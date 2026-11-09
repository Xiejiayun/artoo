import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { assertCanonicalWindowsPath, assertNativeWindows, physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";
import { prepareWindowsCodeInstallation, assertWindowsCodeInstallation, auditWindowsCodeInstallation, type PreparedWindowsCodeInstallation } from "./windows-code-installation.js";
import { prepareWindowsProcessInstallation } from "./windows-process-installation.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { ApplicationPublicationInitializeSelectionSchema, ApplicationPublicationServiceSelectionSchema,
  type ApplicationPublicationProbeBinding } from "./application-publication-process-protocol.js";

const bootstrapName = "application-service-bootstrap.mjs", apiName = "application-service-host-api.mjs";
const manifestName = "application-service-host-manifest.json", maximumManifestBytes = 4_194_304, maximumSelectionBytes = 65_536;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u), path = z.string().min(1).max(4096);
const pinSchema = z.object({ path, bytes: z.number().int().min(1).max(268_435_456), sha256: hash }).strict();
const selectionFields = { version: z.literal(1),
  node_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  writable_workspace_roots: z.array(path).min(1).max(128), node: pinSchema,
  host_manifest: pinSchema,
  backend: z.object({ directory: path, manifest_sha256: hash }).strict(), system_root: path,
  shutdown: z.enum(["stdin", "signals"]),
};
const selectionSchema = z.object({ ...selectionFields, format: z.literal("artoo.application-service-selection.v1"),
  installation_reference: pinSchema }).strict();
const initializationSelectionSchema = z.object({ ...selectionFields, format: z.literal("artoo.application-initialize-selection.v1"),
  installation_parent: path, source_manifest: pinSchema }).strict();
const portable = z.string().min(1).max(512).refine(value => value.split("/").every(part =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(part) && !/[. ]$/u.test(part)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)));
const relative = portable.refine(value => value.endsWith(".mjs"));
const manifestSchema = z.object({ version: z.literal(1), format: z.literal("artoo.application-service-host.v1"),
  platform: z.literal("win32"), arch: z.literal("x64"), bootstrap: z.literal(bootstrapName), host_api: z.literal(apiName),
  files: z.array(z.object({ path: relative, bytes: z.number().int().min(1).max(67_108_864), sha256: hash }).strict()).min(2).max(1024),
}).strict();
const packageManifestName = "application-install-package.json";
const packageSchema = z.object({ version: z.literal(1), format: z.literal("artoo.application-install-package.v1"),
  profile: portable.refine(value => !value.includes("/")),
  files: z.array(z.object({ path: portable, bytes: z.number().int().min(1).max(268_435_456), sha256: hash }).strict()).min(4).max(1024),
}).strict();
type Pin = z.infer<typeof pinSchema>;
export interface ApplicationBootstrapTarget {
  readonly reference: Pin; readonly nodeId: string; readonly allowedRoots: readonly string[]; readonly node: Pin;
  readonly backend: PreparedWindowsProcessBackend; readonly hostCode: PreparedWindowsCodeInstallation; readonly hostDirectory: string;
}
export interface ApplicationInitializationTarget extends Omit<ApplicationBootstrapTarget, "reference"> {
  readonly parent: string; readonly sourceManifest: Pin;
}
export interface ApplicationInitializationPackage {
  readonly directory: string; readonly profile: Pin;
  readonly files: readonly Readonly<{ path: string; bytes: number; sha256: string }>[];
}
declare const initializationBrand: unique symbol;
export interface PreparedApplicationInitializationAdmission { readonly [initializationBrand]: true }
const initializations = new WeakMap<object, { target: ApplicationInitializationTarget; audit: () => void; failed: boolean;
  package: ApplicationInitializationPackage; members: ReadonlyMap<string, Pin>; publication: boolean }>();
declare const bootstrapBrand: unique symbol;
export interface PreparedApplicationBootstrapAdmission { readonly [bootstrapBrand]: true }
const admissions = new WeakMap<object, { target: ApplicationBootstrapTarget; audit: () => void; failed: boolean;
  publication?: ApplicationPublicationProbeBinding }>();
/** Only the original protected publication selection can bind trusted HTTP markers.
 * A plain identity/probe object does not establish this host admission. */
