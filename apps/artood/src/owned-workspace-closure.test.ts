import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentInstanceConfig, RunEvent } from "@artoo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedRunAdmission, createProcessAdapter, getOwnedRunStatusReceipt, getOwnedWorkspaceClosure } from "./process-adapter.js";
import type { MaterializedWorktree } from "./owned/worktree-reservation.js";

// Controlled event-order regression only. These doubles grant no real Git or
// process authority; the built POSIX worktree-results fixture covers that boundary.
const control = vi.hoisted(() => ({
  worktrees: new WeakSet<object>(), spawn: undefined as ((args: readonly string[]) => unknown) | undefined,
  close: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: (_command: string, args: string[]) => control.spawn!(args),
}));
vi.mock("./owned/worktree-reservation.js", async (original) => ({
  ...await original<typeof import("./owned/worktree-reservation.js")>(),
  assertOwnedMaterializedWorktree: async (value: object) => { if (!control.worktrees.has(value)) throw new Error("Unowned fixture"); },
  assertOwnedWorktreeLocalBoundary: (value: object) => { if (!control.worktrees.has(value)) throw new Error("Unowned fixture"); },
}));
vi.mock("./research.js", async (original) => ({
  ...await original<typeof import("./research.js")>(),
  prepareResearchOptions: () => ({}),
  createResearchSession: async () => ({ configPath: "unused", mcpPath: "unused", receipts: () => [], close: () => control.close!() }),
}));

class ControlledChild extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  exitCode: number | null = null; signalCode: string | null = null;
  constructor(readonly pid: number, guardian: boolean) {
    super();
    if (guardian) this.stdin.on("finish", () => queueMicrotask(() => this.close()));
    queueMicrotask(() => this.emit("spawn"));
  }
  close() {
    if (this.exitCode !== null) return;
    this.exitCode = 0; this.emit("exit", 0, null); this.emit("close", 0, null);
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanups.length) cleanups.pop()!(); });

async function fixture() {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  cleanups.push(() => Object.defineProperty(process, "platform", platform));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-closure-order-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const children: ControlledChild[] = [];
  control.spawn = () => { const child = new ControlledChild(7000 + children.length, children.length > 0); children.push(child); return child; };
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (children.some(child => child.pid === Math.abs(pid) && child.exitCode === null)) return true;
    throw Object.assign(new Error("No controlled process"), { code: "ESRCH" });
  });
  let release!: () => void, reject!: (error: Error) => void, closeEntered = false;
  const closing = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  control.close = () => { closeEntered = true; return closing; };
  cleanups.push(release);
  const worktree: MaterializedWorktree = Object.freeze({ root, branch: "fixture/author", committedHead: "a".repeat(40),
    targetIdentity: "controlled", commonDirectory: root });
  control.worktrees.add(worktree);
  const identity = { launchKey: "launch_1", runId: "run_1", taskId: "task_1", agentInstanceId: "ai_1", runtime: "fixture",
    workspaceRoot: root, workspaceBranch: worktree.branch };
  const admission = createOwnedRunAdmission(identity);
  const config: AgentInstanceConfig = { runId: identity.runId, taskId: identity.taskId, agentInstanceId: identity.agentInstanceId,
    runtime: identity.runtime, workspaceRoot: root, runStart: {
      run_id: identity.runId, task_id: identity.taskId, agent_instance_id: identity.agentInstanceId, runtime: identity.runtime,
      workspace: { root, branch: worktree.branch }, context_pack: { id: "ctx_1", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: [root], requires_approval: [] }, artifact_rules: { paths: [] },
    } };
  const adapter = createProcessAdapter({ runtimeId: "fixture", command: [process.execPath, "-e", ""], allowedRoots: [root],
    research: { receiptDirectory: join(root, "unused") } });
  const handle = await adapter.startOwnedRun(config, worktree, admission, new AbortController().signal);
  const events: RunEvent[] = [];
  const draining = (async () => { for await (const event of adapter.streamEvents(handle)) events.push(event); })();
  return { adapter, handle, admission, worktree, identity, release, reject, events, draining,
    async physicallyClose() {
      children[0]!.close();
      for (let attempt = 0; attempt < 20 && (!closeEntered || children[1]?.exitCode !== 0); attempt++) await tick();
      expect(closeEntered).toBe(true); expect(children[1]?.exitCode).toBe(0);
      const observation = await adapter.inspectOwnedRun(handle, admission);
      expect(getOwnedRunStatusReceipt(observation, admission, handle)?.kind).toBe("confirmed_closed");
      return observation;
    },
  };
}

describe("owned workspace sealing closure", () => {
  it("keeps physical closure distinct from pending tool closure and rejects copied or mismatched identities", async () => {
    const f = await fixture();
    const running = await f.adapter.inspectOwnedRun(f.handle, f.admission);
    expect(getOwnedWorkspaceClosure(running, f.admission, f.handle, f.worktree)).toBeUndefined();
    const closed = await f.physicallyClose();
    expect(getOwnedWorkspaceClosure(closed, f.admission, f.handle, f.worktree)).toBeUndefined();
    f.release(); await f.draining;
    const result = getOwnedWorkspaceClosure(closed, f.admission, f.handle, f.worktree)!;
    expect(result.identity).toEqual(f.identity); expect(result.receipt).toBe(closed);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.identity)).toBe(true);
    expect(getOwnedWorkspaceClosure(structuredClone(closed), f.admission, f.handle, f.worktree)).toBeUndefined();
    expect(getOwnedWorkspaceClosure(result, f.admission, f.handle, f.worktree)).toBeUndefined();
    expect(getOwnedWorkspaceClosure(closed, createOwnedRunAdmission(f.identity), f.handle, f.worktree)).toBeUndefined();
    expect(getOwnedWorkspaceClosure(closed, f.admission, { ...f.handle }, f.worktree)).toBeUndefined();
    const another = Object.freeze({ ...f.worktree }); control.worktrees.add(another);
    expect(getOwnedWorkspaceClosure(closed, f.admission, f.handle, another)).toBeUndefined();
    control.worktrees.delete(f.worktree);
    expect(getOwnedWorkspaceClosure(closed, f.admission, f.handle, f.worktree)).toBeUndefined();
  });

  it("retains refusal after tool cleanup fails even when the genuine physical receipt confirms closure", async () => {
    const f = await fixture(), closed = await f.physicallyClose();
    f.reject(new Error("Controlled research cleanup failure")); await f.draining;
    expect(f.events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed", reason: "Research session cleanup failed" } });
    expect(getOwnedRunStatusReceipt(closed, f.admission, f.handle)?.kind).toBe("confirmed_closed");
    expect(getOwnedWorkspaceClosure(closed, f.admission, f.handle, f.worktree)).toBeUndefined();
    expect(getOwnedWorkspaceClosure(await f.adapter.inspectOwnedRun(f.handle, f.admission), f.admission, f.handle, f.worktree)).toBeUndefined();
  });
});
