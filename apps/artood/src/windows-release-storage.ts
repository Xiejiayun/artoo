import { createHash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertCanonicalWindowsPath, assertNativeWindows, collectWindowsAclFacts, MAX_WINDOWS_AUDIT_PATHS,
  physicalWindowsDirectory, TRUSTED_WINDOWS_SYSTEM_SIDS, WINDOWS_ANCESTOR_REPLACEMENT_MASK, WINDOWS_MUTATION_MASK,
  windowsPathComponents, windowsPathKey, windowsPathsOverlap, type WindowsAclFact, type WindowsAclTarget } from "./windows-local-acl.js";
import { markWindowsStorageFailure, type WindowsStorageChangeField, type WindowsStorageFailureCode } from "./windows-storage-diagnostic.js";
import { isWindowsSealedRecordAudit, isWindowsSealedRecordIntegrity,
  type WindowsSealedRecordAuditV1, type WindowsSealedRecordBindingV1 } from "./windows-sealed-record-observer.js";

declare const storageBrand: unique symbol;
export interface PreparedWindowsReleaseStorage { readonly [storageBrand]: true }
export interface WindowsReleaseStorageInput {
  readonly directory: string;
  /** Complete fixed node write scope, never just the release verifier's workspace. */
  readonly writableWorkspaceRoots: readonly string[];
}
interface Identity { path: string; dev: bigint; ino: bigint; directory: boolean; ctimeNs: bigint; mtimeNs: bigint; size: bigint }
interface StorageState {
  directory: string; roots: readonly string[]; fixed: ReadonlyMap<string, Identity>; sid?: string;
  /** Stable existing layout directories. Artifact staging and files legitimately change across writes. */
  layout: Map<string, Identity>;
  /** Only this module's successful exclusive dispatch writer can register entries. */
  sealed: Map<string, WindowsSealedRecordBindingV1>;
}
const authorities = new WeakMap<object, StorageState>();
const LAYOUT = ["operations", "attestations", "artifacts", "health"] as const;
function fail(reason: string, code: WindowsStorageFailureCode = "storage_boundary_rejected", fields?: readonly WindowsStorageChangeField[]): never {
  throw markWindowsStorageFailure(new Error(`Windows release storage: ${reason}`), code, fields);
}
function fact(path: string): Identity {
  assertCanonicalWindowsPath(path);
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)
      || realpathSync.native(path) !== path) fail(`linked, aliased or unsupported path: ${path}`);
    return { path, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(), ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, size: stat.size };
  } catch (error) { throw markWindowsStorageFailure(error, "filesystem_observation_failed"); }
}
function identityEqual(left: Identity, right: Identity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.directory === right.directory;
}
function diagnosticPath(value: string): { value: string; truncated: boolean; sha256: string } {
  return { value: value.length <= 240 ? value : `${value.slice(0, 117)}...${value.slice(-120)}`, truncated: value.length > 240,
    sha256: createHash("sha256").update(value).digest("hex") };
}
interface InventoryChange { path: string; fields: WindowsStorageChangeField[]; before?: Identity; after?: Identity }
/** Both projections use the same captured change; diagnostics never re-read filesystem facts. */
function firstInventoryChange(before: ReadonlyMap<string, Identity>, after: ReadonlyMap<string, Identity>,
  verifiedSealedRecords: ReadonlySet<string> = new Set()): InventoryChange | undefined {
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const previous = before.get(key), current = after.get(key), fields: WindowsStorageChangeField[] = [];
    if (!previous) fields.push("added");
    else if (!current) fields.push("removed");
    else {
      if (!identityEqual(previous, current)) fields.push("identity");
      if (previous.ctimeNs !== current.ctimeNs && !verifiedSealedRecords.has(key)) fields.push("ctime");
      if (previous.mtimeNs !== current.mtimeNs) fields.push("mtime");
      if (previous.size !== current.size) fields.push("size");
    }
    if (fields.length > 0) return { path: (current ?? previous!).path, fields, before: previous, after: current };
  }
  return undefined;
}
/** Decimal strings retain native bigint precision. The explicit truncation list bounds even
 * out-of-range observations without changing the audit's original comparison or rejection. */
