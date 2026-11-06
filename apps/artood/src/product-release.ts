import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { ProductReleaseRequestSchema, ProductReleaseReceiptSchema, ProductReleaseHealthReportSchema,
  ReleaseCapabilitiesV1Schema, ReleaseAcceptanceBindingV1Schema, RunVerificationPayloadSchema, AcceptedProductInputsSchema,
  ImportedValidationReleaseOriginV1Schema, ImportedRecoveryReleaseOriginV1Schema, ImportedCleanReleaseOriginV1Schema,
  CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT, CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST,
  canonicalReleaseCapabilityContract, canonicalReleaseAcceptanceBinding, canonicalReleaseJson, canonicalProductReleaseRequest,
  productSourceRecoveryCheckpointDigestV1,
  type ReleaseCapabilitiesV1, type ReleaseAcceptanceBindingV1, type ContextPack, type ProductReleaseRequest,
  type ProductReleaseReceipt, type ProductReleaseHealthReport, type ProductReleaseRetrySourceV1, type RunVerificationPayload, type RunStartPayload } from "@artoo/domain";
import { subjectManifest, verificationSupported, readVerificationCapabilities, readWindowsVerificationBackend, measureReleaseAcceptancePlan,
  type PreparedVerificationProfile, type VerificationProfile } from "./verification.js";
import { assertAcceptedProductInputs, readProductFile } from "./product-stage.js";
import { assertReleaseCapabilityContext, type ReleaseCapabilityReader } from "./release-capability-authority.js";
import { assertWindowsReleaseStorage, auditWindowsReleaseStorage, type PreparedWindowsReleaseStorage } from "./windows-release-storage.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { fetchReleaseHealthGet } from "./release-health-transport.js";
import { readPreparedImportedValidationRelease, type PreparedImportedValidationRelease } from "./product-source-runtime.js";

import { readPreparedRecoveryValidationRelease, readWindowsSourceRecoveryPublicationFence,
  type PreparedRecoveryValidationRelease, type PreparedWindowsSourceRecoveryRuntime } from "./windows-source-recovery.js";
import { readPreparedCleanValidationRelease, readWindowsCleanValidationPublicationFence,
  type PreparedCleanValidationRelease, type PreparedWindowsCleanValidationRuntime } from "./windows-clean-validation-runtime.js";

export const PRODUCT_RELEASE_FEATURE = "product-release.static.v1";
export const PRODUCT_RELEASE_HEALTH_FEATURE = "product-release.health.v1";
export const PRODUCT_RELEASE_ACCEPTANCE_FEATURE = "product-release.acceptance.v1";
function parseLocallySupportedReleaseRequest(input: unknown): ProductReleaseRequest {
  const request = ProductReleaseRequestSchema.parse(input);
  return request;
}
/** Administrator-owned target. No shell, credentials, command text or remote paths are accepted. */
export interface ReleaseProfile {
  id: string;
  project_id: string;
  verification_profile_id: string;
  storage_root: string;
  output_path: string;
  public_url: string;
  listen_host: string;
  listen_port: number;
  health_checks: { path: string; expect_text?: string }[];
  health_timeout_ms: number;
  /** Opt-in, administrator-owned post-publication recovery policy. */
  monitoring?: { interval_ms: number; failure_threshold: number };
  /** Opt-in to the fixed, node-measured publication criterion; never arbitrary deployment claims. */
  criterion_acceptance?: { version: 1 };
}
export interface PreparedReleaseProfile extends Readonly<ReleaseProfile> {
  readonly digest: string;
  readonly verifier: PreparedVerificationProfile;
}
interface PreparedReleaseAuthority {
  capabilities?: ReleaseCapabilitiesV1;
  workspace: { dev: number; ino: number };
  storage: { dev: number; ino: number };
  windows?: { storage: PreparedWindowsReleaseStorage; backend: PreparedWindowsProcessBackend };
}
export interface ReleasePreparationOptions {
  /** Local opaque authorities keyed by exact physical storage root, never remote profile metadata. */
  windowsStorage?: ReadonlyMap<string, PreparedWindowsReleaseStorage>;
  writableRoots?: readonly string[];
}
const preparedReleaseProfiles = new WeakMap<PreparedReleaseProfile, PreparedReleaseAuthority>();
// Node-local loader provenance must not change serialized profiles, digests or remote contracts.
const releaseConfigurationFiles = new WeakMap<ReleaseProfile, string>();
const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inside = (path: string, root: string): boolean => {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};
const key = (value: string) => sha(value).slice(7);
function fail(message: string): never { throw new Error(`Product release: ${message}`); }
function immutableReleaseValue<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) immutableReleaseValue(child); Object.freeze(value); }
  return value;
}
function canonicalRelative(value: string): boolean {
  return !!value && value.length <= 1024 && !/[\\:\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}
function targetFile(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) fail("health path must be an absolute URL path without query or fragment");
  const decoded = decodeURIComponent(path).slice(1);
  const file = !decoded || decoded.endsWith("/") ? `${decoded}index.html` : decoded;
  if (!canonicalRelative(file) || file.split("/").some((part) => part.startsWith("."))) fail("invalid public file path");
  return file;
}
function physicalTarget(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) fail("path has no existing ancestor");
    suffix.unshift(basename(existing)); existing = parent;
  }
  return resolve(realpathSync.native(existing), ...suffix);
}
function assertStorage(profile: PreparedReleaseProfile): void {
  const windows = preparedReleaseProfiles.get(profile)?.windows;
  if (windows) assertWindowsReleaseStorage(windows.storage, profile.storage_root);
  const stat = lstatSync(profile.storage_root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(profile.storage_root) !== profile.storage_root) fail("storage directory identity changed");
}
/** Platform support belongs to the exact locally prepared profile and its private authorities. */
export function releaseProfileExecutionSupported(profile: PreparedReleaseProfile): boolean {
  const authority = preparedReleaseProfiles.get(profile);
  if (!authority) fail("release execution requires a locally prepared profile");
  if (verificationSupported()) return true;
  if (process.platform !== "win32" || !authority.windows) return false;
  assertWindowsReleaseStorage(authority.windows.storage, profile.storage_root);
  if (readWindowsVerificationBackend(profile.verifier) !== authority.windows.backend) fail("Windows release verifier backend changed");
  return true;
}
/** Repeated reads keep physical directories and protected verifier inputs bound to preparation. */
export function readReleaseCapabilities(profile: PreparedReleaseProfile): ReleaseCapabilitiesV1 | undefined {
  const authority = preparedReleaseProfiles.get(profile);
  if (!authority) fail("release capabilities require a locally prepared profile");
  if (!authority.capabilities) return undefined;
  if (!releaseProfileExecutionSupported(profile)) fail("release acceptance requires a locally qualified execution and storage profile");
  assertStorage(profile);
  for (const [path, saved] of [[profile.storage_root, authority.storage], [profile.verifier.workspace_root, authority.workspace]] as const) {
    const now = lstatSync(path);
    if (!now.isDirectory() || now.isSymbolicLink() || realpathSync.native(path) !== path || now.dev !== saved.dev || now.ino !== saved.ino) {
      fail("release capability physical directory identity changed");
    }
  }
  const verifier = readVerificationCapabilities(profile.verifier);
  if (!verifier || verifier.profile_digest !== authority.capabilities.binding.verification_profile_digest
    || verifier.measurement_plan_policy?.version !== 2) fail("release capability verifier binding changed");
  return authority.capabilities;
}
/** Return the current checked value with its reader in one synchronous preparation.
 * Every later read performs the complete audit; the initial value is never cached for a future read. */
export function prepareReleaseCapabilityReader(profile: PreparedReleaseProfile): Readonly<{
  capabilities: ReleaseCapabilitiesV1; readCapabilities: ReleaseCapabilityReader;
}> {
  const capabilities = readReleaseCapabilities(profile);
  if (!capabilities) fail("release profile does not opt in to criterion acceptance");
  return Object.freeze({ capabilities, readCapabilities: () => readReleaseCapabilities(profile)! });
}
export function createReleaseCapabilityReader(profile: PreparedReleaseProfile): ReleaseCapabilityReader {
  return prepareReleaseCapabilityReader(profile).readCapabilities;
}
function checkedPath(root: string, path: string): string {
  if (!canonicalRelative(path)) fail("invalid artifact path");
  let absolute = root;
  for (const part of path.split("/")) {
    absolute = join(absolute, part);
    if (lstatSync(absolute).isSymbolicLink()) fail("artifact contains a symbolic link");
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.nlink !== 1) fail("artifact is not an unlinked regular file");
  return absolute;
}
/** File flush + rename, plus POSIX directory fsync. Windows qualification covers process restart, not power loss. */
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  if (process.platform !== "win32") {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function sealDirectories(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) sealDirectories(join(path, entry.name));
  chmodSync(path, 0o500); syncDirectory(path);
}
function jsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) fail("invalid state file");
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function prepareReleaseProfiles(raw: readonly ReleaseProfile[] | undefined,
  verifiers: readonly PreparedVerificationProfile[], options: ReleasePreparationOptions = {}): readonly PreparedReleaseProfile[] {
  if (!options || typeof options !== "object" || Object.keys(options).some(name => name !== "windowsStorage" && name !== "writableRoots")
    || options.windowsStorage !== undefined && !(options.windowsStorage instanceof Map)) fail("invalid local release preparation options");
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || raw.length > 64) fail("invalid profile list");
  const ids = new Set<string>();
  const result = raw.map((entry) => {
    if (!entry || !/^[\w.-]{1,128}$/.test(entry.id) || ids.has(entry.id)) fail("invalid or duplicate profile ID");
    ids.add(entry.id);
    const verifier = verifiers.find((item) => item.id === entry.verification_profile_id && item.project_id === entry.project_id);
    if (!verifier) fail("release requires an exact local project/verifier binding");
    if (preparedReleaseProfiles.has(entry as PreparedReleaseProfile)) {
      const prepared = entry as PreparedReleaseProfile;
      if (verifiers.some(item => inside(prepared.storage_root, item.workspace_root) || inside(item.workspace_root, prepared.storage_root))) {
        fail("storage must be outside all coding workspaces");
      }
      if (prepared.verifier === verifier) {
        const existing = preparedReleaseProfiles.get(prepared)!;
        const supplied = options.windowsStorage?.get(prepared.storage_root);
        if (supplied !== undefined && supplied !== existing.windows?.storage) fail("prepared release storage authority changed");
        assertStorage(prepared); readReleaseCapabilities(prepared); return prepared;
      }
      if (prepared.criterion_acceptance) fail("prepared release verifier identity changed");
    }
    if (entry.criterion_acceptance !== undefined) {
      if (!entry.criterion_acceptance || entry.criterion_acceptance.version !== 1
        || Object.keys(entry.criterion_acceptance).some(name => name !== "version")) fail("invalid criterion acceptance policy");
      if (Object.keys(entry).some(name => !["id", "project_id", "verification_profile_id", "storage_root", "output_path", "public_url",
        "listen_host", "listen_port", "health_checks", "health_timeout_ms", "monitoring", "criterion_acceptance"].includes(name))) fail("unknown criterion acceptance profile field");
      if ((!verificationSupported() && !(process.platform === "win32" && options.windowsStorage?.get(realpathSync.native(entry.storage_root))
        && readWindowsVerificationBackend(verifier))) || verifier.measurement_plan_policy?.version !== 2 || !readVerificationCapabilities(verifier)) {
        fail("criterion acceptance requires a supported worker and locally prepared v2 measurement-plan verifier");
      }
    }
    if (!isAbsolute(entry.storage_root) || !lstatSync(entry.storage_root).isDirectory() || lstatSync(entry.storage_root).isSymbolicLink()) fail("storage root must be an existing absolute directory");
    const storage = realpathSync.native(entry.storage_root);
    const windowsStorage = options.windowsStorage?.get(storage);
    let windows: PreparedReleaseAuthority["windows"];
    if (windowsStorage !== undefined) {
      if (process.platform !== "win32") fail("Windows release storage requires native Windows");
      assertWindowsReleaseStorage(windowsStorage, storage);
      const backend = readWindowsVerificationBackend(verifier);
      if (!backend) fail("Windows release storage requires the exact verifier's locally prepared native backend");
      windows = { storage: windowsStorage, backend };
    }
    if (verifiers.some((item) => inside(storage, item.workspace_root) || inside(item.workspace_root, storage))) fail("storage must be outside all coding workspaces");
    if (!canonicalRelative(entry.output_path) || !verifier.subject_paths.some((path) => path === entry.output_path || entry.output_path.startsWith(`${path}/`))) fail("output directory must be covered by verified subject paths");
    const url = new URL(entry.public_url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("public URL must be an HTTP origin without credentials");
    if (typeof entry.listen_host !== "string" || !entry.listen_host || /[\s\u0000]/u.test(entry.listen_host)
      || !Number.isInteger(entry.listen_port) || entry.listen_port < 1 || entry.listen_port > 65535) fail("invalid listener binding");
    if (!Array.isArray(entry.health_checks) || !entry.health_checks.length || entry.health_checks.length > 32) fail("one to 32 health checks are required");
    const checks = entry.health_checks.map((check: ReleaseProfile["health_checks"][number]) => {
      if (entry.criterion_acceptance && Object.keys(check).some(name => name !== "path" && name !== "expect_text")) fail("unknown criterion acceptance health field");
      targetFile(check.path);
      if (check.expect_text !== undefined && (typeof check.expect_text !== "string" || check.expect_text.length > 4096)) fail("invalid health assertion");
      return Object.freeze({ path: check.path, ...(check.expect_text === undefined ? {} : { expect_text: check.expect_text }) });
    });
    if (new Set(checks.map((check: ReleaseProfile["health_checks"][number]) => check.path)).size !== checks.length) fail("duplicate health paths");
    if (!Number.isInteger(entry.health_timeout_ms) || entry.health_timeout_ms < 1 || entry.health_timeout_ms > 60000) fail("invalid health timeout");
    if (entry.monitoring !== undefined && (!entry.monitoring || typeof entry.monitoring !== "object"
      || !Number.isInteger(entry.monitoring.interval_ms) || entry.monitoring.interval_ms < 1000 || entry.monitoring.interval_ms > 3600000
      || !Number.isInteger(entry.monitoring.failure_threshold) || entry.monitoring.failure_threshold < 1 || entry.monitoring.failure_threshold > 10
      || Object.keys(entry.monitoring).some((name) => name !== "interval_ms" && name !== "failure_threshold"))) fail("invalid monitoring policy");
    const value: ReleaseProfile = { id: entry.id, project_id: entry.project_id, verification_profile_id: entry.verification_profile_id,
      storage_root: storage, output_path: entry.output_path, public_url: url.origin, listen_host: entry.listen_host, listen_port: entry.listen_port,
      health_checks: Object.freeze(checks) as unknown as ReleaseProfile["health_checks"], health_timeout_ms: entry.health_timeout_ms,
      ...(entry.monitoring === undefined ? {} : { monitoring: Object.freeze({ interval_ms: entry.monitoring.interval_ms,
        failure_threshold: entry.monitoring.failure_threshold }) }),
      ...(entry.criterion_acceptance === undefined ? {} : { criterion_acceptance: Object.freeze({ version: 1 as const }) }) };
    const profile = Object.freeze({ ...value, verifier, digest: sha(JSON.stringify(value)) });
    let capabilities: ReleaseCapabilitiesV1 | undefined;
    if (value.criterion_acceptance) {
      const contract: ReleaseCapabilitiesV1["contract"] = {
        version: 1, kind: "configured-static-release", claim: "configured", execution_phase: "after-stage-acceptance",
        endpoint_scope: "configured-origin", measurement_scope: "node-http-point-in-time", lifecycle: "while-configured-node-service-running",
        health_checks: checks.map((check: ReleaseProfile["health_checks"][number]) => ({ path: check.path, expected_status: 200, body: "immutable-artifact-equality", identity: "release-id-and-artifact-digest-headers" })),
        criterion: { id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement: CONFIGURED_STATIC_PUBLICATION_STATEMENT,
          statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST },
      };
      capabilities = ReleaseCapabilitiesV1Schema.parse({ version: 1, contract,
        binding: { version: 1, release_profile_id: profile.id, release_profile_digest: profile.digest,
          contract_digest: sha(canonicalReleaseCapabilityContract(contract)), project_id: profile.project_id, workspace_root: verifier.workspace_root,
          verification_profile_id: verifier.id, verification_profile_digest: verifier.digest } });
      const freeze = (value: object): void => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); Object.freeze(value); };
      freeze(capabilities);
    }
    const workspaceStat = lstatSync(verifier.workspace_root), storageStat = lstatSync(storage);
    preparedReleaseProfiles.set(profile, { capabilities, workspace: { dev: workspaceStat.dev, ino: workspaceStat.ino },
      storage: { dev: storageStat.dev, ino: storageStat.ino }, ...(windows ? { windows } : {}) });
    const configurationFile = releaseConfigurationFiles.get(entry);
    if (configurationFile) releaseConfigurationFiles.set(profile, configurationFile);
    return profile;
  });
  for (let index = 0; index < result.length; index++) {
    if (result.slice(index + 1).some((other) => inside(other.storage_root, result[index]!.storage_root) || inside(result[index]!.storage_root, other.storage_root)
      || (other.listen_host === result[index]!.listen_host && other.listen_port === result[index]!.listen_port))) fail("release profiles must use separate storage and listeners");
  }
  if (options.writableRoots !== undefined) for (const root of physicalReleaseWritableRoots(options.writableRoots)) {
    for (const profile of result) assertReleaseAssetBoundary(profile, root);
  }
  return Object.freeze(result);
}

