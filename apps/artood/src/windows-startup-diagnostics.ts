import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { WINDOWS_NATIVE_FAILURE_CODES, readWindowsNativeFailureCode } from "./owned/windows-process-diagnostic.js";

const phase = z.enum(["daemon_start", "load_configuration", "bootstrap_git", "create_node", "start_node", "await_registration",
  "guardian_session", "guardian_registration", "source_profiles", "source_backend", "source_releases", "source_storage",
  "git_installation", "research_storage", "source_bindings", "source_layout", "source_store_audit", "source_activation", "execution_ready"]);
export type WindowsStartupPhase = z.infer<typeof phase>;
export const WindowsStartupDiagnosticSchema = z.object({ version: z.literal(1), phase,
  status: z.enum(["entered", "completed", "failed"]), elapsed_ms: z.number().int().min(0).max(86_400_000),
  phase_elapsed_ms: z.number().int().min(0).max(86_400_000),
  error_code: z.literal("startup_stage_failed").optional(),
  native_failure_code: z.enum(WINDOWS_NATIVE_FAILURE_CODES).optional() }).strict().superRefine((value, context) => {
    if ((value.status === "failed") !== (value.error_code !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid diagnostic classification" });
    if (value.native_failure_code !== undefined && value.status !== "failed") context.addIssue({ code: z.ZodIssueCode.custom, message: "Native failure category requires a failed stage" });
  });
export type WindowsStartupDiagnostic = z.infer<typeof WindowsStartupDiagnosticSchema>;
interface DiagnosticState { emit(value: WindowsStartupDiagnostic): void; begun: number; phaseAt: number;
  phase: WindowsStartupPhase; ended: boolean; count: number }
const current = new AsyncLocalStorage<DiagnosticState>();
const elapsed = (now: number, before: number) => Math.min(86_400_000, Math.max(0, Math.floor(now - before)));
function emit(state: DiagnosticState, status: WindowsStartupDiagnostic["status"], cause?: unknown): void {
  if (state.count++ >= 64) return;
  const now = performance.now();
  const nativeCode = status === "failed" ? readWindowsNativeFailureCode(cause) : undefined;
  // Only compile-time stage/category names and locally measured numbers enter this projection.
  // Exception messages, paths, environment, argv and provider output never enter it.
  state.emit(WindowsStartupDiagnosticSchema.parse({ version: 1, phase: state.phase, status,
    elapsed_ms: elapsed(now, state.begun), phase_elapsed_ms: elapsed(now, state.phaseAt),
    ...(status === "failed" ? { error_code: "startup_stage_failed" } : {}),
    ...(nativeCode ? { native_failure_code: nativeCode } : {}) }));
}
export function recordWindowsStartupPhase(next: WindowsStartupPhase): void {
  const state = current.getStore(); if (!state || state.ended) return;
  const checked = phase.parse(next);
  emit(state, "completed"); state.phase = checked; state.phaseAt = performance.now(); emit(state, "entered");
}
export function recordWindowsStartupFailure(cause?: unknown): void {
  const state = current.getStore(); if (!state || state.ended) return;
  state.ended = true; emit(state, "failed", cause);
}
export function completeWindowsStartupDiagnostics(): void {
  const state = current.getStore(); if (!state || state.ended) return;
  state.ended = true; emit(state, "completed");
}
/** Diagnostic scope only; it cannot complete readiness or create any execution authority. */
export async function withWindowsStartupDiagnostics<T>(sink: (value: WindowsStartupDiagnostic) => void, work: () => Promise<T>): Promise<T> {
  const now = performance.now(), state: DiagnosticState = { emit: sink, begun: now, phaseAt: now, phase: "daemon_start", ended: false, count: 0 };
  return current.run(state, async () => {
    emit(state, "entered");
    try { return await work(); }
    catch (error) { recordWindowsStartupFailure(error); throw error; }
    finally { state.ended = true; }
  });
}
