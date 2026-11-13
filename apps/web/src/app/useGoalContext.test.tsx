// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { GoalSchema } from "@artoo/domain";
import type { ApiClient } from "../api/client.js";
import { bootstrapFixture, createTestQueryClient, fakeApi, renderWithProviders } from "../test/utils.js";
import { queryKeys } from "./queryKeys.js";
import { useGoalContext } from "./useGoalContext.js";
import { useProject } from "./useProject.js";

const goal = GoalSchema.parse({
  id: "goal_linked",
  organization_id: "org_default",
  project_id: "proj_artoo",
  room_id: null,
  owner_user_id: "user_1",
  title: "Linked outcome",
  objective: "Open the authorized goal after reload",
  priority: "p2",
  status: "draft",
  acceptance_criteria: [],
  stop_conditions: {},
  budgets: {},
  current_plan_id: null,
  running_since: null,
  elapsed_cost_usd: null,
  retry_count: 0,
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
});
const otherProject = { id: "proj_other", name: "Earlier project", default_workspace: null };
const targetProject = { id: "proj_artoo", name: "artoo", default_workspace: null };
function client(overrides: Partial<ApiClient> = {}) {
  return fakeApi({
    bootstrap: async () => bootstrapFixture({ projects: [otherProject, targetProject] }),
    listGoals: async (projectId) => ({ goals: projectId === goal.project_id ? [goal] : [] }),
    getGoal: async () => ({ goal }),
    ...overrides,
  });
}
function Probe() {
  const context = useGoalContext(true);
  const { projectId, setSelectedProjectId } = useProject();
  return (
    <>
      <output aria-label="Selected project">{projectId}</output>
      <output aria-label="Selected goal">{context.goal?.id ?? "none"}</output>
      <output aria-label="Context error">{context.contextError?.message ?? "none"}</output>
      <button onClick={context.retryContext}>Retry</button>
      <button
        onClick={() => {
          context.selectGoal(null);
          setSelectedProjectId(otherProject.id);
        }}
      >
        Leave link
      </button>
      <button onClick={() => setSelectedProjectId(otherProject.id)}>Switch project without changing URL</button>
    </>
  );
}

it("resolves an authorized Goal ID when the first bootstrap project differs", async () => {
  const getGoal = vi.fn<ApiClient["getGoal"]>().mockResolvedValue({ goal });
  renderWithProviders(<Probe />, { client: client({ getGoal }), route: `/goals?goal=${goal.id}` });
  await waitFor(() => expect(screen.getByLabelText("Selected goal")).toHaveTextContent(goal.id));
  expect(screen.getByLabelText("Selected project")).toHaveTextContent(goal.project_id);
  expect(getGoal).toHaveBeenCalledWith(goal.id);
  await userEvent.click(screen.getByRole("button", { name: "Switch project without changing URL" }));
  await waitFor(() => expect(screen.getByLabelText("Selected project")).toHaveTextContent(otherProject.id));
  expect(screen.getByLabelText("Selected goal")).toHaveTextContent("none");
  expect(getGoal).toHaveBeenCalledTimes(1);
});

it("uses an already scoped Goal list without another lookup", async () => {
  const getGoal = vi.fn<ApiClient["getGoal"]>();
  renderWithProviders(<Probe />, {
    client: client({ bootstrap: async () => bootstrapFixture(), getGoal }),
    route: `/release?goal=${goal.id}`,
  });
  await waitFor(() => expect(screen.getByLabelText("Selected goal")).toHaveTextContent(goal.id));
  expect(getGoal).not.toHaveBeenCalled();
});

it.each([
  { ...goal, id: "goal_wrong" },
  { ...goal, organization_id: "org_other" },
])("rejects a response with the wrong identity or organization: %j", async (returned) => {
  renderWithProviders(<Probe />, {
    client: client({ getGoal: async () => ({ goal: returned }) }),
    route: `/goals?goal=${goal.id}`,
  });
  await waitFor(() => expect(screen.getByLabelText("Context error")).toHaveTextContent("could not be verified"));
  expect(screen.getByLabelText("Selected project")).toHaveTextContent(otherProject.id);
  expect(screen.getByLabelText("Selected goal")).toHaveTextContent("none");
});

