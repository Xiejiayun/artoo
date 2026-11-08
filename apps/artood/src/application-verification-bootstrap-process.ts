import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { finished as streamFinished } from "node:stream/promises";
import { z } from "zod";
import { createApplicationInstallationOwner, auditApplicationInstallation, type PreparedApplicationInstallation } from "./application-installation.js";
import { ApplicationRuntimeFilePinSchema, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { readApplicationRuntimePin } from "./application-runtime-installation.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { isWindowsOwnedClosureReceipt, isWindowsOwnedTargetInputReceipt, startWindowsOwnedProcess, type OriginalTargetInputReceipt,
  type PreparedWindowsProcessBackend, type WindowsOwnedProcess } from "./owned/windows-owned-process.js";
import { readWindowsGuardianOperation, WINDOWS_GUARDIAN_JOB_BOUNDARY } from "./owned/windows-guardian-scope.js";
import { reserveWindowsGuardianSlot } from "./owned/windows-runtime-guardian.js";
import { readApplicationVerificationProfile, type PreparedApplicationVerificationProfile } from "./application-verification-profile.js";
import { readApplicationVerificationCandidate, type PreparedApplicationVerificationCandidate } from "./application-verification-candidate.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";

const sha = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const initializedSchema = z.object({ version: z.literal(1), kind: z.literal("application-service.initialized"),
  reference: ApplicationRuntimeFilePinSchema, qualified_for_product: z.literal(false),
  closure: z.object({ version: z.literal(1), scope: z.literal("original-native-owners"), create_broker_normal: z.literal(true),
    installation_audited: z.literal(true), session_released: z.literal(true) }).strict() }).strict();
const listeningSchema = z.object({ version: z.literal(1), kind: z.literal("application-service.listening"), origin: z.string(),
  qualified_for_product: z.literal(false), maximum_requests: z.literal(256), maximum_concurrent: z.literal(1) }).strict();
const closureSchema = z.object({ version: z.literal(1), scope: z.literal("original-native-owners"), invocations: z.number().int().min(0).max(256),
  runtime_normal_closures: z.number().int().min(0).max(256), broker_normal_closures: z.number().int().min(0).max(256),
  listener_closed: z.literal(true), preflight_normal: z.literal(true), installation_audited: z.literal(true), session_released: z.literal(true),
}).strict().refine(value => value.invocations === value.runtime_normal_closures && value.invocations === value.broker_normal_closures);
const closedSchema = z.object({ version: z.literal(1), kind: z.literal("application-service.closed"), started: z.literal(true),
  reason: z.literal("stdin"), closure: closureSchema, qualified_for_product: z.literal(false) }).strict();
declare const initializedBrand: unique symbol;
export interface InitializedApplicationVerificationStore { readonly [initializedBrand]: true }
interface Store { readonly profile: PreparedApplicationVerificationProfile; readonly candidate: PreparedApplicationVerificationCandidate;
  readonly reference: ApplicationRuntimeFilePin; readonly testStoreId: string; readonly nodeId: string; readonly backend: PreparedWindowsProcessBackend }
const stores = new WeakMap<object, Store>();
interface OriginalProcess { readonly ready: Promise<void>; readonly closed: Promise<void>; shutdown(): Promise<void>; cancel(error: unknown): void;
  initialized(): z.infer<typeof initializedSchema>; invocations(): number }

/** Use the existing original installation writer and one prepare transition for
 * a separate immutable selection package, including failure retention. The tag
 * identifies this writer's generation; it is not an application service profile. */
