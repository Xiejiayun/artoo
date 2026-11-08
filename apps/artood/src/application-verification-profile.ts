import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { ApplicationCapabilitiesV1Schema, type ApplicationCapabilitiesV1 } from "@artoo/domain";
import { ApplicationRuntimeFilePinSchema, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { readApplicationRuntimePin, loadApplicationRuntimeHelperManifest, ApplicationRuntimeVendorManifestSchema } from "./application-runtime-installation.js";
import { loadApplicationCompilerConfiguration } from "./application-compiler-installation.js";
import { prepareWindowsCodeInstallation, auditWindowsCodeInstallation, type PreparedWindowsCodeInstallation } from "./windows-code-installation.js";
import { prepareWindowsReleaseStorage, auditWindowsReleaseStorage, type PreparedWindowsReleaseStorage } from "./windows-release-storage.js";
import { assertCanonicalWindowsPath, assertNativeWindows, physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";

const pin = ApplicationRuntimeFilePinSchema;
const path = z.string().min(1).max(4096);
const compiler = z.object({ helper: pin, helperManifest: pin, node: pin, entry: pin, configuration: pin }).strict();
const schema = z.object({ version: z.literal(1), format: z.literal("artoo.application-verification-profile.v1"),
  node: pin, compiler,
  runtime: z.object({ helper: pin, helperManifest: pin, entry: pin, vendorManifest: pin, guestBootstrap: pin }).strict(),
  broker: pin, hostManifest: pin, browser: pin,
  candidate_parent: path, installation_parent: path, selection_parent: path,
  origin: z.string().max(128), timeout_ms: z.number().int().min(1).max(600_000),
  operation_timeout_ms: z.number().int().min(1).max(30_000),
  action_timeout_ms: z.number().int().min(500).max(10_000),
}).strict();
export type ApplicationVerificationConfiguration = z.infer<typeof schema>;
export interface ApplicationVerificationProfileSelection { readonly version: 1; readonly configuration: ApplicationRuntimeFilePin }
export interface ApplicationVerificationFile { readonly name: string; readonly pin: ApplicationRuntimeFilePin }
declare const brand: unique symbol;
export interface PreparedApplicationVerificationProfile { readonly [brand]: true }
interface Saved {
  readonly config: ApplicationVerificationConfiguration; readonly configuration: ApplicationRuntimeFilePin;
  readonly roots: readonly string[]; readonly files: readonly ApplicationVerificationFile[];
  readonly packageFiles: readonly ApplicationVerificationFile[];
  readonly codes: ReadonlyMap<string, PreparedWindowsCodeInstallation>;
  readonly storage: ReadonlyMap<string, PreparedWindowsReleaseStorage>;
  readonly capabilities: ApplicationCapabilitiesV1; readonly toolchainDigest: string; readonly hostEntry: ApplicationRuntimeFilePin;
}
const profiles = new WeakMap<object, Saved>();
const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const same = (left: ApplicationRuntimeFilePin, right: ApplicationRuntimeFilePin): boolean =>
  left.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const relative = z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u)
  .refine(value => value.split("/").every(part => part !== "." && part !== ".." && !/[. ]$/u.test(part)));
const hostSchema = z.object({ version: z.literal(1), format: z.literal("artoo.application-service-host.v1"),
  platform: z.literal("win32"), arch: z.literal("x64"), bootstrap: z.literal("application-service-bootstrap.mjs"),
  host_api: z.literal("application-service-host-api.mjs"),
  files: z.array(z.object({ path: relative.refine(value => value.endsWith(".mjs")), bytes: z.number().int().min(1).max(67_108_864),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict()).min(2).max(1024),
}).strict();
function fail(reason: string): never { throw Error(`Application verification profile: ${reason}`); }

/** Local configuration only. No path, argv, tool pin or mutable authority is taken from a run. */
export function prepareApplicationVerificationProfile(selection: ApplicationVerificationProfileSelection,
  writableRoots: readonly string[]): PreparedApplicationVerificationProfile {
  assertNativeWindows();
  if (process.arch !== "x64") fail("native x64 is required");
  const selected = z.object({ version: z.literal(1), configuration: pin }).strict().parse(selection);
  if (selected.configuration.bytes > 65_536) fail("configuration exceeds bound");
  const configuration = Object.freeze({ ...selected.configuration });
  const bytes = readApplicationRuntimePin(configuration), config = freeze(schema.parse(json(bytes)));
  const roots = Object.freeze(writableRoots.map(physicalWindowsDirectory).sort());
  if (!roots.length || new Set(roots.map(root => root.toLowerCase())).size !== roots.length) fail("complete distinct write roots required");
  if (!same(config.node, config.compiler.node) || win32.basename(config.node.path).toLowerCase() !== "node.exe"
    || win32.basename(config.runtime.entry.path) !== "application-runtime.mjs"
    || win32.basename(config.broker.path) !== "application-broker.mjs"
    || win32.basename(config.runtime.guestBootstrap.path) !== "application-runtime-guest-bootstrap.js"
    || win32.basename(config.hostManifest.path) !== "application-service-host-manifest.json") fail("fixed installed entries required");
  const origin = new URL(config.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port
    || origin.origin !== config.origin || origin.username || origin.password) fail("fixed loopback origin required");
  const mutable = [config.candidate_parent, config.installation_parent, config.selection_parent].map(physicalWindowsDirectory);
  for (let i = 0; i < mutable.length; i++) {
    if (roots.some(root => windowsPathsOverlap(mutable[i]!, root))
      || mutable.slice(i + 1).some(root => windowsPathsOverlap(mutable[i]!, root))) fail("mutable roots overlap");
  }
  const files = new Map<string, ApplicationVerificationFile>(), packageFiles = new Map<string, ApplicationVerificationFile>();
  const add = (name: string, value: ApplicationRuntimeFilePin, packaged?: string) => {
    relative.parse(name); assertCanonicalWindowsPath(value.path);
    if (files.has(name)) fail("duplicate toolchain name");
    const member = Object.freeze({ name, pin: Object.freeze(pin.parse(value)) });
    readApplicationRuntimePin(member.pin); files.set(name, member);
    if (packaged) { relative.parse(packaged); if (packageFiles.has(packaged)) fail("duplicate package name");
      packageFiles.set(packaged, Object.freeze({ name: packaged, pin: member.pin })); }
  };
  add("configuration.json", configuration); add("node.exe", config.node);
  add("compiler/entry.mjs", config.compiler.entry); add("compiler/configuration.json", config.compiler.configuration);
  for (const [index, value] of loadApplicationCompilerConfiguration(config.compiler.configuration).files.entries()) add(`compiler/member-${index}`, value);
  for (const [index, value] of loadApplicationRuntimeHelperManifest(config.compiler.helper, config.compiler.helperManifest).entries()) add(`compiler/native-${index}`, value);
  for (const value of loadApplicationRuntimeHelperManifest(config.runtime.helper, config.runtime.helperManifest)) {
    const suffix = win32.relative(win32.dirname(config.runtime.helperManifest.path), value.path).split("\\").join("/");
    add(`runtime/native/${suffix}`, value, `native/${suffix}`);
  }
  add("runtime/entry.mjs", config.runtime.entry, "application-runtime.mjs");
  add("runtime/guest.js", config.runtime.guestBootstrap, "application-runtime-guest-bootstrap.js");
  add("runtime/broker.mjs", config.broker, "application-broker.mjs");
  if (config.runtime.vendorManifest.bytes > 4_194_304) fail("vendor manifest exceeds bound");
  const vendor = ApplicationRuntimeVendorManifestSchema.parse(json(readApplicationRuntimePin(config.runtime.vendorManifest)));
  add("runtime/vendor-manifest.json", config.runtime.vendorManifest, "vendor/manifest.json");
  for (const member of vendor.files) add(`runtime/vendor/${member.path}`, {
    path: win32.join(win32.dirname(config.runtime.vendorManifest.path), ...member.path.split("/")), bytes: member.bytes,
    sha256: `sha256:${member.sha256}` }, `vendor/${member.path}`);
  if (config.hostManifest.bytes > 4_194_304) fail("host manifest exceeds bound");
  const host = hostSchema.parse(json(readApplicationRuntimePin(config.hostManifest))), hostDirectory = win32.dirname(config.hostManifest.path);
  add("host/manifest.json", config.hostManifest);
  const hostNames = new Set<string>(); let hostEntry: ApplicationRuntimeFilePin | undefined;
  for (const member of host.files) {
    if (hostNames.has(member.path.toLowerCase())) fail("aliased host member"); hostNames.add(member.path.toLowerCase());
    const value = { path: win32.join(hostDirectory, ...member.path.split("/")), bytes: member.bytes, sha256: member.sha256 };
    add(`host/${member.path}`, value); if (member.path === host.bootstrap) hostEntry = value;
  }
  if (!hostEntry || !hostNames.has(host.host_api)) fail("host entries absent");
  const actual: string[] = []; let members = 0;
  const walk = (directory: string, depth = 0): void => { if (depth > 64) fail("host inventory depth");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (++members > 2048 || entry.isSymbolicLink()) fail("host inventory bound or link");
    const file = win32.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, depth + 1); else if (entry.isFile()) actual.push(win32.relative(hostDirectory, file).split("\\").join("/"));
    else fail("host inventory member");
  } };
  walk(hostDirectory);
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...host.files.map(file => file.path), win32.basename(config.hostManifest.path)].sort())) fail("complete host inventory differs");
  add("browser/executable", config.browser);
  const directories = [...new Set([...files.values()].map(file => win32.dirname(file.pin.path)))];
  const codes = new Map<string, PreparedWindowsCodeInstallation>();
  for (const directory of directories) {
    if (mutable.some(root => windowsPathsOverlap(root, directory))) fail("immutable code overlaps mutable storage");
    codes.set(directory, prepareWindowsCodeInstallation({ directory, writableWorkspaceRoots: roots }));
  }
  const storage = new Map(mutable.map(directory => [directory, prepareWindowsReleaseStorage({ directory, writableWorkspaceRoots: roots })]));
  const toolchainDigest = sha(JSON.stringify([...files.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(file =>
    ({ path: file.name, bytes: file.pin.bytes, sha256: file.pin.sha256 }))));
  const contract = { version: 1, kind: "local-application-development", source_paths: ["product/client", "product/server", ".artoo/product/application.json"],
    definition_format: "artoo.application-definition.v1", test_scope: "normal-api-browser-reopen", failure_recovery: "unsupported",
    browser_viewport: { width: 1280, height: 900, device_scale_factor: 1 },
    publication: "unsupported", qualified_for_product: false };
  const capabilities = ApplicationCapabilitiesV1Schema.parse({ ...contract, claim: "configured", config_digest: configuration.sha256,
    contract_digest: sha(JSON.stringify(contract)) });
  const saved: Saved = { config, configuration, roots, files: Object.freeze([...files.values()]), packageFiles: Object.freeze([...packageFiles.values()]),
    codes, storage, capabilities: freeze(capabilities), toolchainDigest, hostEntry: Object.freeze(hostEntry) };
  const token = Object.freeze({}) as PreparedApplicationVerificationProfile; profiles.set(token, saved);
  assertApplicationVerificationProfile(token); return token;
}

/** Every operation boundary checks the original content, metadata and local ACL authority again. */
export function assertApplicationVerificationProfile(token: PreparedApplicationVerificationProfile): void {
  const saved = profiles.get(token); if (!saved) fail("original local profile required");
  for (const [directory, code] of saved.codes) auditWindowsCodeInstallation(code, directory);
  for (const [directory, storage] of saved.storage) auditWindowsReleaseStorage(storage, directory);
  for (const file of saved.files) readApplicationRuntimePin(file.pin);
}
export function readApplicationVerificationProfile(token: PreparedApplicationVerificationProfile): Readonly<Omit<Saved, "codes" | "storage">> {
  assertApplicationVerificationProfile(token);
  const { codes: _codes, storage: _storage, ...value } = profiles.get(token)!; return Object.freeze(value);
}