it("keeps failed lookup visible and retries without choosing an unrelated goal", async () => {
  const getGoal = vi
    .fn<ApiClient["getGoal"]>()
    .mockRejectedValueOnce(new Error("Goal access denied"))
    .mockResolvedValue({ goal });
  renderWithProviders(<Probe />, { client: client({ getGoal }), route: `/board?goal=${goal.id}` });
  await waitFor(() => expect(screen.getByLabelText("Context error")).toHaveTextContent("Goal access denied"));
  expect(screen.getByLabelText("Selected project")).toHaveTextContent(otherProject.id);
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByLabelText("Selected goal")).toHaveTextContent(goal.id));
  expect(screen.getByLabelText("Context error")).toHaveTextContent("none");
});

it("requires a known project and can refresh bootstrap access before applying the link", async () => {
  let projects = [otherProject];
  renderWithProviders(<Probe />, {
    client: client({ bootstrap: async () => bootstrapFixture({ projects }) }),
    route: `/goals?goal=${goal.id}`,
  });
  await waitFor(() => expect(screen.getByLabelText("Context error")).toHaveTextContent("project is unavailable"));
  expect(screen.getByLabelText("Selected project")).toHaveTextContent(otherProject.id);
  projects = [otherProject, targetProject];
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByLabelText("Selected goal")).toHaveTextContent(goal.id));
});

it("does not apply a late response after leaving its link", async () => {
  let finish!: (value: { goal: typeof goal }) => void;
  const getGoal = vi.fn<ApiClient["getGoal"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderWithProviders(<Probe />, { client: client({ getGoal }), route: `/goals?goal=${goal.id}` });
  await waitFor(() => expect(getGoal).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "Leave link" }));
  await act(async () => {
    finish({ goal });
  });
  expect(screen.getByLabelText("Selected project")).toHaveTextContent(otherProject.id);
  expect(screen.getByLabelText("Selected goal")).toHaveTextContent("none");
});

it("revalidates cached link data before changing project", async () => {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(queryKeys.linkedGoal(goal.id, "org_default", "user_1"), { goal });
  let finish!: (value: { goal: typeof goal }) => void;
  const getGoal = vi.fn<ApiClient["getGoal"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderWithProviders(<Probe />, { queryClient, client: client({ getGoal }), route: `/goals?goal=${goal.id}` });
  await waitFor(() => expect(getGoal).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("Selected project")).toHaveTextContent(otherProject.id);
  await act(async () => {
    finish({ goal });
  });
  await waitFor(() => expect(screen.getByLabelText("Selected goal")).toHaveTextContent(goal.id));
});

it("isolates pending link responses from a changed account", async () => {
  const queryClient = createTestQueryClient();
  let finish!: (value: { goal: typeof goal }) => void;
  const getGoal = vi
    .fn<ApiClient["getGoal"]>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValue(new Error("New account cannot access this goal"));
  renderWithProviders(<Probe />, { queryClient, client: client({ getGoal }), route: `/goals?goal=${goal.id}` });
  await waitFor(() => expect(getGoal).toHaveBeenCalledTimes(1));
  await act(async () => {
    queryClient.setQueryData(
      queryKeys.bootstrap,
      bootstrapFixture({
        user: { ...bootstrapFixture().user, id: "user_other" },
        projects: [otherProject, targetProject],
      }),
    );
  });
  await waitFor(() => expect(screen.getByLabelText("Context error")).toHaveTextContent("New account cannot access"));
  await act(async () => {
    finish({ goal });
  });
  expect(screen.getByLabelText("Selected project")).toHaveTextContent(otherProject.id);
  expect(screen.getByLabelText("Selected goal")).toHaveTextContent("none");
});