function prepareSelection(profile: PreparedApplicationVerificationProfile, nodeId: string, backend: PreparedWindowsProcessBackend,
  selection: unknown, signal: AbortSignal): { installation: PreparedApplicationInstallation; file: ApplicationRuntimeFilePin } {
  const configured = readApplicationVerificationProfile(profile);
  const owner = createApplicationInstallationOwner({ parent: configured.config.selection_parent, nodeId, allowedRoots: configured.roots,
    node: configured.config.node, backend, signal });
  try {
    const bytes = Buffer.from(JSON.stringify(selection) + "\n"), tag = Buffer.from(JSON.stringify({ version: 1,
      format: "artoo.application-verification-selection-package.v1", installation: { version: 1, generation_id: owner.generationId } }) + "\n");
    if (bytes.length > 65_536) throw Error("Application selection exceeds bound");
    const file = Object.freeze({ path: win32.join(owner.directory, "selection.json"), bytes: bytes.length, sha256: sha(bytes) });
    const installation = owner.install({ version: 1, directories: [], files: [
      { path: "selection.json", bytes: bytes.length, sha256: file.sha256, content: bytes },
      { path: "generation.json", bytes: tag.length, sha256: sha(tag), content: tag }],
      profile: { path: win32.join(owner.directory, "generation.json"), bytes: tag.length, sha256: sha(tag) } });
    return { installation, file };
  } catch (error) { if (owner.describeAttempt().phase === "claimed") owner.abandon(); throw error; }
}

/** Fixed trusted host in its original native Job. Its inner runtime/broker reports
 * remain independently required after original owner closure; cancellation or a
 * successful-looking marker cannot qualify a stopped or uncertain operation. */
