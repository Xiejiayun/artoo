// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Message } from "@artoo/domain";
import type { AssistantTurn } from "../api/types.js";
import { fakeApi, messageFixture, renderWithProviders } from "../test/utils.js";
import { AssistantTurns } from "./AssistantTurns.js";
import { MessageCard } from "./MessageCard.js";

const instruction = messageFixture({ id: "instruction", kind: "text", actor_type: "system", actor_id: "discussion-coordinator",
  thread_root_id: "planning-root", body: '\n  Your agent instance is planner; preserve this exact instruction.\r\n{"task_specs": []}\n',
  payload: { intent: "discussion", discussion_id: "discussion-1", assistant_turn_id: "turn-1", discussion_step: 2 } });
const turn: AssistantTurn = { id: "turn-1", room_id: "room-1", task_id: "planning-task", thread_root_id: "planning-root", run_id: null,
  user_message_id: instruction.id, response_message_id: null, status: "waiting", error: "Waiting for an available agent", created_at: "2026-10-01", updated_at: "2026-10-01" };
const client = () => fakeApi({ listAssistantTurns: async () => ({ turns: [turn] }) });

describe("AssistantTurns", () => {
  it("keeps coordinator instructions solely in the existing message disclosure, including accessible request names", async () => {
    const message = structuredClone(instruction);
    renderWithProviders(<><MessageCard message={message} /><AssistantTurns roomId="room-1" threadRootId="planning-root" messages={[message]} allowActions={false} /></>, { client: client() });
    const request = await screen.findByRole("article", { name: "Agent request Planning instruction · Step 3" });
    expect(request.querySelector("strong")).toHaveTextContent("Planning instruction · Step 3");
    expect(request).not.toHaveTextContent("Your agent instance is planner");
    expect(request.getAttribute("aria-label")).not.toContain(instruction.body);
    const originals = screen.getAllByText(instruction.body, { exact: true, normalizer: (text) => text });
    expect(originals).toHaveLength(1);
    expect(originals[0]).not.toBeVisible();
    expect(within(request).getByText("waiting")).toBeVisible();
    expect(within(request).getByText(turn.error!)).toBeVisible();
    expect(within(request).getByRole("button", { name: "Open execution task" })).toBeVisible();
    expect(within(request).queryByRole("button", { name: "Retry agent request" })).not.toBeInTheDocument();
    expect(within(request).queryByRole("button", { name: "Cancel agent request" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByText("Show agent instructions"));
    expect(originals[0]).toBeVisible(); expect(originals[0]?.textContent).toBe(instruction.body);
    await user.click(screen.getByText("Show agent instructions"));
    expect(originals[0]).not.toBeVisible();
    expect(message).toEqual(instruction);
  });

  it.each([
    ["ordinary user", { actor_type: "user" }],
    ["ordinary agent", { actor_type: "agent" }],
    ["unknown coordinator", { actor_id: "another-system" }],
    ["missing metadata", { payload: {} }],
    ["missing thread", { thread_root_id: null }],
    ["invalid step", { payload: { ...instruction.payload, discussion_step: "2" } }],
    ["unrecognized intent", { payload: { ...instruction.payload, intent: "execution" } }],
  ] satisfies [string, Partial<Message>][])("retains the original %s request and its actions", async (_name, changes) => {
    const message = { ...instruction, ...changes };
    renderWithProviders(<AssistantTurns roomId="room-1" threadRootId="planning-root" messages={[message]} />, { client: client() });
    const request = await screen.findByRole("article");
    expect(request.querySelector("strong")?.textContent).toBe(message.body);
    expect(request).toHaveAttribute("aria-label", `Agent request ${message.body}`);
    expect(within(request).getByRole("button", { name: "Retry agent request" })).toBeVisible();
    expect(within(request).getByRole("button", { name: "Cancel agent request" })).toBeVisible();
  });

  it("preserves the request identity fallback while its message is unavailable", async () => {
    renderWithProviders(<AssistantTurns roomId="room-1" threadRootId="planning-root" messages={[]} />, { client: client() });
    const request = await screen.findByRole("article", { name: `Agent request ${turn.id}` });
    expect(request.querySelector("strong")).toHaveTextContent("Agent request");
  });
});
