import { readWindowsGuardianOperation, startWindowsScopedProcess } from "./owned/windows-guardian-scope.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { dirname, basename, resolve, join, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";

import type { ArtifactPayload, ArtifactType, RunStartPayload } from "@artoo/domain";
import type {
  AgentInstanceConfig,
  AgentInstanceHandle,
  ArtifactDescriptor,
  RunEvent,
  RuntimeAdapter,
  StopReason
} from "@artoo/protocol";
import { assertWorkspaceScope } from "@artoo/protocol";
import { resolveCliCommand } from "./cli-resolver.js";
import { createStructuredOutput, type ProcessOutputFormat } from "./structured-output.js";
import { createResearchSession, prepareResearchOptions, type ResearchOptions, type ResearchSession } from "./research.js";
import { initializeEmptyProductRepository } from "./product-bootstrap.js";
import { resolveProductBootstrapGit, type PreparedProductBootstrapGit } from "./product-bootstrap-git.js";
import { validateProductStage } from "./product-stage.js";
import { createWorkspaceToolSession, takeWorkspaceToolVerifier, takeWorkspaceToolEvidenceReader,
  takeWorkspaceToolCapabilities, assertWorkspaceToolCapabilities, takeWorkspaceToolReleaseCapabilities, type WorkspaceToolSession } from "./workspace-tools.js";
import { assertReleaseCapabilityContext } from "./release-capability-authority.js";
import { assertWorkspacePlanningBinding, takeWorkspaceReadOnlyTools, type WorkspaceReadOnlyGrant } from "./workspace-readonly.js";
import { VerificationCleanupError, readWindowsVerificationBackend, type PreparedVerificationProfile } from "./verification.js";
import { startWindowsOwnedProcess, isWindowsOwnedClosureReceipt, type PreparedWindowsProcessBackend,
  type WindowsOwnedProcess, type WindowsOwnedClosureReceipt } from "./owned/windows-owned-process.js";
import { withWindowsProcessErrorDiagnostic } from "./owned/windows-process-diagnostic.js";
import { assertOwnedContextForLaunch, assertOwnedContextLocalBoundary, writeOwnedContextFile } from "./owned/owned-context.js";
import { assertOwnedMaterializedWorktree, assertOwnedWorktreeLocalBoundary, WorktreeReservationError, type MaterializedWorktree } from "./owned/worktree-reservation.js";
import { OwnedGitError } from "./owned/owned-git.js";
import { allocationStartBinding } from "./node-allocation-identity.js";
import { ownedVerificationDigest } from "./owned/worktree-verification-contract.js";
import type { OwnedAdmissionIdentity, OwnedPhysicalFacts, OwnedRunAdmission, OwnedRunRuntimeAdapter, OwnedRunStatusReceipt, OwnedStartupReceipt, OwnedStopReceipt } from "./process-adapter-owned-receipts.js";
export type { OwnedAdmissionIdentity, OwnedPhysicalFacts, OwnedRunAdmission, OwnedRunRuntimeAdapter, OwnedRunStatusReceipt, OwnedStartupReceipt, OwnedStopReceipt } from "./process-adapter-owned-receipts.js";

interface AdmissionState { identity: Readonly<OwnedAdmissionIdentity>; claimed: boolean }
interface ReceiptScope { admission: WeakRef<OwnedRunAdmission>; worktree: WeakRef<MaterializedWorktree>; handle?: WeakRef<AgentInstanceHandle> }
interface StartupAuthentication extends ReceiptScope { receipt: OwnedStartupReceipt }
interface PhysicalAuthentication extends ReceiptScope { receipt: OwnedStopReceipt | OwnedRunStatusReceipt }
interface OwnedControl {
  facts(): OwnedPhysicalFacts;
  confirmClosed(): Promise<OwnedPhysicalFacts>;
  stop(reason: StopReason): Promise<OwnedPhysicalFacts>;
  inspect(): Promise<"running" | "confirmed_closed" | "uncertain">;
}
interface OwnedInvocation extends ReceiptScope {
  owner: object;
  genuine: boolean;
  spawnAttempted: boolean;
  helperUncertain: boolean;
  resultResourcesClosed: boolean;
  control?: OwnedControl;
  closedFacts?: OwnedPhysicalFacts;
  queue?: AsyncEventQueue<RunEvent>;
  workspaceRoot: string;
  discussion: boolean;
  /** Original actual config snapshot, never a caller's later reconstruction. */
  startSnapshot?: RunStartPayload;
  renderedContext?: Readonly<{ digest: string; size: number }>;
  /** Actual adapter-selected terminal outcome, never an externally supplied event. */
  terminalPhase?: "completed" | "failed" | "cancelled";
}
const ownedAdmissions = new WeakMap<OwnedRunAdmission, AdmissionState>();
const ownedAdapters = new WeakMap<RuntimeAdapter, Readonly<Record<string, unknown>>>();
const ownedStartupErrors = new WeakMap<object, StartupAuthentication>();
const ownedStopReceipts = new WeakMap<object, PhysicalAuthentication>();
const ownedStatusReceipts = new WeakMap<object, PhysicalAuthentication>();
const ownedExecutions = new WeakMap<AgentInstanceHandle, OwnedInvocation>();
const weakKey = (value: unknown): value is object => (typeof value === "object" && value !== null) || typeof value === "function";

declare const windowsAdmissionBrand: unique symbol;
export interface WindowsVerifiedExecutionAdmission { readonly [windowsAdmissionBrand]: true }
interface WindowsVerifiedExecution {
  readonly adapter: RuntimeAdapter;
  readonly config: AgentInstanceConfig;
  readonly payload: RunStartPayload;
  readonly profile: PreparedVerificationProfile;
  readonly backend: PreparedWindowsProcessBackend;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  claimed: boolean;
  resourcesClosed: boolean;
  handle?: WeakRef<AgentInstanceHandle>;
  receipt?: WindowsOwnedClosureReceipt;
}
const windowsConfigs = new WeakMap<AgentInstanceConfig, WindowsVerifiedExecution>();
const windowsAdmissions = new WeakMap<WindowsVerifiedExecutionAdmission, WindowsVerifiedExecution>();
declare const windowsPlanningAdmissionBrand: unique symbol;
export interface WindowsPlanningExecutionAdmission { readonly [windowsPlanningAdmissionBrand]: true }
interface WindowsPlanningExecution extends WindowsVerifiedExecution {
  readonly planningGrant: WorkspaceReadOnlyGrant;
  /** True only before resource acquisition or after the actual startup cleanup completed. */
  startupClosed: boolean;
}
type WindowsNativeExecution = WindowsVerifiedExecution | WindowsPlanningExecution;
const windowsPlanningExecutions = new WeakSet<WindowsNativeExecution>();
const windowsPlanningConfigs = new WeakMap<AgentInstanceConfig, WindowsPlanningExecution>();
const windowsPlanningAdmissions = new WeakMap<WindowsPlanningExecutionAdmission, WindowsPlanningExecution>();
const windowsAdapters = new WeakMap<RuntimeAdapter, Readonly<Record<string, unknown>>>();
const readOnlyToolAdapters = new WeakMap<RuntimeAdapter, Readonly<Record<string, unknown>>>();
/** Local preset support only; public runtime metadata cannot enable the broker. */
export function supportsWorkspaceReadOnlyTools(adapter: RuntimeAdapter): boolean {
  const methods = readOnlyToolAdapters.get(adapter);
  return !!methods && Object.entries(methods).every(([name, method]) => Object.getOwnPropertyDescriptor(adapter, name)?.value === method);
}
function isWindowsVerifiedAdapter(adapter: RuntimeAdapter): boolean {
  const methods = windowsAdapters.get(adapter);
  return !!methods && Object.entries(methods).every(([name, method]) => Object.getOwnPropertyDescriptor(adapter, name)?.value === method);
}
function deeplyFrozenStart(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  const frozen = Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor && deeplyFrozenStart(descriptor.value, seen));
  seen.delete(value);
  return frozen;
}

/** Node-local authority after exact protected-profile selection, never a wire field. */
export function bindWindowsVerifiedExecution(adapter: RuntimeAdapter, config: AgentInstanceConfig,
  profile: PreparedVerificationProfile, signal: AbortSignal, assertCurrent: () => void): WindowsVerifiedExecutionAdmission {
  const backend = readWindowsVerificationBackend(profile);
  if (process.platform !== "win32" || !backend || !isWindowsVerifiedAdapter(adapter) || windowsConfigs.has(config) || windowsPlanningConfigs.has(config)
    || !Object.isFrozen(config) || !deeplyFrozenStart(config.runStart) || !config.runStart.verification
    || !(signal instanceof AbortSignal) || typeof assertCurrent !== "function") throw new Error("A fresh local Windows verified admission is required");
  const state: WindowsVerifiedExecution = { adapter, config, payload: config.runStart, profile, backend,
    signal, assertCurrent, claimed: false, resourcesClosed: false };
  assertWindowsExecutionIdentity(state, config);
  const admission = Object.freeze({}) as WindowsVerifiedExecutionAdmission;
  windowsConfigs.set(config, state); windowsAdmissions.set(admission, state);
  return admission;
}
function assertWindowsExecutionIdentity(state: WindowsVerifiedExecution, config: AgentInstanceConfig): void {
  state.signal.throwIfAborted();
  const current: unknown = state.assertCurrent();
  if (current !== undefined) {
    void Promise.resolve(current).catch(() => {});
    throw new Error("Windows execution admission must be checked synchronously");
  }
  const payload = state.payload;
  if (state.config !== config || state.payload !== config.runStart || !isWindowsVerifiedAdapter(state.adapter)
    || config.runId !== payload.run_id || config.taskId !== payload.task_id || config.agentInstanceId !== payload.agent_instance_id
    || config.runtime !== payload.runtime || config.runtime !== state.adapter.runtimeId || config.workspaceRoot !== payload.workspace.root
    || config.workspaceRoot !== state.profile.workspace_root || payload.workspace.branch != null || payload.workspace_allocation
    || payload.verification?.profile_id !== state.profile.id || payload.context_pack.payload?.project.id !== state.profile.project_id
    || readWindowsVerificationBackend(state.profile) !== state.backend) throw new Error("Windows verified admission identity changed");
}
function takeWindowsVerifiedExecution(adapter: RuntimeAdapter, config: AgentInstanceConfig): WindowsVerifiedExecution | undefined {
  if (process.platform !== "win32") return undefined;
  const state = windowsConfigs.get(config);
  if (!state) {
    if (config.runStart.verification) throw new Error("Windows verification requires the node's local execution admission");
    return undefined;
  }
  if (state.claimed || state.adapter !== adapter) throw new Error("Windows verified admission was already consumed or changed adapter");
  assertWindowsExecutionIdentity(state, config); state.claimed = true;
  return state;
}

