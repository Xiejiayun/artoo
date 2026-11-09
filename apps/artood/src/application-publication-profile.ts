import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { ApplicationPublicationCapabilitiesV1Schema, ApplicationPublicationLimitsV1Schema, ApplicationPublicationIdentifierV1Schema,
  canonicalApplicationPublicationContract, type ApplicationPublicationCapabilitiesV1 } from "@artoo/domain";
import { ApplicationRuntimeFilePinSchema, APPLICATION_RUNTIME_PROCESS_LIMITS, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { readApplicationRuntimePin } from "./application-runtime-installation.js";
import { readApplicationVerificationProfile, type PreparedApplicationVerificationProfile } from "./application-verification-profile.js";
import { assertLocallyPreparedVerificationProfile, readPreparedApplicationVerificationProfile, readWindowsVerificationBackend,
  type PreparedVerificationProfile } from "./verification.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { assertWindowsProcessBackend, assertWindowsProcessTargetInputCapability, assertWindowsProcessTargetControlCapability,
  type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { prepareWindowsCodeInstallation, auditWindowsCodeInstallation, type PreparedWindowsCodeInstallation } from "./windows-code-installation.js";
import { prepareWindowsReleaseStorage, auditWindowsReleaseStorage, type PreparedWindowsReleaseStorage } from "./windows-release-storage.js";
import { assertCanonicalWindowsPath, assertNativeWindows, physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";
import { registerApplicationPublicationResources, registerApplicationPublicationVerifierResources,
  assertApplicationPublicationAuditAvailable } from "./application-publication-coordination.js";

const id = ApplicationPublicationIdentifierV1Schema;
const path = z.string().min(1).max(4096), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const pin = ApplicationRuntimeFilePinSchema;
const schema = z.object({ version: z.literal(1), format: z.literal("artoo.application-publication-profile.v1"),
  id, project_id: id, computer_id: id, verification_profile_id: id, verification_profile_digest: digest,
  application_configuration: pin, application_contract_digest: digest, application_toolchain_digest: digest,
  backend: z.object({ directory: path, manifest_sha256: digest }).strict(),
  host_manifest: pin, host_entry: pin,
  deployment_parent: path, selection_parent: path, journal_parent: path,
  origin: z.string().max(128), limits: ApplicationPublicationLimitsV1Schema,
}).strict();
export type ApplicationPublicationConfiguration = z.infer<typeof schema>;
export interface ApplicationPublicationProfileSelection { readonly version: 1; readonly configuration: ApplicationRuntimeFilePin }
export interface ApplicationPublicationProfileOptions {
  readonly nodeId: string; readonly verifier: PreparedVerificationProfile; readonly backend: PreparedWindowsProcessBackend;
}
declare const brand: unique symbol;
export interface PreparedApplicationPublicationProfile { readonly [brand]: true }
interface Saved {
  readonly configuration: ApplicationRuntimeFilePin; readonly config: ApplicationPublicationConfiguration;
  readonly verifier: PreparedVerificationProfile; readonly application: PreparedApplicationVerificationProfile;
  readonly backend: PreparedWindowsProcessBackend; readonly roots: readonly string[];
  readonly nativeManifest: ApplicationRuntimeFilePin; readonly capabilities: ApplicationPublicationCapabilitiesV1;
  readonly codes: ReadonlyMap<string, PreparedWindowsCodeInstallation>;
  readonly storage: ReadonlyMap<string, PreparedWindowsReleaseStorage>;
  failed: boolean;
}
const profiles = new WeakMap<object, Saved>();
const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const samePin = (a: ApplicationRuntimeFilePin, b: ApplicationRuntimeFilePin): boolean =>
  a.path === b.path && a.bytes === b.bytes && a.sha256 === b.sha256;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function fail(reason: string): never { throw Error(`Application publication profile: ${reason}`); }
function rootsOf(values: readonly string[]): readonly string[] {
  if (!values.length || values.length > 128) fail("complete bounded write roots required");
  const roots = values.map(physicalWindowsDirectory).sort();
  if (new Set(roots.map(root => root.toLowerCase())).size !== roots.length) fail("write roots alias");
  return Object.freeze(roots);
}
function assertNative(): void { assertNativeWindows(); if (process.arch !== "x64") fail("native x64 is required"); }
function assertNativeCapabilities(backend: PreparedWindowsProcessBackend, manifest: ApplicationRuntimeFilePin): void {
  assertWindowsProcessBackend(backend); assertWindowsProcessTargetInputCapability(backend); assertWindowsProcessTargetControlCapability(backend);
  const value = z.object({ version: z.literal(1), protocol: z.literal("artoo.windows-job-process.v1"), runtime: z.literal("win-x64"),
    capabilities: z.array(z.string()).max(16).refine(values => new Set(values).size === values.length),
  }).passthrough().parse(json(readApplicationRuntimePin(manifest)));
  if (!value.capabilities.includes("artoo.windows-target-input.v1")
    || !value.capabilities.includes("artoo.windows-target-control.v1")
    || !value.capabilities.includes("artoo.windows-job-member-observation.v1")) fail("original native input and live member observation capabilities required");
  assertWindowsProcessBackend(backend);
}

/** Local protected configuration only. This object cannot authorize a candidate,
 * launch a process, settle a goal or advertise an implemented publication feature. */
export function prepareApplicationPublicationProfile(selection: ApplicationPublicationProfileSelection,
  input: ApplicationPublicationProfileOptions): PreparedApplicationPublicationProfile {
  assertNative();
  if (!input || Object.keys(input).some(key => !["nodeId", "verifier", "backend"].includes(key))) fail("fixed original local inputs required");
  id.parse(input.nodeId);
  const verifier = input.verifier, backend = input.backend;
  assertLocallyPreparedVerificationProfile(verifier);
  const application = readPreparedApplicationVerificationProfile(verifier);
  if (!application || readWindowsVerificationBackend(verifier) !== backend) fail("original application verifier and native backend required");
  const original = readApplicationVerificationProfile(application), roots = rootsOf(original.roots);
  const workspace = physicalWindowsDirectory(verifier.workspace_root);
  if (!roots.some(root => { const relative = win32.relative(root, workspace);
    return !relative || relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative); })) fail("verifier workspace is outside the complete write scope");
  const selected = z.object({ version: z.literal(1), configuration: pin }).strict().parse(selection);
  const configuration = Object.freeze({ ...selected.configuration });
  if (configuration.bytes > 65_536) fail("configuration exceeds bound");
  assertCanonicalWindowsPath(configuration.path);
  const configDirectory = physicalWindowsDirectory(win32.dirname(configuration.path));
  const codes = new Map<string, PreparedWindowsCodeInstallation>();
  codes.set(configDirectory, prepareWindowsCodeInstallation({ directory: configDirectory, writableWorkspaceRoots: roots }));
  const config = freeze(schema.parse(json(readApplicationRuntimePin(configuration))));
  if (config.computer_id !== input.nodeId || config.project_id !== verifier.project_id
    || config.verification_profile_id !== verifier.id || config.verification_profile_digest !== verifier.digest
    || !samePin(config.application_configuration, original.configuration)
    || config.application_contract_digest !== original.capabilities.contract_digest
    || config.application_toolchain_digest !== original.toolchainDigest
    || !samePin(config.host_manifest, original.config.hostManifest) || !samePin(config.host_entry, original.hostEntry))
    fail("configuration differs from the original verifier, application or host pins");
  const url = new URL(config.origin);
  if (config.origin !== original.config.origin || url.origin !== config.origin || url.protocol !== "http:"
    || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) fail("original fixed loopback origin required");
  // application-local-service's absolute transport timer adds 5s; owned/windows-owned-process
  // bounds endInput ACK at 5s and adds 2.5s to cleanupTimeoutMs. The fixed host must
  // use APPLICATION_RUNTIME_PROCESS_LIMITS.cleanupMs (5s), as the existing bootstrap
  // wrapper does. This is only a minimum configured reserve, not a measured runtime
  // or audit-duration guarantee; none of those original deadlines may be renewed.
  const drainOverheadMs = 5_000 + 5_000 + APPLICATION_RUNTIME_PROCESS_LIMITS.cleanupMs + 2_500;
  if (config.limits.normal_drain_reserve_ms < original.config.operation_timeout_ms + drainOverheadMs)
    fail("normal drain reserve cannot cover the original request and cleanup bounds");
  const native = describeWindowsProcessInstallation(backend);
  if (config.backend.directory !== native.directory || config.backend.manifest_sha256 !== native.manifestSha256
    || JSON.stringify(rootsOf(native.writableWorkspaceRoots)) !== JSON.stringify(roots)) fail("original backend or complete write scope changed");
  const mutable = [config.deployment_parent, config.selection_parent, config.journal_parent].map(physicalWindowsDirectory);
  const fixedDirectories = [configDirectory, native.directory, ...original.files.map(file => win32.dirname(file.pin.path))];
  const verificationStorage = [original.config.candidate_parent, original.config.installation_parent, original.config.selection_parent];
  for (let index = 0; index < mutable.length; index++) {
    if ([...roots, ...fixedDirectories, ...verificationStorage, ...mutable.slice(index + 1)]
      .some(directory => windowsPathsOverlap(mutable[index]!, directory))) fail("publication storage overlaps protected code, verification storage or write roots");
  }
  if (verificationStorage.some(directory => windowsPathsOverlap(configDirectory, directory))) fail("publication configuration overlaps verification storage");
  if (!codes.has(native.directory)) codes.set(native.directory,
    prepareWindowsCodeInstallation({ directory: native.directory, writableWorkspaceRoots: roots }));
  const manifestPath = win32.join(native.directory, "manifest.json"), manifestFact = lstatSync(manifestPath, { bigint: true });
  if (!manifestFact.isFile() || manifestFact.isSymbolicLink() || manifestFact.nlink !== 1n
    || manifestFact.size < 1n || manifestFact.size > 4_194_304n) fail("native manifest exceeds its fixed bound or identity");
  const nativeManifest = Object.freeze({ path: manifestPath, bytes: Number(manifestFact.size), sha256: native.manifestSha256 });
  assertNativeCapabilities(backend, nativeManifest);
  const storage = new Map(mutable.map(directory => [directory, prepareWindowsReleaseStorage({ directory, writableWorkspaceRoots: roots })]));
  const contract = { version: 1 as const, kind: "same-computer-local-application-publication" as const,
    claim: "bounded-local-application-publication" as const, origin: "profile-fixed-loopback" as const,
    lifecycle: "original-paired-session" as const, normal_reopen: "once-same-version-url-database" as const,
    failure_recovery: "unsupported" as const, automatic_rotation: "unsupported" as const, limits: config.limits };
  const capabilities = freeze(ApplicationPublicationCapabilitiesV1Schema.parse({ version: 1, contract,
    binding: { version: 1, publication_profile_id: config.id, publication_profile_digest: configuration.sha256,
      publication_contract_digest: sha(canonicalApplicationPublicationContract(contract)), project_id: config.project_id, computer_id: config.computer_id,
      // Canonical Windows spelling comes from the original local profile. Servers
      // compare this digest; they must not normalize drive letters or rebuild it.
      workspace_root_digest: sha(JSON.stringify({ version: 1, workspace_root: workspace })),
      verification_profile_id: verifier.id, verification_profile_digest: verifier.digest,
      application_config_digest: original.configuration.sha256, application_contract_digest: original.capabilities.contract_digest,
      application_toolchain_digest: original.toolchainDigest } }));
  const token = Object.freeze({}) as PreparedApplicationPublicationProfile;
  profiles.set(token, { configuration, config, verifier, application, backend, roots, nativeManifest, capabilities, codes, storage, failed: false });
  registerApplicationPublicationVerifierResources(verifier, verificationStorage);
  registerApplicationPublicationResources(token, { id: config.id, workspace, verifier,
    directories: [...mutable, ...verificationStorage] });
  try { assertApplicationPublicationProfile(token); return token; }
  catch (error) { profiles.delete(token); throw error; }
}

/** Every operation rechecks the original objects and strict local inventories.
 * An integrity failure is terminal for this token; a later disk repair cannot rebaseline it. */
export function assertApplicationPublicationProfile(token: PreparedApplicationPublicationProfile): void {
  const saved = profiles.get(token); if (!saved || saved.failed) fail("original current local publication profile required");
  assertApplicationPublicationAuditAvailable(token);
  try {
    assertNative(); assertLocallyPreparedVerificationProfile(saved.verifier);
    if (readPreparedApplicationVerificationProfile(saved.verifier) !== saved.application
      || readWindowsVerificationBackend(saved.verifier) !== saved.backend) fail("original verifier authority changed");
    const application = readApplicationVerificationProfile(saved.application), native = describeWindowsProcessInstallation(saved.backend);
    if (!samePin(application.configuration, saved.config.application_configuration)
      || application.capabilities.contract_digest !== saved.config.application_contract_digest
      || application.toolchainDigest !== saved.config.application_toolchain_digest
      || application.config.origin !== saved.config.origin || !samePin(application.config.hostManifest, saved.config.host_manifest)
      || !samePin(application.hostEntry, saved.config.host_entry)
      || JSON.stringify(rootsOf(application.roots)) !== JSON.stringify(saved.roots)
      || saved.verifier.id !== saved.config.verification_profile_id || saved.verifier.digest !== saved.config.verification_profile_digest
      || saved.verifier.project_id !== saved.config.project_id
      || sha(JSON.stringify({ version: 1, workspace_root: physicalWindowsDirectory(saved.verifier.workspace_root) })) !== saved.capabilities.binding.workspace_root_digest
      || native.directory !== saved.config.backend.directory || native.manifestSha256 !== saved.config.backend.manifest_sha256
      || JSON.stringify(rootsOf(native.writableWorkspaceRoots)) !== JSON.stringify(saved.roots)) fail("original configuration binding changed");
    for (const [directory, code] of saved.codes) auditWindowsCodeInstallation(code, directory);
    for (const [directory, storage] of saved.storage) auditWindowsReleaseStorage(storage, directory);
    readApplicationRuntimePin(saved.configuration); assertNativeCapabilities(saved.backend, saved.nativeManifest);
    // Reads and ACL collectors can race file replacement. These are the same
    // captured authorities, never fresh preparations from the current disk.
    for (const [directory, code] of saved.codes) auditWindowsCodeInstallation(code, directory);
    readApplicationVerificationProfile(saved.application);
  } catch (error) { saved.failed = true; throw error; }
}

export function readApplicationPublicationProfile(token: PreparedApplicationPublicationProfile): Readonly<Omit<Saved, "codes" | "storage" | "failed">> {
  assertApplicationPublicationProfile(token);
  const { codes: _codes, storage: _storage, failed: _failed, ...value } = profiles.get(token)!;
  return Object.freeze(value);
}
