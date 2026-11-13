// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { GoalSchema, type AgentHistoryDetail, type AgentHistoryPage } from "@artoo/domain";
import { bootstrapFixture, createTestQueryClient, fakeApi, renderWithProviders, runFixture } from "../test/utils.js";
import { queryKeys } from "../app/queryKeys.js";
import { GoalsPage } from "./GoalsPage.js";
import { ReleasePage } from "./ReleasePage.js";
import { AgentHistoryPage as HistoryPage } from "./AgentHistoryPage.js";
import { SettingsPage } from "./SettingsPage.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const goal = GoalSchema.parse({ id: "goal_loading", organization_id: "org_default", project_id: "proj_artoo", room_id: null,
  owner_user_id: "user_1", title: "Loaded outcome", objective: "Check actual evidence", priority: "p2", status: "draft",
  acceptance_criteria: [], stop_conditions: {}, budgets: {}, current_plan_id: null, running_since: null, elapsed_cost_usd: null,
  retry_count: 0, created_at: "2026-11-13", updated_at: "2026-11-13" });

it("keeps the initial goal placeholder decorative and retains real content during background refresh", async () => {
  const first = deferred<{ goals: typeof goal[] }>(), refresh = deferred<{ goals: typeof goal[] }>();
  const listGoals = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(refresh.promise);
  const queryClient = createTestQueryClient();
  renderWithProviders(<GoalsPage />, { queryClient, client: fakeApi({ bootstrap: async () => bootstrapFixture(), listGoals,
    listPlans: async () => ({ plans: [] }), listCheckpoints: async () => ({ checkpoints: [] }) }) });
  const loading = await screen.findByText("Loading goals…");
  const status = loading.closest('[role="status"]')!;
  expect(status.querySelectorAll(".ui-skeleton").length).toBeGreaterThan(0);
  expect(status.querySelector("button, input, a, [tabindex]")).toBeNull();
  expect(status.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  expect(screen.queryByText(/No goals yet/)).not.toBeInTheDocument();
  expect(document.querySelector(".delivery-new-outcome")).not.toHaveAttribute("open");
  await act(async () => first.resolve({ goals: [goal] }));
  expect(await screen.findByRole("heading", { name: goal.title })).toBeVisible();
  act(() => { void queryClient.invalidateQueries({ queryKey: queryKeys.goals(goal.project_id) }); });
  await waitFor(() => expect(listGoals).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("heading", { name: goal.title })).toBeVisible();
  expect(screen.queryByText("Loading goals…")).not.toBeInTheDocument();
  await act(async () => refresh.resolve({ goals: [goal] }));
});

it.each([false, true])("only opens the empty goal composer after a confirmed empty response (failure=%s)", async failure => {
  const result = deferred<{ goals: typeof goal[] }>();
  const listGoals = vi.fn(() => result.promise);
  renderWithProviders(<GoalsPage />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), listGoals }) });
  await screen.findByText("Loading goals…");
  await waitFor(() => expect(listGoals).toHaveBeenCalledOnce());
  if (failure) {
    await act(async () => result.reject(new Error("Goals unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Goals unavailable");
    expect(document.querySelector(".delivery-new-outcome")).not.toHaveAttribute("open");
    expect(screen.queryByText(/No goals yet/)).not.toBeInTheDocument();
  } else {
    await act(async () => result.resolve({ goals: [] }));
    expect(await screen.findByText(/No goals yet/)).toBeVisible();
    expect(document.querySelector(".delivery-new-outcome")).toHaveAttribute("open");
    expect(screen.getByRole("textbox", { name: "Outcome to plan" })).toBeVisible();
  }
  expect(screen.queryByText("Loading goals…")).not.toBeInTheDocument();
});

it("does not render a publication conclusion while evidence is pending, then preserves sync retry", async () => {
  const evidence = deferred<{ release: null }>();
  const getGoalRelease = vi.fn().mockReturnValueOnce(evidence.promise).mockResolvedValue({ release: null });
  renderWithProviders(<ReleasePage />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), listGoals: async () => ({ goals: [goal] }), getGoalRelease }) });
  await screen.findByText("Loading publication evidence…");
  expect(screen.queryByText("Not published")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Release checks" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open published product" })).not.toBeInTheDocument();
  await act(async () => evidence.reject(new Error("Evidence unavailable")));
  await userEvent.click(await screen.findByRole("button", { name: "Retry publication sync" }));
  expect(await screen.findByText("Not published")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Release checks" })).toHaveTextContent("Not configured");
  expect(screen.queryByText("Loading publication evidence…")).not.toBeInTheDocument();
});

it("settles project settings and devices independently without hiding the usable form", async () => {
  const bootstrap = deferred<ReturnType<typeof bootstrapFixture>>(), devices = deferred<{ devices: [] }>();
  renderWithProviders(<SettingsPage />, { client: fakeApi({ bootstrap: () => bootstrap.promise, listDevices: () => devices.promise }) });
  expect(screen.getByText("Loading project settings…")).toBeInTheDocument();
  expect(screen.getByText("Loading devices…")).toBeInTheDocument();
  await act(async () => bootstrap.resolve(bootstrapFixture()));
  expect(await screen.findByRole("form", { name: "Edit project" })).toBeVisible();
  expect(screen.queryByText("Loading project settings…")).not.toBeInTheDocument();
  expect(screen.getByText("Loading devices…")).toBeInTheDocument();
  await act(async () => devices.resolve({ devices: [] }));
  expect(await screen.findByText("No devices paired yet.")).toBeInTheDocument();
  expect(screen.queryByText("Loading devices…")).not.toBeInTheDocument();
});

it("settles history list and execution placeholders independently", async () => {
  const history = deferred<AgentHistoryPage>(), detail = deferred<AgentHistoryDetail>();
  const run = runFixture({ id: "run_loading", status: "completed" });
  const execution = { run, task_title: "Recorded execution", project_id: goal.project_id };
  renderWithProviders(<Routes><Route path="/agents/:agentId/history" element={<HistoryPage />} /></Routes>, {
    route: `/agents/agent_mock_coder/history?run_id=${run.id}`, client: fakeApi({ bootstrap: async () => bootstrapFixture(), agentHistory: () => history.promise, agentHistoryRun: () => detail.promise }),
  });
  const list = within(screen.getByRole("region", { name: "Agent executions" }));
  const selected = within(screen.getByRole("region", { name: "Execution history" }));
  expect(list.getByRole("status")).toHaveTextContent("Loading history…");
  expect(selected.getByRole("status")).toHaveTextContent("Loading execution…");
  await act(async () => history.resolve({ version: 1, agent_id: "agent_mock_coder", agent_name: "Coder", runs: [execution], next_before_run_id: null }));
  expect(await list.findByRole("button", { name: /Recorded execution/ })).toHaveAttribute("aria-pressed", "true");
  expect(selected.getByRole("status")).toHaveTextContent("Loading execution…");
  await act(async () => detail.resolve({ version: 1, agent_id: "agent_mock_coder", execution, request: null, events: [], next_before: null }));
  expect(await selected.findByRole("heading", { name: "Recorded execution" })).toBeInTheDocument();
  expect(selected.queryByText("Loading execution…")).not.toBeInTheDocument();
});
