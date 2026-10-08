// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderWithProviders } from "../test/utils.js";
import { DesktopSettings } from "./DesktopSetup.js";

afterEach(() => { Reflect.deleteProperty(window, "artooDesktop"); });
function setup({ platform = "darwin", state = "stopped", locked = false, prepared = false } = {}) {
  let config: DesktopDaemonConfig = { allowedRoots: ["/workspace"], runtimes: ["codex"], trustedExecution: false, allowNewAllocations: false };
  let managedWorkspace: DesktopManagedWorkspaceStatus = { state: prepared ? "ready" : "unprepared" };
  const configureDaemon = vi.fn(async (input: DesktopDaemonInput) => { config = input as DesktopDaemonConfig; });
  const prepareManagedWorkspace = vi.fn(async () => { managedWorkspace = { state: "ready" }; });
  const startDaemon = vi.fn(async () => {});
  Object.defineProperty(window, "artooDesktop", { configurable: true, value: {
    platform, serverUrl: "https://team.example", getConnection: async () => ({ serverUrl: "https://team.example", paired: true, deviceId: "device", computerId: "computer" }),
    daemonStatus: async () => ({ state, configurationLocked: locked, config, managedWorkspace }),
    configureDaemon, prepareManagedWorkspace, startDaemon, stopDaemon: vi.fn(async () => {}), restartDaemon: vi.fn(async () => {}),
  } });
  renderWithProviders(<DesktopSettings />, { client: fakeApi({}) });
  return { configureDaemon, prepareManagedWorkspace, startDaemon,
    failPreparation() { prepareManagedWorkspace.mockImplementationOnce(async () => { managedWorkspace = { state: "incomplete" }; throw new Error("Preparation was interrupted"); }); } };
}

describe("desktop separate workspace settings", () => {
  it("prepares explicitly, then saves allocation choice separately from starting", async () => {
    const bridge = setup();
    const choice = await screen.findByLabelText("Allow new tasks in separate workspaces");
    expect(choice).toBeDisabled(); expect(choice).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Prepare separate workspaces" }));
    expect(bridge.prepareManagedWorkspace).toHaveBeenCalledWith();
    await screen.findByText("Ready for separate task workspaces");
    expect(choice).not.toBeDisabled();
    expect(bridge.configureDaemon).not.toHaveBeenCalled(); expect(bridge.startDaemon).not.toHaveBeenCalled();
    await userEvent.click(choice);
    await userEvent.type(screen.getByLabelText("Git repository for isolated worktrees"), "/workspace/project");
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await screen.findByText("Worker configuration saved.");
    expect(bridge.configureDaemon).toHaveBeenCalledWith(expect.objectContaining({ allowNewAllocations: true }));
    expect(bridge.startDaemon).not.toHaveBeenCalled();
    await userEvent.click(choice);
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await waitFor(() => expect(bridge.configureDaemon).toHaveBeenLastCalledWith(expect.objectContaining({ allowNewAllocations: false })));
  });

  it("retains a rejected allocation edit and does not display a saved or running outcome", async () => {
    const bridge = setup({ prepared: true });
    const choice = await screen.findByLabelText("Allow new tasks in separate workspaces");
    await userEvent.click(choice);
    await userEvent.type(screen.getByLabelText("Git repository for isolated worktrees"), "/workspace/project");
    bridge.configureDaemon.mockRejectedValueOnce(new Error("Worker cleanup is not confirmed"));
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cleanup is not confirmed");
    expect(choice).toBeChecked(); expect(screen.queryByText("Worker configuration saved.")).toBeNull();
    expect(bridge.startDaemon).not.toHaveBeenCalled();
  });

  it("requires a repository for enabling while preserving repo-free ordinary settings", async () => {
    const bridge = setup({ prepared: true });
    const choice = await screen.findByLabelText("Allow new tasks in separate workspaces");
    expect(screen.getByLabelText("Git repository for isolated worktrees (optional)")).not.toBeRequired();
    await userEvent.click(choice);
    const repository = screen.getByLabelText("Git repository for isolated worktrees");
    expect(repository).toBeRequired(); expect(repository).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a Git repository before enabling new task allocations");
    const save = screen.getByRole("button", { name: "Save worker configuration" });
    expect(save).toBeDisabled(); await userEvent.click(save);
    expect(bridge.configureDaemon).not.toHaveBeenCalled();
    expect(choice).toBeChecked(); expect(screen.getByLabelText("Allowed workspace folders")).toHaveValue("/workspace");
    await userEvent.click(choice);
    expect(screen.getByLabelText("Git repository for isolated worktrees (optional)")).not.toBeRequired();
    expect(save).not.toBeDisabled(); await userEvent.click(save);
    await screen.findByText("Worker configuration saved.");
    expect(bridge.configureDaemon).toHaveBeenCalledWith(expect.objectContaining({ allowNewAllocations: false }));
    expect(bridge.configureDaemon.mock.calls[0]![0]).not.toHaveProperty("worktreeBaseRepo");
    expect(bridge.prepareManagedWorkspace).not.toHaveBeenCalled(); expect(bridge.startDaemon).not.toHaveBeenCalled();
  });

  it("shows a retained incomplete setup after failure and cannot prepare or start again", async () => {
    const bridge = setup(); bridge.failPreparation();
    await screen.findByLabelText("Allowed workspace folders");
    await userEvent.click(screen.getByRole("button", { name: "Prepare separate workspaces" }));
    await screen.findByText("Previous preparation is incomplete. Its data has been retained.");
    expect(screen.getByRole("button", { name: "Prepare separate workspaces" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start worker" })).toBeDisabled();
    expect(screen.getByLabelText("Allow new tasks in separate workspaces")).toBeDisabled();
    expect(bridge.configureDaemon).not.toHaveBeenCalled();
  });

  it.each(["starting", "running", "stopping", "failed"])("locks settings when process or cleanup remains owned (%s)", async (state) => {
    setup({ state, locked: true });
    expect(await screen.findByLabelText("Allowed workspace folders")).toBeDisabled();
    expect(screen.getByLabelText("Allow new tasks in separate workspaces")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save worker configuration" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Prepare separate workspaces" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start worker" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect this app" })).toBeDisabled();
  });

  it("keeps Mac preparation controls out of Windows settings", async () => {
    setup({ platform: "win32" });
    await screen.findByLabelText("Allowed workspace folders");
    expect(screen.queryByRole("group", { name: "Separate task workspaces" })).toBeNull();
    expect(screen.queryByLabelText("Allow new tasks in separate workspaces")).toBeNull();
  });
});
