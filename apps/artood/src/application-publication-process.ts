import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { finished as streamFinished } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ApplicationPublicationRootLeaseV1Schema, ApplicationPublicationDeploymentV1Schema,
  ApplicationPublicationServiceIdentityV1Schema, ApplicationPublicationInitializationV1Schema,
  ApplicationPublicationNormalClosureV1Schema, ApplicationPublicationAbortedClosureV1Schema,
  ApplicationPublicationLiveOwnerV1Schema, type ApplicationPublicationRootLeaseV1, type ApplicationPublicationDeploymentV1,
  type ApplicationPublicationInitializationV1, type ApplicationPublicationServiceIdentityV1,
  type ApplicationPublicationNormalClosureV1, type ApplicationPublicationAbortedClosureV1,
  type ApplicationPublicationLiveOwnerV1 } from "@artoo/domain";
import { readApplicationPublicationExecution, type PreparedApplicationPublicationExecution,
  type ApplicationPublicationExecutionFacts } from "./application-publication-acceptance.js";
import { readApplicationPublicationProfile } from "./application-publication-profile.js";
import { readApplicationVerificationProfile } from "./application-verification-profile.js";
import { readApplicationVerificationCandidate } from "./application-verification-candidate.js";
import { createApplicationInstallationOwner, auditApplicationInstallation, type PreparedApplicationInstallation } from "./application-installation.js";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { readApplicationRuntimePin } from "./application-runtime-installation.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { isWindowsOwnedClosureReceipt, isWindowsOwnedTargetControlReceipt, startWindowsOwnedProcess,
  type OriginalTargetControlReceipt, type WindowsOwnedProcess, type WindowsOwnedClosureReceipt } from "./owned/windows-owned-process.js";
import { readWindowsGuardianOperation, WINDOWS_GUARDIAN_JOB_BOUNDARY } from "./owned/windows-guardian-scope.js";
import { reserveWindowsGuardianSlot } from "./owned/windows-runtime-guardian.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";
import { ApplicationPublicationInitializedStatusSchema, ApplicationPublicationListeningStatusSchema,
  ApplicationPublicationProgressStatusSchema, ApplicationPublicationClosedStatusSchema, applicationPublicationProbeHeaders,
  APPLICATION_PUBLICATION_STATUS_LIMITS, APPLICATION_PUBLICATION_PROBE_HEADER,
  type ApplicationPublicationProbeBinding, type ApplicationPublicationCounters } from "./application-publication-process-protocol.js";
import { ApplicationPublicationControlStatusSchema, encodeApplicationPublicationControlCommand,
  APPLICATION_PUBLICATION_CONTROL_LIMITS, APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER,
  type ApplicationPublicationControlCommand, type ApplicationPublicationControlStatus } from "./application-publication-control-protocol.js";
import { beginApplicationPublicationOwner, closeApplicationPublicationOwner, setApplicationPublicationOwnerQuiescent,
  type ApplicationPublicationReservation } from "./application-publication-coordination.js";

const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const immutable = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
};
type ClosedOwner = Pick<ApplicationPublicationAbortedClosureV1, "owner_id" | "closed_at" | "process_exit_confirmed" | "exit_code" |
  "job_empty" | "stdout_eof" | "stderr_eof" | "helper_exit_code" | "helper_closed"> & { readonly generation: 0 | 1 | 2 };
type ServiceClosure = ApplicationPublicationNormalClosureV1 | ApplicationPublicationAbortedClosureV1;
interface OwnerRecord { readonly id: string; readonly generation: 0 | 1 | 2; created: boolean; closure?: ClosedOwner }
interface OwnerLedger {
  readonly execution: PreparedApplicationPublicationExecution; readonly facts: Readonly<ApplicationPublicationExecutionFacts>;
  readonly owners: OwnerRecord[]; deployment?: ApplicationPublicationDeploymentV1;
}
interface Execution extends OwnerLedger {
  readonly reservation: ApplicationPublicationReservation;
  readonly lease: ApplicationPublicationRootLeaseV1; readonly deadline: number; readonly signal: AbortSignal;
  readonly configured: ReturnType<typeof readApplicationPublicationProfile>;
  readonly application: ReturnType<typeof readApplicationVerificationProfile>;
  readonly manifest: ApplicationRuntimeFilePin;
}
declare const initializedBrand: unique symbol;
export interface InitializedApplicationPublication { readonly [initializedBrand]: true }
interface Store { readonly original: Execution; readonly reference: ApplicationRuntimeFilePin;
  readonly provenance: z.infer<typeof ApplicationPublicationInitializedStatusSchema>["provenance"];
  readonly initialization: ApplicationPublicationInitializationV1; next: 1 | 2 | 3; first?: OriginalProcess }
const stores = new WeakMap<object, Store>(), failures = new WeakMap<object, OwnerLedger>();
const ledgers = new WeakMap<object, OwnerLedger>(), attempted = new WeakSet<object>();
/** Record an original consumed execution before asynchronous admission. A known
 * empty ledger proves this layer created no owner; an unknown object never does. */
