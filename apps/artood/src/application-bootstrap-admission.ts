import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { assertCanonicalWindowsPath, assertNativeWindows, physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";
import { prepareWindowsCodeInstallation, assertWindowsCodeInstallation, auditWindowsCodeInstallation, type PreparedWindowsCodeInstallation } from "./windows-code-installation.js";
import { prepareWindowsProcessInstallation } from "./windows-process-installation.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

const bootstrapName = "application-service-bootstrap.mjs", apiName = "application-service-host-api.mjs";
const manifestName = "application-service-host-manifest.json", maximumManifestBytes = 4_194_304, maximumSelectionBytes = 65_536;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u), path = z.string().min(1).max(4096);
const pinSchema = z.object({ path, bytes: z.number().int().min(1).max(268_435_456), sha256: hash }).strict();
const selectionSchema = z.object({ version: z.literal(1), format: z.literal("artoo.application-service-selection.v1"),
  node_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  writable_workspace_roots: z.array(path).min(1).max(128), node: pinSchema,
  host_manifest: pinSchema, installation_reference: pinSchema,
  backend: z.object({ directory: path, manifest_sha256: hash }).strict(), system_root: path,
  shutdown: z.enum(["stdin", "signals"]),
}).strict();
const relative = z.string().min(1).max(512).refine(value => value.endsWith(".mjs") && value.split("/").every(part =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(part) && !/[. ]$/u.test(part)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)));
const manifestSchema = z.object({ version: z.literal(1), format: z.literal("artoo.application-service-host.v1"),
  platform: z.literal("win32"), arch: z.literal("x64"), bootstrap: z.literal(bootstrapName), host_api: z.literal(apiName),
  files: z.array(z.object({ path: relative, bytes: z.number().int().min(1).max(67_108_864), sha256: hash }).strict()).min(2).max(1024),
}).strict();
type Pin = z.infer<typeof pinSchema>;
export interface ApplicationBootstrapTarget {
  readonly reference: Pin; readonly nodeId: string; readonly allowedRoots: readonly string[]; readonly node: Pin;
  readonly backend: PreparedWindowsProcessBackend; readonly hostCode: PreparedWindowsCodeInstallation; readonly hostDirectory: string;
}
declare const bootstrapBrand: unique symbol;
export interface PreparedApplicationBootstrapAdmission { readonly [bootstrapBrand]: true }
const admissions = new WeakMap<object, { target: ApplicationBootstrapTarget; audit: () => void; failed: boolean }>();
const samePin = (left: Pin, right: Pin) => left?.path === right?.path && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
/** An original bootstrap object remains bound to one target and one canonical
 * module graph. Neither a copied descriptor nor a caller callback can replace it. */
export function assertApplicationBootstrapAdmission(token: PreparedApplicationBootstrapAdmission, target: ApplicationBootstrapTarget): void {
  const saved = admissions.get(token);
  if (!saved || saved.failed) fail("original current bootstrap admission required");
  try {
    const original = saved.target;
    if (target.hostCode !== original.hostCode || target.backend !== original.backend || target.hostDirectory !== original.hostDirectory
      || target.nodeId !== original.nodeId || !samePin(target.reference, original.reference) || !samePin(target.node, original.node)
      || JSON.stringify(target.allowedRoots) !== JSON.stringify(original.allowedRoots)) fail("bootstrap target binding differs");
    saved.audit();
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
export function prepareApplicationServiceHost(selectionFile: string, entry: string) {
  checkRuntime();
  const hostDirectory = physicalWindowsDirectory(win32.dirname(entry));
  if (win32.basename(entry) !== bootstrapName || process.argv[1] !== entry) fail("fixed installed bootstrap entry required");
  const initial = read(selectionFile, maximumSelectionBytes), selection = selectionSchema.parse(decode(initial.bytes));
  const allowedRoots = Object.freeze(selection.writable_workspace_roots.map(physicalWindowsDirectory).sort());
  if (new Set(allowedRoots.map(value => value.toLowerCase())).size !== allowedRoots.length) fail("duplicate write roots");
  const selectionDirectory = physicalWindowsDirectory(win32.dirname(selectionFile));
  const generationRoot = physicalWindowsDirectory(win32.dirname(win32.dirname(selection.installation_reference.path)));
  const nodeDirectory = physicalWindowsDirectory(win32.dirname(selection.node.path));
  if ([hostDirectory, generationRoot, nodeDirectory, selection.backend.directory].some(value => windowsPathsOverlap(selectionDirectory, value)))
    fail("selection requires its separate immutable configuration directory");
  if (selection.host_manifest.path !== win32.join(hostDirectory, manifestName) || selection.host_manifest.bytes > maximumManifestBytes
    || selection.node.path !== process.execPath || win32.basename(selection.node.path).toLowerCase() !== "node.exe"
    || win32.basename(selection.installation_reference.path) !== "REOPEN.v1.json" || selection.installation_reference.bytes > maximumManifestBytes)
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
  const target = Object.freeze({ reference: Object.freeze({ ...selection.installation_reference }), nodeId: selection.node_id,
    allowedRoots, node: Object.freeze({ ...selection.node }), backend, hostCode, hostDirectory });
  const bootstrap = Object.freeze({}) as PreparedApplicationBootstrapAdmission;
  admissions.set(bootstrap, { target, audit: assertCurrent, failed: false });
  const check = () => assertApplicationBootstrapAdmission(bootstrap, target); check();
  return Object.freeze({ shutdown: selection.shutdown, assertCurrent: check, options: Object.freeze({ ...target, bootstrap }) });
}

export function applicationServiceSelection(args: readonly string[]): string {
  if (args.length !== 1 || !args[0]!.startsWith("--selection=")) fail("one --selection=<absolute protected file> argument required");
  const file = args[0]!.slice("--selection=".length); assertCanonicalWindowsPath(file); return file;
}
