// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRetentionProjection } from "@artoo/domain";
import { fakeApi, renderWithProviders, runFixture } from "../test/utils.js";
import { RunTimeline } from "./RunTimeline.js";

const report: WorkspaceRetentionProjection = {
  version: 1, workspace_root: "/Users/Owner/Artoo work/run_1", workspace_branch: "artoo/run-1",
  outcome: "completed", reporter_computer_id: "computer_1", event_id: "evt_retention",
  position: 41, sequence: 4, reported_at: "2026-10-01T01:02:03.000Z",
};
const run = () => runFixture({ id: "run_1", status: "completed", computer_id: "computer_1",
  workspace_root: report.workspace_root, workspace_branch: report.workspace_branch, workspace_retention: report });

afterEach(() => { Reflect.deleteProperty(window, "artooDesktop"); vi.restoreAllMocks(); });

describe("workspace retention presentation", () => {
  it("shows exact persisted recovery identity without requiring a live output cache", () => {
    renderWithProviders(<RunTimeline runs={[run()]} computers={[{ id: "computer_1", display_name: "Studio Mac", hostname: "studio" }]} />, { client: fakeApi({}) });
    const workspace = within(screen.getByRole("region", { name: "Workspace for run_1" }));
    expect(workspace.getByText("Work retention reported")).toBeInTheDocument();
    expect(workspace.getByText("run_1", { exact: true })).toBeInTheDocument();
    expect(workspace.getByText("Studio Mac")).toBeInTheDocument();
    expect(workspace.getByText("computer_1")).toBeInTheDocument();
    expect(workspace.getByText(report.workspace_root)).toBeInTheDocument();
    expect(workspace.getByText(report.workspace_branch)).toBeInTheDocument();
    expect(workspace.getByText("Execution completed")).toBeInTheDocument();
    expect(workspace.getByText("This is the worker's report at that time. Current file availability has not been checked.")).toBeInTheDocument();
    expect(workspace.getByText(new Date(report.reported_at).toLocaleString())).toHaveAttribute("datetime", report.reported_at);
  });

  it("keeps planned location separate when only a legacy output line claims retention", () => {
    renderWithProviders(<RunTimeline runs={[{ ...run(), workspace_retention: undefined }]}
      outputsByRun={{ run_1: [`Worktree retained for recovery: ${JSON.stringify(report)}`] }} />, { client: fakeApi({}) });
    const workspace = within(screen.getByRole("region", { name: "Workspace for run_1" }));
    expect(workspace.getByText("Retention not reported")).toBeInTheDocument();
    expect(workspace.getByText("Planned workspace")).toBeInTheDocument();
    expect(workspace.queryByText("Work retention reported")).not.toBeInTheDocument();
    expect(workspace.queryByText("Execution completed")).not.toBeInTheDocument();
  });

  it.each([
    { version: 2 }, { reporter_computer_id: "computer_other" }, { workspace_root: "/foreign/path" },
    { workspace_branch: "foreign-branch" }, { position: 0 }, { reported_at: "yesterday" },
  ])("does not promote unsupported or inconsistent metadata: %j", (change) => {
    renderWithProviders(<RunTimeline runs={[{ ...run(), workspace_retention: { ...report, ...change } as WorkspaceRetentionProjection }]} />, { client: fakeApi({}) });
    const workspace = within(screen.getByRole("region", { name: "Workspace for run_1" }));
    expect(workspace.getByText("Retention not reported")).toBeInTheDocument();
    expect(workspace.queryByText("Work retention reported")).not.toBeInTheDocument();
    expect(workspace.queryByText("/foreign/path")).not.toBeInTheDocument();
  });

  it("copies the exact path as data and exposes clipboard failure", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const original = "/Users/Owner/Artoo work/ trailing ";
    renderWithProviders(<RunTimeline runs={[{ ...run(), workspace_root: original,
      workspace_retention: { ...report, workspace_root: original } }]} />, { client: fakeApi({}) });
    await user.click(screen.getByRole("button", { name: "Copy workspace path" }));
    expect(write).toHaveBeenCalledExactlyOnceWith(original);
    expect(screen.getByRole("status")).toHaveTextContent("Workspace path copied");
    write.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await user.click(screen.getByRole("button", { name: "Copy workspace path" }));
    expect(screen.getByRole("status")).toHaveTextContent("Select the workspace path to copy it");
    write.mockRestore();
  });

  it("copies the exact branch, including case and Unicode, and reports a refused clipboard write", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const branch = "artoo/Run-中文";
    renderWithProviders(<RunTimeline runs={[{ ...run(), workspace_branch: branch,
      workspace_retention: { ...report, workspace_branch: branch } }]} />, { client: fakeApi({}) });
    await user.click(screen.getByRole("button", { name: "Copy branch" }));
    expect(write).toHaveBeenCalledExactlyOnceWith(branch);
    expect(screen.getByRole("status")).toHaveTextContent("Branch copied");
    write.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await user.click(screen.getByRole("button", { name: "Copy branch" }));
    expect(screen.getByRole("status")).toHaveTextContent("Select the branch to copy it");
    write.mockRestore();
  });

  it("uses the desktop bridge for exact path and branch copies when browser clipboard permission is denied", async () => {
    const user = userEvent.setup();
    const browserWrite = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Permission denied"));
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "artooDesktop", { configurable: true, value: { writeClipboardText } });
    const root = "/Users/Owner/雪 e\u0301/ trailing \r\n", branch = "artoo/Run-中文-e\u0301";
    renderWithProviders(<RunTimeline runs={[{ ...run(), workspace_root: root, workspace_branch: branch,
      workspace_retention: { ...report, workspace_root: root, workspace_branch: branch } }]} />, { client: fakeApi({}) });
    await user.click(screen.getByRole("button", { name: "Copy workspace path" }));
    expect(writeClipboardText).toHaveBeenNthCalledWith(1, root);
    expect(screen.getByRole("status")).toHaveTextContent("Workspace path copied");
    await user.click(screen.getByRole("button", { name: "Copy branch" }));
    expect(writeClipboardText).toHaveBeenNthCalledWith(2, branch);
    expect(writeClipboardText).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Branch copied");
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it("reports a failed desktop write without claiming a copy or attempting a second write", async () => {
    const user = userEvent.setup();
    const browserWrite = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const writeClipboardText = vi.fn().mockRejectedValue(new Error("Desktop clipboard unavailable"));
    Object.defineProperty(window, "artooDesktop", { configurable: true, value: { writeClipboardText } });
    renderWithProviders(<RunTimeline runs={[run()]} />, { client: fakeApi({}) });
    await user.click(screen.getByRole("button", { name: "Copy workspace path" }));
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(report.workspace_root);
    expect(screen.getByRole("status")).toHaveTextContent("Copy unavailable. Select the workspace path to copy it.");
    expect(browserWrite).not.toHaveBeenCalled();
  });
});