export function readApplicationBootstrapPublication(token: PreparedApplicationBootstrapAdmission): ApplicationPublicationProbeBinding | undefined {
  const saved = admissions.get(token) ?? fail("original bootstrap admission required");
  assertApplicationBootstrapAdmission(token, saved.target); return saved.publication;
}
const samePin = (left: Pin, right: Pin) => left?.path === right?.path && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
const sameCommon = (target: Omit<ApplicationBootstrapTarget, "reference">, original: Omit<ApplicationBootstrapTarget, "reference">) =>
  target.hostCode === original.hostCode && target.backend === original.backend && target.hostDirectory === original.hostDirectory
  && target.nodeId === original.nodeId && samePin(target.node, original.node)
  && JSON.stringify(target.allowedRoots) === JSON.stringify(original.allowedRoots);
/** An original bootstrap object remains bound to one target and one canonical
 * module graph. Neither a copied descriptor nor a caller callback can replace it. */
export function assertApplicationBootstrapAdmission(token: PreparedApplicationBootstrapAdmission, target: ApplicationBootstrapTarget): void {
  const saved = admissions.get(token);
  if (!saved || saved.failed) fail("original current bootstrap admission required");
  try {
    const original = saved.target;
    if (!sameCommon(target, original) || !samePin(target.reference, original.reference)) fail("bootstrap target binding differs");
    saved.audit();
  } catch (error) { saved.failed = true; throw error; }
}
/** Creation authority is separate from reopen authority. It is never rebound to
 * a later descriptor and cannot be reconstructed from selection JSON. */
export function assertApplicationInitializationAdmission(token: PreparedApplicationInitializationAdmission, target: ApplicationInitializationTarget): void {
  const saved = initializations.get(token);
  if (!saved || saved.failed) fail("original current initialization admission required");
  try {
    if (!sameCommon(target, saved.target) || target.parent !== saved.target.parent || !samePin(target.sourceManifest, saved.target.sourceManifest))
      fail("initialization target binding differs");
    saved.audit();
  } catch (error) { saved.failed = true; throw error; }
}
export function assertApplicationPublicationInitializationAdmission(token: PreparedApplicationInitializationAdmission, target: ApplicationInitializationTarget): void {
  assertApplicationInitializationAdmission(token, target);
  if (!initializations.get(token)!.publication) fail("original publication initialization selection required");
}
export function describeApplicationInitializationPackage(token: PreparedApplicationInitializationAdmission, target: ApplicationInitializationTarget): ApplicationInitializationPackage {
  assertApplicationInitializationAdmission(token, target); return initializations.get(token)!.package;
}
export function readApplicationInitializationFile(token: PreparedApplicationInitializationAdmission, target: ApplicationInitializationTarget, file: string): Buffer {
  assertApplicationInitializationAdmission(token, target); const saved = initializations.get(token)!;
  try {
    const pin = saved.members.get(file) ?? fail("original package member required");
    const bytes = read(pin.path, 268_435_456, pin).bytes;
    assertApplicationInitializationAdmission(token, target); return bytes;
  } catch (error) { saved.failed = true; throw error; }
}
const digest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fail(message: string): never { throw Error(`Application bootstrap: ${message}`); }
function facts(file: string, directory = false) {
  assertCanonicalWindowsPath(file); const value = lstatSync(file, { bigint: true });
  if (value.isSymbolicLink() || realpathSync.native(file) !== file || (directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n))
    fail("physical single-link local paths required");
  return value;
}
function same(left: ReturnType<typeof facts>, right: ReturnType<typeof facts>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory();
}
/** Existing-file reads retain the first lstat/handle/path facts through original
 * close. There is no fresh-writer transition, warmup, sleep or ctime exemption. */
