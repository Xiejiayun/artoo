// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentInstance, WorktreeBaseConfiguration } from "@artoo/domain";
import type { BootstrapResponse } from "../api/types.js";
import { ApiClientError } from "../api/client.js";
import { queryKeys } from "../app/queryKeys.js";
import { bootstrapFixture, createTestQueryClient, fakeApi, renderWithProviders } from "../test/utils.js";
import { AgentsPage } from "./InventoryPages.js";

const instanceId = "instance_mock_coder";
const initialSetting = { version: 1, strategy: "per-run", basePath: "/Approved//Existing runs /" } as const;
async function setup({ role = "owner", os = "darwin", setting }: { role?: string; os?: string; setting?: WorktreeBaseConfiguration } = {}) {
  let data = bootstrapFixture();
  data.user.role = role; data.computers[0]!.os = os;
  data.agent_instances[0]!.workspace_root = "/Users/team/project";
  if (setting) data.agent_instances[0]!.config = { worktree_workspace_base: setting };
  const snapshot = () => structuredClone(data);
  const update = (setting: WorktreeBaseConfiguration | null): { agent_instance: AgentInstance } => {
    const instance = data.agent_instances[0]!;
    const config = { ...instance.config };
    if (setting) config.worktree_workspace_base = setting;
    else delete config.worktree_workspace_base;
    data = { ...data, agent_instances: [{ ...instance, config }] };
    return { agent_instance: structuredClone(data.agent_instances[0]!) };
  };
  const bootstrap = vi.fn(async () => snapshot());
  const setAgentWorktreeBase = vi.fn(async (_id: string, setting: WorktreeBaseConfiguration) => update(setting));
  const clearAgentWorktreeBase = vi.fn(async (_id: string) => update(null));
  const registerAgent = vi.fn(async () => ({}));
  const user = userEvent.setup();
  const queryClient = createTestQueryClient();
  const rendered = renderWithProviders(<AgentsPage />, { queryClient, route: "/agents", client: fakeApi({ bootstrap, setAgentWorktreeBase, clearAgentWorktreeBase,
    registerAgent, listDaemons: async () => ({ daemons: [] }) }) });
  const card = await screen.findByRole("article", { name: "Mock Coder" });
  await user.click(within(card).getByText("Workspace & configuration"));
  await waitFor(() => expect(queryClient.isFetching({ queryKey: queryKeys.bootstrap })).toBe(0));
  return { ...rendered, user, card, bootstrap, setAgentWorktreeBase, clearAgentWorktreeBase, registerAgent, snapshot, update };
}
async function editBase(f: Awaited<ReturnType<typeof setup>>, path: string) {
  const checkbox = within(f.card).getByRole("checkbox", { name: "Separate workspace for each task" });
  if (!(checkbox as HTMLInputElement).checked) await f.user.click(checkbox);
  const field = within(f.card).getByLabelText("Task workspace base folder");
  await f.user.clear(field); await f.user.type(field, path);
  return field;
}