function diagnosticMetadata(identity: Identity | undefined) {
  if (!identity) return null;
  const truncated: string[] = [];
  const decimal = (field: "dev" | "ino" | "ctimeNs" | "mtimeNs" | "size"): string => {
    const value = identity[field].toString();
    if (value.length <= 40) return value;
    truncated.push(field);
    return `${value.slice(0, 18)}...${value.slice(-18)}`;
  };
  const metadata = { dev: decimal("dev"), ino: decimal("ino"), directory: identity.directory,
    ctimeNs: decimal("ctimeNs"), mtimeNs: decimal("mtimeNs"), size: decimal("size") };
  return { ...metadata, ...(truncated.length ? { truncated_fields: truncated } : {}) };
}
/** Preserve the existing root/path bindings and bounded CLI message. Startup diagnostics
 * still receive only fixed change labels, never paths or exception text. */
function inventoryChangeDiagnostic(root: string, change: InventoryChange | undefined): string {
  // Preserve the original rejection even if future inventory fields are added.
  if (!change) return "";
  return " " + JSON.stringify({ root: diagnosticPath(root), first_change: {
    relative: diagnosticPath(win32.relative(root, change.path) || "."), fields: change.fields,
    before: diagnosticMetadata(change.before), after: diagnosticMetadata(change.after),
  } }).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function state(authority: PreparedWindowsReleaseStorage): StorageState {
  const saved = authorities.get(authority);
  if (!saved) fail("a locally prepared storage authority is required", "storage_binding_rejected");
  return saved;
}

/** A new canonical dispatch is sealed by its actual wx/fsync/close writer. There
 * is deliberately no register-existing-path, supplied-digest or rebaseline API.
 * These in-memory bindings cannot repair or reclassify a failed prior attempt. */
export function writeWindowsReleaseDispatch(authority: PreparedWindowsReleaseStorage, expectedDirectory: string,
  operationId: string, payloadDigest: string, action: "start" | "stop"): void {
  assertWindowsReleaseStorage(authority, expectedDirectory);
  if (typeof operationId !== "string" || !operationId || operationId.length > 128 || typeof payloadDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(payloadDigest)
    || !["start", "stop"].includes(action)) fail("invalid dispatch writer binding", "storage_binding_rejected");
  const saved = state(authority), name = createHash("sha256").update(operationId).digest("hex");
  const path = win32.join(saved.directory, "attestations", `dispatch-${name}.json`), key = windowsPathKey(path);
  if (saved.sealed.has(key)) fail("dispatch is already sealed", "storage_binding_rejected");
  // This fixed v1 shape is emitted in canonical key order. Keep the storage /
  // bootstrap authority graph independent of the domain barrel; equivalence is
  // checked against the domain canonicalizer in the controlled writer suite.
  const bytes = Buffer.from(JSON.stringify({ action, operation_id: operationId, payload_digest: payloadDigest, version: 1 }));
  if (bytes.length > 65536) fail("dispatch exceeds its fixed bound", "storage_binding_rejected");
  const fd = openSync(path, "wx", 0o600);
  let written: { dev: bigint; ino: bigint; size: bigint };
  try {
    writeFileSync(fd, bytes); fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.length)) fail("exclusive dispatch identity changed");
    const named = fact(path);
    if (named.directory || named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size)
      fail("exclusive dispatch path changed");
    written = { dev: stat.dev, ino: stat.ino, size: stat.size };
  } finally { closeSync(fd); }
  // Windows may finalize LastWriteTime only when the last writing handle closes.
  // Bind that final value after original close, still requiring the writer's
  // exact file ID and length; a replacement cannot become the seal's baseline.
  const completed = fact(path);
  if (completed.directory || completed.dev !== written.dev || completed.ino !== written.ino || completed.size !== written.size)
    fail("exclusive dispatch identity changed on close");
  const binding: WindowsSealedRecordBindingV1 = Object.freeze({ version: 1, dev: written.dev.toString(), ino: written.ino.toString(), size: written.size.toString(),
    mtimeNs: completed.mtimeNs.toString(), sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  saved.sealed.set(key, binding);
}
function matchesSealedIdentity(item: Identity, sealed: WindowsSealedRecordBindingV1): boolean {
  return !item.directory && item.dev.toString() === sealed.dev && item.ino.toString() === sealed.ino
    && item.size.toString() === sealed.size && item.mtimeNs.toString() === sealed.mtimeNs;
}
/** Failure diagnostics project the already captured fixed-collector facts. No
 * filesystem re-read, baseline replacement or permission is introduced here. */
function sealedObservationDiagnostic(value: WindowsSealedRecordAuditV1 | undefined, binding: WindowsSealedRecordBindingV1): string {
  if (!isWindowsSealedRecordAudit(value, binding)) return ' {"sealed_observation_v1":{"validated":false}}';
  const project = (snapshot: WindowsSealedRecordAuditV1["before"]) => ({ ctime_ns: snapshot.ctimeNs,
    ea_count: snapshot.eas.length, ea_inventory_sha256: createHash("sha256").update(JSON.stringify(snapshot.eas)).digest("hex"),
    eas: snapshot.eas.slice(0, 4).map(ea => ({ name: ea.name.slice(0, 96), name_truncated: ea.name.length > 96,
      bytes: ea.bytes, flags: ea.flags, sha256: ea.sha256, contains_expected_sha256: ea.containsExpectedSha256 })) });
  return " " + JSON.stringify({ sealed_observation_v1: { validated: true, content_matches_writer: true,
    security_unchanged: value.before.securitySha256 === value.after.securitySha256,
    streams_unchanged: isDeepStrictEqual(value.before.streams, value.after.streams), before: project(value.before), after: project(value.after) } });
}
function inventory(saved: StorageState): Map<string, Identity> {
  const result = new Map<string, Identity>();
  const visit = (path: string, depth: number): void => {
    if (depth > 64 || result.size >= MAX_WINDOWS_AUDIT_PATHS) fail("storage inventory exceeds the Windows bound");
    const item = fact(path), key = windowsPathKey(path);
    if (result.has(key)) fail("case-aliased storage inventory");
    result.set(key, item);
    if (item.directory) for (const name of readdirSync(path).sort()) visit(win32.join(path, name), depth + 1);
  };
  try { visit(saved.directory, 0); return result; }
  catch (error) { throw markWindowsStorageFailure(error, "filesystem_observation_failed"); }
}
function assertFixed(saved: StorageState): void {
  assertNativeWindows();
  for (const expected of saved.fixed.values()) if (!identityEqual(expected, fact(expected.path))) fail(`fixed physical identity changed: ${expected.path}`);
  for (const expected of saved.layout.values()) if (!identityEqual(expected, fact(expected.path))) fail(`storage layout identity changed: ${expected.path}`);
  for (const root of saved.roots) if (windowsPathsOverlap(saved.directory, root)) fail("storage overlaps an agent writable root");
}

/** Cheap serving check. This does not claim to re-audit ACLs; the current node user is trusted. */
export function assertWindowsReleaseStorage(authority: PreparedWindowsReleaseStorage, expectedDirectory: string): void {
  const saved = state(authority);
  if (saved.directory !== expectedDirectory) fail("storage authority is bound to another directory", "storage_binding_rejected");
  assertFixed(saved);
}

/** Guardian admission requires the exact workspace in the original complete local write
 * scope. A different directory cannot be smuggled in beside an unrelated storage permit. */
export function assertWindowsReleaseStorageWorkspace(authority: PreparedWindowsReleaseStorage, expectedDirectory: string, workspaceRoot: string): void {
  assertWindowsReleaseStorage(authority, expectedDirectory);
  const saved = state(authority);
  if (!saved.roots.includes(workspaceRoot)) fail("guardian workspace is absent from the complete fixed write scope", "storage_binding_rejected");
}

/** Execute at preparation and serialized startup/publication/monitor write boundaries, never per HTTP file. */
export function auditWindowsReleaseStorage(authority: PreparedWindowsReleaseStorage, expectedDirectory: string): void {
  auditWindowsReleaseStorageBatch([{ storage: authority, directory: expectedDirectory }]);
}

/** Only this synchronous invocation shares collector facts. Every storage retains its
 * own complete boundary, policy and before/after inventory; no audit survives return. */
export function auditWindowsReleaseStorageBatch(entries: readonly {
  storage: PreparedWindowsReleaseStorage; directory: string;
}[]): void {
  if (!Array.isArray(entries)) fail("an explicit local storage batch is required", "storage_binding_rejected");
  const prepared = entries.map(entry => {
    if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => key !== "storage" && key !== "directory"))
      fail("an exact local storage binding is required", "storage_binding_rejected");
    const { storage, directory } = entry, saved = state(storage);
    assertWindowsReleaseStorage(storage, directory);
    const before = inventory(saved), targets = new Map<string, WindowsAclTarget>();
    const ancestors = new Set(windowsPathComponents(saved.directory).slice(0, -1).map(windowsPathKey));
    for (const expected of saved.fixed.values()) targets.set(windowsPathKey(expected.path), {
      path: expected.path, directory: true, readAcl: ancestors.has(windowsPathKey(expected.path)),
    });
    for (const [key, sealed] of saved.sealed) {
      const item = before.get(key);
      if (!item || !matchesSealedIdentity(item, sealed)) fail("sealed dispatch identity changed");
    }
    for (const item of before.values()) {
      const sealed = saved.sealed.get(windowsPathKey(item.path));
      targets.set(windowsPathKey(item.path), { path: item.path, directory: item.directory, readAcl: true, ...(sealed ? { sealed } : {}) });
    }
    // Keep the original per-storage limit even when the complete batch needs several collectors.
    if (targets.size > MAX_WINDOWS_AUDIT_PATHS) fail("storage and boundary inventory exceeds the Windows bound");
    return { saved, before, targets, ancestors };
  });
  const combined = new Map<string, WindowsAclTarget>();
  for (const { targets } of prepared) for (const [key, target] of targets) {
    const previous = combined.get(key);
    if (previous && (previous.path !== target.path || previous.directory !== target.directory))
      fail(`shared storage audit target changed: ${target.path}`);
    if (previous?.sealed && target.sealed && !isDeepStrictEqual(previous.sealed, target.sealed)) fail("shared sealed dispatch binding changed");
    const sealed = target.sealed ?? previous?.sealed;
    combined.set(key, { ...target, readAcl: target.readAcl || previous?.readAcl === true,
      ...(sealed ? { sealed } : {}) });
  }
  const facts = new Map<string, WindowsAclFact>();
  let sid: string | undefined;
  // The collector accepts 4096-character paths, 184-character SIDs and 256 ACEs.
  // At 256 targets, even six-byte JSON escaping of every path character plus a
  // conservative 320 bytes per ACE stays below 32 MiB (its response bound is 64 MiB).
  // This also bounds merged responses that individually legal storages could exceed.
  // Splitting happens before collection, never as a retry after a failed observation.
  const maximumTargets = Math.min(256, MAX_WINDOWS_AUDIT_PATHS);
  const maximumRequestBytes = 16 * 1024 * 1024, envelopeBytes = Buffer.byteLength('{"version":1,"paths":[]}');
  let targets: WindowsAclTarget[] = [], requestBytes = envelopeBytes;
  const collect = () => {
    if (!targets.length) return;
    const report = collectWindowsAclFacts(targets);
    if (sid !== undefined && sid !== report.currentSid) fail("node Windows identity changed", "storage_acl_rejected");
    sid = report.currentSid;
    for (const node of report.nodes) facts.set(windowsPathKey(node.path), node);
    targets = []; requestBytes = envelopeBytes;
  };
  for (const target of combined.values()) {
    const bytes = Buffer.byteLength(JSON.stringify(target));
    if (targets.length && (targets.length === maximumTargets || requestBytes + 1 + bytes > maximumRequestBytes)) collect();
    targets.push(target); requestBytes += bytes + (targets.length > 1 ? 1 : 0);
  }
  collect();
  const trusted = new Set([...TRUSTED_WINDOWS_SYSTEM_SIDS, ...(sid === undefined ? [] : [sid])]);
  for (const { saved, targets, ancestors } of prepared) {
    if (saved.sid !== undefined && saved.sid !== sid) fail("node Windows identity changed", "storage_acl_rejected");
    for (const [key, target] of targets) {
      const node = facts.get(key);
      if (!node) fail("storage audit facts are incomplete", "acl_facts_rejected");
      if (!target.readAcl) continue;
      if (!node.ownerSid || !trusted.has(node.ownerSid)) fail(`untrusted owner: ${node.path}`, "storage_acl_rejected");
      // The same path may be an ancestor for one storage and mutable content for another.
      const ancestor = ancestors.has(key);
      for (const ace of node.aces) {
        if (ace.qualifier !== "AccessAllowed" || trusted.has(ace.sid)) continue;
        // InheritOnly is bit 3. OI/CI bits 0/1 can authorize future children in mutable storage.
        const effective = (ace.flags & 8) === 0, inheritedByFutureChild = node.directory && (ace.flags & 3) !== 0;
        if (effective && (ace.mask & (ancestor ? WINDOWS_ANCESTOR_REPLACEMENT_MASK : WINDOWS_MUTATION_MASK)) !== 0
          || !ancestor && inheritedByFutureChild && (ace.mask & WINDOWS_MUTATION_MASK) !== 0) {
          fail(`another principal can modify storage or its future children: ${node.path}`, "storage_acl_rejected");
        }
      }
    }
  }
  const completed = prepared.map(({ saved, before }) => {
    assertFixed(saved);
    const after = inventory(saved);
    const verifiedSealedRecords = new Set<string>();
    const rejectSealed: (binding: WindowsSealedRecordBindingV1, observation: WindowsSealedRecordAuditV1 | undefined) => never = (binding, observation) => {
      const change = firstInventoryChange(before, after);
      const observed = sealedObservationDiagnostic(observation, binding);
      if (change) fail("sealed dispatch changed during ACL audit" + observed + inventoryChangeDiagnostic(saved.directory, change), "storage_inventory_changed", change.fields);
      fail("sealed dispatch observation is incomplete or changed" + observed);
    };
    for (const [key, binding] of saved.sealed) {
      const previous = before.get(key), current = after.get(key), observation = facts.get(key)?.sealed;
      if (!previous || !current || !matchesSealedIdentity(previous, binding) || !matchesSealedIdentity(current, binding)
        || !isWindowsSealedRecordAudit(observation, binding)) rejectSealed(binding, observation);
      // The writer's expected bytes and identity are independent of this audit.
      // OS cache metadata may change before/during the collector; it cannot grant
      // authority, replace that binding or relax any unregistered inventory item.
      if (!isWindowsSealedRecordIntegrity(observation, binding))
        rejectSealed(binding, observation);
      verifiedSealedRecords.add(key);
    }
    const change = firstInventoryChange(before, after, verifiedSealedRecords);
    if (change) fail("storage changed during ACL audit" + inventoryChangeDiagnostic(saved.directory, change), "storage_inventory_changed", change.fields);
    const layout = new Map(saved.layout);
    for (const name of LAYOUT) {
      const path = win32.join(saved.directory, name), entry = after.get(windowsPathKey(path));
      if (entry) {
        if (!entry.directory) fail(`invalid release layout directory: ${path}`);
        layout.set(windowsPathKey(path), entry);
      }
    }
    return { saved, layout };
  });
  // A later rejection must not partially admit an earlier storage's SID or new layout.
  for (const { saved, layout } of completed) {
    saved.layout = layout;
    saved.sid = sid;
  }
}

