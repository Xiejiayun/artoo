import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowsBrowserObserverSession } from "./windows-browser-session.js";
import { closeObservedWindowsProcesses, WindowsBrowserSessionObservationError } from "./windows-browser-exit.js";

const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: fixture.spawn }));
type Frame = Record<string, unknown>;
class ControlledChild extends EventEmitter {
  pid = 990001;
  writes: string[] = [];
  writeFailure?: Error;
  holdWrite = false;
  held?: (error?: Error | null) => void;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({ write: (chunk: Buffer, _encoding, callback) => {
    this.writes.push(chunk.toString("utf8"));
    if (this.holdWrite) this.held = callback;
    else callback(this.writeFailure);
  } });
  kill = vi.fn(() => true);
  configure(): Frame { return JSON.parse(this.writes[0]!.trim().split("\n").at(-1)!) as Frame; }
  request(): Frame { return JSON.parse(this.writes.at(-1)!.trim()) as Frame; }
  frame(value: Frame): void { this.stdout.write(JSON.stringify(value) + "\n"); }
  response(extra: Frame = {}): Frame { const request = this.request(); return { version: 1, session: request.session, seq: request.seq, operation: request.operation, status: "ok", ...extra }; }
  ready(): void { const config = this.configure(); this.frame({ version: 1, session: config.session, seq: 0, operation: "ready", status: "ok" }); }
  close(code = 0): void { this.emit("exit", code, null); this.stdout.end(); this.stderr.end(); this.emit("close", code, null); }
}
const children: ControlledChild[] = [];
let now = 100;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function advance(ms: number) { now += ms; await vi.advanceTimersByTimeAsync(ms); }
function create(signal?: AbortSignal, budget = 30000) {
  const child = new ControlledChild(); children.push(child); fixture.spawn.mockReturnValueOnce(child);
  const session = new WindowsBrowserObserverSession({ executable: "C:\\Chrome\\chrome.exe", profile: "C:\\private\\profile",
    launchDeadline: now + budget, ...(signal ? { signal } : {}) });
  return { child, session };
}
async function bound(signal?: AbortSignal) {
  const result = create(signal); result.child.ready();
  const binding = result.session.bind(7001); await tick();
  result.child.frame(result.child.response({ parent_pid: 7001 })); await binding;
  return result;
}
const processes = [{ pid: 7001, created_utc: "2026-11-05T00:00:00.0000000Z" }];
const ancestryFailure = () => ({ version: 1, attempt: 2, census: "first", root_pid: 7001, parent_pid: 7002, child_pid: 7003,
  root_filetime: "134383440000000000", parent_filetime: "134383440000000101", child_filetime: "134383440000000100",
  root_type: "System.Int64", parent_type: "System.Int64", child_type: "System.Int64", delta_ticks: "-1" });