export function prepareApplicationPublicationProcess(execution: PreparedApplicationPublicationExecution): void {
  const facts = readApplicationPublicationExecution(execution), saved = ledgers.get(execution);
  if (saved) { if (saved.facts !== facts) throw Error("Original publication execution changed"); return; }
  ledgers.set(execution, { execution, facts, owners: [] });
}
export interface ApplicationPublicationService {
  readonly identity: ApplicationPublicationServiceIdentityV1; readonly origin: string; readonly generation: 1 | 2;
  readonly probe: { readonly requestHeaders: Readonly<Record<string, string>>; readonly responseHeaders: Readonly<Record<string, string>> };
  readonly preflight: { readonly existing_database: true; readonly process_exit_confirmed: true };
  readonly closed: Promise<ServiceClosure>;
  drain(): Promise<ApplicationPublicationNormalClosureV1>;
  cancel(error: unknown): void;
  quiesce(): Promise<void>;
  resume(): Promise<void>;
  runProbe<T>(path: string, work: (headers: Readonly<Record<string, string>>) => Promise<T>): Promise<T>;
  observe(): Promise<ApplicationPublicationLiveOwnerV1>;
  waitForRequestCounters(minimumRequests: number, input: { deadline: number; signal: AbortSignal }): Promise<ApplicationPublicationCounters>;
}
function markFailure(error: unknown, original: OwnerLedger): Error {
  const result = error instanceof Error ? error : Error("Application publication failed", { cause: error });
  failures.set(result, original); return result;
}
/** A failure must be this process layer's original object and original consumed
 * execution. Cleanup observations remain readable after authority revocation. */
