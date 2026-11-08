import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { createApplicationInstallationOwner, auditApplicationInstallation, type PreparedApplicationInstallation } from "./application-installation.js";
import { ApplicationRuntimeFilePinSchema, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { readApplicationRuntimePin } from "./application-runtime-installation.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
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
interface OriginalProcess { readonly ready: Promise<void>; readonly closed: Promise<void>; shutdown(): Promise<void>;
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

/** Fixed trusted host only. This is the original ChildProcess owner, not an outer
 * Windows Job containment claim. Inner compiler/runtime/broker owners remain
 * independently required. A forced exit, marker, or CLI code alone never passes. */
function start(profile: PreparedApplicationVerificationProfile, nodeId: string, backend: PreparedWindowsProcessBackend,
  target: { candidate: PreparedApplicationVerificationCandidate } | { store: Store }, deadline: number, signal: AbortSignal): OriginalProcess {
  signal.throwIfAborted(); const configured = readApplicationVerificationProfile(profile), native = describeWindowsProcessInstallation(backend);
  const systemRoot = realpathSync.native(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "");
  const selection = { version: 1, node_id: nodeId, writable_workspace_roots: configured.roots, node: configured.config.node,
    host_manifest: configured.config.hostManifest, backend: { directory: native.directory, manifest_sha256: native.manifestSha256 },
    system_root: systemRoot, shutdown: "stdin", ...("candidate" in target ? {
      format: "artoo.application-initialize-selection.v1", installation_parent: configured.config.installation_parent,
      source_manifest: readApplicationVerificationCandidate(target.candidate).manifest,
    } : { format: "artoo.application-service-selection.v1", installation_reference: target.store.reference }) };
  const prepared = prepareSelection(profile, nodeId, backend, selection, signal);
  const audit = () => { readApplicationVerificationProfile(profile); auditApplicationInstallation(prepared.installation);
    readApplicationRuntimePin(prepared.file); readApplicationVerificationCandidate("candidate" in target ? target.candidate : target.store.candidate); };
  audit(); signal.throwIfAborted();
  if (performance.now() >= deadline) throw Error("Application bootstrap deadline elapsed before spawn");
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void, resolveClosed!: () => void, rejectClosed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); void ready.catch(() => {});
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; }); void closed.catch(() => {});
  let initialized: z.infer<typeof initializedSchema> | undefined, closure: z.infer<typeof closedSchema> | undefined;
  let listened = false, requested = false, finished = false, stdoutEnd = false, stderrEnd = false, stdinFinished = false;
  let exited = false, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null, failure: unknown;
  let bytes = 0, pending = Buffer.alloc(0), events = 0, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(configured.config.node.path, [configured.hostEntry.path, `--selection=${prepared.file.path}`], {
    cwd: win32.dirname(configured.hostEntry.path), shell: false, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"],
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, "System32") } });
  const finish = (error?: unknown) => {
    if (finished) return; finished = true; clearTimeout(timer); if (cleanupTimer) clearTimeout(cleanupTimer);
    signal.removeEventListener("abort", cancel);
    if (error) { failure ??= error; rejectReady(error); rejectClosed(error); } else { resolveReady(); resolveClosed(); }
  };
  const fail = (error: unknown) => {
    failure ??= error; rejectReady(failure);
    if (finished || cleanupTimer) return;
    // Terminate only this exact original child. Never locate, adopt or kill a PID.
    // Install the one-attempt latch first: kill may synchronously emit error.
    cleanupTimer = setTimeout(() => finish(new VerificationCleanupError("Original application bootstrap closure is unconfirmed", { cause: failure })), 5_000);
    try { child.kill(); } catch { /* The original failure and bounded closure join remain authoritative. */ }
  };
  const cancel = () => fail(Error("Application bootstrap cancelled"));
  const timer = setTimeout(() => fail(Error("Application bootstrap original deadline elapsed")), Math.max(1, deadline - performance.now()));
  const writeShutdown = (): void => {
    if (requested || finished) return; requested = true;
    child.stdin.end('{"version":1,"kind":"shutdown"}\n');
  };
  child.stdin.on("finish", () => { stdinFinished = true; });
  child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail); child.on("error", fail);
  child.stdout.on("data", (value: Buffer) => {
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
          listened = true; audit(); resolveReady();
        } else {
          if (!requested || closure) throw Error("Unexpected application closure status");
          closure = closedSchema.parse(event);
        }
      }
      if (pending.length >= 4096) throw Error("Application status line exceeds bound");
    } catch (error) { fail(error); }
  });
  child.stderr.on("data", () => fail(Error("Application bootstrap reported a diagnostic failure")));
  child.stdout.on("end", () => { stdoutEnd = true; }); child.stderr.on("end", () => { stderrEnd = true; });
  child.once("exit", (code, reason) => { exited = true; exitCode = code; exitSignal = reason; });
  child.once("close", (code, reason) => {
    try {
      if (failure || !exited || exitCode !== 0 || code !== 0 || exitSignal !== null || reason !== null
        || !stdoutEnd || !stderrEnd || pending.length || ("candidate" in target ? !initialized || events !== 1 : !stdinFinished || !closure || !listened || events !== 2)) {
        throw new VerificationCleanupError("Application bootstrap did not confirm normal original host and native-owner closure", { cause: failure });
      }
      audit(); signal.throwIfAborted(); if (performance.now() >= deadline) throw Error("Application bootstrap deadline elapsed");
      finish();
    } catch (error) { finish(error); }
  });
  signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
  return Object.freeze({ ready, closed, shutdown: () => { writeShutdown(); return closed; },
    initialized: () => { if (!finished || failure || !initialized) throw Error("Original application initialization not complete"); return initialized; },
    invocations: () => { if (!finished || failure || !closure) throw Error("Original application service not normally closed"); return closure.closure.invocations; } });
}

export async function initializeApplicationVerificationStore(profile: PreparedApplicationVerificationProfile,
  candidate: PreparedApplicationVerificationCandidate, nodeId: string, backend: PreparedWindowsProcessBackend,
  deadline: number, signal: AbortSignal): Promise<InitializedApplicationVerificationStore> {
  const original = start(profile, nodeId, backend, { candidate }, deadline, signal); await original.closed;
  const reference = Object.freeze({ ...original.initialized().reference }), configured = readApplicationVerificationProfile(profile);
  const control = win32.dirname(reference.path), generation = win32.dirname(control), testStoreId = win32.basename(generation);
  if (win32.basename(reference.path) !== "REOPEN.v1.json" || win32.basename(control) !== "control"
    || win32.dirname(generation) !== configured.config.installation_parent || !z.string().guid().safeParse(testStoreId).success) throw Error("Initialized application reference escaped its selected store");
  readApplicationRuntimePin(reference);
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
  try { await original.ready; } catch (error) {
    try { await original.closed; }
    catch (cleanup) { throw new VerificationCleanupError("Application service startup and original closure failed", {
      cause: new AggregateError([error, cleanup], "Original application startup and cleanup observations") }); }
    throw error;
  }
  return Object.freeze({ closed: original.closed, close: original.shutdown, invocations: original.invocations });
}
