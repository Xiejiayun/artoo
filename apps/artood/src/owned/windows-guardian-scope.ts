import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical, RecoveryOperationRefV1Schema, type RecoveryOperationRefV1 } from "@artoo/domain";
import { auditWindowsGuardianRuntime, readWindowsGuardianLocalRuntime, reserveWindowsGuardianSlot, windowsGuardianForBackend,
  hasPreparedWindowsGuardian, type PreparedWindowsGuardian } from "./windows-runtime-guardian.js";
import { startWindowsOwnedProcess, type PreparedWindowsProcessBackend, type WindowsOwnedStart, type WindowsOwnedProcess } from "./windows-owned-process.js";

export interface WindowsGuardianOperation {
  readonly guardian: PreparedWindowsGuardian; readonly backend: PreparedWindowsProcessBackend;
  readonly workspaceRoot: string;
  readonly operationId: string; readonly bindingDigest: string; readonly serverOperation: RecoveryOperationRefV1 | null;
}
const operations = new AsyncLocalStorage<WindowsGuardianOperation>();
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
/** The daemon's original host owns the complete non-breakaway Job subtree. A fixed
 * verifier's nested browser hosts remain descendants of that same Job; they neither
 * inherit a guardian token nor manufacture independent slots. Existing registered
 * slots still require their own actual HANDLE waits, EOF and native ACK. */
export const WINDOWS_GUARDIAN_JOB_BOUNDARY = "atomic-job-subtree.v1" as const;

/** Established by the authenticated local controller around its exact invocation. Scope
 * is not read from task text, process environment, argv or adapter output. */
export function withWindowsGuardianOperation<T>(guardian: PreparedWindowsGuardian, descriptor: {
  operationId: string; bindingDigest: string; serverOperation: RecoveryOperationRefV1 | null;
}, work: () => T): T {
  const saved = readWindowsGuardianLocalRuntime(guardian);
  if (saved.mode !== "active" || !descriptor.operationId || descriptor.operationId.length > 128
    || !/^sha256:[a-f0-9]{64}$/.test(descriptor.bindingDigest)) throw new Error("Guardian operation requires a current registered epoch and exact binding");
  const prior = operations.getStore();
  if (prior && prior.guardian !== guardian) throw new Error("An active guardian operation cannot switch its workspace owner");
  const serverOperation = descriptor.serverOperation === null ? null : Object.freeze(RecoveryOperationRefV1Schema.parse(descriptor.serverOperation));
  const operation = Object.freeze({ guardian, backend: saved.backend, workspaceRoot: saved.local.workspaceRoot, operationId: descriptor.operationId,
    bindingDigest: descriptor.bindingDigest, serverOperation });
  return operations.run(operation, () => { auditWindowsGuardianRuntime(guardian); return work(); });
}

/** Used by fixed collectors and nested tools. Unbound manual backends retain their
 * ordinary path; a guardian-bound backend can never fall back when scope is missing. */
export function readWindowsGuardianOperation(backend?: PreparedWindowsProcessBackend): WindowsGuardianOperation | undefined {
  const current = operations.getStore(), bound = backend ? windowsGuardianForBackend(backend) : undefined;
  if (!backend && !current && hasPreparedWindowsGuardian()) throw new Error("Prepared guardian collector requires an explicit local operation scope");
  if (backend && bound && (!current || current.guardian !== bound || current.backend !== backend))
    throw new Error("Guardian-bound execution lacks its original authenticated operation scope");
  if (current && backend && backend !== current.backend) throw new Error("An active guardian operation cannot switch its prepared native backend");
  if (current && (!backend || backend === current.backend)) {
    const saved = readWindowsGuardianLocalRuntime(current.guardian);
    if (saved.mode !== "active" || saved.backend !== current.backend) throw new Error("Guardian operation epoch is no longer active");
    return current;
  }
  return undefined;
}

/** HTTP callbacks are not assumed to inherit the caller's async context. Capture the
 * original local scope while creating the broker and restore it for every request. */
export function bindWindowsGuardianCallback<Args extends unknown[], Result>(work: (...args: Args) => Result): (...args: Args) => Result {
  const original = readWindowsGuardianOperation();
  if (!original) return work;
  return (...args: Args) => operations.run(original, () => { readWindowsGuardianOperation(original.backend); return work(...args); });
}

/** Prepare each target's one-use native slot before starting the unchanged synchronous
 * process bridge. The binding includes both the original operation and exact local argv. */
export async function startWindowsScopedProcess(backend: PreparedWindowsProcessBackend, input: WindowsOwnedStart,
  kind: "author" | "verifier" | "browser" | "git" | "tool"): Promise<WindowsOwnedProcess> {
  const operation = readWindowsGuardianOperation(backend);
  if (!operation) return startWindowsOwnedProcess(backend, input);
  if (input.guardianSlot !== undefined) throw new Error("Scoped process cannot replace its original slot");
  const launch: WindowsOwnedStart = Object.freeze({ ...input, args: Object.freeze([...input.args]), env: Object.freeze({ ...input.env }) });
  const slot = await reserveWindowsGuardianSlot(operation.guardian, { operationKind: kind, operationId: operation.operationId,
    bindingDigest: digest({ boundary: WINDOWS_GUARDIAN_JOB_BOUNDARY, operation: operation.bindingDigest, kind, executable: launch.executable, args: launch.args,
      cwd: launch.cwd, env: launch.env, timeoutMs: launch.timeoutMs, maxOutputBytes: launch.maxOutputBytes,
      cleanupTimeoutMs: launch.cleanupTimeoutMs, normalExitPolicy: launch.normalExitPolicy, normalExitGraceMs: launch.normalExitGraceMs }),
    serverOperation: operation.serverOperation });
  launch.signal?.throwIfAborted(); return startWindowsOwnedProcess(backend, { ...launch, guardianSlot: slot });
}
