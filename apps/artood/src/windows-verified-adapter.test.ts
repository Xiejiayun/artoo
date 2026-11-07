import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInstanceConfig, RunEvent } from "@artoo/protocol";
import { productDevelopmentContext } from "@artoo/domain";
import { createProcessAdapter, bindWindowsVerifiedExecution, assertWindowsVerifiedExecutionClosed,
  bindWindowsPlanningExecution, assertWindowsPlanningExecutionClosed, assertWindowsPlanningStartupClosed,
  type WindowsVerifiedExecutionAdmission } from "./process-adapter.js";
import { bindWorkspaceToolVerifier } from "./workspace-tools.js";
import { bindWorkspaceReadOnlyTools } from "./workspace-readonly.js";
import { VerificationCleanupError, type PreparedVerificationProfile } from "./verification.js";
import type { PreparedWindowsProcessBackend, WindowsOwnedClosureReceipt, WindowsOwnedProcess } from "./owned/windows-owned-process.js";
import { windowsProcessDiagnostic, withWindowsProcessDiagnostic } from "./owned/windows-process-diagnostic.js";
import * as guardianScope from "./owned/windows-guardian-scope.js";
import { awaitSessionClosure } from "./session-closure.js";

const controlled = vi.hoisted(() => ({ start: vi.fn(), backends: new WeakMap<object, object>(), receipts: new WeakSet<object>(),
  workspace: vi.fn(), research: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async load => ({ ...await load<typeof import("node:child_process")>(), spawn: controlled.spawn }));
vi.mock("./cli-resolver.js", () => ({ resolveCliCommand: (command: string) => [command] }));
vi.mock("./verification.js", async load => ({ ...await load<typeof import("./verification.js")>(),
  readWindowsVerificationBackend: (profile: object) => controlled.backends.get(profile) }));
vi.mock("./owned/windows-owned-process.js", () => ({ startWindowsOwnedProcess: controlled.start,
  isWindowsOwnedClosureReceipt: (receipt: object) => controlled.receipts.has(receipt), assertWindowsProcessBackend: vi.fn() }));
vi.mock("./workspace-tools.js", async load => ({ ...await load<typeof import("./workspace-tools.js")>(), createWorkspaceToolSession: controlled.workspace }));
vi.mock("./research.js", async load => ({ ...await load<typeof import("./research.js")>(), createResearchSession: controlled.research }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [], externalRoots: string[] = [];
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.resetAllMocks();
  // Every process/session in this suite is a controlled mock. No target is running.
  for (const root of [...externalRoots.splice(0), ...roots.splice(0)]) rmSync(root, { recursive: true, force: true });
});
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
function fixture(discussion = false, product = false, planning = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-windows-adapter-"))); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const config: AgentInstanceConfig = { runId: "run", taskId: "task", agentInstanceId: "agent", runtime: "fixture", workspaceRoot: workspace,
    runStart: { run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "fixture", workspace: { root: workspace },
      context_pack: { id: "context", payload: { task: { id: "task", title: "Task", description: "", acceptance_criteria: [] },
        project: { id: "project", name: "Project", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
        policy: { filesystem_write_scope: discussion ? [] : [workspace], requires_approval: [], ...(discussion ? { execution_mode: "discussion" as const } : {}) },
        memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
        ...(product ? { product_development: productDevelopmentContext("research") } : {}),
        ...(discussion ? { review_subject: { version: 1 as const, task_id: "author-task", run_id: "author", evidence_id: "evidence", subject_digest: `sha256:${"a".repeat(64)}`, development_stage: "research" as const } } : {}) } },
      policy_snapshot: { filesystem_write_scope: discussion ? [] : [workspace], requires_approval: [] }, artifact_rules: { paths: [] },
      verification: { version: 1, profile_id: "profile", request_id: "verification", ...(discussion ? { expected_subject_digest: `sha256:${"a".repeat(64)}` } : {}) } } };
  if (planning) {
    delete config.runStart.verification; delete config.runStart.context_pack.payload!.review_subject;
    config.runStart.policy_snapshot.filesystem_write_scope = [workspace];
    config.runStart.context_pack.payload!.conversation = { room_id: "room", turn_id: "turn", messages: [], history_truncated: false,
      current_request: JSON.stringify({ version: 1, kind: "autonomous-planning", request: "Build a notes product", planning_capability_snapshot: {
        version: 1, computer_id: "other-computer", project_id: "project", workspace_root: "/future/worker", verification_profile_id: "future-profile", capabilities: null } }) };
  }
  const profile = { id: "profile", project_id: "project", workspace_root: workspace } as PreparedVerificationProfile;
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend; controlled.backends.set(profile, backend);
  const workspaceClose = vi.fn(async (_options?: { retainFiles?: boolean }) => {}), researchClose = vi.fn(async (_options?: { retainFiles?: boolean }) => {});
  controlled.workspace.mockResolvedValue({ configPath: join(root, "workspace-broker.json"), mcpPath: join(root, "workspace-mcp.json"), close: workspaceClose });
  controlled.research.mockResolvedValue({ configPath: join(root, "research-broker.json"), mcpPath: join(root, "research-mcp.json"), receipts: () => [], close: researchClose });
  controlled.spawn.mockImplementation(() => { throw new Error("Ordinary process spawning is forbidden in this controlled native-route test"); });
  const command = [process.execPath, "--context", "{{context_pack_path}}", "--tools", "{{workspace_tools_config_path}}"];
  const adapter = createProcessAdapter({ runtimeId: "fixture", allowedRoots: [workspace], artifacts: [], command, discussionCommand: command,
    ...(planning ? { readOnlyCommand: command } : {}),
    ...(product ? { productCommand: command, research: { receiptDirectory: join(root, "receipts") } } : {}) });
  if (product) bindWorkspaceToolVerifier(config, async () => { throw new Error("Unused controlled verifier"); });
  const controller = new AbortController(); Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  return { root, workspace, config, profile, backend, adapter, controller, workspaceClose, researchClose,
    bind: () => bindWindowsVerifiedExecution(adapter, freeze(config), profile, controller.signal, () => {}) };
}
function nativeFixture() {
  const stdout = new PassThrough(), stderr = new PassThrough();
  let start!: (value: { pid: number }) => void, noStart!: (error: Error) => void, close!: (value: WindowsOwnedClosureReceipt) => void, unknown!: (error: Error) => void;
  let pid: number | undefined, exitCode: number | null = null;
  const started = new Promise<{ pid: number }>((ok, fail) => { start = ok; noStart = fail; });
  const closed = new Promise<WindowsOwnedClosureReceipt>((ok, fail) => { close = ok; unknown = fail; });
  void started.catch(() => {}); void closed.catch(() => {});
  const child = Object.assign(new EventEmitter(), { stdout, stderr, started, closed, cancel: vi.fn() });
  Object.defineProperties(child, { pid: { get: () => pid }, exitCode: { get: () => exitCode }, signalCode: { get: () => null } });
  // The process properties above are getters, so declare their shape after defining them.
  const ownedChild = child as typeof child & WindowsOwnedProcess;
  controlled.start.mockReturnValue(ownedChild);
  const receipt = (patch: Partial<WindowsOwnedClosureReceipt> = {}): WindowsOwnedClosureReceipt => {
    const value = { version: 1, token: "controlled-native-receipt", elapsedMs: 1, rootCreated: true, rootStarted: true, rootPid: 1234,
      rootCreationTime: "1000", atomicJobMember: true, rootWaitObserved: true, rootExitCode: 0, stdoutEof: true, stderrEof: true,
      jobEmptyObserved: true, noTargetCreated: false, terminationReason: null, nativeTerminationReason: null, failureCode: null,
      nativeError: null, outputBytesObserved: 0, outputBytesCaptured: 0, helperSpawnObserved: true, helperExitObserved: true,
      helperCloseObserved: true, helperExitCode: 0, helperSignal: null, cleanupConfirmed: true, ...patch } as WindowsOwnedClosureReceipt;
    controlled.receipts.add(value); return value;
  };
  return { child, receipt, start() { pid = 1234; start({ pid }); child.emit("spawn"); },
    finish(patch: Partial<WindowsOwnedClosureReceipt> = {}) {
      const value = receipt(patch); exitCode = value.rootExitCode;
      if (!pid) {
        const diagnostic = windowsProcessDiagnostic(value);
        noStart(Object.assign(new Error(withWindowsProcessDiagnostic("Controlled target was not started", diagnostic)), { diagnostic }));
      }
      child.emit("exit", exitCode, null); stdout.end(); stderr.end(); close(value); child.emit("close", exitCode, null);
    }, fail(diagnostic?: unknown) {
      noStart(new Error("Controlled unknown target")); stdout.end(); stderr.end();
      unknown(Object.assign(new Error("Controlled helper loss"), diagnostic === undefined ? {} : { diagnostic }));
    } };
}
async function drain(stream: AsyncIterable<RunEvent>) { const events: RunEvent[] = []; for await (const event of stream) events.push(event); return events; }
async function waitLaunch() { await vi.waitFor(() => expect(controlled.start).toHaveBeenCalledTimes(1)); }
function contextPath(): string { const path = controlled.start.mock.calls[0]![1].args[1] as string; externalRoots.push(dirname(path)); return path; }

describe("Windows verified adapter (controlled bridge/session fixtures, not native qualification)", () => {
  it("rejects missing, copied and replayed permits before a second launch", async () => {
    const f = fixture(true), native = nativeFixture();
    await expect(f.adapter.start(f.config)).rejects.toThrow(/local execution admission/);
    f.bind(); await expect(f.adapter.start(structuredClone(f.config))).rejects.toThrow(/local execution admission/);
    const starting = f.adapter.start(f.config); await waitLaunch();
    await expect(f.adapter.start(f.config)).rejects.toThrow(/already consumed/);
    native.start(); const handle = await starting; native.finish(); await drain(f.adapter.streamEvents(handle));
    expect(controlled.spawn).not.toHaveBeenCalled();
  });
  it("requires deep immutable payload/config and unchanged ordinary adapter methods", () => {
    const f = fixture(); freeze(f.config.runStart);
    expect(() => bindWindowsVerifiedExecution(f.adapter, f.config, f.profile, f.controller.signal, () => {})).toThrow(/fresh local/);
    const mutable = structuredClone(f.config); Object.freeze(mutable.runStart); Object.freeze(mutable);
    expect(() => bindWindowsVerifiedExecution(f.adapter, mutable, f.profile, f.controller.signal, () => {})).toThrow(/fresh local/);
    const start = f.adapter.start; f.adapter.start = vi.fn();
    expect(() => f.bind()).toThrow(/fresh local/); f.adapter.start = start;
    const admission = f.bind(); expect(() => assertWindowsVerifiedExecutionClosed(admission, { runId: "run" })).toThrow(VerificationCleanupError);
  });
  it("revalidates adapter identity and cancellation immediately before consumption", async () => {
    const f = fixture(); f.bind(); const stop = f.adapter.stop; f.adapter.stop = vi.fn();
    await expect(f.adapter.start(f.config)).rejects.toThrow(/identity changed/); f.adapter.stop = stop;
    f.controller.abort(new Error("Controlled cancellation")); await expect(f.adapter.start(f.config)).rejects.toThrow(/Controlled cancellation/);
    expect(controlled.start).not.toHaveBeenCalled(); expect(existsSync(join(f.workspace, "context_pack.md"))).toBe(false);
  });
  it("runs research reviewers without evidence grants under native ownership and binds closure to their exact handle", async () => {
    const f = fixture(true), native = nativeFixture(), admission = f.bind(), starting = f.adapter.start(f.config); await waitLaunch();
    const path = contextPath(); expect(existsSync(path)).toBe(true); expect(controlled.workspace).not.toHaveBeenCalled();
    expect(controlled.start.mock.calls[0]![1]).toMatchObject({ normalExitPolicy: "terminate-descendants", normalExitGraceMs: 250 });
    native.start(); const handle = await starting; expect(Object.isFrozen(handle)).toBe(true);
    expect(() => assertWindowsVerifiedExecutionClosed(admission, handle)).toThrow(VerificationCleanupError);
    native.finish(); const events = await drain(f.adapter.streamEvents(handle));
    expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
    expect(() => assertWindowsVerifiedExecutionClosed(admission, handle)).not.toThrow();
    expect(() => assertWindowsVerifiedExecutionClosed(admission, { ...handle })).toThrow(VerificationCleanupError); expect(existsSync(path)).toBe(false);
  });
  it.each(["timeout", "output_limit"])("keeps root exit zero with %s as a command failure", async terminationReason => {
    const f = fixture(true), native = nativeFixture(); f.bind(); const starting = f.adapter.start(f.config); await waitLaunch(); native.start();
    const handle = await starting; native.finish({ terminationReason });
    const events = await drain(f.adapter.streamEvents(handle)); expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed" } });
  });
  it("revokes both author brokers with retention when native closure is unknown", async () => {
    const f = fixture(false, true), native = nativeFixture(), admission = f.bind();
    const starting = f.adapter.start(f.config); await waitLaunch(); native.start(); const handle = await starting;
    const streaming = drain(f.adapter.streamEvents(handle)), expected = expect(streaming).rejects.toBeInstanceOf(VerificationCleanupError);
    f.workspaceClose.mockRejectedValue(new VerificationCleanupError("Controlled independent verifier uncertainty")); native.fail(); await expected;
    expect(f.workspaceClose).toHaveBeenCalledWith({ retainFiles: true }); expect(f.researchClose).toHaveBeenCalledWith({ retainFiles: true });
    expect(() => assertWindowsVerifiedExecutionClosed(admission, handle)).toThrow(VerificationCleanupError);
  });
  it.each(["native-failure", "normal-close"])("settles %s as uncertainty when the session close deadline rejects", async mode => {
    const f = fixture(false, true), native = nativeFixture(), admission = f.bind();
    const starting = f.adapter.start(f.config); await waitLaunch(); native.start(); const handle = await starting;
    let release!: () => void, closing: Promise<void> | undefined;
    const pending = new Promise<void>(done => { release = done; });
    const events: RunEvent[] = [];
    // Controlled broker implementation obeying the production bounded-close
    // contract; actual HTTP/evidence/verifier joins are tested in their suites.
    f.workspaceClose.mockImplementation(() => closing ??= awaitSessionClosure(() => pending, "Controlled broker closure remains unconfirmed"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const streaming = (async () => { for await (const event of f.adapter.streamEvents(handle)) events.push(event); })().catch(error => error as unknown);
      if (mode === "native-failure") native.fail(); else native.finish();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await streaming).toBeInstanceOf(VerificationCleanupError);
      expect(f.researchClose).toHaveBeenCalledWith({ retainFiles: true });
      expect(() => assertWindowsVerifiedExecutionClosed(admission, handle)).toThrow(VerificationCleanupError);
      expect(events.some(event => event.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(event.payload.phase))).toBe(false);
      release(); await vi.advanceTimersByTimeAsync(0);
      await expect(f.adapter.stop(handle, "user_cancelled")).rejects.toBeInstanceOf(VerificationCleanupError);
      expect(() => assertWindowsVerifiedExecutionClosed(admission, handle)).toThrow(VerificationCleanupError);
    } finally { release(); await Promise.resolve(); vi.useRealTimers(); }
  });

  it("rejects startup after the bounded broker failure while still attempting both closures", async () => {
    const f = fixture(false, true); f.bind();
    controlled.start.mockImplementation(() => { throw new Error("Controlled no-target launch failure"); });
    let release!: () => void, closing: Promise<void> | undefined;
    const pending = new Promise<void>(done => { release = done; });
    f.workspaceClose.mockImplementation(() => closing ??= awaitSessionClosure(() => pending, "Controlled startup broker remains unconfirmed"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const starting = f.adapter.start(f.config).catch(error => error as unknown);
      await vi.waitFor(() => expect(f.workspaceClose).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(5000);
      expect(await starting).toBeInstanceOf(VerificationCleanupError); expect(f.researchClose).toHaveBeenCalledOnce();
      release(); await vi.advanceTimersByTimeAsync(0);
      await expect(closing).rejects.toBeInstanceOf(VerificationCleanupError);
    } finally { release(); await Promise.resolve(); vi.useRealTimers(); }
  });
  it("retains external reviewer context after unknown native closure", async () => {
    const f = fixture(true), native = nativeFixture(); f.bind(); const starting = f.adapter.start(f.config); await waitLaunch(); const path = contextPath();
    native.start(); const handle = await starting; const streaming = drain(f.adapter.streamEvents(handle));
    const expected = expect(streaming).rejects.toBeInstanceOf(VerificationCleanupError); native.fail(); await expected;
    expect(existsSync(path)).toBe(true); await expect(f.adapter.stop(handle, "user_cancelled")).rejects.toBeInstanceOf(VerificationCleanupError);
  });
  it("safely cleans a synchronous no-target failure while still closing both brokers", async () => {
    const f = fixture(false, true), reason = new Error("Controlled no-target failure"); f.bind(); controlled.start.mockImplementation(() => { throw reason; });
    await expect(f.adapter.start(f.config)).rejects.toBe(reason); expect(reason).not.toHaveProperty("diagnostic");
    expect(f.workspaceClose).toHaveBeenCalled(); expect(f.researchClose).toHaveBeenCalled();
  });
  it("returns CreateProcess diagnostics after known startup closure without creating a run handle", async () => {
    const f = fixture(true), native = nativeFixture(); f.bind(); const starting = f.adapter.start(f.config);
    const failure = starting.catch(error => error as Error); await waitLaunch(); const path = contextPath();
    native.finish({ rootCreated: false, rootStarted: false, rootPid: null, rootWaitObserved: false, rootExitCode: null,
      atomicJobMember: false, noTargetCreated: true, rootCreationTime: null, terminationReason: "create_process",
      nativeTerminationReason: "create_process", failureCode: "create_process", nativeError: 5 });
    const error = await failure; expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(VerificationCleanupError);
    expect((error as Error).message).toContain('"failureCode":"create_process"'); expect((error as Error).message).toContain('"nativeError":5');
    expect((error as Error).message).toContain('"cleanupConfirmed":true'); expect(existsSync(path)).toBe(false);
    expect(controlled.spawn).not.toHaveBeenCalled();
  });
  it("preserves diagnostic facts while keeping unknown startup closure unsafe and retaining context", async () => {
    const f = fixture(true), native = nativeFixture(); f.bind(); const starting = f.adapter.start(f.config);
    const failure = starting.catch(error => error as Error); await waitLaunch(); const path = contextPath();
    native.fail(windowsProcessDiagnostic(native.receipt({ rootCreated: false, rootStarted: false, rootWaitObserved: false,
      noTargetCreated: false, helperExitObserved: false, helperCloseObserved: false, helperExitCode: null,
      failureCode: "missing_complete", nativeError: null, cleanupConfirmed: false })));
    const error = await failure; expect(error).toBeInstanceOf(VerificationCleanupError);
    expect((error as Error).message).toContain('"failureCode":"missing_complete"'); expect((error as Error).message).toContain('"cleanupConfirmed":false');
    expect((error as Error).message).toContain('"noTargetCreated":false'); expect(existsSync(path)).toBe(true);
    expect(controlled.spawn).not.toHaveBeenCalled();
  });
  it("does not skip research closure or release uncertainty when another startup closer rejects", async () => {
    const f = fixture(false, true); f.bind(); controlled.start.mockImplementation(() => { throw new Error("Controlled no-target failure"); });
    f.workspaceClose.mockRejectedValue(new Error("Controlled close failure"));
    await expect(f.adapter.start(f.config)).rejects.toBeInstanceOf(VerificationCleanupError); expect(f.researchClose).toHaveBeenCalled();
  });
  it("waits for native closure on stop before reporting cancellation", async () => {
    const f = fixture(true), native = nativeFixture(), admission = f.bind(), starting = f.adapter.start(f.config); await waitLaunch(); native.start();
    const handle = await starting; let stopped = false;
    const stopping = f.adapter.stop(handle, "user_cancelled").then(() => { stopped = true; }); await Promise.resolve();
    expect(native.child.cancel).toHaveBeenCalled(); expect(stopped).toBe(false);
    native.finish({ terminationReason: "cancelled" }); await stopping;
    expect((await drain(f.adapter.streamEvents(handle))).at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "cancelled" } });
    expect(() => assertWindowsVerifiedExecutionClosed(admission, handle)).not.toThrow();
  });
  it("joins a cancelled startup's confirmed no-target closure before removing reviewer context", async () => {
    const f = fixture(true), native = nativeFixture(); f.bind(); const starting = f.adapter.start(f.config);
    const reason = new Error("Controlled startup cancellation"), expected = expect(starting).rejects.toBe(reason);
    await waitLaunch(); const path = contextPath(); f.controller.abort(reason);
    expect(native.child.cancel).toHaveBeenCalled(); expect(existsSync(path)).toBe(true);
    native.finish({ rootCreated: false, rootStarted: false, rootPid: null, rootWaitObserved: false, rootExitCode: null,
      atomicJobMember: false, noTargetCreated: true, rootCreationTime: null, terminationReason: "cancelled" });
    await expected; expect(existsSync(path)).toBe(false);
  });
});

describe("Windows planning admission (controlled native bridge, no provider qualification)", () => {
  function planningFixture() {
    const f = fixture(true, false, true);
    bindWorkspaceReadOnlyTools(f.config, { projectId: "project", workspaceRoot: f.workspace, assertCurrent: () => { f.controller.signal.throwIfAborted(); } });
    return { ...f, bindPlanning: () => bindWindowsPlanningExecution(f.adapter, freeze(f.config), f.profile, f.controller.signal, () => {}) };
  }

  it("uses native ownership for context-only planning without a verification request or author authority", async () => {
    const f = planningFixture(), native = nativeFixture(), admission = f.bindPlanning();
    expect(f.config.runStart.verification).toBeUndefined();
    const starting = f.adapter.start(f.config); await waitLaunch(); contextPath(); native.start(); const handle = await starting;
    expect(controlled.workspace.mock.calls[0]![0]).toMatchObject({ readOnlyGrant: expect.any(Object) });
    expect(controlled.workspace.mock.calls[0]![0].verify).toBeUndefined();
    expect(() => assertWindowsPlanningExecutionClosed(admission, handle)).toThrow(VerificationCleanupError);
    native.finish(); expect((await drain(f.adapter.streamEvents(handle))).at(-1)).toMatchObject({ payload: { phase: "completed" } });
    expect(() => assertWindowsPlanningExecutionClosed(admission, handle)).not.toThrow();
    expect(() => assertWindowsPlanningExecutionClosed(admission, { ...handle })).toThrow(VerificationCleanupError);
    expect(() => assertWindowsVerifiedExecutionClosed(admission as unknown as WindowsVerifiedExecutionAdmission, handle)).toThrow(VerificationCleanupError);
    expect(controlled.spawn).not.toHaveBeenCalled(); expect(controlled.research).not.toHaveBeenCalled();
  });

  it("rejects a missing broker, a copied config, and a replayed planning permit", async () => {
    const missing = fixture(true, false, true);
    expect(() => bindWindowsPlanningExecution(missing.adapter, freeze(missing.config), missing.profile, missing.controller.signal, () => {})).toThrow(/context-only broker/);
    const f = planningFixture(), native = nativeFixture(); f.bindPlanning();
    expect(() => bindWindowsPlanningExecution(f.adapter, freeze(structuredClone(f.config)), f.profile, f.controller.signal, () => {})).toThrow(/context-only broker/);
    const starting = f.adapter.start(f.config); await waitLaunch(); contextPath();
    await expect(f.adapter.start(f.config)).rejects.toThrow(/already consumed/);
    native.start(); const handle = await starting; native.finish(); await drain(f.adapter.streamEvents(handle));
    expect(controlled.spawn).not.toHaveBeenCalled();
  });

  it("waits for the original native closure and broker closure on active stop", async () => {
    const f = planningFixture(), native = nativeFixture(), admission = f.bindPlanning();
    const starting = f.adapter.start(f.config); await waitLaunch(); contextPath(); native.start(); const handle = await starting;
    let stopped = false;
    const stopping = f.adapter.stop(handle, "user_cancelled").then(() => { stopped = true; }); await Promise.resolve();
    expect(native.child.cancel).toHaveBeenCalled(); expect(stopped).toBe(false);
    native.finish({ terminationReason: "cancelled" }); await stopping;
    expect((await drain(f.adapter.streamEvents(handle))).at(-1)).toMatchObject({ payload: { phase: "cancelled" } });
    expect(f.workspaceClose).toHaveBeenCalled(); expect(() => assertWindowsPlanningExecutionClosed(admission, handle)).not.toThrow();
  });

  it("settles a rejected startup only after actual no-target closure", async () => {
    const f = planningFixture(), native = nativeFixture(), admission = f.bindPlanning();
    const starting = f.adapter.start(f.config), failure = starting.catch(error => error); await waitLaunch(); const path = contextPath();
    expect(() => assertWindowsPlanningStartupClosed(admission)).toThrow(VerificationCleanupError);
    native.finish({ rootCreated: false, rootStarted: false, rootPid: null, rootWaitObserved: false, rootExitCode: null,
      atomicJobMember: false, noTargetCreated: true, rootCreationTime: null, terminationReason: "create_process", failureCode: "create_process" });
    expect(await failure).toBeInstanceOf(Error);
    expect(() => assertWindowsPlanningStartupClosed(admission)).not.toThrow(); expect(existsSync(path)).toBe(false);
  });

  it("retains unknown startup closure and the external planning context without inventing a handle", async () => {
    const f = planningFixture(), native = nativeFixture(), admission = f.bindPlanning();
    const starting = f.adapter.start(f.config), failure = starting.catch(error => error); await waitLaunch(); const path = contextPath();
    native.fail(); expect(await failure).toBeInstanceOf(VerificationCleanupError);
    expect(() => assertWindowsPlanningStartupClosed(admission)).toThrow(VerificationCleanupError);
    expect(existsSync(path)).toBe(true); expect(controlled.spawn).not.toHaveBeenCalled();
  });

  it("does not treat a rejected asynchronous guardian reservation as a closed no-target startup", async () => {
    const f = planningFixture();
    const scope = vi.spyOn(guardianScope, "readWindowsGuardianOperation").mockReturnValue({ backend: f.backend } as guardianScope.WindowsGuardianOperation);
    const launch = vi.spyOn(guardianScope, "startWindowsScopedProcess").mockRejectedValue(new Error("Controlled reservation helper closure unknown"));
    try {
      const admission = f.bindPlanning();
      await expect(f.adapter.start(f.config)).rejects.toThrow(/guardian startup closure remains unconfirmed/);
      const path = launch.mock.calls[0]![1].args[1]!; externalRoots.push(dirname(path));
      expect(existsSync(path)).toBe(true); expect(f.workspaceClose).toHaveBeenCalled();
      expect(() => assertWindowsPlanningStartupClosed(admission)).toThrow(VerificationCleanupError);
      expect(controlled.start).not.toHaveBeenCalled(); expect(controlled.spawn).not.toHaveBeenCalled();
    } finally { launch.mockRestore(); scope.mockRestore(); }
  });
});