export function readApplicationPublicationProcessFailure(error: unknown, execution: PreparedApplicationPublicationExecution) {
  const original = typeof error === "object" && error !== null ? failures.get(error) : undefined;
  if (!original || original.execution !== execution) throw Error("Original publication process failure required");
  return ownerSnapshot(original);
}
function ownerSnapshot(original: OwnerLedger) {
  return Object.freeze({ closed_owners: Object.freeze(original.owners.flatMap(owner => owner.closure ? [owner.closure] : [])),
    unsettled_owner_ids: Object.freeze(original.owners.filter(owner => owner.created && !owner.closure).map(owner => owner.id)),
    ...(original.deployment ? { deployment: original.deployment } : {}) });
}
export function readApplicationPublicationProcessOwners(token: InitializedApplicationPublication) {
  const saved = stores.get(token); if (!saved) throw Error("Original initialized publication required"); return ownerSnapshot(saved.original);
}
export function readApplicationPublicationProcessState(execution: PreparedApplicationPublicationExecution) {
  const saved = ledgers.get(execution); if (!saved) throw Error("Original admitted publication execution required"); return ownerSnapshot(saved);
}
function current(original: Execution): void {
  original.signal.throwIfAborted();
  if (performance.now() >= original.deadline) throw Error("Application publication original root deadline elapsed");
  if (readApplicationPublicationExecution(original.execution) !== original.facts) throw Error("Original publication execution changed");
  if (performance.now() >= original.deadline) throw Error("Application publication original root deadline elapsed during admission");
}
function prepareSelection(original: Execution, selection: unknown): { installation: PreparedApplicationInstallation; file: ApplicationRuntimeFilePin } {
  current(original);
  const owner = createApplicationInstallationOwner({ parent: original.configured.config.selection_parent,
    nodeId: original.facts.request.computer_id, allowedRoots: original.configured.roots, node: original.application.config.node,
    backend: original.facts.backend, signal: original.signal });
  try {
    const bytes = Buffer.from(JSON.stringify(selection) + "\n"), tag = Buffer.from(JSON.stringify({ version: 1,
      format: "artoo.application-publication-selection-package.v1", installation: { version: 1, generation_id: owner.generationId } }) + "\n");
    if (bytes.length > 65_536) throw Error("Publication selection exceeds bound");
    const file = Object.freeze({ path: win32.join(owner.directory, "selection.json"), bytes: bytes.length, sha256: sha(bytes) });
    const installation = owner.install({ version: 1, directories: [], files: [
      { path: "selection.json", bytes: bytes.length, sha256: file.sha256, content: bytes },
      { path: "generation.json", bytes: tag.length, sha256: sha(tag), content: tag }],
      profile: { path: win32.join(owner.directory, "generation.json"), bytes: tag.length, sha256: sha(tag) } });
    return { installation, file };
  } catch (error) { if (owner.describeAttempt().phase === "claimed") owner.abandon(); throw error; }
}
interface OriginalProcess {
  readonly ready: Promise<void>; readonly closed: Promise<ApplicationPublicationInitializationV1 | ServiceClosure>;
  readonly record: OwnerRecord; readonly identity?: ApplicationPublicationServiceIdentityV1;
  cancel(error: unknown): void; drain(): Promise<ApplicationPublicationNormalClosureV1>;
  quiesce(): Promise<void>; resume(): Promise<void>;
  runProbe<T>(path: string, work: (headers: Readonly<Record<string, string>>) => Promise<T>): Promise<T>;
  observe(): Promise<ApplicationPublicationLiveOwnerV1>;
  waitForRequestCounters(minimumRequests: number, input: { deadline: number; signal: AbortSignal }): Promise<ApplicationPublicationCounters>;
  initialized(): z.infer<typeof ApplicationPublicationInitializedStatusSchema>;
  listening(): z.infer<typeof ApplicationPublicationListeningStatusSchema>;
  normal(): boolean;
}
function start(original: Execution, target: { initialize: true } | { store: Store; binding: ApplicationPublicationProbeBinding }): OriginalProcess {
  current(original);
  const identity = "binding" in target ? target.binding.identity : undefined;
  const record: OwnerRecord = { id: identity?.owner_id ?? randomUUID(), generation: identity?.generation ?? 0, created: false };
  original.owners.push(record);
  const configured = original.application, backend = original.facts.backend, native = describeWindowsProcessInstallation(backend);
  const systemRoot = realpathSync.native(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "");
  const selection = { version: 1, node_id: original.facts.request.computer_id, writable_workspace_roots: original.configured.roots,
    node: configured.config.node, host_manifest: configured.config.hostManifest,
    backend: { directory: native.directory, manifest_sha256: native.manifestSha256 }, system_root: systemRoot, shutdown: "stdin",
    ...("initialize" in target ? { format: "artoo.application-publication-initialize-selection.v1",
      installation_parent: original.configured.config.deployment_parent, source_manifest: original.manifest }
      : { format: "artoo.application-publication-service-selection.v1", installation_reference: target.store.reference, publication: target.binding }) };
  const prepared = prepareSelection(original, selection);
  const auditCaptured = () => { auditApplicationInstallation(prepared.installation); readApplicationRuntimePin(prepared.file); };
  const audit = () => { current(original); auditCaptured(); current(original); };
  audit();
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  let resolveClosed!: (value: ApplicationPublicationInitializationV1 | ServiceClosure) => void, rejectClosed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); void ready.catch(() => {});
  const closed = new Promise<ApplicationPublicationInitializationV1 | ServiceClosure>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => {});
  let initialized: z.infer<typeof ApplicationPublicationInitializedStatusSchema> | undefined;
  let listening: z.infer<typeof ApplicationPublicationListeningStatusSchema> | undefined;
  let closure: z.infer<typeof ApplicationPublicationClosedStatusSchema> | undefined, counters: ApplicationPublicationCounters | undefined;
  let child: WindowsOwnedProcess | undefined, started: Awaited<WindowsOwnedProcess["started"]> | undefined;
  let failure: unknown, finished = false, cancelled = false, requested = false, normal = false, ownerJoined = false;
  let input: Promise<OriginalTargetControlReceipt> | undefined, totalBytes = 0, events = 0, pending = Buffer.alloc(0);
  let ownerRegistered = false, phase: "starting" | "quiesced" | "probe" | "resumed" | "draining" = "starting";
  let cycle = 0, controlSequence = 0, controlBytes = 0;
  let controlTail: Promise<OriginalTargetControlReceipt | undefined> = Promise.resolve(undefined);
  const controlAcks: OriginalTargetControlReceipt[] = [];
  type ControlRequest = { command: ApplicationPublicationControlCommand; statuses: ApplicationPublicationControlStatus[];
    waiters: Set<() => void> };
  const controls = new Map<number, ControlRequest>();
  const ownerClosed = () => { if (ownerRegistered) { closeApplicationPublicationOwner(original.reservation, record); ownerRegistered = false; } };
  const counterWaiters = new Set<() => void>();
  const countersChanged = () => { for (const notify of counterWaiters) notify(); };
  const admission = new AbortController();
  const cancelOwner = () => { if (!child || cancelled) return; cancelled = true;
    try { child.cancel(); } catch (error) { failure = new AggregateError([failure, error], "Original publication cancellation failed"); } };
  const fail = (error: unknown) => {
    failure ??= error; rejectReady(markFailure(failure, original)); countersChanged();
    for (const control of controls.values()) for (const wake of control.waiters) wake();
    if (finished) return;
    if (child) cancelOwner(); else admission.abort(failure);
  };
  const cancel = () => fail(original.signal.reason ?? Error("Application publication cancelled"));
  const timer = setTimeout(() => fail(Error("Application publication original root deadline elapsed")), Math.max(1, original.deadline - performance.now()));
  original.signal.addEventListener("abort", cancel, { once: true }); if (original.signal.aborted) cancel();
  const finish = (value?: ApplicationPublicationInitializationV1 | ServiceClosure, error?: unknown) => {
    if (finished) return; finished = true; clearTimeout(timer); original.signal.removeEventListener("abort", cancel);
    countersChanged();
    for (const control of controls.values()) for (const wake of control.waiters) wake();
    if (error !== undefined) { const result = markFailure(error, original); rejectReady(result); rejectClosed(result); }
    else { if (!failure) resolveReady(); resolveClosed(value!); }
  };
  const maybeReady = () => {
    if (!listening || !started?.creationTime || failure || finished) return;
    try {
      const initial = ApplicationPublicationControlStatusSchema.parse(listening.control);
      if (!isDeepStrictEqual(initial.identity, identity) || initial.sequence !== -1 || initial.cycle !== 0 || initial.state !== "quiesced")
        throw Error("Publication listener was exposed before original startup quiescence");
      if (initial.counters.requests_used !== 0 || initial.closure.invocations !== 0 || listening.counters.requests_used !== 0)
        throw Error("Publication admitted work before original startup quiescence");
      phase = "quiesced"; setApplicationPublicationOwnerQuiescent(original.reservation, record, true);
      audit(); resolveReady();
    } catch (error) { fail(error); }
  };
  const updateCounters = (next: ApplicationPublicationCounters) => {
    if (counters && (next.requests_used < counters.requests_used || next.closed_transports < counters.closed_transports
      || Date.parse(next.observed_at) < Date.parse(counters.observed_at))) throw Error("Publication counters regressed");
    counters = immutable(next);
    countersChanged();
  };
  const liveControl = () => {
    original.signal.throwIfAborted();
    if (!identity || !listening || !started?.creationTime || !child?.writeControl || finished || requested || failure
      || performance.now() >= original.deadline) throw Error("Original publication control owner is unavailable", { cause: failure });
  };
  const sendControl = (kind: ApplicationPublicationControlCommand["kind"], extra?: { path: string; nonce: string }) => {
    if (!identity || !child?.writeControl || !listening || !started?.creationTime || finished || failure)
      throw Error("Original publication control pipe unavailable");
    if (kind !== "drain" && controlSequence >= APPLICATION_PUBLICATION_CONTROL_LIMITS.messages - 1)
      throw Error("Publication control budget reserves its final drain");
    const command = { version: 1 as const, identity, sequence: controlSequence++, cycle, kind, ...extra } as ApplicationPublicationControlCommand;
    const bytes = Buffer.from(encodeApplicationPublicationControlCommand(command)), final = kind === "drain";
    const control: ControlRequest = { command, statuses: [], waiters: new Set() }; controls.set(command.sequence, control);
    controlBytes += bytes.length;
    const written = controlTail.then(async () => {
      if (!child?.writeControl || finished || failure || performance.now() >= original.deadline)
        throw Error("Original publication control ended before write");
      const ack = await child.writeControl(bytes, { final });
      if (!isWindowsOwnedTargetControlReceipt(ack) || ack.sequence !== command.sequence || ack.bytesWritten !== bytes.length
        || ack.sha256 !== sha(bytes) || ack.final !== final || ack.inputClosed !== final
        || controlAcks.length !== command.sequence || controlAcks[0] && controlAcks[0].token !== ack.token)
        throw Error("Publication native control acknowledgement differs from its original command");
      controlAcks.push(ack); return ack;
    });
    controlTail = written; void written.catch(fail);
    return { control, written };
  };
  const waitControl = (control: ControlRequest, state: ApplicationPublicationControlStatus["state"]) => {
    // Pausing preserves already-accepted requests through their original native
    // closure. The configured drain reserve covers those owner bounds; an HTTP
    // readiness timeout alone can be shorter than a legitimate business write.
    const limits = original.facts.request.capabilities.contract.limits;
    const deadline = Math.min(original.deadline,
      performance.now() + (control.command.kind === "pause" ? limits.normal_drain_reserve_ms : limits.health_timeout_ms));
    return new Promise<ApplicationPublicationControlStatus>((resolve, reject) => {
      let done = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finishWait = (error?: unknown, value?: ApplicationPublicationControlStatus) => {
        if (done) return; done = true; clearTimeout(timeout); control.waiters.delete(check);
        if (error !== undefined) reject(error); else resolve(value!);
      };
      const check = () => {
        try {
          liveControl();
          if (performance.now() >= deadline) throw Error("Publication original control acknowledgement deadline elapsed");
          const value = control.statuses.find(status => status.state === state);
          if (value) finishWait(undefined, value);
        } catch (error) { finishWait(error); }
      };
      control.waiters.add(check);
      timeout = setTimeout(() => finishWait(Error("Publication original control acknowledgement deadline elapsed")), Math.max(1, deadline - performance.now()));
      check();
    });
  };
  const quiesce = async () => {
    try {
      liveControl(); if (phase === "quiesced") return;
      if (phase !== "resumed") throw Error("Publication control already has an outstanding transition");
      cycle++; const sent = sendControl("pause"); phase = "starting";
      await Promise.all([sent.written, waitControl(sent.control, "quiesced")]); liveControl();
      phase = "quiesced"; setApplicationPublicationOwnerQuiescent(original.reservation, record, true); countersChanged();
    } catch (error) { if (!requested) fail(error); throw markFailure(error, original); }
  };
  const resume = async () => {
    try {
      liveControl(); if (phase !== "quiesced") throw Error("Publication resume requires original quiescence");
      current(original); liveControl();
      setApplicationPublicationOwnerQuiescent(original.reservation, record, false);
      const sent = sendControl("resume"); phase = "starting";
      await Promise.all([sent.written, waitControl(sent.control, "resumed")]); liveControl(); phase = "resumed";
    } catch (error) { if (!requested) fail(error); throw markFailure(error, original); }
  };
  const runProbe = async <T>(path: string, work: (headers: Readonly<Record<string, string>>) => Promise<T>): Promise<T> => {
    try {
      liveControl(); if (phase !== "quiesced" || path !== "/" && path !== original.facts.definition.persistence.read.path)
        throw Error("Publication probe requires its original quiescent fixed read path");
      current(original); liveControl();
      const nonce = randomUUID(); setApplicationPublicationOwnerQuiescent(original.reservation, record, false);
      const sent = sendControl("probe", { path, nonce }); phase = "probe";
      const [, armed] = await Promise.all([sent.written, waitControl(sent.control, "probe-ready")]);
      liveControl(); const value = await work(Object.freeze({ [APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER]: nonce }));
      const settled = await waitControl(sent.control, "quiesced"); liveControl();
      if (settled.counters.requests_used !== armed.counters.requests_used + 1)
        throw Error("Publication probe did not settle exactly its one original transport");
      phase = "quiesced"; setApplicationPublicationOwnerQuiescent(original.reservation, record, true); countersChanged();
      current(original); return value;
    } catch (error) { if (!requested) fail(error); throw markFailure(error, original); }
  };
  const onOutput = (chunk: Buffer) => {
    try {
      if (!Buffer.isBuffer(chunk) || (totalBytes += chunk.length) > APPLICATION_PUBLICATION_STATUS_LIMITS.outputBytes) throw Error("Publication output exceeds bound");
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const index = pending.indexOf(10); if (index < 0) break;
        if (index + 1 > APPLICATION_PUBLICATION_STATUS_LIMITS.lineBytes || ++events > APPLICATION_PUBLICATION_STATUS_LIMITS.events) throw Error("Publication status bound exceeded");
        const event: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, index))); pending = pending.subarray(index + 1);
        if (!identity) { if (initialized) throw Error("Duplicate publication initialization"); initialized = immutable(ApplicationPublicationInitializedStatusSchema.parse(event)); }
        else if (!listening) {
          listening = immutable(ApplicationPublicationListeningStatusSchema.parse(event));
          if (!isDeepStrictEqual(listening.identity, identity) || requested) throw Error("Publication listening identity differs");
          updateCounters(listening.counters); maybeReady();
        } else {
          const kind = z.object({ kind: z.string() }).passthrough().parse(event).kind;
          if (closure) throw Error("Publication status followed original closure");
          if (kind === "application-publication.control") {
            const status = ApplicationPublicationControlStatusSchema.parse(event), control = controls.get(status.sequence);
            if (!control || !isDeepStrictEqual(status.identity, identity) || status.cycle !== control.command.cycle)
              throw Error("Publication control status differs from its original command");
            const expected = control.command.kind === "probe" ? ["probe-ready", "quiesced"]
              : control.command.kind === "pause" ? ["quiesced"] : control.command.kind === "resume" ? ["resumed"] : [];
            if (status.state !== expected[control.statuses.length]) throw Error("Publication control status was replayed or reordered");
            const previous = control.statuses.at(-1);
            if (previous && (status.closure.invocations < previous.closure.invocations
              || status.closure.runtime_normal_closures < previous.closure.runtime_normal_closures
              || status.closure.broker_normal_closures < previous.closure.broker_normal_closures)) throw Error("Publication control closure counters regressed");
            control.statuses.push(immutable(status)); updateCounters(status.counters);
            for (const wake of control.waiters) wake();
          } else if (kind === "application-publication.progress") {
            const progress = ApplicationPublicationProgressStatusSchema.parse(event);
            if (!isDeepStrictEqual(progress.identity, identity)) throw Error("Publication progress identity differs");
            if (phase === "quiesced" && counters && (progress.counters.requests_used !== counters.requests_used
              || progress.counters.in_flight !== 0 || progress.counters.closed_transports !== counters.closed_transports))
              throw Error("Publication admitted a request while its original gate was quiescent");
            updateCounters(progress.counters);
          } else {
            if (!requested) throw Error("Unrequested publication closure");
            closure = immutable(ApplicationPublicationClosedStatusSchema.parse(event));
            if (!isDeepStrictEqual(closure.identity, identity)) throw Error("Publication closure identity differs"); updateCounters(closure.counters);
          }
        }
      }
      if (pending.length >= APPLICATION_PUBLICATION_STATUS_LIMITS.lineBytes) throw Error("Publication line exceeds bound");
    } catch (error) { fail(error); }
  };
  void (async () => {
    try {
      const scope = readWindowsGuardianOperation(backend);
      const launch = Object.freeze({ executable: configured.config.node.path,
        args: Object.freeze([configured.hostEntry.path, `--selection=${prepared.file.path}`]),
        cwd: scope?.workspaceRoot ?? win32.dirname(configured.hostEntry.path),
        env: Object.freeze({ SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, "System32") }),
        cleanupTimeoutMs: 5000, maxOutputBytes: APPLICATION_PUBLICATION_STATUS_LIMITS.outputBytes,
        normalExitPolicy: "require-empty" as const, normalExitGraceMs: 250,
        ...(identity ? { targetControl: Object.freeze({ version: 1 } as const) }
          : { targetInput: Object.freeze({ version: 1, mode: "single-message-eof", maximumBytes: 4096 } as const) }) });
      const guardianSlot = scope ? await reserveWindowsGuardianSlot(scope.guardian, { operationKind: "tool", operationId: scope.operationId,
        bindingDigest: sha(JSON.stringify({ version: 1, format: "artoo.application-publication-launch.v1",
          boundary: WINDOWS_GUARDIAN_JOB_BOUNDARY, operation: scope.bindingDigest, selection: prepared.file, deadline: original.deadline, launch })),
        serverOperation: scope.serverOperation }) : undefined;
      admission.signal.throwIfAborted(); audit();
      if (readWindowsGuardianOperation(backend) !== scope) throw Error("Original publication Guardian operation changed");
      const remaining = Math.floor(original.deadline - performance.now()); if (remaining < 1) throw Error("Publication deadline elapsed before spawn");
      beginApplicationPublicationOwner(original.reservation, record); ownerRegistered = true;
      child = startWindowsOwnedProcess(backend, { ...launch, timeoutMs: remaining, signal: admission.signal, ...(guardianSlot ? { guardianSlot } : {}) });
      record.created = true;
      child.stdout.on("data", onOutput); child.stderr.on("data", () => fail(Error("Publication host reported diagnostic failure")));
      child.stdout.on("error", fail); child.stderr.on("error", fail); child.on("error", fail);
      const outputClosed = Promise.all([streamFinished(child.stdout, { cleanup: true }), streamFinished(child.stderr, { cleanup: true })]);
      void outputClosed.catch(fail);
      const startup = child.started.then(value => { started = value; maybeReady(); }, fail); void child.closed.catch(fail);
      if (identity ? !child.writeControl || !child.observeMembers : !child.endInput) fail(Error("Original publication native capabilities unavailable"));
      if (failure) cancelOwner();
      const [nativeResult, outputResult] = await Promise.allSettled([child.closed, outputClosed]); ownerJoined = true; await startup;
      if (nativeResult.status === "rejected" || outputResult.status === "rejected") throw new VerificationCleanupError("Publication original closure is unconfirmed", {
        cause: new AggregateError([failure, nativeResult, outputResult], "Original publication owner observations") });
      const receipt = nativeResult.value;
      // Record actual native facts before any current-authority or integrity
      // rejection. Revocation must never erase the original owner's closure.
      if (isWindowsOwnedClosureReceipt(receipt) && receipt.cleanupConfirmed && receipt.noTargetCreated
        && !receipt.rootCreated && receipt.jobEmptyObserved && receipt.stdoutEof && receipt.stderrEof
        && receipt.helperExitObserved && receipt.helperCloseObserved) {
        record.created = false; ownerClosed(); throw Error("Publication native admission created no target");
      }
      const facts = nativeClosure(receipt, started, record);
      record.closure = immutable({ ...facts, generation: record.generation });
      ownerClosed();
      let ack: OriginalTargetControlReceipt | undefined;
      try { ack = input ? await input : undefined; } catch (error) { failure ??= error; }
      const inputFact = receipt.targetInput, controlFact = receipt.targetControl;
      const normalNative = receipt.rootExitCode === 0 && receipt.helperExitCode === 0 && receipt.helperSignal === null
        && receipt.terminationReason === null && receipt.nativeTerminationReason === null && receipt.failureCode === null && receipt.nativeError === null;
      if (!failure && normalNative && !pending.length) {
        if (!identity && initialized && events === 1 && inputFact?.version === 1 && inputFact.pipeCreated && inputFact.inputClosed
          && !inputFact.writeRequested && inputFact.requestId === null && inputFact.bytesWritten === 0) {
          auditCaptured(); if (failure) throw failure;
          const value = ApplicationPublicationInitializationV1Schema.parse({ ...facts, broker_invocations: 1, broker_closed: 1 });
          normal = true; finish(immutable(value)); return;
        }
        if (identity && closure && requested && ack && isWindowsOwnedTargetControlReceipt(ack)
          && ack.token === receipt.token && ack.final && ack.inputClosed && controlFact?.version === 1
          && controlFact.pipeCreated && controlFact.inputClosed && controlFact.messagesRequested === controlSequence
          && controlFact.messagesAcknowledged === controlAcks.length && controlAcks.length === controlSequence
          && controlFact.bytesWritten === controlBytes && controlAcks.every(value => value.token === receipt.token)
          && isDeepStrictEqual(controlFact.finalAcknowledgement, { requestId: ack.requestId, sequence: ack.sequence,
            bytesWritten: ack.bytesWritten, sha256: ack.sha256, final: true, inputClosed: true }) && closure.counters.in_flight === 0
          && closure.counters.requests_used === closure.counters.closed_transports) {
          auditCaptured(); if (failure) throw failure;
          const value = ApplicationPublicationNormalClosureV1Schema.parse({ ...facts, kind: "normal-drain", service: identity,
            reason: "stdin-drain", input_ack_digest: sha(JSON.stringify(ack)), listener_closed: true, audit_complete: true, session_released: true,
            counters: { accepted_transports: closure.counters.requests_used, closed_transports: closure.counters.closed_transports,
              runtime_invocations: closure.closure.invocations, runtime_closed: closure.closure.runtime_normal_closures,
              broker_invocations: closure.closure.invocations, broker_closed: closure.closure.broker_normal_closures } });
          normal = true; finish(immutable(value)); return;
        }
      }
      if (identity) {
        failure ??= Error("Publication stopped without its original normal drain"); rejectReady(markFailure(failure, original));
        const reason = performance.now() >= original.deadline ? "deadline" : original.signal.aborted ? "cancelled"
          : counters?.requests_used === 256 ? "request-limit" : "native-failure";
        finish(immutable(ApplicationPublicationAbortedClosureV1Schema.parse({ ...facts, kind: "aborted", service: identity, reason }))); return;
      }
      throw Error("Publication initialization did not close normally", { cause: failure });
    } catch (error) {
      if (ownerJoined && identity && record.closure) {
        failure ??= error; rejectReady(markFailure(failure, original));
        const { generation: _generation, ...facts } = record.closure;
        finish(immutable(ApplicationPublicationAbortedClosureV1Schema.parse({ ...facts, kind: "aborted", service: identity, reason: "control-failure" })));
      } else if (child && !ownerJoined) {
        fail(error);
        const settled = await Promise.allSettled([child.closed, streamFinished(child.stdout, { cleanup: true }), streamFinished(child.stderr, { cleanup: true })]);
        const receipt = settled[0];
        if (receipt?.status === "fulfilled" && settled.every(value => value.status === "fulfilled")) {
          try { record.closure = immutable({ ...nativeClosure(receipt.value, started, record), generation: record.generation }); ownerClosed(); } catch { /* The original owner remains explicitly unsettled. */ }
        }
        finish(undefined, new VerificationCleanupError("Publication setup failed after native owner creation", { cause: new AggregateError([error, ...settled], "Original publication cleanup") }));
      } else { if (!child && ownerRegistered) ownerClosed(); finish(undefined, error); }
    }
  })();
  return Object.freeze({ ready, closed, record, ...(identity ? { identity } : {}), cancel: fail, normal: () => normal,
    quiesce, resume, runProbe,
    initialized: () => { if (!finished || !normal || !initialized) throw Error("Original publication initialization incomplete"); return initialized; },
    listening: () => { if (!listening || !started?.creationTime || failure || finished) throw Error("Original publication listener is not live"); return listening; },
    drain: async () => {
      // Stopping an existing owner uses captured state even after session expiry.
      // It cannot create new work or extend the original native deadline.
      if (!requested && !finished && !failure) {
        requested = true; countersChanged();
        try {
          if (!identity || !listening || !started || !child?.writeControl) throw Error("Original publication listener input unavailable");
          if (performance.now() >= original.deadline) throw Error("Publication original root deadline elapsed before drain");
          setApplicationPublicationOwnerQuiescent(original.reservation, record, false); phase = "draining";
          input = sendControl("drain").written; void input.catch(fail);
        } catch (error) { fail(error); }
      }
      const value = await closed;
      if (!("kind" in value) || value.kind !== "normal-drain") throw markFailure(Error("Publication owner did not close by normal drain"), original);
      return value;
    },
    waitForRequestCounters: (minimumRequests: number, options: { deadline: number; signal: AbortSignal }): Promise<ApplicationPublicationCounters> => {
      const selectedSignal = options.signal, requestedDeadline = options.deadline;
      const deadline = Math.min(requestedDeadline, original.deadline);
      if (!Number.isSafeInteger(minimumRequests) || minimumRequests < 0 || minimumRequests > 256
        || !Number.isFinite(requestedDeadline) || counterWaiters.size >= 1)
        return Promise.reject(markFailure(Error("One bounded original publication counter wait required"), original));
      return new Promise((resolve, reject) => {
        let done = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const complete = (error?: unknown, value?: ApplicationPublicationCounters) => {
          if (done) return; done = true; clearTimeout(timeout);
          counterWaiters.delete(check); selectedSignal.removeEventListener("abort", check);
          if (error !== undefined) reject(markFailure(error, original)); else resolve(value!);
        };
        const check = () => {
          if (done) return;
          try {
            selectedSignal.throwIfAborted(); original.signal.throwIfAborted();
            if (performance.now() >= deadline) throw Error("Publication health counter deadline elapsed");
            if (finished || requested || failure || !identity || !listening || !started?.creationTime)
              throw Error("Original publication owner stopped before its health counters settled", { cause: failure });
            if (counters && counters.requests_used >= minimumRequests && counters.in_flight === 0) {
              if (phase !== "quiesced") return;
              current(original); selectedSignal.throwIfAborted();
              if (performance.now() >= deadline) throw Error("Publication health counter deadline elapsed during admission");
              if (finished || requested || failure) throw Error("Original publication owner stopped during counter observation");
              complete(undefined, counters);
            }
          } catch (error) { complete(error); }
        };
        // Only actual validated host status wakes this barrier. HTTP response
        // completion cannot increment counters or renew either deadline. The
        // original closed promise independently prevents a late false success.
        counterWaiters.add(check); selectedSignal.addEventListener("abort", check, { once: true });
        timeout = setTimeout(() => complete(Error("Publication health counter deadline elapsed")), Math.max(1, Math.ceil(deadline - performance.now())));
        void closed.then(() => complete(Error("Original publication owner closed before its health counters settled")),
          error => complete(error));
        check();
      });
    },
    observe: async () => {
      try {
        original.signal.throwIfAborted();
        if (performance.now() >= original.deadline) throw Error("Publication original root deadline elapsed");
        if (!identity || !listening || !started?.creationTime || !child?.observeMembers || finished || requested || failure || !counters)
          throw Error("Original publication owner is not live");
        const root = { pid: started.pid, creationTime: started.creationTime };
        const observation = await child.observeMembers([{ pid: root.pid, creationTime: root.creationTime }],
          Math.max(1, Math.min(5000, Math.floor(original.deadline - performance.now()))));
        original.signal.throwIfAborted();
        if (performance.now() >= original.deadline) throw Error("Publication original root deadline elapsed during observation");
        const member = observation.members[0];
        if (finished || requested || failure || observation.members.length !== 1 || member?.pid !== root.pid
          || member.creationTime !== root.creationTime || member.status !== "observed" || !member.jobMember)
          throw Error("Original publication root Job membership was not observed");
        const captured = counters;
        return immutable(ApplicationPublicationLiveOwnerV1Schema.parse({ service: identity, observed_at: new Date().toISOString(),
          counters_observed_at: captured.observed_at, closed: false,
          native: { root_pid: root.pid, root_creation_time: root.creationTime, observed: true, job_member: true },
          requests_used: captured.requests_used, in_flight: captured.in_flight }));
      } catch (error) { throw markFailure(error, original); }
    } });
}
function nativeClosure(receipt: WindowsOwnedClosureReceipt, started: Awaited<WindowsOwnedProcess["started"]> | undefined,
  record: OwnerRecord): Omit<ClosedOwner, "generation"> {
  if (!isWindowsOwnedClosureReceipt(receipt) || !receipt.cleanupConfirmed || !started?.creationTime
    || receipt.rootPid !== started.pid || receipt.rootCreationTime !== started.creationTime
    || !receipt.rootCreated || !receipt.rootStarted || receipt.noTargetCreated || !receipt.atomicJobMember || !receipt.rootWaitObserved
    || !receipt.stdoutEof || !receipt.stderrEof || !receipt.jobEmptyObserved || !receipt.helperSpawnObserved
    || !receipt.helperExitObserved || !receipt.helperCloseObserved) throw new VerificationCleanupError("Original publication root/Job/EOF/helper closure unconfirmed");
  return Object.freeze({ owner_id: record.id, closed_at: new Date().toISOString(), process_exit_confirmed: true,
    exit_code: receipt.rootExitCode, job_empty: true, stdout_eof: true, stderr_eof: true,
    helper_exit_code: receipt.helperExitCode, helper_closed: true });
}

