// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useLocation } from "react-router-dom";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { useSelection } from "../app/SelectionContext.js";
import { Nav } from "./Nav.js";
import { ProductHeader } from "./ProductHeader.js";
import { initializeTheme, ThemeControl } from "./ThemeControl.js";

function SelectionProbe() {
  const { selectedTaskId, setSelectedTaskId } = useSelection();
  const location = useLocation();
  return <><button onClick={() => setSelectedTaskId("task_previous")}>Select old task</button><output aria-label="Current task">{selectedTaskId ?? "none"}</output><output aria-label="Route">{location.pathname}{location.search}</output></>;
}
const client = () => fakeApi({ bootstrap: async () => bootstrapFixture({ projects: [{ id: "proj_artoo", name: "artoo", default_workspace: "C:/workspace/artoo" }, { id: "proj_other", name: "Second project", default_workspace: null }] }), listNotifications: async () => ({ notifications: [], unread_count: 0, has_more: false, next_before: null }) });

describe("Product shell", () => {
  beforeEach(() => { window.localStorage.clear(); delete document.documentElement.dataset.theme; });

  it("switches project, clears stale task selection, and starts a clean thread route", async () => {
    renderWithProviders(<><Nav /><SelectionProbe /></>, { client: client(), route: "/channels?room=old&thread=old" });
    await userEvent.click(screen.getByRole("button", { name: "Select old task" }));
    await userEvent.click(await screen.findByRole("button", { name: "Second project" }));
    await waitFor(() => expect(screen.getByLabelText("Route")).toHaveTextContent(/^\/channels$/));
    expect(screen.getByLabelText("Current task")).toHaveTextContent("none");
    expect(screen.getByRole("button", { name: "Second project" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "Connect Local Node" })).toHaveAttribute("href", "/computers?connect=1");
    expect(within(screen.getByRole("region", { name: "Agent Squad" })).getByText("Mock Coder")).toBeInTheDocument();
  });

  it("shows backed project views and marks Release active", async () => {
    renderWithProviders(<ProductHeader menuOpen={false} onToggleMenu={() => undefined} detailsOpen={true} onToggleDetails={() => undefined} />, { client: client(), route: "/release" });
    const tabs = screen.getByRole("navigation", { name: "Project views" });
    expect(within(tabs).getByRole("link", { name: "Release" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "Thread" })).toHaveAttribute("href", "/channels");
    expect(within(tabs).getByRole("link", { name: "Plan" })).toHaveAttribute("href", "/goals");
    expect(within(tabs).getByRole("link", { name: "Board" })).toHaveAttribute("href", "/board");
    expect(screen.queryByRole("button", { name: "Toggle task details" })).not.toBeInTheDocument();
  });

  it("defaults to dark and persists the user's light theme choice", async () => {
    expect(initializeTheme()).toBe("dark");
    renderWithProviders(<ThemeControl />, { client: client() });
    await userEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("artoo.theme")).toBe("light");
    delete document.documentElement.dataset.theme;
    expect(initializeTheme()).toBe("light");
    await userEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});
