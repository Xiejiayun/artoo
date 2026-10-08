import { createHash } from "node:crypto";
import { ManagedDelivery, boundedOperation, abortableOperation, DeliveryCancelled,
  type ManagedJournalOptions, type ManagedSession } from "./managed/managed-delivery.js";
import type { FreshLaunchPermit, JournalRun, TerminalSettlement } from "./managed/journal-types.js";
import type {
  AgentInstanceHandle,
  NodeSideTransport,
  NodeToServerMessage,
  NodeErrorCode,
  RunEventMessage,
  RunStartCommand,
  RunStopCommand,
  RunResumeCommand,
  RuntimeAdapter,
  ServerToNodeMessage,
  Unsubscribe
} from "@artoo/protocol";
import { adapterRunEventBodySchema, assertWorkspaceScope } from "@artoo/protocol";
import { RunStartPayloadSchema, RunWorkspaceRetainedPayloadSchema,
  type RunStartPayload, type WorkspaceRetentionOutcome } from "@artoo/domain";

import type { AdapterRegistry } from "./adapter-registry.js";
import { allocationStartBinding, assertMatchingAllocationReplay, type AllocationStartBinding, type AllocationReplayIdentity } from "./node-allocation-identity.js";
import {
  assertRealWorkspaceScope, createOwnedRunAdmission, getOwnedStartupReceipt, getOwnedStopReceipt,
  getOwnedRunStatusReceipt, isOwnedRunAdapter,
  type OwnedRunAdmission, type OwnedRunRuntimeAdapter,
} from "./process-adapter.js";
import { snapshotGitOptions, type GitReadOptions } from "./owned/git-operations.js";
import { OwnedGitError } from "./owned/owned-git.js";
import { provisionRunNamespace } from "./owned/workspace-namespace.js";
import { prepareOwnedWorktree, reserveOwnedWorktree, materializeOwnedWorktree,
  type MaterializedWorktree, type OwnedReservation } from "./owned/worktree-reservation.js";
import type { ArtifactUploader } from "./artifact-upload.js";
import {
  createGitCliExecutor,
  materializeWorkspace,
  planWorkspace,
  type GitExecutor,
  type WorkspaceConfig,
  type WorkspacePlan,
} from "./workspace-binding.js";

/**
 * `artood` node-protocol client (mock-loop core of task #6).
 *
 * Drives a {@link RuntimeAdapter} in response to Server->Node commands over a
 * {@link NodeSideTransport}, proving the node-side protocol loop:
 *
 *   run.start -> command.ack(accepted) -> adapter.start
 *             -> stream RunEvents as run.event with a per-run monotonic sequence
 *   run.stop  -> command.ack(accepted) -> adapter.stop (the run streams to a
 *               cancelled lifecycle and ends)
 *   run.resume -> command.ack(accepted) only when this client still tracks the
 *                live handle; otherwise command.ack(rejected/process_exited).
 *
 * Legacy starts retain the transport/adapter seam. Explicit per-run starts use
 * genuine local workspace handles and authenticated owned-process evidence;
 * that same-process path does not advertise a public execution feature or
 * reconstruct restart ownership. No production branch depends on test helpers.
 */
export interface NodeClientOptions {
  nodeId: string;
  transport: NodeSideTransport;
  /** Single-runtime mode: handles any run.start.runtime. Provide this OR registry. */
  adapter?: RuntimeAdapter;
  /** Multi-runtime mode: resolves the adapter by run.start.runtime; unknown -> runtime_missing. */
  registry?: AdapterRegistry;
  /** Node-side workspace materialization config (git worktree mode). Default: no worktree support. */
  workspace?: WorkspaceConfig;
  /** Legacy materialization executor only; explicit per-run mode never calls it. */
  git?: GitExecutor;
  /** Trusted local asynchronous physical-mode settings; never read from wire payloads. */
  ownedGit?: Omit<GitReadOptions, "signal">;
  uploadArtifact?: ArtifactUploader;
  /** Trusted local managed delivery. It never falls back to transport replay. */
  managedJournal?: ManagedJournalOptions;
}

export interface NodeClient {
  start(): void;
  stop(cancelRunning?: boolean): Promise<void>;
  invalidateManagedStartupSession(session: ManagedSession | undefined, cause: Error): void;
  failManagedConnection(cause: Error): Promise<void>;
  requestManagedRunStop(runId: string): Promise<void>;
}

type PhysicalStartupOutcome = Readonly<
  | { kind: "started" }
  | { kind: "rejected" | "cancelled" | "uncertain"; code: NodeErrorCode; message: string }
>;
interface PhysicalExecution {
  readonly adapter: OwnedRunRuntimeAdapter;
  readonly handle: AgentInstanceHandle;
  readonly admission: OwnedRunAdmission;
  readonly stopOwnedRun: OwnedRunRuntimeAdapter["stopOwnedRun"];
  readonly inspectOwnedRun: OwnedRunRuntimeAdapter["inspectOwnedRun"];
  readonly streamEvents: RuntimeAdapter["streamEvents"];
  /** The real stream/receipt task is still owned, even after its writer closes. */
  deliveryPending: boolean;
  stopPending?: Promise<void>;
}
interface PhysicalStartRecord {
  readonly identity: AllocationReplayIdentity;
  readonly ready: Promise<PhysicalStartupOutcome>;
  resolveReady?: (outcome: PhysicalStartupOutcome) => void;
  outcome?: PhysicalStartupOutcome;
  controller?: AbortController;
  startupSession?: ManagedSession;
  execution?: PhysicalExecution;
  /** Set only after authenticated closure of this exclusively claimed attempt. */
  confirmedClosed: boolean;
  closureReceipt?: unknown;
  userStopRequested?: boolean;
  managed?: { permit: FreshLaunchPermit; delivery: ManagedDelivery; settled: boolean; deliveryPending: boolean; run?: JournalRun;
    observedTerminal?: TerminalSettlement["terminal"]; failure?: string };
  readonly recovery: { runId: string; taskId: string; root: string; branch: string; phase: string };
}
/** A legacy journal admission is an identity fence, never physical authority. */
interface MixedLegacyStartRecord {
  readonly key: string;
  readonly ready: Promise<PhysicalStartupOutcome>;
  resolveReady?: (outcome: PhysicalStartupOutcome) => void;
  outcome?: PhysicalStartupOutcome;
  controller?: AbortController;
  startupSession?: ManagedSession;
  admitted: boolean;
  adapterInvoked: boolean;
  stopPending?: Promise<void>;
  stopCompleted?: boolean;
  stopFailure?: string;
}
interface RunDelivery {
  readonly commandId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly workspaceRoot: string;
}

