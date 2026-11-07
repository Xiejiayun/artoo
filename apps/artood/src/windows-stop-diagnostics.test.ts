// Controlled diagnostic projection only; no native helper or model is executed.
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { installShutdownHandlers, type ShutdownRegistration } from "./main.js";
import { createWindowsStopDiagnostics, createWindowsStopDiagnosticWriter, observeWindowsStopStage, recordWindowsStopDiagnostic,
  WindowsStopDiagnosticSchema, type WindowsStopDiagnostic } from "./windows-stop-diagnostics.js";
import { markWindowsNativeFailure, windowsNativeFailureDetail } from "./owned/windows-process-diagnostic.js";

describe("bounded safe stop diagnostics", () => {
  it("keeps the first tagged failure while reporting fallback closure, without copying private data", async () => {
    const events: WindowsStopDiagnostic[] = [], diagnostics = createWindowsStopDiagnostics(value => events.push(value));
    const detail = windowsNativeFailureDetail("guardian_client_sync", 2, Buffer.from(JSON.stringify({ version: 1,
      kind: "native_failure_diagnostic", payload: { version: 1, phase: "guardian_response_read", code: "guardian_peer_eof", nativeError: null } }) + "\n"))!;
    const original = markWindowsNativeFailure(Error("private-path-key-env-argv"), "native_nonzero_exit", detail);
    await expect(diagnostics.run(async () => {
      recordWindowsStopDiagnostic("guardian_scope_admission", "failed", original);
      await observeWindowsStopStage("fallback_close", async () => {});
      recordWindowsStopDiagnostic("node_stop", "failed", Error("private-secondary-error"));
      throw original;
    })).rejects.toBe(original);
    expect(events.filter(value => value.status === "failed")).toEqual([expect.objectContaining({ phase: "guardian_scope_admission",
      error_code: "stop_stage_failed", native_failure_code: "native_nonzero_exit", native_failure_detail: detail })]);
    expect(events.at(-1)).toMatchObject({ phase: "fallback_close", status: "completed" });
    expect(events.every(value => WindowsStopDiagnosticSchema.safeParse(value).success)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private-");
  });
  it("reserves bounded space for the first failure and ignores copied native fields", () => {
    const events: WindowsStopDiagnostic[] = [], diagnostics = createWindowsStopDiagnostics(value => events.push(value));
    for (let i = 0; i < 100; i++) diagnostics.record("client_close", "entered");
    const copied = Object.assign(Error("private"), { native_failure_code: "native_timeout", native_failure_detail: { secret: true } });
    diagnostics.record("client_close", "failed", copied); diagnostics.record("node_stop", "failed", Error("later"));
    expect(events).toHaveLength(64); expect(events.at(-1)).toMatchObject({ status: "failed", error_code: "stop_stage_failed" });
    expect(events.at(-1)).not.toHaveProperty("native_failure_code"); expect(events.at(-1)).not.toHaveProperty("native_failure_detail");
  });
  it("never replaces an operational rejection when the diagnostic sink is broken", async () => {
    const original = Error("original"), diagnostics = createWindowsStopDiagnostics(() => { throw Error("broken sink"); });
    await expect(diagnostics.run(() => observeWindowsStopStage("client_close", () => { throw original; }))).rejects.toBe(original);
  });
  it.each(["async_error", "sync_throw", "sync_callback"])("joins actual stop after %s output failure and keeps one failed exit", async mode => {
    const failure = Error("private-pipe-error"), exit = vi.fn(); let finish!: () => void, shutdown!: ShutdownRegistration;
    const cleanup = new Promise<void>(resolve => { finish = resolve; });
    const output = new Writable({ write(_bytes, _encoding, callback) { queueMicrotask(() => callback(failure)); } });
    if (mode === "sync_throw") vi.spyOn(output, "write").mockImplementation(() => { throw failure; });
    if (mode === "sync_callback") vi.spyOn(output, "write").mockImplementation((...args: unknown[]) => {
      const callback = args.find(value => typeof value === "function") as ((error: Error) => void) | undefined;
      callback?.(failure); output.emit("error", failure); return false;
    });
    const failed = vi.fn((cause: unknown) => { void shutdown.fail(cause); });
    const write = createWindowsStopDiagnosticWriter(output, failed);
    const diagnostics = createWindowsStopDiagnostics(value => write(JSON.stringify(value) + "\n"));
    const host = Object.assign(new EventEmitter(), { exit, stopDiagnostics: diagnostics });
    const stop = vi.fn(() => cleanup);
    shutdown = installShutdownHandlers({ start: async () => {}, stop }, host);
    host.emit("SIGTERM"); await new Promise(resolve => setImmediate(resolve));
    output.emit("error", failure); await Promise.resolve();
    expect(failed).toHaveBeenCalledTimes(1); expect(shutdown.failure).toBe(failure);
    expect(stop).toHaveBeenCalledTimes(1); expect(exit).not.toHaveBeenCalled();
    finish(); await expect(shutdown.completion).rejects.toBe(failure);
    expect(exit).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledWith(1); shutdown(); output.destroy();
  });
  it("rejects extra fields and non-failure native details", () => {
    const valid = { version: 1, phase: "node_stop", status: "entered", elapsed_ms: 0, phase_elapsed_ms: 0 };
    expect(WindowsStopDiagnosticSchema.safeParse(valid).success).toBe(true);
    for (const change of [{ phase: "private" }, { stderr: "private" }, { error_code: "private" },
      { native_failure_code: "native_timeout" }, { elapsed_ms: 86_400_001 }])
      expect(WindowsStopDiagnosticSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