function read(file: string, maximum: number, expected?: Pin) {
  physicalWindowsDirectory(win32.dirname(file)); const before = facts(file);
  if (before.size < 1n || before.size > BigInt(maximum) || expected && before.size !== BigInt(expected.bytes)) fail("file byte bound differs");
  const buffer = Buffer.alloc(Number(before.size) + 1), fd = openSync(file, "r"); let length = 0;
  let failure: unknown, failed = false;
  try {
    const check = () => { if (!same(before, fstatSync(fd, { bigint: true })) || !same(before, facts(file))) fail("input identity or metadata changed"); };
    check();
    while (length < buffer.length) { const count = readSync(fd, buffer, length, Math.min(65_536, buffer.length - length), length);
      check(); if (!count) break; length += count; }
    check();
  } catch (error) { failed = true; failure = error; }
  try { closeSync(fd); }
  catch (error) { if (failed) throw new AggregateError([failure, error], "Application input and original close failed"); throw error; }
  if (failed) throw failure;
  const bytes = buffer.subarray(0, length);
  if (!same(before, facts(file)) || BigInt(length) !== before.size || expected && digest(bytes) !== expected.sha256) fail("input changed through original close");
  return { bytes, facts: before, pin: Object.freeze({ path: file, bytes: length, sha256: digest(bytes) }) };
}
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
function checkRuntime(): void {
  assertNativeWindows();
  if (process.execArgv.length || process.connected !== undefined || Object.keys(process.env).some(key => /^(NODE_OPTIONS|NODE_PATH)$/iu.test(key)))
    fail("standalone default Node loader required");
}
function inventory(directory: string): { files: string[]; directories: string[] } {
  const files: string[] = [], directories: string[] = [], seen = new Set<string>();
  function visit(current: string, depth: number): void {
    if (depth > 64 || seen.size > 2048) fail("host inventory exceeds bound"); facts(current, true);
    for (const name of readdirSync(current).sort()) {
      const file = win32.join(current, name), local = win32.relative(directory, file).split(win32.sep).join("/"), key = local.toLowerCase();
      if (seen.has(key) || seen.size >= 2048) fail("host inventory aliases or exceeds bound"); seen.add(key);
      const value = lstatSync(file);
      if (value.isDirectory() && !value.isSymbolicLink()) { directories.push(local); visit(file, depth + 1); }
      else { facts(file); files.push(local); }
    }
  }
  visit(directory, 0); return { files: files.sort(), directories: directories.sort() };
}

/** Trusted installed bootstrap only. A protected local selection supplies data;
 * actual current-process Windows objects are created here before the application
 * graph is imported. This function never imports an application implementation. */
function prepareHost(selectionFile: string, entry: string, initialize: boolean, publication = false) {
  checkRuntime();
  const hostDirectory = physicalWindowsDirectory(win32.dirname(entry));
  if (win32.basename(entry) !== bootstrapName || process.argv[1] !== entry) fail("fixed installed bootstrap entry required");
  const initial = read(selectionFile, maximumSelectionBytes), selection = publication
    ? (initialize ? ApplicationPublicationInitializeSelectionSchema.parse(decode(initial.bytes))
      : ApplicationPublicationServiceSelectionSchema.parse(decode(initial.bytes)))
    : (initialize ? initializationSelectionSchema.parse(decode(initial.bytes)) : selectionSchema.parse(decode(initial.bytes)));
  const allowedRoots = Object.freeze(selection.writable_workspace_roots.map(physicalWindowsDirectory).sort());
  if (new Set(allowedRoots.map(value => value.toLowerCase())).size !== allowedRoots.length) fail("duplicate write roots");
  const selectionDirectory = physicalWindowsDirectory(win32.dirname(selectionFile));
  const generationRoot = physicalWindowsDirectory("installation_reference" in selection
    ? win32.dirname(win32.dirname(selection.installation_reference.path)) : selection.installation_parent);
  const nodeDirectory = physicalWindowsDirectory(win32.dirname(selection.node.path));
  if ([hostDirectory, generationRoot, nodeDirectory, selection.backend.directory].some(value => windowsPathsOverlap(selectionDirectory, value)))
    fail("selection requires its separate immutable configuration directory");
  if (selection.host_manifest.path !== win32.join(hostDirectory, manifestName) || selection.host_manifest.bytes > maximumManifestBytes
    || selection.node.path !== process.execPath || win32.basename(selection.node.path).toLowerCase() !== "node.exe"
    || "installation_reference" in selection && (win32.basename(selection.installation_reference.path) !== "REOPEN.v1.json"
      || selection.installation_reference.bytes > maximumManifestBytes))
    fail("selection differs from installed entry or current Node");
  const systemRoot = physicalWindowsDirectory(selection.system_root);
  if (realpathSync.native(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "") !== systemRoot
    || realpathSync.native(process.env.WINDIR ?? process.env.windir ?? "") !== systemRoot) fail("fixed Windows system environment differs");
  const selectionCode = prepareWindowsCodeInstallation({ directory: selectionDirectory, writableWorkspaceRoots: allowedRoots });
  const hostCode = prepareWindowsCodeInstallation({ directory: hostDirectory, writableWorkspaceRoots: allowedRoots });
  const nodeCode = prepareWindowsCodeInstallation({ directory: nodeDirectory, writableWorkspaceRoots: allowedRoots });
  const manifestInput = read(selection.host_manifest.path, maximumManifestBytes, selection.host_manifest);
  const manifest = manifestSchema.parse(decode(manifestInput.bytes));
  const fileNames = new Set<string>(), directories = new Set<string>(); let total = 0;
  const files = manifest.files.map(member => {
    const key = member.path.toLowerCase(); total += member.bytes;
    if (fileNames.has(key) || total > 134_217_728) fail("host members duplicate or exceed byte bound"); fileNames.add(key);
    const parents = member.path.split("/"); parents.pop();
    while (parents.length) { directories.add(parents.join("/")); parents.pop(); }
    return Object.freeze({ ...member, path: win32.join(hostDirectory, ...member.path.split("/")) });
  });
  if (!manifest.files.some(file => file.path === bootstrapName) || !manifest.files.some(file => file.path === apiName)) fail("both fixed host entries are required");
  const expectedInventory = { files: [...manifest.files.map(file => file.path), manifestName].sort(), directories: [...directories].sort() };
  const assertInputs = () => {
    checkRuntime();
    if (process.argv[1] !== entry || process.execPath !== selection.node.path
      || realpathSync.native(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "") !== systemRoot
      || realpathSync.native(process.env.WINDIR ?? process.env.windir ?? "") !== systemRoot) fail("original Node entry or system environment changed");
    assertWindowsCodeInstallation(selectionCode, selectionDirectory); assertWindowsCodeInstallation(hostCode, hostDirectory);
    assertWindowsCodeInstallation(nodeCode, nodeDirectory);
    const now = read(selectionFile, maximumSelectionBytes, initial.pin);
    if (!same(initial.facts, now.facts)) fail("original selection metadata changed");
    const currentManifest = read(selection.host_manifest.path, maximumManifestBytes, selection.host_manifest);
    if (!same(manifestInput.facts, currentManifest.facts)) fail("original host manifest metadata changed");
    if (JSON.stringify(inventory(hostDirectory)) !== JSON.stringify(expectedInventory)) fail("complete host inventory differs from manifest");
    for (const file of files) read(file.path, 67_108_864, file);
    read(selection.node.path, 268_435_456, selection.node);
    assertWindowsCodeInstallation(selectionCode, selectionDirectory); assertWindowsCodeInstallation(hostCode, hostDirectory);
    assertWindowsCodeInstallation(nodeCode, nodeDirectory);
  };
  assertInputs();
  const backend = prepareWindowsProcessInstallation({ directory: selection.backend.directory, manifestSha256: selection.backend.manifest_sha256,
    writableWorkspaceRoots: allowedRoots });
  const assertCurrent = () => {
    assertInputs(); auditWindowsCodeInstallation(selectionCode, selectionDirectory); auditWindowsCodeInstallation(hostCode, hostDirectory);
    auditWindowsCodeInstallation(nodeCode, nodeDirectory); assertWindowsProcessBackend(backend); assertInputs();
  };
  return { selection, allowedRoots, hostCode, hostDirectory, backend, assertCurrent };
}

