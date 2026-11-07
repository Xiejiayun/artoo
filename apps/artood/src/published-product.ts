import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { ProductReleaseRequestSchema, ProductReleaseReceiptSchema, type ProductReleaseReceipt } from "@artoo/domain";
import { prepareWindowsProcessInstallation, type WindowsProcessInstallation } from "./windows-process-installation.js";
import { prepareWindowsReleaseStorage } from "./windows-release-storage.js";
import { loadVerificationProfilesFile, prepareVerificationProfiles, attachWindowsVerificationBackend, subjectManifest } from "./verification.js";
import { loadReleaseProfilesFile, prepareReleaseProfiles, createProductReleaseExecutor } from "./product-release.js";
import { fetchReleaseHealthGet } from "./release-health-transport.js";

const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never { throw new Error(`Published product: ${message}`); }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected a local record");
  return value as Record<string, unknown>;
};
const inside = (root: string, value: string): boolean => {
  const tail = relative(root, value); return tail === "" || tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
};
function physical(path: string, directory: boolean) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path) || realpathSync.native(path) !== path) fail("nonphysical local path");
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail("linked or unsupported local path");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (lstatSync(parent).isSymbolicLink() || realpathSync.native(parent) !== parent) fail("linked local ancestor");
    if (dirname(parent) === parent) break;
  }
  return stat;
}
function jsonValue(path: string, maximum = 4 * 1024 * 1024): unknown {
  const stat = physical(path, false); if (stat.size > BigInt(maximum)) fail("local record exceeds its bound");
  const bytes = readFileSync(path); if (bytes.length > maximum) fail("local record grew beyond its bound");
  return JSON.parse(bytes.toString("utf8"));
}
const json = (path: string): Record<string, unknown> => record(jsonValue(path));
export interface PublishedProductFilePin { readonly path: string; readonly bytes: number; readonly sha256: string }
function pinnedBytes(pin: PublishedProductFilePin): Buffer {
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(pin.sha256)) fail("invalid result pin");
  const stat = physical(pin.path, false); if (stat.size !== BigInt(pin.bytes)) fail("pinned local file size changed");
  const bytes = readFileSync(pin.path);
  if (bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) fail("pinned local file changed");
  return bytes;
}

export interface PublishedProductOwnershipDescriptor {
  readonly version: 1; readonly session_root: string; readonly mode: "daily" | "reopen";
  readonly owner_id: string; readonly acquired_at: string;
}
export interface PublishedProductOwnershipReceipt extends PublishedProductOwnershipDescriptor {
  readonly released_at: string; readonly lock_removed: true;
}
export interface PublishedProductOwnership {
  readonly descriptor: PublishedProductOwnershipDescriptor;
  assertHeld(): void;
  release(): PublishedProductOwnershipReceipt;
}
interface OwnershipState { assertHeld(): void; readonly descriptor: PublishedProductOwnershipDescriptor; readonly consumers: Set<object> }
const ownerships = new WeakMap<object, OwnershipState>();

/** Shared by the original daily publisher and every later opener. A leftover
 * directory is uncertainty, never permission to reclaim by probing a PID. */
