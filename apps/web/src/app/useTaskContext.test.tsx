// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it } from "vitest";
import { bootstrapFixture, fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { useTaskContext } from "./useTaskContext.js";
import { useProject } from "./useProject.js";

function Probe() {
  const task = useTaskContext();
  const { projectId } = useProject();
  return (
    <>
      <output aria-label="Task">{task.taskId ?? "none"}</output>
      <output aria-label="Project">{projectId}</output>
      <output aria-label="Error">{task.contextError?.message ?? "none"}</output>
      <button onClick={() => task.selectTask(null)}>Close</button>
    </>
  );
}
const task = taskFixture({ id: "linked", title: "Linked task", status: "ready", project_id: "target" });
const snapshot = { task, room: null, runs: [], approvals: [], artifacts: [] };

it("resolves task and project after a direct navigation and clears selection when closed", async () => {
  renderWithProviders(<Probe />, {
    route: "/board?task=linked&project=target",
    client: fakeApi({
      bootstrap: async () =>
        bootstrapFixture({
          projects: [
            { id: "first", name: "First", default_workspace: null },
            { id: "target", name: "Target", default_workspace: null },
          ],
        }),
      getTask: async () => snapshot,
    }),
  });
  await waitFor(() => expect(screen.getByLabelText("Project")).toHaveTextContent("target"));
  expect(screen.getByLabelText("Task")).toHaveTextContent("linked");
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByLabelText("Task")).toHaveTextContent("none");
});

it("does not show a task whose server project conflicts with the shared URL", async () => {
  renderWithProviders(<Probe />, {
    route: "/board?task=linked&project=proj_artoo",
    client: fakeApi({ bootstrap: async () => bootstrapFixture(), getTask: async () => snapshot }),
  });
  await waitFor(() => expect(screen.getByLabelText("Error")).toHaveTextContent("could not be verified"));
  expect(screen.getByLabelText("Task")).toHaveTextContent("none");
  expect(screen.getByLabelText("Project")).toHaveTextContent("proj_artoo");
});
