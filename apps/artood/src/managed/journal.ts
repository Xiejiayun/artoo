import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { RunStartPayloadSchema, type RunStartPayload } from "@artoo/domain";
import { runEventBodySchema, type AgentInstanceHandle, type RuntimeAdapter } from "@artoo/protocol";
import { allocationStartBinding } from "../node-allocation-identity.js";
import { createOwnedRunAdmission, getOwnedRunStatusReceipt, getOwnedStopReceipt, getOwnedStartupReceipt, isOwnedRunAdapter,
  type OwnedAdmissionIdentity, type OwnedRunAdmission, type OwnedRunRuntimeAdapter } from "../process-adapter.js";
import type { MaterializedWorktree } from "../owned/worktree-reservation.js";
import { nonempty } from "./journal-boundary.js";
import type { AdmissionResult, LiveDeliveryClaim, LiveDeliveryView, ClosedRunDeliveryScope, ClosedRunDeliveryView, ClosedRunDeliveryClaim, FreshLaunchPermit, Journal, JournalLocation, JournalOptions, JournalRun, StoredEvent, TerminalSettlement } from "./journal-types.js";
export type * from "./journal-types.js";

interface Reply { kind: string; id?: string; value?: unknown; message?: string; namespace?: string;
  incarnation?: string; pragmas?: Record<string, string | number> }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; deadline: number; timer: ReturnType<typeof setTimeout> }
function snapshotLocation(input: JournalLocation): JournalLocation {
  const { directory, controllerScope, nodeId } = input;
  nonempty(directory, "directory"); nonempty(controllerScope, "controller scope"); nonempty(nodeId, "node ID");
  return Object.freeze({ directory, controllerScope, nodeId });
}
function freeze(value: object): void {
  for (const child of Object.values(value)) if (child !== null && typeof child === "object") freeze(child);
  Object.freeze(value);
}
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Owned journal worker closure remains uncertain")), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