describe("per-agent task workspace setting", () => {
  it.each(["owner", "admin"])("offers the accessible workspace form to %s", async (role) => {
    const f = await setup({ role });
    expect(within(f.card).getByRole("form", { name: "Task workspace configuration" })).toBeVisible();
    expect(within(f.card).getByRole("checkbox", { name: "Separate workspace for each task" })).not.toBeChecked();
    expect(within(f.card).queryByLabelText("Task workspace base folder")).toBeNull();
    expect(within(f.card).getByRole("button", { name: "Save task workspace setting" })).toBeDisabled();
    expect(f.registerAgent).not.toHaveBeenCalled();
  });

  it.each(["member", "viewer"])("keeps setting controls unavailable to %s", async (role) => {
    const f = await setup({ role, setting: initialSetting });
    expect(within(f.card).queryByRole("form", { name: "Task workspace configuration" })).toBeNull();
    expect(within(f.card).queryByRole("checkbox", { name: "Separate workspace for each task" })).toBeNull();
    expect(f.setAgentWorktreeBase).not.toHaveBeenCalled(); expect(f.clearAgentWorktreeBase).not.toHaveBeenCalled();
  });

  it("renders the exact saved setting in the existing workspace details", async () => {
    const f = await setup({ setting: initialSetting });
    expect(within(f.card).getByRole("checkbox", { name: "Separate workspace for each task" })).toBeChecked();
    expect(within(f.card).getByLabelText("Task workspace base folder")).toHaveValue(initialSetting.basePath);
    expect(within(f.card).getByText(initialSetting.basePath, { selector: "code" })).toBeVisible();
    expect(within(f.card).getByRole("button", { name: "Save task workspace setting" })).toBeDisabled();
    expect(within(f.card).getByText(/does not grant access to folders/)).toBeVisible();
  });

  it("sends only version, strategy and the exact base path, then reloads committed settings", async () => {
    const f = await setup(); const basePath = "/Users/team/Task runs /";
    await editBase(f, basePath);
    await f.user.click(within(f.card).getByRole("button", { name: "Save task workspace setting" }));
    await within(f.card).findByText("Task workspace setting saved.");
    expect(f.setAgentWorktreeBase).toHaveBeenCalledWith(instanceId, { version: 1, strategy: "per-run", basePath });
    expect(f.bootstrap.mock.calls.length).toBeGreaterThan(1);
    expect(within(f.card).getByLabelText("Task workspace base folder")).toHaveValue(basePath);
    expect(f.registerAgent).not.toHaveBeenCalled();
    expect(f.clearAgentWorktreeBase).not.toHaveBeenCalled();
  });

  it("clears the setting with the dedicated DELETE operation and refreshed absent config", async () => {
    const f = await setup({ setting: initialSetting });
    await f.user.click(within(f.card).getByRole("checkbox", { name: "Separate workspace for each task" }));
    await f.user.click(within(f.card).getByRole("button", { name: "Save task workspace setting" }));
    await within(f.card).findByText("Task workspace setting saved.");
    expect(f.clearAgentWorktreeBase).toHaveBeenCalledWith(instanceId);
    expect(f.setAgentWorktreeBase).not.toHaveBeenCalled();
    expect(within(f.card).getByRole("checkbox", { name: "Separate workspace for each task" })).not.toBeChecked();
    expect(within(f.card).getByText(/Use the agent’s registered workspace/)).toBeVisible();
  });

  it("does not show saved before both the write and the new bootstrap read finish", async () => {
    const f = await setup(); const path = "/Users/team/New runs";
    let resolveWrite!: () => void, resolveRead!: (value: BootstrapResponse) => void;
    const writeWait = new Promise<void>((resolve) => { resolveWrite = resolve; });
    const readWait = new Promise<BootstrapResponse>((resolve) => { resolveRead = resolve; });
    f.setAgentWorktreeBase.mockImplementationOnce(async (_id, setting) => { await writeWait; return f.update(setting); });
    f.bootstrap.mockImplementationOnce(() => readWait);
    const callsBefore = f.bootstrap.mock.calls.length;
    await editBase(f, path);
    await f.user.click(within(f.card).getByRole("button", { name: "Save task workspace setting" }));
    await waitFor(() => expect(f.setAgentWorktreeBase).toHaveBeenCalledOnce());
    expect(within(f.card).queryByText("Task workspace setting saved.")).toBeNull();
    resolveWrite();
    await waitFor(() => expect(f.bootstrap.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(within(f.card).queryByText("Task workspace setting saved.")).toBeNull();
    expect(within(f.card).getByText(/Use the agent’s registered workspace/)).toBeVisible();
    expect(within(f.card).getByLabelText("Task workspace base folder")).toBeDisabled();
    resolveRead(f.snapshot());
    await within(f.card).findByText("Task workspace setting saved.");
  });

  it.each([
    new ApiClientError("invalid_state", "Stop the active run before changing this agent instance", 409),
    new ApiClientError("network_error", "Network request failed: offline", 0),
  ])("retains input and the actual error on a failed write: $message", async (error) => {
    const f = await setup(); const path = "/Users/team/Retained edit";
    f.setAgentWorktreeBase.mockRejectedValueOnce(error);
    await editBase(f, path);
    await f.user.click(within(f.card).getByRole("button", { name: "Save task workspace setting" }));
    expect(await within(f.card).findByRole("alert")).toHaveTextContent(error.message);
    expect(within(f.card).getByLabelText("Task workspace base folder")).toHaveValue(path);
    expect(within(f.card).getByRole("checkbox", { name: "Separate workspace for each task" })).toBeChecked();
    expect(within(f.card).queryByText("Task workspace setting saved.")).toBeNull();
    await f.user.click(within(f.card).getByRole("button", { name: "Save task workspace setting" }));
    await within(f.card).findByText("Task workspace setting saved.");
    expect(f.setAgentWorktreeBase).toHaveBeenCalledTimes(2);
  });

  it("preserves the mounted draft when the write commits but bootstrap refresh fails", async () => {
    const f = await setup(); const path = "/Users/team/Keep through refresh";
    f.bootstrap.mockRejectedValueOnce(new Error("Connection lost during refresh"));
    await editBase(f, path);
    await f.user.click(within(f.card).getByRole("button", { name: "Save task workspace setting" }));
    expect(await within(f.card).findByRole("alert")).toHaveTextContent("The server accepted the workspace setting, but refreshing agent settings failed.");
    expect(within(f.card).getByRole("alert")).toHaveTextContent("Connection lost during refresh");
    expect(within(f.card).getByLabelText("Task workspace base folder")).toHaveValue(path);
    expect(within(f.card).queryByText("Task workspace setting saved.")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry agent settings" })).toBeVisible();
  });

  it("does not declare success if refreshed config differs from the accepted write", async () => {
    const f = await setup(); const before = f.snapshot(); const path = "/Users/team/Requested runs";
    f.bootstrap.mockResolvedValueOnce(before);
    await editBase(f, path);
    await f.user.click(within(f.card).getByRole("button", { name: "Save task workspace setting" }));
    expect(await within(f.card).findByRole("alert")).toHaveTextContent("refreshed agent settings differ");
    expect(within(f.card).getByLabelText("Task workspace base folder")).toHaveValue(path);
    expect(within(f.card).queryByText("Task workspace setting saved.")).toBeNull();
  });

  it("requires a Mac absolute folder without normalizing a relative entry", async () => {
    const f = await setup();
    const field = await editBase(f, "relative/runs");
    expect(field).toHaveValue("relative/runs");
    expect(within(f.card).getByRole("alert")).toHaveTextContent("absolute folder path");
    expect(within(f.card).getByRole("button", { name: "Save task workspace setting" })).toBeDisabled();
    expect(f.setAgentWorktreeBase).not.toHaveBeenCalled();
  });

  it("blocks a new setting on a non-Mac execution computer", async () => {
    const f = await setup({ os: "windows" });
    expect(within(f.card).getByRole("checkbox", { name: "Separate workspace for each task" })).toBeDisabled();
    expect(within(f.card).getByText(/require a Mac execution computer/)).toBeVisible();
    expect(f.setAgentWorktreeBase).not.toHaveBeenCalled();
  });

  it("can clear an existing setting on another OS without granting a new one", async () => {
    const f = await setup({ os: "windows", setting: initialSetting });
    expect(within(f.card).getByLabelText("Task workspace base folder")).toBeDisabled();
    await f.user.click(within(f.card).getByRole("checkbox", { name: "Separate workspace for each task" }));
    await f.user.click(within(f.card).getByRole("button", { name: "Save task workspace setting" }));
    await within(f.card).findByText("Task workspace setting saved.");
    expect(f.clearAgentWorktreeBase).toHaveBeenCalledWith(instanceId);
    expect(f.setAgentWorktreeBase).not.toHaveBeenCalled();
  });
});
