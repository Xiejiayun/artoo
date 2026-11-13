// @vitest-environment jsdom
import { GoalSchema, type PreparedGoalEntryV1 } from "@artoo/domain";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { startTransition, StrictMode, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../api/client.js";
import { useSelection } from "../app/SelectionContext.js";
import { createTestQueryClient, bootstrapFixture, fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { Button, Modal } from "../ui/index.js";
import { CommandPalette } from "./CommandPalette.js";
import { GoalsPage } from "./GoalsPage.js";

const goal = GoalSchema.parse({
  id: "goal_other",
  organization_id: "org_default",
  project_id: "proj_other",
  owner_user_id: "user_1",
  title: "Cross goal",
  objective: "Cross project outcome",
  priority: "p2",
  status: "draft",
  acceptance_criteria: [],
  stop_conditions: {},
  budgets: {},
  room_id: null,
  current_plan_id: null,
  running_since: null,
  elapsed_cost_usd: null,
  retry_count: 0,
  created_at: "2026-11-14",
  updated_at: "2026-11-14",
});
const projects = [
  { id: "proj_artoo", name: "artoo", default_workspace: null },
  { id: "proj_other", name: "Other project", default_workspace: null },
];
const crossTask = taskFixture({ id: "task_other", project_id: "proj_other", title: "Cross task", status: "backlog" });
const channel = {
  id: "room_other",
  project_id: "proj_other",
  name: "Cross channel",
  description: "",
  created_at: "2026-11-14",
};
function client(overrides: Partial<ApiClient> = {}) {
  return fakeApi({
    bootstrap: async () => bootstrapFixture({ projects }),
    listTasks: async (id) => ({ tasks: id === "proj_other" ? [crossTask] : [] }),
    listGoals: async (id) => ({ goals: id === "proj_other" ? [goal] : [] }),
    listChannels: async (id) => ({ channels: id === "proj_other" ? [channel] : [] }),
    listPlans: async () => ({ plans: [] }),
    listCheckpoints: async () => ({ checkpoints: [] }),
    listDiscussions: async () => ({ discussions: [] }),
    ...overrides,
  });
}
function Probe() {
  const { selectedProjectId, selectedTaskId } = useSelection();
  const location = useLocation();
  return (
    <>
      <output aria-label="Selected project">{selectedProjectId ?? "default"}</output>
      <output aria-label="Selected task">{selectedTaskId ?? "none"}</output>
      <output aria-label="Route">
        {location.pathname}
        {location.search}
      </output>
    </>
  );
}
function Harness({ blocked = false }: { blocked?: boolean }) {
  return (
    <>
      <CommandPalette blocked={blocked} />
      <Probe />
      <Routes>
        <Route path="/goals" element={<GoalsPage />} />
        <Route path="*" element={null} />
      </Routes>
    </>
  );
}
const trigger = () => screen.getByRole("button", { name: "Open commands (Ctrl or Command + K)" });
const input = () => screen.getByRole("combobox", { name: "Search commands" });
const options = () => within(screen.getByRole("listbox", { name: "Matching commands" }));
async function open() {
  await waitFor(() => expect(trigger()).toBeEnabled());
  await userEvent.click(trigger());
  await screen.findByRole("option", { name: "Project artoo" });
}
async function search(text: string) {
  await userEvent.clear(input());
  await userEvent.type(input(), text);
}

describe("global commands", () => {
  it("keeps a new opening in the committing navigation but closes an existing panel on later navigation", async () => {
    function ConcurrentNavigation() {
      const navigate = useNavigate();
      return (
        <>
          <Harness />
          <button
            type="button"
            onClick={() =>
              startTransition(() => {
                navigate("/board");
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
              })
            }
          >
            Navigate and open commands
          </button>
          <button type="button" onClick={() => navigate("/settings")}>
            Navigate later
          </button>
        </>
      );
    }
    renderWithProviders(<ConcurrentNavigation />, { client: client() });
    await userEvent.click(screen.getByRole("button", { name: "Navigate and open commands" }));
    await waitFor(() => expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/board$/));
    expect(await screen.findByRole("dialog", { name: "Commands" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Navigate later" }));
    await waitFor(() => expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/settings$/));
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("cycles Tab through the modal controls while options retain combobox focus", async () => {
    renderWithProviders(<Harness />, { client: client() });
    await open();
    await search("Go to");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(input()).toHaveFocus();
    fireEvent.mouseDown(options().getByRole("option", { name: "Go to Channels" }));
    expect(input()).toHaveFocus();
  });

  it("loads project lists only on opening, handles Ctrl/Command K once in StrictMode and restores focus", async () => {
    const listTasks = vi.fn<ApiClient["listTasks"]>().mockResolvedValue({ tasks: [] });
    renderWithProviders(
      <StrictMode>
        <Harness />
      </StrictMode>,
      { client: client({ listTasks }) },
    );
    await waitFor(() => expect(trigger()).toBeEnabled());
    expect(listTasks).not.toHaveBeenCalled();
    trigger().focus();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Commands" });
    expect(input()).toHaveFocus();
    await waitFor(() => expect(listTasks).toHaveBeenCalledWith("proj_artoo"));
    fireEvent.keyDown(input(), { key: "k", ctrlKey: true, repeat: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(input(), { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("keeps IME commitment and Escape inside composition, then dismisses normally", async () => {
    renderWithProviders(<Harness />, { client: client() });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true, isComposing: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await open();
    fireEvent.compositionStart(input());
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(input(), { key: "Escape", isComposing: true });
    fireEvent.keyDown(input(), { key: "k", ctrlKey: true, keyCode: 229 });
    expect(screen.getByRole("dialog", { name: "Commands" })).toBeInTheDocument();
    expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/$/);
    fireEvent.compositionEnd(input());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("does not compete with another modal or the navigation drawer", async () => {
    function OtherDialog() {
      const [show, setShow] = useState(false);
      return (
        <>
          <CommandPalette />
          <Button onClick={() => setShow(true)}>Another dialog</Button>
          <Modal open={show} title="Existing editor" onClose={() => setShow(false)}>
            Unsaved work
          </Modal>
        </>
      );
    }
    const view = renderWithProviders(<OtherDialog />, { client: client() });
    await userEvent.click(screen.getByRole("button", { name: "Another dialog" }));
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Existing editor" })).toBeInTheDocument();
    view.unmount();
    renderWithProviders(<Harness blocked />, { client: client() });
    expect(trigger()).toBeDisabled();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("chooses pages by arrows and Enter while retaining combobox focus and ignores held Enter", async () => {
    renderWithProviders(<Harness />, { client: client() });
    await open();
    await search("Go to");
    expect(input()).toHaveFocus();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(options().getByRole("option", { name: "Go to Channels" })).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById(input().getAttribute("aria-activedescendant")!)).toHaveTextContent("Channels");
    fireEvent.keyDown(input(), { key: "Enter", repeat: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/channels$/);
  });

  it.each([
    ["Cross task", "Task Cross task", "/", "task_other"],
    ["Cross goal", "Goal Cross goal", "/goals?goal=goal_other", "none"],
    ["Cross channel", "Channel Cross channel", "/channels?room=room_other&project=proj_other", "none"],
  ])("opens %s in its explicit project scope", async (term, label, route, task) => {
    const listTasks = vi
      .fn<ApiClient["listTasks"]>()
      .mockImplementation(async (id) => ({ tasks: id === "proj_other" ? [crossTask] : [] }));
    renderWithProviders(<Harness />, { client: client({ listTasks }) });
    await open();
    expect(listTasks).not.toHaveBeenCalledWith("proj_other");
    await userEvent.selectOptions(screen.getByLabelText("Search in project"), "proj_other");
    expect(screen.getByLabelText("Selected project")).toHaveTextContent("default");
    await search(term);
    await userEvent.click(await screen.findByRole("option", { name: label }));
    expect(screen.getByLabelText("Selected project")).toHaveTextContent("proj_other");
    expect(screen.getByLabelText("Selected task")).toHaveTextContent(task);
    expect(screen.getByLabelText("Route")).toHaveTextContent(route);
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("does not expose mismatched project/organization rows or removed projects in stale caches", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["tasks", "proj_removed"], {
      tasks: [taskFixture({ id: "secret", title: "Removed secret", project_id: "proj_removed", status: "backlog" })],
    });
    renderWithProviders(<Harness />, {
      queryClient,
      client: client({
        listTasks: async () => ({
          tasks: [
            crossTask,
            taskFixture({ id: "foreign", title: "Foreign secret", organization_id: "org_other", status: "backlog" }),
          ],
        }),
        listGoals: async () => ({ goals: [goal] }),
        listChannels: async () => ({ channels: [channel] }),
      }),
    });
    await open();
    await search("Cross");
    await screen.findByText("No matching commands.");
    await search("secret");
    expect(options().queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByLabelText("Search in project")).not.toHaveTextContent("proj_removed");
  });

  it("shows list failures, suppresses failed cached results, and retries the actual scoped request", async () => {
    const queryClient = createTestQueryClient();
    const listTasks = vi
      .fn<ApiClient["listTasks"]>()
      .mockRejectedValueOnce(Error("forbidden"))
      .mockResolvedValue({ tasks: [taskFixture({ id: "recovered", title: "Recovered task", status: "backlog" })] });
    queryClient.setQueryData(["tasks", "proj_artoo"], {
      tasks: [taskFixture({ id: "stale", title: "Stale task", status: "backlog" })],
    });
    renderWithProviders(<Harness />, { queryClient, client: client({ listTasks }) });
    await open();
    await screen.findByRole("button", { name: "Retry tasks" });
    await search("Stale task");
    expect(options().queryAllByRole("option")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Retry tasks" }));
    await search("Recovered task");
    expect(await screen.findByRole("option", { name: "Task Recovered task" })).toBeInTheDocument();
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(listTasks).toHaveBeenLastCalledWith("proj_artoo");
  });

  it("discards a late scoped response after refreshed bootstrap removes that project", async () => {
    const queryClient = createTestQueryClient();
    let finish!: (value: { tasks: (typeof crossTask)[] }) => void;
    const pending = new Promise<{ tasks: (typeof crossTask)[] }>((resolve) => {
      finish = resolve;
    });
    renderWithProviders(<Harness />, {
      queryClient,
      client: client({
        listTasks: (id) => (id === "proj_other" ? pending : Promise.resolve({ tasks: [] })),
      }),
    });
    await open();
    await userEvent.selectOptions(screen.getByLabelText("Search in project"), "proj_other");
    await act(async () => {
      queryClient.setQueryData(["bootstrap"], bootstrapFixture({ projects: [projects[0]!] }));
      finish({ tasks: [crossTask] });
    });
    await waitFor(() => expect(screen.getByLabelText("Search in project")).toHaveValue(""));
    await search("Cross task");
    expect(options().queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByLabelText("Selected project")).toHaveTextContent("default");
  });

  it("keeps project errors visible and recovers the initial scope through an explicit retry", async () => {
    const bootstrap = vi
      .fn<ApiClient["bootstrap"]>()
      .mockRejectedValueOnce(Error("unauthorized"))
      .mockResolvedValue(bootstrapFixture({ projects }));
    const listTasks = vi.fn<ApiClient["listTasks"]>().mockResolvedValue({ tasks: [] });
    renderWithProviders(<Harness />, { client: client({ bootstrap, listTasks }) });
    await userEvent.click(trigger());
    await screen.findByRole("button", { name: "Retry projects" });
    expect(listTasks).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry projects" }));
    await waitFor(() => expect(screen.getByLabelText("Search in project")).toHaveValue("proj_artoo"));
    await waitFor(() => expect(listTasks).toHaveBeenCalledWith("proj_artoo"));
  });

  it("opens the real task and goal forms without submitting work", async () => {
    const createTask = vi.fn<ApiClient["createTask"]>();
    const createGoal = vi.fn<ApiClient["createGoal"]>();
    const createAutonomousGoal = vi.fn<ApiClient["createAutonomousGoal"]>();
    renderWithProviders(<Harness />, { client: client({ createTask, createGoal, createAutonomousGoal }) });
    await open();
    await search("New task");
    await userEvent.click(options().getByRole("option", { name: "Create New task" }));
    const taskDialog = await screen.findByRole("dialog", { name: "Create task" });
    expect(createTask).not.toHaveBeenCalled();
    await userEvent.click(within(taskDialog).getByRole("button", { name: "Cancel" }));
    await open();
    await search("New goal");
    await userEvent.click(options().getByRole("option", { name: "Create New goal" }));
    expect(await screen.findByRole("dialog", { name: "New goal" })).toBeInTheDocument();
    expect(createGoal).not.toHaveBeenCalled();
    expect(createAutonomousGoal).not.toHaveBeenCalled();
  });

  it("retains an open task draft when background bootstrap refresh fails", async () => {
    const queryClient = createTestQueryClient();
    const bootstrap = vi.fn<ApiClient["bootstrap"]>().mockResolvedValue(bootstrapFixture({ projects }));
    renderWithProviders(<Harness />, { queryClient, client: client({ bootstrap }) });
    await open();
    await search("New task");
    await userEvent.click(options().getByRole("option", { name: "Create New task" }));
    const dialog = await screen.findByRole("dialog", { name: "Create task" });
    await userEvent.type(within(dialog).getByLabelText("Title"), "Keep this draft");
    bootstrap.mockRejectedValue(Error("offline"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["bootstrap"] });
    });
    await waitFor(() => expect(queryClient.getQueryState(["bootstrap"])?.status).toBe("error"));
    expect(screen.getByRole("dialog", { name: "Create task" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Keep this draft");
  });

  it.each([false, true])(
    "keeps a prepared or invalid prepared entry out of manual New goal (invalid=%s)",
    async (invalid) => {
      const prepared: PreparedGoalEntryV1 = {
        version: 1,
        session_id: "console-session",
        project_id: "proj_artoo",
        goal_id: null,
        submission_owner: "console",
      };
      renderWithProviders(<Harness />, {
        client: client({
          bootstrap: async () =>
            bootstrapFixture({
              projects,
              goal_entry: invalid ? ({ ...prepared, version: 99 } as unknown as PreparedGoalEntryV1) : prepared,
            }),
        }),
      });
      await open();
      await search("New goal");
      expect(options().queryAllByRole("option")).toHaveLength(0);
    },
  );

  it("distinguishes no matches from loading and bounds the rendered results", async () => {
    let finish!: (value: { tasks: ReturnType<typeof taskFixture>[] }) => void;
    const pending = new Promise<{ tasks: ReturnType<typeof taskFixture>[] }>((resolve) => {
      finish = resolve;
    });
    renderWithProviders(<Harness />, { client: client({ listTasks: () => pending }) });
    await open();
    expect(screen.getByText("Loading tasks…")).toBeInTheDocument();
    await search("Large task");
    expect(screen.queryByText("No matching commands.")).not.toBeInTheDocument();
    await act(async () =>
      finish({
        tasks: Array.from({ length: 60 }, (_, i) =>
          taskFixture({ id: `task_${i}`, title: `Large task ${i}`, status: "backlog" }),
        ),
      }),
    );
    await search("Large task");
    expect(options().getAllByRole("option")).toHaveLength(50);
    expect(screen.getByText("Showing the first 50 matches. Refine your search.")).toBeInTheDocument();
    await search("nothing matches");
    expect(screen.getByText("No matching commands.")).toBeInTheDocument();
  });
});