export async function initializeApplicationPublicationProcess(execution: PreparedApplicationPublicationExecution,
  input: { lease: ApplicationPublicationRootLeaseV1; deadline: number; signal: AbortSignal; reservation: ApplicationPublicationReservation }): Promise<InitializedApplicationPublication> {
  if (attempted.has(execution)) throw Error("Original publication execution was already initialized");
  prepareApplicationPublicationProcess(execution); attempted.add(execution);
  const ledger = ledgers.get(execution)!;
  try {
  const facts = readApplicationPublicationExecution(execution), configured = readApplicationPublicationProfile(facts.publicationProfile);
  const application = readApplicationVerificationProfile(facts.applicationProfile), candidate = readApplicationVerificationCandidate(facts.candidate);
  const lease = immutable(ApplicationPublicationRootLeaseV1Schema.parse(input.lease)), deadline = input.deadline, signal = input.signal;
  if (!Number.isFinite(deadline) || deadline <= performance.now() || deadline - performance.now() > lease.root_lifetime_ms
    || lease.publication_id !== facts.request.publication_id || lease.publisher_session_id !== facts.request.publisher_session_id
    || lease.request_digest !== facts.requestDigest || lease.root_lifetime_ms !== configured.config.limits.root_lifetime_ms
    || !isDeepStrictEqual(candidate.identity, facts.request.author.candidate)) throw Error("Original publication root lease or candidate differs");
  const original: Execution = Object.assign(ledger, { configured, application, manifest: Object.freeze({ ...candidate.manifest }), lease, deadline, signal,
    reservation: input.reservation });
  try {
    current(original); const process = start(original, { initialize: true });
    const initialization = ApplicationPublicationInitializationV1Schema.parse(await process.closed), status = process.initialized(); current(original);
    const reference = status.reference, installation = status.installation, proof = status.provenance;
    const control = win32.dirname(reference.path), generation = win32.dirname(control), storeId = win32.basename(generation);
    if (win32.basename(reference.path) !== "REOPEN.v1.json" || win32.basename(control) !== "control"
      || win32.dirname(generation) !== configured.config.deployment_parent || !z.string().uuid().safeParse(storeId).success
      || installation.generation_id !== storeId || proof.target.generation_id !== storeId
      || !isDeepStrictEqual(installation.reference, reference) || !isDeepStrictEqual(proof.source.manifest, original.manifest)
      || proof.target.directory !== win32.join(generation, "code") || proof.target.storage_directory !== win32.join(generation, "store")
      || win32.dirname(installation.database.path) !== proof.target.storage_directory
      || !isDeepStrictEqual(installation.scope, proof.preserved.candidate_scope)
      || installation.schema_digest !== facts.request.author.candidate.schema_digest
      || proof.preserved.schema_json_digest !== installation.schema_digest
      || installation.scope.artifact_digest !== facts.request.author.candidate.artifact_digest
      || installation.scope.product_id !== facts.request.project_id
      || proof.preserved.http_origin !== configured.config.origin || installation.origin !== configured.config.origin
      || storeId === facts.request.author.test_store_id || storeId === facts.request.reviewer.test_store_id)
      throw Error("Publication initialization differs from original candidate, relocation or deployment");
    readApplicationRuntimePin(reference); current(original);
    const deployment = immutable(ApplicationPublicationDeploymentV1Schema.parse({ version: 1, deployment_generation: storeId, store_id: storeId,
      plan_digest: proof.target.plan_digest, relocation_proof_digest: sha(JSON.stringify(proof)), reopen_pin_digest: reference.sha256,
      database_identity: { device: installation.database.dev, inode: installation.database.ino }, schema_digest: installation.schema_digest,
      scope_digest: sha(JSON.stringify(installation.scope)), data_generation: installation.scope.data_generation,
      origin: installation.origin, client_entry_digest: installation.client_entry_digest }));
    original.deployment = deployment;
    const token = Object.freeze({}) as InitializedApplicationPublication;
    stores.set(token, { original, reference: immutable(reference), provenance: proof, initialization: immutable(initialization), next: 1 }); return token;
  } catch (error) { throw markFailure(error, original); }
  } catch (error) { throw markFailure(error, ledger); }
}
export function readInitializedApplicationPublication(token: InitializedApplicationPublication) {
  const saved = stores.get(token); if (!saved) throw Error("Original initialized publication required");
  current(saved.original); readApplicationRuntimePin(saved.reference); current(saved.original);
  return Object.freeze({ execution: saved.original.execution, reference: saved.reference, deployment: saved.original.deployment!, provenance: saved.provenance,
    initialization: saved.initialization, lease: saved.original.lease, deadline: saved.original.deadline });
}
export async function startApplicationPublicationService(token: InitializedApplicationPublication): Promise<ApplicationPublicationService> {
  const saved = stores.get(token); if (!saved) throw Error("Original initialized publication required");
  const original = saved.original;
  try {
    const captured = readInitializedApplicationPublication(token), generation = saved.next;
    if (generation === 3 || generation === 2 && !saved.first?.normal()) throw Error("Publication permits exactly one normal same-store reopen");
    saved.next = generation === 1 ? 2 : 3;
    const deployment = captured.deployment;
    const identity = immutable(ApplicationPublicationServiceIdentityV1Schema.parse({ publication_id: original.facts.request.publication_id,
      lease_id: original.lease.lease_id, owner_id: randomUUID(), generation, deployment_generation: deployment.deployment_generation,
      reopen_pin_digest: deployment.reopen_pin_digest, database_identity: deployment.database_identity, schema_digest: deployment.schema_digest,
      scope_digest: deployment.scope_digest, artifact_digest: original.facts.request.author.candidate.artifact_digest, origin: deployment.origin }));
    const binding = immutable({ version: 1 as const, identity, challenge: randomUUID(),
      control: { version: 1 as const, read_path: original.facts.definition.persistence.read.path } }), process = start(original, { store: saved, binding });
    if (generation === 1) saved.first = process;
    try { await process.ready; current(original); } catch (error) {
      process.cancel(error);
      try { await process.closed; } catch (cleanup) { throw new VerificationCleanupError("Publication startup failed and closure remains uncertain", { cause: new AggregateError([error, cleanup]) }); }
      throw error;
    }
    const preflight = process.listening().preflight;
    const closed = process.closed.then(value => { if (!("kind" in value)) throw Error("Service owner returned initialization closure"); return value; });
    void closed.catch(() => {});
    return Object.freeze({ identity, origin: identity.origin, generation, preflight,
      probe: Object.freeze({ requestHeaders: Object.freeze({ [APPLICATION_PUBLICATION_PROBE_HEADER]: binding.challenge }),
        responseHeaders: applicationPublicationProbeHeaders(binding) }), closed,
      drain: process.drain, cancel: process.cancel, observe: process.observe, waitForRequestCounters: process.waitForRequestCounters,
      quiesce: process.quiesce, resume: process.resume, runProbe: process.runProbe });
  } catch (error) { throw markFailure(error, original); }
}
