// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

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

describe("MessageCard", () => {
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
