import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { WINDOWS_NATIVE_FAILURE_CODES, readWindowsNativeFailure, WindowsNativeFailureDetailV1Schema } from "./owned/windows-process-diagnostic.js";

const phase = z.enum(["node_failure", "node_stop", "guardian_scope_admission", "fallback_close", "client_close", "publisher_stop",
  "source_close", "transport_close", "ipc_stopped", "ipc_disconnect", "daemon_input", "daemon_signal", "daemon_notification"]);
export type WindowsStopPhase = z.infer<typeof phase>;
export const WindowsStopDiagnosticSchema = z.object({ version: z.literal(1), phase,
  status: z.enum(["entered", "completed", "failed"]), elapsed_ms: z.number().int().min(0).max(86_400_000),
  phase_elapsed_ms: z.number().int().min(0).max(86_400_000), error_code: z.literal("stop_stage_failed").optional(),
  native_failure_code: z.enum(WINDOWS_NATIVE_FAILURE_CODES).optional(),
  native_failure_detail: WindowsNativeFailureDetailV1Schema.optional() }).strict().superRefine((value, context) => {
    if ((value.status === "failed") !== (value.error_code !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid stop diagnostic classification" });
    if (value.native_failure_code !== undefined && value.status !== "failed") context.addIssue({ code: z.ZodIssueCode.custom, message: "Native failure requires a failed stop stage" });
    if (value.native_failure_detail !== undefined && (value.status !== "failed" || value.native_failure_code === undefined))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Native detail requires a failed stop stage and category" });
  });
export type WindowsStopDiagnostic = z.infer<typeof WindowsStopDiagnosticSchema>;
export interface WindowsStopDiagnostics {
  run<T>(work: () => T): T;
  record(phase: WindowsStopPhase, status: WindowsStopDiagnostic["status"], cause?: unknown): void;
}
const current = new AsyncLocalStorage<WindowsStopDiagnostics>();
const elapsed = (now: number, before: number) => Math.min(86_400_000, Math.max(0, Math.floor(now - before)));

/** Local observation only. The first failure remains visible while fallback cleanup continues;
 * no diagnostic grants readiness, a clean stop, native closure or permission to remove a fence. */
export function createWindowsStopDiagnostics(sink: (value: WindowsStopDiagnostic) => void): WindowsStopDiagnostics {
  let begun: number | undefined, count = 0, failed = false, disabled = false;
  const starts = new Map<WindowsStopPhase, number>();
  const diagnostics: WindowsStopDiagnostics = {
    run: work => current.run(diagnostics, work),
    record(next, status, cause) {
      if (disabled || status === "failed" && failed || count >= (status === "failed" ? 64 : 63)) return;
      const now = performance.now(); begun ??= now;
      if (status === "entered") starts.set(next, now);
      const native = status === "failed" ? readWindowsNativeFailure(cause) : undefined;
      const value = WindowsStopDiagnosticSchema.safeParse({ version: 1, phase: next, status,
        elapsed_ms: elapsed(now, begun), phase_elapsed_ms: elapsed(now, starts.get(next) ?? now),
        ...(status === "failed" ? { error_code: "stop_stage_failed" } : {}),
        ...(native ? { native_failure_code: native.code, ...(native.detail ? { native_failure_detail: native.detail } : {}) } : {}) });
      if (!value.success) { disabled = true; return; }
      if (status === "failed") failed = true;
      count++;
      // Broken diagnostics cannot replace the original exception or prevent real cleanup.
      // No exception text, stack, environment, paths, argv or raw stderr enters this channel.
      try { sink(value.data); } catch { disabled = true; }
    },
  };
  return diagnostics;
}
export function recordWindowsStopDiagnostic(phase: WindowsStopPhase, status: WindowsStopDiagnostic["status"], cause?: unknown): void {
  current.getStore()?.record(phase, status, cause);
}
export async function observeWindowsStopStage<T>(phase: WindowsStopPhase, work: () => T | Promise<T>): Promise<T> {
  recordWindowsStopDiagnostic(phase, "entered");
  try { const result = await work(); recordWindowsStopDiagnostic(phase, "completed"); return result; }
  catch (error) { recordWindowsStopDiagnostic(phase, "failed", error); throw error; }
}

/** The daemon owns this stdout until process exit. An asynchronous pipe error must
 * enter its existing failed-stop path, not escape as an uncaught stream error. */
export function createWindowsStopDiagnosticWriter(output: NodeJS.WritableStream, onFailure: (cause: unknown) => void): (line: string) => void {
  let failed = false;
  // The first diagnostic can be emitted before main assigns its shared stop Promise.
  // Defer notification so a synchronous write failure cannot re-enter node.stop().
  const reject = (cause: unknown) => { if (!failed) { failed = true; queueMicrotask(() => onFailure(cause)); } };
  output.on("error", reject);
  return line => {
    if (failed) return;
    try { output.write(line, error => { if (error) reject(error); }); }
    catch (error) { reject(error); }
  };
}