export function prepareApplicationServiceHost(selectionFile: string, entry: string, publication = false) {
  const { selection, allowedRoots, hostCode, hostDirectory, backend, assertCurrent } = prepareHost(selectionFile, entry, false, publication);
  if (!("installation_reference" in selection)) fail("service selection required");
  const target = Object.freeze({ reference: Object.freeze({ ...selection.installation_reference }), nodeId: selection.node_id,
    allowedRoots, node: Object.freeze({ ...selection.node }), backend, hostCode, hostDirectory });
  const bootstrap = Object.freeze({}) as PreparedApplicationBootstrapAdmission;
  const publicationBinding = "publication" in selection ? Object.freeze({ ...selection.publication,
    ...(selection.publication.control ? { control: Object.freeze({ ...selection.publication.control }) } : {}),
    identity: Object.freeze({ ...selection.publication.identity, database_identity: Object.freeze({ ...selection.publication.identity.database_identity }) }) }) : undefined;
  admissions.set(bootstrap, { target, audit: assertCurrent, failed: false, ...(publicationBinding ? { publication: publicationBinding } : {}) });
  const check = () => assertApplicationBootstrapAdmission(bootstrap, target); check();
  return Object.freeze({ shutdown: selection.shutdown, assertCurrent: check, options: Object.freeze({ ...target, bootstrap }) });
}

