// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { useProject } from "../app/useProject.js";
import { useSelection } from "../app/SelectionContext.js";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { Nav } from "./Nav.js";
import { OverviewPage } from "./OverviewPage.js";
import { SettingsPage } from "./SettingsPage.js";

function ProjectNavigation() {
  const location = useLocation();
  const { project } = useProject();
  const { selectedTaskId, setSelectedTaskId } = useSelection();
  return (
    <>
      <Nav />
      <button onClick={() => setSelectedTaskId("task_previous")}>Select task</button>
      <output aria-label="Current project">{project?.id ?? "none"}</output>
      <output aria-label="Current task">{selectedTaskId ?? "none"}</output>
      <output aria-label="Route">
        {location.pathname}
        {location.search}
      </output>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="*" element={<p>Project content</p>} />
      </Routes>
    </>
  );
}

describe("Project creation navigation", () => {
  it("clears the selected project and task and closes project content when the mouse leaves", async () => {
    const user = userEvent.setup();
    const snapshot = bootstrapFixture();
    snapshot.projects.push({ id: "proj_other", name: "Other project", default_workspace: null });
    renderWithProviders(<ProjectNavigation />, {
      route: "/channels?room=old&thread=old",
      client: fakeApi({ bootstrap: async () => snapshot }),
    });
    const project = await screen.findByRole("button", { name: "Other project" });
    await user.click(project);
    screen.getByRole("button", { name: "Select task" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Current task")).toHaveTextContent("task_previous");
    await user.unhover(project);
    expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/overview$/);
    expect(screen.getByLabelText("Current project")).toHaveTextContent("none");
    expect(screen.getByLabelText("Current task")).toHaveTextContent("none");
    expect(screen.getByRole("button", { name: "artoo" })).toHaveAttribute("aria-pressed", "false");
    expect(project).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Project content")).not.toBeInTheDocument();
    expect(await screen.findByText("Select a project", { exact: true })).toBeVisible();
    project.focus();
    await user.keyboard("{Enter}");
    expect(project).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Current project")).toHaveTextContent("proj_other");
    expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/board$/);
  });

  it("keeps the active project when the mouse leaves an unselected project", async () => {
    const user = userEvent.setup();
    const snapshot = bootstrapFixture();
    snapshot.projects.push({ id: "proj_other", name: "Other project", default_workspace: null });
    renderWithProviders(<ProjectNavigation />, {
      route: "/channels",
      client: fakeApi({ bootstrap: async () => snapshot }),
    });
    const other = await screen.findByRole("button", { name: "Other project" });
    await user.hover(other);
    await user.unhover(other);
    expect(screen.getByLabelText("Current project")).toHaveTextContent("proj_artoo");
    expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/channels$/);
  });

  it("opens creation from the project plus and selects the saved project", async () => {
    const snapshot = bootstrapFixture();
    const project = { id: "proj_new", name: "New workspace", default_workspace: "C:/workspace/new" };
    const createProject = vi.fn(async () => {
      snapshot.projects.push(project);
      return { project };
    });
    renderWithProviders(<ProjectNavigation />, {
      route: "/channels",
      client: fakeApi({ bootstrap: async () => snapshot, listDevices: async () => ({ devices: [] }), createProject }),
    });
    await userEvent.click(await screen.findByRole("link", { name: "New project" }));
    const dialog = screen.getByRole("dialog", { name: "New project" });
    await userEvent.type(within(dialog).getByLabelText("Project name"), project.name);
    await userEvent.type(within(dialog).getByLabelText("Default workspace"), project.default_workspace);
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(createProject).toHaveBeenCalledExactlyOnceWith(
      { name: project.name, default_workspace: project.default_workspace },
      expect.any(String),
    );
    expect(screen.getByRole("button", { name: project.name })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/settings$/);
  });

  it("closes and reopens creation while already on Settings, preserving other parameters", async () => {
    renderWithProviders(<ProjectNavigation />, {
      route: "/settings?keep=value&create=project",
      client: fakeApi({ bootstrap: async () => bootstrapFixture(), listDevices: async () => ({ devices: [] }) }),
    });
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New project" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/settings\?keep=value$/);
    await userEvent.click(screen.getByRole("link", { name: "New project" }));
    expect(screen.getByRole("dialog", { name: "New project" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New project" })).not.toBeInTheDocument();
  });

  it("does not offer project creation to members even with a direct creation URL", async () => {
    const snapshot = bootstrapFixture();
    snapshot.user.role = "member";
    renderWithProviders(<ProjectNavigation />, {
      route: "/settings?create=project",
      client: fakeApi({ bootstrap: async () => snapshot, listDevices: async () => ({ devices: [] }) }),
    });
    await screen.findByRole("button", { name: "artoo" });
    expect(screen.queryByRole("link", { name: "New project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "New project" })).not.toBeInTheDocument();
  });
});
