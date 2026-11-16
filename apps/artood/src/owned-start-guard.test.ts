import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedRunAdmission, createProcessAdapter, getOwnedStartupReceipt } from "./process-adapter.js";
import type { MaterializedWorktree } from "./owned/worktree-reservation.js";

// Controlled async ordering only. No native Git/producer proof is fabricated.
const control = vi.hoisted(() => ({ spawn: vi.fn(), prepared: () => {} }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: control.spawn,
}));
vi.mock("./owned/worktree-reservation.js", async (original) => ({
  ...(await original<typeof import("./owned/worktree-reservation.js")>()),
  assertOwnedMaterializedWorktree: async () => {},
  assertOwnedWorktreeLocalBoundary: () => {},
}));
vi.mock("./research.js", async (original) => ({
  ...(await original<typeof import("./research.js")>()),
  prepareResearchOptions: () => ({}),
  createResearchSession: async () => {
    await Promise.resolve();
    control.prepared();
    return { configPath: "unused", mcpPath: "unused", receipts: () => [], close: async () => {} };
  },
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  control.spawn.mockReset();
  control.prepared = () => {};
  while (cleanups.length) cleanups.pop()!();
});

function fixture(guard: () => void) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  cleanups.push(() => Object.defineProperty(process, "platform", platform));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-start-guard-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const worktree = Object.freeze({
    root,
    branch: "fixture/guard",
    committedHead: "a".repeat(40),
    targetIdentity: "controlled",
    commonDirectory: root,
  }) as MaterializedWorktree;
  const identity = {
    launchKey: "launch",
    runId: "run",
    taskId: "task",
    agentInstanceId: "instance",
    runtime: "fixture",
    workspaceRoot: root,
    workspaceBranch: worktree.branch,
  };
  const admission = createOwnedRunAdmission(identity, guard);
  const config = {
    runId: identity.runId,
    taskId: identity.taskId,
    agentInstanceId: identity.agentInstanceId,
    runtime: identity.runtime,
    workspaceRoot: root,
    runStart: {
      run_id: identity.runId,
      task_id: identity.taskId,
      agent_instance_id: identity.agentInstanceId,
      runtime: identity.runtime,
      workspace: { root, branch: worktree.branch },
      context_pack: { id: "context", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: [root], requires_approval: [] },
      artifact_rules: { paths: [] },
    },
  };
  const adapter = createProcessAdapter({
    runtimeId: "fixture",
    command: [process.execPath, "-e", ""],
    allowedRoots: [root],
    research: { receiptDirectory: join(root, "unused") },
  });
  return {
    adapter,
    worktree,
    admission,
    config,
    start: () => adapter.startOwnedRun(config, worktree, admission, new AbortController().signal),
  };
}

describe("private owned start guard", () => {
  it("rechecks after awaited tool preparation immediately before spawn and cannot reuse failed admission", async () => {
    let current = true;
    const guard = vi.fn(() => {
      if (!current) throw new Error("Original start window expired");
    });
    const f = fixture(guard);
    control.prepared = () => {
      current = false;
    };
    const error = await f.start().catch((cause: unknown) => cause);
    expect(guard).toHaveBeenCalledTimes(2);
    expect(control.spawn).not.toHaveBeenCalled();
    expect(error).toMatchObject({ cause: { message: "Original start window expired" } });
    expect(getOwnedStartupReceipt(error, f.admission, f.worktree)?.kind).toBe("not_spawned");
    current = true;
    await expect(f.start()).rejects.toThrow("fresh authenticated");
    expect(control.spawn).not.toHaveBeenCalled();
    expect(f.config.runStart).not.toHaveProperty("assertLaunchCurrent");
  });

  it("refuses an asynchronous guard without starting the target", async () => {
    const f = fixture(async () => {});
    await expect(f.start()).rejects.toMatchObject({ cause: { message: expect.stringContaining("synchronously") } });
    expect(control.spawn).not.toHaveBeenCalled();
  });
});