/** Local native process ownership for context-only planning; this never grants verification or source export. */
export function bindWindowsPlanningExecution(adapter: RuntimeAdapter, config: AgentInstanceConfig,
  profile: PreparedVerificationProfile, signal: AbortSignal, assertCurrent: () => void): WindowsPlanningExecutionAdmission {
  const backend = readWindowsVerificationBackend(profile);
  if (process.platform !== "win32" || !backend || !isWindowsVerifiedAdapter(adapter) || !supportsWorkspaceReadOnlyTools(adapter)
    || windowsConfigs.has(config) || windowsPlanningConfigs.has(config) || !Object.isFrozen(config) || !deeplyFrozenStart(config.runStart)
    || !(signal instanceof AbortSignal) || typeof assertCurrent !== "function") throw new Error("A fresh local Windows planning admission is required");
  const planningGrant = assertWorkspacePlanningBinding(config);
  const state: WindowsPlanningExecution = { adapter, config, payload: config.runStart, profile, backend,
    signal, assertCurrent, planningGrant, claimed: false, resourcesClosed: false, startupClosed: true };
  assertWindowsPlanningIdentity(state, config);
  const admission = Object.freeze({}) as WindowsPlanningExecutionAdmission;
  windowsPlanningExecutions.add(state);
  windowsPlanningConfigs.set(config, state); windowsPlanningAdmissions.set(admission, state);
  return admission;
}
function assertWindowsPlanningIdentity(state: WindowsPlanningExecution, config: AgentInstanceConfig): void {
  state.signal.throwIfAborted();
  const current: unknown = state.assertCurrent();
  if (current !== undefined) {
    void Promise.resolve(current).catch(() => {});
    throw new Error("Windows planning admission must be checked synchronously");
  }
  const payload = state.payload, context = payload.context_pack.payload;
  if (state.config !== config || state.payload !== config.runStart || !isWindowsVerifiedAdapter(state.adapter)
    || !supportsWorkspaceReadOnlyTools(state.adapter) || config.runId !== payload.run_id || config.taskId !== payload.task_id
    || config.agentInstanceId !== payload.agent_instance_id || config.runtime !== payload.runtime || config.runtime !== state.adapter.runtimeId
    || config.workspaceRoot !== payload.workspace.root || config.workspaceRoot !== state.profile.workspace_root
    || context?.project.id !== state.profile.project_id || context.task.id !== payload.task_id || context.workspace.root !== payload.workspace.root
    || payload.verification !== undefined || readWindowsVerificationBackend(state.profile) !== state.backend) {
    throw new Error("Windows planning admission identity changed");
  }
  assertWorkspacePlanningBinding(config, state.planningGrant);
  // A guardian-bound backend cannot escape its current authenticated operation.
  readWindowsGuardianOperation(state.backend);
}
function isWindowsPlanningExecution(state: WindowsNativeExecution): state is WindowsPlanningExecution {
  return windowsPlanningExecutions.has(state);
}
function assertWindowsNativeExecutionIdentity(state: WindowsNativeExecution, config: AgentInstanceConfig): void {
  if (isWindowsPlanningExecution(state)) assertWindowsPlanningIdentity(state, config);
  else assertWindowsExecutionIdentity(state, config);
}
function takeWindowsPlanningExecution(adapter: RuntimeAdapter, config: AgentInstanceConfig): WindowsPlanningExecution | undefined {
  const state = windowsPlanningConfigs.get(config);
  if (!state) return undefined;
  if (process.platform !== "win32" || state.claimed || state.adapter !== adapter) throw new Error("Windows planning admission was already consumed or changed adapter");
  assertWindowsPlanningIdentity(state, config); state.claimed = true;
  return state;
}
export function assertWindowsPlanningExecutionClosed(admission: WindowsPlanningExecutionAdmission, handle: AgentInstanceHandle): void {
  const state = windowsPlanningAdmissions.get(admission);
  if (!state || state.handle?.deref() !== handle || handle.runId !== state.config.runId || !state.claimed || !state.resourcesClosed
    || !state.receipt || !isWindowsOwnedClosureReceipt(state.receipt) || !state.receipt.cleanupConfirmed) {
    throw new VerificationCleanupError("Windows planning execution closure remains unconfirmed");
  }
}
/** A rejected start may have no returned handle. Only the original adapter's resource closure can settle it. */
export function assertWindowsPlanningStartupClosed(admission: WindowsPlanningExecutionAdmission): void {
  const state = windowsPlanningAdmissions.get(admission);
  if (!state || !state.claimed || state.handle || !state.startupClosed) {
    throw new VerificationCleanupError("Windows planning startup closure remains unconfirmed");
  }
}
/** CLI closure and node-owned tool closure are both required before final verification. */
export function assertWindowsVerifiedExecutionClosed(admission: WindowsVerifiedExecutionAdmission, handle: AgentInstanceHandle): void {
  const state = windowsAdmissions.get(admission);
  if (!state || state.handle?.deref() !== handle || handle.runId !== state.config.runId || !state.claimed || !state.resourcesClosed
    || !state.receipt || !isWindowsOwnedClosureReceipt(state.receipt) || !state.receipt.cleanupConfirmed) {
    throw new VerificationCleanupError("Windows verified execution closure remains unconfirmed");
  }
}

/** Local export additionally binds closure to the exact original run and prepared profile. */
export function assertWindowsVerifiedExecutionExportBinding(admission: WindowsVerifiedExecutionAdmission, handle: AgentInstanceHandle,
  profile: PreparedVerificationProfile, payload: RunStartPayload): void {
  assertWindowsVerifiedExecutionClosed(admission, handle);
  const state = windowsAdmissions.get(admission)!;
  if (state.profile !== profile || state.payload !== payload) throw new Error("Source export differs from the actually closed author admission");
}

export function createOwnedRunAdmission(identity: OwnedAdmissionIdentity): OwnedRunAdmission {
  const value = Object.freeze({ launchKey: identity.launchKey, runId: identity.runId, taskId: identity.taskId,
    agentInstanceId: identity.agentInstanceId, runtime: identity.runtime, workspaceRoot: identity.workspaceRoot,
    workspaceBranch: identity.workspaceBranch });
  if (Object.values(value).some((item) => typeof item !== "string" || !item || item.includes("\0"))) throw new Error("A complete local owned admission identity is required");
  const admission = Object.freeze({}) as OwnedRunAdmission;
  ownedAdmissions.set(admission, { identity: value, claimed: false });
  return admission;
}

export function isOwnedRunAdapter(adapter: RuntimeAdapter): adapter is OwnedRunRuntimeAdapter {
  const methods = ownedAdapters.get(adapter);
  if (!methods) return false;
  // Do not invoke arbitrary getters while checking a capability boundary.
  return Object.entries(methods).every(([name, method]) => Object.getOwnPropertyDescriptor(adapter, name)?.value === method);
}

function matchesScope(scope: ReceiptScope, admission: OwnedRunAdmission, handle?: AgentInstanceHandle): boolean {
  return scope.admission.deref() === admission && ownedAdmissions.has(admission)
    && (handle === undefined || scope.handle?.deref() === handle);
}
export function getOwnedStartupReceipt(error: unknown, admission: OwnedRunAdmission, worktree: MaterializedWorktree): OwnedStartupReceipt | undefined {
  const value = weakKey(error) ? ownedStartupErrors.get(error) : undefined;
  return value && matchesScope(value, admission) && value.worktree.deref() === worktree ? value.receipt : undefined;
}
export function getOwnedStopReceipt(value: unknown, admission: OwnedRunAdmission, handle: AgentInstanceHandle): OwnedStopReceipt | undefined {
  const found = weakKey(value) ? ownedStopReceipts.get(value) : undefined;
  return found && matchesScope(found, admission, handle) ? found.receipt as OwnedStopReceipt : undefined;
}
export function getOwnedRunStatusReceipt(value: unknown, admission: OwnedRunAdmission, handle: AgentInstanceHandle): OwnedRunStatusReceipt | undefined {
  const found = weakKey(value) ? ownedStatusReceipts.get(value) : undefined;
  return found && matchesScope(found, admission, handle) ? found.receipt as OwnedRunStatusReceipt : undefined;
}

/** Local sealing boundary, not a serializable permission or a successful-run verdict. */
export function getOwnedWorkspaceClosure(value: unknown, admission: OwnedRunAdmission, handle: AgentInstanceHandle,
  worktree: MaterializedWorktree): Readonly<{ identity: Readonly<OwnedAdmissionIdentity>; receipt: OwnedStopReceipt | OwnedRunStatusReceipt }> | undefined {
  const found = weakKey(value) ? ownedStopReceipts.get(value) ?? ownedStatusReceipts.get(value) : undefined;
  const execution = ownedExecutions.get(handle), admitted = ownedAdmissions.get(admission);
  if (!found || !admitted || !matchesScope(found, admission, handle) || found.worktree.deref() !== worktree
    || found.receipt.kind !== "confirmed_closed" || !execution?.genuine || !matchesScope(execution, admission, handle)
    || execution.worktree.deref() !== worktree || execution.discussion || execution.helperUncertain
    || !execution.resultResourcesClosed || !execution.closedFacts?.childSpawned
    || admitted.identity.workspaceRoot !== worktree.root || admitted.identity.workspaceBranch !== worktree.branch) return undefined;
  // Physical CLI closure can precede tool closure. Only the close continuation
  // below can establish that no owned tool is still using the result workspace.
  try { assertOwnedWorktreeLocalBoundary(worktree); } catch { return undefined; }
  return Object.freeze({ identity: admitted.identity, receipt: found.receipt });
}

