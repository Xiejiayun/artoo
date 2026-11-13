// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Plan } from "@artoo/domain";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { planDraftKey } from "../app/planDrafts.js";
import { clearRoomDrafts } from "../app/roomDrafts.js";
import { PlanForm } from "./PlanForm.js";
import type { ApiClient } from "../api/client.js";

const scope = "https://server.example/api/v1", goalId = "goal_editor";
const key = planDraftKey(scope, "org_default", "user_1", goalId);
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
function render(overrides: Partial<ApiClient> = {}, user = "user_1") {
  const onCreated = vi.fn(async () => undefined);
  return { onCreated, ...renderWithProviders(<PlanForm goalId={goalId} onCreated={onCreated} />, { client: fakeApi({
    bootstrap: async () => ({ ...bootstrapFixture(), user: { ...bootstrapFixture().user, id: user } }),
    getStorageScope: () => scope, ...overrides,
  }) }) };
}
async function fillTask(index: number, title: string) {
  await userEvent.type(screen.getByLabelText(`Task ${index} title`), title);
  await userEvent.type(screen.getByLabelText(`Task ${index} acceptance criteria`), `Check ${title}`);
}
const group = (index: number) => within(screen.getByRole("group", { name: `Task ${index}` }));

it("removes a middle task and preserves actual dependencies through moves in both directions", async () => {
  const proposePlan = vi.fn<ApiClient["proposePlan"]>().mockResolvedValue({ plan: {} as Plan });
  const { onCreated } = render({ proposePlan });
  await userEvent.type(await screen.findByLabelText("Plan rationale"), "Stable identities");
  await fillTask(1, "Implement");
  await userEvent.type(screen.getByLabelText("Task 1 description"), "Keep this request");
  await userEvent.click(screen.getByRole("button", { name: "Add plan task" }));
  await fillTask(2, "Intermediate");
  await userEvent.click(group(2).getByRole("checkbox", { name: "Implement" }));
  await userEvent.click(screen.getByRole("button", { name: "Add plan task" }));
  await fillTask(3, "Review");
  await userEvent.click(group(3).getByRole("checkbox", { name: "Implement" }));
  await userEvent.click(group(3).getByRole("checkbox", { name: "Intermediate" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove task 2" }));
  await waitFor(() => expect(screen.getByLabelText("Task 2 title")).toHaveFocus());
  expect(screen.getByLabelText("Task 2 title")).toHaveValue("Review");
  expect(group(2).getByRole("checkbox", { name: "Implement" })).toBeChecked();
  expect(screen.queryByRole("checkbox", { name: "Intermediate" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Move task 2 up" }));
  expect(screen.getByLabelText("Task 1 title")).toHaveValue("Review");
  await userEvent.click(screen.getByRole("button", { name: "Move task 1 down" }));
  expect(screen.getByLabelText("Task 1 title")).toHaveValue("Implement");
  await userEvent.click(screen.getByRole("button", { name: "Move task 2 up" }));
  expect(group(1).getByRole("checkbox", { name: "Implement" })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Submit plan for review" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  expect(proposePlan.mock.calls[0]?.[1].task_specs).toEqual([
    expect.objectContaining({ title: "Review", dependencies: [{ ref: "1", type: "blocks" }] }),
    expect.objectContaining({ title: "Implement", description: "Keep this request", dependencies: [] }),
  ]);
  expect(proposePlan.mock.calls[0]?.[1].task_specs.every(task => !("id" in task))).toBe(true);
  expect(localStorage.getItem(key)).toBeNull();
});

it("restores exact unfinished text after closing, retains it on rejection, and clears only after success", async () => {
  const proposePlan = vi.fn<ApiClient["proposePlan"]>().mockRejectedValueOnce(new Error("Cyclic plan rejected")).mockResolvedValue({ plan: {} as Plan });
  const first = render({ proposePlan });
  await userEvent.type(await screen.findByLabelText("Plan rationale"), "A saved approach");
  await fillTask(1, "Persist");
  await userEvent.type(screen.getByLabelText("Task 1 description"), "unfinished\n\nnotes ");
  const saved = localStorage.getItem(key);
  first.unmount();
  const second = render({ proposePlan });
  expect(await screen.findByLabelText("Task 1 description")).toHaveValue("unfinished\n\nnotes ");
  expect(screen.getByText("Restored your saved plan draft.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Submit plan for review" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Cyclic plan rejected");
  expect(localStorage.getItem(key)).toBe(saved);
  expect(second.onCreated).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Submit plan for review" }));
  await waitFor(() => expect(second.onCreated).toHaveBeenCalledOnce());
  expect(localStorage.getItem(key)).toBeNull();
});

it("separates server, organization, account and goal scopes and never loads another account's draft", async () => {
  expect(new Set([key, planDraftKey("https://other.example/api/v1", "org_default", "user_1", goalId),
    planDraftKey(scope, "org_other", "user_1", goalId), planDraftKey(scope, "org_default", "user_2", goalId),
    planDraftKey(scope, "org_default", "user_1", "goal_other")]).size).toBe(5);
  const first = render();
  await userEvent.type(await screen.findByLabelText("Plan rationale"), "Private draft");
  first.unmount();
  render({}, "user_2");
  expect(await screen.findByLabelText("Plan rationale")).toHaveValue("");
  expect(localStorage.getItem(key)).toContain("Private draft");
});

it("clears account drafts on session end and a late submission does not revive or close the editor", async () => {
  let resolve!: (value: { plan: Plan }) => void;
  const proposePlan = vi.fn(() => new Promise<{ plan: Plan }>(yes => { resolve = yes; }));
  const { onCreated } = render({ proposePlan });
  await userEvent.type(await screen.findByLabelText("Plan rationale"), "A pending draft");
  await fillTask(1, "Pending");
  localStorage.setItem("unrelated-preference", "keep");
  await userEvent.click(screen.getByRole("button", { name: "Submit plan for review" }));
  await waitFor(() => expect(proposePlan).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("Task 1 title")).toBeDisabled();
  act(() => clearRoomDrafts());
  expect(screen.getByLabelText("Plan rationale")).toHaveValue("");
  expect(screen.getByLabelText("Plan rationale")).toBeDisabled();
  await act(async () => resolve({ plan: {} as Plan }));
  expect(onCreated).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem("unrelated-preference")).toBe("keep");
});

it("keeps newer edits when a closed editor's submission succeeds after reopening", async () => {
  let resolve!: (value: { plan: Plan }) => void;
  const proposePlan = vi.fn(() => new Promise<{ plan: Plan }>(yes => { resolve = yes; }));
  const first = render({ proposePlan });
  await userEvent.type(await screen.findByLabelText("Plan rationale"), "Original plan");
  await fillTask(1, "Original task");
  await userEvent.click(screen.getByRole("button", { name: "Submit plan for review" }));
  await waitFor(() => expect(proposePlan).toHaveBeenCalledOnce());
  first.unmount();
  const reopened = render();
  await userEvent.type(await screen.findByLabelText("Plan rationale"), " with newer edits");
  await act(async () => resolve({ plan: {} as Plan }));
  expect(localStorage.getItem(key)).toContain("Original plan with newer edits");
  expect(screen.getByLabelText("Plan rationale")).toHaveValue("Original plan with newer edits");
  expect(first.onCreated).not.toHaveBeenCalled();
  expect(reopened.onCreated).not.toHaveBeenCalled();
});

it.each(["{broken", JSON.stringify({ version: 1, rationale: "retained", tasks: [{ id: "a", title: "T", description: "", criteria: "C", capabilities: [], dependencies: ["missing"] }] })])("retains an unreadable saved copy until explicit discard", async raw => {
  localStorage.setItem(key, raw);
  render();
  expect(await screen.findByLabelText("Plan rationale")).toBeDisabled();
  expect(screen.getByText(/could not be restored/)).toBeInTheDocument();
  expect(localStorage.getItem(key)).toBe(raw);
  await userEvent.click(screen.getByRole("button", { name: "Discard saved draft" }));
  expect(screen.getByLabelText("Plan rationale")).toBeEnabled();
  expect(localStorage.getItem(key)).toBeNull();
});

it("retains usable in-memory edits and explains when browser persistence fails", async () => {
  render();
  await screen.findByLabelText("Plan rationale");
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
  await userEvent.type(screen.getByLabelText("Plan rationale"), "Still editable");
  expect(screen.getByLabelText("Plan rationale")).toHaveValue("Still editable");
  expect(screen.getByText(/could not be saved in this browser/)).toBeInTheDocument();
  save.mockRestore();
  await userEvent.type(screen.getByLabelText("Plan rationale"), " and saved");
  expect(localStorage.getItem(key)).toContain("Still editable and saved");
});
