// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalSchema, GoalAutomationSchema, type PreparedGoalEntryV1 } from "@artoo/domain";
import { ApiClientError, type ApiClient } from "../api/client.js";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { preparedGoalBody, preparedGoalDraftKey, writePreparedGoalDraft, type BrowserGoalEntry } from "../app/goalEntryDraft.js";
import { GoalsPage } from "./GoalsPage.js";

const entry: BrowserGoalEntry = { version: 1, session_id: "prepared-one", project_id: "proj_artoo", submission_owner: "browser", goal_id: null,
  request_key: "prepared-request-one", request: { execution_mode: "agent_team", verification_profile_id: "native-web",
    release_profile_id: "native-publish", max_retries: 3, source_handoff: { version: 1, mode: "automatic" } } };
const goal = GoalSchema.parse({ id: "goal_prepared", organization_id: "org_default", project_id: "proj_artoo", room_id: null,
  owner_user_id: "user_1", title: "A personal product", objective: "Make a personal task tracker", priority: "p2", status: "draft",
  acceptance_criteria: [], stop_conditions: {}, budgets: {}, current_plan_id: null, running_since: null, elapsed_cost_usd: null,
  retry_count: 0, created_at: "2026-11-07", updated_at: "2026-11-07" });
const automation = GoalAutomationSchema.parse({ goal_id: goal.id, organization_id: "org_default", actor_user_id: "user_1",
  consent_id: null, policy_version: "local-v1", status: "planning", discussion_id: null, plan_id: null, agent_instance_id: null,
  computer_id: null, workspace_root: null, verification_profile_id: "native-web", release_profile_id: "native-publish",
  execution_mode: "agent_team", last_error: null, created_at: goal.created_at, updated_at: goal.updated_at });
function client(current: PreparedGoalEntryV1 | undefined = entry, overrides: Partial<ApiClient> = {}) {
  return fakeApi({ bootstrap: async () => bootstrapFixture(current ? { goal_entry: current } : {}), listGoals: async () => ({ goals: [] }),
    listPlans: async () => ({ plans: [] }), listCheckpoints: async () => ({ checkpoints: [] }), ...overrides });
}
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe("prepared product request page", () => {
  it("takes only the objective and submits the actual configured profiles and handoff once", async () => {
    const createAutonomousGoal = vi.fn<ApiClient["createAutonomousGoal"]>().mockResolvedValue({ goal, automation });
    renderWithProviders(<GoalsPage />, { client: client(entry, { createAutonomousGoal }) });
    const input = await screen.findByLabelText("Objective");
    expect(screen.queryByLabelText("Goal title")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Execution mode")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Allow Artoo to divide work across configured computers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New goal" })).not.toBeInTheDocument();
    await userEvent.type(input, goal.objective);
    await userEvent.click(screen.getByRole("button", { name: "Start product" }));
    await waitFor(() => expect(createAutonomousGoal).toHaveBeenCalledTimes(1));
    expect(createAutonomousGoal).toHaveBeenCalledWith(preparedGoalBody(entry, goal.objective), entry.request_key);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry submission" })).toBeDisabled());
  });

  it("makes the console-owned session a monitor without another input form", async () => {
    const createAutonomousGoal = vi.fn<ApiClient["createAutonomousGoal"]>();
    renderWithProviders(<GoalsPage />, { client: client({ version: 1, session_id: entry.session_id, project_id: entry.project_id,
      submission_owner: "console", goal_id: null }, { createAutonomousGoal }) });
    expect(await screen.findByText(/uses the request entered in the launcher/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Objective")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Allow Artoo to divide work across configured computers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New goal" })).not.toBeInTheDocument();
    expect(createAutonomousGoal).not.toHaveBeenCalled();
  });

  it("recovers an uncertain submission after a page reload using exactly the saved request", async () => {
    const createAutonomousGoal = vi.fn<ApiClient["createAutonomousGoal"]>()
      .mockRejectedValueOnce(new ApiClientError("unknown", "The response was unreadable", 502))
      .mockResolvedValue({ goal, automation });
    const api = client(entry, { createAutonomousGoal });
    const first = renderWithProviders(<GoalsPage />, { client: api });
    await userEvent.type(await screen.findByLabelText("Objective"), goal.objective);
    await userEvent.click(screen.getByRole("button", { name: "Start product" }));
    await screen.findByText("The response was unreadable");
    expect(screen.getByLabelText("Objective")).toBeDisabled(); first.unmount();
    renderWithProviders(<GoalsPage />, { client: api });
    await waitFor(() => expect(createAutonomousGoal).toHaveBeenCalledTimes(2));
    expect(createAutonomousGoal.mock.calls[1]).toEqual(createAutonomousGoal.mock.calls[0]);
  });

  it("does not send a request when its recovery body cannot be retained", async () => {
    const createAutonomousGoal = vi.fn<ApiClient["createAutonomousGoal"]>();
    renderWithProviders(<GoalsPage />, { client: client(entry, { createAutonomousGoal }) });
    await userEvent.type(await screen.findByLabelText("Objective"), goal.objective);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    await userEvent.click(screen.getByRole("button", { name: "Start product" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No new request was sent");
    expect(createAutonomousGoal).not.toHaveBeenCalled();
  });

  it("rejects a saved body from another prepared configuration instead of creating a replacement goal", async () => {
    const createAutonomousGoal = vi.fn<ApiClient["createAutonomousGoal"]>();
    const api = client(entry, { createAutonomousGoal });
    const key = preparedGoalDraftKey(api.getStorageScope(), "org_default", "user_1", entry);
    writePreparedGoalDraft(key, entry, { ...preparedGoalBody(entry, goal.objective), verification_profile_id: "changed" });
    renderWithProviders(<GoalsPage />, { client: api });
    expect(await screen.findByRole("alert")).toHaveTextContent("differs from the prepared configuration");
    expect(createAutonomousGoal).not.toHaveBeenCalled();
  });

  it("does not silently use the ordinary form for an unsupported prepared-session version", async () => {
    const invalid = { ...entry, version: 2 } as unknown as PreparedGoalEntryV1;
    renderWithProviders(<GoalsPage />, { client: client(invalid) });
    expect(await screen.findByRole("alert")).toHaveTextContent("unsupported configuration");
    expect(screen.queryByRole("button", { name: "New goal" })).not.toBeInTheDocument();
  });
});
