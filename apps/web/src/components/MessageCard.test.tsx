// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fakeApi, messageFixture, renderWithProviders } from "../test/utils.js";
import { MessageCard } from "./MessageCard.js";

const client = fakeApi({});
const suggestedPlan = {
  version: 1, discussion_id: "discussion_1", goal_id: "goal_1", rationale: "Build before verifying the result.",
  task_specs: [
    { title: "Implement the API", description: "Add the documented endpoint.", acceptance_criteria: ["The endpoint returns the documented response", "Unauthorized requests are rejected"], required_capabilities: ["code.read", "code.modify"], dependencies: [], approval_gates: [], write_scopes: [], expected_artifacts: [{ type: "report", description: "API contract evidence" }] },
    { title: "Verify the API", description: "Exercise the implemented endpoint.", acceptance_criteria: ["Contract checks pass"], required_capabilities: [], dependencies: [{ ref: "0", type: "blocks" }], approval_gates: [], write_scopes: [], expected_artifacts: [] },
  ],
};
const originalReply = `\`\`\`json\n${JSON.stringify({ rationale: suggestedPlan.rationale, task_specs: suggestedPlan.task_specs })}\n\`\`\``;
const planningInstruction = messageFixture({
  id: "planning_instruction", kind: "text", actor_type: "system", actor_id: "discussion-coordinator",
  thread_root_id: "goal_root",
  body: '\n  Prepare a plan for “目标 🧭”.\r\n\t{"task_specs": [{"title": "保留空白"}]}\n  ',
  payload: { intent: "discussion", discussion_id: "discussion_1", assistant_turn_id: "turn_1", discussion_step: 2 },
});

