import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isPromise } from "node:util/types";
import { z } from "zod";
import { WINDOWS_NATIVE_FAILURE_CODES, readWindowsNativeFailure, WindowsNativeFailureDetailV1Schema } from "./owned/windows-process-diagnostic.js";
import { readWindowsStorageFailure, WindowsStorageFailureSchema } from "./windows-storage-diagnostic.js";

const families = ["operation", "review", "design", "design-review", "execution", "execution-review", "execution-repair", "validation", "validation-review"] as const;
const controls = ["", ".stop", ".status", ".receipt"] as const;
const commandTypes = families.flatMap(family => controls.map(control => `product.source.${family}${control}.v1`));
const commandType = z.enum(commandTypes as [string, ...string[]]);
const phase = z.enum(["dispatch", "dispatch_admission", "handler", "dispatch_scope", "session", "recovery", "runtime", "request",
  "prior_result", "result_binding", "adapter", "reservation", "acknowledgement", "before_verification", "reviewer",
  "after_verification", "persist_result", "emit_result"]);
export type SourceCommandPhase = z.infer<typeof phase>;
export const SOURCE_COMMAND_DIAGNOSTIC_LIMITS = Object.freeze({ normalEvents: 2048, failureEvents: 64,
  normalEventsPerCommand: 64, retainedCommandDigests: 2048 });
export const SourceCommandDiagnosticSchema = z.object({ version: z.literal(1), command_type: commandType,
  command_id_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), phase, status: z.enum(["entered", "completed", "failed"]),
  elapsed_ms: z.number().int().min(0).max(86_400_000), phase_elapsed_ms: z.number().int().min(0).max(86_400_000),
  error_code: z.literal("source_command_stage_failed").optional(),
  native_failure_code: z.enum(WINDOWS_NATIVE_FAILURE_CODES).optional(),
  native_failure_detail: WindowsNativeFailureDetailV1Schema.optional(), storage_failure: WindowsStorageFailureSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.status === "failed") !== (value.error_code !== undefined)
    || value.status !== "failed" && (value.native_failure_code !== undefined || value.native_failure_detail !== undefined || value.storage_failure !== undefined)
    || value.native_failure_detail !== undefined && value.native_failure_code === undefined)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid source command diagnostic classification" });
});
export type SourceCommandDiagnostic = z.infer<typeof SourceCommandDiagnosticSchema>;
type Identity = Pick<SourceCommandDiagnostic, "command_type" | "command_id_digest">;
interface Budget {
  sink(value: SourceCommandDiagnostic): unknown;
  normal: number; failures: number; seen: Set<string>; failed: Set<string>;
}
interface CommandState { budget: Budget; identity: Identity; begun: number; regular: boolean; count: number; ended: boolean; failed: boolean }
interface PhaseState { command: CommandState; phase: SourceCommandPhase; begun: number }
const current = new AsyncLocalStorage<PhaseState>();
const elapsed = (now: number, begun: number) => Math.min(86_400_000, Math.max(0, Math.floor(now - begun)));

function identity(command: { type: string; id: string }): Identity | undefined {
  // Diagnostics must not invoke accessors or prevent the real dispatcher rejecting malformed input.
  try {
    const type = Object.getOwnPropertyDescriptor(command, "type"), id = Object.getOwnPropertyDescriptor(command, "id");
    if (!type || !Object.hasOwn(type, "value") || !commandTypes.includes(type.value)
      || !id || !Object.hasOwn(id, "value") || typeof id.value !== "string" || id.value.length === 0 || id.value.length > 128) return;
    return { command_type: type.value, command_id_digest: `sha256:${createHash("sha256").update(id.value).digest("hex")}` };
  } catch { return; }
}