function physicalReleaseWritableRoots(roots: readonly string[]): readonly string[] {
  if (!Array.isArray(roots)) fail("writable roots must be an array");
  return roots.map(root => {
    if (typeof root !== "string" || !root || !isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root)) fail("writable roots must be absolute local paths");
    return physicalTarget(root);
  });
}
function assertReleaseAssetBoundary(profile: PreparedReleaseProfile, target: string): void {
  const configurationFile = releaseConfigurationFiles.get(profile);
  if (configurationFile && (inside(configurationFile, target) || inside(target, configurationFile))) {
    fail("coding workspace overlaps protected release configuration");
  }
  if (inside(target, profile.storage_root) || inside(profile.storage_root, target)) fail("coding workspace overlaps protected release storage");
}
export function loadReleaseProfilesFile(path: string, verifiers: readonly VerificationProfile[] = [], writableRoots?: readonly string[]): ReleaseProfile[] {
  if (!isAbsolute(path)) fail("configuration path must be absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail("invalid configuration file");
  const physical = realpathSync.native(path);
  if (verifiers.some((verifier) => inside(physical, realpathSync.native(verifier.workspace_root)))) fail("release configuration must be outside every coding workspace");
  if (writableRoots !== undefined && physicalReleaseWritableRoots(writableRoots).some(root => inside(physical, root))) {
    fail("release configuration must be outside every writable root");
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) fail("configuration must be a JSON array");
  for (const profile of parsed) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) fail("configuration profiles must be objects");
    releaseConfigurationFiles.set(profile as ReleaseProfile, physical);
  }
  return parsed as ReleaseProfile[];
}

const AcceptanceContextSchema = z.object({ version: z.literal(1), goal_id: z.string().min(1),
  stage: z.literal("validation"), plan: z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict(),
  accepted_inputs: AcceptedProductInputsSchema, binding: ReleaseAcceptanceBindingV1Schema,
}).strict();
const AttestationSchema = z.object({ run_id: z.string().min(1), project_id: z.string().min(1), workspace_root: z.string().min(1),
  evidence: RunVerificationPayloadSchema, acceptance: AcceptanceContextSchema.optional(),
  imported_validation: ImportedValidationReleaseOriginV1Schema.optional(),
  imported_recovery: ImportedRecoveryReleaseOriginV1Schema.optional(),
  imported_clean: ImportedCleanReleaseOriginV1Schema.optional(),
}).strict();
type Attestation = z.infer<typeof AttestationSchema>;
/** This argument is created by the node after the producer exits; it is never adapter output. */
export interface LocalReleaseVerificationContext { context: ContextPack; readCapabilities: ReleaseCapabilityReader; importedValidation?: PreparedImportedValidationRelease; importedRecovery?: PreparedRecoveryValidationRelease; importedClean?: PreparedCleanValidationRelease }
interface Pointer { release_id: string; artifact_digest: string; release_profile_digest: string }
interface Operation {
  request: ProductReleaseRequest;
  previous: Pointer | null;
  phase: "prepared" | "activated" | "rolling_back" | "disabling" | "terminal";
  /** Persisted before restoring the pointer, so a crash cannot retry a known failed candidate. */
  rollback_receipt?: ProductReleaseReceipt;
  receipt?: ProductReleaseReceipt;
}
interface ArtifactManifest { digest: string; files: { path: string; checksum: string; size: number }[]; directories: string[] }
interface MonitorRecord {
  version: 1;
  phase: "monitoring" | "recovering" | "disabling" | "terminal";
  report: ProductReleaseHealthReport;
  recovery?: { previous: Pointer | null; checks: ProductReleaseReceipt["health_checks"] };
}
export interface ProductReleaseExecutorOptions {
  /** A failed delivery leaves the latest report on disk for reconnect replay. */
  onHealthReport?: (report: ProductReleaseHealthReport) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Original authenticated connection identity. A reconnect supplies another object; absence disables retry minting. */
  retrySession?: () => object | undefined;
}
export interface ProductReleaseHealthFault { profile_id: string; failed_at: string; reason: string }
declare const releaseRetryBrand: unique symbol;
export interface PreparedProductReleaseRetry { readonly [releaseRetryBrand]: true }
const preparedReleaseRetries = new WeakMap<PreparedProductReleaseRetry, Readonly<{ request: ProductReleaseRequest;
  previousRequest: ProductReleaseRequest; previousReceipt: ProductReleaseReceipt; assertCurrent: () => void }>>();
/** Reading wire projections or protected history can never manufacture an original retry permit. */
export function readPreparedProductReleaseRetry(permit: PreparedProductReleaseRetry, request?: ProductReleaseRequest) {
  const saved = preparedReleaseRetries.get(permit);
  if (!saved || request && canonicalProductReleaseRequest(request) !== canonicalProductReleaseRequest(saved.request)) fail("original exact publication retry permit is required");
  saved.assertCurrent(); return saved;
}