export interface OwnedSourceLaunchProofV1 {
  readonly version: 1;
  readonly launch_binding_digest: string;
  readonly author_context_digest: string;
  readonly context_pack_id: string;
  /** Initial context bytes checked immediately before actual process spawn.
   * This is not the ContextPack canonical digest or proof that the CLI read it. */
  readonly rendered_context: Readonly<{ digest: string; size: number }>;
}
function freezeOwnedStart<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeOwnedStart(child); Object.freeze(value); }
  return value;
}
/** Additional source provenance for the new projector. Older/manual captures
 * remain valid without it; copied snapshots and receipts cannot create it. */
export function getOwnedWorkspaceLaunchProof(value: unknown, admission: OwnedRunAdmission, handle: AgentInstanceHandle,
  worktree: MaterializedWorktree): OwnedSourceLaunchProofV1 | undefined {
  const closed = getOwnedWorkspaceClosure(value, admission, handle, worktree), invocation = ownedExecutions.get(handle);
  if (!closed || !invocation?.startSnapshot || !invocation.renderedContext) return undefined;
  try {
    // `true` selects the structural committed-allocation contract; this accessor
    // does not attest a transport connection or a server acknowledgement.
    const binding = allocationStartBinding(invocation.startSnapshot, process.platform, true);
    if (!binding || binding.key !== closed.identity.launchKey || !binding.payload.context_pack.payload
      || ownedVerificationDigest(binding.payload) !== ownedVerificationDigest(invocation.startSnapshot)) return undefined;
    return freezeOwnedStart({ version: 1 as const, launch_binding_digest: `sha256:${binding.key}`,
      author_context_digest: ownedVerificationDigest(binding.payload.context_pack.payload),
      context_pack_id: binding.payload.context_pack.id, rendered_context: { ...invocation.renderedContext } });
  } catch { return undefined; } // Unsupported legacy launch data grants no projection provenance.
}

/** Live author outcome, distinct from physical closure and command verification.
 * It is not reconstructed from serialized events or historical source receipts. */
export function getOwnedWorkspaceAuthorOutcome(value: unknown, admission: OwnedRunAdmission, handle: AgentInstanceHandle,
  worktree: MaterializedWorktree): Readonly<{ version: 1; phase: "completed" | "failed" | "cancelled" }> | undefined {
  if (!getOwnedWorkspaceClosure(value, admission, handle, worktree)) return undefined;
  const phase = ownedExecutions.get(handle)?.terminalPhase;
  return phase ? Object.freeze({ version: 1 as const, phase }) : undefined;
}

function confirmedHelperFailure(error: unknown, signal: AbortSignal): boolean {
  const seen = new Set<unknown>();
  for (let item = error; item && !seen.has(item);) {
    seen.add(item);
    if (item instanceof OwnedGitError) return item.receipt.cleanupConfirmed === true;
    if (signal.aborted && item === signal.reason) return true;
    if (!(item instanceof WorktreeReservationError)) return false;
    item = Object.getOwnPropertyDescriptor(item, "cause")?.value;
  }
  return false;
}

async function ownedPreparation<T>(invocation: OwnedInvocation | undefined, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  if (invocation) invocation.helperUncertain = true;
  try {
    const result = await operation();
    if (invocation) invocation.helperUncertain = false;
    return result;
  } catch (error) {
    if (invocation && signal) invocation.helperUncertain = !confirmedHelperFailure(error, signal);
    throw error;
  }
}

async function boundedOwnedWait(promise: Promise<unknown>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Owned physical closure remains uncertain")), Math.max(1, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}

/**
 * Process-based {@link RuntimeAdapter} (design §5.2 minimal model). Runs a CLI
 * coding agent (e.g. Codex) as a child process and maps its lifecycle to the
 * RunEvent contract:
 *
 *   spawn         -> run.lifecycle(started)
 *   stdout/stderr -> run.output (line-buffered)
 *   exit 0        -> collect artifacts -> artifact.created* -> run.lifecycle(completed)
 *   exit non-zero -> run.lifecycle(failed, reason)
 *
 * The workspace allowlist is enforced before spawn (design §4.7); an out-of-scope
 * workspace throws WorkspaceScopeError and the run never starts. Task #7 only
 * supplies this real adapter; the node-side loop and contract come from #6's
 * createNodeClient, unchanged.
 */
export interface ArtifactSpec {
  type: ArtifactType;
  /** Path relative to the workspace root. */
  path: string;
}

export interface ProcessAdapterOptions {
  runtimeId?: string;
  /** argv template; supports {{workspace_root}} and {{context_pack_path}}. */
  command: string[];
  /** Explicit operator-configured read-only command for discussion sessions. */
  discussionCommand?: string[];
  /** Local preset for verified product authors; requires a node-owned tool binding. */
  productCommand?: string[];
  /** Read-only peer command with a node-granted evidence bridge; planning remains unchanged. */
  reviewCommand?: string[];
  /** Selected only when the node installed an exact one-use read-only broker grant. */
  readOnlyCommand?: string[];
  /** Workspace allowlist enforced before spawn. */
  allowedRoots: string[];
  /** Artifacts collected from the workspace after the run completes. */
  artifacts?: ArtifactSpec[];
  contextPackFilename?: string;
  /** Recognized CLI JSONL output; overrides/fixtures default to plain logs. */
  outputFormat?: ProcessOutputFormat;
  /** Administrator opt-in only; requests cannot enable network tools or bootstrap. */
  research?: ResearchOptions;
  initializeRepository?: boolean;
  /** Prepared node-local executable choice; never populated by run.start. */
  productBootstrapGit?: PreparedProductBootstrapGit;
}

interface RunState {
  queue: AsyncEventQueue<RunEvent>;
  kill: () => Promise<void>;
  workspaceRoot: string;
  discussion: boolean;
  stopReason?: StopReason;
}

/** Resolve existing ancestors so symlinks/junctions cannot bypass root policy. */
export function assertRealWorkspaceScope(target: string, allowedRoots: readonly string[]): void {
  const canonical = (path: string): string => {
    // Keep the original spelling until the OS resolves existing symlinks and
    // '..'. Lexically normalizing first can authorize a different directory.
    let existing = path;
    const suffix: string[] = [];
    while (true) {
      try { lstatSync(existing); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(existing), component = basename(existing);
        // A missing ancestor followed by '..' has no current OS resolution.
        if (parent === existing || component === "..") throw error;
        suffix.unshift(component);
        existing = parent;
      }
    }
    // lstat recognizes dangling links. Resolve outside the ENOENT fallback so
    // they fail closed instead of being mistaken for ordinary missing names.
    return resolve(realpathSync.native(existing), ...suffix);
  };
  assertWorkspaceScope(canonical(target), allowedRoots.map(canonical));
}

async function stopProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolveStop, rejectStop) => {
      const killer = spawn(resolve(process.env.SystemRoot ?? "C:/Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      let output = "";
      killer.stderr?.on("data", (data: Buffer) => { output += data.toString(); });
      killer.once("error", rejectStop);
      killer.once("close", (code) => {
        // 128 means the requested root PID already exited. Windows descendant
        // containment remains taskkill-based; POSIX uses an owned group below.
        if (code === 0 || code === 128) resolveStop();
        else rejectStop(new Error(`could not stop process tree (${code}): ${output}`));
      });
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(-pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        // macOS can briefly report EPERM while killed members are being
        // reaped. Retry the observation, never count EPERM as a stopped group.
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      await new Promise((resolveStop) => setTimeout(resolveStop, 20));
    }
    throw new Error("CLI process group did not exit after termination");
  }
}

// A small independent Node process owns a pipe from the daemon. If the daemon
// crashes (including an Electron worker kill), pipe EOF kills the CLI's process
// tree. POSIX cleanup disarms it only after the owned group is gone. No task
// content becomes executable, and detached/setsid escape is not containment.
const PROCESS_GUARDIAN = `
const {spawn}=require('node:child_process');
const pid=Number(process.argv[1]);
let disarmed=false;
process.stdin.on('data',()=>{disarmed=true;});
process.stdin.on('end',async()=>{
  if(disarmed) return;
  if(process.platform==='win32') spawn(require('node:path').resolve(process.env.SystemRoot||'C:/Windows','System32','taskkill.exe'),['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  else {
    try {
      process.kill(-pid,'SIGKILL');
      const deadline=Date.now()+5000;
      while(Date.now()<deadline) {
        try { process.kill(-pid,0); } catch(error) { if(error.code!=='EPERM') throw error; }
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      process.exitCode=1;
    } catch(error) { if(error.code!=='ESRCH') process.exitCode=1; }
  }
});
process.stdin.resume();
`;

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;
  private failure?: Error;

  push(item: T): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter({ value: undefined as never, done: true });
      waiter = this.waiters.shift();
    }
  }

  fail(error: Error): void {
    this.failure = error;
    this.end();
  }

  async *drain(): AsyncIterable<T> {
    while (true) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield result.value;
    }
  }
}