/** Trusted-team local admission. No caller-supplied SID, policy or callback can authorize storage. */
export function prepareWindowsReleaseStorage(input: WindowsReleaseStorageInput): PreparedWindowsReleaseStorage {
  assertNativeWindows();
  if (!input || typeof input !== "object" || Object.keys(input).some(name => !["directory", "writableWorkspaceRoots"].includes(name))
    || !Array.isArray(input.writableWorkspaceRoots) || input.writableWorkspaceRoots.length === 0 || input.writableWorkspaceRoots.length > 128) {
    fail("an explicit local directory and all agent write roots are required");
  }
  const directory = physicalWindowsDirectory(input.directory);
  const roots = Object.freeze([...new Set(input.writableWorkspaceRoots.map(physicalWindowsDirectory))]);
  for (const root of roots) if (windowsPathsOverlap(directory, root)) fail("storage overlaps an agent writable root");
  const fixed = new Map<string, Identity>();
  for (const path of [directory, ...roots].flatMap(windowsPathComponents)) fixed.set(windowsPathKey(path), fact(path));
  const prepared = Object.freeze({}) as PreparedWindowsReleaseStorage;
  authorities.set(prepared, { directory, roots, fixed, layout: new Map(), sealed: new Map() });
  try { auditWindowsReleaseStorage(prepared, directory); }
  catch (error) { authorities.delete(prepared); throw error; }
  return prepared;
}