function start(profile: PreparedApplicationVerificationProfile, nodeId: string, backend: PreparedWindowsProcessBackend,
  target: { candidate: PreparedApplicationVerificationCandidate } | { store: Store }, deadline: number, signal: AbortSignal): OriginalProcess {
  signal.throwIfAborted();
  if (!Number.isFinite(deadline)) throw Error("Application bootstrap requires its original finite deadline");
  const checkDeadline = (message = "Application bootstrap deadline elapsed") => {
    signal.throwIfAborted(); if (performance.now() >= deadline) throw Error(message);
  };
  checkDeadline("Application bootstrap deadline elapsed before spawn");
  const configured = readApplicationVerificationProfile(profile); checkDeadline();
  const native = describeWindowsProcessInstallation(backend); checkDeadline();
  const systemRoot = realpathSync.native(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "");
  const selection = { version: 1, node_id: nodeId, writable_workspace_roots: configured.roots, node: configured.config.node,
    host_manifest: configured.config.hostManifest, backend: { directory: native.directory, manifest_sha256: native.manifestSha256 },
    system_root: systemRoot, shutdown: "stdin", ...("candidate" in target ? {
      format: "artoo.application-initialize-selection.v1", installation_parent: configured.config.installation_parent,
      source_manifest: readApplicationVerificationCandidate(target.candidate).manifest,
    } : { format: "artoo.application-service-selection.v1", installation_reference: target.store.reference }) };
  checkDeadline(); const prepared = prepareSelection(profile, nodeId, backend, selection, signal);
  const audit = () => { checkDeadline(); readApplicationVerificationProfile(profile); auditApplicationInstallation(prepared.installation);
    readApplicationRuntimePin(prepared.file); readApplicationVerificationCandidate("candidate" in target ? target.candidate : target.store.candidate); checkDeadline(); };
  audit(); signal.throwIfAborted();
  if (performance.now() >= deadline) throw Error("Application bootstrap deadline elapsed before spawn");
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void, resolveClosed!: () => void, rejectClosed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); void ready.catch(() => {});
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; }); void closed.catch(() => {});
  let initialized: z.infer<typeof initializedSchema> | undefined, closure: z.infer<typeof closedSchema> | undefined;
  let listened = false, requested = false, finished = false, cancellationIssued = false, ownerJoined = false;
  let child: WindowsOwnedProcess | undefined, started: Awaited<WindowsOwnedProcess["started"]> | undefined, failure: unknown;
  let bytes = 0, pending = Buffer.alloc(0), events = 0;
  let input: Promise<OriginalTargetInputReceipt> | undefined;
  const shutdownBytes = Buffer.from('{"version":1,"kind":"shutdown"}\n');
  const shutdownDigest = sha(shutdownBytes);
  const admission = new AbortController(), streams = new AbortController();
  const causes = (...values: unknown[]) => new AggregateError([...new Set(values.filter(value => value !== undefined))],
    "Original application failure and native owner observations");
  const finish = (error?: unknown) => {
    if (finished) return; finished = true; clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (error) { failure ??= error; rejectReady(error); rejectClosed(error); } else { resolveReady(); resolveClosed(); }
  };
  const cancelOwner = () => {
    if (!child || cancellationIssued) return; cancellationIssued = true;
    try { child.cancel(); }
    catch (error) { failure = new AggregateError([failure, error], "Application failure and original owner cancellation failure"); }
  };
  const fail = (error: unknown) => {
    failure ??= error; rejectReady(failure);
    if (finished) return;
    streams.abort(failure);
    if (child) cancelOwner(); else admission.abort(failure);
    // The original native owner owns its cleanup bound. Never release this wrapper
    // from a separate timer while that owner's closed promise is still pending.
  };
  const cancel = () => fail(signal.reason ?? Error("Application bootstrap cancelled"));
  const timer = setTimeout(() => fail(Error("Application bootstrap original deadline elapsed")), Math.max(1, deadline - performance.now()));
  const maybeReady = () => {
    if (!listened || !started || failure || finished) return;
    try { audit(); signal.throwIfAborted(); if (performance.now() >= deadline) throw Error("Application bootstrap deadline elapsed"); resolveReady(); }
    catch (error) { fail(error); }
  };
  const writeShutdown = (): void => {
    if (requested || finished || failure) return; requested = true;
    try {
      signal.throwIfAborted(); if (performance.now() >= deadline) throw Error("Application bootstrap deadline elapsed before shutdown");
      if (!child?.endInput || !started || !listened) throw Error("Original application target input is unavailable");
      input = child.endInput(Buffer.from(shutdownBytes));
      void input.then(() => {}, fail);
    } catch (error) { fail(error); }
  };
  const onOutput = (value: Buffer) => {
    try {
      bytes += value.length; if (bytes > 12_288) throw Error("Application bootstrap output exceeds bound");
      pending = Buffer.concat([pending, value]);
      for (;;) {
        const index = pending.indexOf(10); if (index < 0) break;
        if (index + 1 > 4096 || ++events > 2) throw Error("Application bootstrap status bound exceeded");
        const event: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, index)));
        pending = pending.subarray(index + 1);
        if ("candidate" in target) {
          if (initialized) throw Error("Duplicate application initialization status");
          initialized = initializedSchema.parse(event);
        } else if (!listened) {
          const value = listeningSchema.parse(event);
          if (value.origin !== configured.config.origin || requested) throw Error("Application origin or startup differs");
          listened = true; maybeReady();
        } else {
          if (!requested || closure) throw Error("Unexpected application closure status");
          closure = closedSchema.parse(event);
        }
      }
      if (pending.length >= 4096) throw Error("Application status line exceeds bound");
    } catch (error) { fail(error); }
  };
  const onDiagnostic = () => fail(Error("Application bootstrap reported a diagnostic failure"));
  try { signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel(); }
  catch (error) { clearTimeout(timer); throw error; }
  void (async () => {
    try {
      const scope = readWindowsGuardianOperation(backend);
      checkDeadline();
      const launch = Object.freeze({
        executable: configured.config.node.path, args: Object.freeze([configured.hostEntry.path, `--selection=${prepared.file.path}`]),
        // The fixed host uses absolute protected paths. A registered launch stays
        // inside its original authenticated workspace, never a caller-selected cwd.
        cwd: scope?.workspaceRoot ?? win32.dirname(configured.hostEntry.path),
        env: Object.freeze({ SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, "System32") }),
        cleanupTimeoutMs: 5000, maxOutputBytes: 12_288, normalExitPolicy: "require-empty" as const, normalExitGraceMs: 250,
        targetInput: Object.freeze({ version: 1, mode: "single-message-eof", maximumBytes: 4096 } as const),
      });
      // Reserve with the original authenticated operation. Keep the absolute
      // deadline in the binding and compute the native budget only AFTER this await.
      const guardianSlot = scope ? await reserveWindowsGuardianSlot(scope.guardian, { operationKind: "verifier", operationId: scope.operationId,
        bindingDigest: sha(Buffer.from(JSON.stringify({ version: 1, format: "artoo.application-bootstrap-launch.v1",
          boundary: WINDOWS_GUARDIAN_JOB_BOUNDARY, operation: scope.bindingDigest, selection: prepared.file, deadline, launch }))),
        serverOperation: scope.serverOperation }) : undefined;
      admission.signal.throwIfAborted(); signal.throwIfAborted();
      if (readWindowsGuardianOperation(backend) !== scope) throw Error("Original application Guardian operation changed");
      audit();
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) throw Error("Application bootstrap deadline elapsed before spawn");
      child = startWindowsOwnedProcess(backend, { ...launch, timeoutMs: remaining, signal: admission.signal, ...(guardianSlot ? { guardianSlot } : {}) });
      child.stdout.on("data", onOutput); child.stderr.on("data", onDiagnostic);
      child.stdout.on("error", fail); child.stderr.on("error", fail); child.on("error", fail);
      const outputClosed = Promise.all([streamFinished(child.stdout, { cleanup: true, signal: streams.signal }),
        streamFinished(child.stderr, { cleanup: true, signal: streams.signal })]);
      void outputClosed.catch(fail);
      const startup = child.started.then(value => { started = value; maybeReady(); }, fail);
      void child.closed.catch(fail);
      if (!child.endInput) fail(Error("Original application owner lacks the selected target input capability"));
      if (failure) cancelOwner();
      if (performance.now() >= deadline) fail(Error("Application bootstrap deadline elapsed during native admission"));
      // Join this exact owner even on startup failure, and drain its original
      // Readables before interpreting the final internal closure summary.
      const [nativeResult, outputResult] = await Promise.allSettled([child.closed, outputClosed]);
      ownerJoined = true;
      await startup;
      if (nativeResult.status === "rejected" || outputResult.status === "rejected") {
        throw new VerificationCleanupError("Original application bootstrap closure is unconfirmed", {
          cause: causes(failure, nativeResult.status === "rejected" ? nativeResult.reason : nativeResult.value,
            outputResult.status === "rejected" ? outputResult.reason : undefined) });
      }
      const receipt = nativeResult.value, inputFact = receipt.targetInput;
      let ack: OriginalTargetInputReceipt | undefined;
      try { ack = input ? await input : undefined; }
      catch (error) { throw new VerificationCleanupError("Original application shutdown input was not acknowledged", { cause: causes(failure, error, receipt) }); }
      if (failure || !isWindowsOwnedClosureReceipt(receipt) || !receipt.cleanupConfirmed || !started?.creationTime
        || receipt.rootPid !== started.pid || receipt.rootCreationTime !== started.creationTime
        || !receipt.rootCreated || !receipt.rootStarted || receipt.noTargetCreated || !receipt.atomicJobMember || !receipt.rootWaitObserved
        || receipt.rootExitCode !== 0 || !receipt.stdoutEof || !receipt.stderrEof || !receipt.jobEmptyObserved
        || !receipt.helperSpawnObserved || !receipt.helperExitObserved || !receipt.helperCloseObserved
        || receipt.helperExitCode !== 0 || receipt.helperSignal !== null || receipt.terminationReason !== null
        || receipt.nativeTerminationReason !== null || receipt.failureCode !== null || receipt.nativeError !== null
        || !inputFact || inputFact.version !== 1 || !inputFact.pipeCreated || !inputFact.inputClosed || pending.length
        || ("candidate" in target ? !initialized || events !== 1 || inputFact.writeRequested || inputFact.requestId !== null || inputFact.bytesWritten !== 0
          : !closure || !listened || events !== 2 || !ack || !isWindowsOwnedTargetInputReceipt(ack)
            || ack.token !== receipt.token || ack.requestId !== inputFact.requestId || !inputFact.writeRequested
            || ack.bytesWritten !== shutdownBytes.length || inputFact.bytesWritten !== shutdownBytes.length
            || ack.sha256 !== shutdownDigest || ack.inputClosed !== true)) {
        throw new VerificationCleanupError("Application bootstrap did not confirm normal original host and native-owner closure", { cause: causes(failure, receipt) });
      }
      audit(); signal.throwIfAborted(); if (performance.now() >= deadline) throw Error("Application bootstrap deadline elapsed");
      finish();
    } catch (error) {
      if (child && !ownerJoined) {
        fail(error);
        let terminal: unknown;
        try { terminal = await child.closed; }
        catch (cleanup) { terminal = cleanup; }
        finish(new VerificationCleanupError("Original application bootstrap setup failed after owner creation", { cause: causes(failure, error, terminal) }));
      } else finish(failure && failure !== error && !ownerJoined
        ? new AggregateError([failure, error], "Application admission failure and original cancellation/deadline") : error);
    }
  })();
  return Object.freeze({ ready, closed, shutdown: () => { writeShutdown(); return closed; }, cancel: fail,
    initialized: () => { if (!finished || failure || !initialized) throw Error("Original application initialization not complete"); return initialized; },
    invocations: () => { if (!finished || failure || !closure) throw Error("Original application service not normally closed"); return closure.closure.invocations; } });
}

