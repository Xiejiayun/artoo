import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { assertCanonicalWindowsPath, assertNativeWindows, physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";
import { prepareWindowsCodeInstallation, assertWindowsCodeInstallation, auditWindowsCodeInstallation, type PreparedWindowsCodeInstallation } from "./windows-code-installation.js";
import { prepareWindowsReleaseStorage, assertWindowsReleaseStorage, auditWindowsReleaseStorage, type PreparedWindowsReleaseStorage } from "./windows-release-storage.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { assertApplicationClientReader, revokeApplicationClientReader, type ApplicationClientReader } from "./application-artifact-admission.js";
import { ApplicationRuntimeFilePinSchema, APPLICATION_RUNTIME_PROCESS_LIMITS as limits, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";

declare const installedBrand: unique symbol;
export interface PreparedApplicationInstallation { readonly [installedBrand]: true }
export interface ApplicationInstallationBinding {
  readonly generationId: string; readonly nodeId: string; readonly allowedRoots: readonly string[];
  readonly profile: ApplicationRuntimeFilePin; readonly directory: string; readonly storageDirectory: string;
  readonly node: ApplicationRuntimeFilePin; readonly nodeDirectory: string;
  readonly code: PreparedWindowsCodeInstallation; readonly nodeCode: PreparedWindowsCodeInstallation;
  readonly storage: PreparedWindowsReleaseStorage; readonly backend: PreparedWindowsProcessBackend;
}
export interface ApplicationInstallationOptions {
  readonly parent: string; readonly nodeId: string; readonly allowedRoots: readonly string[];
  /** Independently selected local Node pin and original protected backend. */
  readonly node: ApplicationRuntimeFilePin; readonly backend: PreparedWindowsProcessBackend;
  readonly signal?: AbortSignal;
}
export interface ApplicationInstallationPlan {
  readonly version: 1;
  readonly directories: readonly string[];
  readonly files: readonly ({ readonly path: string; readonly bytes: number; readonly sha256: string } &
    ({ readonly source: ApplicationRuntimeFilePin } | { readonly content: Uint8Array }))[];
  /** Absolute destination plus independently computed exact serialized profile hash. */
  readonly profile: ApplicationRuntimeFilePin;
}
export interface ApplicationInstallationOwner {
  readonly generationId: string; readonly directory: string; readonly storageDirectory: string;
  install(plan: ApplicationInstallationPlan): PreparedApplicationInstallation;
  describeAttempt(): Readonly<{ phase: Phase; failureRecordError: string | null }>;
}
type Phase = "claimed" | "writing" | "writers-closed" | "content-verified" | "admitted" | "failed";
type Member = { path: string; bytes: Buffer; pin: { path: string; bytes: number; sha256: string } };
interface Saved {
  phase: Phase; failureRecordError: string | null; control: string; generationId: string;
  binding?: ApplicationInstallationBinding; directories: readonly string[]; files: readonly Member[];
  readers: Set<ApplicationClientReader>; written: Map<string, ReturnType<typeof fact>>;
  prepared?: ReadonlyMap<string, { baseline: ReturnType<typeof fact>; preparation: ReadDiagnostic }>;
  layout: Map<string, ReturnType<typeof fact>>;
}
const installations = new WeakMap<object, Saved>();
const claimed = new Set<string>();
const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fail(reason: string): never { throw Error(`Application installation: ${reason}`); }
const portable = (value: string): boolean => value.length <= 512 && value.split("/").every(part =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(part) && !/[. ]$/u.test(part)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
const relative = z.string().min(1).max(512).refine(portable);
const member = { path: relative, bytes: z.number().int().min(1).max(limits.fileBytes), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u) };
const planSchema = z.object({ version: z.literal(1), directories: z.array(relative).max(limits.files),
  files: z.array(z.union([z.object({ ...member, source: ApplicationRuntimeFilePinSchema }).strict(),
    z.object({ ...member, content: z.instanceof(Uint8Array) }).strict()])).min(1).max(limits.files),
  profile: ApplicationRuntimeFilePinSchema }).strict();
function fact(file: string, directory = false) {
  assertCanonicalWindowsPath(file); const stat = lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || realpathSync.native(file) !== file || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail("physical single-link path required");
  return stat;
}
function equal(left: ReturnType<typeof fact>, right: ReturnType<typeof fact>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
const metadataFields = ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
function metadata(stat: ReturnType<typeof fact>) {
  return { dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
    file: stat.isFile(), symbolic_link: stat.isSymbolicLink() };
}
interface ReadDiagnostic {
  path: string; operation: string;
  writer?: ReturnType<typeof metadata>; before?: ReturnType<typeof metadata>;
  baseline?: ReturnType<typeof metadata>;
  handle?: ReturnType<typeof metadata>; current_path?: ReturnType<typeof metadata>;
  expected_sha256?: string; actual_sha256?: string; expected_bytes?: number; actual_bytes?: number;
}
const readFailures = new WeakMap<object, ReadDiagnostic>();
function retainReadFailure(error: unknown, diagnostic: ReadDiagnostic): void {
  if (typeof error === "object" && error !== null) readFailures.set(error, { ...diagnostic, path: diagnostic.path.slice(0, 4096) });
}
function diagnosticFields(diagnostic: ReadDiagnostic): string[] {
  const preparation = diagnostic.operation.startsWith("prepare");
  const expected = preparation ? diagnostic.baseline ?? diagnostic.writer : diagnostic.before;
  const fields = preparation && !diagnostic.baseline ? metadataFields.filter(name => name !== "ctimeNs") : metadataFields;
  const changed = new Set<string>();
  for (const observed of [preparation && !diagnostic.baseline ? diagnostic.before : undefined, diagnostic.handle, diagnostic.current_path]) if (expected && observed) {
    for (const name of [...fields, "file", "symbolic_link"] as const)
      if (expected[name] !== observed[name]) changed.add(name);
  }
  if (diagnostic.actual_sha256 && diagnostic.actual_sha256 !== diagnostic.expected_sha256) changed.add("sha256");
  if (diagnostic.before && diagnostic.expected_bytes !== undefined && diagnostic.before.size !== String(diagnostic.expected_bytes)) changed.add("size");
  if (diagnostic.actual_bytes !== undefined && diagnostic.actual_bytes !== diagnostic.expected_bytes) changed.add("bytes");
  return [...changed];
}
function originalClose<T>(fd: number, operation: () => T): T {
  let value!: T, failed = false, original: unknown;
  try { value = operation(); } catch (error) { failed = true; original = error; }
  try { closeSync(fd); }
  catch (error) { if (failed) throw new AggregateError([original, error], "Operation and original handle close failed", { cause: original }); throw error; }
  if (failed) throw original; return value;
}
/** Fixed original-handle read, including the final close and path recheck. */
function read(pin: ApplicationRuntimeFilePin): Buffer {
  const diagnostic: ReadDiagnostic = { path: pin.path, operation: "read-before-open", expected_sha256: pin.sha256, expected_bytes: pin.bytes };
  try {
    physicalWindowsDirectory(win32.dirname(pin.path)); const before = fact(pin.path);
    diagnostic.before = metadata(before);
    if (before.size !== BigInt(pin.bytes)) fail("source or installed size mismatch");
    const bytes = Buffer.alloc(pin.bytes + 1), fd = openSync(pin.path, "r"); let length = 0;
    const check = () => { const opened = fstatSync(fd, { bigint: true });
      diagnostic.handle = metadata(opened);
      if (!opened.isFile() || opened.nlink !== 1n || !equal(before, opened)) fail("read identity or metadata changed");
      const current = fact(pin.path); diagnostic.current_path = metadata(current);
      if (!equal(before, current)) fail("read identity or metadata changed"); };
    originalClose(fd, () => {
      diagnostic.operation = "read-first-handle";
      check();
      diagnostic.operation = "read-bytes";
      while (length < bytes.length) { const count = readSync(fd, bytes, length, Math.min(65_536, bytes.length - length), length);
        if (!count) break; length += count; check(); }
      check();
      diagnostic.operation = "read-original-close";
    });
    diagnostic.operation = "read-after-close";
    const after = fact(pin.path); diagnostic.current_path = metadata(after); diagnostic.actual_bytes = length;
    diagnostic.actual_sha256 = sha(bytes.subarray(0, length));
    if (!equal(before, after) || length !== pin.bytes || diagnostic.actual_sha256 !== pin.sha256) fail("read changed through original close");
    return bytes.subarray(0, length);
  } catch (error) { retainReadFailure(error, diagnostic); throw error; }
}
/** Only this owner's original new members reach preparation. Writer facts are
 * retained separately; the first read handle begins the immutable interval. */
function prepareMembers(saved: Saved, directory: string): void {
  if (saved.phase !== "writers-closed" || saved.prepared) fail("original preparation phase required");
  const prepared = new Map<string, { baseline: ReturnType<typeof fact>; preparation: ReadDiagnostic }>();
  for (const member of saved.files) {
    const path = win32.join(directory, ...member.path.split("/")), writer = saved.written.get(member.path);
    const diagnostic: ReadDiagnostic = { path, operation: "prepare-before-open", expected_sha256: member.pin.sha256, expected_bytes: member.pin.bytes };
    try {
      if (!writer || prepared.has(member.path)) fail("original writer required for one preparation read");
      diagnostic.writer = metadata(writer);
      physicalWindowsDirectory(win32.dirname(path)); const before = fact(path); diagnostic.before = metadata(before);
      const samePreparedIdentity = (value: ReturnType<typeof fact>) => value.isFile() && value.nlink === 1n
        && value.dev === writer.dev && value.ino === writer.ino && value.size === writer.size && value.mtimeNs === writer.mtimeNs;
      if (!samePreparedIdentity(before) || before.size !== BigInt(member.pin.bytes)) fail("preparation writer identity changed");
      const bytes = Buffer.alloc(member.pin.bytes + 1), fd = openSync(path, "r"); let length = 0;
      let baseline!: ReturnType<typeof fact>;
      originalClose(fd, () => {
        diagnostic.operation = "prepare-first-handle"; baseline = fstatSync(fd, { bigint: true }); diagnostic.handle = metadata(baseline);
        if (!samePreparedIdentity(baseline)) fail("preparation writer identity changed");
        diagnostic.baseline = metadata(baseline);
        const check = () => {
          const opened = fstatSync(fd, { bigint: true }), current = fact(path);
          diagnostic.handle = metadata(opened); diagnostic.current_path = metadata(current);
          if (!opened.isFile() || opened.nlink !== 1n || !equal(baseline, opened) || !equal(baseline, current)) {
            fail("prepared read identity or metadata changed");
          }
        };
        check(); diagnostic.operation = "prepare-read";
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, Math.min(65_536, bytes.length - length), length);
          check(); if (!count) break; length += count;
        }
        check(); diagnostic.operation = "prepare-original-close";
      });
      diagnostic.operation = "prepare-after-close";
      const after = fact(path); diagnostic.current_path = metadata(after);
      diagnostic.actual_bytes = length; diagnostic.actual_sha256 = sha(bytes.subarray(0, length));
      if (!equal(baseline, after) || length !== member.pin.bytes || diagnostic.actual_sha256 !== member.pin.sha256) fail("prepared read changed through original close");
      prepared.set(member.path, { baseline, preparation: diagnostic });
    } catch (error) { retainReadFailure(error, diagnostic); throw error; }
  }
  // One publication after every original read/hash/close. No failed prefix is a
  // baseline and the terminal owner cannot retry preparation or installation.
  saved.prepared = prepared;
}
// Copy actual storage; caller-overridden properties cannot hide shared/resizable buffers.
const array = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (name: string) => Object.getOwnPropertyDescriptor(array, name)!.get!;
const arrayLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
function copy(value: Uint8Array, expected: number): Buffer {
  const buffer: unknown = Reflect.apply(getter("buffer"), value, []); Reflect.apply(arrayLength, buffer, []);
  if (resizable && Reflect.apply(resizable, buffer, [])) fail("resizable content rejected");
  const length: number = Reflect.apply(getter("byteLength"), value, []);
  if (length !== expected) fail("content length mismatch");
  return Buffer.from(new Uint8Array(buffer as ArrayBuffer, Reflect.apply(getter("byteOffset"), value, []), length));
}
/** This is the only writer. Completion includes every original flush and close. */
function write(file: string, bytes: Uint8Array): ReturnType<typeof fact> {
  const fd = openSync(file, "wx");
  const written = originalClose(fd, () => {
    let offset = 0;
    while (offset < bytes.byteLength) { const requested = Math.min(65_536, bytes.byteLength - offset), count = writeSync(fd, bytes, offset, requested, offset);
      if (!Number.isInteger(count) || count < 1 || count > requested) fail("writer made no valid progress"); offset += count; }
    fsyncSync(fd); const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.byteLength)) fail("writer file mismatch");
    return stat;
  });
  const closed = fact(file); if (!equal(written, closed)) fail("writer identity or metadata changed through original close"); return closed;
}
function assertLayout(saved: Saved): void {
  // These directories are mutable during creation; bind their original physical
  // identities without treating authorized child creation as immutable admission.
  for (const [path, original] of saved.layout) { const current = fact(path, true);
    if (current.dev !== original.dev || current.ino !== original.ino) fail("original generation directory replaced"); }
}
function record(saved: Saved, name: string, data: unknown): void {
  // An exclusive mkdir failure must never write a failure marker into somebody
  // else's existing generation, including a previous process's retained claim.
  if (!saved.layout.has(saved.control)) fail("original control directory unavailable");
  assertLayout(saved); write(win32.join(saved.control, name), Buffer.from(JSON.stringify(data) + "\n"));
}
function invalidate(saved: Saved, error?: unknown): void {
  if (saved.phase === "failed") return;
  const phase = saved.phase, diagnostic = typeof error === "object" && error !== null ? readFailures.get(error) : undefined;
  saved.phase = "failed";
  for (const reader of saved.readers) { try { revokeApplicationClientReader(reader); } catch { saved.failureRecordError = "client reader revocation failed"; } }
  saved.readers.clear();
  try { record(saved, "FAILED.json", { version: 1, generation_id: saved.generationId, failed: true, qualified_for_product: false,
    phase_before_failure: phase, ...(diagnostic ? { diagnostic: { ...diagnostic, changed_fields: diagnosticFields(diagnostic) } } : {}) }); }
  catch (error) { saved.failureRecordError = String(error); }
}
function state(token: PreparedApplicationInstallation): Saved {
  const saved = installations.get(token); if (!saved || saved.phase !== "admitted" || !saved.binding) fail("original admitted installation required"); return saved;
}
function verify(saved: Saved, directory: string): void {
  const actualDirectories: string[] = [], actualFiles: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 64 || actualDirectories.length + actualFiles.length > limits.files * 2) fail("inventory exceeds bound");
    fact(current, true);
    for (const name of readdirSync(current).sort()) {
      const file = win32.join(current, name), rel = win32.relative(directory, file).split(win32.sep).join("/");
      if (!portable(rel)) fail("unexpected inventory path");
      const observed = lstatSync(file);
      if (observed.isDirectory() && !observed.isSymbolicLink()) { actualDirectories.push(rel); walk(file, depth + 1); }
      else { fact(file); actualFiles.push(rel); }
    }
  };
  walk(directory, 0);
  const wantedFiles = saved.files.map(file => file.path).sort();
  if (JSON.stringify(actualDirectories.sort()) !== JSON.stringify(saved.directories)
    || JSON.stringify(actualFiles.sort()) !== JSON.stringify(wantedFiles)) fail("complete installation set differs from plan");
  for (const file of saved.files) {
    const path = win32.join(directory, ...file.path.split("/")), baseline = saved.prepared?.get(file.path)?.baseline;
    const check = () => {
      const current = fact(path);
      if (!baseline || !equal(baseline, current)) {
        const error = Error("Application installation: original installed file replaced or changed");
        retainReadFailure(error, { path, operation: "verify-path", ...(baseline ? { before: metadata(baseline) } : {}), current_path: metadata(current) });
        throw error;
      }
    };
    check();
    read({ ...file.pin, path });
    check();
  }
}
function guard(saved: Saved, audit: boolean): void {
  try {
    if (saved.phase !== "admitted" || !saved.binding) fail("installation has failed"); const binding = saved.binding;
    assertLayout(saved);
    assertWindowsCodeInstallation(binding.code, binding.directory); assertWindowsCodeInstallation(binding.nodeCode, binding.nodeDirectory);
    assertWindowsReleaseStorage(binding.storage, binding.storageDirectory); assertWindowsProcessBackend(binding.backend);
    if (audit) {
      auditWindowsCodeInstallation(binding.code, binding.directory); auditWindowsCodeInstallation(binding.nodeCode, binding.nodeDirectory);
      auditWindowsReleaseStorage(binding.storage, binding.storageDirectory); verify(saved, binding.directory); read(binding.node);
      assertWindowsCodeInstallation(binding.code, binding.directory); assertWindowsCodeInstallation(binding.nodeCode, binding.nodeDirectory);
    }
  } catch (error) { invalidate(saved, error); throw error; }
}
export function describeApplicationInstallation(token: PreparedApplicationInstallation): ApplicationInstallationBinding {
  const saved = state(token); guard(saved, false); return saved.binding!;
}
export function assertApplicationInstallation(token: PreparedApplicationInstallation): void { guard(state(token), false); }
export function auditApplicationInstallation(token: PreparedApplicationInstallation): void { guard(state(token), true); }
export function invalidateApplicationInstallation(token: PreparedApplicationInstallation): void { const saved = installations.get(token); if (saved) invalidate(saved); }
export function bindApplicationInstallationClientReader(token: PreparedApplicationInstallation, reader: ApplicationClientReader): void {
  const saved = state(token); guard(saved, false);
  try { assertApplicationClientReader(reader); saved.readers.add(reader); }
  catch (error) { invalidate(saved, error); throw error; }
}