/** Owns release side effects separately from coding runtimes and keeps durable request identities. */
export function createProductReleaseExecutor(profiles: readonly PreparedReleaseProfile[], options: ProductReleaseExecutorOptions = {}) {
  const servers = new Map<string, Server>();
  const starts = new Map<string, Promise<void>>();
  const queues = new Map<string, Promise<unknown>>();
  const controllers = new Map<string, AbortController>();
  const activeReleases = new Map<string, { request: ProductReleaseRequest; pending: Promise<ProductReleaseReceipt> }>();
  const monitorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const monitorControllers = new Map<string, AbortController>();
  const monitorPending = new Map<string, Promise<void>>();
  const monitorFaults = new Map<string, ProductReleaseHealthFault>();
  const initializedProfiles = new Set<PreparedReleaseProfile>();
  type RecoveryFence = { runtime: PreparedWindowsSourceRecoveryRuntime;
    original: ReturnType<typeof readWindowsSourceRecoveryPublicationFence>;
    files: ReadonlyMap<string, string>; operationIds: ReadonlySet<string>; healthPaths: ReadonlySet<string>;
    marker: Readonly<{ version: 1; recovery_id: string; checkpoint_digest: string; inventory_digest: string; previous_pointer: Pointer | null }>;
    opened: boolean };
  const recoveryFences = new Map<PreparedReleaseProfile, RecoveryFence>();
  const recoveryValidationPublications = new Map<string, PreparedRecoveryValidationRelease>();
  const recoveryValidationRuns = new Map<string, { start: RunStartPayload; evidence: RunVerificationPayload; origin: NonNullable<ProductReleaseRequest["imported_recovery"]> }>();
  type CleanFence = { runtime: PreparedWindowsCleanValidationRuntime;
    original: ReturnType<typeof readWindowsCleanValidationPublicationFence>;
    files: ReadonlyMap<string, string>; operationIds: ReadonlySet<string>; healthPaths: ReadonlySet<string>;
    missingOperationIds: ReadonlySet<string>;
    marker: Readonly<{ version: 1; clean_generation_id: string; lineage_id: string; inventory_digest: string; previous_pointer: Pointer | null }>;
    opened: boolean };
  const cleanFences = new Map<PreparedReleaseProfile, CleanFence>();
  const cleanValidationPublications = new Map<string, PreparedCleanValidationRelease>();
  const cleanValidationRuns = new Map<string, { start: RunStartPayload; evidence: RunVerificationPayload; origin: NonNullable<ProductReleaseRequest["imported_clean"]> }>();
  const importedValidationPublications = new Map<string, PreparedImportedValidationRelease>();
  const importedValidationRuns = new Map<string, { start: RunStartPayload; evidence: RunVerificationPayload; origin: NonNullable<ProductReleaseRequest["imported_validation"]> }>();
  const closedListeners = new WeakSet<Server>();
  type Attempt = { request: ProductReleaseRequest; session?: object; original: boolean; settled: boolean;
    receipt?: ProductReleaseReceipt; retry?: PreparedProductReleaseRetry; running: boolean; healthSettled: boolean; recoverySettled: boolean; previous?: Pointer | null };
  type RetrySource = { attempt: Attempt; profile: PreparedReleaseProfile; receipt: ProductReleaseReceipt;
    recovery: ProductReleaseRetrySourceV1["recovery"]; listener: Server; attestationDigest: string; successor?: PreparedProductReleaseRetry };
  const attempts = new Map<string, Attempt>(), retrySources = new Map<string, RetrySource>(), retryHeads = new Map<string, string>();
  const issuedRetryPermits = new WeakSet<PreparedProductReleaseRetry>();
  const settledHealth = new WeakSet<ProductReleaseReceipt["health_checks"]>();
  const retryDisabledProfiles = new Set<string>();
  const releaseRoot = (request: ProductReleaseRequest) => request.retry?.root_release_id ?? request.release_id;
  const generation = (request: ProductReleaseRequest) => request.retry?.generation ?? 0;
  const requestDigest = (request: ProductReleaseRequest) => sha(canonicalProductReleaseRequest(request));
  const receiptDigest = (receipt: ProductReleaseReceipt) => sha(canonicalReleaseJson(receipt));
  let stopping = false;
  let stopped = false;
  function assertRetrySession(attempt: Attempt): void {
    if (stopping || stopped || !attempt.session || options.retrySession?.() !== attempt.session) fail("publication retry requires the original live authenticated session");
  }
  function assertRetrySource(source: RetrySource, requireRecovery: boolean): void {
    const { attempt, profile, receipt } = source; assertRetrySession(attempt); auditStorage(profile); assertRequestProfile(profile, attempt.request);
    if (!attempt.original || !attempt.settled || attempt.running || attempt.receipt !== receipt || !receipt.retry_source
      || receipt.outcome === "published" || monitorFaults.has(profile.id)) fail("original settled failed publication is required");
    const operation = readOperation(profile, statePath(profile, attempt.request.release_id));
    if (operation?.phase !== "terminal" || canonicalReleaseJson(operation.receipt) !== canonicalReleaseJson(receipt)) fail("original publication failure history changed");
    if (subjectManifest(profile.verifier).digest !== attempt.request.subject_digest) fail("publication retry source changed");
    const attestation = jsonFile<Attestation>(join(profile.storage_root, "attestations", `${key(attempt.request.run_id)}.json`));
    if (!attestation || sha(canonicalReleaseJson(attestation)) !== source.attestationDigest
      || attestation.evidence.subject_digest !== attempt.request.subject_digest) fail("publication retry attestation is unavailable or changed");
    if (attestation.acceptance) assertPinnedAcceptance(profile.verifier.workspace_root, attestation.acceptance);
    if (requireRecovery) {
      const pointer = jsonFile<Pointer | null>(pointerPath(profile)) ?? null;
      if (source.recovery.kind === "listener-closed") {
        if (pointer !== null || !closedListeners.has(source.listener) || source.listener.listening || servers.has(profile.id) || starts.has(profile.id)) fail("failed publication listener closure is no longer current");
      } else {
        const expected = { release_id: source.recovery.active_release_id, artifact_digest: source.recovery.active_artifact_digest, release_profile_digest: profile.digest };
        if (!isDeepStrictEqual(pointer, expected) || servers.get(profile.id) !== source.listener || !source.listener.listening || closedListeners.has(source.listener)) fail("original healthy rollback listener or pointer changed");
        requirePublishedPointer(profile, pointer);
      }
    }
  }
  function prepareRetry(input: ProductReleaseRequest): PreparedProductReleaseRetry {
    const request = parseLocallySupportedReleaseRequest(input), retry = request.retry;
    if (!retry) fail("publication retry lineage is required");
    const source = retrySources.get(retry.source_id); if (!source) fail("original live publication retry source is unavailable");
    assertRetrySource(source, source.successor === undefined);
    const previous = source.attempt.request, { release_id: _oldId, retry: _oldRetry, ...oldFields } = previous;
    const { release_id: _newId, retry: _newRetry, ...newFields } = request;
    if (!isDeepStrictEqual(oldFields, newFields) || request.release_id === previous.release_id || retry.previous_release_id !== previous.release_id
      || retry.root_release_id !== releaseRoot(previous) || retry.generation !== generation(previous) + 1
      || retry.previous_request_digest !== requestDigest(previous) || retry.previous_receipt_digest !== receiptDigest(source.receipt)
      || retry.authorization.goal_id !== previous.goal_id || retry.authorization.attempt_index <= (previous.retry?.authorization.attempt_index ?? -1)
      || previous.retry && (retry.authorization.event_id === previous.retry.authorization.event_id
        || retry.authorization.actor_user_id !== previous.retry.authorization.actor_user_id)) fail("publication retry differs from its exact immutable predecessor");
    if (source.successor) { readPreparedProductReleaseRetry(source.successor, request); return source.successor; }
    if (retryHeads.get(retry.root_release_id) !== previous.release_id || attempts.has(request.release_id)) fail("publication retry predecessor is no longer the latest attempt");
    const attestation = AttestationSchema.parse(jsonFile<Attestation>(join(source.profile.storage_root, "attestations", `${key(previous.run_id)}.json`)));
    assertAcceptance(source.profile, previous, attestation);
    const permit = Object.freeze({}) as PreparedProductReleaseRetry;
    const exactRequest = immutableReleaseValue(structuredClone(request));
    // Readers receive this record, so its request and current-owner check must not be replaceable.
    preparedReleaseRetries.set(permit, Object.freeze({ request: exactRequest, previousRequest: previous, previousReceipt: source.receipt, assertCurrent: () => {
      assertRetrySource(source, !attempts.get(request.release_id)?.running && !attempts.get(request.release_id)?.settled);
      if (source.successor !== permit || retryHeads.get(retry.root_release_id) !== request.release_id) fail("publication retry permit is no longer the current successor");
    } }));
    issuedRetryPermits.add(permit); source.successor = permit; retryHeads.set(retry.root_release_id, request.release_id); return permit;
  }
  function writeState(profile: PreparedReleaseProfile, path: string, value: unknown): void {
    // A concurrent cancellation/history/attestation audit can fail while health awaits I/O.
    // Aborting that health request must not let its catch path write rollback state through a failed boundary.
    if (monitorFaults.has(profile.id)) fail("a local release fault prevents further state writes until restart");
    assertStorage(profile);
    atomicJson(path, value);
  }
  function auditStorage(profile: PreparedReleaseProfile): void {
    const authority = preparedReleaseProfiles.get(profile);
    if (verificationSupported() || process.platform !== "win32") return;
    try {
      if (!authority?.windows) fail("Windows release requires locally qualified protected storage");
      auditWindowsReleaseStorage(authority.windows.storage, profile.storage_root);
    } catch (error) {
      // Storage failure is a local executor fault, not a fabricated HTTP health observation.
      const reason = `Release profile ${profile.id}: storage admission failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
      monitorFaults.set(profile.id, { profile_id: profile.id, failed_at: new Date().toISOString(), reason });
      const server = servers.get(profile.id); server?.close(); server?.closeAllConnections(); servers.delete(profile.id);
      monitorControllers.get(profile.id)?.abort(new Error(reason));
      for (const [id, active] of activeReleases) if (active.request.release_profile_id === profile.id) controllers.get(id)?.abort(new Error(reason));
      throw new Error(reason, { cause: error });
    }
  }
  function capabilityReader(profile: PreparedReleaseProfile): ReleaseCapabilityReader {
    const read = createReleaseCapabilityReader(profile);
    return () => { if (stopping || stopped) fail("release capability lifetime has ended"); return read(); };
  }
  const statePath = (profile: PreparedReleaseProfile, requestId: string) => join(profile.storage_root, "operations", `${key(requestId)}.json`);
  const artifactRoot = (profile: PreparedReleaseProfile, digest: string) => join(profile.storage_root, "artifacts", digest.slice(7));
  const pointerPath = (profile: PreparedReleaseProfile) => join(profile.storage_root, "current.json");
  const monitorPath = (profile: PreparedReleaseProfile, releaseId: string) => join(profile.storage_root, "health", `${key(releaseId)}.json`);
  const recoveryFencePath = (profile: PreparedReleaseProfile) => join(profile.storage_root, "source-recovery.json");
  const cleanFencePath = (profile: PreparedReleaseProfile) => join(profile.storage_root, "source-clean-restart.json");
  function assertRecoveryFence(profile: PreparedReleaseProfile, inspectHistory = true): RecoveryFence | undefined {
    const fence = recoveryFences.get(profile), marker = jsonFile<RecoveryFence["marker"]>(recoveryFencePath(profile));
    // This durable record is only a fence. It never restores a guardian, verifier, review or receipt owner.
    if (!fence) { if (marker !== undefined) fail("source recovery requires its original live checkpoint owner"); return undefined; }
    fence.original.assertCurrent();
    if (!isDeepStrictEqual(marker, fence.marker)) fail("source recovery isolation record changed");
    for (const [path, digest] of inspectHistory ? fence.files : []) {
      if (jsonFile<unknown>(path) === undefined || sha(readFileSync(path)) !== digest) fail("isolated publication history changed");
    }
    return fence;
  }
  function assertRecoveryRequest(profile: PreparedReleaseProfile, request: ProductReleaseRequest): RecoveryFence | undefined {
    const fence = assertRecoveryFence(profile);
    if (fence && (fence.operationIds.has(request.release_id) || !request.imported_recovery || request.imported_clean
      || request.imported_recovery.recovery_id !== fence.marker.recovery_id
      || request.imported_recovery.checkpoint_digest !== fence.marker.checkpoint_digest))
      fail("isolated old publication cannot execute or replay in a recovered epoch");
    if (request.imported_recovery && !fence) fail("recovery publication requires an installed original checkpoint fence");
    return fence;
  }
  function fenceRecoveredWorkspace(runtime: PreparedWindowsSourceRecoveryRuntime): void {
    const original = readWindowsSourceRecoveryPublicationFence(runtime);
    const selected = profiles.filter(profile => profile.project_id === original.projectId && profile.verifier.workspace_root === original.workspaceRoot);
    for (const profile of selected) {
      const existing = recoveryFences.get(profile);
      if (existing) { if (existing.runtime !== runtime) fail("recovery publication fence owner is immutable"); assertRecoveryFence(profile); continue; }
      if (servers.has(profile.id) || starts.has(profile.id) || queues.has(profile.id) || monitorPending.has(profile.id)
        || [...attempts.values()].some(attempt => attempt.request.release_profile_id === profile.id))
        fail("recovery publication fence must precede all publisher execution");
      auditStorage(profile); initialize(profile); original.assertCurrent();
      if (existsSync(recoveryFencePath(profile))) fail("another recovery epoch already fenced this publisher; original owner is required");
      if (cleanFences.has(profile) || existsSync(cleanFencePath(profile))) fail("a clean generation already owns this publisher");
      const files = new Map<string, string>(), operationIds = new Set<string>(), healthPaths = new Set<string>();
      const expected = original.checkpoint.operations.filter(operation => operation.kind === "release");
      for (const child of ["operations", "health"] as const) {
        const entries = readdirSync(join(profile.storage_root, child)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
        if (entries.length > 10000) fail("publication history exceeds recovery isolation limit");
        for (const name of entries) {
          const path = join(profile.storage_root, child, name);
          if (child === "operations") {
            const operation = readOperation(profile, path)!;
            const ref = expected.find(item => item.operation_id === operation.request.release_id);
            if (ref && ref.request_digest !== requestDigest(operation.request)) fail("checkpoint publication request differs from local history");
            if (operation.phase !== "terminal" && !ref) fail("unfinished publication is outside the original closed epoch");
            operationIds.add(operation.request.release_id);
          } else { readMonitor(profile, path); healthPaths.add(path); }
          files.set(path, sha(readFileSync(path)));
        }
      }
      const pointer = jsonFile<Pointer | null>(pointerPath(profile)) ?? null;
      if (pointer !== null) {
        const operation = readOperation(profile, statePath(profile, pointer.release_id));
        if (!operation || pointer.release_profile_digest !== profile.digest || operation.request.subject_digest !== pointer.artifact_digest)
          fail("old publication pointer has no exact retained operation");
      }
      const marker = immutableReleaseValue({ version: 1 as const, recovery_id: original.checkpoint.recovery_id,
        checkpoint_digest: productSourceRecoveryCheckpointDigestV1(original.checkpoint, sha),
        inventory_digest: sha(canonicalReleaseJson([...files].map(([path, digest]) => [relative(profile.storage_root, path).replaceAll("\\", "/"), digest]))),
        previous_pointer: pointer });
      original.assertCurrent(); writeState(profile, recoveryFencePath(profile), marker); auditStorage(profile);
      recoveryFences.set(profile, { runtime, original, files, operationIds, healthPaths, marker, opened: false });
      assertRecoveryFence(profile);
    }
  }
  function prepareRecoveredStart(profile: PreparedReleaseProfile, request: ProductReleaseRequest): void {
    const fence = assertRecoveryRequest(profile, request);
    if (!fence) return;
    const permit = assertRecoveryPublication(request);
    if (!permit) fail("recovered publisher needs its fresh author and independent review");
    const prepared = readPreparedRecoveryValidationRelease(permit, request);
    if (prepared.checkpoint !== fence.original.checkpoint) fail("publication and fence have different original checkpoint owners");
    if (!fence.opened) {
      if (!isDeepStrictEqual(jsonFile<Pointer | null>(pointerPath(profile)) ?? null, fence.marker.previous_pointer))
        fail("old publication pointer changed before fresh recovery acceptance");
      // The old records remain byte-for-byte history. Only the newly reviewed source may become active.
      writeState(profile, pointerPath(profile), null); auditStorage(profile); fence.opened = true;
    }
  }
  function assertCleanFence(profile: PreparedReleaseProfile, inspectHistory = true): CleanFence | undefined {
    const fence = cleanFences.get(profile), marker = jsonFile<CleanFence["marker"]>(cleanFencePath(profile));
    // A persisted fence isolates history. Only the original new checkpoint object
    // can retain execution authority; reading this JSON cannot restore that object.
    if (!fence) { if (marker !== undefined) fail("clean restart requires its original live checkpoint owner"); return undefined; }
    fence.original.assertCurrent();
    if (!isDeepStrictEqual(marker, fence.marker)) fail("clean publication isolation record changed");
    for (const [path, digest] of inspectHistory ? fence.files : []) {
      if (jsonFile<unknown>(path) === undefined || sha(readFileSync(path)) !== digest) fail("isolated publication history changed");
    }
    for (const id of inspectHistory ? fence.missingOperationIds : []) {
      if (existsSync(statePath(profile, id)) || existsSync(`${statePath(profile, id)}.cancelled`))
        fail("an absent original publication journal appeared after clean closure");
    }
    return fence;
  }
  function assertPublicationFence(profile: PreparedReleaseProfile, inspectHistory = true): RecoveryFence | CleanFence | undefined {
    const recovered = assertRecoveryFence(profile, inspectHistory), clean = assertCleanFence(profile, inspectHistory);
    if (recovered && clean) fail("publisher cannot have two source generation owners");
    return recovered ?? clean;
  }
  function assertCleanRequest(profile: PreparedReleaseProfile, request: ProductReleaseRequest): CleanFence | undefined {
    const fence = assertCleanFence(profile), origin = request.imported_clean;
    if (fence && (fence.operationIds.has(request.release_id)
      || fence.original.predecessorOperations.some(operation => operation.kind === "release" && operation.operation_id === request.release_id)
      || !origin || request.imported_validation || request.imported_recovery
      || origin.clean_generation_id !== fence.marker.clean_generation_id)) fail("isolated old publication cannot execute or replay in a clean generation");
    if (origin && !fence) fail("clean publication requires its original installed checkpoint fence");
    if (fence && origin) {
      const expected = fence.original.predecessorOperations.filter(operation => operation.kind === "release");
      if (origin.interrupted_release_id === null) {
        if (expected.length) fail("first clean publication cannot omit an original release operation");
        for (const oldId of fence.operationIds) {
          if (readOperation(profile, statePath(profile, oldId))?.request.goal_id === request.goal_id)
            fail("first clean publication cannot replace this goal's retained release history");
        }
      } else {
        const reference = expected.find(operation => operation.operation_id === origin.interrupted_release_id);
        const path = statePath(profile, origin.interrupted_release_id), operation = readOperation(profile, path);
        const previous = operation?.request ?? jsonFile<ProductReleaseRequest>(`${path}.cancelled`);
        if (!reference || previous && (reference.request_digest !== requestDigest(previous) || previous.goal_id !== request.goal_id
          || previous.project_id !== request.project_id || previous.run_id === request.run_id))
          fail("clean publication requires its exact retained interrupted predecessor and a fresh author");
        // A terminal local receipt may have been lost before server delivery. Keep
        // that fact intact. A queued request may also never have reached this node:
        // whole-parent closure and the exact original set authorize fresh work,
        // without manufacturing a missing old operation or a failed receipt.
      }
    }
    return fence;
  }
  function assertPublicationRequest(profile: PreparedReleaseProfile, request: ProductReleaseRequest): RecoveryFence | CleanFence | undefined {
    const recovered = assertRecoveryRequest(profile, request), clean = assertCleanRequest(profile, request);
    if (recovered && clean) fail("publisher cannot have two source generation owners");
    return recovered ?? clean;
  }
  function fenceCleanWorkspace(runtime: PreparedWindowsCleanValidationRuntime): void {
    const original = readWindowsCleanValidationPublicationFence(runtime);
    const selected = profiles.filter(profile => profile.project_id === original.projectId && profile.verifier.workspace_root === original.workspaceRoot);
    for (const profile of selected) {
      const existing = cleanFences.get(profile);
      if (existing) { if (existing.runtime !== runtime) fail("clean publication fence owner is immutable"); assertCleanFence(profile); continue; }
      if (servers.has(profile.id) || starts.has(profile.id) || queues.has(profile.id) || monitorPending.has(profile.id)
        || [...attempts.values()].some(attempt => attempt.request.release_profile_id === profile.id))
        fail("clean publication fence must precede all publisher execution");
      auditStorage(profile); initialize(profile); original.assertCurrent();
      if (existsSync(cleanFencePath(profile)) || recoveryFences.has(profile) || existsSync(recoveryFencePath(profile)))
        fail("another source generation already fenced this publisher; original owner is required");
      const files = new Map<string, string>(), operationIds = new Set<string>(), healthPaths = new Set<string>();
      const expected = original.predecessorOperations.filter(operation => operation.kind === "release");
      for (const child of ["operations", "health", "attestations"] as const) {
        const entries = readdirSync(join(profile.storage_root, child)).filter(name => child === "operations"
          ? /^[a-f0-9]{64}\.json(?:\.cancelled)?$/.test(name) : /^[a-f0-9]{64}\.json$/.test(name)).sort();
        if (entries.length > 10000) fail("publication history exceeds clean isolation limit");
        for (const name of entries) {
          const path = join(profile.storage_root, child, name);
          if (child === "operations") {
            if (name.endsWith(".cancelled")) {
              const cancelled = parseLocallySupportedReleaseRequest(jsonFile<unknown>(path));
              if (path !== `${statePath(profile, cancelled.release_id)}.cancelled` || cancelled.release_profile_id !== profile.id)
                fail("invalid retained publication cancellation identity");
              const reference = expected.find(item => item.operation_id === cancelled.release_id);
              if (reference && reference.request_digest !== requestDigest(cancelled)) fail("clean predecessor cancellation differs from local history");
              operationIds.add(cancelled.release_id);
            } else {
              const operation = readOperation(profile, path)!;
              const reference = expected.find(item => item.operation_id === operation.request.release_id);
              if (reference && reference.request_digest !== requestDigest(operation.request)) fail("clean predecessor request differs from local history");
              if (operation.phase !== "terminal" && !reference) fail("unfinished publication is outside the original closed epoch");
              operationIds.add(operation.request.release_id);
            }
          } else if (child === "health") { readMonitor(profile, path); healthPaths.add(path); }
          else {
            const attestation = AttestationSchema.parse(jsonFile<unknown>(path));
            if (name !== `${key(attestation.run_id)}.json`) fail("invalid retained publication attestation identity");
          }
          files.set(path, sha(readFileSync(path)));
        }
      }
      const pointer = jsonFile<Pointer | null>(pointerPath(profile)) ?? null;
      if (pointer !== null) {
        const operation = readOperation(profile, statePath(profile, pointer.release_id));
        if (!operation || pointer.release_profile_digest !== profile.digest || operation.request.subject_digest !== pointer.artifact_digest)
          fail("old publication pointer has no exact retained operation");
      }
      const marker = immutableReleaseValue({ version: 1 as const, clean_generation_id: original.generationId, lineage_id: original.lineageId,
        inventory_digest: sha(canonicalReleaseJson([...files].map(([path, digest]) => [relative(profile.storage_root, path).replaceAll("\\", "/"), digest]))),
        previous_pointer: pointer });
      original.assertCurrent(); writeState(profile, cleanFencePath(profile), marker); auditStorage(profile);
      const missingOperationIds = new Set(expected.filter(operation => !operationIds.has(operation.operation_id)).map(operation => operation.operation_id));
      cleanFences.set(profile, { runtime, original, files, operationIds, missingOperationIds, healthPaths, marker, opened: false });
      assertCleanFence(profile);
    }
  }
  function prepareCleanStart(profile: PreparedReleaseProfile, request: ProductReleaseRequest): void {
    const fence = assertCleanRequest(profile, request);
    if (!fence) return;
    const permit = assertCleanPublication(request);
    if (!permit) fail("clean publisher needs its fresh author and independent review");
    const prepared = readPreparedCleanValidationRelease(permit, request);
    if (prepared.checkpoint !== fence.original.checkpoint || prepared.restart.generation_id !== fence.original.generationId
      || prepared.restart.lineage_id !== fence.original.lineageId) fail("clean publication and fence have different original checkpoint owners");
    if (!fence.opened) {
      if (!isDeepStrictEqual(jsonFile<Pointer | null>(pointerPath(profile)) ?? null, fence.marker.previous_pointer))
        fail("old publication pointer changed before fresh clean acceptance");
      writeState(profile, pointerPath(profile), null); auditStorage(profile); fence.opened = true;
    }
  }
  function assertRequestProfile(profile: PreparedReleaseProfile, request: ProductReleaseRequest): void {
    if (request.project_id !== profile.project_id || request.verification_profile_id !== profile.verifier.id
      || request.verification_profile_digest !== profile.verifier.digest) fail("release request does not match local profile");
    if (request.acceptance_binding && !isDeepStrictEqual(request.acceptance_binding.release_binding, capabilityReader(profile)().binding)) {
      fail("release acceptance request differs from the local publication contract");
    }
  }
  function assertPinnedAcceptance(root: string, acceptance: NonNullable<Attestation["acceptance"]>): void {
    const pins = acceptance.accepted_inputs.files;
    const research = pins.find(pin => pin.path === ".artoo/product/research.json");
    if (pins.length !== 2 || !pins.some(pin => pin.path === ".artoo/product/research.json") || !pins.some(pin => pin.path === ".artoo/product/design.json")
      || !research || !isDeepStrictEqual({ path: research.path, checksum: research.checksum, size: research.size }, acceptance.binding.research)) fail("release acceptance requires the accepted research and design pins");
    for (const pin of pins) {
      const bytes = readProductFile(root, pin.path);
      if (sha(bytes) !== pin.checksum || bytes.length !== pin.size) fail("release accepted input changed");
    }
  }
  function bindingFromSummary(plan: { id: string; version: number }, summary: NonNullable<RunVerificationPayload["measurement_plan"]>,
    read: ReleaseCapabilityReader): ReleaseAcceptanceBindingV1 {
    const capability = read();
    if (summary.version !== 2 || summary.scope !== "final" || !summary.pending_release.length
      || summary.pending_release.some(item => !isDeepStrictEqual(item.release_binding, capability.binding))) fail("release requires final measured publication obligations");
    return ReleaseAcceptanceBindingV1Schema.parse({ version: 1, plan, research: summary.research,
      measurement_plan_digest: summary.measurement_plan_digest, release_binding: capability.binding,
      criteria: summary.pending_release.map(({ requirement_id, criterion_index, criterion_digest, claim_id }) => ({ requirement_id, criterion_index, criterion_digest, claim_id })) });
  }
  function assertAcceptance(profile: PreparedReleaseProfile, request: ProductReleaseRequest, attestation: Attestation,
    root = profile.verifier.workspace_root): void {
    const imported = assertValidationPublication(request, attestation, root);
    const obligations = attestation.evidence.measurement_plan?.version === 2 && attestation.evidence.measurement_plan.pending_release.length > 0;
    if (!profile.criterion_acceptance && !request.acceptance_binding && !attestation.acceptance && !obligations) return;
    const acceptance = attestation.acceptance, read = capabilityReader(profile);
    if (!acceptance || !request.acceptance_binding || !obligations || acceptance.goal_id !== request.goal_id
      || !isDeepStrictEqual(acceptance.binding, request.acceptance_binding) || !isDeepStrictEqual(acceptance.plan, acceptance.binding.plan)) {
      fail("release requires the exact final validation author acceptance binding; downgrade is forbidden");
    }
    assertPinnedAcceptance(root, acceptance);
    const summary = measureReleaseAcceptancePlan(profile.verifier, root, read, imported);
    if (!isDeepStrictEqual(summary, attestation.evidence.measurement_plan)
      || !isDeepStrictEqual(bindingFromSummary(acceptance.plan, summary, read), acceptance.binding)) fail("release research or measurement plan changed");
    read();
  }
  function assertRecoveryPublication(request: ProductReleaseRequest, attestation?: Attestation, root?: string): PreparedRecoveryValidationRelease | undefined {
    const permit = recoveryValidationPublications.get(request.release_id);
    if (!request.imported_recovery && !attestation?.imported_recovery && !permit && !recoveryValidationRuns.has(request.run_id)) return undefined;
    if (!permit || !request.imported_recovery || request.imported_validation || request.imported_clean || attestation?.imported_validation || attestation?.imported_clean
      || attestation && !isDeepStrictEqual(attestation.imported_recovery, request.imported_recovery))
      fail("Recovery publication requires its exact fresh local author and independent review owner");
    const original = readPreparedRecoveryValidationRelease(permit, request, root);
    if (attestation && (attestation.run_id !== original.start.run_id || !isDeepStrictEqual(attestation.evidence, original.verification)))
      fail("Recovery publication attestation differs from its original fresh final verifier");
    return permit;
  }
  function assertCleanPublication(request: ProductReleaseRequest, attestation?: Attestation, root?: string): PreparedCleanValidationRelease | undefined {
    const permit = cleanValidationPublications.get(request.release_id);
    if (!request.imported_clean && !attestation?.imported_clean && !permit && !cleanValidationRuns.has(request.run_id)) return undefined;
    if (!permit || !request.imported_clean || request.imported_validation || request.imported_recovery
      || attestation?.imported_validation || attestation?.imported_recovery
      || attestation && !isDeepStrictEqual(attestation.imported_clean, request.imported_clean))
      fail("Clean publication requires its exact fresh local author and independent review owner");
    const original = readPreparedCleanValidationRelease(permit, request, root);
    const profile = profiles.find(candidate => candidate.id === request.release_profile_id);
    if (!profile) fail("clean publication profile is unavailable");
    const fence = assertCleanRequest(profile, request);
    if (!fence || original.checkpoint !== fence.original.checkpoint || original.restart.generation_id !== fence.original.generationId
      || original.restart.lineage_id !== fence.original.lineageId) fail("clean publication and fence have different original checkpoint owners");
    if (attestation && (attestation.run_id !== original.start.run_id || !isDeepStrictEqual(attestation.evidence, original.verification)))
      fail("Clean publication attestation differs from its original fresh final verifier");
    return permit;
  }
  function assertValidationPublication(request: ProductReleaseRequest, attestation?: Attestation, root?: string): PreparedImportedValidationRelease | PreparedRecoveryValidationRelease | PreparedCleanValidationRelease | undefined {
    const clean = assertCleanPublication(request, attestation, root);
    if (clean) return clean;
    const recovered = assertRecoveryPublication(request, attestation, root);
    if (recovered) return recovered;
    const permit = importedValidationPublications.get(request.release_id);
    if (!request.imported_validation && !attestation?.imported_validation && !permit && !importedValidationRuns.has(request.run_id)) return undefined;
    if (!permit || !request.imported_validation || attestation && !isDeepStrictEqual(attestation.imported_validation, request.imported_validation))
      fail("Imported validation publication requires its original current local owner; origin downgrade and recovery by JSON are forbidden");
    const original = readPreparedImportedValidationRelease(permit, request, root);
    if (attestation && (attestation.run_id !== original.start.run_id || !isDeepStrictEqual(attestation.evidence, original.verification)))
      fail("Imported validation attestation differs from the original independently verified author");
    return permit;
  }
  function initialize(profile: PreparedReleaseProfile) {
    assertStorage(profile);
    for (const child of ["operations", "attestations", "artifacts", "health"]) {
      const path = join(profile.storage_root, child);
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail("invalid release storage layout");
    }
    initializedProfiles.add(profile);
  }
  function initializeHistory(profile: PreparedReleaseProfile): void {
    if (monitorFaults.has(profile.id)) fail("local release history is unavailable after an executor fault");
    if (!initializedProfiles.has(profile)) { auditStorage(profile); initialize(profile); auditStorage(profile); }
    else assertStorage(profile);
  }
  function artifactBytes(profile: PreparedReleaseProfile, pointer: Pointer, path: string): Buffer {
    if (!/^sha256:[a-f0-9]{64}$/.test(pointer.artifact_digest) || pointer.release_profile_digest !== profile.digest) fail("invalid active release pointer");
    const root = artifactRoot(profile, pointer.artifact_digest);
    const manifest = jsonFile<ArtifactManifest>(join(root, "manifest.json"));
    const file = `${profile.output_path}/${targetFile(path)}`;
    const fact = manifest?.files.find((item) => item.path === file);
    if (!fact || manifest?.digest !== pointer.artifact_digest) fail("requested file is not in the immutable artifact");
    const bytes = readFileSync(checkedPath(join(root, "content"), file));
    if (sha(bytes) !== fact.checksum || bytes.length !== fact.size) fail("immutable artifact was modified");
    return bytes;
  }
  function readOperation(profile: PreparedReleaseProfile, path: string): Operation | undefined {
    const operation = jsonFile<Operation>(path);
    if (!operation) return undefined;
    const request = parseLocallySupportedReleaseRequest(operation.request);
    if (path !== statePath(profile, request.release_id) || request.release_profile_id !== profile.id
      || !["prepared", "activated", "rolling_back", "disabling", "terminal"].includes(operation.phase)) fail("invalid operation identity or phase");
    if (operation.phase === "terminal") {
      const receipt = ProductReleaseReceiptSchema.parse(operation.receipt);
      if (!isDeepStrictEqual(receipt.request, request)) fail("terminal receipt does not match operation");
      if (receipt.acceptance && (!request.acceptance_binding
        || receipt.acceptance.binding_digest !== sha(canonicalReleaseAcceptanceBinding(request.acceptance_binding)))) fail("terminal acceptance digest differs from its immutable request");
      // Older workers recorded routing errors as terminal failures. They are inert history, never publication authority.
      if (request.project_id !== profile.project_id && receipt.outcome !== "failed") fail("operation project does not match local profile");
    } else if (operation.receipt) fail("nonterminal operation contains a terminal receipt");
    else if (request.project_id !== profile.project_id) fail("operation project does not match local profile");
    return operation;
  }
  function readMonitor(profile: PreparedReleaseProfile, path: string): MonitorRecord | undefined {
    const record = jsonFile<MonitorRecord>(path);
    if (!record) return undefined;
    const report = ProductReleaseHealthReportSchema.parse(record.report);
    const publication = readOperation(profile, statePath(profile, report.request.release_id));
    if (record.version !== 1 || !["monitoring", "recovering", "disabling", "terminal"].includes(record.phase)
      || path !== monitorPath(profile, report.request.release_id) || report.release_profile_digest !== profile.digest
      || publication?.phase !== "terminal" || publication.receipt?.outcome !== "published"
      || !isDeepStrictEqual(publication.request, report.request) || publication.receipt.release_profile_digest !== profile.digest
      || !isDeepStrictEqual(report.health_checks.map((check) => check.path), profile.health_checks.map((check) => check.path))) fail("invalid monitoring journal identity");
    if (record.phase === "monitoring") {
      if (!["healthy", "degraded"].includes(report.state) || record.recovery !== undefined) fail("invalid monitoring state");
    } else if (record.phase === "terminal") {
      if (!["rolled_back", "unavailable"].includes(report.state) || record.recovery !== undefined) fail("invalid terminal monitoring state");
    } else {
      if (!profile.monitoring || report.state !== "degraded" || report.consecutive_failures < profile.monitoring.failure_threshold
        || !record.recovery || !isDeepStrictEqual(record.recovery.previous, publication.previous)) fail("invalid monitoring recovery intent");
      const { acceptance: _settled, ...publicationWithoutSettlement } = publication.receipt;
      const validated = ProductReleaseReceiptSchema.parse({ ...publicationWithoutSettlement, outcome: "failed", endpoint: null,
        health_checks: record.recovery.checks }).health_checks;
      if (record.phase === "recovering" && (!record.recovery.previous || validated.length)) fail("invalid monitoring recovery phase");
      if (record.phase === "disabling" && validated.length && validated.every((check) => check.passed)) fail("disabling cannot claim successful recovery");
      record.recovery.checks = validated;
    }
    return { ...record, report };
  }
  function monitorRecords(profile: PreparedReleaseProfile): MonitorRecord[] {
    const fence = assertPublicationFence(profile);
    const entries = readdirSync(join(profile.storage_root, "health")).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (entries.length > 10000) fail("monitoring journal exceeds recovery limit");
    return entries.filter(name => !fence?.healthPaths.has(join(profile.storage_root, "health", name)))
      .map((name) => readMonitor(profile, join(profile.storage_root, "health", name))!);
  }
  function requirePublishedPointer(profile: PreparedReleaseProfile, pointer: Pointer | null): void {
    if (pointer === null) return;
    if (!pointer || typeof pointer.release_id !== "string") fail("invalid previous release pointer");
    const previous = readOperation(profile, statePath(profile, pointer.release_id));
    if (previous?.phase !== "terminal" || previous.receipt?.outcome !== "published"
      || previous.receipt.artifact_digest !== pointer.artifact_digest || pointer.release_profile_digest !== profile.digest
      || previous.receipt.release_profile_digest !== profile.digest) fail("release pointer is not bound to a confirmed published version");
    if (readMonitor(profile, monitorPath(profile, pointer.release_id))?.phase === "terminal") fail("release pointer refers to a version withdrawn after failed monitoring");
  }
  function beginRollback(profile: PreparedReleaseProfile, operation: Operation, receipt?: ProductReleaseReceipt): Operation {
    if (operation.phase !== "rolling_back" && operation.phase !== "disabling") {
      if (!receipt) fail("rollback requires a failure receipt");
      const { acceptance: _settled, ...failedReceipt } = receipt;
      operation = { request: operation.request, previous: operation.previous, phase: "rolling_back",
        rollback_receipt: ProductReleaseReceiptSchema.parse({ ...failedReceipt, outcome: "failed", endpoint: null }) };
      writeState(profile, statePath(profile, operation.request.release_id), operation);
    }
    const failure = ProductReleaseReceiptSchema.parse(operation.rollback_receipt);
    if (failure.outcome !== "failed" || !isDeepStrictEqual(failure.request, operation.request)
      || failure.release_profile_digest !== profile.digest || failure.previous_release_id !== (operation.previous?.release_id ?? null)) fail("invalid durable rollback receipt");
    if (operation.phase === "disabling") {
      if (!failure.recovery_checks?.length || failure.recovery_checks.every((check) => check.passed)) fail("disabling publication requires failed recovery measurements");
    } else requirePublishedPointer(profile, operation.previous);
    const active = jsonFile<Pointer | null>(pointerPath(profile)) ?? null;
    const candidate: Pointer = { release_id: operation.request.release_id, artifact_digest: operation.request.subject_digest, release_profile_digest: profile.digest };
    if (!isDeepStrictEqual(active, candidate) && !isDeepStrictEqual(active, operation.previous)
      && !(operation.phase === "disabling" && active === null)) fail("another release superseded interrupted publication");
    // This restoration precedes listener binding at startup. No unconfirmed candidate is served after a crash.
    writeState(profile, pointerPath(profile), operation.phase === "disabling" ? null : operation.previous);
    return operation;
  }
  async function finishRollback(profile: PreparedReleaseProfile, operation: Operation): Promise<ProductReleaseReceipt> {
    const receipt = ProductReleaseReceiptSchema.parse(operation.rollback_receipt);
    if (operation.phase !== "disabling") receipt.recovery_checks = operation.previous ? await health(profile, operation.previous) : [];
    else if (!receipt.recovery_checks?.length || receipt.recovery_checks.every((check) => check.passed)) fail("disabling publication requires failed recovery measurements");
    const recovered = receipt.recovery_checks.every((check) => check.passed);
    const attempt = attempts.get(operation.request.release_id);
    if (attempt) attempt.recoverySettled = !operation.previous || settledHealth.has(receipt.recovery_checks);
    receipt.outcome = recovered ? "rolled_back" : "failed";
    if (!recovered && operation.phase !== "disabling") {
      receipt.reason = `${receipt.reason ?? "Publication failed"}; previous release health failed; publication disabled`.slice(0, 2000);
      operation = { request: operation.request, previous: operation.previous, phase: "disabling",
        rollback_receipt: ProductReleaseReceiptSchema.parse(receipt) };
      writeState(profile, statePath(profile, operation.request.release_id), operation);
      beginRollback(profile, operation);
    }
    return finishTerminal(profile, operation.request, operation.previous, receipt);
  }
  function prepareRecovery(profile: PreparedReleaseProfile): Operation | undefined {
    const fence = assertPublicationFence(profile);
    const entries = readdirSync(join(profile.storage_root, "operations")).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (entries.length > 10000) fail("operation journal exceeds recovery limit");
    const pending = entries.map((name) => readOperation(profile, join(profile.storage_root, "operations", name))!)
      .filter((operation) => operation.phase !== "terminal" && !fence?.operationIds.has(operation.request.release_id));
    if (pending.length > 1) fail("multiple unfinished publications require recovery before serving");
    const operation = pending[0];
    if (!operation) {
      requirePublishedPointer(profile, jsonFile<Pointer | null>(pointerPath(profile)) ?? null);
      return undefined;
    }
    return beginRollback(profile, operation, { request: operation.request,
      release_profile_digest: operation.request.acceptance_binding?.release_binding.release_profile_digest ?? profile.digest,
      artifact_digest: operation.request.subject_digest, outcome: "failed", endpoint: null,
      previous_release_id: operation.previous?.release_id ?? null, health_checks: [],
      reason: "Publication was interrupted before a terminal receipt; recovering the previous release" });
  }
  async function notifyHealth(report: ProductReleaseHealthReport): Promise<void> {
    try { await options.onHealthReport?.(ProductReleaseHealthReportSchema.parse(report)); }
    catch (error) { options.onError?.(error); } // The protected journal, not transport availability, owns recovery.
  }
  function writeMonitor(profile: PreparedReleaseProfile, record: MonitorRecord): void {
    const path = monitorPath(profile, record.report.request.release_id);
    if (!existsSync(path) && readdirSync(join(profile.storage_root, "health")).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length >= 10000) {
      fail("monitoring journal is full");
    }
    writeState(profile, path, record);
  }
  function restoreMonitorPointer(profile: PreparedReleaseProfile, record: MonitorRecord): void {
    if (!record.recovery || !["recovering", "disabling"].includes(record.phase)) fail("monitor recovery is not prepared");
    const active = jsonFile<Pointer | null>(pointerPath(profile)) ?? null;
    const failed: Pointer = { release_id: record.report.request.release_id, artifact_digest: record.report.artifact_digest,
      release_profile_digest: record.report.release_profile_digest };
    if (!isDeepStrictEqual(active, failed) && !isDeepStrictEqual(active, record.recovery.previous)
      && !(record.phase === "disabling" && active === null)) fail("another release superseded interrupted monitoring recovery");
    if (record.phase === "recovering") requirePublishedPointer(profile, record.recovery.previous);
    writeState(profile, pointerPath(profile), record.phase === "recovering" ? record.recovery.previous : null);
  }
  async function finishMonitorRecovery(profile: PreparedReleaseProfile, record: MonitorRecord): Promise<void> {
    restoreMonitorPointer(profile, record);
    if (record.phase === "recovering") {
      const checks = await health(profile, record.recovery!.previous!);
      if (checks.some((check) => !check.passed)) {
        // Persist rejection before disabling. A crash here must never serve this failed recovery candidate again.
        record = { ...record, phase: "disabling", recovery: { previous: record.recovery!.previous, checks } };
        writeMonitor(profile, record); restoreMonitorPointer(profile, record);
      } else record = { ...record, recovery: { previous: record.recovery!.previous, checks } };
    }
    const recovered = record.phase === "recovering";
    const report = ProductReleaseHealthReportSchema.parse({ ...record.report, event_id: randomUUID(), sequence: record.report.sequence + 1,
      state: recovered ? "rolled_back" : "unavailable", active_release_id: recovered ? record.recovery!.previous!.release_id : null,
      active_artifact_digest: recovered ? record.recovery!.previous!.artifact_digest : null, recovery_checks: record.recovery!.checks,
      checked_at: new Date().toISOString(), reason: recovered ? "Continuous health checks failed; restored and verified the previous release"
        : record.recovery!.previous ? "Continuous health checks failed; the previous release could not be recovered; publication disabled"
          : "Continuous health checks failed; no previous release is available; publication disabled" });
    writeMonitor(profile, { version: 1, phase: "terminal", report });
    await notifyHealth(report);
  }
  async function observeHealth(profile: PreparedReleaseProfile): Promise<void> {
    if (!profile.monitoring || stopped || stopping) return;
    const pointer = jsonFile<Pointer | null>(pointerPath(profile)) ?? null;
    if (!pointer) return;
    requirePublishedPointer(profile, pointer);
    const publication = readOperation(profile, statePath(profile, pointer.release_id))!;
    const previous = readMonitor(profile, monitorPath(profile, pointer.release_id));
    if (previous && previous.phase !== "monitoring") fail("health recovery must finish before the next observation");
    const controller = new AbortController(); monitorControllers.set(profile.id, controller);
    let checks: ProductReleaseReceipt["health_checks"];
    try {
      checks = await health(profile, pointer, controller.signal);
      // Stopping the daemon is not evidence that the endpoint failed.
      if (controller.signal.aborted || stopped || stopping) return;
    } finally { monitorControllers.delete(profile.id); }
    if (!isDeepStrictEqual(jsonFile<Pointer | null>(pointerPath(profile)) ?? null, pointer)) fail("release changed during serialized health observation");
    const passed = checks.every((check) => check.passed);
    const failures = passed ? 0 : (previous?.report.consecutive_failures ?? 0) + 1;
    const report = ProductReleaseHealthReportSchema.parse({ version: 1, event_id: randomUUID(), sequence: (previous?.report.sequence ?? 0) + 1,
      request: publication.request, release_profile_digest: profile.digest, artifact_digest: pointer.artifact_digest,
      state: passed ? "healthy" : "degraded", active_release_id: pointer.release_id, active_artifact_digest: pointer.artifact_digest,
      consecutive_failures: failures, health_checks: checks, recovery_checks: [], checked_at: new Date().toISOString(),
      ...(passed ? {} : { reason: "Published endpoint failed a continuous health observation" }) });
    let record: MonitorRecord = { version: 1, phase: "monitoring", report };
    if (!passed && failures >= profile.monitoring.failure_threshold) {
      let recoverable = publication.previous !== null;
      try { requirePublishedPointer(profile, publication.previous); }
      catch { recoverable = false; }
      record = { ...record, phase: recoverable ? "recovering" : "disabling", recovery: { previous: publication.previous, checks: [] } };
    }
    writeMonitor(profile, record);
    // Transport failures cannot hold the local recovery path open or delay its pointer restoration.
    if (record.phase !== "monitoring") await finishMonitorRecovery(profile, record);
    else await notifyHealth(report);
  }
  async function closeListener(profileId: string, timeoutMs?: number): Promise<void> {
    const server = servers.get(profileId);
    if (!server) return;
    await new Promise<void>((resolveClose, rejectClose) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => rejectClose(new Error("Publication listener closure is uncertain after its local deadline")), timeoutMs);
      server.close(error => { clearTimeout(timer); error ? rejectClose(error) : resolveClose(); }); server.closeAllConnections();
    });
    servers.delete(profileId);
  }
  async function finishTerminal(profile: PreparedReleaseProfile, request: ProductReleaseRequest, previous: Pointer | null,
    receipt: ProductReleaseReceipt): Promise<ProductReleaseReceipt> {
    const attempt = attempts.get(request.release_id); let source: Omit<RetrySource, "receipt"> | undefined;
    if (receipt.outcome !== "published" && attempt?.original && attempt.session && attempt.healthSettled && attempt.recoverySettled
      && !controllers.get(request.release_id)?.signal.aborted && !stopping && !stopped && !monitorFaults.has(profile.id)
      && !existsSync(`${statePath(profile, request.release_id)}.cancelled`) && options.retrySession?.() === attempt.session) {
      const pointer = jsonFile<Pointer | null>(pointerPath(profile)) ?? null, listener = servers.get(profile.id);
      if (!listener || !listener.listening || closedListeners.has(listener)) fail("original publication listener is unavailable for failure settlement");
      let recovery: ProductReleaseRetrySourceV1["recovery"];
      if (previous && isDeepStrictEqual(pointer, previous)) {
        if (!receipt.recovery_checks?.length) {
          receipt.recovery_checks = await health(profile, previous); attempt.recoverySettled = settledHealth.has(receipt.recovery_checks);
        }
        if (!attempt.recoverySettled || receipt.recovery_checks.some(check => !check.passed)) fail("publication rollback is not settled at its exact healthy predecessor");
        requirePublishedPointer(profile, previous);
        recovery = { kind: "previous-restored", active_release_id: previous.release_id, active_artifact_digest: previous.artifact_digest };
      } else {
        if (pointer !== null) fail("failed publication still has an active candidate");
        const timer = monitorTimers.get(profile.id); if (timer) clearTimeout(timer); monitorTimers.delete(profile.id);
        retryDisabledProfiles.add(profile.id);
        await closeListener(profile.id, profile.health_timeout_ms);
        if (!closedListeners.has(listener) || listener.listening || servers.has(profile.id)) fail("original publication listener closure is uncertain");
        recovery = { kind: "listener-closed", active_release_id: null, active_artifact_digest: null };
      }
      // Only unchanged final author inputs can be retried. A terminal rejection remains visible without a retry source.
      try {
        assertRetrySession(attempt); auditStorage(profile); assertRequestProfile(profile, request);
        const attestation = AttestationSchema.parse(jsonFile<Attestation>(join(profile.storage_root, "attestations", `${key(request.run_id)}.json`)));
        if (attestation.run_id !== request.run_id || attestation.evidence.subject_digest !== request.subject_digest
          || attestation.evidence.request_id !== request.verification_request_id || subjectManifest(profile.verifier).digest !== request.subject_digest) fail("publication retry inputs changed");
        assertAcceptance(profile, request, attestation);
        receipt = { ...receipt, retry_source: { version: 1, source_id: randomUUID(), closure: "local-release-settled.v1", recovery } };
        source = { attempt, profile, recovery, listener, attestationDigest: sha(canonicalReleaseJson(attestation)) };
      } catch (error) { receipt = { ...receipt, reason: `${receipt.reason ?? "Publication failed"}; automatic retry unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000) }; }
    }
    const final = immutableReleaseValue(ProductReleaseReceiptSchema.parse(receipt));
    writeState(profile, statePath(profile, request.release_id), { request, previous, phase: "terminal", receipt: final } satisfies Operation);
    auditStorage(profile);
    if (attempt?.original) attempt.receipt = final;
    if (source && final.retry_source) retrySources.set(final.retry_source.source_id, { ...source, receipt: final });
    return final;
  }
  function scheduleMonitor(profile: PreparedReleaseProfile): void {
    if (!profile.monitoring || stopped || stopping || retryDisabledProfiles.has(profile.id) || monitorFaults.has(profile.id) || monitorTimers.has(profile.id)) return;
    const timer = setTimeout(() => {
      monitorTimers.delete(profile.id);
      void checkHealth(profile).catch((error: unknown) => { options.onError?.(error); });
    }, profile.monitoring.interval_ms);
    timer.unref(); monitorTimers.set(profile.id, timer);
  }
  async function checkHealth(profile: PreparedReleaseProfile): Promise<void> {
    if (!profile.monitoring || stopped || stopping || retryDisabledProfiles.has(profile.id)) return;
    const fence = assertPublicationFence(profile); if (fence && !fence.opened) return;
    if (monitorFaults.has(profile.id)) fail("monitoring stopped after a journal or executor failure");
    const existing = monitorPending.get(profile.id); if (existing) return existing;
    const pending = (queues.get(profile.id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (stopped || stopping) return;
      try { await start(profile); auditStorage(profile); await observeHealth(profile); auditStorage(profile); }
      catch (error) {
        // A corrupt or unwritable recovery journal cannot authorize continued unattended serving.
        const reason = `Release profile ${profile.id}: monitoring halted: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
        monitorFaults.set(profile.id, { profile_id: profile.id, failed_at: new Date().toISOString(), reason });
        await closeListener(profile.id); throw new Error(reason, { cause: error });
      }
    });
    queues.set(profile.id, pending); monitorPending.set(profile.id, pending);
    try { await pending; } finally {
      if (queues.get(profile.id) === pending) queues.delete(profile.id);
      if (monitorPending.get(profile.id) === pending) monitorPending.delete(profile.id);
      scheduleMonitor(profile);
    }
  }
  async function start(profile: PreparedReleaseProfile): Promise<void> {
    if (!releaseProfileExecutionSupported(profile)) fail("product release requires a Linux or macOS worker or a locally qualified Windows verification and storage profile");
    if (stopped || stopping) fail("executor stopped");
    if (monitorFaults.has(profile.id)) fail("monitoring stopped after a journal or executor failure");
    const fence = assertPublicationFence(profile);
    if (fence && !fence.opened) fail("recovered publisher is awaiting fresh verification and independent review");
    if (starts.has(profile.id)) return starts.get(profile.id)!;
    if (servers.has(profile.id)) return;
    auditStorage(profile); initialize(profile); auditStorage(profile);
    const promise = (async () => {
      const monitorRecovery = monitorRecords(profile).filter((record) => record.phase === "recovering" || record.phase === "disabling");
      if (monitorRecovery.length > 1) fail("multiple unfinished monitoring recoveries require intervention before serving");
      const recovery = prepareRecovery(profile);
      if (recovery && monitorRecovery.length) fail("publication and monitoring recovery cannot run concurrently");
      if (monitorRecovery[0]) restoreMonitorPointer(profile, monitorRecovery[0]);
      const server = createServer((request, response) => {
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
        try {
          assertStorage(profile);
          // Full old-history rehash belongs to serialized control operations, not each public asset request.
          const currentFence = assertPublicationFence(profile, false);
          const pointer = jsonFile<Pointer | null>(pointerPath(profile));
          if (!pointer) { response.writeHead(503).end("No healthy release"); return; }
          if (currentFence && (!currentFence.opened || currentFence.operationIds.has(pointer.release_id)
            || !attempts.get(pointer.release_id)?.original)) fail("active publication has no current recovery executor owner");
          const path = new URL(request.url ?? "/", "http://local.invalid").pathname;
          const bytes = artifactBytes(profile, pointer, path);
          response.setHeader("x-artoo-release-id", pointer.release_id);
          response.setHeader("x-artoo-artifact-digest", pointer.artifact_digest);
          const extension = targetFile(path).split(".").pop();
          response.setHeader("content-type", ({ html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
            json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", ico: "image/x-icon" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream");
          response.writeHead(200).end(request.method === "HEAD" ? undefined : bytes);
        } catch { response.writeHead(404).end("Unavailable artifact"); }
      });
      server.once("close", () => { closedListeners.add(server); });
      try {
        await new Promise<void>((resolveStart, reject) => {
          server.once("error", reject);
          server.listen(profile.listen_port, profile.listen_host, () => { servers.set(profile.id, server); resolveStart(); });
        });
        if (recovery) await finishRollback(profile, recovery);
        if (monitorRecovery[0]) await finishMonitorRecovery(profile, monitorRecovery[0]);
        else await observeHealth(profile);
        auditStorage(profile);
        scheduleMonitor(profile);
      } catch (error) {
        await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
        servers.delete(profile.id);
        throw error;
      }
    })().finally(() => { starts.delete(profile.id); });
    starts.set(profile.id, promise); return promise;
  }
  function snapshot(profile: PreparedReleaseProfile, request: ProductReleaseRequest, attestation: Attestation): string {
    const before = subjectManifest(profile.verifier);
    if (before.digest !== request.subject_digest) fail("workspace changed since verified review");
    const destination = artifactRoot(profile, before.digest);
    if (!existsSync(destination)) {
      const temporary = join(profile.storage_root, "artifacts", `.preparing-${randomUUID()}`);
      mkdirSync(temporary, { mode: 0o700 });
      const content = join(temporary, "content"); mkdirSync(content, { mode: 0o700 });
      for (const directory of before.directories) mkdirSync(join(content, directory), { recursive: true, mode: 0o700 });
      for (const fact of before.files.values()) {
        const bytes = readFileSync(checkedPath(profile.verifier.workspace_root, fact.path));
        if (sha(bytes) !== fact.checksum || bytes.length !== fact.size) fail("source changed while snapshotting");
        const target = join(content, fact.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const fd = openSync(target, "wx", 0o400);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      }
      const copied = subjectManifest({ ...profile.verifier, workspace_root: realpathSync.native(content) });
      if (copied.digest !== before.digest || subjectManifest(profile.verifier).digest !== before.digest) fail("release snapshot differs from verified source");
      writeState(profile, join(temporary, "manifest.json"), { digest: before.digest, files: [...before.files.values()], directories: before.directories });
      chmodSync(join(temporary, "manifest.json"), 0o400);
      sealDirectories(temporary);
      renameSync(temporary, destination);
      syncDirectory(dirname(destination));
    }
    // Replayed artifacts are checked as carefully as newly copied ones.
    const content = join(destination, "content");
    for (const root of [destination, content]) {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(root) !== root) fail("stored release directory identity changed");
    }
    const current = subjectManifest({ ...profile.verifier, workspace_root: content });
    if (current.digest !== request.subject_digest) fail("stored release artifact changed");
    assertAcceptance(profile, request, attestation, content);
    assertAcceptance(profile, request, attestation);
    return before.digest;
  }
  async function health(profile: PreparedReleaseProfile, pointer: Pointer, signal?: AbortSignal): Promise<ProductReleaseReceipt["health_checks"]> {
    const checks: ProductReleaseReceipt["health_checks"] = [];
    let allSettled = true;
    for (const check of profile.health_checks) {
      let status: number | null = null, bodyDigest: string | null = null, passed = false;
      try {
        const expected = artifactBytes(profile, pointer, check.path);
        const deadline = performance.now() + profile.health_timeout_ms;
        const timeout = AbortSignal.timeout(profile.health_timeout_ms);
        const healthSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetchReleaseHealthGet(new URL(check.path, profile.public_url), healthSignal, deadline);
        status = response.status;
        if (Number(response.headers.get("content-length")) > 64 * 1024 * 1024) throw new Error("health body too large");
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            for (;;) {
              const next = await reader.read(); if (next.done) break;
              size += next.value.length; if (size > 64 * 1024 * 1024) { await reader.cancel(); throw new Error("health body too large"); }
              chunks.push(next.value);
            }
          } finally { reader.releaseLock(); }
        }
        const bytes = Buffer.concat(chunks); bodyDigest = sha(bytes);
        passed = status === 200 && bodyDigest === sha(expected) && response.headers.get("x-artoo-release-id") === pointer.release_id
          && response.headers.get("x-artoo-artifact-digest") === pointer.artifact_digest
          && (check.expect_text === undefined || bytes.toString("utf8").includes(check.expect_text))
          && !healthSignal.aborted && performance.now() < deadline;
        if (healthSignal.aborted || performance.now() >= deadline) allSettled = false;
      } catch { allSettled = false; /* A failed or unfinished HTTP exchange cannot mint retry authority. */ }
      checks.push({ path: check.path, status_code: status, body_digest: bodyDigest, passed, checked_at: new Date().toISOString() });
    }
    if (allSettled && !signal?.aborted) settledHealth.add(checks);
    return checks;
  }
  async function execute(profile: PreparedReleaseProfile, request: ProductReleaseRequest): Promise<ProductReleaseReceipt> {
    assertValidationPublication(request);
    prepareRecoveredStart(profile, request);
    prepareCleanStart(profile, request);
    await start(profile);
    auditStorage(profile);
    const path = statePath(profile, request.release_id);
    let operation = readOperation(profile, path);
    if (operation && !isDeepStrictEqual(operation.request, request)) fail("release ID reused with a different immutable request");
    if (operation?.phase === "terminal") return ProductReleaseReceiptSchema.parse(operation.receipt);
    const attempt = attempts.get(request.release_id);
    if (attempt && !operation) { attempt.original = true; attempt.previous = jsonFile<Pointer | null>(pointerPath(profile)) ?? null; }
    const receipt: ProductReleaseReceipt = { request,
      release_profile_digest: request.acceptance_binding?.release_binding.release_profile_digest ?? profile.digest, artifact_digest: null,
      outcome: "failed", endpoint: null, previous_release_id: operation?.previous?.release_id ?? attempt?.previous?.release_id ?? null, health_checks: [] };
    const controller = new AbortController(); controllers.set(request.release_id, controller);
    try {
      // An earlier attempt may have left a durable recovery intent after an I/O failure in this process.
      if (operation) return await finishRollback(profile, beginRollback(profile, operation, {
        ...receipt, artifact_digest: request.subject_digest, reason: "Retrying recovery of an interrupted publication" }));
      const cancelled = jsonFile<ProductReleaseRequest>(`${path}.cancelled`);
      try {
        if (cancelled) {
          if (!isDeepStrictEqual(cancelled, request)) fail("cancelled release ID has a different immutable request");
          fail("publication was cancelled");
        }
        const saved = jsonFile<Attestation>(join(profile.storage_root, "attestations", `${key(request.run_id)}.json`));
        const attestation = saved ? AttestationSchema.parse(saved) : undefined;
        if (!attestation || attestation.run_id !== request.run_id || attestation.project_id !== request.project_id
          || attestation.workspace_root !== profile.verifier.workspace_root || attestation.evidence.outcome !== "passed"
          || attestation.evidence.request_id !== request.verification_request_id || attestation.evidence.profile_id !== request.verification_profile_id
          || attestation.evidence.profile_digest !== request.verification_profile_digest || attestation.evidence.subject_digest !== request.subject_digest) fail("no matching local successful verification attestation");
        assertAcceptance(profile, request, attestation);
        receipt.artifact_digest = snapshot(profile, request, attestation);
        operation = { request, previous: jsonFile<Pointer | null>(pointerPath(profile)) ?? null, phase: "prepared" };
        writeState(profile, path, operation);
        receipt.previous_release_id = operation.previous?.release_id ?? null;
        const pointer: Pointer = { release_id: request.release_id, artifact_digest: request.subject_digest, release_profile_digest: profile.digest };
        const active = jsonFile<Pointer | null>(pointerPath(profile)) ?? null;
        if (active?.release_id !== request.release_id && !isDeepStrictEqual(active, operation.previous)) fail("another release superseded this operation");
        assertValidationPublication(request, attestation);
        writeState(profile, pointerPath(profile), pointer);
        operation.phase = "activated"; writeState(profile, path, operation);
        if (attempt) attempt.healthSettled = false;
        receipt.health_checks = await health(profile, pointer, controller.signal);
        if (attempt) attempt.healthSettled = settledHealth.has(receipt.health_checks);
        controller.signal.throwIfAborted();
        assertValidationPublication(request, attestation);
        if (receipt.health_checks.some((check) => !check.passed)) throw new Error("Published endpoint failed configured health checks");
        if (request.acceptance_binding) {
          capabilityReader(profile)();
          receipt.acceptance = { version: 1, binding_digest: sha(canonicalReleaseAcceptanceBinding(request.acceptance_binding)),
            scope: "node-http-point-in-time", settled_criteria: structuredClone(request.acceptance_binding.criteria) };
        }
        receipt.outcome = "published"; receipt.endpoint = profile.public_url;
      } catch (error) {
        receipt.reason = (error instanceof Error ? error.message : "Release failed").slice(0, 2000);
        if (operation) return await finishRollback(profile, beginRollback(profile, operation, receipt));
      }
      return await finishTerminal(profile, request, operation?.previous ?? attempt?.previous ?? null, receipt);
    } finally {
      controllers.delete(request.release_id);
      auditStorage(profile);
    }
  }
  async function release(input: ProductReleaseRequest, local?: { retry?: PreparedProductReleaseRetry }): Promise<ProductReleaseReceipt> {
    if (!verificationSupported() && !profiles.some(releaseProfileExecutionSupported)) fail("product release requires a Linux or macOS worker or a locally qualified Windows verification and storage profile");
    const request = immutableReleaseValue(parseLocallySupportedReleaseRequest(input));
    const profile = profiles.find((item) => item.id === request.release_profile_id);
    if (!profile) fail("release profile unavailable");
    if (!releaseProfileExecutionSupported(profile)) fail("selected release profile has no qualified execution and storage backend");
    assertRequestProfile(profile, request);
    const historical = replayReceipt(request); if (historical) return historical;
    if (!!request.retry !== !!local?.retry) fail("publication retry requires its original local permit");
    if (local?.retry && !issuedRetryPermits.has(local.retry)) fail("publication retry permit must belong to this original executor");
    if (local?.retry) readPreparedProductReleaseRetry(local.retry, request);
    assertValidationPublication(request);
    const active = activeReleases.get(request.release_id);
    if (active) {
      if (!isDeepStrictEqual(active.request, request)) fail("release ID reused with a different immutable request");
      return active.pending;
    }
    const oldAttempt = attempts.get(request.release_id);
    if (oldAttempt && !isDeepStrictEqual(oldAttempt.request, request)) fail("publication attempt request changed");
    const attempt: Attempt = oldAttempt ?? { request, session: options.retrySession?.(), original: false, settled: false, running: false,
      healthSettled: true, recoverySettled: true, ...(local?.retry ? { retry: local.retry } : {}) };
    attempts.set(request.release_id, attempt);
    if (!request.retry) retryHeads.set(request.release_id, request.release_id);
    const pending = (queues.get(profile.id) ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (local?.retry) readPreparedProductReleaseRetry(local.retry, request);
      retryDisabledProfiles.delete(profile.id);
      attempt.running = true; return execute(profile, request);
    });
    queues.set(profile.id, pending); activeReleases.set(request.release_id, { request, pending });
    let returned = false;
    try { const receipt = await pending; returned = true; return receipt; } finally {
      if (queues.get(profile.id) === pending) queues.delete(profile.id);
      if (activeReleases.get(request.release_id)?.pending === pending) activeReleases.delete(request.release_id);
      attempt.running = false; attempt.settled = returned && attempt.original && attempt.healthSettled && attempt.recoverySettled;
    }
  }
  function replayReceipt(input: ProductReleaseRequest): ProductReleaseReceipt | undefined {
    const request = parseLocallySupportedReleaseRequest(input), profile = profiles.find(item => item.id === request.release_profile_id);
    if (!profile) fail("release profile unavailable"); assertRequestProfile(profile, request);
    const fence = assertPublicationRequest(profile, request); initializeHistory(profile);
    if (fence && !attempts.has(request.release_id)) return undefined;
    const operation = readOperation(profile, statePath(profile, request.release_id));
    if (operation && !isDeepStrictEqual(operation.request, request)) fail("release ID reused with a different immutable request");
    return operation?.phase === "terminal" ? ProductReleaseReceiptSchema.parse(operation.receipt) : undefined;
  }
  return {
    fenceRecoveredWorkspace,
    fenceCleanWorkspace,
    prepareRetry,
    replayReceipt,
    isAttemptSettled(request: ProductReleaseRequest): boolean {
      const attempt = attempts.get(request.release_id);
      return !!attempt?.settled && isDeepStrictEqual(attempt.request, request);
    },
    getCapabilityReader(profileId: string): ReleaseCapabilityReader {
      const profile = profiles.find(item => item.id === profileId);
      if (!profile) fail("release profile unavailable");
      return capabilityReader(profile);
    },
    async start(): Promise<void> { await Promise.all(profiles.map(start)); },
    /** Node-local observations use only the already validated configuration, never remote URLs or commands. */
    async checkHealth(): Promise<void> { await Promise.all(profiles.map(checkHealth)); },
    /** A local executor fault is not fabricated endpoint-health evidence. It requires operator diagnostics. */
    getHealthFaults(): ProductReleaseHealthFault[] { return [...monitorFaults.values()].map((fault) => ({ ...fault })); },
    /** Latest state for each release is retained for bounded, idempotent reconnect replay. */
    getHealthReports(): ProductReleaseHealthReport[] {
      return profiles.flatMap((profile) => { initializeHistory(profile); return monitorRecords(profile).map((record) => record.report); });
    },
    /** Replay facts before later health observations; this never runs a publication again. */
    getPublicationReceipts(): ProductReleaseReceipt[] {
      return profiles.flatMap((profile) => {
        const fence = assertPublicationFence(profile);
        initializeHistory(profile);
        const entries = readdirSync(join(profile.storage_root, "operations")).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
        if (entries.length > 10000) fail("operation journal exceeds recovery limit");
        return entries.flatMap((name) => {
          const operation = readOperation(profile, join(profile.storage_root, "operations", name))!;
          if (fence && (fence.operationIds.has(operation.request.release_id) || !attempts.has(operation.request.release_id))) return [];
          // Legacy routing failures are inert local history, not facts about this configured project.
          return operation.phase === "terminal" && operation.request.project_id === profile.project_id
            && operation.request.verification_profile_id === profile.verifier.id
            && operation.request.verification_profile_digest === profile.verifier.digest ? [ProductReleaseReceiptSchema.parse(operation.receipt)] : [];
        });
      });
    },
    assertWorkspaceBoundary(payload: RunStartPayload): void {
      const target = physicalTarget(payload.workspace.root);
      for (const profile of profiles) {
        assertStorage(profile);
        assertReleaseAssetBoundary(profile, target);
      }
    },
    recordVerification(runId: string, projectId: string, workspaceRoot: string, evidence: RunVerificationPayload,
      local?: LocalReleaseVerificationContext): void {
      if (evidence.outcome !== "passed") return;
      const clean = local?.importedClean ? readPreparedCleanValidationRelease(local.importedClean) : undefined;
      if (local?.context.imported_clean_validation_review_subject || !!local?.context.imported_clean_validation !== !!clean
        || clean && (local?.importedValidation || local?.importedRecovery)
        || clean && (clean.verification !== evidence || clean.start.context_pack.payload !== local!.context
          || clean.start.run_id !== runId || clean.profile.project_id !== projectId || clean.profile.workspace_root !== workspaceRoot))
        fail("Only the original clean author verifier can create its publication attestation");
      if (clean && cleanValidationPublications.has(clean.request.release_id)
        && cleanValidationPublications.get(clean.request.release_id) !== local!.importedClean)
        fail("Clean publication owner is immutable");
      const priorCleanRun = cleanValidationRuns.get(runId);
      if (clean && priorCleanRun && (priorCleanRun.start !== clean.start || priorCleanRun.evidence !== evidence
        || !isDeepStrictEqual(priorCleanRun.origin, clean.request.imported_clean)))
        fail("Clean author cannot be rebound to another publication decision");
      const recovered = local?.importedRecovery ? readPreparedRecoveryValidationRelease(local.importedRecovery) : undefined;
      if (local?.context.imported_recovery_validation_review_subject || !!local?.context.imported_recovery_validation !== !!recovered
        || local?.importedValidation && recovered
        || recovered && (recovered.verification !== evidence || recovered.start.context_pack.payload !== local!.context
          || recovered.start.run_id !== runId || recovered.profile.project_id !== projectId || recovered.profile.workspace_root !== workspaceRoot))
        fail("Only the original H9 author verifier can create its recovery publication attestation");
      if (recovered && recoveryValidationPublications.has(recovered.request.release_id)
        && recoveryValidationPublications.get(recovered.request.release_id) !== local!.importedRecovery)
        fail("Recovery publication owner is immutable");
      const priorRecoveryRun = recoveryValidationRuns.get(runId);
      if (recovered && priorRecoveryRun && (priorRecoveryRun.start !== recovered.start || priorRecoveryRun.evidence !== evidence
        || !isDeepStrictEqual(priorRecoveryRun.origin, recovered.request.imported_recovery)))
        fail("Recovery author cannot be rebound to another publication decision");
      const imported = local?.importedValidation ? readPreparedImportedValidationRelease(local.importedValidation) : undefined;
      if (local?.context.imported_validation_review_subject || !!local?.context.imported_validation !== !!imported
        || imported && (imported.verification !== evidence || imported.start.context_pack.payload !== local!.context
          || imported.start.run_id !== runId || imported.profile.project_id !== projectId || imported.profile.workspace_root !== workspaceRoot))
        fail("Only the original H7 author verifier can create its publication attestation");
      if (imported && importedValidationPublications.has(imported.request.release_id) && importedValidationPublications.get(imported.request.release_id) !== local!.importedValidation)
        fail("Validation publication owner is immutable");
      const previousRun = importedValidationRuns.get(runId);
      if (imported && previousRun && (previousRun.start !== imported.start || previousRun.evidence !== evidence
        || !isDeepStrictEqual(previousRun.origin, imported.request.imported_validation))) fail("Validation author ownership is immutable across publication attempts");
      const pending = evidence.measurement_plan?.version === 2 && evidence.measurement_plan.pending_release.length > 0;
      if (pending && !local) fail("publication obligations require the node's local acceptance context");
      const capability = local ? assertReleaseCapabilityContext(local.context, local.readCapabilities) : undefined;
      let acceptance: Attestation["acceptance"], recorded = false;
      if (pending) {
        // Earlier stages and independent peer verification remain reviewable, but cannot publish.
        if (local!.context.product_development?.stage !== "validation" || local!.context.review_subject
          || local!.context.policy.execution_mode === "discussion") return;
        const goal = local!.context.goal_context, inputs = local!.context.product_development.accepted_inputs;
        if (!goal?.plan || !inputs) fail("final publication acceptance requires an accepted goal plan and input pins");
        assertAcceptedProductInputs(workspaceRoot, local!.context);
        const plan = { id: goal.plan.id, version: goal.plan.version };
        acceptance = AcceptanceContextSchema.parse({ version: 1, goal_id: goal.goal_id, stage: "validation", plan, accepted_inputs: inputs,
          binding: bindingFromSummary(plan, evidence.measurement_plan!, local!.readCapabilities) });
      }
      for (const profile of profiles) {
        if (profile.verifier.id !== evidence.profile_id || profile.project_id !== projectId || profile.verifier.workspace_root !== workspaceRoot) continue;
        if (profile.verifier.digest !== evidence.profile_digest) continue;
        if (pending ? profile.id !== capability!.binding.release_profile_id : profile.criterion_acceptance !== undefined) continue;
        const fence = assertRecoveryFence(profile);
        if (fence && (!recovered || recovered.checkpoint !== fence.original.checkpoint))
          fail("recovered publisher cannot attest an old or unrelated author");
        const cleanFence = assertCleanFence(profile);
        if (cleanFence && (!clean || clean.checkpoint !== cleanFence.original.checkpoint
          || clean.restart.generation_id !== cleanFence.original.generationId || clean.restart.lineage_id !== cleanFence.original.lineageId))
          fail("clean publisher cannot attest an old or unrelated author");
        if (clean && !cleanFence) fail("clean publication requires its original installed checkpoint fence");
        if (clean) assertCleanRequest(profile, clean.request);
        if (acceptance) {
          const read = capabilityReader(profile);
          if (!isDeepStrictEqual(read(), capability)) fail("final acceptance selected a different release capability");
          assertPinnedAcceptance(workspaceRoot, acceptance);
          if (!isDeepStrictEqual(measureReleaseAcceptancePlan(profile.verifier, workspaceRoot, read, local?.importedClean ?? local?.importedRecovery ?? local?.importedValidation), evidence.measurement_plan)) fail("final acceptance measurement changed");
          if (subjectManifest(profile.verifier).digest !== evidence.subject_digest) fail("final acceptance source changed");
        }
        auditStorage(profile); initialize(profile);
        const attestation = AttestationSchema.parse({ run_id: runId, project_id: projectId, workspace_root: workspaceRoot, evidence,
          ...(imported ? { imported_validation: imported.request.imported_validation } : {}),
          ...(recovered ? { imported_recovery: recovered.request.imported_recovery } : {}),
          ...(clean ? { imported_clean: clean.request.imported_clean } : {}),
          ...(acceptance ? { acceptance } : {}) });
        const path = join(profile.storage_root, "attestations", `${key(runId)}.json`);
        const previous = jsonFile<Attestation>(path);
        if (previous && !isDeepStrictEqual(previous, attestation)) fail("verification attestation is immutable");
        if (!previous) writeState(profile, path, attestation);
        auditStorage(profile);
        recorded = true;
      }
      if (pending && !recorded) fail("final acceptance release profile is unavailable");
      if (clean && recorded) {
        cleanValidationPublications.set(clean.request.release_id, local!.importedClean!);
        cleanValidationRuns.set(runId, { start: clean.start, evidence, origin: clean.request.imported_clean! });
      }
      if (recovered && recorded) {
        recoveryValidationPublications.set(recovered.request.release_id, local!.importedRecovery!);
        recoveryValidationRuns.set(runId, { start: recovered.start, evidence, origin: recovered.request.imported_recovery! });
      }
      if (imported && recorded) {
        importedValidationPublications.set(imported.request.release_id, local!.importedValidation!);
        importedValidationRuns.set(runId, { start: imported.start, evidence, origin: imported.request.imported_validation! });
      }
    },
    release,
    async cancel(input: ProductReleaseRequest): Promise<ProductReleaseReceipt> {
      const request = parseLocallySupportedReleaseRequest(input);
      const profile = profiles.find((item) => item.id === request.release_profile_id);
      if (!profile) fail("release profile unavailable");
      assertRequestProfile(profile, request);
      assertPublicationRequest(profile, request);
      const active = activeReleases.get(request.release_id);
      if (active && !isDeepStrictEqual(active.request, request)) fail("release ID reused with a different immutable request");
      auditStorage(profile); initialize(profile);
      const operationPath = statePath(profile, request.release_id);
      const operation = readOperation(profile, operationPath);
      if (operation && !isDeepStrictEqual(operation.request, request)) fail("release ID reused with a different immutable request");
      const path = `${operationPath}.cancelled`;
      const previous = jsonFile<ProductReleaseRequest>(path);
      if (previous && !isDeepStrictEqual(previous, request)) fail("cancelled release ID has a different immutable request");
      if (operation?.phase === "terminal") return ProductReleaseReceiptSchema.parse(operation.receipt);
      writeState(profile, path, request);
      auditStorage(profile);
      controllers.get(request.release_id)?.abort(new Error("Publication was cancelled"));
      await active?.pending;
      return release(request);
    },
    requestStop(): void {
      stopping = true;
      for (const timer of monitorTimers.values()) clearTimeout(timer); monitorTimers.clear();
      for (const controller of monitorControllers.values()) controller.abort(new Error("Release monitoring is shutting down"));
      for (const controller of controllers.values()) controller.abort(new Error("Release executor is shutting down"));
    },
    async stop(): Promise<void> {
      stopping = true;
      for (const timer of monitorTimers.values()) clearTimeout(timer); monitorTimers.clear();
      for (const controller of monitorControllers.values()) controller.abort(new Error("Release monitoring is shutting down"));
      for (const controller of controllers.values()) controller.abort(new Error("Release executor is shutting down"));
      stopped = true;
      await Promise.allSettled([...queues.values(), ...starts.values()]);
      await Promise.all([...servers.values()].map((server) => new Promise<void>((resolveClose) => {
        server.close(() => resolveClose()); server.closeAllConnections();
      })));
      servers.clear();
    },
  };
}