export function createNodeClient(options: NodeClientOptions): NodeClient {
  const { nodeId, transport } = options;
  if (!options.adapter && !options.registry) {
    throw new Error("createNodeClient requires either an adapter or a registry");
  }
  // run.start.runtime is the only adapter-selection key on the node side — no
  // scheduling or fallback here. Single-adapter mode handles every runtime.
  const resolveAdapter = (runtime: string): RuntimeAdapter | undefined =>
    options.registry ? options.registry.resolve(runtime) : options.adapter;
  const workspaceConfig: WorkspaceConfig = options.workspace ?? {};
  const git: GitExecutor = options.git ?? createGitCliExecutor();
  const runs = new Map<string, { handle: AgentInstanceHandle; adapter: RuntimeAdapter }>();
  const starting = new Map<string, Promise<void>>();
  const finished = new Set<string>();
  // Includes legacy (undefined) bindings, distinguishing an actual launch from
  // a cancellation tombstone that must never acquire an identity or a writer.
  const launchBindings = new Map<string, AllocationReplayIdentity | undefined>();
  const physicalStarts = new Map<string, PhysicalStartRecord>();
  const mixedLegacyStarts = new Map<string, MixedLegacyStartRecord>();
  const mixedStopIntents = new Set<string>();
  const closedDeliveries = new Map<string, ManagedDelivery>();
  const inflight = new Set<Promise<void>>();
  let unsubscribe: Unsubscribe | undefined;

  async function sendControl(message: NodeToServerMessage): Promise<void> {
    const operation = transport.send(message);
    if (options.managedJournal) await boundedOperation(operation, 10000);
    else await operation;
  }
  async function ackAccepted(commandId: string): Promise<void> {
    await sendControl({
      kind: "command.ack",
      node_id: nodeId,
      command_id: commandId,
      status: "accepted",
      message: null
    });
  }

  async function ackRejected(commandId: string, errorCode: NodeErrorCode, message: string): Promise<void> {
    await sendControl({
      kind: "command.ack",
      node_id: nodeId,
      command_id: commandId,
      status: "rejected",
      error_code: errorCode,
      message
    });
  }

  function track(task: Promise<void>): void {
    inflight.add(task);
    void task.catch(() => {}).finally(() => { inflight.delete(task); });
  }

  function settlePhysical(record: PhysicalStartRecord, outcome: PhysicalStartupOutcome): void {
    if (record.outcome) return;
    record.outcome = Object.freeze(outcome);
    record.resolveReady!(record.outcome);
    record.resolveReady = undefined;
    record.controller = undefined;
  }

  function settleMixedLegacy(record: MixedLegacyStartRecord, outcome: PhysicalStartupOutcome): void {
    if (record.outcome) return;
    record.outcome = Object.freeze(outcome);
    record.resolveReady!(record.outcome);
    record.resolveReady = undefined;
    record.controller = undefined;
    record.startupSession = undefined;
  }

  function assertMixedLegacyStartup(runId: string, record: MixedLegacyStartRecord): void {
    record.controller?.signal.throwIfAborted();
    if (mixedStopIntents.has(runId)) throw new DeliveryCancelled("Run was stopped before ordinary startup");
    options.managedJournal!.channel.assertCurrentSession(record.startupSession);
  }

  async function stopLegacyRun(runId: string, run: { handle: AgentInstanceHandle; adapter: RuntimeAdapter }): Promise<void> {
    const record = mixedLegacyStarts.get(runId);
    if (!record) return run.adapter.stop(run.handle, "user_cancelled");
    if (record.stopCompleted) return;
    if (record.stopPending) return record.stopPending;
    const operation = Promise.resolve().then(() => run.adapter.stop(run.handle, "user_cancelled"));
    record.stopPending = operation;
    try {
      await operation; record.stopCompleted = true; record.stopFailure = undefined;
      const current = runs.get(runId);
      // A failed/pending Stop can outlive its stream. Release only the exact
      // handle retained for that finished stream, after its retry succeeds.
      if (finished.has(runId) && current && current.handle === run.handle && current.adapter === run.adapter) runs.delete(runId);
    }
    catch (error) { record.stopFailure = errorMessage(error); throw error; }
    finally { if (record.stopPending === operation) record.stopPending = undefined; }
  }

  function compactPhysical(record: PhysicalStartRecord): void {
    if (record.managed && (!record.managed.settled || record.managed.deliveryPending)) return;
    if (record.confirmedClosed && !record.execution?.deliveryPending) {
      record.execution = undefined;
      record.closureReceipt = undefined;
      record.controller = undefined;
      // Keep identity and the original startup outcome. No ContextPack, worktree
      // inventory, error chain, child/queue or resolved-handle promise is retained.
    }
  }

  async function acknowledgePhysicalStart(commandId: string, outcome: PhysicalStartupOutcome): Promise<void> {
    if (outcome.kind === "started") await ackAccepted(commandId);
    else await ackRejected(commandId, outcome.code, outcome.message);
  }

  async function drainManagedRecord(record: PhysicalStartRecord): Promise<void> {
    const managed = record.managed!;
    managed.deliveryPending = true;
    if (record.execution) record.execution.deliveryPending = true;
    try {
      await managed.delivery.drainClosed();
      managed.deliveryPending = false;
      if (record.execution) record.execution.deliveryPending = false;
    } finally { compactPhysical(record); }
  }

  async function stopPhysical(record: PhysicalStartRecord): Promise<void> {
    if (record.confirmedClosed && (record.closureReceipt || record.managed?.settled || !record.managed)) return;
    const execution = record.execution;
    if (!execution) throw new Error("Owned startup has no authenticated writer-absence proof; recovery state is retained");
    if (execution.stopPending) return execution.stopPending;
    const operation = (async () => {
      const value = await execution.stopOwnedRun(execution.handle, execution.admission, "user_cancelled");
      const receipt = getOwnedStopReceipt(value, execution.admission, execution.handle);
      if (receipt?.kind !== "confirmed_closed") throw new Error("Owned process/guardian cleanup is uncertain; recovery state is retained");
      record.closureReceipt = value;
      record.confirmedClosed = true;
      compactPhysical(record);
    })();
    execution.stopPending = operation;
    try { await operation; }
    finally { if (execution.stopPending === operation) execution.stopPending = undefined; }
  }

  async function executePhysicalStart(command: RunStartCommand, binding: AllocationStartBinding,
    record: PhysicalStartRecord, controller: AbortController): Promise<void> {
    const payload = binding.payload;
    let materialized: MaterializedWorktree | undefined;
    let reservation: OwnedReservation | undefined;
    let admission: OwnedRunAdmission | undefined;
    let adapterInvoked = false;
    let physicalWorkEntered = false;
    let rejectionCode: NodeErrorCode = "process_start_failed";
    try {
      // Local authority is detached before any asynchronous work. Neither the
      // wire allocation base nor the legacy injected executor grants Git access.
      const baseRepo = workspaceConfig.worktreeBaseRepo;
      const allowedRoots = Object.freeze([...(workspaceConfig.allowedRoots ?? [])]);
      const gitOptions = snapshotGitOptions({ ...options.ownedGit, signal: controller.signal });
      const adapter = resolveAdapter(payload.runtime);
      if (!adapter) {
        rejectionCode = "runtime_missing";
        throw new Error(`no adapter for runtime '${payload.runtime}'`);
      }
      if (!isOwnedRunAdapter(adapter)) throw new Error("selected runtime lacks the complete authenticated owned-run startup/stop/status seam");
      // Capture the verified producer functions synchronously; later property
      // replacement cannot provide a fake stream or a different physical start.
      const startOwnedRun = adapter.startOwnedRun.bind(adapter);
      const stopOwnedRun = adapter.stopOwnedRun.bind(adapter);
      const inspectOwnedRun = adapter.inspectOwnedRun.bind(adapter);
      const streamEvents = adapter.streamEvents.bind(adapter);
      if (typeof baseRepo !== "string" || !baseRepo || allowedRoots.length === 0) {
        throw new Error("per-run allocation requires a local source repository and a nonempty local allowlist");
      }
      if (options.managedJournal) {
        const journal = options.managedJournal.journal;
        options.managedJournal.channel.assertCurrentSession(record.startupSession);
        controller.signal.throwIfAborted();
        const admitted = await journal.admitStart({ expectedNamespace: journal.namespace, runId: payload.run_id,
          idempotencyKey: command.idempotency_key, payload });
        if (admitted.kind !== "fresh") throw new Error(`Durable managed start is ${admitted.kind}; no new execution authority`);
        options.managedJournal.mixed?.bindRun(payload.run_id, "managed");
        record.managed = { permit: admitted.permit, settled: false, deliveryPending: true,
          delivery: new ManagedDelivery(journal, admitted.permit, nodeId, payload.run_id, options.managedJournal.channel) };
        await journal.advance(admitted.permit, "preparing");
      } else admission = createOwnedRunAdmission({ launchKey: binding.key, runId: payload.run_id, taskId: payload.task_id,
        agentInstanceId: payload.agent_instance_id, runtime: payload.runtime,
        workspaceRoot: payload.workspace.root, workspaceBranch: payload.workspace.branch! });
      const input = Object.freeze({ root: payload.workspace.root, basePath: payload.workspace_allocation!.base_path,
        agentInstanceId: payload.agent_instance_id, runId: payload.run_id, sourceRepo: baseRepo, allowedRoots });
      controller.signal.throwIfAborted();
      physicalWorkEntered = true;
      record.recovery.phase = "namespace";
      await provisionRunNamespace(input, gitOptions);
      record.recovery.phase = "preparing";
      const prepared = await prepareOwnedWorktree({ ...input, branch: payload.workspace.branch! }, gitOptions);
      record.recovery.phase = "reserving";
      reservation = await reserveOwnedWorktree(prepared);
      record.recovery.phase = "materializing";
      materialized = await materializeOwnedWorktree(reservation);
      record.recovery.phase = "adapter_startup";
      adapterInvoked = true;
      let handle: AgentInstanceHandle;
      if (record.managed) {
        const journal = options.managedJournal!.journal;
        options.managedJournal!.channel.assertCurrentSession(record.startupSession);
        controller.signal.throwIfAborted();
        await journal.advance(record.managed.permit, "launch_intent");
        const started = await journal.startOwnedProcess(record.managed.permit, adapter, materialized, controller.signal);
        handle = started.handle; admission = started.admission;
        // Retain genuine authority before recordStarted can fail or observe a
        // writer that already exited naturally during the awaited bridge.
        record.execution = { adapter, handle, admission, stopOwnedRun, inspectOwnedRun, streamEvents, deliveryPending: true };
        await journal.recordStarted(record.managed.permit, adapter, handle);
        controller.signal.throwIfAborted();
        options.managedJournal!.channel.assertCurrentSession(record.startupSession);
      } else handle = await startOwnedRun({ runId: payload.run_id, taskId: payload.task_id,
        agentInstanceId: payload.agent_instance_id, runtime: payload.runtime,
        workspaceRoot: payload.workspace.root, runStart: payload }, materialized, admission!, controller.signal);
      record.execution ??= { adapter, handle, admission: admission!, stopOwnedRun, inspectOwnedRun, streamEvents, deliveryPending: true };
      record.recovery.phase = "streaming";
      // Startup readiness is a historical fact, independently settled from ACK,
      // stream and authoritative receipt delivery. Later failures cannot rewrite it.
      settlePhysical(record, { kind: "started" });
      const plan: WorkspacePlan = { kind: "worktree", root: payload.workspace.root,
        branch: payload.workspace.branch!, baseRepo };
      const delivery: RunDelivery = { commandId: command.id, runId: payload.run_id,
        taskId: payload.task_id, workspaceRoot: payload.workspace.root };
      track(streamStartedRun(delivery, adapter, handle, plan, true, record));
      // No full command/ContextPack or genuine worktree handle enters the
      // permanently remembered startup outcome or delivery task's input.
      return;
    } catch (error) {
      if (record.managed) {
        const managed = record.managed;
        managed.failure ??= errorMessage(error).slice(0, 500);
        if (record.execution) {
          try { await managed.delivery.abort(new Error(managed.failure)); } catch { /* Storage unknown cannot skip the actual physical stop. */ }
          try { await stopPhysical(record); } catch { /* Preserve genuine uncertainty and execution state. */ }
          if (record.confirmedClosed && record.closureReceipt) {
            try {
              const closed = await options.managedJournal!.journal.settleOwnedProcess(managed.permit, record.execution.handle, record.closureReceipt,
                { terminal: { type: "run.lifecycle", payload: { phase: "failed", reason: managed.failure } }, retentionOutcome: "incomplete_delivery" });
              managed.run = closed; managed.settled = true; managed.delivery.useClosed(closed);
            } catch { /* Genuine stop can be known while durable settlement/delivery remains unknown. */ }
          }
          record.execution.deliveryPending = true;
        } else if (materialized) {
          try {
            const closed = await options.managedJournal!.journal.settleOwnedStartupFailure(managed.permit, materialized, error);
            managed.run = closed; managed.settled = true; record.confirmedClosed = true;
            managed.delivery.useClosed(closed);
          } catch { /* not_spawned or storage uncertainty never fabricates a physical settlement. */ }
        }
        settlePhysical(record, { kind: record.confirmedClosed ? "rejected" : "uncertain", code: rejectionCode, message: managed.failure });
        if (managed.settled) track(drainManagedRecord(record));
        if (!record.execution && !managed.settled) record.managed = undefined;
        compactPhysical(record); await acknowledgePhysicalStart(command.id, record.outcome!); return;
      }
      const receipt = adapterInvoked && materialized && admission
        ? getOwnedStartupReceipt(error, admission, materialized) : undefined;
      // This genuine handle came only from this attempt's fresh exclusive claim.
      // A not_spawned receipt alone would not authorize a foreign/occupied root.
      const adapterClosed = materialized !== undefined
        && (receipt?.kind === "not_spawned" || receipt?.kind === "confirmed_closed");
      const cancelledGitClosed = !adapterInvoked && reservation !== undefined
        && controller.signal.aborted && confirmedOwnedGitCleanup(error);
      record.confirmedClosed = adapterClosed || cancelledGitClosed;
      const kind = record.confirmedClosed
        ? (controller.signal.aborted || receipt?.cancellationRequested ? "cancelled" : "rejected")
        : physicalWorkEntered ? "uncertain" : "rejected";
      const message = `${errorMessage(error)}\nOwned attempt retained: ${JSON.stringify(record.recovery)}`;
      settlePhysical(record, { kind, code: rejectionCode, message });
      compactPhysical(record);
      await acknowledgePhysicalStart(command.id, record.outcome!);
    } finally {
      // Even an unexpected local proof/classification exception must release
      // matching duplicates and stop/resume waiters without claiming success.
      if (!record.outcome) {
        record.confirmedClosed = false;
        settlePhysical(record, { kind: "uncertain", code: "process_start_failed",
          message: `Owned startup could not establish its outcome; retained ${JSON.stringify(record.recovery)}` });
      }
    }
  }

  function beginPhysicalStart(command: RunStartCommand, binding: AllocationStartBinding): Promise<void> {
    let resolveReady!: (outcome: PhysicalStartupOutcome) => void;
    const controller = new AbortController();
    const record: PhysicalStartRecord = { identity: Object.freeze({ key: binding.key }),
      ready: new Promise<PhysicalStartupOutcome>((resolve) => { resolveReady = resolve; }),
      controller, confirmedClosed: false, startupSession: options.managedJournal?.channel.assertCurrentSession(),
      recovery: { runId: binding.payload.run_id, taskId: binding.payload.task_id,
        root: binding.payload.workspace.root, branch: binding.payload.workspace.branch!, phase: "admitted" } };
    record.resolveReady = resolveReady;
    // Install the strict identity and separately settled outcome before I/O.
    physicalStarts.set(binding.payload.run_id, record);
    launchBindings.set(binding.payload.run_id, record.identity);
    return executePhysicalStart(command, binding, record, controller);
  }

  function beginMixedLegacyStart(command: RunStartCommand, snapshot: { key: string; payload: RunStartPayload }): Promise<void> {
    const managed = options.managedJournal!, runId = snapshot.payload.run_id;
    let resolveReady!: (outcome: PhysicalStartupOutcome) => void;
    const record: MixedLegacyStartRecord = { key: snapshot.key, admitted: false, adapterInvoked: false,
      ready: new Promise<PhysicalStartupOutcome>((resolve) => { resolveReady = resolve; }),
      controller: new AbortController(), startupSession: managed.channel.assertCurrentSession() };
    record.resolveReady = resolveReady;
    // Reserve this process's attempt before journal I/O. Matching duplicates
    // join its outcome; neither a pending row nor an ACK grants another start.
    mixedLegacyStarts.set(runId, record);
    launchBindings.set(runId, undefined);
    starting.set(runId, record.ready.then(() => {}));
    return (async () => {
      try {
        assertMixedLegacyStartup(runId, record);
        const admitted = await managed.journal.admitStart({ expectedNamespace: managed.journal.namespace,
          runId, idempotencyKey: command.idempotency_key, payload: snapshot.payload });
        if (admitted.kind !== "fresh") throw new Error(`Durable ordinary start is ${admitted.kind}; no new execution authority`);
        if (admitted.run.namespace !== managed.journal.namespace || admitted.run.runId !== runId
          || admitted.run.mode !== "legacy" || admitted.run.launchKey !== snapshot.key) {
          throw new Error("Ordinary admission identity differs from the immutable start");
        }
        record.admitted = true;
        assertMixedLegacyStartup(runId, record);
        managed.mixed!.bindRun(runId, "legacy");
        // This permit is intentionally not used for a producer, event or physical
        // settlement. The retained legacy row grants no restart ownership.
        await executeStart({ ...command, payload: admitted.payload }, () => { starting.delete(runId); }, record);
      } catch (error) {
        if (record.outcome) throw error;
        const outcome: PhysicalStartupOutcome = { kind: record.adapterInvoked ? "uncertain"
          : record.controller?.signal.aborted || mixedStopIntents.has(runId) ? "cancelled" : "rejected",
          code: "process_start_failed", message: errorMessage(error) };
        settleMixedLegacy(record, outcome);
        await acknowledgePhysicalStart(command.id, outcome);
      } finally {
        if (!record.outcome) settleMixedLegacy(record, { kind: "uncertain", code: "process_start_failed",
          message: "Ordinary startup did not establish an outcome; its durable identity is retained" });
        starting.delete(runId);
      }
    })();
  }

  async function onRunStart(command: RunStartCommand): Promise<void> {
    let binding: AllocationStartBinding | undefined;
    let legacy: { key: string; payload: RunStartPayload } | undefined;
    try {
      binding = allocationStartBinding(command.payload, process.platform, transport.acknowledgesRunEvents);
      if (options.managedJournal) {
        options.managedJournal.channel.assertCurrentSession();
        if (options.managedJournal.mixed && command.idempotency_key !== `${command.payload.run_id}:start`) {
          throw new Error("Mixed execution requires the stable run start idempotency key");
        }
        if (!binding) {
          if (!options.managedJournal.mixed) throw new Error("Managed execution requires an explicit per-run allocation");
          legacy = snapshotMixedLegacyStart(command.payload);
        }
      }
    } catch (error) {
      await ackRejected(command.id, "process_start_failed", errorMessage(error));
      return;
    }
    // Per-run launches use the detached frozen snapshot, including after awaits.
    const launchCommand = binding || legacy ? { ...command, payload: (binding ?? legacy)!.payload } : command;
    const replayIdentity = binding ? Object.freeze({ key: binding.key }) : undefined;
    const runId = launchCommand.payload.run_id;
    const ordinary = mixedLegacyStarts.get(runId);
    if (ordinary) {
      if (!legacy || legacy.key !== ordinary.key) {
        await ackRejected(command.id, "process_start_failed", "run.start ordinary launch binding or execution mode changed"); return;
      }
      await acknowledgePhysicalStart(command.id, await ordinary.ready); return;
    }
    if (binding && options.managedJournal && finished.has(runId) && !launchBindings.has(runId)) {
      await ackRejected(command.id, "process_start_failed", "Durable stop-before-start fence denies a new managed launch"); return;
    }
    const physical = physicalStarts.get(runId);
    if (physical) {
      try { assertMatchingAllocationReplay(physical.identity, binding); }
      catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); return; }
      await acknowledgePhysicalStart(command.id, await physical.ready);
      return;
    }
    if (options.managedJournal?.mixed && mixedStopIntents.has(runId)) {
      await ackRejected(command.id, "process_start_failed", "Run-wide Stop intent denies a new launch"); return;
    }
    if (legacy) return beginMixedLegacyStart(launchCommand, legacy);
    if (starting.has(runId) || runs.has(runId) || finished.has(runId)) {
      try {
        if (launchBindings.has(runId)) assertMatchingAllocationReplay(launchBindings.get(runId), binding);
      } catch (error) {
        await ackRejected(command.id, "process_start_failed", errorMessage(error));
        return;
      }
      if (binding && starting.has(runId)) {
        await starting.get(runId);
        // A pending attempt is not an accepted launch if startup later rejects.
        if (!launchBindings.has(runId)) {
          await ackRejected(command.id, "process_start_failed", "original per-run startup did not acquire a run handle");
          return;
        }
      }
      await ackAccepted(command.id); // Retries never spawn another writer.
      return;
    }
    if (binding) {
      if (options.managedJournal?.mixed?.allowNewAllocations === false) {
        await ackRejected(command.id, "process_start_failed", "New per-run allocations are disabled on this worker"); return;
      }
      return beginPhysicalStart(launchCommand, binding);
    }
    let ready!: () => void;
    launchBindings.set(runId, replayIdentity);
    starting.set(runId, new Promise<void>((resolve) => { ready = resolve; }));
    try {
      await executeStart(launchCommand, () => { starting.delete(runId); ready(); });
    } finally {
      starting.delete(runId);
      if (!runs.has(runId) && !finished.has(runId)) launchBindings.delete(runId);
      ready();
    }
  }

  async function executeStart(command: RunStartCommand, ready: () => void, mixed?: MixedLegacyStartRecord): Promise<void> {
    const payload = command.payload;
    const rejectStart = async (code: NodeErrorCode, message: string): Promise<void> => {
      if (mixed) settleMixedLegacy(mixed, { kind: mixed.adapterInvoked ? "uncertain"
        : mixed.controller?.signal.aborted || mixedStopIntents.has(payload.run_id) ? "cancelled" : "rejected", code, message });
      await ackRejected(command.id, code, message);
    };
    const adapter = resolveAdapter(payload.runtime);
    if (!adapter) {
      await rejectStart("runtime_missing", `no adapter for runtime '${payload.runtime}'`);
      return;
    }

    // Prepare the workspace before the adapter starts. A branch-backed run
    // materializes a git worktree at workspace.root; a missing base repo or a
    // failed materialization rejects run.start without ever starting the adapter.
    const planResult = planWorkspace(payload.workspace, workspaceConfig);
    if (!planResult.ok) {
      await rejectStart(planResult.code, planResult.reason);
      return;
    }
    const plan = planResult.plan;
    // Validate an advertised raw branch even if legacy planning trims it empty.
    const typedRetention = payload.workspace.branch != null && payload.workspace_retention_reporting === "typed-v1";
    try {
      if (mixed) assertMixedLegacyStartup(payload.run_id, mixed);
      if (typedRetention) {
        if (transport.acknowledgesRunEvents !== true) {
          throw new Error("typed workspace retention requires committed run-event receipts");
        }
        // Reject unsupported identity before materialization or a writer starts.
        RunWorkspaceRetainedPayloadSchema.parse({ version: 1, workspace_root: plan.root,
          workspace_branch: payload.workspace.branch, outcome: "unconfirmed" });
      }
      assertWorkspaceScope(plan.root, payload.policy_snapshot.filesystem_write_scope);
      if (workspaceConfig.allowedRoots) {
        assertRealWorkspaceScope(plan.root, workspaceConfig.allowedRoots);
        if (plan.kind === "worktree") assertRealWorkspaceScope(plan.baseRepo, workspaceConfig.allowedRoots);
      }
      await materializeWorkspace(plan, git);
    } catch (err) {
      await rejectStart("process_start_failed", errorMessage(err));
      return;
    }

    let handle: AgentInstanceHandle;
    try {
      if (mixed) { assertMixedLegacyStartup(payload.run_id, mixed); mixed.adapterInvoked = true; }
      handle = await adapter.start({
        runId: payload.run_id,
        taskId: payload.task_id,
        agentInstanceId: payload.agent_instance_id,
        runtime: payload.runtime,
        workspaceRoot: payload.workspace.root,
        runStart: payload
      });
    } catch (err) {
      // start() can reject after a child already wrote files (for example, a
      // process guardian failed to launch). Preserve the materialized worktree
      // even when the adapter never returned a handle to this client.
      const recovery = plan.kind === "worktree" ? `\nWorktree retained for recovery: ${JSON.stringify({
        run_id: payload.run_id, task_id: payload.task_id, workspace_root: plan.root,
        workspace_branch: plan.branch, outcome: "process_start_failed",
      })}` : "";
      await rejectStart("process_start_failed", `${errorMessage(err)}${recovery}`);
      return;
    }
    runs.set(payload.run_id, { handle, adapter });
    if (mixed) settleMixedLegacy(mixed, { kind: "started" });
    ready();
    await streamStartedRun({ commandId: command.id, runId: payload.run_id, taskId: payload.task_id,
      workspaceRoot: payload.workspace.root }, adapter, handle, plan, typedRetention);
  }

  async function streamManagedRun(delivery: RunDelivery, handle: AgentInstanceHandle, physical: PhysicalStartRecord): Promise<void> {
    const managed = physical.managed!, journal = options.managedJournal!.journal;
    let delivered = false;
    const persist = async (settlement: TerminalSettlement): Promise<void> => {
      await stopPhysical(physical);
      if (!physical.confirmedClosed || !physical.closureReceipt) throw new Error("Managed settlement lacks the retained genuine closure object");
      const run = await journal.settleOwnedProcess(managed.permit, handle, physical.closureReceipt, settlement);
      managed.run = run; managed.settled = true; managed.delivery.useClosed(run);
      // Receipt is retained until the preceding real journal commit succeeds.
      physical.closureReceipt = undefined;
      await drainManagedRecord(physical); delivered = true;
    };
    try {
      await abortableOperation(boundedOperation(ackAccepted(delivery.commandId), 10000), managed.delivery.signal);
      const iterator = physical.execution!.streamEvents(handle)[Symbol.asyncIterator]();
      for (;;) {
        // A separate cancellation signal wakes even a silent producer. Do not
        // await iterator.return() before stopping the genuine writer: return
        // itself can wait behind the same blocked next(). Actual owned stop is
        // the cleanup authority, and the losing next Promise stays observed.
        const yielded = await abortableOperation(iterator.next(), managed.delivery.signal);
        managed.delivery.signal.throwIfAborted();
        if (yielded.done) break;
        const raw = adapterRunEventBodySchema.parse(yielded.value);
        if (raw.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(raw.payload.phase)) {
          // Only a terminal actually observed before our failure-stop is prior
          // runtime history. A cancellation emitted by that stop is not read
          // back and cannot turn a delivery failure into user cancellation.
          managed.observedTerminal = raw as TerminalSettlement["terminal"];
          const current = await journal.lookupRun({ expectedNamespace: journal.namespace, runId: delivery.runId });
          if (raw.payload.phase === "completed" && current?.liveAbort) throw new Error(current.liveAbort.message);
          await persist({ terminal: managed.observedTerminal, retentionOutcome: raw.payload.phase as "completed" | "failed" | "cancelled" });
          return;
        }
        const event = raw.type === "artifact.created" && options.uploadArtifact
          ? await boundedOperation(options.uploadArtifact(delivery.runId, delivery.workspaceRoot, raw), 30000) : raw;
        await managed.delivery.sendLive(event);
      }
      throw new Error("Managed stream ended without a terminal outcome");
    } catch (error) {
      if (managed.settled) throw error; // Closed correction/receipt state remains durable; never settle again.
      const prior = managed.observedTerminal;
      let storedAbort: JournalRun["liveAbort"] = null;
      try { storedAbort = (await journal.lookupRun({ expectedNamespace: journal.namespace, runId: delivery.runId }))?.liveAbort ?? null; }
      catch { /* Storage unavailable; still stop the genuine writer below. */ }
      const priorNonSuccess = prior && (prior.payload.phase === "failed" || prior.payload.phase === "cancelled") ? prior : undefined;
      const userCancelled = physical.userStopRequested === true && !storedAbort && !managed.failure;
      managed.failure ??= (storedAbort?.message ?? errorMessage(error)).slice(0, 500);
      try {
        if (userCancelled) await journal.latchLiveDeliveryAbort(managed.permit, { code: "user_cancelled", message: "User stop requested" });
        else await managed.delivery.abort(error);
      } catch { /* Persistence failure cannot skip physical stop or invent closure. */ }
      const terminal: TerminalSettlement["terminal"] = priorNonSuccess ?? { type: "run.lifecycle", payload: userCancelled
        ? { phase: "cancelled", reason: "user_cancelled" } : { phase: "failed", reason: managed.failure } };
      await persist({ terminal, retentionOutcome: terminal.payload.phase === "cancelled" ? "cancelled"
        : priorNonSuccess ? "failed" : "incomplete_delivery" });
    } finally {
      if (physical.execution) physical.execution.deliveryPending = !delivered;
      physical.recovery.phase = managed.settled ? "closed" : physical.confirmedClosed ? "physical_closed_journal_unknown" : "cleanup_uncertain";
      compactPhysical(physical);
    }
  }

  async function streamStartedRun(delivery: RunDelivery, adapter: RuntimeAdapter, handle: AgentInstanceHandle,
    plan: WorkspacePlan, typedRetention: boolean, physical?: PhysicalStartRecord): Promise<void> {
    if (physical?.managed) return streamManagedRun(delivery, handle, physical);
    let ownedStopAttempted = false;
    let sequence = 0;
    let retentionReported: WorkspaceRetentionOutcome | undefined;
    const reportRetainedWorkspace = async (outcome: WorkspaceRetentionOutcome): Promise<void> => {
      if (plan.kind !== "worktree") return;
      // Only completed delivery can need one subsequent correction. A timed-out
      // report may already have committed, so its correction uses a new sequence.
      if (retentionReported && !(retentionReported === "completed" && outcome === "incomplete_delivery")) return;
      retentionReported = outcome;
      if (typedRetention) {
        try {
          await transport.send({ kind: "run.event", node_id: nodeId, run_id: delivery.runId, sequence: sequence++,
            event: { type: "run.workspace.retained", payload: { version: 1, workspace_root: plan.root,
              workspace_branch: plan.branch, outcome } },
          });
        } catch (error) {
          // Success requires committed typed evidence; other outcomes preserve
          // the actual failure/cancellation even if metadata delivery fails.
          if (outcome === "completed") throw error;
        }
      }
      // Keep the legacy diagnostic readable, without treating runtime text as
      // retention authority. In typed mode this diagnostic is only best-effort.
      try {
        const diagnostic = transport.send({ kind: "run.event", node_id: nodeId, run_id: delivery.runId, sequence: sequence++,
          event: { type: "run.output", payload: { stream: "stderr", text: `Worktree retained for recovery: ${JSON.stringify({
            run_id: delivery.runId, task_id: delivery.taskId, workspace_root: plan.root,
            workspace_branch: plan.branch, outcome,
          })}` } },
        }, typedRetention ? { delivery: "best-effort" } : undefined);
        // Typed metadata already supplies the durable authority. Never wait on
        // the optional diagnostic, including transports that ignore the option.
        if (typedRetention) void diagnostic.catch(() => {});
        else await diagnostic;
      } catch (error) {
        if (!typedRetention && outcome === "completed") { retentionReported = undefined; throw error; }
      }
    };
    try {
      await ackAccepted(delivery.commandId);
      const stream = physical ? physical.execution!.streamEvents(handle) : adapter.streamEvents(handle);
      for await (const yielded of stream) {
        // Custom adapters and child output have no authority to report retention.
        const rawEvent = adapterRunEventBodySchema.parse(yielded);
        if (rawEvent.type === "run.lifecycle" && (rawEvent.payload.phase === "completed" || rawEvent.payload.phase === "failed" || rawEvent.payload.phase === "cancelled")) {
          if (physical) {
            ownedStopAttempted = true;
            await stopPhysical(physical);
          }
          await reportRetainedWorkspace(rawEvent.payload.phase);
        }
        const event = rawEvent.type === "artifact.created" && options.uploadArtifact
          ? await options.uploadArtifact(delivery.runId, delivery.workspaceRoot, rawEvent) : rawEvent;
        const message: RunEventMessage = {
          kind: "run.event",
          node_id: nodeId,
          run_id: delivery.runId,
          sequence: sequence,
          event
        };
        sequence += 1;
        await transport.send(message);
      }
    } catch (error) {
      // Preserve the worktree when a deliverable could not be safely transferred.
      // A delivery error can occur while the process is still writing. Confirm
      // process stop before reporting failure and allowing lease release.
      if (physical) {
        if (!ownedStopAttempted) { ownedStopAttempted = true; await stopPhysical(physical); }
        else if (!physical.confirmedClosed) throw error;
      }
      else await stopLegacyRun(delivery.runId, { handle, adapter });
      await reportRetainedWorkspace("incomplete_delivery");
      await transport.send({
        kind: "run.event", node_id: nodeId, run_id: delivery.runId, sequence: sequence++,
        event: { type: "run.lifecycle", payload: { phase: "failed", reason: errorMessage(error) } },
      }).catch(() => {});
    } finally {
      if (!physical) {
        finished.add(delivery.runId);
        const ordinary = mixedLegacyStarts.get(delivery.runId);
        // Stream completion does not erase a mixed run's remaining Stop
        // authority while persistence or an adapter Stop is still pending.
        const awaitingRequestedStop = ordinary && mixedStopIntents.has(delivery.runId) && !ordinary.stopCompleted;
        if (!awaitingRequestedStop && !ordinary?.stopFailure && !ordinary?.stopPending) runs.delete(delivery.runId);
        // Artifacts do not certify that all modified/new/ignored bytes are saved.
        await reportRetainedWorkspace("unconfirmed");
      } else {
        try {
          // Stream completion alone does not prove guardian/group closure.
          if (!physical.confirmedClosed && !ownedStopAttempted) await stopPhysical(physical);
        } finally {
          try { await reportRetainedWorkspace("unconfirmed"); }
          finally {
            if (physical.execution) physical.execution.deliveryPending = false;
            physical.recovery.phase = physical.confirmedClosed ? "closed" : "cleanup_uncertain";
            compactPhysical(physical);
          }
        }
      }
    }
  }

  async function requestManagedRunStop(runId: string): Promise<void> {
    const physical = physicalStarts.get(runId);
    if (!options.managedJournal || !physical?.managed) throw new Error("Local Stop requires this Node's owned managed run");
    const managed = physical.managed;
    physical.controller?.abort();
    if (!managed.failure && !managed.settled) physical.userStopRequested = true;
    managed.delivery.cancelUnexposed(new DeliveryCancelled("User stop requested"));
    try { await options.managedJournal.journal.requestStop({ expectedNamespace: options.managedJournal.journal.namespace, runId }); }
    catch (error) {
      await physical.ready;
      try { await stopPhysical(physical); } catch { /* Preserve unknown closure while surfacing the original storage error. */ }
      throw error;
    }
    await physical.ready;
    await stopPhysical(physical);
  }

  async function onRunStop(command: RunStopCommand): Promise<void> {
    const runId = command.payload.run_id;
    if (options.managedJournal?.mixed) mixedStopIntents.add(runId);
    const ordinary = mixedLegacyStarts.get(runId);
    if (ordinary) {
      ordinary.controller?.abort(new DeliveryCancelled("User stop requested before ordinary startup"));
      let storageFailure: unknown;
      let storageFailed = false;
      let stopped: JournalRun | undefined;
      try {
        const journal = options.managedJournal!.journal;
        stopped = await journal.requestStop({ expectedNamespace: journal.namespace, runId, expectedKey: ordinary.key });
      } catch (error) { storageFailed = true; storageFailure = error; }
      // Even failed persistence cannot revoke the captured legacy stop handle.
      await ordinary.ready;
      try {
        const run = runs.get(runId);
        if (run) await stopLegacyRun(runId, run);
        else if (!ordinary.admitted && stopped?.receipt?.kind !== "run_fenced_unbound" && stopped?.receipt?.kind !== "not_started_fenced") {
          throw new Error("Durable ordinary ownership is unknown; stop is not confirmed");
        }
        else if (ordinary.stopFailure) throw new Error(ordinary.stopFailure);
        else if (ordinary.adapterInvoked && ordinary.outcome?.kind !== "started" && !ordinary.stopCompleted) {
          throw new Error("Ordinary startup invoked its adapter without a returned handle; stop remains uncertain");
        }
        if (storageFailed) throw storageFailure;
        await ackAccepted(command.id);
      } catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); }
      return;
    }
    const physical = physicalStarts.get(command.payload.run_id);
    if (physical?.managed) {
      try { await requestManagedRunStop(command.payload.run_id); await ackAccepted(command.id); }
      catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); }
      return;
    }
    physical?.controller?.abort(); // Stop startup promptly, before any journal await.
    if (options.managedJournal && !runs.has(command.payload.run_id) && !starting.has(command.payload.run_id)
      && !(launchBindings.has(command.payload.run_id) && launchBindings.get(command.payload.run_id) === undefined)) {
      if (physical && !physical.managed?.failure) physical.userStopRequested = true;
      physical?.managed?.delivery.cancelUnexposed(new DeliveryCancelled("User stop requested"));
      const journal = options.managedJournal.journal;
      try {
        const stopped = await journal.requestStop({ expectedNamespace: journal.namespace, runId: command.payload.run_id });
        if (!physical?.execution && (stopped.receipt?.kind === "run_fenced_unbound" || stopped.receipt?.kind === "not_started_fenced")) {
          finished.add(command.payload.run_id); await ackAccepted(command.id); return;
        }
      }
      catch (error) {
        // A database failure does not revoke the actual captured stop authority.
        if (physical) { physical.controller?.abort(); await physical.ready; try { await stopPhysical(physical); } catch { /* reported uncertain below */ } }
        await ackRejected(command.id, "process_start_failed", errorMessage(error)); return;
      }
      if (!physical) {
        const durable = await journal.lookupRun({ expectedNamespace: journal.namespace, runId: command.payload.run_id });
        if (durable?.receipt?.kind === "run_fenced_unbound" || durable?.receipt?.kind === "not_started_fenced") { await ackAccepted(command.id); return; }
        await ackRejected(command.id, "process_start_failed", "Durable live ownership is unknown; stop is not confirmed"); return;
      }
    }
    if (physical) {
      // Signal the actual shared startup controller before waiting for readiness.
      physical.controller?.abort();
      await physical.ready;
      try { await stopPhysical(physical); await ackAccepted(command.id); }
      catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); }
      return;
    }
    await starting.get(command.payload.run_id);
    const run = runs.get(command.payload.run_id);
    if (!run && !finished.has(command.payload.run_id)) {
      // A cancellation can race ahead of run.start. Record the tombstone before
      // acknowledging absence, so a later start for this run cannot spawn.
      finished.add(command.payload.run_id);
      await ackAccepted(command.id);
      return;
    }
    try {
      if (run) await run.adapter.stop(run.handle, "user_cancelled");
      await ackAccepted(command.id);
    } catch (error) {
      await ackRejected(command.id, "process_exited", errorMessage(error));
    }
  }

  // #115 P2-S3b: resume an already-active run after a reconnect. This handler is
  // deliberately narrow: it does not implement WebSocket reconnect or outbound
  // event buffering, and it NEVER rebuilds or starts a process. It only reports
  // whether the run's handle is still live in this client. Alive → ack accepted
  // (the existing streamEvents loop keeps flowing). Lost → ack rejected
  // (process_exited), and the server maps that to the daemon_disconnect path.
  async function onRunResume(command: RunResumeCommand): Promise<void> {
    const ordinary = mixedLegacyStarts.get(command.payload.run_id);
    if (ordinary) {
      const outcome = await ordinary.ready;
      // A rejected journal admission does not make the durable owner's process
      // absent. Let the checked recovery path below inspect that original row.
      if (ordinary.admitted) {
        if (ordinary.stopFailure || outcome.kind === "uncertain") {
          await ackRejected(command.id, "process_start_failed", ordinary.stopFailure
            ?? (outcome.kind === "uncertain" ? outcome.message : "Ordinary stop remains uncertain"));
        } else if (outcome.kind === "started" && runs.has(command.payload.run_id)) {
          await ackAccepted(command.id);
        } else {
          await ackRejected(command.id, "process_exited", "Ordinary run has no active handle in this client");
        }
        return;
      }
    }
    const physical = physicalStarts.get(command.payload.run_id);
    if (physical) {
      await physical.ready;
      if (physical.managed?.settled && physical.managed.run) {
        const run = physical.managed.run, journal = options.managedJournal!.journal;
        try {
          const state = await journal.inspectClosedRunDelivery({ expectedNamespace: journal.namespace, runId: run.runId,
            launchKey: run.launchKey!, physicalReceiptId: run.receipt!.id });
          if (state.state === "delivered") {
            physical.managed.deliveryPending = false;
            if (physical.execution) physical.execution.deliveryPending = false;
            compactPhysical(physical); await ackRejected(command.id, "process_exited", "owned execution and durable delivery are closed"); return;
          }
          if (state.state === "blocked") { await ackRejected(command.id, "process_start_failed", "Durable delivery remains blocked"); return; }
          track(drainManagedRecord(physical));
          await ackAccepted(command.id); return; // Durable delivery-only resume needs no live handle.
        } catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); return; }
      }
      const execution = physical.execution;
      if (!execution) {
        await ackRejected(command.id, physical.confirmedClosed ? "process_exited" : "process_start_failed",
          physical.confirmedClosed ? "owned execution and delivery are closed"
            : "owned startup has no authenticated current status; recovery state is retained");
        return;
      }
      try {
        if (physical.managed) await options.managedJournal!.journal.lookupRun({ expectedNamespace: options.managedJournal!.journal.namespace, runId: command.payload.run_id });
        const value = await execution.inspectOwnedRun(execution.handle, execution.admission);
        const receipt = getOwnedRunStatusReceipt(value, execution.admission, execution.handle);
        if (receipt?.kind === "confirmed_closed") { physical.confirmedClosed = true; physical.closureReceipt = value; }
        if ((receipt?.kind === "running" || receipt?.kind === "confirmed_closed") && execution.deliveryPending) {
          // This ACK means this client still owns a resumable execution/delivery.
          // A closed child can have real terminal events awaiting committed receipts.
          await ackAccepted(command.id);
        } else if (receipt?.kind === "confirmed_closed") {
          compactPhysical(physical);
          await ackRejected(command.id, "process_exited", "owned execution and delivery are closed");
        } else {
          await ackRejected(command.id, "process_start_failed", "owned execution status or delivery is uncertain; no absence is claimed");
        }
      } catch (error) {
        await ackRejected(command.id, "process_start_failed", errorMessage(error));
      }
      return;
    }
    if (options.managedJournal) {
      const journal = options.managedJournal.journal;
      const durable = await journal.lookupRun({ expectedNamespace: journal.namespace, runId: command.payload.run_id });
      if (durable && !runs.has(command.payload.run_id)) {
        if (durable.mode === "per-run" && durable.phase === "closed" && durable.receipt?.kind === "process_exit_confirmed" && durable.launchKey) {
          const state = await journal.inspectClosedRunDelivery({ expectedNamespace: journal.namespace, runId: durable.runId,
            launchKey: durable.launchKey, physicalReceiptId: durable.receipt.id });
          if (state.state === "delivered") { await ackRejected(command.id, "process_exited", "Durable closed delivery is complete"); return; }
          if (state.state === "blocked") { await ackRejected(command.id, "process_start_failed", "Durable closed delivery is blocked"); return; }
          options.managedJournal.mixed?.bindRun(durable.runId, "managed");
          let delivery = closedDeliveries.get(durable.runId);
          if (!delivery) {
            delivery = new ManagedDelivery(journal, undefined, nodeId, durable.runId, options.managedJournal.channel);
            delivery.useClosed(durable); closedDeliveries.set(durable.runId, delivery);
          }
          track(delivery.drainClosed()); await ackAccepted(command.id); return;
        }
        await ackRejected(command.id, "process_start_failed", "Durable restart ownership remains unknown; this client cannot adopt a writer"); return;
      }
    }
    // Workspace/materialization or adapter.start may still be in flight after
    // reconnect. Absence from the live map is not proof of exit until that
    // start has either installed its process handle or definitively failed.
    await starting.get(command.payload.run_id);
    if (runs.has(command.payload.run_id)) {
      await ackAccepted(command.id);
    } else {
      await ackRejected(command.id, "process_exited", `run ${command.payload.run_id} is not active on this node`);
    }
  }

  async function dispatch(message: ServerToNodeMessage): Promise<void> {
    switch (message.type) {
      case "run.start":
        return onRunStart(message);
      case "run.stop":
        return onRunStop(message);
      case "artifact.collect":
        return ackAccepted(message.id);
      case "run.resume":
        return onRunResume(message);
      case "run.event.ack":
        return; // WebSocket transport owns persisted-event acknowledgements.
      case "node.session.ready":
      case "node.session.pong":
        return; // Only the managed transport may establish session usability.
    }
  }

  const client: NodeClient = {
    requestManagedRunStop,
    invalidateManagedStartupSession(session, cause): void {
      for (const physical of physicalStarts.values()) {
        if (physical.controller && physical.startupSession && (!session || physical.startupSession === session)) physical.controller.abort(cause);
      }
      for (const ordinary of mixedLegacyStarts.values()) {
        if (ordinary.controller && ordinary.startupSession && (!session || ordinary.startupSession === session)) ordinary.controller.abort(cause);
      }
    },
    async failManagedConnection(cause): Promise<void> {
      // Latch cause and wake/cancel all owned consumers synchronously, before
      // the first awaited stop or database write. A resulting producer cancel
      // is not read back as an earlier user-cancelled terminal.
      for (const physical of physicalStarts.values()) {
        physical.controller?.abort(cause);
        if (physical.managed) {
          if (!physical.managed.settled && !physical.userStopRequested) physical.managed.failure ??= errorMessage(cause).slice(0, 500);
          physical.managed.delivery.cancelUnexposed(cause);
        }
      }
      for (const delivery of closedDeliveries.values()) delivery.cancelUnexposed(cause);
      await client.stop(true);
    },
    start(): void {
      unsubscribe = transport.subscribe((message) => {
        track(dispatch(message));
      });
    },
    async stop(cancelRunning = false): Promise<void> {
      unsubscribe?.();
      unsubscribe = undefined;
      if (cancelRunning) {
        for (const [runId, ordinary] of mixedLegacyStarts) {
          mixedStopIntents.add(runId);
          ordinary.controller?.abort(new DeliveryCancelled("Node shutdown requested"));
        }
        for (const physical of physicalStarts.values()) {
          physical.controller?.abort();
          physical.managed?.delivery.cancelUnexposed(new DeliveryCancelled("Node shutdown requested"));
        }
        for (const delivery of closedDeliveries.values()) delivery.cancelUnexposed(new DeliveryCancelled("Node shutdown requested"));
        await Promise.allSettled([...physicalStarts.values()].map((physical) => physical.ready));
        await Promise.allSettled([...starting.values()]);
        const stopped = await Promise.allSettled([
          ...[...runs.entries()].map(([runId, run]) => stopLegacyRun(runId, run)),
          ...[...mixedLegacyStarts.entries()]
            .filter(([runId, ordinary]) => !runs.has(runId) && (ordinary.stopFailure
              || (ordinary.adapterInvoked && ordinary.outcome?.kind !== "started" && !ordinary.stopCompleted)))
            .map(([, ordinary]) => Promise.reject(new Error(ordinary.stopFailure ?? "Ordinary startup closure remains uncertain; durable identity is retained"))),
          ...[...physicalStarts.values()]
            .filter((physical) => physical.execution || physical.outcome?.kind === "uncertain")
            .map((physical) => stopPhysical(physical)),
        ]);
        const failure = stopped.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      await Promise.allSettled([...inflight]);
    }
  };
  return client;
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : "process start failed";
}

/** Same canonical legacy payload identity as journal.admitStart, detached before I/O. */
function snapshotMixedLegacyStart(input: RunStartPayload): { readonly key: string; readonly payload: RunStartPayload } {
  const payload = RunStartPayloadSchema.parse(input);
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child !== null && typeof child === "object") freeze(child);
    Object.freeze(value);
  };
  freeze(payload);
  return Object.freeze({ key: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), payload });
}

/** Recognize only the real shared runner's typed cleanup facts, never error text. */
function confirmedOwnedGitCleanup(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  let receipts = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (item instanceof OwnedGitError) {
      receipts += 1;
      if (!item.receipt.cleanupConfirmed || !item.receipt.observersDisposed) return false;
    }
    const nested = item as { cause?: unknown; errors?: unknown[] };
    pending.push(nested.cause, ...(Array.isArray(nested.errors) ? nested.errors : []));
  }
  return receipts > 0;
}