function makeLineEmitter(onLine: (text: string) => void): {
  feed(chunk: Buffer | string): void;
  flush(): void;
} {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return {
    feed(chunk): void {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        onLine(buffer.slice(0, index).replace(/\r$/, ""));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    flush(): void {
      buffer += decoder.end();
      if (buffer.length > 0) {
        onLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
    }
  };
}

function importedValidationInstructions(config: AgentInstanceConfig): string[] {
  const context = config.runStart.context_pack.payload;
  if (context?.imported_clean_validation) return ["", "## Product validation after a clean node restart",
    "The current restart checkpoint contains unverified workspace bytes. Complete a fresh validation attempt against the original goal, accepted research/design, and every declared acceptance case and viewport.",
    "Use the protected workspace verification tool. Preserve the accepted research/design. Repair product defects and obtain a new complete final verification; a prior run or checkpoint does not prove this product passed."];
  if (context?.imported_clean_validation_review_subject) return ["", "## Independent product review after a clean node restart",
    "Review the entire current product against the original goal and accepted inputs using the pinned source and measured evidence. You have read-only tools.",
    "Return the required JSON verdict with review_id, validation_id, source_digest and subject_digest from imported_clean_validation_review_subject. Report every blocking finding and reject when one remains."];
  if (context?.imported_recovery_validation) return ["", "## Product validation after interrupted execution",
    "The current recovery checkpoint records unverified workspace bytes. Complete a new validation attempt against the original goal, accepted research/design, and every declared acceptance case and viewport.",
    "Inspect the current product and any supplied predecessor findings. You may repair product files, implementation notes, and the validation report. Preserve the exact accepted research.json and design.json bytes and protected measurement configuration.",
    "Run the node-owned verification tool and write a truthful .artoo/product/validation.json. Only the new final verifier and a new independent product review can establish completion; an earlier run result or checkpoint is not a passing result."];
  if (context?.imported_recovery_validation_review_subject) return ["", "## Independent product review after recovery",
    "Review the complete current product against the original goal, accepted plan, every acceptance criterion, complete new browser evidence, regression risks, and the validation report's accuracy.",
    "Use the workspace evidence index. The retained baseline files describe the actual workspace before this new validation author. Compare that baseline with current product source and the complete new final measurements.",
    "Return the required JSON verdict with review_id, validation_id, source_digest and subject_digest from imported_recovery_validation_review_subject. Report every blocking finding and reject when one remains. The checkpoint and prior interrupted run provide history, not proof that this product passed."];
  if (context?.imported_validation) return ["", "## Imported product validation",
    "Validate the complete final product against the original goal, accepted research/design, and every declared acceptance case and viewport.",
    "You may repair product files, implementation notes, and the validation report. Preserve the exact accepted research.json and design.json bytes, requirements, measurement programs, and protected configuration.",
    "Use the supplied prior review findings or typed failure feedback to guide repairs, and run the node-owned verification tool before completing. The independent final verifier and full product review decide completion.",
    "Write a truthful .artoo/product/validation.json that describes the actual final product and outcomes. A report alone does not establish a passing product."];
  if (context?.imported_validation_review_subject) return ["", "## Independent final product review",
    "Review the complete final product, original goal and accepted plan, all acceptance criteria, measured behavior, regression risks, and validation report truthfulness.",
    "Use the workspace evidence index. baseline.directories and baseline.files[].reference expose retained actual files from before the validation author; read those references to assess changes alongside current product source and complete final browser evidence.",
    "Reviewing only validation.json is insufficient. Read-only tools cannot change the product. Return the required JSON verdict with validation_id, source_digest and subject_digest from imported_validation_review_subject; reject when any blocking finding remains."];
  return [];
}
function renderContextPack(config: AgentInstanceConfig): string {
  const pack = config.runStart.context_pack;
  const lines: string[] = [
    `# Context Pack ${pack.id}`,
    `task: ${config.taskId}`,
    `run: ${config.runId}`,
  ];
  if (pack.uri) {
    lines.push(`uri: ${pack.uri}`);
  }
  if (pack.payload) {
    lines.push(
      "",
      "## Task",
      `id: ${pack.payload.task.id}`,
      `title: ${pack.payload.task.title}`,
      `description: ${pack.payload.task.description}`,
      "acceptance_criteria:",
      ...pack.payload.task.acceptance_criteria.map((criterion) => `- ${criterion}`),
      "",
      "## Project",
      `id: ${pack.payload.project.id}`,
      `name: ${pack.payload.project.name}`,
      `default_workspace: ${pack.payload.project.default_workspace ?? ""}`,
      "",
      "## Workspace",
      `root: ${pack.payload.workspace.root}`,
      "file_scope:",
      ...pack.payload.workspace.file_scope.map((scope) => `- ${scope}`),
      "",
      "## Policy",
      "filesystem_write_scope:",
      ...pack.payload.policy.filesystem_write_scope.map((scope) => `- ${scope}`),
      "requires_approval:",
      ...pack.payload.policy.requires_approval.map((approval) => `- ${approval}`),
      "",
      "## Memory",
      `task_summary: ${pack.payload.memory.task_summary ?? ""}`,
      "project_notes:",
      ...pack.payload.memory.project_notes.map((note) => `- ${note}`),
      "",
      "## Expected Artifacts",
      ...pack.payload.artifacts.expected.map((artifact) => `- ${artifact}`),
      "",
      "## Raw Payload",
      JSON.stringify(pack.payload, null, 2)
    );
  }
  lines.push(...importedValidationInstructions(config));
  return `${lines.join("\n")}\n`;
}

/** MCP pages carry every payload field once; legacy context files keep their original rendering. */
function renderWorkspaceToolContext(config: AgentInstanceConfig): string {
  const pack = config.runStart.context_pack;
  const lines = [`# Context Pack ${pack.id}`, `task: ${config.taskId}`, `run: ${config.runId}`];
  if (pack.uri) lines.push(`uri: ${pack.uri}`);
  if (pack.payload) lines.push("", "## Raw Payload", JSON.stringify(pack.payload));
  lines.push(...importedValidationInstructions(config));
  return `${lines.join("\n")}\n`;
}

/** Local execution seam; the materialized handle is never a wire field. */
export interface OwnedWorktreeRuntimeAdapter extends RuntimeAdapter {
  /** Startup signal only. Use the same controller in helper preparation for prompt Git cancellation. */
  startOwnedWorktree(config: AgentInstanceConfig, worktree: MaterializedWorktree, startupSignal?: AbortSignal): Promise<AgentInstanceHandle>;
}

export function createProcessAdapter(options: ProcessAdapterOptions): OwnedWorktreeRuntimeAdapter & OwnedRunRuntimeAdapter {
  const runtimeId = options.runtimeId ?? "process";
  const contextPackFilename = options.contextPackFilename ?? "context_pack.md";
  const artifactSpecs = options.artifacts ?? [];
  const runs = new Map<string, RunState>();
  const researchOptions = options.research ? prepareResearchOptions(options.research, options.allowedRoots) : undefined;
  const completedArtifacts = new Map<string, ArtifactDescriptor[]>();
  const ownedOwner = Object.freeze({});

  function workspacePath(workspaceRoot: string, relativePath: string): string {
    // Resolve the existing root before joining: its raw symlink/.. spelling
    // must designate the same directory for context files and the child cwd.
    const physicalRoot = realpathSync.native(workspaceRoot);
    const absolute = resolve(physicalRoot, relativePath);
    assertWorkspaceScope(absolute, [physicalRoot]);
    assertRealWorkspaceScope(absolute, [physicalRoot]);
    return absolute;
  }

  function artifactPaths(workspaceRoot: string): Array<ArtifactSpec & { absolute: string }> {
    return artifactSpecs.map((spec) => ({ ...spec, absolute: workspacePath(workspaceRoot, spec.path) }));
  }

  function collectDescriptors(workspaceRoot: string): ArtifactDescriptor[] {
    const descriptors: ArtifactDescriptor[] = [];
    for (const spec of artifactPaths(workspaceRoot)) {
      const absolute = spec.absolute;
      if (!existsSync(absolute)) {
        continue;
      }
      const content = readFileSync(absolute);
      const payload: ArtifactPayload = {
        type: spec.type,
        uri: pathToFileURL(absolute).href,
        metadata: { path: spec.path },
        checksum: `sha256:${createHash("sha256").update(content).digest("hex")}`
      };
      descriptors.push({ payload, localPath: absolute });
    }
    return descriptors;
  }

  interface ExternalDiscussionContext { path: string; directory: string; cleanupAllowed: boolean }
  function cleanupDiscussionContext(context: ExternalDiscussionContext): void {
    if (context.cleanupAllowed) rmSync(context.directory, { recursive: true, force: true });
  }
  async function startProcess(config: AgentInstanceConfig, worktree?: MaterializedWorktree, startupSignal?: AbortSignal, invocation?: OwnedInvocation,
    externalDiscussion?: ExternalDiscussionContext, windowsExecution?: WindowsNativeExecution): Promise<AgentInstanceHandle> {
      const workspaceRoot = config.workspaceRoot, runId = config.runId;
      const guardianOperation = readWindowsGuardianOperation();
      if (guardianOperation && !windowsExecution) throw new Error("Guardian workspace execution requires its locally bound native profile");
      if (config.runStart.context_pack.payload?.imported_clean_validation || config.runStart.context_pack.payload?.imported_clean_validation_review_subject) {
        if (!windowsExecution) throw new Error("Clean validation requires its original native execution admission");
        const { assertWindowsCleanExecutionConfiguration } = await import("./windows-clean-validation-runtime.js");
        assertWindowsCleanExecutionConfiguration(config, windowsExecution.backend);
      }
      if (config.runStart.context_pack.payload?.imported_recovery_validation || config.runStart.context_pack.payload?.imported_recovery_validation_review_subject)
        {
        if (!windowsExecution) throw new Error("Recovery requires its original Windows execution admission");
        const { assertWindowsRecoveryExecutionConfiguration } = await import("./windows-source-recovery.js");
        assertWindowsRecoveryExecutionConfiguration(config, windowsExecution.backend);
      }
      if (worktree) {
        if (config.workspaceRoot !== worktree.root || config.runStart.workspace.root !== worktree.root
          || config.runStart.workspace.branch !== worktree.branch || config.runId !== config.runStart.run_id
          || config.taskId !== config.runStart.task_id || config.agentInstanceId !== config.runStart.agent_instance_id
          || config.runtime !== config.runStart.runtime) throw new Error("Owned worktree start identity differs");
      }
      // Enforce the workspace allowlist before context writes or process launch.
      assertWorkspaceScope(config.workspaceRoot, options.allowedRoots);
      assertRealWorkspaceScope(config.workspaceRoot, options.allowedRoots);

      const discussion = config.runStart.context_pack.payload?.policy.execution_mode === "discussion";
      const productTools = !discussion && !!config.runStart.context_pack.payload?.product_development && !!options.productCommand;
      const readEvidence = takeWorkspaceToolEvidenceReader(config);
      const readCapabilities = takeWorkspaceToolCapabilities(config);
      assertWorkspaceToolCapabilities(config.runStart.context_pack.payload, readCapabilities);
      const readReleaseCapabilities = takeWorkspaceToolReleaseCapabilities(config);
      assertReleaseCapabilityContext(config.runStart.context_pack.payload, readReleaseCapabilities);
      const reviewTools = discussion && !!config.runStart.context_pack.payload?.review_subject && !!readEvidence && !!options.reviewCommand;
      const readOnlyGrant = takeWorkspaceReadOnlyTools(config);
      if (readOnlyGrant && (!discussion || !options.readOnlyCommand)) throw new Error("Runtime has no configured node-bound read-only command");
      const verify = productTools ? takeWorkspaceToolVerifier(config) : undefined;
      if (productTools && !verify) throw new Error("Product tools require the node's local verified-run binding");
      if (discussion && !options.discussionCommand) throw new Error("runtime has no explicitly configured read-only discussion command");
      if (!discussion && options.initializeRepository && config.runStart.context_pack.payload?.product_development) {
        if (worktree || config.runStart.workspace.branch != null) throw new Error("Product bootstrap supports ordinary workspaces only");
        const git = resolveProductBootstrapGit(options.productBootstrapGit);
        await initializeEmptyProductRepository(config.workspaceRoot, git, startupSignal, windowsExecution?.backend);
        if (options.productBootstrapGit) resolveProductBootstrapGit(options.productBootstrapGit);
      }

      const legacyContextPath = worktree || externalDiscussion ? undefined : workspacePath(config.workspaceRoot, contextPackFilename);
      artifactPaths(config.workspaceRoot);
      startupSignal?.throwIfAborted();
      const ownedContext = worktree ? await ownedPreparation(invocation, startupSignal,
        () => writeOwnedContextFile(worktree, contextPackFilename, renderContextPack(config))) : undefined;
      startupSignal?.throwIfAborted();
      const contextPackPath = ownedContext?.path ?? externalDiscussion?.path ?? legacyContextPath!;
      if (!ownedContext) writeFileSync(contextPackPath, renderContextPack(config), externalDiscussion ? { mode: 0o400, flag: "wx" } : undefined);

      const template = readOnlyGrant ? options.readOnlyCommand! : reviewTools ? options.reviewCommand! : discussion ? options.discussionCommand! : productTools ? options.productCommand! : options.command;
      if (!template[0]) throw new Error("process adapter command template is empty");
      const resolved = resolveCliCommand(template[0]);
      if (!resolved) throw new Error(`runtime executable is unavailable or has an unsupported shell wrapper: ${template[0]}`);
      let research: ResearchSession | undefined;
      if (!discussion && researchOptions) research = await createResearchSession(researchOptions, {
        runId, taskId: config.taskId, projectId: config.runStart.context_pack.payload?.project.id ?? "",
        goalId: config.runStart.context_pack.payload?.goal_context?.goal_id ?? null, workspaceRoot: realpathSync.native(workspaceRoot),
      });
      let workspaceTools: WorkspaceToolSession | undefined;
      try {
        if (windowsExecution && isWindowsPlanningExecution(windowsExecution)) {
          windowsExecution.startupClosed = false;
          if (externalDiscussion) externalDiscussion.cleanupAllowed = false;
        }
        if (productTools) workspaceTools = await createWorkspaceToolSession({ workspaceRoot,
          context: config.runStart.context_pack.payload!, contextText: renderWorkspaceToolContext(config), verify: verify!,
          researchMcpPath: research?.mcpPath, readEvidence, readCapabilities, readReleaseCapabilities });
        else if (readOnlyGrant) workspaceTools = await createWorkspaceToolSession({ workspaceRoot,
          context: config.runStart.context_pack.payload!, contextText: renderWorkspaceToolContext(config), readEvidence, readCapabilities, readReleaseCapabilities, readOnlyGrant });
        else if (reviewTools) workspaceTools = await createWorkspaceToolSession({ workspaceRoot,
          context: config.runStart.context_pack.payload!, contextText: renderWorkspaceToolContext(config), readEvidence, readCapabilities, readReleaseCapabilities, evidenceOnly: true });
      } catch (error) { await research?.close(); throw error; }
      const argv = template.map((part) =>
        part
          .replaceAll("{{workspace_root}}", config.workspaceRoot)
          .replaceAll("{{context_pack_path}}", contextPackPath)
          .replaceAll("{{research_config_path}}", research?.configPath ?? "")
          .replaceAll("{{research_config_json}}", JSON.stringify(research?.configPath ?? ""))
          .replaceAll("{{research_mcp_path}}", research?.mcpPath ?? "")
          .replaceAll("{{workspace_tools_mcp_path}}", workspaceTools?.mcpPath ?? "")
          .replaceAll("{{workspace_tools_config_path}}", workspaceTools?.configPath ?? "")
          .replaceAll("{{workspace_tools_config_json}}", JSON.stringify(workspaceTools?.configPath ?? ""))
      );
      const [, ...args] = argv;
      let child: ChildProcess | WindowsOwnedProcess;
      let nativeProcess: WindowsOwnedProcess | undefined;
      try {
      if (ownedContext) {
        await ownedPreparation(invocation, startupSignal, () => assertOwnedContextForLaunch(ownedContext));
        // Fresh async Git observations end here. Keep the local boundary and
        // cancellation check adjacent to spawn, without an intervening await.
        if (invocation) invocation.helperUncertain = true;
        assertOwnedContextLocalBoundary(ownedContext);
        if (invocation) invocation.helperUncertain = false;
        if (invocation?.startSnapshot?.workspace_allocation !== undefined) {
          try {
            if (ownedVerificationDigest(config.runStart) === ownedVerificationDigest(invocation.startSnapshot)) {
              invocation.renderedContext = Object.freeze({ digest: `sha256:${ownedContext.sha256}`, size: ownedContext.bytes });
            }
          } catch { invocation.renderedContext = undefined; } // Legacy data never gains the optional projection proof.
        }
      }
      startupSignal?.throwIfAborted();
      if (invocation) invocation.spawnAttempted = true;
      if (externalDiscussion) externalDiscussion.cleanupAllowed = false;
      if (windowsExecution) {
        assertWindowsNativeExecutionIdentity(windowsExecution, config);
        child = nativeProcess = await startWindowsScopedProcess(windowsExecution.backend, {
          executable: resolved[0]!, args: [...resolved.slice(1), ...args], cwd: workspaceRoot, env: process.env,
          timeoutMs: 43_200_000, maxOutputBytes: 64 * 1024 * 1024, cleanupTimeoutMs: 5000,
          normalExitPolicy: "terminate-descendants", normalExitGraceMs: 250, signal: windowsExecution.signal,
        }, isWindowsPlanningExecution(windowsExecution) ? "tool" : "author");
      } else child = spawn(resolved[0]!, [...resolved.slice(1), ...args], { cwd: config.workspaceRoot, detached: process.platform !== "win32", windowsHide: true });
      } catch (error) {
        if (windowsExecution) {
          if (externalDiscussion) externalDiscussion.cleanupAllowed = false;
          // The bridge's admittedToCaller gate guarantees that a synchronous
          // start failure never dispatched a target. Both brokers still close.
          const closures = await Promise.allSettled([Promise.resolve().then(() => workspaceTools?.close()),
            Promise.resolve().then(() => research?.close())]);
          if (closures.some(result => result.status === "rejected")) {
            throw new VerificationCleanupError("Windows startup tool closure remains unconfirmed; context retained", { cause: error });
          }
          if (isWindowsPlanningExecution(windowsExecution)) {
            // Scoped launch first awaits a guardian reservation helper. Its
            // rejected promise alone cannot prove that helper's actual closure.
            if (guardianOperation) throw new VerificationCleanupError("Windows planning guardian startup closure remains unconfirmed; context retained", { cause: error });
            windowsExecution.startupClosed = true;
          }
          if (externalDiscussion) externalDiscussion.cleanupAllowed = true;
        } else {
          if (externalDiscussion) externalDiscussion.cleanupAllowed = true;
          await workspaceTools?.close(); await research?.close();
        }
        throw error;
      }
      // The agent receives its task via the command template + context pack, not
      // stdin. Close stdin so CLIs that read it (e.g. `codex exec` prints
      // "Reading additional input from stdin...") get EOF immediately instead of
      // blocking forever on an open, never-written pipe.
      if (!nativeProcess) (child as ChildProcess).stdin?.end();
      const queue = new AsyncEventQueue<RunEvent>();
      let finalized = false;
      let spawned = false;
      let childExitObserved = false, childStdioClosed = false, childSpawnFailed = false, groupAbsent = false;
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolveClose) => { resolveClosed = resolveClose; });
      let termination: Promise<void> | undefined;
      let workspaceCleanupError: VerificationCleanupError | undefined;
      let nativeFailureCleanup: Promise<void> | undefined;
      let guardian: ChildProcess | undefined;
      let guardianClosed: Promise<void> | undefined;
      let guardianCloseObserved = false, guardianSpawned = false, guardianSpawnFailed = false;
      let guardianAttempted = false, guardianExitObserved = false, guardianGroupAbsent = false;
      let guardianStatus: number | null = null, guardianSignal: NodeJS.Signals | null = null;
      const structured = createStructuredOutput(options.outputFormat ?? "plain");
      // CLI diagnostics may echo authentication headers. Parse original JSON
      // first: a short key such as "type" must not alter protocol field names.
      // Redact log text separately and redact parsed values before publishing.
      const secret = process.env.ARTOO_CODEX_PROVIDER_KEY;
      const secretForms = secret ? [secret] : [];
      let allFormsKnown = !secret;
      const redact = (text: string): string => {
        // A provider can embed a JSON response inside another JSON diagnostic.
        // Cover every possible repeated JSON escaping level that fits in this
        // text, rather than assuming a single log serialization boundary.
        while (!allFormsKnown && secretForms.at(-1)!.length <= text.length) {
          const last = secretForms.at(-1)!;
          const escaped = JSON.stringify(last).slice(1, -1);
          if (escaped === last) allFormsKnown = true;
          else secretForms.push(escaped);
        }
        return [...secretForms].reverse().reduce((value, part) => value.replaceAll(part, "[redacted]"), text);
      };
      const redactLine = (raw: string): string => {
        if (!secret) return raw;
        // JSON may spell a secret with Unicode escapes. Normalize only records
        // requiring redaction; this output is never used as protocol input.
        try {
          const normalized = JSON.stringify(JSON.parse(raw));
          const safe = redact(normalized);
          return safe === normalized ? redact(raw) : safe;
        } catch { return redact(raw); }
      };
      const emit = (event: RunEvent): void => {
        if (event.type === "run.answer") event = { ...event, payload: { ...event.payload, text: redact(event.payload.text) } };
        else if (event.type === "run.lifecycle" && typeof event.payload.reason === "string") event = { ...event, payload: { ...event.payload, reason: redact(event.payload.reason) } };
        else if (event.type === "run.usage" && event.payload.provider_session_id) event = { ...event, payload: { ...event.payload, provider_session_id: redact(event.payload.provider_session_id) } };
        queue.push(event);
      };

      const stdout = makeLineEmitter((raw) => {
        const text = redactLine(raw);
        queue.push({ type: "run.output", payload: { stream: "stdout", text } });
        structured.consume(raw);
      });
      const stderr = makeLineEmitter((text) =>
        queue.push({ type: "run.output", payload: { stream: "stderr", text: redactLine(text) } })
      );
      child.stdout?.on("data", (chunk: Buffer) => stdout.feed(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.feed(chunk));

      const state: RunState = {
        queue,
        workspaceRoot,
        discussion,
        kill: async () => {
          if (workspaceCleanupError) throw workspaceCleanupError;
          if (finalized) return;
          if (nativeProcess) {
            // Stop the Job before disposing tool configurations. Node-owned preview
            // verification closes independently in the close continuation below.
            await beginTermination(); await closed;
            if (workspaceCleanupError) throw workspaceCleanupError;
            return;
          }
          // The verifier runs in its own owned process group. Stopping only the
          // CLI/MCP process does not confirm that verifier's exit.
          const toolClosure = workspaceTools?.close();
          void toolClosure?.catch(() => {});
          await beginTermination();
          await toolClosure;
          await closed;
          if (workspaceCleanupError) throw workspaceCleanupError;
        }
      };

      function beginTermination(): Promise<void> {
        if (!termination) {
          if (nativeProcess) { nativeProcess.cancel(); termination = nativeProcess.closed.then(() => {}, cause => {
            throw new VerificationCleanupError(withWindowsProcessErrorDiagnostic("Windows process stop did not confirm closure", cause), { cause });
          }); }
          else termination = child.pid === undefined ? Promise.resolve() : stopProcessTree(child.pid);
          void termination.then(() => { groupAbsent = true; }, () => {});
        }
        return termination;
      }
      function zeroProbe(pid: number): "present" | "absent" | "unknown" {
        // POSIX signal zero is an existence query; it sends no signal.
        try { process.kill(pid, 0); return "present"; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown"; }
      }
      function physicalFacts(): OwnedPhysicalFacts {
        const childNeverSpawned = childSpawnFailed && !spawned && child.pid === undefined && childStdioClosed;
        const guardianNeverSpawned = !guardianAttempted || guardianSpawnFailed && !guardianSpawned && guardian?.pid === undefined && guardianCloseObserved;
        return Object.freeze({ childPid: child.pid ?? null, childSpawned: spawned, childExitObserved,
          childStdioClosed, groupAbsent: groupAbsent || childNeverSpawned,
          guardianPid: guardian?.pid ?? null, guardianAttempted, guardianSpawned, guardianExitObserved,
          guardianStdioClosed: guardianCloseObserved || !guardianAttempted,
          guardianGroupAbsent: guardianGroupAbsent || guardianNeverSpawned });
      }
      function observeFullClosure(): OwnedPhysicalFacts | undefined {
        const childNeverSpawned = childSpawnFailed && !spawned && child.pid === undefined && childStdioClosed;
        if (!(childNeverSpawned || childExitObserved && childStdioClosed && groupAbsent)) return;
        if (guardianAttempted) {
          const neverSpawned = guardianSpawnFailed && !guardianSpawned && guardian?.pid === undefined && guardianCloseObserved;
          if (!neverSpawned) {
            if (!guardianExitObserved || !guardianCloseObserved || guardianStatus !== 0 || guardianSignal !== null || guardian?.pid === undefined) return;
            if (!guardianGroupAbsent) guardianGroupAbsent = zeroProbe(-guardian.pid) === "absent";
            if (!guardianGroupAbsent) return;
          }
        }
        const facts = physicalFacts();
        if (invocation) {
          invocation.closedFacts = facts;
          invocation.control = undefined; // Closed tokens must not retain the child/guardian graph.
        }
        return facts;
      }
      async function confirmOwnedClosure(): Promise<OwnedPhysicalFacts> {
        const existing = invocation?.closedFacts ?? observeFullClosure();
        if (existing) return existing;
        const deadline = performance.now() + 5000;
        await boundedOwnedWait(closed, deadline);
        if (guardianAttempted && guardianClosed) await boundedOwnedWait(guardianClosed, deadline);
        for (;;) {
          const facts = observeFullClosure();
          if (facts) return facts;
          if (performance.now() >= deadline) throw new Error("Owned child, stdio, group or guardian closure remains uncertain");
          await new Promise((resolveCheck) => setTimeout(resolveCheck, 10));
        }
      }
      function childObservedRunning(): boolean {
        return spawned && !childExitObserved && !childStdioClosed && child.exitCode === null && child.signalCode === null
          && child.pid !== undefined && zeroProbe(child.pid) === "present" && zeroProbe(-child.pid) === "present";
      }
      if (invocation) {
        invocation.queue = queue;
        invocation.workspaceRoot = workspaceRoot;
        invocation.discussion = discussion;
        invocation.control = {
          facts: physicalFacts,
          confirmClosed: confirmOwnedClosure,
          stop: async (reason) => {
            const existing = invocation.closedFacts ?? observeFullClosure();
            if (existing) return existing;
            // Natural exit already has a real terminal outcome. Confirm its
            // closure without turning a buffered completion into cancellation.
            if (!childExitObserved && !childStdioClosed && child.exitCode === null && child.signalCode === null) {
              if (!childObservedRunning()) throw new Error("Owned child liveness is uncertain");
              state.stopReason = reason;
              await boundedOwnedWait(state.kill(), performance.now() + 5000);
            }
            return confirmOwnedClosure();
          },
          inspect: async () => {
            if (invocation.closedFacts ?? observeFullClosure()) return "confirmed_closed";
            if (childExitObserved || childStdioClosed || child.exitCode !== null || child.signalCode !== null) {
              try { await confirmOwnedClosure(); return "confirmed_closed"; } catch { return "uncertain"; }
            }
            return childObservedRunning() && guardianSpawned && !guardianExitObserved && !guardianCloseObserved
              && guardian?.pid !== undefined && guardian.exitCode === null && guardian.signalCode === null
              && zeroProbe(guardian.pid) === "present" && zeroProbe(-guardian.pid) === "present" ? "running" : "uncertain";
          }
        };
      }
      function compactOwnedAfterClose(): void {
        if (invocation) void confirmOwnedClosure().catch(() => {});
      }

      function finishWith(event: RunEvent): void {
        if (finalized) {
          return;
        }
        finalized = true;
        if (invocation && event.type === "run.lifecycle" && (event.payload.phase === "completed"
          || event.payload.phase === "failed" || event.payload.phase === "cancelled")) invocation.terminalPhase = event.payload.phase;
        stdout.flush();
        stderr.flush();
        for (const measured of structured.finish(false)) emit(measured);
        emit(event);
        queue.end();
        resolveClosed();
        compactOwnedAfterClose();
      }

      function retainWindowsUncertainty(error: unknown): Promise<void> {
        workspaceCleanupError ??= error instanceof VerificationCleanupError ? error
          : new VerificationCleanupError(withWindowsProcessErrorDiagnostic("Windows process closure remains unconfirmed; context and execution retained", error), { cause: error });
        return nativeFailureCleanup ??= (async () => {
          // Invoke both closers even if one rejects. Retention becomes sticky
          // before either asynchronous closure can remove invocation files.
          await Promise.allSettled([Promise.resolve().then(() => workspaceTools?.close({ retainFiles: true })),
            Promise.resolve().then(() => research?.close({ retainFiles: true }))]);
          queue.fail(workspaceCleanupError!); resolveClosed();
        })();
      }
      function acceptNativeClosure(receipt: WindowsOwnedClosureReceipt): void {
        if (!isWindowsOwnedClosureReceipt(receipt) || !receipt.cleanupConfirmed) throw new VerificationCleanupError("Windows process closure is not authenticated");
        windowsExecution!.receipt = receipt;
      }
      if (nativeProcess) {
        nativeProcess.once("spawn", () => {
          spawned = true; queue.push({ type: "run.lifecycle", payload: { phase: "started" } });
        });
        void nativeProcess.closed.then(acceptNativeClosure).catch(retainWindowsUncertainty);
      }

      child.on("error", (err: Error) => {
        if (!spawned) {
          childSpawnFailed = child.pid === undefined;
          return;
        }
        stderr.feed(`${err.message}\n`);
      });
      child.on("exit", () => {
        childExitObserved = true;
        if (process.platform === "win32" || child.pid === undefined) return;
        // The CLI leader can exit while a writer either ignores or inherits
        // stdio. Start group cleanup on exit, before waiting for pipe closure.
        const closing = beginTermination();
        void closing.catch((error: unknown) => stderr.feed(`CLI cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`));
      });
      const onChildClose = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
        childStdioClosed = true;
        if (nativeProcess) acceptNativeClosure(await nativeProcess.closed);
        if (process.platform !== "win32" && child.pid !== undefined) {
          beginTermination();
          try { await termination; } catch { return; }
        }
        // Only disarm after the POSIX group has actually disappeared. A leader
        // exiting successfully is not evidence that all workspace writers did.
        guardian?.stdin?.end("disarm");
        try { await workspaceTools?.close(); }
        catch (error) {
          workspaceCleanupError = error instanceof VerificationCleanupError ? error
            : new VerificationCleanupError("Workspace tool closure remains unconfirmed");
          try { await research?.close(windowsExecution ? { retainFiles: true } : undefined); }
          catch { workspaceCleanupError = new VerificationCleanupError("Workspace and research tool closure remain unconfirmed"); }
          // Surface uncertainty without a terminal lifecycle or released lease.
          queue.fail(workspaceCleanupError); resolveClosed(); return;
        }
        try { await research?.close(); }
        catch {
          if (windowsExecution) {
            workspaceCleanupError = new VerificationCleanupError("Windows research tool closure remains unconfirmed");
            queue.fail(workspaceCleanupError); resolveClosed(); return;
          }
          finishWith({ type: "run.lifecycle", payload: { phase: "failed", reason: "Research session cleanup failed" } }); return;
        }
        if (invocation) invocation.resultResourcesClosed = true;
        if (windowsExecution) windowsExecution.resourcesClosed = true;
        if (externalDiscussion) {
          externalDiscussion.cleanupAllowed = true;
          try { cleanupDiscussionContext(externalDiscussion); }
          catch (error) {
            finishWith({ type: "run.lifecycle", payload: { phase: "failed", reason: "External discussion context cleanup failed" } }); return;
          }
        }
        if (state.stopReason) {
          // A parent exit alone does not prove its descendants stopped.
          try { await termination; } catch { resolveClosed(); return; }
          finishWith({
            type: "run.lifecycle",
            payload: { phase: "cancelled", reason: state.stopReason }
          });
          return;
        }

        if (windowsExecution?.receipt && (windowsExecution.receipt.failureCode
          || (windowsExecution.receipt.terminationReason !== null && windowsExecution.receipt.terminationReason !== "normal_exit_descendants"))) {
          finishWith({ type: "run.lifecycle", payload: { phase: "failed",
            reason: `Windows execution ${windowsExecution.receipt.failureCode ?? windowsExecution.receipt.terminationReason}` } });
          return;
        }

        if (code === 0) {
          stdout.flush();
          stderr.flush();
          if (structured.failureReason() !== undefined) {
            finishWith({ type: "run.lifecycle", payload: { phase: "failed", reason: structured.failureReason() } });
            return;
          }
          let descriptors: ArtifactDescriptor[];
          try {
            const context = config.runStart.context_pack.payload;
            descriptors = discussion ? [] : [...collectDescriptors(workspaceRoot), ...(context ? validateProductStage(workspaceRoot, context, researchOptions) : [])];
            completedArtifacts.set(runId, descriptors);
          }
          catch (error) {
            finishWith({ type: "run.lifecycle", payload: { phase: "failed", reason: error instanceof Error ? error.message : "artifact collection failed" } });
            return;
          }
          stdout.flush();
          stderr.flush();
          finalized = true;
          for (const descriptor of descriptors) {
            queue.push({ type: "artifact.created", payload: descriptor.payload });
          }
          for (const measured of structured.finish(true)) emit(measured);
          if (invocation) invocation.terminalPhase = "completed";
          queue.push({ type: "run.lifecycle", payload: { phase: "completed", reason: null } });
          queue.end();
          resolveClosed();
          compactOwnedAfterClose();
          return;
        }

        // Parse any final unterminated JSON record before choosing the error.
        // CLIs normally exit nonzero for model/auth/provider failures; preserve
        // their actionable reason instead of reducing every failure to exit 1.
        stdout.flush();
        stderr.flush();
        finishWith({
          type: "run.lifecycle",
          payload: { phase: "failed", reason: signal ? `signal ${signal}` : structured.failureReason() ?? `exit ${code ?? "unknown"}` }
        });
      };
      // EventEmitter does not await asynchronous listeners. Keep all native
      // continuation failures inside the sticky ownership/retention boundary.
      if (nativeProcess) child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        void onChildClose(code, signal).catch(retainWindowsUncertainty);
      });
      else child.on("close", onChildClose);

      let startupStop: Promise<void> | undefined;
      let startupAbortHandled = false;
      const onStartupAbort = (): void => {
        state.stopReason = "user_cancelled";
        startupStop ??= state.kill();
        // The startup continuation awaits and reports cleanup failure below.
        void startupStop.catch(() => {});
      };
      async function rejectAfterStartupAbort(): Promise<never> {
        startupAbortHandled = true;
        onStartupAbort();
        try {
          await startupStop;
          if (guardian) {
            if (!guardianClosed) throw new Error("Startup guardian closure was not observed");
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([guardianClosed, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Startup guardian did not close after disarm")), 5000);
              })]);
            } finally { clearTimeout(timer); }
            const neverSpawned = guardianSpawnFailed && !guardianSpawned && guardian.pid === undefined;
            if (!neverSpawned && (!guardianCloseObserved || guardianStatus !== 0 || guardianSignal !== null)) {
              throw new Error("Startup guardian closure was not successful");
            }
          }
        } catch (error) {
          if (windowsExecution) throw new VerificationCleanupError("Windows startup cleanup remains unconfirmed; context retained");
          throw new Error("Owned startup cleanup is uncertain; worktree and context retained", { cause: error });
        }
        throw startupSignal!.reason;
      }
      try {
      startupSignal?.addEventListener("abort", onStartupAbort, { once: true });
      if (startupSignal?.aborted) onStartupAbort();
      if (nativeProcess) {
        try { await nativeProcess.started; }
        catch (error) {
          try { await nativeProcess.closed; await closed; }
          catch (cause) {
            throw new VerificationCleanupError(withWindowsProcessErrorDiagnostic("Windows process startup closure remains unconfirmed", cause), { cause });
          }
          if (workspaceCleanupError) throw workspaceCleanupError;
          throw error;
        }
      } else await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", () => {
          spawned = true;
          queue.push({ type: "run.lifecycle", payload: { phase: "started" } });
          resolveSpawn();
        });
        child.once("error", (err: Error) => {
          if (!spawned) {
            rejectSpawn(err);
          }
        });
      });
      if (startupSignal?.aborted) await rejectAfterStartupAbort();

      if (!nativeProcess && !finalized && child.pid !== undefined) {
        guardianAttempted = true;
        guardian = spawn(process.execPath, ["-e", PROCESS_GUARDIAN, String(child.pid)], {
          stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: process.platform !== "win32",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
        if (startupSignal) {
          // Observe the actual guardian at creation, before its spawn/close
          // callbacks can run. Only startup cancellation waits on this proof.
          const observedGuardian = guardian;
          guardianClosed = new Promise<void>((resolveGuardianClose) => {
            observedGuardian.once("spawn", () => { guardianSpawned = true; });
            observedGuardian.once("exit", () => { guardianExitObserved = true; });
            observedGuardian.once("close", (code, signal) => {
              guardianCloseObserved = true; guardianStatus = code; guardianSignal = signal;
              resolveGuardianClose();
            });
            observedGuardian.once("error", () => {
              if (!guardianSpawned && observedGuardian.pid === undefined) {
                guardianSpawnFailed = true; resolveGuardianClose();
              }
            });
          });
        }
        guardian.stdin?.on("error", () => {});
        try {
          await new Promise<void>((resolveGuard, rejectGuard) => {
            guardian!.once("spawn", resolveGuard);
            guardian!.once("error", rejectGuard);
          });
        } catch (error) {
          state.stopReason = "user_cancelled";
          await state.kill();
          throw error;
        }
        if (finalized) guardian.stdin?.end("disarm");
      }

      if (startupSignal?.aborted) await rejectAfterStartupAbort();
      if (invocation) {
        const handle = Object.freeze({ runId });
        invocation.handle = new WeakRef(handle);
        ownedExecutions.set(handle, invocation);
        return handle;
      }
      runs.set(runId, state);
      const handle = windowsExecution ? Object.freeze({ runId }) : { runId };
      if (windowsExecution) windowsExecution.handle = new WeakRef(handle);
      return handle;
      } catch (error) {
        if (startupSignal?.aborted && !startupAbortHandled) await rejectAfterStartupAbort();
        if (nativeProcess && !windowsExecution!.resourcesClosed) {
          try { await state.kill(); }
          catch (cause) {
            await retainWindowsUncertainty(cause);
            throw workspaceCleanupError!;
          }
        }
        throw error;
      } finally {
        startupSignal?.removeEventListener("abort", onStartupAbort);
      }
  }

  function ownedExecution(handle: AgentInstanceHandle, admission: OwnedRunAdmission): OwnedInvocation | undefined {
    const execution = ownedExecutions.get(handle);
    return execution?.owner === ownedOwner && matchesScope(execution, admission, handle) ? execution : undefined;
  }
  function stopReceipt(execution: OwnedInvocation, kind: OwnedStopReceipt["kind"]): OwnedStopReceipt {
    const facts = execution.closedFacts ?? execution.control?.facts();
    const receipt = Object.freeze({ kind, observedAt: new Date().toISOString(), ...(facts ? { facts } : {}) });
    ownedStopReceipts.set(receipt, { admission: execution.admission, worktree: execution.worktree,
      handle: execution.handle, receipt });
    return receipt;
  }
  function statusReceipt(execution: OwnedInvocation, kind: OwnedRunStatusReceipt["kind"]): OwnedRunStatusReceipt {
    const facts = execution.closedFacts ?? execution.control?.facts();
    const receipt = Object.freeze({ kind, observedAt: new Date().toISOString(), ...(facts ? { facts } : {}) });
    ownedStatusReceipts.set(receipt, { admission: execution.admission, worktree: execution.worktree,
      handle: execution.handle, receipt });
    return receipt;
  }
  const adapter: OwnedWorktreeRuntimeAdapter & OwnedRunRuntimeAdapter = {
    runtimeId,

    async start(config: AgentInstanceConfig): Promise<AgentInstanceHandle> {
      if (config.runStart.workspace_allocation !== undefined) throw new Error("Explicit allocation requires an owned worktree start");
      const windowsExecution: WindowsNativeExecution | undefined = takeWindowsVerifiedExecution(adapter, config) ?? takeWindowsPlanningExecution(adapter, config);
      if (config.runStart.context_pack.payload?.policy.execution_mode === "discussion") {
        if (!options.discussionCommand) throw new Error("runtime has no explicitly configured read-only discussion command");
        assertWorkspaceScope(config.workspaceRoot, options.allowedRoots);
        assertRealWorkspaceScope(config.workspaceRoot, options.allowedRoots);
        const root = realpathSync.native(config.workspaceRoot), temporary = realpathSync.native(tmpdir());
        const suffix = relative(root, temporary);
        if (suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) {
          throw new Error("Discussion needs a context directory outside its workspace");
        }
        const directory = mkdtempSync(join(temporary, "artoo-discussion-context-"));
        const external = { directory, path: join(directory, "context_pack.md"), cleanupAllowed: true };
        try {
          chmodSync(directory, 0o700);
          return await startProcess(config, undefined, windowsExecution?.signal, undefined, external, windowsExecution);
        } catch (error) {
          if (windowsExecution && isWindowsPlanningExecution(windowsExecution) && windowsExecution.resourcesClosed
            && windowsExecution.receipt && isWindowsOwnedClosureReceipt(windowsExecution.receipt) && windowsExecution.receipt.cleanupConfirmed) {
            windowsExecution.startupClosed = true;
          }
          cleanupDiscussionContext(external); throw error;
        }
      }
      return startProcess(config, undefined, windowsExecution?.signal, undefined, undefined, windowsExecution);
    },

    async startOwnedWorktree(config: AgentInstanceConfig, worktree: MaterializedWorktree, startupSignal?: AbortSignal): Promise<AgentInstanceHandle> {
      // Detach caller-owned payload before the first async ownership observation.
      const snapshot = structuredClone(config);
      startupSignal?.throwIfAborted();
      await assertOwnedMaterializedWorktree(worktree);
      startupSignal?.throwIfAborted();
      return startProcess(snapshot, worktree, startupSignal);
    },

    async startOwnedRun(config: AgentInstanceConfig, worktree: MaterializedWorktree, admission: OwnedRunAdmission, signal: AbortSignal): Promise<AgentInstanceHandle> {
      const admitted = ownedAdmissions.get(admission);
      if (!admitted || admitted.claimed) throw new Error("A fresh authenticated owned admission is required");
      admitted.claimed = true;
      const invocation: OwnedInvocation = { admission: new WeakRef(admission), worktree: new WeakRef(worktree),
        owner: ownedOwner, genuine: false, spawnAttempted: false, helperUncertain: false, resultResourcesClosed: false,
        workspaceRoot: admitted.identity.workspaceRoot, discussion: false };
      try {
        // Snapshot before any asynchronous ownership observation.
        const snapshot = structuredClone(config), identity = admitted.identity;
        if (snapshot.runStart.workspace_allocation !== undefined) invocation.startSnapshot = freezeOwnedStart(structuredClone(snapshot.runStart));
        if (!(signal instanceof AbortSignal)) throw new Error("An actual startup AbortSignal is required");
        assertOwnedWorktreeLocalBoundary(worktree);
        invocation.genuine = true;
        if (identity.runId !== snapshot.runId || identity.taskId !== snapshot.taskId
          || identity.agentInstanceId !== snapshot.agentInstanceId || identity.runtime !== snapshot.runtime
          || identity.runtime !== runtimeId || identity.workspaceRoot !== snapshot.workspaceRoot
          || identity.workspaceRoot !== worktree.root || identity.workspaceBranch !== worktree.branch
          || snapshot.runStart.run_id !== identity.runId || snapshot.runStart.task_id !== identity.taskId
          || snapshot.runStart.agent_instance_id !== identity.agentInstanceId || snapshot.runStart.runtime !== identity.runtime
          || snapshot.runStart.workspace.root !== identity.workspaceRoot || snapshot.runStart.workspace.branch !== identity.workspaceBranch) {
          throw new Error("Owned admission does not match this exact frozen launch identity");
        }
        signal.throwIfAborted();
        await ownedPreparation(invocation, signal, () => assertOwnedMaterializedWorktree(worktree));
        signal.throwIfAborted();
        return await startProcess(snapshot, worktree, signal, invocation);
      } catch (cause) {
        let kind: OwnedStartupReceipt["kind"] = "uncertain";
        if (invocation.genuine && !invocation.spawnAttempted && !invocation.helperUncertain) kind = "not_spawned";
        if (invocation.spawnAttempted && invocation.control) {
          try { await invocation.control.stop("user_cancelled"); } catch { /* Retain authenticated uncertainty. */ }
        }
        if (invocation.closedFacts) kind = invocation.closedFacts.childSpawned ? "confirmed_closed" : "not_spawned";
        const error = new Error("Owned runtime startup failed; workspace and context retained", { cause });
        if (invocation.genuine) {
          const facts = invocation.closedFacts ?? invocation.control?.facts();
          const receipt: OwnedStartupReceipt = Object.freeze({ kind, cancellationRequested: signal instanceof AbortSignal && signal.aborted,
            observedAt: new Date().toISOString(), ...(facts ? { facts } : {}) });
          ownedStartupErrors.set(error, { admission: invocation.admission, worktree: invocation.worktree, receipt });
        }
        throw error;
      }
    },

    async stopOwnedRun(handle: AgentInstanceHandle, admission: OwnedRunAdmission, reason: StopReason): Promise<OwnedStopReceipt> {
      const execution = ownedExecution(handle, admission);
      if (!execution) throw new Error("An exact authenticated owned execution handle is required");
      if (execution.closedFacts) return stopReceipt(execution, "confirmed_closed");
      try {
        if (!execution.control) return stopReceipt(execution, "uncertain");
        await execution.control.stop(reason);
        return stopReceipt(execution, execution.closedFacts ? "confirmed_closed" : "uncertain");
      } catch { return stopReceipt(execution, "uncertain"); }
    },

    async inspectOwnedRun(handle: AgentInstanceHandle, admission: OwnedRunAdmission): Promise<OwnedRunStatusReceipt> {
      const execution = ownedExecution(handle, admission);
      if (!execution) throw new Error("An exact authenticated owned execution handle is required");
      if (execution.closedFacts) return statusReceipt(execution, "confirmed_closed");
      try {
        const kind = execution.control ? await execution.control.inspect() : "uncertain";
        return statusReceipt(execution, kind);
      } catch { return statusReceipt(execution, "uncertain"); }
    },

    streamEvents(handle: AgentInstanceHandle): AsyncIterable<RunEvent> {
      const execution = ownedExecutions.get(handle);
      if (execution?.owner === ownedOwner) {
        const queue = execution.queue;
        return (async function* () {
          if (!queue) return;
          let drained = false;
          try { yield* queue.drain(); drained = true; }
          finally { if (drained && execution.queue === queue) execution.queue = undefined; }
        })();
      }
      const state = runs.get(handle.runId);
      if (!state) {
        throw new Error(`no active run for ${handle.runId}`);
      }
      return state.queue.drain();
    },

    async stop(handle: AgentInstanceHandle, reason: StopReason): Promise<void> {
      const execution = ownedExecutions.get(handle);
      if (execution?.owner === ownedOwner) {
        if (execution.closedFacts) return;
        if (!execution.control) throw new Error("Owned execution closure is uncertain");
        await execution.control.stop(reason);
        return;
      }
      const state = runs.get(handle.runId);
      if (state) {
        state.stopReason = reason;
        await state.kill();
      }
    },

    async collectArtifacts(handle: AgentInstanceHandle): Promise<ArtifactDescriptor[]> {
      const completed = completedArtifacts.get(handle.runId);
      if (completed) return completed;
      const execution = ownedExecutions.get(handle);
      if (execution?.owner === ownedOwner) return execution.discussion ? [] : collectDescriptors(execution.workspaceRoot);
      const state = runs.get(handle.runId);
      return state && !state.discussion ? collectDescriptors(state.workspaceRoot) : [];
    }
  };
  ownedAdapters.set(adapter, Object.freeze({ runtimeId: adapter.runtimeId, startOwnedRun: adapter.startOwnedRun,
    stopOwnedRun: adapter.stopOwnedRun, inspectOwnedRun: adapter.inspectOwnedRun,
    streamEvents: adapter.streamEvents, collectArtifacts: adapter.collectArtifacts }));
  windowsAdapters.set(adapter, Object.freeze({ runtimeId: adapter.runtimeId, start: adapter.start, stop: adapter.stop,
    streamEvents: adapter.streamEvents, collectArtifacts: adapter.collectArtifacts }));
  if (options.readOnlyCommand?.length && options.discussionCommand?.length) readOnlyToolAdapters.set(adapter,
    Object.freeze({ runtimeId: adapter.runtimeId, start: adapter.start, stop: adapter.stop, streamEvents: adapter.streamEvents, collectArtifacts: adapter.collectArtifacts }));
  return adapter;
}