export function acquirePublishedProductOwnership(input: { sessionRoot: string; mode: "daily" | "reopen" }): PublishedProductOwnership {
  if (input.mode !== "daily" && input.mode !== "reopen") fail("invalid ownership mode");
  const root = input.sessionRoot, originalRoot = physical(root, true);
  const directory = join(root, ".published-product-owner"), file = join(directory, "owner.json");
  mkdirSync(directory, { mode: 0o700 }); // Atomic admission; EEXIST is deliberately not recovered.
  const descriptor = Object.freeze({ version: 1 as const, session_root: root, mode: input.mode,
    owner_id: randomUUID(), acquired_at: new Date().toISOString() });
  const bytes = Buffer.from(JSON.stringify(descriptor) + "\n"), fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const originalDirectory = physical(directory, true), createdFile = physical(file, false), consumers = new Set<object>();
  type IdentityKey = "dev" | "ino" | "ctimeNs" | "mtimeNs" | "size";
  const unchanged = (label: string, expected: BigIntStats, actual: BigIntStats, keys: readonly IdentityKey[]): void => {
    const changed = keys.filter(key => expected[key] !== actual[key]).map(key => ({ field: `${label}.${key}`,
      expected: expected[key].toString(), actual: actual[key].toString() }));
    if (changed.length) fail(`ownership identity changed: ${JSON.stringify(changed)}`);
  };
  const readOwner = (expected: BigIntStats, initialWindowsRead = false): BigIntStats => {
    const keys: readonly IdentityKey[] = initialWindowsRead ? ["dev", "ino", "mtimeNs", "size"] : ["dev", "ino", "ctimeNs", "mtimeNs", "size"];
    unchanged("file", expected, physical(file, false), keys);
    const reader = openSync(file, "r");
    const check = () => {
      const handle = fstatSync(reader, { bigint: true });
      if (!handle.isFile() || handle.nlink !== 1n) fail("ownership file type or link count changed");
      unchanged("handle", expected, handle, keys); unchanged("file", expected, physical(file, false), keys);
    };
    try {
      check();
      const value = Buffer.alloc(bytes.length + 1); let length = 0;
      while (length < value.length) {
        const count = readSync(reader, value, length, value.length - length, length);
        if (!count) break; length += count;
      }
      if (length !== bytes.length || !value.subarray(0, length).equals(bytes)) fail("ownership identity changed: file.bytes");
      check();
    } finally { closeSync(reader); }
    const closed = physical(file, false); unchanged("file", expected, closed, keys); return closed;
  };
  // NTFS can commit deferred access metadata on the first read/close. Before
  // handing out ownership, compare exact generated bytes and every other fact,
  // then bind ctime and require a second complete read to preserve every fact.
  // Later checks never rebase this snapshot or retry through an identity change.
  const originalFile = readOwner(createdFile, process.platform === "win32"); readOwner(originalFile);
  let released = false, releasing = false;
  const assertHeld = () => {
    if (released || releasing) fail("ownership already ended");
    const checkDirectories = () => {
      unchanged("root", originalRoot, physical(root, true), ["dev", "ino"]);
      unchanged("directory", originalDirectory, physical(directory, true), ["dev", "ino"]);
      if (!isDeepStrictEqual(readdirSync(directory).sort(), ["owner.json"])) fail("ownership identity changed: directory.entries");
    };
    checkDirectories(); readOwner(originalFile); checkDirectories();
  };
  const owner = Object.freeze({ descriptor, assertHeld, release(): PublishedProductOwnershipReceipt {
    assertHeld(); if (consumers.size) fail("publisher closure has not been confirmed");
    releasing = true;
    // Delete only the original, exactly checked single-file directory. Any partial
    // failure remains latched; this handle cannot silently retry or mint a receipt.
    unlinkSync(file); rmdirSync(directory); released = true;
    return Object.freeze({ ...descriptor, released_at: new Date().toISOString(), lock_removed: true as const });
  } });
  ownerships.set(owner, { descriptor, assertHeld, consumers }); return owner;
}

export interface PublishedProductSelection {
  readonly release_id: string; readonly run_id: string; readonly evidence_id: string;
  readonly artifact_digest: string; readonly url: string; readonly request_sha256: string; readonly receipt_sha256: string;
  /** Original server values, retained before JSONB/key ordering can be confused
   * with the equivalent native journal serialization. They grant no new release. */
  readonly request: unknown; readonly receipt: unknown;
}
export interface PublishedProductOptions {
  readonly version: 1;
  readonly closedSessionResult: PublishedProductFilePin;
  readonly verificationProfilesFile: string;
  readonly releaseProfilesFile: string;
  readonly releaseProfileId: string;
  readonly windowsProcessInstallation: WindowsProcessInstallation;
  readonly publication: PublishedProductSelection;
  readonly exclusive: PublishedProductOwnership;
}
export interface PublishedProductObservation {
  readonly release_id: string; readonly artifact_digest: string; readonly url: string; readonly observed_at: string;
  readonly health_checks: ProductReleaseReceipt["health_checks"];
}
export interface PublishedProduct {
  /** Existing publisher health/withdrawal policy remains active. A withdrawn or
   * changed selected version rejects; callers must stop and retain its evidence. */
  start(): Promise<PublishedProductObservation>;
  observe(): Promise<PublishedProductObservation>;
  stop(): Promise<Readonly<{ cleanupConfirmed: true }>>;
}

/** Serves one already completed local product. No goal, node connection, source
 * recovery/clean owner, verifier execution, model or database is created here.
 * The original profile's publisher monitoring and withdrawal policy still runs;
 * it may update health/current journals. A selected-version change fails closed
 * and retains ownership plus the original receipt and resulting journal state. */