/** Local, single-generation installation only. No process, CLI recovery or retry. */
export function createApplicationInstallationOwner(input: ApplicationInstallationOptions): ApplicationInstallationOwner {
  assertNativeWindows();
  if (!input || Object.keys(input).some(key => !["parent", "nodeId", "allowedRoots", "node", "backend", "signal"].includes(key))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.nodeId) || !Array.isArray(input.allowedRoots)
    || input.allowedRoots.length < 1 || input.allowedRoots.length > 128) fail("fixed local settings required");
  const parent = physicalWindowsDirectory(input.parent), allowedRoots = Object.freeze(input.allowedRoots.map(physicalWindowsDirectory).sort());
  if (new Set(allowedRoots.map(value => value.toLowerCase())).size !== allowedRoots.length
    || allowedRoots.some(root => windowsPathsOverlap(parent, root))) fail("complete disjoint write roots required");
  const node = Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.node)), nodeDirectory = physicalWindowsDirectory(win32.dirname(node.path));
  const backend = input.backend, native = describeWindowsProcessInstallation(backend);
  if (JSON.stringify([...native.writableWorkspaceRoots].sort()) !== JSON.stringify(allowedRoots)
    || windowsPathsOverlap(parent, nodeDirectory) || windowsPathsOverlap(parent, native.directory)) fail("external prerequisites differ or overlap");
  assertWindowsProcessBackend(backend); read(node);
  const parentStorage = prepareWindowsReleaseStorage({ directory: parent, writableWorkspaceRoots: allowedRoots });
  const nodeId = input.nodeId, signal = input.signal;
  const generationId = randomUUID(), root = win32.join(parent, generationId), directory = win32.join(root, "code"), storageDirectory = win32.join(root, "store");
  if (claimed.has(root.toLowerCase())) fail("generation already claimed"); claimed.add(root.toLowerCase());
  const saved: Saved = { phase: "claimed", failureRecordError: null, generationId, control: win32.join(root, "control"), directories: [], files: [], readers: new Set(), written: new Map(), layout: new Map() };
  const cancelled = () => { if (signal?.aborted) fail("installation cancelled"); assertWindowsReleaseStorage(parentStorage, parent); assertLayout(saved); };
  const createDirectory = (path: string) => { cancelled(); mkdirSync(path); saved.layout.set(path, fact(path, true)); };
  try {
    createDirectory(root); createDirectory(saved.control);
    record(saved, "CLAIM.json", { version: 1, generation_id: generationId, qualified_for_product: false });
    createDirectory(directory); createDirectory(storageDirectory); cancelled();
  } catch (error) { invalidate(saved, error); throw error; }
  let attempted = false;
  return Object.freeze({ generationId, directory, storageDirectory,
    describeAttempt: () => Object.freeze({ phase: saved.phase, failureRecordError: saved.failureRecordError }),
    install(raw: ApplicationInstallationPlan): PreparedApplicationInstallation {
      if (attempted) fail("installation attempt already used"); attempted = true;
      try {
        cancelled(); const plan = planSchema.parse(raw), seen = new Set<string>(), directories = [...plan.directories].sort();
        const allPaths = [...directories, ...plan.files.map(file => file.path)];
        for (const path of allPaths) { const key = path.toLowerCase(); if (seen.has(key)) fail("duplicate or case-aliased plan path"); seen.add(key); }
        const ancestors = new Set<string>();
        for (const file of plan.files) { const parts = file.path.split("/"); parts.pop(); while (parts.length) { ancestors.add(parts.join("/")); parts.pop(); } }
        if (JSON.stringify([...ancestors].sort()) !== JSON.stringify(directories)) fail("plan directories must exactly cover file parents");
        let total = 0;
        const files = plan.files.map(file => {
          total += file.bytes; if (total > limits.allFileBytes) fail("plan exceeds byte bound");
          if ("source" in file && (file.source.bytes !== file.bytes || file.source.sha256 !== file.sha256
            || windowsPathsOverlap(root, file.source.path))) fail("external source differs from expected output");
          const bytes = "source" in file ? read(file.source) : copy(file.content, file.bytes);
          if (sha(bytes) !== file.sha256) fail("planned content hash mismatch");
          return { path: file.path, bytes, pin: { path: file.path, bytes: file.bytes, sha256: file.sha256 } };
        }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        assertCanonicalWindowsPath(plan.profile.path);
        if (win32.dirname(plan.profile.path) !== directory || plan.profile.bytes > 65_536) fail("profile must be a bounded direct code child");
        const profileFile = files.find(file => win32.join(directory, ...file.path.split("/")) === plan.profile.path);
        if (!profileFile || profileFile.pin.bytes !== plan.profile.bytes || profileFile.pin.sha256 !== plan.profile.sha256) fail("independent profile pin differs from plan");
        const profile: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(profileFile.bytes));
        if (!profile || typeof profile !== "object" || !Object.hasOwn(profile, "installation")) fail("managed profile tag required");
        const tag = z.object({ version: z.literal(1), generation_id: z.literal(generationId) }).strict();
        tag.parse((profile as { installation: unknown }).installation);
        saved.directories = Object.freeze(directories); saved.files = files;
        const manifest = { version: 1, generation_id: generationId, node_id: nodeId, allowed_roots: allowedRoots,
          directories, files: files.map(file => file.pin), profile: plan.profile, external_node: node,
          external_backend: { directory: native.directory, manifestSha256: native.manifestSha256 } };
        const planDigest = sha(JSON.stringify(manifest)); record(saved, "PLAN.json", { ...manifest, plan_digest: planDigest });
        cancelled(); saved.phase = "writing";
        for (const relative of directories.slice().sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) createDirectory(win32.join(directory, ...relative.split("/")));
        for (const file of files) { cancelled(); saved.written.set(file.path, write(win32.join(directory, ...file.path.split("/")), file.bytes)); cancelled(); }
        saved.phase = "writers-closed"; prepareMembers(saved, directory); verify(saved, directory); cancelled(); saved.phase = "content-verified";
        // Exactly one new admission per immutable root. No retries or new baseline.
        const code = prepareWindowsCodeInstallation({ directory, writableWorkspaceRoots: allowedRoots });
        const nodeCode = prepareWindowsCodeInstallation({ directory: nodeDirectory, writableWorkspaceRoots: allowedRoots });
        const storage = prepareWindowsReleaseStorage({ directory: storageDirectory, writableWorkspaceRoots: allowedRoots });
        verify(saved, directory); read(node); cancelled();
        assertWindowsCodeInstallation(code, directory); assertWindowsCodeInstallation(nodeCode, nodeDirectory);
        assertWindowsReleaseStorage(storage, storageDirectory); assertWindowsProcessBackend(backend);
        record(saved, "ADMITTED.json", { version: 1, generation_id: generationId, plan_digest: planDigest, qualified_for_product: false });
        cancelled(); assertWindowsCodeInstallation(code, directory); assertWindowsCodeInstallation(nodeCode, nodeDirectory);
        assertWindowsReleaseStorage(storage, storageDirectory); assertWindowsProcessBackend(backend);
        saved.binding = Object.freeze({ generationId, nodeId, allowedRoots, profile: Object.freeze({ ...plan.profile }), directory,
          storageDirectory, node, nodeDirectory, code, nodeCode, storage, backend });
        saved.phase = "admitted"; const token = Object.freeze({}) as PreparedApplicationInstallation; installations.set(token, saved); return token;
      } catch (error) { invalidate(saved, error); throw error; }
    },
  });
}