function emit(scope: PhaseState, status: SourceCommandDiagnostic["status"], cause?: unknown): void {
  const command = scope.command, budget = command.budget;
  if (command.ended || command.failed) return;
  if (status === "failed") {
    command.failed = true;
    const key = `${command.identity.command_type}:${command.identity.command_id_digest}`;
    if (budget.failed.has(key) || budget.failures >= SOURCE_COMMAND_DIAGNOSTIC_LIMITS.failureEvents) return;
    budget.failed.add(key); budget.failures++;
  } else {
    if (!command.regular || budget.normal >= SOURCE_COMMAND_DIAGNOSTIC_LIMITS.normalEvents
      || command.count >= SOURCE_COMMAND_DIAGNOSTIC_LIMITS.normalEventsPerCommand) return;
    budget.normal++; command.count++;
  }
  try {
    const now = performance.now(), native = status === "failed" ? readWindowsNativeFailure(cause) : undefined;
    const storage = status === "failed" ? readWindowsStorageFailure(cause) : undefined;
    // Never project error text, copied error properties, payloads, argv, paths or environment.
    const value = SourceCommandDiagnosticSchema.parse({ version: 1, ...command.identity, phase: scope.phase, status,
      elapsed_ms: elapsed(now, command.begun), phase_elapsed_ms: elapsed(now, scope.begun),
      ...(status === "failed" ? { error_code: "source_command_stage_failed" } : {}),
      ...(native ? { native_failure_code: native.code, ...(native.detail ? { native_failure_detail: native.detail } : {}) } : {}),
      ...(storage ? { storage_failure: storage } : {}) });
    // Sink failures cannot replace an outcome; an asynchronous sink is never awaited.
    void Promise.resolve(budget.sink(Object.freeze(value))).catch(() => {});
  } catch { /* Optional diagnostics never replace the original result or rejection. */ }
}

/** Local observation only. No command validation, admission, deduplication or execution authority is supplied. */
export function createSourceCommandDiagnostics(sink: (value: SourceCommandDiagnostic) => unknown) {
  const budget: Budget = { sink, normal: 0, failures: 0, seen: new Set(), failed: new Set() };
  return {
    async run<T>(command: { type: string; id: string }, work: () => T | Promise<T>): Promise<T> {
      const saved = identity(command);
      // Reentrant manual/unsupported commands must not inherit another command's diagnostic scope.
      if (!saved) return current.exit(work);
      // Start and receipt intentionally share an ID but have distinct diagnostic lifetimes.
      const key = `${saved.command_type}:${saved.command_id_digest}`;
      const regular = !budget.seen.has(key) && budget.seen.size < SOURCE_COMMAND_DIAGNOSTIC_LIMITS.retainedCommandDigests
        && budget.normal < SOURCE_COMMAND_DIAGNOSTIC_LIMITS.normalEvents;
      if (regular) budget.seen.add(key);
      const now = performance.now(), state: CommandState = { budget, identity: saved, begun: now, regular, count: 0, ended: false, failed: false };
      const scope: PhaseState = { command: state, phase: "dispatch", begun: now };
      return current.run(scope, async () => {
        emit(scope, "entered");
        try { const result = await work(); emit(scope, "completed"); return result; }
        catch (error) { emit(scope, "failed", error); throw error; }
        finally { state.ended = true; }
      });
    },
  };
}

/** Advance a synchronous controller's phase without introducing an await or another work invocation. */
export function recordSourceCommandPhase(next: SourceCommandPhase): void {
  const scope = current.getStore(); if (!scope || scope.command.ended || scope.command.failed) return;
  const checked = phase.safeParse(next); if (!checked.success || checked.data === scope.phase) return;
  emit(scope, "completed"); scope.phase = checked.data; scope.begun = performance.now(); emit(scope, "entered");
}

/** Record the first failure before cleanup can block; the caller retains responsibility for handling/throwing it. */
export function recordSourceCommandFailure(cause?: unknown): void {
  const scope = current.getStore(); if (scope) emit(scope, "failed", cause);
}

/** Observe a nested phase while preserving synchronous return/throw and the original async outcome. */
export function observeSourceCommandPhase<T>(next: SourceCommandPhase, work: () => T): T {
  const parent = current.getStore(), checked = phase.safeParse(next);
  if (!parent || parent.command.ended || parent.command.failed || !checked.success) return work();
  const scope: PhaseState = { command: parent.command, phase: checked.data, begun: performance.now() };
  return current.run(scope, () => {
    emit(scope, "entered");
    try {
      const result = work();
      // Only real promises are observed; arbitrary returned objects/accessors are not inspected.
      if (isPromise(result)) return result.then(value => { emit(scope, "completed"); return value; },
        error => { emit(scope, "failed", error); throw error; }) as T;
      emit(scope, "completed"); return result;
    } catch (error) { emit(scope, "failed", error); throw error; }
  });
}
