// Runner lifecycle only. Admission and the delayed API are controlled stand-ins;
// the actual stdin control helper runs against fake streams and signal emitters.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalApplicationService } from "./application-local-service.js";

const state = vi.hoisted(() => ({ selection: vi.fn(), prepare: vi.fn(), current: vi.fn(), reopen: vi.fn(), initialize: vi.fn(),
  events: [] as string[], imports: 0 }));
vi.mock("./application-bootstrap-admission.js", () => ({ applicationServiceSelection: state.selection, prepareApplicationBootstrap: state.prepare }));
const originalProcess = process;
const shutdown = Buffer.from('{"version":1,"kind":"shutdown"}\n');
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function until(check: () => boolean) {
  for (let count = 0; count < 100; count++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  throw Error("Controlled bootstrap did not reach expected state");
}
class Input extends EventEmitter {
  readableObjectMode = false; readableEncoding: string | null = null; readableEnded = false; destroyed = false;
  pause = vi.fn();
}
class Output extends EventEmitter {
  records: Record<string, unknown>[] = [];
  pending = new Set<(error?: Error | null) => void>();
  onWrite: (record: Record<string, unknown>, complete: (error?: Error | null) => void) => void = (_record, complete) => complete();
  write = vi.fn((bytes: Buffer, callback: (error?: Error | null) => void) => {
    const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; this.records.push(record);
    state.events.push("output:" + String(record.kind));
    let done = false;
    const complete = (error?: Error | null) => { if (done) return; done = true; this.pending.delete(complete); callback(error); };
    this.pending.add(complete); this.onWrite(record, complete); return true;
  });
  finish() { for (const complete of [...this.pending]) complete(); }
}
let last: Awaited<ReturnType<typeof fixture>> | undefined;
beforeEach(() => {
  vi.resetModules(); state.events.length = 0; state.imports = 0;
  for (const mock of [state.selection, state.prepare, state.current, state.reopen, state.initialize]) mock.mockReset();
  vi.doMock("./application-service-host-api.js", () => {
    state.imports++; state.events.push("host-import"); return { reopenInstalledApplicationService: state.reopen, initializeApplicationPackage: state.initialize };
  });
});
afterEach(async () => {
  if (last) {
    last.signals.emit("SIGTERM"); last.closeDone.resolve(); last.closed.resolve(); last.stdout.finish(); last.stderr.finish();
    if (last.work) await last.work.catch(() => {});
    last = undefined;
  }
  vi.unstubAllGlobals(); vi.doUnmock("./application-service-host-api.js");
});
async function fixture(mode: "stdin" | "signals" = "stdin", operation: "reopen" | "initialize" = "reopen") {
  // Import under the genuine process argv so the module's direct-entry guard
  // cannot start a second runner. Only subsequent explicit calls see this host.
  const { runApplicationServiceBootstrap } = await import("./application-service-bootstrap.js");
  const input = new Input(), stdout = new Output(), stderr = new Output(), signals = new EventEmitter();
  const exit = vi.fn(() => { throw Error("process.exit is forbidden"); }), kill = vi.fn(() => { throw Error("PID cleanup is forbidden"); });
  const host = Object.create(originalProcess) as NodeJS.Process;
  Object.defineProperties(host, {
    stdin: { value: input }, stdout: { value: stdout }, stderr: { value: stderr },
    argv: { value: [originalProcess.execPath, "C:\\controlled\\application-service-bootstrap.mjs", "--selection=C:\\config\\application.json"] },
    on: { value: signals.on.bind(signals) }, off: { value: signals.off.bind(signals) },
    exit: { value: exit }, kill: { value: kill }, exitCode: { value: undefined, writable: true },
  });
  vi.stubGlobal("process", host);
  const options = Object.freeze({ reference: Object.freeze({}), node: Object.freeze({}), backend: Object.freeze({}),
    bootstrap: Object.freeze({}), hostCode: Object.freeze({}), hostDirectory: "C:\\host", nodeId: "node1", allowedRoots: Object.freeze(["C:\\work"]) });
  const selected = Object.freeze({ operation, shutdown: mode, options, assertCurrent: state.current });
  state.selection.mockImplementation(() => { state.events.push("selection"); return "C:\\config\\application.json"; });
  state.prepare.mockImplementation(() => { state.events.push("prepare"); return selected; });
  state.current.mockImplementation(() => { state.events.push("assert-current"); });
  const closed = deferred<void>(), closeDone = deferred<void>();
  const close = vi.fn(() => closeDone.promise);
  const service: LocalApplicationService = Object.freeze({ origin: "http://127.0.0.1:31000", closed: closed.promise, close });
  state.reopen.mockImplementation(async (_options, signal: AbortSignal) => {
    state.events.push("reopen");
    // The production installed API owns this signal-to-close connection. The
    // controlled counterpart retains independently delayed original settlements.
    signal.addEventListener("abort", () => { void close().catch(() => {}); }, { once: true });
    return service;
  });
  const f = { input, stdout, stderr, signals, host, exit, kill, options, selected, closed, closeDone, close, service,
    work: undefined as Promise<void> | undefined, settled: false,
    run(): Promise<void> {
      f.work = runApplicationServiceBootstrap(); void f.work.then(() => { f.settled = true; }, () => { f.settled = true; }); return f.work;
    },
    finish() { closeDone.resolve(); closed.resolve(); },
  };
  last = f; return f;
}
function expectDetached(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.signals.listenerCount("SIGINT")).toBe(0); expect(f.signals.listenerCount("SIGTERM")).toBe(0);
  expect(f.input.listenerCount("data")).toBe(0); expect(f.input.listenerCount("end")).toBe(0); expect(f.input.listenerCount("error")).toBe(0);
  expect(f.stdout.listenerCount("error")).toBe(0); expect(f.stderr.listenerCount("error")).toBe(0);
  expect(f.exit).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled(); expect(f.host.exitCode).toBeUndefined();
}