describe("MessageCard", () => {
  it("uses a person's initials and keeps thread actions on their message", async () => {
    const onOpenThread = vi.fn();
    renderWithProviders(<MessageCard message={messageFixture({ id: "root", kind: "text", body: "Let's discuss", reply_count: 1 })} actorName="Alex Chen (you)" onOpenThread={onOpenThread} />, { client });
    expect(screen.getByText("AC")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Alex Chen (you)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "1 reply" }));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Reply in thread" }));
    expect(onOpenThread).toHaveBeenCalledTimes(2);
  });

  it("renders plain text", () => {
    renderWithProviders(
      <MessageCard message={messageFixture({ id: "m1", kind: "text", body: "hello world" })} />,
      { client },
    );
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("renders an approval request defensively from an opaque payload", () => {
    renderWithProviders(
      <MessageCard
        message={messageFixture({ id: "m2", kind: "approval_request", payload: { action: "git.push" } })}
      />,
      { client },
    );
    expect(screen.getByText(/Approval requested: git\.push/)).toBeInTheDocument();
  });

  it("degrades an unknown kind to a system-notice card", () => {
    renderWithProviders(
      <MessageCard message={messageFixture({ id: "m3", kind: "future_kind", body: "later" })} />,
      { client },
    );
    expect(screen.getByLabelText("system_notice message")).toHaveAttribute(
      "data-kind",
      "system_notice",
    );
  });

  it("does not crash on a malformed artifact payload (non-string uri)", () => {
    renderWithProviders(
      <MessageCard
        message={messageFixture({ id: "m4", kind: "artifact", payload: { uri: 123 }, body: "fallback" })}
      />,
      { client },
    );
    expect(screen.getByText(/Artifact: fallback/)).toBeInTheDocument();
  });

  it("summarizes a coordinator instruction and toggles its exact original text without changing the message", async () => {
    const message = structuredClone(planningInstruction);
    renderWithProviders(<MessageCard message={message} actorName="Discussion coordinator" />, { client });
    expect(screen.getByRole("region", { name: "Planning instruction" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Planning instruction · Step 3" })).toBeVisible();
    expect(screen.getByText("The agents use the goal and earlier replies to prepare a plan. You review a proposal before accepting it.")).toBeVisible();
    expect(screen.getByText("Discussion coordinator")).toBeVisible();
    expect(screen.getByLabelText("text message").querySelector("time")).toHaveAttribute("datetime", message.created_at);
    const original = screen.getByText(message.body, { exact: true, normalizer: (text) => text });
    const disclosure = screen.getByText("Show agent instructions");
    expect(original).not.toBeVisible();
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    const user = userEvent.setup();
    await user.click(disclosure);
    expect(original).toBeVisible();
    expect(original.textContent).toBe(message.body);
    await user.click(disclosure);
    expect(original).not.toBeVisible();
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    expect(message).toEqual(planningInstruction);
    expect(screen.queryByRole("button", { name: /accept|propose|create tasks/i })).not.toBeInTheDocument();
  });

  it.each([0, Number.MAX_SAFE_INTEGER - 1])("displays a safe zero-based instruction step %s as one-based", (step) => {
    renderWithProviders(<MessageCard message={{ ...planningInstruction, payload: { ...planningInstruction.payload, discussion_step: step } }} />, { client });
    expect(screen.getByRole("heading", { name: `Planning instruction · Step ${step + 1}` })).toBeVisible();
  });

  it("retains opaque identifiers whose content is not removed by JavaScript trim", () => {
    const message = { ...planningInstruction, thread_root_id: "\u0085",
      payload: { ...planningInstruction.payload, discussion_id: "\u0085", assistant_turn_id: "\u0085" } };
    renderWithProviders(<MessageCard message={message} />, { client });
    expect(screen.getByRole("region", { name: "Planning instruction" })).toBeVisible();
    expect(message.thread_root_id).toBe("\u0085");
    expect(message.payload.discussion_id).toBe("\u0085");
  });

  it.each([
    ["a user imitating coordinator metadata", { actor_type: "user" }],
    ["an agent reply with coordinator metadata", { actor_type: "agent" }],
    ["another system actor", { actor_id: "another-coordinator" }],
    ["a non-text instruction", { kind: "run_event" }],
    ["an unknown message kind", { kind: "future_kind" }],
    ["a missing thread root", { thread_root_id: undefined }],
    ["a null thread root", { thread_root_id: null }],
    ["an empty thread root", { thread_root_id: "" }],
    ["a blank thread root", { thread_root_id: " \n\t" }],
    ["a Unicode trim-only thread root", { thread_root_id: "\uFEFF" }],
    ["missing metadata", { payload: {} }],
    ["a missing intent", { payload: { ...planningInstruction.payload, intent: undefined } }],
    ["another intent", { payload: { ...planningInstruction.payload, intent: "execution" } }],
    ["a non-string intent", { payload: { ...planningInstruction.payload, intent: 1 } }],
    ["a missing discussion ID", { payload: { ...planningInstruction.payload, discussion_id: undefined } }],
    ["an empty discussion ID", { payload: { ...planningInstruction.payload, discussion_id: "" } }],
    ["a blank discussion ID", { payload: { ...planningInstruction.payload, discussion_id: " \n\t" } }],
    ["a Unicode trim-only discussion ID", { payload: { ...planningInstruction.payload, discussion_id: "\uFEFF" } }],
    ["a non-string discussion ID", { payload: { ...planningInstruction.payload, discussion_id: 1 } }],
    ["a missing turn ID", { payload: { ...planningInstruction.payload, assistant_turn_id: undefined } }],
    ["an empty turn ID", { payload: { ...planningInstruction.payload, assistant_turn_id: "" } }],
    ["a blank turn ID", { payload: { ...planningInstruction.payload, assistant_turn_id: " \n\t" } }],
    ["a Unicode trim-only turn ID", { payload: { ...planningInstruction.payload, assistant_turn_id: "\uFEFF" } }],
    ["a non-string turn ID", { payload: { ...planningInstruction.payload, assistant_turn_id: 1 } }],
    ["a missing step", { payload: { ...planningInstruction.payload, discussion_step: undefined } }],
    ["a string step", { payload: { ...planningInstruction.payload, discussion_step: "2" } }],
    ["a negative step", { payload: { ...planningInstruction.payload, discussion_step: -1 } }],
    ["a fractional step", { payload: { ...planningInstruction.payload, discussion_step: 0.5 } }],
    ["a non-finite step", { payload: { ...planningInstruction.payload, discussion_step: Infinity } }],
    ["a NaN step", { payload: { ...planningInstruction.payload, discussion_step: NaN } }],
    ["a step with an unsafe increment", { payload: { ...planningInstruction.payload, discussion_step: Number.MAX_SAFE_INTEGER } }],
    ["an unsafe step", { payload: { ...planningInstruction.payload, discussion_step: Number.MAX_SAFE_INTEGER + 1 } }],
  ] as const)("keeps %s visible as its original body", (_name, overrides) => {
    renderWithProviders(<MessageCard message={{ ...planningInstruction, ...overrides }} />, { client });
    expect(screen.queryByRole("region", { name: "Planning instruction" })).not.toBeInTheDocument();
    expect(screen.queryByText("Show agent instructions")).not.toBeInTheDocument();
    expect(screen.getByText(planningInstruction.body, { exact: true, normalizer: (text) => text })).toBeVisible();
  });

  it("shows an agent's suggested tasks, criteria and named dependencies with the original reply collapsed", async () => {
    renderWithProviders(<MessageCard message={messageFixture({ id: "plan", kind: "text", actor_type: "agent", body: originalReply, payload: { discussion_plan: suggestedPlan } })} actorName="Planner" />, { client });
    expect(screen.getByRole("region", { name: "Suggested plan" })).toBeVisible();
    expect(screen.getByText("Planner")).toBeVisible();
    expect(screen.getByText(suggestedPlan.rationale)).toBeVisible();
    expect(screen.getByRole("heading", { name: "1. Implement the API" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "2. Verify the API" })).toBeVisible();
    expect(screen.getByText("Add the documented endpoint.")).toBeVisible();
    expect(screen.getByText("The endpoint returns the documented response")).toBeVisible();
    expect(screen.getByText("Unauthorized requests are rejected")).toBeVisible();
    expect(screen.getByText("Contract checks pass")).toBeVisible();
    expect(screen.getByText("Depends on:").parentElement).toHaveTextContent("Depends on: Implement the API");
    expect(screen.getByText("Required capabilities:").parentElement).toHaveTextContent("code.read, code.modify");
    expect(screen.getByText("report").parentElement).toHaveTextContent("API contract evidence");
    const original = screen.getByText(originalReply, { exact: true, normalizer: (text) => text });
    expect(original).not.toBeVisible();
    await userEvent.setup().click(screen.getByText("Show original reply"));
    expect(original).toBeVisible();
    expect(original.textContent).toBe(originalReply);
    expect(screen.queryByRole("button", { name: /accept|propose|create tasks/i })).not.toBeInTheDocument();
  });

  it.each([
    ["artifact_required", "Requires artifact from:"],
    ["contract_required", "Requires contract from:"],
    ["review_required", "Requires review from:"],
    ["soft_context", "Context from:"],
  ])("identifies %s dependencies without presenting them as blocking", (type, label) => {
    const preview = { ...suggestedPlan, task_specs: [suggestedPlan.task_specs[0], { ...suggestedPlan.task_specs[1], dependencies: [{ ref: "0", type }] }] };
    renderWithProviders(<MessageCard message={messageFixture({ id: "typed-dependency", kind: "text", actor_type: "agent", body: originalReply, payload: { discussion_plan: preview } })} />, { client });
    expect(screen.getByText(label).parentElement).toHaveTextContent(`${label} Implement the API`);
    expect(screen.queryByText("Depends on:")).not.toBeInTheDocument();
  });

  it.each([
    ["ordinary user metadata", "user", "text", suggestedPlan],
    ["ordinary agent JSON without metadata", "agent", "text", undefined],
    ["unsupported preview version", "agent", "text", { ...suggestedPlan, version: 2 }],
    ["malformed task criteria", "agent", "text", { ...suggestedPlan, task_specs: [{ title: "Invalid task", acceptance_criteria: "not a list" }] }],
    ["invalid dependency reference", "agent", "text", { ...suggestedPlan, task_specs: [{ ...suggestedPlan.task_specs[0], dependencies: [{ ref: "9", type: "blocks" }] }] }],
    ["system metadata", "system", "text", suggestedPlan],
    ["non-text agent metadata", "agent", "run_event", suggestedPlan],
  ] as const)("keeps %s as its original body", (_name, actor, kind, preview) => {
    renderWithProviders(<MessageCard message={messageFixture({ id: "fallback", actor_type: actor, kind, body: originalReply, payload: { discussion_plan: preview } })} />, { client });
    expect(screen.queryByRole("region", { name: "Suggested plan" })).not.toBeInTheDocument();
    expect(screen.queryByText("Show original reply")).not.toBeInTheDocument();
    expect(screen.getByText(originalReply, { exact: true, normalizer: (text) => text })).toBeVisible();
  });
});