const boundFailure = () => ({ version: 1, source: "current_subtree", count: 128, attempt: 2, census: "first", root_pid: 7001 });
async function observed() {
  const result = await bound(); const pending = result.session.observe();
  result.child.frame(result.child.response({ parent_pid: 7001, processes })); await pending;
  return result;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now); fixture.spawn.mockReset();
});
afterEach(() => {
  for (const child of children.splice(0)) child.close(1);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe("persistent Windows observer transport (controlled child events, no native acceptance)", () => {
  it.each([undefined, "current_subtree", "history_union"])("keeps bound failure terminal with optional %s facts", async source => {
    const { child, session } = await bound(); const initial = session.observe();
    const pids = Array.from({ length: 127 }, (_, i) => 8000 + i);
    const evidence = source === undefined ? undefined : { ...boundFailure(), source };
    child.frame(child.response({ status: "error", error_code: "observation_bound_exceeded", parent_pid: 7001,
      exit_history: { version: 1, pids }, ...(evidence ? { bound_failure: evidence } : {}) }));
    const failure: unknown = await initial.catch(error => error);
    expect(WindowsBrowserSessionObservationError.boundFailureEvidence(failure, 7001)).toEqual(evidence);
    expect(WindowsBrowserSessionObservationError.boundFailureEvidence(failure, 7002)).toBeUndefined();
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toEqual(pids);
    if (evidence) expect((failure as Error).message).toContain(`bound_failure_v1=${JSON.stringify(evidence)}`);
    else expect((failure as Error).message).not.toContain("bound_failure_v1");
    await expect(session.observe()).rejects.toBe(failure); await expect(session.finalAudit(1000)).rejects.toBe(failure);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.close(1); await session.cleanup(); expect(() => session.assertCompleted()).toThrow("observation_bound_exceeded");
  });
  it.each([
    { evidence: { ...boundFailure(), version: 2 } }, { evidence: { ...boundFailure(), count: 129 } },
    { evidence: { ...boundFailure(), source: "owned" } }, { evidence: { ...boundFailure(), root_pid: 8001 } },
    { evidence: { ...boundFailure(), pids: [9001] } }, { evidence: { ...boundFailure(), source: "history_union" } },
    { evidence: null }, { evidence: boundFailure(), code: "observer_retry_exhausted" },
  ])("rejects malformed or mismatched bound facts without losing existing negative history: %j", async ({ evidence, code }) => {
    const { child, session } = await bound(); const initial = session.observe();
    child.frame(child.response({ status: "error", error_code: code ?? "observation_bound_exceeded", parent_pid: 7001,
      exit_history: { version: 1, pids: [7002] }, bound_failure: evidence }));
    const failure: unknown = await initial.catch(error => error);
    expect((failure as Error).message).toContain("observer_protocol_failed");
    expect((failure as Error).message).not.toContain("bound_failure_v1");
    expect(WindowsBrowserSessionObservationError.boundFailureEvidence(failure, 7001)).toBeUndefined();
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toEqual([7002]);
  });
  it.each([{ operation: "ready", status: "ok" }, { operation: "bind", status: "ok" }, { operation: "initial", status: "ok" },
    { operation: "final", status: "ok" }, { operation: "ready", status: "error" }, { operation: "bind", status: "error" },
    { operation: "final", status: "error" }])("forbids bound diagnostics on $operation:$status", async ({ operation, status }) => {
    const { child, session } = operation === "final" ? await observed() : operation === "initial" ? await bound() : create();
    const pending = operation === "final" ? session.finalAudit(1000) : operation === "initial" ? session.observe() : session.bind(7001);
    void pending.catch(() => {});
    if (operation === "bind") { child.ready(); await tick(); }
    const fields = { status, bound_failure: boundFailure(), ...(status === "error" ? { error_code: "observation_bound_exceeded" }
      : operation === "bind" ? { parent_pid: 7001 } : operation === "initial" ? { parent_pid: 7001, processes } : operation === "final" ? { processes: [] } : {}) };
    child.frame(operation === "ready" ? { version: 1, session: child.configure().session, seq: 0, operation, ...fields } : child.response(fields));
    const failure: unknown = await pending.catch(error => error);
    expect((failure as Error).message).toContain("observer_protocol_failed");
    expect(WindowsBrowserSessionObservationError.boundFailureEvidence(failure, 7001)).toBeUndefined();
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
  });
  it.each([{ session: "other" }, { seq: 3 }, { parent_pid: 8001 }, { exit_history: undefined }])(
    "rejects bound diagnostics outside the exact initial binding: %j", async extra => {
      const { child, session } = await bound(); const initial = session.observe();
      child.frame(child.response({ status: "error", error_code: "observation_bound_exceeded", parent_pid: 7001,
        exit_history: { version: 1, pids: [] }, bound_failure: boundFailure(), ...extra }));
      const failure: unknown = await initial.catch(error => error);
      expect((failure as Error).message).toContain("observer_protocol_failed");
      expect(WindowsBrowserSessionObservationError.boundFailureEvidence(failure, 7001)).toBeUndefined();
      expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
    });
  it("rejects duplicate bound fields and does not attach facts arriving at the original deadline", async () => {
    const first = await bound(); const duplicate = first.session.observe();
    const line = JSON.stringify(first.child.response({ status: "error", error_code: "observation_bound_exceeded", parent_pid: 7001,
      exit_history: { version: 1, pids: [] }, bound_failure: boundFailure() }));
    first.child.stdout.write(line.replace('"count":128', '"count":128,"count":128') + "\n");
    await expect(duplicate).rejects.toThrow("observer_protocol_failed");
    const second = await bound(); const late = second.session.observe(); now += 5000;
    second.child.frame(second.child.response({ status: "error", error_code: "observation_bound_exceeded", parent_pid: 7001,
      exit_history: { version: 1, pids: [] }, bound_failure: boundFailure() }));
    const failure: unknown = await late.catch(error => error);
    expect((failure as Error).message).toContain("observer_deadline");
    expect(WindowsBrowserSessionObservationError.boundFailureEvidence(failure, 7001)).toBeUndefined();
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
  });
  it("captures optional exact negative evidence in the same bound error frame without recovering failure", async () => {
    const { child, session } = await bound(); const initial = session.observe();
    child.frame(child.response({ status: "error", error_code: "descendant_precedes_parent", parent_pid: 7001,
      exit_history: { version: 1, pids: [7002, 7003] }, ancestry_failure: ancestryFailure() }));
    const failure: unknown = await initial.catch(error => error);
    expect(WindowsBrowserSessionObservationError.negativeEvidence(failure, 7001)).toEqual(ancestryFailure());
    expect((failure as Error).message).toContain(`ancestry_failure_v1=${JSON.stringify(ancestryFailure())}`);
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toEqual([7002, 7003]);
    expect(WindowsBrowserSessionObservationError.negativeEvidence(failure, 7002)).toBeUndefined();
    await expect(session.observe()).rejects.toBe(failure); await expect(session.finalAudit(1000)).rejects.toBe(failure);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.close(1); await session.cleanup(); expect(() => session.assertCompleted()).toThrow("descendant_precedes_parent");
  });
  it.each([
    { name: "unknown version", evidence: { ...ancestryFailure(), version: 2 } },
    { name: "extra field", evidence: { ...ancestryFailure(), owned: true } },
    { name: "invalid difference", evidence: { ...ancestryFailure(), delta_ticks: "-2" } },
    { name: "wrong root", evidence: { ...ancestryFailure(), root_pid: 8001 } },
    { name: "unobserved child", evidence: { ...ancestryFailure(), child_pid: 8001 } },
    { name: "null", evidence: null },
    { name: "wrong error code", evidence: ancestryFailure(), code: "observer_retry_exhausted" },
  ])("rejects $name evidence while preserving independently validated negative history", async ({ evidence, code }) => {
    const { child, session } = await bound(); const initial = session.observe();
    child.frame(child.response({ status: "error", error_code: code ?? "descendant_precedes_parent", parent_pid: 7001,
      exit_history: { version: 1, pids: [7002, 7003] }, ancestry_failure: evidence }));
    const failure: unknown = await initial.catch(error => error);
    expect((failure as Error).message).toContain("observer_protocol_failed");
    expect((failure as Error).message).not.toContain("ancestry_failure_v1");
    expect(WindowsBrowserSessionObservationError.negativeEvidence(failure, 7001)).toBeUndefined();
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toEqual([7002, 7003]);
    await expect(session.observe()).rejects.toBe(failure);
  });
  it.each(["ready", "bind", "final"])("forbids negative evidence on a %s error", async operation => {
    const { child, session } = operation === "final" ? await observed() : create();
    const pending = operation === "final" ? session.finalAudit(1000) : session.bind(7001); void pending.catch(() => {});
    if (operation === "bind") { child.ready(); await tick(); }
    const fields = { status: "error", error_code: "descendant_precedes_parent", parent_pid: 7001,
      exit_history: { version: 1, pids: [7002, 7003] }, ancestry_failure: ancestryFailure() };
    child.frame(operation === "ready" ? { version: 1, session: child.configure().session, seq: 0, operation, ...fields } : child.response(fields));
    const failure: unknown = await pending.catch(error => error);
    expect((failure as Error).message).toContain("observer_protocol_failed");
    expect(WindowsBrowserSessionObservationError.negativeEvidence(failure, 7001)).toBeUndefined();
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
  });
  it("keeps original cleanup-only probes after malformed evidence without adding its unobserved PID", async () => {
    const { child, session } = await bound();
    const probe = vi.fn((_pid: number) => { throw Object.assign(new Error("Controlled absent PID"), { code: "ESRCH" }); });
    const terminateParent = vi.fn(async (_remainingMs: number) => {}), requestGracefulClose = vi.fn(async () => {});
    const closing = closeObservedWindowsProcesses({ parentPid: 7001, parentClosed: () => true,
      observe: () => session.observe(), terminateParent, requestGracefulClose, finalAudit: remaining => session.finalAudit(remaining) },
    { probe, now: () => now, sleep: async () => {}, connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100 });
    void closing.catch(() => {});
    child.frame(child.response({ status: "error", error_code: "descendant_precedes_parent", parent_pid: 7001,
      exit_history: { version: 1, pids: [7002, 7003] }, ancestry_failure: { ...ancestryFailure(), child_pid: 8001 } }));
    await expect(closing).rejects.toThrow("initial_observation:observer_protocol_failed");
    expect(probe.mock.calls).toEqual([[7001], [7002], [7003]]);
    expect(terminateParent).toHaveBeenCalledExactlyOnceWith(3000); expect(requestGracefulClose).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.close(1); await session.cleanup(); expect(() => session.assertCompleted()).toThrow("observer_protocol_failed");
  });
  it.each([{ status: "ok", processes }, { session: "other" }, { seq: 3 }, { parent_pid: 8001 }, { exit_history: undefined }])(
    "does not accept diagnostic data outside its exact initial failure binding: %j", async extra => {
      const { child, session } = await bound(); const initial = session.observe();
      child.frame(child.response({ status: "error", error_code: "descendant_precedes_parent", parent_pid: 7001,
        exit_history: { version: 1, pids: [7002, 7003] }, ancestry_failure: ancestryFailure(), ...extra }));
      const failure: unknown = await initial.catch(error => error);
      expect((failure as Error).message).toContain("observer_protocol_failed");
      expect(WindowsBrowserSessionObservationError.negativeEvidence(failure, 7001)).toBeUndefined();
      expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
    });
  it("rejects duplicate diagnostic keys before folding and never attaches late evidence", async () => {
    const first = await bound(); const duplicate = first.session.observe();
    const line = JSON.stringify(first.child.response({ status: "error", error_code: "descendant_precedes_parent", parent_pid: 7001,
      exit_history: { version: 1, pids: [7002, 7003] }, ancestry_failure: ancestryFailure() }));
    first.child.stdout.write(line.replace('"attempt":2', '"attempt":1,"attempt":2') + "\n");
    await expect(duplicate).rejects.toThrow("observer_protocol_failed");
    const second = await bound(); const late = second.session.observe(); now += 5000;
    second.child.frame(second.child.response({ status: "error", error_code: "descendant_precedes_parent", parent_pid: 7001,
      exit_history: { version: 1, pids: [7002, 7003] }, ancestry_failure: ancestryFailure() }));
    const failure: unknown = await late.catch(error => error);
    expect((failure as Error).message).toContain("observer_deadline");
    expect(WindowsBrowserSessionObservationError.negativeEvidence(failure, 7001)).toBeUndefined();
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
  });
  it("preserves initial frames without history and unions exit-only history without fabricating process identities", async () => {
    const legacy = await bound(); const first = legacy.session.observe();
    legacy.child.frame(legacy.child.response({ parent_pid: 7001, processes }));
    await expect(first).resolves.toEqual([7001]);

    const { child, session } = await bound(); const initial = session.observe();
    const current = [...processes, { pid: 7002, created_utc: processes[0]!.created_utc }];
    child.frame(child.response({ parent_pid: 7001, processes: current, exit_history: { version: 1, pids: [7002, 7003, 0xffffffff] } }));
    await expect(initial).resolves.toEqual([7001, 7002, 7003, 0xffffffff]);
    expect(current).toHaveLength(2);
    const final = session.finalAudit(4000); child.frame(child.response({ processes: [] })); child.close();
    await expect(final).resolves.toEqual([]); session.assertCompleted();
  });
  it("counts current/history overlap once at the native 128 PID bound including root", async () => {
    const { child, session } = await bound(); const initial = session.observe();
    const descendants = Array.from({ length: 127 }, (_, index) => 8000 + index);
    child.frame(child.response({ parent_pid: 7001,
      processes: [...processes, ...descendants.map(pid => ({ pid, created_utc: processes[0]!.created_utc }))],
      exit_history: { version: 1, pids: descendants } }));
    await expect(initial).resolves.toEqual([7001, ...descendants]);
  });
  it("carries successful transport history through exit probes and requires the unchanged final closure", async () => {
    const { child, session } = await bound();
    const probe = vi.fn((_pid: number) => { throw Object.assign(new Error("Controlled absent PID"), { code: "ESRCH" }); });
    const terminateParent = vi.fn(async (_remainingMs: number) => {});
    const closing = closeObservedWindowsProcesses({ parentPid: 7001, parentClosed: () => true,
      observe: () => session.observe(), terminateParent, requestGracefulClose: async () => {},
      finalAudit: remaining => { const final = session.finalAudit(remaining); child.frame(child.response({ processes: [] })); child.close(); return final; } },
    { probe, now: () => now, sleep: async () => {}, connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100 });
    child.frame(child.response({ parent_pid: 7001, processes, exit_history: { version: 1, pids: [7002] } }));
    await expect(closing).resolves.toEqual({ observedProcessCount: 2 });
    expect(probe.mock.calls.map(([pid]) => pid)).toEqual([7001, 7002, 7001, 7002]);
    expect(terminateParent).not.toHaveBeenCalled(); session.assertCompleted();
  });
  it("carries failed transport history only into exit probes and never into graceful success", async () => {
    const { child, session } = await bound();
    const probe = vi.fn((_pid: number) => { throw Object.assign(new Error("Controlled absent PID"), { code: "ESRCH" }); });
    const requestGracefulClose = vi.fn(async (_remainingMs: number) => {});
    const terminateParent = vi.fn(async (_remainingMs: number) => {});
    const closing = closeObservedWindowsProcesses({ parentPid: 7001, parentClosed: () => true,
      observe: () => session.observe(), terminateParent, requestGracefulClose, finalAudit: remaining => session.finalAudit(remaining) },
    { probe, now: () => now, sleep: async () => {}, connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100 });
    void closing.catch(() => {});
    child.frame(child.response({ status: "error", error_code: "observer_retry_exhausted", parent_pid: 7001, exit_history: { version: 1, pids: [7002] } }));
    await expect(closing).rejects.toThrow("profile is retained");
    expect(probe.mock.calls.map(([pid]) => pid)).toEqual([7001, 7002]);
    expect(requestGracefulClose).not.toHaveBeenCalled(); expect(terminateParent).toHaveBeenCalledExactlyOnceWith(3000);
    child.close(1); await session.cleanup(); expect(() => session.assertCompleted()).toThrow("observer_retry_exhausted");
  });
  it.each([
    { name: "unknown history version", history: { version: 2, pids: [7002] } },
    { name: "array history", history: [] },
    { name: "null history", history: null },
    { name: "missing history version", history: { pids: [7002] } },
    { name: "missing history PIDs", history: { version: 1 } },
    { name: "non-array history PIDs", history: { version: 1, pids: 7002 } },
    { name: "duplicate history PIDs", history: { version: 1, pids: [7002, 7002] } },
    { name: "root in history", history: { version: 1, pids: [7001] } },
    { name: "zero history PID", history: { version: 1, pids: [0] } },
    { name: "negative history PID", history: { version: 1, pids: [-1] } },
    { name: "fractional history PID", history: { version: 1, pids: [7002.5] } },
    { name: "string history PID", history: { version: 1, pids: ["7002"] } },
    { name: "history PID beyond uint32", history: { version: 1, pids: [0x100000000] } },
    { name: "fabricated history creation", history: { version: 1, pids: [7002], created_utc: "2026-11-05T00:00:00Z" } },
    { name: "fabricated history ownership", history: { version: 1, pids: [7002], owned: true } },
    { name: "history identity object", history: { version: 1, pids: [{ pid: 7002, created_utc: "2026-11-05T00:00:00Z" }] } },
    { name: "history alone exceeds bound", history: { version: 1, pids: Array.from({ length: 128 }, (_, index) => 8000 + index) } },
  ])("rejects $name in both successful and explicit failed initial frames", async ({ history }) => {
    for (const status of ["ok", "error"]) {
      const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
      child.frame(child.response({ status, parent_pid: 7001, exit_history: history,
        ...(status === "ok" ? { processes } : { error_code: "observer_retry_exhausted" }) }));
      const failure: unknown = await initial.catch(error => error);
      expect(failure).toBeInstanceOf(WindowsBrowserSessionObservationError);
      expect((failure as Error).message).toContain("observer_protocol_failed");
      expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
    }
  });
  it("rejects a union exceeding 128 even when each current/history collection is within its bound", async () => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    child.frame(child.response({ parent_pid: 7001,
      processes: [...processes, { pid: 7002, created_utc: processes[0]!.created_utc }],
      exit_history: { version: 1, pids: Array.from({ length: 127 }, (_, index) => 8000 + index) } }));
    await expect(initial).rejects.toThrow("observer_protocol_failed");
  });
  it("rejects a non-native current PID even alongside valid history", async () => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    child.frame(child.response({ parent_pid: 7001,
      processes: [...processes, { pid: 0x100000000, created_utc: processes[0]!.created_utc }], exit_history: { version: 1, pids: [] } }));
    await expect(initial).rejects.toThrow("observer_protocol_failed");
  });
  it("rejects duplicate nested history keys before JSON can collapse them", async () => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    const frame = JSON.stringify(child.response({ parent_pid: 7001, processes, exit_history: { version: 1, pids: [7002] } }));
    child.stdout.write(frame.replace('"pids":[7002]', '"pids":[],"pids":[7002]') + "\n");
    await expect(initial).rejects.toThrow("observer_protocol_failed");
  });
  it.each([
    { name: "wrong session", extra: { session: "other" } },
    { name: "wrong sequence", extra: { seq: 3 } },
    { name: "wrong operation", extra: { operation: "final" } },
    { name: "wrong root", extra: { parent_pid: 7002 } },
    { name: "missing paired root", extra: { parent_pid: undefined } },
    { name: "missing paired history", extra: { exit_history: undefined } },
    { name: "current process claims on error", extra: { processes } },
  ])("does not trust explicit error history with $name", async ({ extra }) => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    child.frame(child.response({ status: "error", error_code: "process_open_invalid_parameter", parent_pid: 7001,
      exit_history: { version: 1, pids: [7002] }, ...extra }));
    const failure: unknown = await initial.catch(error => error);
    expect((failure as Error).message).toContain("observer_protocol_failed");
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
  });
  it.each(["process_open_access_denied", "process_open_invalid_parameter", "process_open_invalid_handle", "process_open_resource_unavailable",
    "process_open_other_error", "historical_pid_reappeared", "historical_identity_unknown", "historical_creation_changed", "ancestry_parent_changed", "observer_retry_exhausted"])(
    "preserves the closed native diagnostic %s with immutable cleanup-only history", async code => {
      const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
      child.frame(child.response({ status: "error", error_code: code, parent_pid: 7001, exit_history: { version: 1, pids: [7002] } }));
      const failure: unknown = await initial.catch(error => error);
      expect(failure).toBeInstanceOf(WindowsBrowserSessionObservationError);
      expect((failure as Error).message).toContain(`(${code})`);
      expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toEqual([7002]);
      expect(Object.isFrozen(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001))).toBe(true);
      expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7002)).toBeUndefined();
      await expect(session.finalAudit(1000)).rejects.toBe(failure);
      child.close(1); await session.cleanup(); expect(() => session.assertCompleted()).toThrow(code);
    });
  it.each([undefined, { version: 1, pids: [] }])("retains failure when optional initial error history is %j", async history => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    child.frame(child.response({ status: "error", error_code: "observer_retry_exhausted",
      ...(history === undefined ? {} : { parent_pid: 7001, exit_history: history }) }));
    const failure: unknown = await initial.catch(error => error);
    expect((failure as Error).message).toContain("observer_retry_exhausted");
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toEqual(history?.pids);
    await expect(session.observe()).rejects.toBe(failure);
  });
  it.each(["ready", "bind", "final"])("forbids history on a %s error", async operation => {
    const result = operation === "final" ? await observed() : create();
    const { child, session } = result;
    let pending: Promise<unknown>;
    if (operation === "final") pending = session.finalAudit(1000);
    else {
      pending = session.bind(7001); void pending.catch(() => {});
      if (operation === "bind") { child.ready(); await tick(); }
    }
    void pending.catch(() => {});
    const errorFrame = { status: "error", error_code: "observer_retry_exhausted", parent_pid: 7001, exit_history: { version: 1, pids: [7002] } };
    child.frame(operation === "ready"
      ? { version: 1, session: child.configure().session, seq: 0, operation: "ready", ...errorFrame }
      : child.response(errorFrame));
    const failure: unknown = await pending.catch(error => error);
    expect((failure as Error).message).toContain("observer_protocol_failed");
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
  });
  it("does not attach late error history after the original initial deadline, even before its timer runs", async () => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    now += 5000;
    child.frame(child.response({ status: "error", error_code: "observer_retry_exhausted", parent_pid: 7001, exit_history: { version: 1, pids: [7002] } }));
    const failure: unknown = await initial.catch(error => error);
    expect((failure as Error).message).toContain("observer_deadline");
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
  });
  it("does not attach a partial undelivered error history when the observer dies", async () => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    child.stdout.write(JSON.stringify(child.response({ status: "error", error_code: "observer_retry_exhausted", parent_pid: 7001,
      exit_history: { version: 1, pids: [7002] } })));
    child.close(1);
    const failure: unknown = await initial.catch(error => error);
    expect(failure).toBeInstanceOf(WindowsBrowserSessionObservationError);
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 7001)).toBeUndefined();
    expect(() => session.assertCompleted()).toThrow();
  });
  it("keeps script/configuration on the private pipe and binds within the shared launch deadline", async () => {
    const { child, session } = create(undefined, 1000);
    const call = fixture.spawn.mock.calls[0]!;
    expect(call[1]).toHaveLength(5); expect(call[2]).toMatchObject({ windowsHide: true, stdio: "pipe" });
    expect(JSON.stringify(call[1])).not.toContain("C:\\private\\profile");
    expect(child.configure()).toMatchObject({ version: 1, operation: "configure", seq: 0 });
    const binding = session.bind(7001); void binding.catch(() => {});
    await advance(900); child.ready(); await tick();
    expect(child.request()).toMatchObject({ operation: "bind", seq: 1, parent_pid: 7001 });
    await advance(100);
    await expect(binding).rejects.toThrow("observer_deadline");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.frame(child.response({ parent_pid: 7001 }));
    await expect(session.observe()).rejects.toThrow("observer_deadline");
  });
  it("waits for exit, actual close and both output EOFs before returning a final empty audit", async () => {
    const { child, session } = await observed();
    const final = session.finalAudit(4000); let settled = false; void final.then(() => { settled = true; });
    // Exit may be observed before the last stdout frame. It is not close proof.
    child.emit("exit", 0, null); child.frame(child.response({ processes: [] })); await tick();
    expect(settled).toBe(false);
    child.stdout.end(); child.emit("close", 0, null); await tick(); expect(settled).toBe(false);
    child.stderr.end(); await expect(final).resolves.toEqual([]); session.assertCompleted();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("collects nonempty final results without closing and accepts only the following final operation", async () => {
    const { child, session } = await observed();
    const first = session.finalAudit(4000); child.frame(child.response({ processes })); await expect(first).resolves.toEqual([7001]);
    const second = session.finalAudit(2000); expect(child.request().seq).toBe(4);
    child.frame(child.response({ processes: [] })); child.close(); await expect(second).resolves.toEqual([]);
  });
  it.each(["stderr_eof", "exit"])("does not reuse a session whose %s precedes a nonempty final result", async first => {
    const { child, session } = await observed(); const final = session.finalAudit(4000); void final.catch(() => {});
    if (first === "stderr_eof") { child.stderr.end(); await tick(); } else child.emit("exit", 0, null);
    child.frame(child.response({ processes }));
    await expect(final).rejects.toThrow("observer_parent_eof");
    await expect(session.finalAudit(2000)).rejects.toThrow("observer_parent_eof");
  });
  it("accepts stderr EOF and exit before a valid empty final only after stdout and close finish", async () => {
    const { child, session } = await observed(); const final = session.finalAudit(4000);
    child.stderr.end(); child.emit("exit", 0, null); await tick();
    child.frame(child.response({ processes: [] })); child.stdout.end(); child.emit("close", 0, null);
    await expect(final).resolves.toEqual([]); session.assertCompleted();
  });
  it.each(["stdout", "stderr"] as const)("poisons an unexpected early %s EOF before a close request", async stream => {
    const { child, session } = await bound(); child[stream].end(); await tick();
    await expect(session.observe()).rejects.toThrow("observer_parent_eof");
    expect(child.kill).toHaveBeenCalled();
  });
  it("does not accept an empty final whose actual close misses the remaining audit deadline", async () => {
    const { child, session } = await observed(); const final = session.finalAudit(100); void final.catch(() => {});
    child.frame(child.response({ processes: [] })); child.emit("exit", 0, null); child.stdout.end(); child.stderr.end();
    await advance(100); await expect(final).rejects.toThrow("observer_deadline");
    child.emit("close", 0, null); await tick(); expect(() => session.assertCompleted()).toThrow("observer_deadline");
  });
  it("rejects extra frames after empty final instead of treating process exit as clean output", async () => {
    const { child, session } = await observed(); const final = session.finalAudit(1000); void final.catch(() => {});
    const frame = child.response({ processes: [] }); child.frame(frame); child.frame(frame); child.close();
    await expect(final).rejects.toThrow("observer_protocol_failed");
  });
  it("rejects duplicate JSON keys before the parser can collapse them", async () => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    child.stdout.write(JSON.stringify(child.response({ parent_pid: 7001, processes })).replace('"status":"ok"', '"status":"error","status":"ok"') + "\n");
    await expect(initial).rejects.toThrow("observer_protocol_failed");
  });
  it.each([
    { name: "wrong session", extra: { session: "other" } },
    { name: "wrong sequence", extra: { seq: 100 } },
    { name: "wrong operation", extra: { operation: "final" } },
    { name: "unknown field", extra: { authority: true } },
    { name: "wrong root", extra: { parent_pid: 7002 } },
    { name: "duplicate PIDs", extra: { processes: [...processes, ...processes] } },
  ])("fails closed for $name", async ({ extra }) => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    child.frame(child.response({ parent_pid: 7001, processes, ...extra }));
    await expect(initial).rejects.toThrow("observer_protocol_failed");
    expect(child.kill).toHaveBeenCalled();
  });
  it("rejects reentry and never starts a second initial observation", async () => {
    const { child, session } = await bound(); const first = session.observe(); void first.catch(() => {});
    await expect(session.observe()).rejects.toThrow("observer_protocol_failed");
    await expect(first).rejects.toThrow("observer_protocol_failed");
    expect(child.writes.filter(line => line.includes('"operation":"initial"'))).toHaveLength(1);
  });
  it("waits for actual close after a spawn error and does not renew failure cleanup", async () => {
    const { child, session } = create(); const binding = session.bind(7001); void binding.catch(() => {});
    child.emit("error", new Error("Private spawn details")); await expect(binding).rejects.toThrow("observer_process_failed");
    let cleaned = false; const cleanup = session.cleanup(); void cleanup.then(() => { cleaned = true; }, () => {});
    await advance(2000); expect(cleaned).toBe(false); session.abort(); expect(session.cleanup()).toBe(cleanup);
    await advance(1000); await expect(cleanup).rejects.toThrow("observer_cleanup_unconfirmed");
    child.emit("close", -1, null); await expect(session.cleanup()).rejects.toThrow("observer_cleanup_unconfirmed");
  });
  it("cannot restore success after an asynchronous input write error or late result", async () => {
    const { child, session } = await bound(); child.holdWrite = true;
    const initial = session.observe(); void initial.catch(() => {});
    child.frame(child.response({ parent_pid: 7001, processes }));
    child.held!(new Error("Private pipe path")); await tick();
    await expect(initial).rejects.toThrow("observer_input_failed");
    child.close(); await session.cleanup(); expect(() => session.assertCompleted()).toThrow("observer_input_failed");
  });
  it("handles a synchronous write exception without assuming observer closure", async () => {
    const { child, session } = await bound(); vi.spyOn(child.stdin, "write").mockImplementation(() => { throw new Error("Pipe unavailable"); });
    await expect(session.observe()).rejects.toThrow("observer_input_failed");
    const cleanup = session.cleanup(); let finished = false; void cleanup.then(() => { finished = true; });
    await tick(); expect(finished).toBe(false); child.close(); await cleanup;
  });
  it("times out initial at five seconds and ignores a late successful result", async () => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    await advance(5000); await expect(initial).rejects.toThrow("observer_deadline");
    child.frame(child.response({ parent_pid: 7001, processes })); child.close(); await session.cleanup();
    expect(() => session.assertCompleted()).toThrow("observer_deadline");
  });
  it("preserves trusted session failure code and phase through browser shutdown diagnostics", async () => {
    const { session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    await advance(5000); await expect(initial).rejects.toThrow("observer_deadline");
    const absent = () => { throw Object.assign(new Error("Controlled absent PID"), { code: "ESRCH" }); };
    await expect(closeObservedWindowsProcesses({ parentPid: 7001, parentClosed: () => true,
      observe: () => session.observe(), terminateParent: async () => {}, finalAudit: async () => [] },
    { probe: absent, now: () => 0, sleep: async () => {}, connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100 }))
      .rejects.toThrow("initial_observation:observer_deadline@process_start");
    await expect(closeObservedWindowsProcesses({ parentPid: 7001, parentClosed: () => true,
      observe: async () => { throw new Error("Protected Windows browser session failed (observer_deadline) [last_phase=root_query]"); },
      terminateParent: async () => {}, finalAudit: async () => [] },
    { probe: absent, now: () => 0, sleep: async () => {}, connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100 }))
      .rejects.toThrow("initial_observation:unavailable");
  });
  it("wires cancellation before spawn and during an active observer", async () => {
    const early = new AbortController(); early.abort(); expect(() => create(early.signal)).toThrow("observer_cancelled");
    expect(fixture.spawn).not.toHaveBeenCalled(); fixture.spawn.mockReset();
    const controller = new AbortController(); const { child, session } = await bound(controller.signal);
    controller.abort(); await expect(session.observe()).rejects.toThrow("observer_cancelled");
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL"); child.close(); await session.cleanup();
  });
  it.each(["oversized", "partial"])("rejects %s stdout without authorizing cleanup", async kind => {
    const { child, session } = await bound(); const initial = session.observe(); void initial.catch(() => {});
    child.stdout.write(kind === "oversized" ? "x".repeat(65537) : '{"version":1');
    if (kind === "partial") child.stdout.end();
    await expect(initial).rejects.toThrow(/observer_(protocol_failed|output_invalid)/);
  });
});