describe("application-only bootstrap runner with original controlled owners", () => {
  it("asserts original admission before the first delayed import and passes the exact fresh objects", async () => {
    const f = await fixture(), work = f.run(); await until(() => f.stdout.records.length === 1);
    expect(state.events.slice(0, 6)).toEqual(["selection", "prepare", "assert-current", "host-import", "assert-current", "reopen"]);
    expect(state.prepare).toHaveBeenCalledWith("C:\\config\\application.json", expect.stringMatching(/application-service-bootstrap\.ts$/u));
    expect(state.reopen.mock.calls[0]![0]).toBe(f.options);
    expect(state.reopen.mock.calls[0]![0].backend).toBe(f.options.backend); expect(state.reopen.mock.calls[0]![0].hostCode).toBe(f.options.hostCode);
    expect(state.reopen.mock.calls[0]![0].bootstrap).toBe(f.options.bootstrap);
    expect(state.reopen.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(f.stdout.records[0]).toMatchObject({ kind: "application-service.listening", origin: f.service.origin, qualified_for_product: false });
    f.finish(); await work; expectDetached(f);
  });
  it.each(["selection", "prepare", "pre-import-assert"])("does not import the application after %s failure", async phase => {
    const f = await fixture(), failure = Error(phase);
    (phase === "selection" ? state.selection : phase === "prepare" ? state.prepare : state.current).mockImplementation(() => { throw failure; });
    await expect(f.run()).rejects.toBe(failure); expect(state.imports).toBe(0); expect(state.reopen).not.toHaveBeenCalled();
    expect(f.stdout.records).toEqual([]); expectDetached(f);
  });
  it("rechecks original admission after import and refuses to start if it changed", async () => {
    const f = await fixture(), failure = Error("changed after import"); state.current.mockImplementationOnce(() => {}).mockImplementation(() => { throw failure; });
    await expect(f.run()).rejects.toBe(failure); expect(state.imports).toBe(1); expect(state.reopen).not.toHaveBeenCalled(); expectDetached(f);
  });
  it("rejects changed admission after reopening without readiness and joins both original closure owners", async () => {
    const f = await fixture(), failure = Error("changed while reopening");
    state.current.mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementation(() => { throw failure; });
    const work = f.run(); await until(() => f.close.mock.calls.length > 0);
    expect(state.reopen).toHaveBeenCalledOnce(); expect(state.current).toHaveBeenCalledTimes(3);
    expect(state.reopen.mock.calls[0]![1].aborted).toBe(true); expect(f.stdout.records).toEqual([]); expect(f.settled).toBe(false);
    f.closeDone.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); expect(f.settled).toBe(false);
    f.closed.resolve(); await expect(work).rejects.toBe(failure);
    expect(f.stdout.records).toEqual([]); expectDetached(f);
  });
  it.each(["SIGINT", "SIGTERM"])("retains an early %s during admission and skips the delayed application import", async signal => {
    const f = await fixture(); state.prepare.mockImplementation(() => { f.signals.emit(signal); return f.selected; });
    await f.run(); expect(state.imports).toBe(0); expect(state.reopen).not.toHaveBeenCalled();
    expect(f.stdout.records).toEqual([{ version: 1, kind: "application-service.closed", started: false, reason: signal, qualified_for_product: false }]);
    expectDetached(f);
  });
  it("retains shutdown already buffered when stdin mode is enabled, before importing application code", async () => {
    const f = await fixture(), on = f.input.on.bind(f.input);
    vi.spyOn(f.input, "on").mockImplementation((event, listener) => {
      on(event, listener); if (event === "data") f.input.emit("data", shutdown); return f.input;
    });
    await f.run(); expect(state.imports).toBe(0); expect(state.reopen).not.toHaveBeenCalled();
    expect(f.stdout.records[0]).toMatchObject({ kind: "application-service.closed", started: false, reason: "stdin" }); expectDetached(f);
  });
  it("waits for the exact late startup owner after cancellation without reporting readiness", async () => {
    const f = await fixture(), startup = deferred<LocalApplicationService>(); state.reopen.mockReturnValue(startup.promise);
    const work = f.run(); await until(() => state.reopen.mock.calls.length === 1);
    f.input.emit("data", shutdown); expect(state.reopen.mock.calls[0]![1].aborted).toBe(true);
    startup.resolve(f.service); await until(() => f.close.mock.calls.length === 1);
    expect(f.settled).toBe(false); expect(f.stdout.records).toEqual([]);
    f.closeDone.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); expect(f.settled).toBe(false);
    f.closed.resolve(); await work;
    expect(f.stdout.records).toEqual([{ version: 1, kind: "application-service.closed", started: true, reason: "stdin", qualified_for_product: false }]); expectDetached(f);
  });
  it("waits for both original close and closed after readiness output callback failure", async () => {
    const f = await fixture(), failure = Error("readiness pipe failed"); f.stdout.onWrite = (_record, complete) => complete(failure);
    const work = f.run(); await until(() => f.close.mock.calls.length > 0);
    expect(state.reopen.mock.calls[0]![1].aborted).toBe(true); expect(f.settled).toBe(false);
    f.closeDone.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); expect(f.settled).toBe(false);
    f.closed.resolve(); await expect(work).rejects.toBe(failure); expect(f.stdout.records).toHaveLength(1); expectDetached(f);
  });
  it("does not return on a valid stdin request until actual original service closure", async () => {
    const f = await fixture(), work = f.run(); await until(() => f.stdout.records.length === 1);
    f.input.emit("data", shutdown); f.input.emit("end"); await until(() => f.close.mock.calls.length > 0);
    expect(f.settled).toBe(false); f.closeDone.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); expect(f.settled).toBe(false);
    f.closed.resolve(); await work;
    expect(f.stdout.records[1]).toMatchObject({ kind: "application-service.closed", reason: "stdin" }); expectDetached(f);
  });
  it("rejects uncertain original shutdown without process exit, PID cleanup or success status", async () => {
    const f = await fixture(), work = f.run(); await until(() => f.stdout.records.length === 1);
    const failure = Error("original owner closure uncertain"); f.closed.reject(failure); await until(() => f.close.mock.calls.length > 0);
    expect(f.settled).toBe(false); f.closeDone.reject(Error("original close failed"));
    await expect(work).rejects.toThrow("original closure remains uncertain"); expect(f.stdout.records).toHaveLength(1); expectDetached(f);
  });
  it("allows natural budget drain and reports closure only after a final current-admission check", async () => {
    const f = await fixture("signals"), work = f.run(); await until(() => f.stdout.records.length === 1);
    expect(f.input.listenerCount("data")).toBe(0); f.finish(); await work;
    expect(f.close).not.toHaveBeenCalled(); expect(state.events.slice(-2)).toEqual(["assert-current", "output:application-service.closed"]);
    expect(f.stdout.records[1]).toMatchObject({ kind: "application-service.closed", reason: "budget-exhausted" }); expectDetached(f);
  });
  it("retains listener startup rejection and never publishes listening or closes a fabricated owner", async () => {
    const f = await fixture(), failure = Error("listener could not bind"); state.reopen.mockRejectedValue(failure);
    await expect(f.run()).rejects.toBe(failure); expect(f.stdout.records).toEqual([]); expect(f.close).not.toHaveBeenCalled(); expectDetached(f);
  });
  it("propagates an invalid stdin event after waiting for the already-owned service", async () => {
    const f = await fixture(), work = f.run(); await until(() => f.stdout.records.length === 1);
    f.input.emit("data", Buffer.from('{"kind":"exec"}\n')); await until(() => f.close.mock.calls.length > 0);
    expect(f.settled).toBe(false); f.finish(); await expect(work).rejects.toThrow("stdin control was invalid");
    expect(f.stdout.records).toHaveLength(1); expectDetached(f);
  });
  it.each(["stdout", "stderr"])("retains %s transport failure and joins original cleanup", async stream => {
    const f = await fixture(), work = f.run(); await until(() => f.stdout.records.length === 1);
    const failure = Error("lost status pipe"); (stream === "stdout" ? f.stdout : f.stderr).emit("error", failure);
    await until(() => f.close.mock.calls.length > 0); expect(f.settled).toBe(false); f.finish(); await expect(work).rejects.toBe(failure);
    expect(f.stdout.records).toHaveLength(1); expectDetached(f);
  });
  it("retains a control failure delivered while the final closed status is still flushing", async () => {
    const f = await fixture(); let completeFinal!: (error?: Error | null) => void;
    f.stdout.onWrite = (record, complete) => { if (record.kind === "application-service.closed") completeFinal = complete; else complete(); };
    const work = f.run(); await until(() => f.stdout.records.length === 1);
    f.input.emit("data", shutdown); f.finish(); await until(() => f.stdout.records.length === 2);
    expect(f.settled).toBe(false); f.input.emit("data", Buffer.from("trailing bytes")); completeFinal();
    await expect(work).rejects.toThrow("stdin control was invalid"); expectDetached(f);
  });
  it.each(["stdout", "stderr"])("retains %s transport failure while the final closed status is flushing", async stream => {
    const f = await fixture(), failure = Error("lost final status pipe"); let completeFinal!: (error?: Error | null) => void;
    f.stdout.onWrite = (record, complete) => { if (record.kind === "application-service.closed") completeFinal = complete; else complete(); };
    const work = f.run(); await until(() => f.stdout.records.length === 1);
    f.finish(); await until(() => f.stdout.records.length === 2);
    expect(f.settled).toBe(false); (stream === "stdout" ? f.stdout : f.stderr).emit("error", failure); completeFinal();
    await expect(work).rejects.toBe(failure); expectDetached(f);
  });
});