export function createPublishedProduct(options: PublishedProductOptions): PublishedProduct {
  const owner = ownerships.get(options.exclusive);
  if (options.version !== 1 || !owner || owner.descriptor.mode !== "reopen") fail("original local reopen ownership required");
  owner.assertHeld();
  const root = owner.descriptor.session_root, originalPin = { ...options.closedSessionResult }, selected = structuredClone(options.publication);
  const configPins: PublishedProductFilePin[] = [];
  if (originalPin.path !== join(root, "RESULT.json")) fail("result is outside the owned original session");
  const selectionFields = ["release_id", "run_id", "evidence_id", "artifact_digest", "url", "request_sha256", "receipt_sha256", "request", "receipt"] as const;
  for (const key of ["release_id", "run_id", "evidence_id"] as const) if (typeof selected[key] !== "string" || !selected[key] || selected[key].length > 256) fail("invalid publication identity");
  if (!/^sha256:[a-f0-9]{64}$/.test(selected.artifact_digest)
    || !/^[a-f0-9]{64}$/.test(selected.request_sha256) || !/^[a-f0-9]{64}$/.test(selected.receipt_sha256)
    || sha(JSON.stringify(selected.request)) !== selected.request_sha256 || sha(JSON.stringify(selected.receipt)) !== selected.receipt_sha256) fail("original publication snapshot changed");
  const request = ProductReleaseRequestSchema.parse(selected.request), receipt = ProductReleaseReceiptSchema.parse(selected.receipt);
  if (request.imported_recovery || request.imported_clean || receipt.outcome !== "published"
    || !isDeepStrictEqual(receipt.request, request) || request.release_id !== selected.release_id || request.run_id !== selected.run_id
    || request.subject_digest !== selected.artifact_digest || receipt.artifact_digest !== selected.artifact_digest || receipt.endpoint !== selected.url) fail("selection is not an ordinary successful publication");
  function assertOriginal(): void {
    owner!.assertHeld(); const result = record(JSON.parse(pinnedBytes(originalPin).toString("utf8"))), publication = record(result.publication);
    for (const pin of configPins) pinnedBytes(pin);
    if (result.version !== 1 || result.scope !== "windows-local-single-goal" || result.output !== root
      || result.status !== "stopped-after-publication" || result.product_published !== true || result.shutdown_confirmed !== true
      || result.server_closed !== true || result.inputs_unchanged !== true || !Array.isArray(result.errors) || result.errors.length
      || result.logical_goals_created !== 1 || result.goal_id !== request.goal_id) fail("original daily session did not confirm successful shutdown");
    if (!isDeepStrictEqual(result.shutdown_control, { version: 1, mode: "stdin", commands: 1, complete: true })) fail("original stdin shutdown is not confirmed");
    const prior = record(result.publisher_ownership);
    if (prior.version !== 1 || prior.session_root !== root || prior.mode !== "daily" || prior.lock_removed !== true
      || typeof prior.owner_id !== "string" || !/^[a-f0-9-]{36}$/.test(prior.owner_id) || prior.owner_id === owner!.descriptor.owner_id
      || typeof prior.acquired_at !== "string" || !Number.isFinite(Date.parse(prior.acquired_at))
      || typeof prior.released_at !== "string" || !Number.isFinite(Date.parse(prior.released_at))) fail("original publisher ownership was not released");
    if (!Array.isArray(result.nodes) || result.nodes.length !== 2) fail("original node closure evidence missing");
    const roles = new Set<string>();
    for (const value of result.nodes) {
      const node = record(value), cli = record(node.cli), stopped = record(cli.stopped);
      if (node.role !== "source" && node.role !== "destination" || roles.has(String(node.role))) fail("original node identities differ");
      roles.add(String(node.role));
      if (node.registry_disconnected !== true || cli.spawned !== true || cli.shutdown_written !== true || cli.forced_root_kill !== false
        || cli.stdout_eof !== true || cli.stderr_eof !== true || stopped.kind !== "artoo.supervised.stopped" || stopped.cleanupConfirmed !== true
        || !isDeepStrictEqual(cli.exit, { code: 0, signal: null }) || !isDeepStrictEqual(cli.close, { code: 0, signal: null })) fail("original node shutdown is unconfirmed");
    }
    for (const key of selectionFields) if (!isDeepStrictEqual(publication[key], selected[key])) fail("selected product differs from original result");
  }
  assertOriginal();
  const consumer = {}; owner.consumers.add(consumer);
  for (const [file, name] of [[options.verificationProfilesFile, "verifiers.json"], [options.releaseProfilesFile, "releases.json"]] as const) {
    if (file !== join(root, "destination", "config", name)) fail("profile configuration is outside the original destination");
    const stat = physical(file, false); if (stat.size > 4n * 1024n * 1024n) fail("profile configuration exceeds its bound");
    const bytes = readFileSync(file); configPins.push({ path: file, bytes: bytes.length, sha256: sha(bytes) });
  }
  const roots = [...options.windowsProcessInstallation.writableWorkspaceRoots];
  if (roots.some(path => inside(path, root))) fail("session ownership must be outside agent write roots");
  // Qualification remains the ordinary Windows installation/storage boundary.
  // These calls are intentionally after shared ownership and original closure.
  const backend = prepareWindowsProcessInstallation({ ...options.windowsProcessInstallation, writableWorkspaceRoots: roots });
  const rawVerifiers = loadVerificationProfilesFile(options.verificationProfilesFile, roots);
  const verifiers = prepareVerificationProfiles(rawVerifiers, roots);
  for (const verifier of verifiers) attachWindowsVerificationBackend(verifier, backend);
  const rawProfiles = loadReleaseProfilesFile(options.releaseProfilesFile, rawVerifiers, roots);
  const raw = rawProfiles.find(profile => profile.id === options.releaseProfileId);
  if (!raw || raw.storage_root !== join(root, "destination", "release")) fail("release storage is outside the owned product session");
  const storage = prepareWindowsReleaseStorage({ directory: raw.storage_root, writableWorkspaceRoots: roots });
  const [profile] = prepareReleaseProfiles([raw], verifiers, { windowsStorage: new Map([[raw.storage_root, storage]]), writableRoots: roots });
  if (!profile || profile.public_url !== selected.url || profile.listen_host !== "127.0.0.1"
    || new URL(profile.public_url).protocol !== "http:" || new URL(profile.public_url).hostname !== "127.0.0.1"
    || Number(new URL(profile.public_url).port) !== profile.listen_port || profile.digest !== receipt.release_profile_digest
    || profile.id !== request.release_profile_id || profile.project_id !== request.project_id
    || profile.verifier.id !== request.verification_profile_id || profile.verifier.digest !== request.verification_profile_digest) fail("original local publication profile changed");
  const prepared = profile;
  if (!isDeepStrictEqual(profile.health_checks.map(check => check.path), receipt.health_checks.map(check => check.path))) fail("original health paths changed");
  let failure: Error | undefined, closing = false, started = false;
  const failed = (error: unknown): Error => failure ??= error instanceof Error ? error : new Error("Published product execution failed");
  const executor = createProductReleaseExecutor([prepared], { onError: error => { failed(error); } });
  const controller = new AbortController(), pending = new Set<Promise<unknown>>();
  const stoppingError = new Error("Published product is stopping");
  let startPromise: Promise<PublishedProductObservation> | undefined, stopPromise: Promise<Readonly<{ cleanupConfirmed: true }>> | undefined;
  function assertJournal(): void {
    assertOriginal(); const names = readdirSync(prepared.storage_root);
    if (names.includes("source-recovery.json") || names.includes("source-clean-restart.json")) fail("publication has a recovery or clean fence");
    if (!isDeepStrictEqual(jsonValue(join(prepared.storage_root, "current.json")), {
      release_id: selected.release_id, artifact_digest: selected.artifact_digest, release_profile_digest: prepared.digest,
    })) fail("active product version changed");
    const artifact = join(prepared.storage_root, "artifacts", selected.artifact_digest.slice(7)), content = join(artifact, "content");
    physical(artifact, true); physical(content, true);
    const measured = subjectManifest({ ...prepared.verifier, workspace_root: content });
    if (measured.digest !== selected.artifact_digest || !isDeepStrictEqual(json(join(artifact, "manifest.json")), {
      digest: measured.digest, files: [...measured.files.values()], directories: measured.directories,
    })) fail("stored product artifact changed");
    let remaining = 32 * 1024 * 1024;
    for (const folder of ["operations", "health"] as const) {
      const directory = join(prepared.storage_root, folder); physical(directory, true);
      const entries = readdirSync(directory); if (entries.length > 10000) fail("publication journal exceeds its bound");
      for (const name of entries) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) fail("unsupported unfinished publication journal");
        const path = join(directory, name), stat = physical(path, false); remaining -= Number(stat.size);
        if (remaining < 0) fail("publication journal bytes exceed their bound");
        const item = json(path);
        if (folder === "operations" && item.phase !== "terminal" || folder === "health" && item.phase !== "monitoring" && item.phase !== "terminal") fail("unfinished publication requires its original owner");
      }
    }
    // These APIs validate native journal schemas, and may initialize layout. They
    // therefore stay inside ownership, after the read-only unfinished-state gate.
    const matching = executor.getPublicationReceipts().filter(value => value.request.release_id === selected.release_id);
    if (matching.length !== 1 || !isDeepStrictEqual(matching[0], receipt)) fail("native publication receipt differs from selected product");
    const reports = executor.getHealthReports().filter(value => value.request.release_id === selected.release_id);
    if (reports.some(report => report.state !== "healthy" || report.active_release_id !== selected.release_id
      || report.active_artifact_digest !== selected.artifact_digest || !isDeepStrictEqual(report.request, request))) fail("selected product is no longer healthy");
    if (executor.getHealthFaults().length) fail("publisher has an executor fault");
  }
  function track<T>(operation: Promise<T>): Promise<T> {
    pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => {}); return operation;
  }
  async function measure(): Promise<PublishedProductObservation> {
    if (closing || failure) throw failure ?? stoppingError;
    assertJournal(); await executor.checkHealth(); assertJournal();
    const checks: ProductReleaseReceipt["health_checks"] = [];
    for (const [index, check] of prepared.health_checks.entries()) {
      const deadline = performance.now() + prepared.health_timeout_ms;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(prepared.health_timeout_ms)]);
      const response = await fetchReleaseHealthGet(new URL(check.path, prepared.public_url), signal, deadline);
      let bytes: Buffer;
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        if (Number(response.headers.get("content-length")) > 64 * 1024 * 1024) fail("product response exceeds its bound");
        if (reader) for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length; if (size > 64 * 1024 * 1024) fail("product response exceeds its bound"); chunks.push(next.value);
        }
        bytes = Buffer.concat(chunks);
      } catch (error) { if (reader) await reader.cancel().catch(() => {}); throw error; }
      finally { reader?.releaseLock(); }
      const digest = `sha256:${sha(bytes)}`;
      if (response.status !== 200 || digest !== receipt.health_checks[index]!.body_digest
        || response.headers.get("x-artoo-release-id") !== selected.release_id || response.headers.get("x-artoo-artifact-digest") !== selected.artifact_digest
        || check.expect_text !== undefined && !bytes.toString("utf8").includes(check.expect_text)
        || signal.aborted || performance.now() >= deadline) fail("actual published content identity or health differs");
      assertJournal(); checks.push({ path: check.path, status_code: response.status, body_digest: digest, passed: true, checked_at: new Date().toISOString() });
    }
    if (failure) throw failure;
    return { release_id: selected.release_id, artifact_digest: selected.artifact_digest, url: selected.url,
      observed_at: new Date().toISOString(), health_checks: checks };
  }
  return Object.freeze({
    start(): Promise<PublishedProductObservation> {
      // Reusing an in-flight start is idempotent only while its original owner
      // still holds the product. A cached observation cannot reopen a closed run.
      try { if (closing) fail("cannot start a stopped product"); owner!.assertHeld(); if (failure) throw failure; }
      catch (error) { return Promise.reject(error); }
      return startPromise ??= track((async () => {
        try { assertJournal(); await executor.start(); started = true; return await measure(); }
        catch (error) { throw error === stoppingError ? error : failed(error); }
      })());
    },
    observe(): Promise<PublishedProductObservation> {
      return track((async () => {
        try { if (!started) fail("product has not completed startup"); return await measure(); }
        catch (error) { throw error === stoppingError ? error : failed(error); }
      })());
    },
    stop(): Promise<Readonly<{ cleanupConfirmed: true }>> {
      return stopPromise ??= (async () => {
        closing = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Finish already admitted, bounded HTTP observations before stopping the
        // executor. A normal stop must not manufacture a failed health check by
        // closing the very listener that an admitted observation is measuring.
        const closure = (async () => { await Promise.allSettled([...pending]); executor.requestStop(); await executor.stop(); })();
        void closure.catch(() => {});
        try {
          await Promise.race([closure, new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              try { executor.requestStop(); } catch (error) { failed(error); }
              reject(new Error("Published product closure remains unconfirmed; ownership retained"));
            }, 30000);
          })]);
          if (failure) throw failure;
          if (executor.getHealthFaults().length) fail("publisher closure after an executor fault is unconfirmed");
          assertJournal(); owner!.consumers.delete(consumer);
          return Object.freeze({ cleanupConfirmed: true as const });
        } catch (error) { throw failed(error); }
        finally { clearTimeout(timer); }
      })();
    },
  });
}