export async function initializeApplicationVerificationStore(profile: PreparedApplicationVerificationProfile,
  candidate: PreparedApplicationVerificationCandidate, nodeId: string, backend: PreparedWindowsProcessBackend,
  deadline: number, signal: AbortSignal): Promise<InitializedApplicationVerificationStore> {
  const original = start(profile, nodeId, backend, { candidate }, deadline, signal); await original.closed;
  signal.throwIfAborted(); if (performance.now() >= deadline) throw Error("Application bootstrap deadline elapsed");
  const reference = Object.freeze({ ...original.initialized().reference }), configured = readApplicationVerificationProfile(profile);
  const control = win32.dirname(reference.path), generation = win32.dirname(control), testStoreId = win32.basename(generation);
  if (win32.basename(reference.path) !== "REOPEN.v1.json" || win32.basename(control) !== "control"
    || win32.dirname(generation) !== configured.config.installation_parent || !z.string().guid().safeParse(testStoreId).success) throw Error("Initialized application reference escaped its selected store");
  readApplicationRuntimePin(reference);
  signal.throwIfAborted(); if (performance.now() >= deadline) throw Error("Application bootstrap deadline elapsed after store audit");
  const token = Object.freeze({}) as InitializedApplicationVerificationStore;
  stores.set(token, { profile, candidate, reference, testStoreId, nodeId, backend }); return token;
}
export function readApplicationVerificationStore(token: InitializedApplicationVerificationStore): { testStoreId: string } {
  const store = stores.get(token); if (!store) throw Error("Original initialized application store required");
  readApplicationRuntimePin(store.reference); return { testStoreId: store.testStoreId };
}
export async function startApplicationVerificationService(token: InitializedApplicationVerificationStore, deadline: number, signal: AbortSignal) {
  const store = stores.get(token); if (!store) throw Error("Original initialized application store required");
  const original = start(store.profile, store.nodeId, store.backend, { store }, deadline, signal);
  try { await original.ready; signal.throwIfAborted(); if (performance.now() >= deadline) throw Error("Application service startup deadline elapsed"); } catch (error) {
    original.cancel(error);
    try { await original.closed; }
    catch (cleanup) { throw new VerificationCleanupError("Application service startup and original closure failed", {
      cause: new AggregateError([error, cleanup], "Original application startup and cleanup observations") }); }
    throw error;
  }
  return Object.freeze({ closed: original.closed, close: original.shutdown, invocations: original.invocations });
}
