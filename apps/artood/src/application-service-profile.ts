import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { ApplicationBrokerConfigurationSchema } from "./application-broker-control.js";
import { parseApplicationDataSchema } from "./application-data-contract.js";
import { prepareApplicationBrokerProcess, type PreparedApplicationBrokerProcess } from "./application-broker-process.js";
import { prepareApplicationRuntimeProcess, type PreparedApplicationRuntimeProcess } from "./application-runtime-process.js";
import { ApplicationRuntimeFilePinSchema, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { loadApplicationRuntimeConfiguration, loadApplicationRuntimeHelperManifest } from "./application-runtime-installation.js";
import { createApplicationArtifactOwner, revokeApplicationClientReader, type ApplicationArtifactExpectation, type ApplicationClientReader } from "./application-artifact-admission.js";
import { describeApplicationInstallation, assertApplicationInstallation, auditApplicationInstallation,
  invalidateApplicationInstallation, bindApplicationInstallationClientReader, type PreparedApplicationInstallation } from "./application-installation.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { prepareWindowsCodeInstallation, assertWindowsCodeInstallation, auditWindowsCodeInstallation } from "./windows-code-installation.js";
import { prepareWindowsReleaseStorage, assertWindowsReleaseStorage, auditWindowsReleaseStorage } from "./windows-release-storage.js";
import { assertCanonicalWindowsPath, assertNativeWindows, physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u), path = z.string().min(1).max(4096);
const pin = ApplicationRuntimeFilePinSchema;
const schema = z.object({ version: z.literal(1), format: z.literal("artoo.application-service-profile.v1"),
  node_id: id, writable_workspace_roots: z.array(path).min(1).max(128),
  installation: z.object({ version: z.literal(1), generation_id: id }).strict().optional(),
  installation_directory: path, storage_directory: path,
  runtime: z.object({ helper: pin, helperManifest: pin, node: pin, entry: pin, configuration: pin }).strict(),
  broker: z.object({ node: pin, entry: pin, create_configuration: pin, open_configuration: pin }).strict(),
  http: z.object({ origin: z.string().max(128), timeout_ms: z.number().int().min(1).max(30_000),
    maximum_concurrent: z.literal(1), access: z.enum(["read", "write"]),
    same_origin: z.object({ version: z.literal(1), api_prefix: z.literal("/api") }).strict().optional() }).strict(),
}).strict();
export interface ApplicationServiceProfileOptions {
  readonly file: string; readonly nodeId: string; readonly allowedRoots: readonly string[];
  readonly backend: PreparedWindowsProcessBackend;
}
declare const profileBrand: unique symbol;
export interface PreparedApplicationServiceProfile { readonly [profileBrand]: true }
export interface ApplicationServiceBinding {
  readonly origin: string; readonly port: number; readonly timeoutMs: number;
  readonly maximumAccess: "read" | "write"; readonly qualifiedForProduct: false;
  readonly sameOrigin?: Readonly<{ version: 1; apiPrefix: "/api" }>;
}
function fail(reason: string): never { throw Error(`Application service profile: ${reason}`); }
function facts(file: string) {
  assertCanonicalWindowsPath(file);
  const value = lstatSync(file, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || realpathSync.native(file) !== file) fail("physical single-link file required");
  return value;
}
function same(left: ReturnType<typeof facts>, right: ReturnType<typeof facts>): boolean {
  return right.isFile() && !right.isSymbolicLink() && right.nlink === 1n && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
/** One bounded original-handle read, including the original close. Metadata
 * changes reject: installation/AV timing is not repaired by retrying this read. */
function read(file: string, maximum: number) {
  const before = facts(file);
  if (before.size < 1n || before.size > BigInt(maximum)) fail("file exceeds bound");
  // Allocation can throw; acquire the original handle only after it succeeds.
  const bytes = Buffer.alloc(Number(before.size) + 1);
  const fd = openSync(file, "r");
  let length = 0;
  try {
    const check = () => { if (!same(before, fstatSync(fd, { bigint: true })) || !same(before, facts(file))) fail("file changed during read"); };
    check();
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, Math.min(65_536, bytes.length - length), length);
      if (!count) break; length += count; check();
    }
    check(); if (BigInt(length) !== before.size) fail("file size changed during read");
  } finally { closeSync(fd); }
  if (!same(before, facts(file))) fail("file changed during close");
  const content = bytes.subarray(0, length);
  return { bytes: content, facts: before, pin: Object.freeze({ path: file, bytes: length,
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` }) };
}
function fixed(expected: ApplicationRuntimeFilePin, maximum = 268_435_456) {
  const value = read(expected.path, maximum);
  if (value.pin.bytes !== expected.bytes || value.pin.sha256 !== expected.sha256) fail("installed bytes differ from profile");
  return value;
}
function roots(values: readonly string[]): readonly string[] {
  const result = values.map(physicalWindowsDirectory).sort();
  if (new Set(result.map(value => value.toLowerCase())).size !== result.length) fail("duplicate declared write roots");
  return Object.freeze(result);
}
function within(directory: string, file: string): void {
  const relative = win32.relative(directory, file);
  if (!relative || win32.isAbsolute(relative) || relative === ".." || relative.startsWith("..\\")) fail("file outside protected installation");
}
interface InstalledAuthority {
  readonly token: PreparedApplicationInstallation;
  readonly binding: ReturnType<typeof describeApplicationInstallation>;
}
function installationGuard<T>(installation: InstalledAuthority | undefined, operation: () => T): T {
  if (!installation) return operation();
  try { assertApplicationInstallation(installation.token); return operation(); }
  catch (error) { invalidateApplicationInstallation(installation.token); throw error; }
}
const samePin = (left: ApplicationRuntimeFilePin, right: ApplicationRuntimeFilePin) =>
  left.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256;
function prepare(input: ApplicationServiceProfileOptions, installation?: InstalledAuthority) {
  const guarded = <T>(operation: () => T): T => installationGuard(installation, operation);
  assertNativeWindows();
  if (!input || Object.keys(input).some(key => !["file", "nodeId", "allowedRoots", "backend"].includes(key))
    || !id.safeParse(input.nodeId).success || !Array.isArray(input.allowedRoots) || !input.allowedRoots.length || input.allowedRoots.length > 128)
    fail("fixed local node settings required");
  const file = input.file, backend = input.backend;
  const allowedRoots = roots(input.allowedRoots), profileDirectory = physicalWindowsDirectory(win32.dirname(file));
  // Managed profiles reuse the original generation authority. No second inventory
  // baseline may replace it, including for the profile's own directory.
  if (installation && (profileDirectory !== installation.binding.directory || file !== installation.binding.profile.path))
    fail("installed profile must be the original file at the code root");
  const profileCode = installation ? installation.binding.code
    : prepareWindowsCodeInstallation({ directory: profileDirectory, writableWorkspaceRoots: allowedRoots });
  const original = read(file, 65_536);
  if (installation && !samePin(original.pin, installation.binding.profile)) fail("profile differs from independently selected installation pin");
  const profile = schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original.bytes)));
  if (installation ? profile.installation?.generation_id !== installation.binding.generationId : profile.installation !== undefined)
    fail("original matching installation authority required for a managed profile");
  if (profile.node_id !== input.nodeId || JSON.stringify(roots(profile.writable_workspace_roots)) !== JSON.stringify(allowedRoots))
    fail("profile differs from declared node or write roots");
  if (win32.basename(profile.runtime.node.path).toLowerCase() !== "node.exe"
    || win32.basename(profile.runtime.entry.path) !== "application-runtime.mjs"
    || win32.basename(profile.runtime.configuration.path) !== "application-runtime.json"
    || win32.dirname(profile.runtime.configuration.path) !== win32.dirname(profile.runtime.entry.path)
    || win32.basename(profile.broker.entry.path) !== "application-broker.mjs") fail("fixed trusted entry names required");
  const native = describeWindowsProcessInstallation(backend);
  if (JSON.stringify(roots(native.writableWorkspaceRoots)) !== JSON.stringify(allowedRoots)) fail("native write roots differ");
  const directory = physicalWindowsDirectory(profile.installation_directory), storageDirectory = physicalWindowsDirectory(profile.storage_directory);
  within(directory, file);
  const nodeDirectory = physicalWindowsDirectory(win32.dirname(profile.runtime.node.path));
  if (JSON.stringify(profile.runtime.node) !== JSON.stringify(profile.broker.node)) fail("runtime and broker require the same fixed Node");
  if (installation && (directory !== installation.binding.directory || storageDirectory !== installation.binding.storageDirectory
    || nodeDirectory !== installation.binding.nodeDirectory || !samePin(profile.runtime.node, installation.binding.node)))
    fail("profile differs from original installation destinations or Node selection");
  if ([directory, profileDirectory, nodeDirectory, native.directory].some(value => windowsPathsOverlap(value, storageDirectory)))
    fail("storage must be separate from code and native installation");
  const url = new URL(profile.http.origin), port = Number(url.port);
  if (url.origin !== profile.http.origin || url.protocol !== "http:" || url.hostname !== "127.0.0.1"
    || url.username || url.password || !Number.isInteger(port) || port < 1 || port > 65535) fail("fixed canonical loopback HTTP origin required");
  const code = installation ? installation.binding.code : prepareWindowsCodeInstallation({ directory, writableWorkspaceRoots: allowedRoots });
  const nodeCode = installation ? installation.binding.nodeCode : prepareWindowsCodeInstallation({ directory: nodeDirectory, writableWorkspaceRoots: allowedRoots });
  const storage = installation ? installation.binding.storage : prepareWindowsReleaseStorage({ directory: storageDirectory, writableWorkspaceRoots: allowedRoots });
  const allPins = [...Object.values(profile.runtime), profile.broker.entry, profile.broker.create_configuration, profile.broker.open_configuration];
  for (const value of allPins) { if (value.path !== profile.runtime.node.path) within(directory, value.path); fixed(value); }
  const helperFiles = loadApplicationRuntimeHelperManifest(profile.runtime.helper, profile.runtime.helperManifest);
  const loaded = loadApplicationRuntimeConfiguration(profile.runtime.configuration);
  for (const value of [...helperFiles, ...loaded.runtimeFiles]) within(directory, value.path);
  const owner = createApplicationArtifactOwner(loaded.config.expectation as ApplicationArtifactExpectation), captured = owner.capture(loaded.capture);
  owner.revoke(captured); // Content verification only; never execute product text here.
  const decode = (value: ApplicationRuntimeFilePin) => ApplicationBrokerConfigurationSchema.parse(JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(fixed(value, 65_536).bytes)));
  const create = decode(profile.broker.create_configuration), open = decode(profile.broker.open_configuration);
  if (create.mode !== "create" || open.mode !== "open" || JSON.stringify({ ...create, mode: "open" }) !== JSON.stringify(open)
    || open.maximumAccess !== profile.http.access) fail("fixed create/open bindings differ");
  parseApplicationDataSchema(open.schemaJson);
  const expectation = loaded.config.expectation as ApplicationArtifactExpectation;
  if (expectation.artifacts.digest !== open.scope.artifact_digest) fail("runtime and broker artifact bindings differ");
  assertCanonicalWindowsPath(open.databasePath);
  if (win32.dirname(open.databasePath) !== storageDirectory) fail("database must be a direct child of storage");
  const assertLocalAdmission = (): void => guarded(() => {
    assertWindowsCodeInstallation(profileCode, profileDirectory); assertWindowsCodeInstallation(code, directory);
    assertWindowsCodeInstallation(nodeCode, nodeDirectory); assertWindowsReleaseStorage(storage, storageDirectory);
    const now = read(file, 65_536);
    if (!same(original.facts, now.facts) || now.pin.sha256 !== original.pin.sha256) fail("original profile changed");
  });
  const audit = (): void => guarded(() => {
    if (installation) { auditApplicationInstallation(installation.token); assertLocalAdmission(); }
    else {
      assertLocalAdmission(); auditWindowsCodeInstallation(code, directory); auditWindowsCodeInstallation(nodeCode, nodeDirectory);
      auditWindowsReleaseStorage(storage, storageDirectory); assertWindowsProcessBackend(backend);
    }
  });
  const requireStore = (mode: "create" | "open"): void => {
    try { facts(open.databasePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && mode === "create") return;
      // Absent/existing stores are lifecycle preconditions. Physical-path,
      // permission and file-identity errors are installation integrity failures.
      if (installation && (error as NodeJS.ErrnoException).code !== "ENOENT") invalidateApplicationInstallation(installation.token);
      throw error;
    }
    if (mode === "create") fail("new store already exists; it will not be overwritten");
  };
  audit();
  const binding: ApplicationServiceBinding = Object.freeze({ origin: profile.http.origin, port,
    timeoutMs: profile.http.timeout_ms, maximumAccess: profile.http.access, qualifiedForProduct: false,
    ...(profile.http.same_origin ? { sameOrigin: Object.freeze({ version: 1 as const, apiPrefix: "/api" as const }) } : {}) });
  return { binding, assertGeneration(): void { guarded(() => {}); }, prepareClient(): ApplicationClientReader {
    if (!profile.http.same_origin) fail("same-origin client serving is not enabled");
    audit(); requireStore("open");
    // A new reader belongs to this listener only. Reload the pinned closure under
    // the original profile admission; no path or manifest comes from HTTP.
    return guarded(() => {
      const current = loadApplicationRuntimeConfiguration(profile.runtime.configuration);
      const clientOwner = createApplicationArtifactOwner(current.config.expectation as ApplicationArtifactExpectation);
      const clientCapture = clientOwner.capture(current.capture);
      let reader: ApplicationClientReader | undefined;
      try {
        reader = clientOwner.clientReader(clientCapture);
        if (installation) bindApplicationInstallationClientReader(installation.token, reader);
        return reader;
      } catch (error) {
        if (reader) revokeApplicationClientReader(reader);
        try { clientOwner.revoke(clientCapture); } finally { throw error; }
      }
    });
  }, assertOpenStore(): void { audit(); requireStore("open"); }, prepareRuntime(): PreparedApplicationRuntimeProcess {
    audit(); requireStore("open"); return guarded(() => prepareApplicationRuntimeProcess({ ...profile.runtime, assertLocalAdmission }));
  }, prepareBroker(mode: "create" | "open"): PreparedApplicationBrokerProcess {
    audit(); requireStore(mode);
    return guarded(() => prepareApplicationBrokerProcess({ native: { directory: native.directory, manifestSha256: native.manifestSha256,
      assertLocalInstallation: () => guarded(() => assertWindowsProcessBackend(backend)) }, node: profile.broker.node, entry: profile.broker.entry,
      configuration: mode === "create" ? profile.broker.create_configuration : profile.broker.open_configuration, assertLocalAdmission }));
  } };
}
const profiles = new WeakMap<object, ReturnType<typeof prepare>>();
function state(token: PreparedApplicationServiceProfile) {
  const saved = profiles.get(token) ?? fail("original local profile authority required"); saved.assertGeneration(); return saved;
}
export function prepareApplicationServiceProfile(input: ApplicationServiceProfileOptions): PreparedApplicationServiceProfile {
  const saved = prepare(input), token = Object.freeze({}) as PreparedApplicationServiceProfile; profiles.set(token, saved); return token;
}
/** Original in-process handoff only. The installation owner selects every input
 * and the exact backend; a profile tag or serialized plan grants no authority. */
export function prepareInstalledApplicationServiceProfile(installation: PreparedApplicationInstallation): PreparedApplicationServiceProfile {
  try {
    const binding = describeApplicationInstallation(installation);
    const saved = installationGuard({ token: installation, binding }, () => prepare({ file: binding.profile.path, nodeId: binding.nodeId,
      allowedRoots: binding.allowedRoots, backend: binding.backend }, { token: installation, binding }));
    const token = Object.freeze({}) as PreparedApplicationServiceProfile; profiles.set(token, saved); return token;
  } catch (error) { invalidateApplicationInstallation(installation); throw error; }
}
export function describeApplicationServiceProfile(token: PreparedApplicationServiceProfile): ApplicationServiceBinding { return state(token).binding; }
export function assertApplicationServiceOpenStore(token: PreparedApplicationServiceProfile): void { state(token).assertOpenStore(); }
export function prepareProfileApplicationClient(token: PreparedApplicationServiceProfile): ApplicationClientReader { return state(token).prepareClient(); }
export function prepareProfileApplicationRuntime(token: PreparedApplicationServiceProfile): PreparedApplicationRuntimeProcess { return state(token).prepareRuntime(); }
export function prepareProfileApplicationBroker(token: PreparedApplicationServiceProfile, mode: "create" | "open"): PreparedApplicationBrokerProcess {
  if (mode !== "create" && mode !== "open") fail("fixed store mode required");
  return state(token).prepareBroker(mode);
}