export function prepareApplicationInitializationHost(selectionFile: string, entry: string, publication = false) {
  const { selection, allowedRoots, hostCode, hostDirectory, backend, assertCurrent } = prepareHost(selectionFile, entry, true, publication);
  if (!("source_manifest" in selection)) fail("initialization selection required");
  const parent = physicalWindowsDirectory(selection.installation_parent), directory = physicalWindowsDirectory(win32.dirname(selection.source_manifest.path));
  if (win32.basename(selection.source_manifest.path) !== packageManifestName || selection.source_manifest.bytes > maximumManifestBytes
    || [parent, hostDirectory, win32.dirname(selection.node.path), selection.backend.directory, win32.dirname(selectionFile)]
      .some(value => windowsPathsOverlap(directory, value))
    || [hostDirectory, win32.dirname(selection.node.path), selection.backend.directory].some(value => windowsPathsOverlap(parent, value)))
    fail("initialization requires separate package and destination roots");
  const sourceCode = prepareWindowsCodeInstallation({ directory, writableWorkspaceRoots: allowedRoots });
  const original = read(selection.source_manifest.path, maximumManifestBytes, selection.source_manifest), manifest = packageSchema.parse(decode(original.bytes));
  const members = new Map<string, Pin>(), names = new Set<string>(), directories = new Set<string>(); let total = 0;
  for (const file of manifest.files) {
    const key = file.path.toLowerCase(); total += file.bytes;
    if (names.has(key) || key === packageManifestName.toLowerCase() || total > 536_870_912) fail("package members alias or exceed bounds");
    names.add(key); const segments = file.path.split("/"); segments.pop();
    while (segments.length) { directories.add(segments.join("/")); segments.pop(); }
    const pin = Object.freeze({ ...file, path: win32.join(directory, ...file.path.split("/")) }); members.set(pin.path, pin);
  }
  const profile = members.get(win32.join(directory, manifest.profile)) ?? fail("original package profile required");
  const expected = { files: [...manifest.files.map(file => file.path), packageManifestName].sort(), directories: [...directories].sort() };
  const assertSource = () => {
    assertCurrent(); assertWindowsCodeInstallation(sourceCode, directory);
    const now = read(selection.source_manifest.path, maximumManifestBytes, selection.source_manifest);
    if (!same(original.facts, now.facts) || JSON.stringify(inventory(directory)) !== JSON.stringify(expected)) fail("original package inventory changed");
    for (const pin of members.values()) read(pin.path, 268_435_456, pin);
    auditWindowsCodeInstallation(sourceCode, directory); assertCurrent();
  };
  const target: ApplicationInitializationTarget = Object.freeze({ parent, sourceManifest: Object.freeze({ ...selection.source_manifest }),
    nodeId: selection.node_id, allowedRoots, node: Object.freeze({ ...selection.node }), backend, hostCode, hostDirectory });
  const bootstrap = Object.freeze({}) as PreparedApplicationInitializationAdmission;
  const packageData: ApplicationInitializationPackage = Object.freeze({ directory, profile,
    files: Object.freeze(manifest.files.map(value => Object.freeze({ ...value }))) });
  initializations.set(bootstrap, { target, audit: assertSource, failed: false, package: packageData, members, publication });
  const check = () => assertApplicationInitializationAdmission(bootstrap, target); check();
  return Object.freeze({ shutdown: selection.shutdown, assertCurrent: check, options: Object.freeze({ ...target, bootstrap }) });
}

/** Both local formats use the same fixed entry and one delayed canonical graph.
 * Dispatch grants no authority; the selected reader repeats strict admission. */
export function prepareApplicationBootstrap(selectionFile: string, entry: string) {
  checkRuntime(); const value = decode(read(selectionFile, maximumSelectionBytes).bytes);
  const format = z.object({ format: z.string() }).passthrough().parse(value).format;
  if (format === "artoo.application-service-selection.v1")
    return Object.freeze({ operation: "reopen" as const, ...prepareApplicationServiceHost(selectionFile, entry) });
  if (format === "artoo.application-initialize-selection.v1")
    return Object.freeze({ operation: "initialize" as const, ...prepareApplicationInitializationHost(selectionFile, entry) });
  if (format === "artoo.application-publication-initialize-selection.v1")
    return Object.freeze({ operation: "publication-initialize" as const, ...prepareApplicationInitializationHost(selectionFile, entry, true) });
  if (format === "artoo.application-publication-service-selection.v1")
    return Object.freeze({ operation: "publication-reopen" as const, ...prepareApplicationServiceHost(selectionFile, entry, true) });
  return fail("fixed application selection format required");
}

export function applicationServiceSelection(args: readonly string[]): string {
  if (args.length !== 1 || !args[0]!.startsWith("--selection=")) fail("one --selection=<absolute protected file> argument required");
  const file = args[0]!.slice("--selection=".length); assertCanonicalWindowsPath(file); return file;
}