class JournalWorker {
  readonly worker: Worker;
  readonly ready: Promise<Reply>;
  readonly exited: Promise<number>;
  readonly controlKey = randomUUID();
  readonly pending = new Map<string, Pending>();
  private resolveFailure!: (error: Error) => void;
  readonly failed = new Promise<Error>((resolve) => { this.resolveFailure = resolve; });
  private failure: Error | undefined;
  private unavailable = false;
  private closing = false;
  private provisioned = false;
  private closeWork: Promise<void> | undefined;
  private exitCode: number | undefined;
  private readonly timeout: number;
  constructor(action: "provision" | "open", location: JournalLocation, expectedNamespace?: string, timeout = 5000) {
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 10000) throw new Error("Journal request deadline must be within 1–10000ms");
    this.timeout = timeout;
    this.worker = new Worker(new URL("./journal-worker.js", import.meta.url), {
      workerData: { action, ...location, expectedNamespace, controlKey: this.controlKey },
    });
    this.exited = new Promise((resolve) => this.worker.once("exit", (code) => {
      this.exitCode = code; resolve(code);
      if (code !== 0) this.fail(new Error(`Journal worker exited with code ${code}; ownership is unknown`));
      else if (!this.closing && !(action === "provision" && this.provisioned)) this.fail(new Error("Journal worker exited; ownership is unknown"));
    }));
    const startDeadline = performance.now() + 10000;
    this.ready = new Promise((resolve, reject) => {
      let initialized = false;
      const timer = setTimeout(() => { const error = new Error("Journal initialization deadline expired"); this.fail(error); reject(error); }, 10000);
      this.worker.on("message", (reply: Reply) => {
        if (reply.kind === "ready" || reply.kind === "provisioned") {
          clearTimeout(timer);
          if (performance.now() > startDeadline || this.unavailable) {
            const error = new Error("Late initialization cannot establish journal availability"); this.fail(error); reject(error);
          }
          else { initialized = true; this.provisioned = reply.kind === "provisioned"; resolve(reply); }
        } else if (reply.kind === "failed") {
          clearTimeout(timer); const error = new Error(reply.message ?? "Journal initialization failed"); this.fail(error); reject(error);
        }
        if (!reply.id) return;
        const request = this.pending.get(reply.id);
        if (!request) return; // A timed-out or abandoned reply never grants a permit.
        if (performance.now() > request.deadline) { this.fail(new Error("Late journal commit reply; outcome is unknown")); return; }
        clearTimeout(request.timer); this.pending.delete(reply.id);
        if (reply.kind === "result" && !this.unavailable) request.resolve(reply.value);
        else { const error = new Error(reply.message ?? "Journal storage unavailable"); this.fail(error); request.reject(error); }
      });
      this.worker.on("error", (error) => { clearTimeout(timer); this.fail(error); reject(error); });
      void this.exited.then((code) => {
        clearTimeout(timer);
        if (!initialized) reject(new Error(`Journal worker exited before initialization receipt (${code})`));
      });
    });
  }
  assertAvailable(): void {
    if (this.unavailable || this.closing || this.exitCode !== undefined) throw new Error("Journal unavailable; no execution authority is granted");
  }
  private fail(error: Error): void {
    if (!this.failure) { this.failure = error; this.resolveFailure(error); }
    this.makeUnavailable(error);
  }
  private makeUnavailable(error: Error): void {
    this.unavailable = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  call<T>(op: string, input: Record<string, unknown>): Promise<T> {
    this.assertAvailable();
    const id = randomUUID(), deadline = performance.now() + this.timeout;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Journal operation deadline expired; commit may have occurred")), this.timeout);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, deadline, timer });
      try { this.worker.postMessage({ id, controlKey: this.controlKey, op, input }); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true;
    this.makeUnavailable(new Error("Journal closed; outstanding operations retain unknown outcomes"));
    this.closeWork = (async () => {
      try {
        if (this.exitCode === undefined) this.worker.postMessage({ id: randomUUID(), controlKey: this.controlKey, op: "close", input: {} });
        const code = await bounded(this.exited, 5000);
        if (code !== 0) throw new Error(`Journal worker closed with code ${code}`);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.fail(error);
        if (this.exitCode === undefined) {
          try { await bounded(this.worker.terminate(), 5000); }
          catch (cleanup) { throw new AggregateError([error, cleanup], `${error.message}; journal worker termination also failed`, { cause: error }); }
        }
        throw error;
      }
    })();
    return this.closeWork;
  }
}

/** Explicit creation only. Existing/partial directories are retained and rejected. */
export async function provisionLocalJournal(input: JournalLocation): Promise<{ readonly namespace: string; readonly pragmas: Readonly<Record<string, string | number>> }> {
  const worker = new JournalWorker("provision", snapshotLocation(input));
  try {
    const ready = await worker.ready;
    if (ready.kind !== "provisioned" || !ready.namespace || !ready.pragmas) throw new Error("Missing explicit provision receipt");
    const code = await bounded(worker.exited, 5000);
    if (code !== 0) throw new Error("Provision worker did not close successfully");
    return Object.freeze({ namespace: ready.namespace, pragmas: Object.freeze(ready.pragmas) });
  } catch (error) {
    try { await worker.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${error instanceof Error ? error.message : "Journal provisioning failed"}; journal cleanup also failed`, { cause: error }); }
    throw error;
  }
}

interface PermitState {
  readonly nonce: string; readonly key: string; readonly runId: string; readonly mode: "per-run" | "legacy";
  readonly identity?: OwnedAdmissionIdentity;
  payload: RunStartPayload | undefined;
  revision: number; phase: JournalRun["phase"]; tail: Promise<void>;
  admission?: OwnedRunAdmission; handle?: AgentInstanceHandle; closedHandle?: WeakRef<AgentInstanceHandle>;
  recordedStarted: boolean; recordedClosed: boolean;
  startClaimed: boolean; bridgeAdapter?: RuntimeAdapter; bridgeWorktree?: WeakRef<MaterializedWorktree>;
  inspect?: OwnedRunRuntimeAdapter["inspectOwnedRun"];
}
export async function openLocalJournal(options: JournalOptions): Promise<Journal> {
  const location = snapshotLocation(options), namespace = options.expectedNamespace;
  nonempty(namespace, "expected namespace");
  const worker = new JournalWorker("open", location, namespace, options.operationTimeoutMs);
  let ready: Reply;
  try {
    ready = await worker.ready;
    if (ready.namespace !== namespace || !ready.incarnation || !ready.pragmas) throw new Error("Unexpected journal identity");
  } catch (error) {
    try { await worker.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${error instanceof Error ? error.message : "Journal open failed"}; journal cleanup also failed`, { cause: error }); }
    throw error;
  }
  const permits = new WeakMap<FreshLaunchPermit, PermitState>();
  const checkNamespace = (expected: string) => { if (expected !== namespace) throw new Error("Expected ownership namespace differs"); };
  const query = (input: { expectedNamespace: string; runId: string }) => { checkNamespace(input.expectedNamespace); nonempty(input.runId, "run ID"); return input.runId; };
  const deliveryScope = (input: ClosedRunDeliveryScope) => {
    const runId = query(input); nonempty(input.launchKey, "launch key"); nonempty(input.physicalReceiptId, "physical receipt ID");
    return { runId, key: input.launchKey, physicalReceiptId: input.physicalReceiptId };
  };
  const stateFor = (permit: FreshLaunchPermit): PermitState => {
    worker.assertAvailable(); const state = permits.get(permit);
    if (!state) throw new Error("An exact live fresh journal permit is required"); return state;
  };
  const inputFor = (state: PermitState) => ({ runId: state.runId, key: state.key, nonce: state.nonce });
  const update = (state: PermitState, run: JournalRun) => { state.revision = run.revision; state.phase = run.phase; };
  function serialize<T>(permit: FreshLaunchPermit, operation: (state: PermitState) => Promise<T>): Promise<T> {
    const state = stateFor(permit);
    const task = state.tail.then(() => { worker.assertAvailable(); return operation(state); });
    state.tail = task.then(() => {}, () => {}); return task;
  }
  function snapshotSettlement(input: TerminalSettlement): TerminalSettlement {
    const terminal = runEventBodySchema.parse(input.terminal);
    if (terminal.type !== "run.lifecycle" || !["completed", "failed", "cancelled"].includes(terminal.payload.phase)) throw new Error("A terminal lifecycle outcome is required");
    const outcome = input.retentionOutcome;
    if (terminal.payload.phase === "completed" ? outcome !== "completed"
      : terminal.payload.phase === "cancelled" ? outcome !== "cancelled"
      : !["failed", "incomplete_delivery"].includes(outcome)) throw new Error("Terminal and retention outcome differ");
    const result = { terminal: terminal as TerminalSettlement["terminal"], retentionOutcome: outcome };
    freeze(result); return result;
  }
  async function persistSettlement(state: PermitState, proofSource: "returned_handle" | "startup_error", detail: unknown, settlement: TerminalSettlement): Promise<JournalRun> {
    if (!state.identity) throw new Error("A frozen physical workspace identity is required");
    const retained = runEventBodySchema.parse({ type: "run.workspace.retained", payload: { version: 1,
      workspace_root: state.identity.workspaceRoot, workspace_branch: state.identity.workspaceBranch, outcome: settlement.retentionOutcome } });
    const outcome = JSON.stringify({ terminal: settlement.terminal, retained });
    if (Buffer.byteLength(outcome) > 1024 * 1024) throw new Error("Settlement exceeds the bounded journal payload size");
    const result = await worker.call<JournalRun>("producer_closed", { ...inputFor(state), proofSource, detail, outcome,
      eventContents: [JSON.stringify(retained), JSON.stringify(settlement.terminal)] });
    update(state, result); state.recordedClosed = true;
    if (state.handle) state.closedHandle = new WeakRef(state.handle);
    state.handle = undefined; state.inspect = undefined; state.bridgeAdapter = undefined;
    return result;
  }
  return Object.freeze({
    namespace, incarnation: ready.incarnation, pragmas: Object.freeze(ready.pragmas), failed: worker.failed,
    async admitStart(request): Promise<AdmissionResult> {
      const runId = query(request);
      if (request.idempotencyKey !== `${runId}:start`) throw new Error("Managed delivery requires the stable run start idempotency key");
      const parsed = RunStartPayloadSchema.parse(request.payload);
      if (parsed.run_id !== runId) throw new Error("Journal run ID and payload differ");
      const binding = allocationStartBinding(parsed, process.platform, true), payload = binding?.payload ?? parsed;
      freeze(payload);
      const canonical = JSON.stringify(payload), key = binding?.key ?? createHash("sha256").update(canonical).digest("hex");
      if (Buffer.byteLength(canonical) > 1024 * 1024) throw new Error("Launch snapshot exceeds the bounded journal payload size");
      const mode = binding ? "per-run" : "legacy", nonce = randomUUID();
      const result = await worker.call<{ kind: AdmissionResult["kind"]; run: JournalRun }>("admit", { runId, mode, key, canonical, nonce });
      worker.assertAvailable();
      if (result.kind !== "fresh") return result as Exclude<AdmissionResult, { kind: "fresh" }>;
      const permit = Object.freeze({}) as FreshLaunchPermit;
      const identity = binding ? Object.freeze({ launchKey: key, runId, taskId: payload.task_id,
        agentInstanceId: payload.agent_instance_id, runtime: payload.runtime, workspaceRoot: payload.workspace.root,
        workspaceBranch: payload.workspace.branch! }) : undefined;
      permits.set(permit, { nonce, key, runId, mode, payload, ...(identity ? { identity } : {}), revision: result.run.revision, phase: result.run.phase,
        tail: Promise.resolve(), recordedStarted: false, recordedClosed: false, startClaimed: false });
      return Object.freeze({ kind: "fresh", permit, run: result.run, payload });
    },
    async lookupRun(request) { return worker.call<JournalRun | null>("lookup", { runId: query(request) }); },
    advance(permit, phase) { return serialize(permit, async (state) => {
      const result = await worker.call<{ kind: string; run: JournalRun }>("advance", { ...inputFor(state), revision: state.revision, phase });
      update(state, result.run);
      if (result.kind !== "advanced") throw new Error("Journal stage was already used, changed or stopped; no side effect is authorized");
      return result.run;
    }); },
    async requestStop(request) {
      const runId = query(request), key = request.expectedKey;
      if (key !== undefined && !/^[a-f0-9]{64}$/u.test(key)) throw new Error("Invalid expected launch key");
      const result = await worker.call<{ kind: string; run: JournalRun }>("stop", { runId, key });
      if (result.kind === "conflict") throw new Error("Stop launch key differs from the durable owner");
      return result.run;
    },
    async startOwnedProcess(permit, adapter, worktree, signal) {
      const state = stateFor(permit);
      if (state.mode !== "per-run" || !state.identity || !state.payload || state.phase !== "launch_intent" || state.startClaimed) throw new Error("One unused committed launch_intent is required for the trusted start bridge");
      // Claim synchronously, before the first await; a failed invocation can
      // never regain this chance. Capture genuine methods at this same boundary.
      state.startClaimed = true;
      const payload = state.payload;
      try {
        if (!isOwnedRunAdapter(adapter) || !(signal instanceof AbortSignal)) throw new Error("A genuine producer and actual startup signal are required");
        const start = adapter.startOwnedRun.bind(adapter), inspect = adapter.inspectOwnedRun.bind(adapter);
        if (worktree.root !== state.identity.workspaceRoot || worktree.branch !== state.identity.workspaceBranch) throw new Error("Owned worktree differs from the immutable journal launch");
        state.bridgeAdapter = adapter; state.bridgeWorktree = new WeakRef(worktree); state.inspect = inspect;
        state.admission = createOwnedRunAdmission(state.identity);
        const current = await worker.call<JournalRun | null>("lookup", { runId: state.runId });
        if (!current || current.stopRequested || current.phase !== "launch_intent") throw new Error("Journal startup was stopped before the trusted producer invocation");
        const handle = await start({ runId: payload.run_id, taskId: payload.task_id, agentInstanceId: payload.agent_instance_id,
          runtime: payload.runtime, workspaceRoot: payload.workspace.root, runStart: payload }, worktree, state.admission, signal);
        state.handle = handle;
        // The factory consumed this admission before producing a handle. It was
        // never available to a caller supplying another ContextPack or policy.
        return Object.freeze({ handle, admission: state.admission });
      } finally { state.payload = undefined; }
    },
    recordStarted(permit, adapter, handle) { return serialize(permit, async (state) => {
      if (!state.admission || state.recordedStarted || state.bridgeAdapter !== adapter || state.handle !== handle || !state.inspect) throw new Error("The trusted bridge's exact adapter and handle are required");
      const observation = await state.inspect(handle, state.admission);
      const proof = getOwnedRunStatusReceipt(observation, state.admission, handle);
      if (!proof || proof.kind === "uncertain") throw new Error("No authenticated producer handle observation");
      const result = await worker.call<{ kind: string; run: JournalRun }>("started", inputFor(state));
      update(state, result.run);
      if (result.kind !== "recorded") throw new Error("Startup history could not be durably recorded");
      state.recordedStarted = true; state.inspect = undefined; state.bridgeAdapter = undefined;
      return result.run;
    }); },
    settleOwnedProcess(permit, handle, value, input) {
      const settlement = snapshotSettlement(input);
      return serialize(permit, async (state) => {
      if (!state.admission || !state.recordedStarted || (state.handle ?? state.closedHandle?.deref()) !== handle) throw new Error("Physical settlement requires this journal's exact recorded execution");
      const proof = getOwnedStopReceipt(value, state.admission, handle) ?? getOwnedRunStatusReceipt(value, state.admission, handle);
      if (proof?.kind !== "confirmed_closed" || proof.facts?.childSpawned !== true) throw new Error("No authenticated physical child-closure receipt");
      return persistSettlement(state, "returned_handle", { observedAt: proof.observedAt, facts: proof.facts }, settlement);
    }); },
    settleOwnedStartupFailure(permit, worktree, error) { return serialize(permit, async (state) => {
      if (!state.identity || !state.admission || state.bridgeWorktree?.deref() !== worktree || state.handle || state.recordedStarted
        || (state.phase !== "launch_intent" && !state.recordedClosed)
        || worktree.root !== state.identity.workspaceRoot || worktree.branch !== state.identity.workspaceBranch) {
        throw new Error("Startup settlement requires this journal admission without a returned handle");
      }
      const proof = getOwnedStartupReceipt(error, state.admission, worktree);
      if (proof?.kind !== "confirmed_closed" || proof.facts?.childSpawned !== true) throw new Error("Startup error lacks authenticated spawned-child closure; not_spawned remains unknown");
      const phase = proof.cancellationRequested ? "cancelled" : "failed";
      const settlement = snapshotSettlement({ terminal: { type: "run.lifecycle", payload: { phase,
        reason: "Owned startup ended after child spawn; physical closure confirmed" } }, retentionOutcome: phase });
      return persistSettlement(state, "startup_error", { observedAt: proof.observedAt, facts: proof.facts }, settlement);
    }); },
    appendEvent(permit, eventId, input) {
      nonempty(eventId, "event ID");
      if (eventId.startsWith("sys:settlement:")) throw new Error("Reserved terminal event identity");
      const parsed = runEventBodySchema.parse(input), content = JSON.stringify(parsed);
      if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Event exceeds the bounded journal payload size");
      return serialize(permit, async (state) => {
        const terminal = parsed.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(parsed.payload.phase);
        if (parsed.type === "run.lifecycle" && parsed.payload.phase === "started" && !state.recordedStarted) throw new Error("Started events require our authenticated recorded producer handle");
        if (terminal || parsed.type === "run.workspace.retained") throw new Error("Terminal/retention events must be committed atomically through physical settlement");
        const result = await worker.call<{ kind: string; event?: StoredEvent; revision?: number }>("append", { ...inputFor(state), eventId, content });
        if (result.kind !== "stored" || !result.event || result.revision === undefined) throw new Error(`Journal event ${result.kind}; existing content is retained`);
        state.revision = result.revision; return result.event;
      });
    },
    claimNextLiveDelivery(permit) { return serialize(permit, (state) => worker.call<LiveDeliveryClaim>("live_claim", inputFor(state))); },
    recordLiveEventReceipt(permit, receipt) {
      if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0 || receipt.sequence > 2 ** 31 - 1
        || !/^[a-f0-9]{64}$/u.test(receipt.contentSha256) || !["accepted", "rejected"].includes(receipt.status)) throw new Error("Invalid live event receipt");
      nonempty(receipt.attemptId, "live attempt ID");
      return serialize(permit, (state) => worker.call<LiveDeliveryView>("live_receipt", { ...inputFor(state), sequence: receipt.sequence, hash: receipt.contentSha256, attemptId: receipt.attemptId, status: receipt.status }));
    },
    recordLiveAttemptFailure(permit, failure) {
      nonempty(failure.attemptId, "live attempt ID");
      if (!Number.isSafeInteger(failure.sequence) || failure.sequence < 0 || failure.sequence > 2 ** 31 - 1
        || !["rejected", "transport_failure", "receipt_timeout"].includes(failure.reason)) throw new Error("Invalid live failure");
      return serialize(permit, (state) => worker.call<LiveDeliveryView>("live_failure", { ...inputFor(state), ...failure }));
    },
    latchLiveDeliveryAbort(permit, cause) {
      nonempty(cause.code, "live abort code"); nonempty(cause.message, "live abort message");
      const snapshot = JSON.parse(JSON.stringify(cause)) as Record<string, unknown>;
      return serialize(permit, (state) => worker.call<LiveDeliveryView>("live_abort", { ...inputFor(state), cause: snapshot }));
    },
    async pendingEvents(request, limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Bounded event batch required");
      return worker.call<StoredEvent[]>("pending", { runId: query(request), limit });
    },
    inspectClosedRunDelivery(scope) { return worker.call<ClosedRunDeliveryView>("delivery_inspect", deliveryScope(scope)); },
    claimNextClosedRunDelivery(scope) { return worker.call<ClosedRunDeliveryClaim>("delivery_claim", deliveryScope(scope)); },
    recordClosedRunEventReceipt(scope, receipt) {
      const input = deliveryScope(scope);
      if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0 || receipt.sequence > 2 ** 31 - 1
        || !/^[a-f0-9]{64}$/u.test(receipt.contentSha256) || !["accepted", "rejected"].includes(receipt.status)) throw new Error("Invalid event receipt identity");
      nonempty(receipt.attemptId, "delivery attempt ID");
      return worker.call<ClosedRunDeliveryView>("delivery_receipt", { ...input, sequence: receipt.sequence,
        hash: receipt.contentSha256, attemptId: receipt.attemptId, status: receipt.status });
    },
    recordClosedRunAttemptFailure(scope, failure) {
      const input = deliveryScope(scope); nonempty(failure.attemptId, "delivery attempt ID");
      if (!Number.isSafeInteger(failure.sequence) || failure.sequence < 0 || failure.sequence > 2 ** 31 - 1 || !["rejected", "transport_failure", "receipt_timeout"].includes(failure.reason)) throw new Error("Invalid delivery failure reason");
      return worker.call<ClosedRunDeliveryView>("delivery_failure", { ...input, sequence: failure.sequence, attemptId: failure.attemptId, reason: failure.reason });
    },
    close: () => worker.close(),
  } satisfies Journal);
}