describe("fixed package initialization runner", () => {
  const reference = Object.freeze({ path: "C:\\installed\\generation\\control\\REOPEN.v1.json", bytes: 42, sha256: "sha256:" + "a".repeat(64) });
  it("awaits original initialization, hands off only its reference and never starts a service", async () => {
    const f = await fixture("stdin", "initialize"), initialized = deferred<typeof reference>(); state.initialize.mockReturnValue(initialized.promise);
    const work = f.run(); await until(() => state.initialize.mock.calls.length === 1);
    expect(f.stdout.records).toEqual([]); expect(f.settled).toBe(false);
    expect(state.initialize.mock.calls[0]![0]).toBe(f.options); expect(state.initialize.mock.calls[0]![0].bootstrap).toBe(f.options.bootstrap);
    initialized.resolve(reference); await work;
    expect(f.stdout.records).toEqual([{ version: 1, kind: "application-service.initialized", reference, qualified_for_product: false }]);
    expect(state.reopen).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled(); expectDetached(f);
  });
  it("does not manufacture a reference after an initialization failure", async () => {
    const f = await fixture("stdin", "initialize"), failure = Error("original broker closure failed"); state.initialize.mockRejectedValue(failure);
    await expect(f.run()).rejects.toBe(failure); expect(f.stdout.records).toEqual([]); expectDetached(f);
  });
  it.each(["stdin", "signal"])("retains %s cancellation while awaiting the original initialization promise", async kind => {
    const f = await fixture("stdin", "initialize"), initialized = deferred<typeof reference>(); state.initialize.mockReturnValue(initialized.promise);
    const work = f.run(); await until(() => state.initialize.mock.calls.length === 1);
    if (kind === "stdin") f.input.emit("data", shutdown); else f.signals.emit("SIGTERM");
    expect(state.initialize.mock.calls[0]![1].aborted).toBe(true); expect(f.settled).toBe(false);
    initialized.resolve(reference); await expect(work).rejects.toThrow("cancelled before handoff");
    expect(f.stdout.records).toEqual([]); expectDetached(f);
  });
  it("rejects changed admission before the initialized reference is emitted", async () => {
    const f = await fixture("stdin", "initialize"), failure = Error("initialization source changed"); state.initialize.mockResolvedValue(reference);
    state.current.mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw failure; });
    await expect(f.run()).rejects.toBe(failure); expect(f.stdout.records).toEqual([]); expectDetached(f);
  });
  it.each(["stdout", "stdin", "shutdown", "signal"])("does not hide %s failure during initialized-status flush", async kind => {
    const f = await fixture("stdin", "initialize"), failure = Error("initialized output failed"); let flush!: () => void;
    state.initialize.mockResolvedValue(reference); f.stdout.onWrite = (_record, complete) => { flush = () => complete(); };
    const work = f.run(); await until(() => f.stdout.records.length === 1); expect(f.settled).toBe(false);
    if (kind === "stdout") f.stdout.emit("error", failure);
    else if (kind === "stdin") f.input.emit("data", Buffer.from("bad\n"));
    else if (kind === "shutdown") f.input.emit("data", shutdown);
    else f.signals.emit("SIGTERM");
    flush(); await expect(work).rejects.toThrow(kind === "stdout" ? failure.message : kind === "stdin" ? "stdin control was invalid" : "cancelled before handoff");
    expectDetached(f);
  });
});
