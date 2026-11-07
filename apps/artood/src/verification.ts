import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync,
  mkdtempSync, writeFileSync, rmSync, chmodSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DevelopmentStageSchema, productStageHandoffPaths, RunVerificationPayloadSchema, StaticWebAcceptanceReportSchema,
  VerificationCapabilitiesContextSchema, VerificationCapabilityBindingSchema, StaticWebCapabilityBindingSchema,
  MeasurementPlanPolicySchema, MeasurementPlanSummaryV1Schema, MeasurementPlanSummaryV2Schema, ProductResearchReportV1Schema, ProductResearchReportV2Schema,
  evaluateDeclaredMeasurementPlanV1, evaluateDeclaredMeasurementPlanV2,
  canonicalProductSourceTransferValueV1, inspectImportedDesignVerificationEnvelopeV1, importedDesignVerificationEchoV1,
  type RunStartPayload, type RunVerificationPayload, type StaticWebAcceptanceReport, type VerificationObservation,
  type VerificationCapabilities, type VerificationCapabilitiesContext, type StaticWebCapabilityBinding,
  type MeasurementPlanPolicy, type MeasurementPlanSummary, type MeasurementPlanSummaryV2, type ProductMeasurementPlan,
  type inspectProductSourceVerificationEnvelope } from "@artoo/domain";
import type { PreparedProductSourceVerificationAdmission, PreparedImportedDesignContinuation, readImportedDesignVerificationAdmission } from "./product-source-runtime.js";
import { assertReleaseCapabilityContext, type ReleaseCapabilityReader } from "./release-capability-authority.js";
import { OwnedGitError } from "./owned/owned-git.js";
import { ProtectedCommandError, runProtectedCommand } from "./protected-command.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { assertWindowsBrowserProcessInstallation, createWindowsBrowserProcessDescriptor } from "./windows-browser-process-authority.js";
import { writeWindowsBrowserPrivateContext } from "./windows-browser-private-context.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";
export { VerificationCleanupError } from "./verification-cleanup-error.js";
import { assertAcceptedProductInputs, readProductFile } from "./product-stage.js";
import { assertProductDesignRevisionRun, assertProductDesignRevisionBaseline, inspectProductDesignRevision, readProductDesignRevision } from "./product-design-revision.js";
import { sealBrowserEvidence, validateBrowserEvidenceRoot } from "./browser-evidence.js";
import { deriveExpectedWebAcceptanceV2, deriveExpectedWebAcceptanceV3, prepareStaticWebCapabilities, type PreparedStaticWebCapabilities } from "./web-acceptance.js";
import { isV2WebAcceptanceOptions, isV3WebAcceptanceOptions, normalizeWebAcceptanceOptions, STATIC_WEB_MAX_CONFIG_BYTES } from "./web-acceptance-config.js";

export const VERIFICATION_FEATURE = "run-verification.v1";
export const PRODUCT_STAGE_VERIFICATION_FEATURE = "product-stage-verification.v1";
export const VERIFICATION_CAPABILITIES_FEATURE = "verification-capabilities.v1";
export const MEASUREMENT_PLAN_FEATURE = "measurement-plan.v1";
export const MEASUREMENT_PLAN_V2_FEATURE = "measurement-plan.v2";
export interface VerificationProfile {
  id: string;
  project_id: string;
  workspace_root: string;
  commands: { id: string; argv: string[]; timeout_ms: number;
    observation?: { format: "static-web-acceptance.v1" | "static-web-acceptance.v2" | "static-web-acceptance.v3"; evidence_root?: string; capabilities?: { version: 1 } } }[];
  required_files: string[];
  subject_paths: string[];
  measurement_plan_policy?: MeasurementPlanPolicy;
}
interface FileFact { path: string; checksum: string; size: number }
export interface PreparedVerificationProfile extends Readonly<VerificationProfile> {
  readonly digest: string;
  readonly trustedFiles: readonly FileFact[];
  readonly capabilities?: VerificationCapabilities;
}
// Only preparation in this process can install execution options. Public metadata
// and serialized prepared profiles cannot manufacture this local authority.
const staticWebProfiles = new WeakMap<PreparedVerificationProfile, ReadonlyMap<string, PreparedStaticWebCapabilities>>();
const measurementPlanPolicies = new WeakMap<PreparedVerificationProfile, MeasurementPlanPolicy>();
const locallyPreparedProfiles = new WeakSet<PreparedVerificationProfile>();
const windowsProfileBackends = new WeakMap<PreparedVerificationProfile, PreparedWindowsProcessBackend>();
const exportableFinalVerifications = new WeakMap<RunVerificationPayload, { profile: PreparedVerificationProfile; requestId: string; context: string; payload: string }>();
// Loader provenance stays local: reserving the configuration file must not alter
// existing profile serialization, digests or remote capability contracts.
const profileConfigurationFiles = new WeakMap<VerificationProfile, string>();
const installedStaticWebCli = fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url));
const sha = (bytes: string | Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const MAX_FILES = 10_000, MAX_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
/** Redact before slicing so a truncation boundary cannot expose part of a secret. */
function redactOutput(output: Buffer): string {
  let text = output.toString("utf8");
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 6 && /key|token|secret|password|credential/i.test(key)) text = text.replaceAll(value, "[redacted]");
  }
  return text.replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential)\s*["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}
/** Bounded failure context for the next repair attempt; full output remains a digest. */
function diagnostics(stdout: Buffer, stderr: Buffer): string {
  const tail = [stdout.length ? `stdout: ${redactOutput(stdout).slice(-700)}` : "", stderr.length ? `stderr: ${redactOutput(stderr).slice(-700)}` : ""].filter(Boolean).join("\n");
  return tail.slice(-1500);
}

export interface VerificationPreviewResult {
  verification: RunVerificationPayload;
  diagnostics: { version: 1; commands: {
    command_id: string; output_digest: string;
    stdout_excerpt: string; stderr_excerpt: string; stdout_truncated: boolean; stderr_truncated: boolean;
  }[] };
}
function previewDiagnostic(commandId: string, outputDigest: string, stdout: Buffer, stderr: Buffer): VerificationPreviewResult["diagnostics"]["commands"][number] {
  const out = redactOutput(stdout), err = redactOutput(stderr);
  return { command_id: commandId, output_digest: outputDigest, stdout_excerpt: out.slice(-2048), stderr_excerpt: err.slice(-2048),
    stdout_truncated: out.length > 2048, stderr_truncated: err.length > 2048 };
}
function failureReason(summary: string, stdout: Buffer, stderr: Buffer): string {
  const tail = diagnostics(stdout, stderr);
  return `${summary}${tail ? `\n${tail}` : ""}`.slice(0, 2000);
}
const inside = (path: string, root: string): boolean => {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};
function fail(message: string): never { throw new Error(`Verification: ${message}`); }
function knownFields(value: object, allowed: readonly string[], label: string): void {
  if (Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(`unknown ${label} field`);
}
export function verificationSupported(): boolean { return process.platform === "linux" || process.platform === "darwin"; }
/** Local installation only. Neither serialization nor remote profile metadata can attach a backend. */
export function attachWindowsVerificationBackend(profile: PreparedVerificationProfile, backend: PreparedWindowsProcessBackend): void {
  if (!locallyPreparedProfiles.has(profile)) fail("Windows backend requires a locally prepared profile");
  assertTrusted(profile);
  assertWindowsProcessBackend(backend);
  if ([...(staticWebProfiles.get(profile)?.values() ?? [])].some(prepared => prepared.options.windows_browser_process)) {
    assertWindowsBrowserProcessInstallation(backend, profile.workspace_root);
  }
  const existing = windowsProfileBackends.get(profile);
  if (existing && existing !== backend) fail("Windows backend is already bound to this profile");
  windowsProfileBackends.set(profile, backend);
}
/** The node uses this exact local object when binding an adapter permit. */
export function readWindowsVerificationBackend(profile: PreparedVerificationProfile): PreparedWindowsProcessBackend | undefined {
  const backend = windowsProfileBackends.get(profile);
  if (!backend) return undefined;
  if (!locallyPreparedProfiles.has(profile)) fail("Windows backend requires a locally prepared profile");
  assertTrusted(profile);
  assertWindowsProcessBackend(backend);
  return backend;
}
function profileExecutionSupported(profile: PreparedVerificationProfile | undefined): boolean {
  return verificationSupported() || process.platform === "win32" && !!profile && readWindowsVerificationBackend(profile) !== undefined;
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) fail(`invalid ${field}`);
}
function relativePath(value: unknown): asserts value is string {
  text(value, "relative path");
  if (value.length > 1024 || isAbsolute(value) || value.includes("\\") || value.includes(":") || value.split("/").some((part) => !part || part === "." || part === "..")) fail("paths must be canonical relative paths");
}
function paths(value: unknown, field: string, nonempty = false): string[] {
  if (!Array.isArray(value) || value.length > 128 || (nonempty && value.length === 0)) fail(`invalid ${field}`);
  const result = value as unknown[];
  result.forEach(relativePath);
  if (new Set(result).size !== result.length) fail(`duplicate ${field}`);
  return [...result] as string[];
}
/** Reject links at every component beneath an already physical root. */
function scopedPath(root: string, path: string): string {
  relativePath(path);
  let current = root;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    if (!inside(current, root)) fail("path leaves workspace");
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail("symbolic links are unsupported");
  }
  return current;
}
function fileFact(path: string, label = path, maxSize = MAX_BYTES): FileFact {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxSize) fail("expected a bounded regular file without links");
  const windows = process.platform === "win32";
  const sameFile = (stat: Stats): void => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino
      || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || (!windows && stat.ctimeMs !== before.ctimeMs)) fail("file changed while reading");
  };
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const checkIdentity = (expectedCtime?: number): void => {
      const handle = fstatSync(fd), named = lstatSync(path);
      sameFile(handle); sameFile(named);
      if (expectedCtime !== undefined && (handle.ctimeMs !== expectedCtime || named.ctimeMs !== expectedCtime)) fail("file changed while reading");
    };
    checkIdentity();
    // The extra byte detects growth without allowing a concurrently growing file
    // to turn a bounded manifest read into an unbounded allocation or read loop.
    const buffer = Buffer.alloc(Math.min(64 * 1024, before.size + 1));
    const readDigest = (expectedCtime?: number): string => {
      const digest = createHash("sha256"); let length = 0;
      while (length <= before.size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - length), length);
        if (!count) break;
        digest.update(buffer.subarray(0, count)); length += count;
      }
      if (length !== before.size) fail("file changed while reading");
      checkIdentity(expectedCtime);
      return `sha256:${digest.digest("hex")}`;
    };
    const checksum = readDigest();
    // NTFS can commit deferred access metadata during the first read. Rebind
    // ctime before the second pass and require both handle and path to keep it:
    // equal digests alone miss writes after the final read. Never retry through
    // changed bytes or metadata that remains unstable on the second pass.
    if (windows) {
      const secondReadCtime = fstatSync(fd).ctimeMs;
      checkIdentity(secondReadCtime);
      if (readDigest(secondReadCtime) !== checksum) fail("file changed while reading");
    }
    return { path: label, checksum, size: before.size };
  } finally { closeSync(fd); }
}
function assertWorkspace(profile: PreparedVerificationProfile): void {
  const stat = lstatSync(profile.workspace_root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(profile.workspace_root) !== profile.workspace_root) fail("configured workspace identity changed");
}
function assertTrusted(profile: PreparedVerificationProfile): void {
  assertWorkspace(profile);
  for (const command of profile.commands) {
    const root = command.observation?.evidence_root;
    if (root && validateBrowserEvidenceRoot(root, [profile.workspace_root]) !== root) fail("browser evidence root identity changed");
  }
  for (const saved of profile.trustedFiles) {
    if (realpathSync.native(saved.path) !== saved.path || inside(saved.path, profile.workspace_root)) fail("verifier is no longer outside the workspace");
    const now = fileFact(saved.path, saved.path, 256 * 1024 * 1024);
    if (now.checksum !== saved.checksum || now.size !== saved.size) fail("administrator verifier changed; restart with reviewed configuration");
  }
}

/** A source-reader may only derive authority from an actual local preparation, never a JSON clone. */
export function assertLocallyPreparedVerificationProfile(profile: PreparedVerificationProfile): void {
  if (!locallyPreparedProfiles.has(profile)) fail("source reader requires a locally prepared profile");
  assertTrusted(profile);
}

/** Local configuration only. No command or file binding is accepted from a run. */
export function prepareVerificationProfiles(input: readonly VerificationProfile[] | undefined,
  writableRoots?: readonly string[]): readonly PreparedVerificationProfile[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > 64) fail("invalid profile list");
  const ids = new Set<string>();
  const prepared = input.map((raw: VerificationProfile) => {
    if (!raw || typeof raw !== "object") fail("invalid profile");
    text(raw.id, "profile id"); text(raw.project_id, "project id"); text(raw.workspace_root, "workspace root");
    if (raw.id.length > 128 || raw.project_id.length > 128) fail("profile/project id exceeds 128 characters");
    if (ids.has(raw.id)) fail("duplicate profile id"); ids.add(raw.id);
    // The runner passes these exact objects to its client. Reuse the protected
    // snapshot rather than reading a second configuration after advertising it.
    if (staticWebProfiles.has(raw as PreparedVerificationProfile) || windowsProfileBackends.has(raw as PreparedVerificationProfile)) {
      assertTrusted(raw as PreparedVerificationProfile);
      if (windowsProfileBackends.has(raw as PreparedVerificationProfile)) readWindowsVerificationBackend(raw as PreparedVerificationProfile);
      return raw as PreparedVerificationProfile;
    }
    if (!isAbsolute(raw.workspace_root) || !lstatSync(raw.workspace_root).isDirectory() || lstatSync(raw.workspace_root).isSymbolicLink()) fail("workspace must be an existing absolute directory");
    const root = realpathSync.native(raw.workspace_root);
    const required = paths(raw.required_files, "required files"), subjects = paths(raw.subject_paths, "subject paths", true);
    if (required.some((path) => !subjects.some((subject) => path === subject || path.startsWith(`${subject}/`)))) fail("required files must be covered by subject paths");
    if (!Array.isArray(raw.commands) || raw.commands.length === 0 || raw.commands.length > 32) fail("one to 32 commands are required");
    const optedIn = raw.commands.some((command) => command?.observation?.capabilities !== undefined);
    let measurementPolicy: MeasurementPlanPolicy | undefined;
    if (raw.measurement_plan_policy !== undefined) {
      const parsed = MeasurementPlanPolicySchema.safeParse(raw.measurement_plan_policy);
      if (!parsed.success || !optedIn) fail("measurement-plan policy requires a supported policy and installed capability-bound checks");
      measurementPolicy = Object.freeze(parsed.data.version === 2
        ? { ...parsed.data, methods: Object.freeze(parsed.data.methods) as unknown as typeof parsed.data.methods } : parsed.data);
      if (!subjects.includes("product") || !subjects.some((path) => path === ".artoo" || path === ".artoo/product")) {
        fail("measurement-plan policy must cover the complete product and product handoffs");
      }
    }
    if (optedIn) knownFields(raw, ["id", "project_id", "workspace_root", "commands", "required_files", "subject_paths", "measurement_plan_policy"], "capability profile");
    const files = new Map<string, FileFact>(), commandIds = new Set<string>();
    const staticWeb = new Map<string, PreparedStaticWebCapabilities>();
    const commands = raw.commands.map((command: VerificationProfile["commands"][number]) => {
      if (!command || typeof command !== "object") fail("invalid command");
      if (optedIn) knownFields(command, ["id", "argv", "timeout_ms", "observation"], "capability command");
      text(command.id, "command id");
      if (command.id.length > 128) fail("command id exceeds 128 characters");
      if (commandIds.has(command.id)) fail("duplicate command id"); commandIds.add(command.id);
      if (!Array.isArray(command.argv) || !command.argv.length || command.argv.length > 128) fail("invalid command argv");
      command.argv.forEach((arg: string) => text(arg, "command argument"));
      if (!Number.isSafeInteger(command.timeout_ms) || command.timeout_ms < 1 || command.timeout_ms > 600_000) fail("timeout must be 1 to 600000 milliseconds");
      let observation: VerificationProfile["commands"][number]["observation"];
      if (command.observation !== undefined) {
        const value = command.observation;
        if (!value || typeof value !== "object" || Array.isArray(value) || !["static-web-acceptance.v1", "static-web-acceptance.v2", "static-web-acceptance.v3"].includes(value.format)
          || Object.keys(value).some((key) => key !== "format" && key !== "evidence_root" && key !== "capabilities")) fail("invalid command observation format");
        if (value.format !== "static-web-acceptance.v1" && value.capabilities === undefined) {
          fail("version 2 and 3 browser observations require an opted-in installed verifier capability contract");
        }
        if (value.capabilities !== undefined) {
          if (!value.capabilities || typeof value.capabilities !== "object" || value.capabilities.version !== 1) fail("invalid observation capabilities version");
          knownFields(value.capabilities, ["version"], "observation capabilities");
          if (!value.evidence_root) fail("capability observation requires a protected evidence root");
        }
        if (value.evidence_root !== undefined) text(value.evidence_root, "browser evidence root");
        observation = Object.freeze({ format: value.format,
          ...(value.evidence_root !== undefined ? { evidence_root: validateBrowserEvidenceRoot(value.evidence_root, [root]) } : {}),
          ...(value.capabilities !== undefined ? { capabilities: Object.freeze({ version: 1 as const }) } : {}) });
      }
      const argv = [...command.argv];
      if (!isAbsolute(argv[0]!)) fail("executable must be absolute");
      const executableName = basename(argv[0]!).toLowerCase().replace(/\.exe$/, "");
      if (/^(?:sh|bash|zsh|dash|cmd|powershell|pwsh|npm|npx|yarn|pnpm)$/.test(executableName)) fail("shell and package-manager launchers are unsupported; configure an external verifier script");
      if (/^(?:node|nodejs|python(?:\d(?:\.\d+)?)?|ruby|perl|bun|deno)$/.test(executableName) && (!argv[1] || !isAbsolute(argv[1]))) fail("interpreters require an absolute external script as their first argument");
      for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]!;
        if (!isAbsolute(arg)) {
          if (/\.(?:[cm]?js|py|rb|pl|ps1|sh|cmd|bat)$/i.test(arg)) fail("script arguments must be absolute external files");
          continue;
        }
        const physical = realpathSync.native(arg);
        if (inside(physical, root)) fail("verifier executable and scripts must be outside coding workspace");
        const fact = fileFact(physical, physical, 256 * 1024 * 1024);
        files.set(physical, fact); argv[index] = physical;
      }
      if (observation?.capabilities) {
        if (argv.length !== 3 || argv[0] !== realpathSync.native(process.execPath)
          || argv[1] !== realpathSync.native(installedStaticWebCli) || !isAbsolute(argv[2]!)) {
          fail("capabilities require exactly the installed Node static-web CLI and an absolute configuration file");
        }
        const configFact = fileFact(argv[2]!, argv[2], STATIC_WEB_MAX_CONFIG_BYTES), bytes = readFileSync(argv[2]!);
        if (sha(bytes) !== configFact.checksum || configFact.checksum !== files.get(argv[2]!)?.checksum) fail("static-web configuration changed while preparing");
        const options = normalizeWebAcceptanceOptions(JSON.parse(bytes.toString("utf8")));
        if (options.windows_browser_process && process.platform !== "win32") fail("Windows browser Job profiles require Windows");
        if (!options.evidence_root) fail("capability configuration requires a protected evidence root");
        options.evidence_root = validateBrowserEvidenceRoot(options.evidence_root, [root]);
        if (options.evidence_root !== observation.evidence_root) fail("capability configuration and observation evidence roots differ");
        if (options.browser_executable) {
          options.browser_executable = realpathSync.native(options.browser_executable);
          if (inside(options.browser_executable, root)) fail("browser executable must be outside coding workspace");
          files.set(options.browser_executable, fileFact(options.browser_executable, options.browser_executable, 256 * 1024 * 1024));
        }
        const prepared = prepareStaticWebCapabilities(options);
        if (observation.format !== `static-web-acceptance.v${prepared.contract.version}`) {
          fail("browser observation format differs from the configured program version");
        }
        staticWeb.set(command.id, prepared);
      }
      return Object.freeze({ id: command.id, argv: Object.freeze(argv) as unknown as string[], timeout_ms: command.timeout_ms,
        ...(observation ? { observation } : {}) });
    });
    if (measurementPolicy?.version === 2 && (!staticWeb.size || [...staticWeb.values()].some(check => check.contract.version !== 3)
      || commands.some(command => command.observation && command.observation.format !== "static-web-acceptance.v3"))) {
      fail("v2 measurement-plan policy requires installed v3 browser checks");
    }
    const value: VerificationProfile = { id: raw.id, project_id: raw.project_id, workspace_root: root,
      commands, required_files: Object.freeze(required) as unknown as string[], subject_paths: Object.freeze(subjects) as unknown as string[],
      ...(measurementPolicy ? { measurement_plan_policy: measurementPolicy } : {}) };
    const trustedFiles = Object.freeze([...files.values()].sort((a, b) => a.path.localeCompare(b.path)).map((fact) => Object.freeze(fact)));
    // Keep the legacy serialization byte-for-byte unchanged. Capability digests
    // are derived afterward so the profile/config/contract bindings cannot cycle.
    const digest = sha(JSON.stringify({ ...value, trustedFiles }));
    const capabilities: VerificationCapabilities | undefined = staticWeb.size ? Object.freeze({ version: 1, profile_digest: digest,
      checks: Object.freeze([...staticWeb].map(([command_id, prepared]) => Object.freeze({ command_id,
        config_digest: prepared.config_digest, contract_digest: prepared.contract_digest, contract: prepared.contract }))) as unknown as VerificationCapabilities["checks"],
      ...(measurementPolicy ? { measurement_plan_policy: measurementPolicy } : {}) }) : undefined;
    const profile = Object.freeze({ ...value, commands: Object.freeze(commands) as unknown as typeof commands,
      trustedFiles, digest, ...(capabilities ? { capabilities } : {}) });
    const configurationFile = profileConfigurationFiles.get(raw);
    if (configurationFile) profileConfigurationFiles.set(profile, configurationFile);
    if (capabilities) staticWebProfiles.set(profile, staticWeb);
    if (measurementPolicy) measurementPlanPolicies.set(profile, measurementPolicy);
    locallyPreparedProfiles.add(profile);
    return profile;
  });
  for (let index = 0; index < prepared.length; index++) {
    const root = prepared[index]!.workspace_root;
    if (prepared.slice(index + 1).some((other) => inside(root, other.workspace_root) || inside(other.workspace_root, root))) {
      fail("profile workspaces must be non-overlapping; configure one profile per workspace");
    }
  }
  if (prepared.some((profile) => profile.trustedFiles.some((file) => prepared.some((other) => inside(file.path, other.workspace_root))))) fail("verifier files must be outside all configured coding workspaces");
  for (const profile of prepared) for (const command of profile.commands) {
    if (command.observation?.evidence_root) validateBrowserEvidenceRoot(command.observation.evidence_root, prepared.map((item) => item.workspace_root));
  }
  // Verifiers must be outside every ordinary task write root, including roots
  // that are not dedicated profile workspaces. Recheck even prepared objects.
  if (prepared.length && writableRoots !== undefined) {
    for (const root of physicalWritableRoots(writableRoots)) for (const profile of prepared) assertVerificationAssetBoundary(profile, root);
  }
  return Object.freeze(prepared);
}

export function loadVerificationProfilesFile(path: string, writableRoots?: readonly string[]): VerificationProfile[] {
  text(path, "profiles file");
  if (!isAbsolute(path)) fail("profiles file must be absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail("invalid profiles file");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) fail("profiles file must contain a JSON array");
  const physical = realpathSync.native(path);
  const profiles = parsed as VerificationProfile[];
  // Validate before a worker connects, and do not trust configuration writable by its agent.
  const prepared = prepareVerificationProfiles(profiles, writableRoots);
  if (prepared.some((profile) => inside(physical, profile.workspace_root))) fail("profiles file must be outside every coding workspace");
  if (writableRoots !== undefined && physicalWritableRoots(writableRoots).some(root => inside(physical, root))) {
    fail("profiles file must be outside every writable root");
  }
  for (const profile of profiles) profileConfigurationFiles.set(profile, physical);
  return profiles;
}

/** Read-only local authority used for model context; private paths never leave preparation. */
export function readVerificationCapabilities(profile: PreparedVerificationProfile): VerificationCapabilitiesContext | undefined {
  if (!profile.capabilities) return undefined;
  if (!staticWebProfiles.has(profile)) fail("capabilities require a locally prepared profile");
  assertTrusted(profile);
  return Object.freeze({ ...profile.capabilities, profile_id: profile.id });
}

function assertCapabilityContext(profile: PreparedVerificationProfile, context: RunStartPayload["context_pack"]["payload"]): void {
  const expected = readVerificationCapabilities(profile), supplied = context?.verification_capabilities;
  if (!expected) { if (supplied !== undefined) fail("capability context requires an opted-in local profile"); return; }
  const parsed = VerificationCapabilitiesContextSchema.safeParse(supplied);
  if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(VerificationCapabilitiesContextSchema.parse(expected))) {
    fail("verification capability context differs from the protected profile");
  }
}

function assertReleaseContext(profile: PreparedVerificationProfile, context: RunStartPayload["context_pack"]["payload"],
  read: ReleaseCapabilityReader | undefined) {
  const release = assertReleaseCapabilityContext(context, read);
  if (release && (release.binding.verification_profile_id !== profile.id || release.binding.verification_profile_digest !== profile.digest
    || release.binding.project_id !== profile.project_id || release.binding.workspace_root !== profile.workspace_root
    || profile.measurement_plan_policy?.version !== 2)) fail("release capability binding differs from the protected profile");
  return release;
}

function commandCapabilityBinding(profile: PreparedVerificationProfile, commandId: string): StaticWebCapabilityBinding | undefined {
  const prepared = staticWebProfiles.get(profile)?.get(commandId);
  if (!prepared) return undefined;
  return { version: 1, command_id: commandId, profile_digest: profile.digest,
    config_digest: prepared.config_digest, contract_digest: prepared.contract_digest };
}

export function selectVerificationProfile(payload: RunStartPayload, profiles: readonly PreparedVerificationProfile[], managed: boolean,
  readReleaseCapabilities?: ReleaseCapabilityReader, computerId?: string): PreparedVerificationProfile | undefined {
  assertProductDesignRevisionRun(payload, computerId);
  if (!payload.verification) {
    if (payload.context_pack.payload?.verification_capabilities !== undefined) fail("capability context requires node verification authority");
    assertReleaseCapabilityContext(payload.context_pack.payload, readReleaseCapabilities);
    if (readReleaseCapabilities) fail("release capabilities require node verification authority");
    return undefined;
  }
  const profile = profiles.find((item) => item.id === payload.verification!.profile_id);
  if (!profileExecutionSupported(profile)) fail("run verification requires Linux or macOS process-group control, or an explicitly bound Windows backend");
  if (managed || payload.workspace.branch != null || payload.workspace_allocation) fail("verification supports only ordinary, non-managed workspaces");
  if (!profile) fail("requested administrator profile is unavailable");
  const context = payload.context_pack.payload;
  if (!context || context.project.id !== profile.project_id || context.task.id !== payload.task_id || context.workspace.root !== payload.workspace.root) fail("verification project/task context mismatch");
  if (realpathSync.native(payload.workspace.root) !== profile.workspace_root || payload.workspace.root !== profile.workspace_root) fail("verification workspace mismatch");
  if (context.policy.execution_mode === "discussion" && !payload.verification.expected_subject_digest) fail("verified discussion requires an exact source digest");
  assertCapabilityContext(profile, context);
  const release = assertReleaseContext(profile, context, readReleaseCapabilities);
  if (release ? !isDeepStrictEqual(payload.verification.release_capability_binding, release.binding) : payload.verification.release_capability_binding !== undefined) {
    fail("release capability binding differs from the protected profile");
  }
  if (profile.capabilities) {
    const expected = { version: 1, profile_digest: profile.digest,
      checks: profile.capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
    const parsed = VerificationCapabilityBindingSchema.safeParse(payload.verification.capability_binding);
    if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(VerificationCapabilityBindingSchema.parse(expected))) {
      fail("verification capability binding differs from the protected profile");
    }
  } else if (payload.verification.capability_binding !== undefined) fail("capability binding requires an opted-in local profile");
  assertProductSubjectCoverage(profile, context);
  assertTrusted(profile);
  assertAcceptedProductInputs(profile.workspace_root, context);
  if (readProductDesignRevision(context)) {
    assertProductDesignRevisionVerificationProfile(profile);
    assertProductDesignRevisionBaseline(context, readProductFile(profile.workspace_root, ".artoo/product/research.json"));
  }
  if (payload.verification.expected_subject_digest) assertVerificationSubject(profile, payload.verification.expected_subject_digest);
  return profile;
}

function productStage(context: RunStartPayload["context_pack"]["payload"]) {
  const authored = context?.product_development?.stage, reviewed = context?.review_subject?.development_stage;
  if (authored && reviewed && authored !== reviewed) fail("author and review stage bindings differ");
  const stage = authored ?? reviewed;
  if (stage === undefined) return undefined;
  const parsed = DevelopmentStageSchema.safeParse(stage);
  if (!parsed.success) fail("unsupported product development stage");
  return parsed.data;
}
function assertProductSubjectCoverage(profile: PreparedVerificationProfile, context: RunStartPayload["context_pack"]["payload"]): void {
  const stage = productStage(context);
  if (profile.measurement_plan_policy !== undefined && !measurementPlanPolicies.has(profile)) fail("measurement-plan policy requires a locally prepared profile");
  if (measurementPlanPolicies.has(profile) && !stage) fail("measurement-plan policy requires a recognized author or review product stage");
  if (!stage) return;
  if (!profile.subject_paths.some((path) => path === ".artoo" || path === ".artoo/product")) fail("product stage verification must include .artoo/product handoffs in subject paths");
  if (!profile.subject_paths.includes("product")) fail("product stage verification must include the complete product directory");
}

const researchIssueFields = new Set([
  "version", "objective", "assumptions", "requirements", "id", "description", "priority", "acceptance_criteria",
  "sources", "url", "title", "retrieved_at", "content_digest", "findings", "summary", "source_ids", "decisions",
  "question", "decision", "rationale", "measurement_plan", "profile_digest", "entries", "requirement_id", "criterion_index",
  "method", "release_binding", "release_profile_id", "release_profile_digest", "project_id", "workspace_root",
  "verification_profile_id", "verification_profile_digest", "claim_id", "statement_digest",
  "command_id", "config_digest", "contract_digest", "actions", "keys", "viewports", "width", "height", "needs", "kind",
  "scope", "max_created", "same_origin", "same_browser_context", "mode", "invariant", "page_scope", "api_scope", "percentage",
]);
const researchIssueCodes = new Set([
  "invalid_type", "invalid_literal", "custom", "invalid_union", "invalid_union_discriminator", "invalid_enum_value",
  "unrecognized_keys", "invalid_arguments", "invalid_return_type", "invalid_date", "invalid_string", "too_small", "too_big",
  "invalid_intersection_types", "not_multiple_of", "not_finite",
]);
const researchExpectedTypes = new Set(["string", "number", "integer", "boolean", "array", "object", "null", "undefined"]);
interface ResearchSchemaIssue {
  code: string; path: readonly PropertyKey[]; expected?: unknown; values?: readonly unknown[]; discriminator?: unknown;
}

/** Keep the v1 diagnostic vocabulary across Zod versions without exposing schema values or input. */
function researchIssueCode(issue: ResearchSchemaIssue): string {
  if (issue.code === "invalid_value") {
    // Only the count is needed: the fixed research schemas use singleton literals and multi-value enums.
    if (!Array.isArray(issue.values) || issue.values.length === 0) return "custom";
    return issue.values.length === 1 ? "invalid_literal" : "invalid_enum_value";
  }
  if (issue.code === "invalid_format") return "invalid_string";
  if (issue.code === "invalid_union" && typeof issue.discriminator === "string") return "invalid_union_discriminator";
  return researchIssueCodes.has(issue.code) ? issue.code : "custom";
}

/** Project schema facts only: Zod messages, custom values and unknown keys may contain product input. */
function researchSchemaFailure(issues: readonly ResearchSchemaIssue[]): string {
  const prefix = "measurement-plan research does not satisfy its versioned report contract";
  const safe: { path: (string | number)[]; code: string; expected?: string }[] = [];
  const reason = () => `${prefix}: ${JSON.stringify({ version: 1, format: "artoo-research-schema-issues.v1",
    file: ".artoo/product/research.json", issues: safe, omitted_issues: issues.length - safe.length })}`;
  for (const issue of issues.slice(0, 8)) {
    const path = issue.path.slice(0, 8).map(segment => typeof segment === "number"
      ? Number.isSafeInteger(segment) && segment >= 0 && segment <= 10000 ? segment : "<index>"
      : typeof segment === "string" && segment.length <= 32 && researchIssueFields.has(segment) ? segment : "<field>");
    if (issue.path.length > 8) path[7] = "<truncated>";
    const code = researchIssueCode(issue);
    const expectedType = issue.expected === "int" ? "integer" : issue.expected;
    const expected = code === "invalid_type" && typeof expectedType === "string" && researchExpectedTypes.has(expectedType)
      ? expectedType : code === "invalid_literal" ? "literal"
        : code === "invalid_enum_value" || code === "invalid_union_discriminator" ? "enum"
          : code === "invalid_union" ? "union" : undefined;
    safe.push({ path, code, ...(expected === undefined ? {} : { expected }) });
    // Include fail()'s prefix, and remove whole objects rather than truncating JSON in the outer catch.
    if (`Verification: ${reason()}`.length >= 1800) { safe.pop(); break; }
  }
  return reason();
}

/** Derive only declared feasibility from the same bounded bytes in the measured subject. */
function measureDeclaredPlan(profile: PreparedVerificationProfile, files: ReadonlyMap<string, FileFact>,
  scope: VerificationObservation["scope"], readReleaseCapabilities?: ReleaseCapabilityReader,
  root = profile.workspace_root, effectiveForeignPlan?: ProductMeasurementPlan, foreignDesign = false): MeasurementPlanSummary | undefined {
  const policy = measurementPlanPolicies.get(profile);
  if (!policy) return undefined;
  const path = ".artoo/product/research.json", measured = files.get(path);
  if (!measured || !profile.capabilities) fail("measurement-plan policy requires measured research and configured capabilities");
  const bytes = readProductFile(root, path);
  if (sha(bytes) !== measured.checksum || bytes.length !== measured.size) fail("measurement-plan research differs from the measured source");
  let json: unknown;
  try { json = JSON.parse(bytes.toString("utf8")); } catch { fail("measurement-plan research must be valid JSON"); }
  // Select by the protected policy, preserving precise diagnostics and v2 criterion bytes.
  // The author cannot choose the legacy trimming/parser branch to weaken a new contract.
  const research = (policy.version === 2 ? ProductResearchReportV2Schema : ProductResearchReportV1Schema).safeParse(json);
  if (!research.success) fail(researchSchemaFailure(research.error.issues));
  if (effectiveForeignPlan) {
    if (effectiveForeignPlan.version !== policy.version || !foreignDesign && scope !== "final" || policy.version === 2 && !readReleaseCapabilities) {
      fail("foreign measurement requires its admitted final research policy and local release reader");
    }
    // Replace only the parsed in-memory plan. The original report bytes remain
    // pinned in the subject and the private admission at every command boundary.
    research.data.measurement_plan = effectiveForeignPlan;
  }
  if (policy.version === 2) {
    const { canonical_plan, ...facts } = evaluateDeclaredMeasurementPlanV2({ research: research.data, policy,
      capabilities: profile.capabilities, releaseCapabilities: readReleaseCapabilities?.(), digest: sha });
    return MeasurementPlanSummaryV2Schema.parse({ version: 2, claim: "declared-mapping-feasibility", scope,
      policy, research: measured, measurement_plan_digest: sha(canonical_plan), ...facts });
  }
  const { canonical_plan, ...facts } = evaluateDeclaredMeasurementPlanV1({ research: research.data, policy, capabilities: profile.capabilities });
  return MeasurementPlanSummaryV1Schema.parse({ version: 1, claim: "declared-mapping-feasibility", scope,
    policy, research: measured, measurement_plan_digest: sha(canonical_plan), ...facts });
}

/** Local publisher re-measures the same protected contract against workspace or copied immutable bytes. */
export function measureReleaseAcceptancePlan(profile: PreparedVerificationProfile, root: string,
  read: ReleaseCapabilityReader): MeasurementPlanSummaryV2 {
  assertTrusted(profile);
  const capability = read();
  if (capability.binding.verification_profile_id !== profile.id || capability.binding.verification_profile_digest !== profile.digest
    || capability.binding.project_id !== profile.project_id || capability.binding.workspace_root !== profile.workspace_root) fail("release verifier binding changed");
  const measured = subjectManifest({ ...profile, workspace_root: root });
  const summary = measureDeclaredPlan(profile, measured.files, "final", read, root);
  if (summary?.version !== 2) fail("release acceptance requires a measured v2 plan");
  read(); return summary;
}

/** Resolve missing targets through their existing physical ancestor, never a lexical alias. */
function physicalTarget(path: string): string {
  text(path, "workspace path");
  if (!isAbsolute(path) || path.split(sep).some((part) => part === "." || part === "..")) fail("workspace path must be absolute without dot segments");
  let existing = path;
  const suffix: string[] = [];
  for (;;) {
    try { lstatSync(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) fail("workspace has no existing ancestor");
      suffix.unshift(basename(existing)); existing = parent;
    }
  }
  return resolve(realpathSync.native(existing), ...suffix);
}

function physicalWritableRoots(roots: readonly string[]): readonly string[] {
  if (!Array.isArray(roots)) fail("writable roots must be an array");
  return roots.map(root => {
    text(root, "writable root");
    if (!isAbsolute(root)) fail("writable roots must be absolute");
    return physicalTarget(root);
  });
}

/** Ordinary task roots cannot contain verifier inputs or overlap evidence storage. */
function assertVerificationAssetBoundary(profile: PreparedVerificationProfile, target: string): void {
  const configurationFile = profileConfigurationFiles.get(profile);
  const files = [...profile.trustedFiles.map(file => file.path), ...(configurationFile ? [configurationFile] : [])];
  if (files.some(file => inside(file, target) || inside(target, file))
    || profile.commands.some(command => {
      const evidence = command.observation?.evidence_root;
      return evidence !== undefined && (inside(evidence, target) || inside(target, evidence));
    })) fail("workspace overlaps protected verification files or evidence; ordinary writes are not permitted");
}

/** Profiles reserve their workspace and protected assets even between autonomous runs. */
export function assertVerificationWorkspaceBoundary(payload: RunStartPayload, profiles: readonly PreparedVerificationProfile[], restrictedDiscussionAdapter: boolean): void {
  if (!profiles.length) return;
  const target = physicalTarget(payload.workspace.root);
  for (const profile of profiles) {
    assertWorkspace(profile);
    assertVerificationAssetBoundary(profile, target);
    if (!inside(target, profile.workspace_root) && !inside(profile.workspace_root, target)) continue;
    const context = payload.context_pack.payload;
    const readOnlyDiscussion = target === profile.workspace_root && restrictedDiscussionAdapter && context?.policy.execution_mode === "discussion"
      && context.policy.filesystem_write_scope.length === 0 && context.project.id === profile.project_id
      && context.workspace.root === payload.workspace.root && payload.workspace.branch == null && !payload.workspace_allocation;
    if (readOnlyDiscussion) continue;
    if (!payload.verification || payload.verification.profile_id !== profile.id || target !== profile.workspace_root) {
      fail("workspace overlaps a dedicated verification directory; ordinary writes are not permitted");
    }
  }
}

/** Canonical content manifest includes empty directories; links and missing paths fail closed. */
export function subjectManifest(profile: PreparedVerificationProfile): { digest: string; files: Map<string, FileFact>; directories: string[] } {
  assertWorkspace(profile);
  const entries = new Map<string, { path: string; kind: "directory" } | (FileFact & { kind: "file" })>();
  let bytes = 0;
  const walk = (path: string): void => {
    if (entries.has(path)) return;
    if (entries.size >= MAX_FILES) fail("subject exceeds file-count limit");
    const absolute = scopedPath(profile.workspace_root, path), stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      entries.set(path, { path, kind: "directory" });
      const children = readdirSync(absolute).sort();
      for (const child of children) walk(`${path}/${child}`);
    } else {
      const fact = fileFact(absolute, path, MAX_BYTES - bytes); bytes += fact.size;
      entries.set(path, { ...fact, kind: "file" });
    }
  };
  [...profile.subject_paths].sort().forEach(walk);
  const sorted = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  const files = new Map(sorted.flatMap((item) => item.kind === "file" ? [[item.path, { path: item.path, checksum: item.checksum, size: item.size }] as const] : []));
  return { digest: sha(JSON.stringify(sorted)), files, directories: sorted.filter((item) => item.kind === "directory").map((item) => item.path) };
}

/** Review and publication are admitted only for the exact measured source version. */
export function assertVerificationSubject(profile: PreparedVerificationProfile, expectedDigest: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) fail("invalid expected source digest");
  assertTrusted(profile);
  if (subjectManifest(profile).digest !== expectedDigest) fail("source changed since the verified run");
}

export async function runVerification(profile: PreparedVerificationProfile, requestId: string, signal: AbortSignal,
  context?: RunStartPayload["context_pack"]["payload"], expectedSubjectDigest?: string,
  readReleaseCapabilities?: ReleaseCapabilityReader): Promise<RunVerificationPayload> {
  if (context?.transferred_product_input) fail("Imported design requires its original dedicated verifier admission");
  const originalContext = JSON.stringify(context ?? null);
  const result = await executeVerification(profile, requestId, signal, context, expectedSubjectDigest, "final", undefined, readReleaseCapabilities);
  if (result.outcome === "passed" && !signal.aborted && locallyPreparedProfiles.has(profile) && JSON.stringify(context ?? null) === originalContext) {
    exportableFinalVerifications.set(result, { profile, requestId, context: originalContext, payload: JSON.stringify(result) });
  }
  return result;
}

/** A distinct entry point prevents mapped foreign results from minting local export provenance. */
export async function runTransferredResearchVerification(profile: PreparedVerificationProfile, requestId: string, signal: AbortSignal,
  context: NonNullable<RunStartPayload["context_pack"]["payload"]>, expectedSubjectDigest: string,
  admission: PreparedProductSourceVerificationAdmission): Promise<RunVerificationPayload> {
  const { readProductSourceVerificationAdmission } = await import("./product-source-runtime.js");
  const read = () => readProductSourceVerificationAdmission(admission, profile, requestId, context);
  const admitted = read();
  if (context.product_development?.stage !== "research" || context.review_subject || context.imported_review_subject
    || profile.commands.some(command => !staticWebProfiles.get(profile)?.has(command.id))) fail("foreign research requires only installed capability-bound checks");
  const result = await executeVerification(profile, requestId, signal, context, expectedSubjectDigest, "final", undefined, admitted.readReleaseCapabilities, read);
  read();
  return result;
}

/** Local export input only. Serialized/preview/forged receipts never acquire this provenance. */
export function assertFinalVerificationExportBinding(profile: PreparedVerificationProfile, evidence: RunVerificationPayload,
  requestId: string, context: NonNullable<RunStartPayload["context_pack"]["payload"]>): void {
  const binding = exportableFinalVerifications.get(evidence);
  assertLocallyPreparedVerificationProfile(profile);
  if (!binding || binding.profile !== profile || binding.requestId !== requestId || binding.context !== JSON.stringify(context)
    || binding.payload !== JSON.stringify(evidence) || evidence.outcome !== "passed" || !evidence.subject_digest) {
    fail("export requires the original completed final verification and exact context");
  }
}

/** Local author diagnostics do not emit a run event or create a release attestation. */
export async function runVerificationPreview(profile: PreparedVerificationProfile, requestId: string, signal: AbortSignal,
  context?: RunStartPayload["context_pack"]["payload"], expectedSubjectDigest?: string,
  readReleaseCapabilities?: ReleaseCapabilityReader): Promise<VerificationPreviewResult> {
  if (context?.transferred_product_input) fail("Imported design preview requires its original dedicated verifier admission");
  const diagnostics: VerificationPreviewResult["diagnostics"] = { version: 1, commands: [] };
  const verification = await executeVerification(profile, requestId, signal, context, expectedSubjectDigest, "preview", diagnostics.commands, readReleaseCapabilities);
  return { verification, diagnostics };
}

/** A changed design subject retains the exact imported research and original local owner. */
export function assertImportedDesignVerificationProfile(profile: PreparedVerificationProfile): void {
  assertTrusted(profile);
  if (process.platform !== "win32" || !readWindowsVerificationBackend(profile)
    || profile.capabilities?.measurement_plan_policy?.version !== 2 || !profile.commands.length
    || profile.commands.some(command => { const prepared = staticWebProfiles.get(profile)?.get(command.id);
      return !prepared || !isV3WebAcceptanceOptions(prepared.options) || !prepared.options.windows_browser_process; })) {
    fail("Imported design requires an original native Windows Job verifier with protected policy-v2 v3 checks");
  }
}

/** Public capability metadata alone cannot select the native executor or all-case design policy. */
export function assertProductDesignRevisionVerificationProfile(profile: PreparedVerificationProfile): void {
  assertTrusted(profile);
  if (process.platform !== "win32" || !readWindowsVerificationBackend(profile)
    || profile.capabilities?.measurement_plan_policy?.version !== 2 || !profile.commands.length
    || profile.commands.some(command => { const prepared = staticWebProfiles.get(profile)?.get(command.id);
      return !prepared || !isV3WebAcceptanceOptions(prepared.options) || !prepared.options.windows_browser_process
        || !prepared.options.design_capture_cases || command.observation?.format !== "static-web-acceptance.v3"; })) {
    fail("Design revision requires a locally prepared native Windows Job verifier running all policy-v2 design cases");
  }
}

/** Discovery uses only original prepared profiles and withdraws support when local qualification fails. */
export function productDesignRevisionVerificationSupported(profile: PreparedVerificationProfile): boolean {
  try { assertProductDesignRevisionVerificationProfile(profile); return true; } catch { return false; }
}

export async function runTransferredDesignVerification(profile: PreparedVerificationProfile, requestId: string, signal: AbortSignal,
  context: NonNullable<RunStartPayload["context_pack"]["payload"]>, permit: PreparedImportedDesignContinuation): Promise<RunVerificationPayload> {
  const { readImportedDesignVerificationAdmission: readAdmission } = await import("./product-source-runtime.js");
  assertImportedDesignVerificationProfile(profile);
  const read = () => readAdmission(permit, profile, requestId, context, "final"), admitted = read();
  if (context.product_development?.stage !== "design" || context.review_subject || context.imported_review_subject
    || profile.commands.some(command => !staticWebProfiles.get(profile)?.has(command.id))) fail("Imported design requires installed capability-bound checks");
  const result = await executeVerification(profile, requestId, signal, context, undefined, "final", undefined, admitted.readReleaseCapabilities, undefined, read);
  read(); return result;
}

/** Preview remains diagnostic and never registers exportable final verification. */
export async function runTransferredDesignVerificationPreview(profile: PreparedVerificationProfile, requestId: string, signal: AbortSignal,
  context: NonNullable<RunStartPayload["context_pack"]["payload"]>, permit: PreparedImportedDesignContinuation): Promise<VerificationPreviewResult> {
  const { readImportedDesignVerificationAdmission: readAdmission } = await import("./product-source-runtime.js");
  assertImportedDesignVerificationProfile(profile);
  const read = () => readAdmission(permit, profile, requestId, context, "preview"), admitted = read();
  if (context.product_development?.stage !== "design" || context.review_subject || context.imported_review_subject
    || profile.commands.some(command => !staticWebProfiles.get(profile)?.has(command.id))) fail("Imported design preview requires installed capability-bound checks");
  const diagnostics: VerificationPreviewResult["diagnostics"] = { version: 1, commands: [] };
  const verification = await executeVerification(profile, requestId, signal, context, undefined, "preview", diagnostics.commands, admitted.readReleaseCapabilities, undefined, read);
  read(); return { verification, diagnostics };
}

async function executeVerification(profile: PreparedVerificationProfile, requestId: string, signal: AbortSignal,
  context: RunStartPayload["context_pack"]["payload"] | undefined, expectedSubjectDigest: string | undefined,
  scope: VerificationObservation["scope"], previewCommands?: VerificationPreviewResult["diagnostics"]["commands"],
  readReleaseCapabilities?: ReleaseCapabilityReader,
  readSemanticAdmission?: () => ReturnType<typeof inspectProductSourceVerificationEnvelope>,
  readDesignAdmission?: () => ReturnType<typeof readImportedDesignVerificationAdmission>): Promise<RunVerificationPayload> {
  const result: RunVerificationPayload = { version: 1, request_id: requestId, profile_id: profile.id, profile_digest: profile.digest,
    subject_digest: null, outcome: "failed", checks: [], required_files: [] };
  const reports: { checkIndex: number; command: PreparedVerificationProfile["commands"][number]; report: StaticWebAcceptanceReport }[] = [];
  let contextDirectory: string | undefined;
  let cleanupConfirmed = true;
  try {
    if (!profileExecutionSupported(profile)) fail("unsupported verification platform");
    assertTrusted(profile);
    assertCapabilityContext(profile, context);
    assertReleaseContext(profile, context, readReleaseCapabilities);
    assertProductSubjectCoverage(profile, context);
    const before = subjectManifest(profile); result.subject_digest = before.digest;
    if (expectedSubjectDigest && before.digest !== expectedSubjectDigest) fail("source changed since the verified run");
    assertAcceptedProductInputs(profile.workspace_root, context, before.files);
    const revision = readProductDesignRevision(context);
    if (revision) assertProductDesignRevisionVerificationProfile(profile);
    const revisionEvidence = revision ? inspectProductDesignRevision(context,
      readProductFile(profile.workspace_root, ".artoo/product/research.json"), readProductFile(profile.workspace_root, ".artoo/product/design.json")) : undefined;
    const stage = productStage(context);
    const requiredFiles = [...new Set([...profile.required_files, ...(stage ? productStageHandoffPaths(stage) : [])])];
    result.required_files = requiredFiles.map((path) => {
      const fact = before.files.get(path); if (!fact) fail("required file is absent or not regular"); return fact;
    });
    // This candidate has no authority until every protected command exits and
    // the unchanged subject, accepted inputs, evidence and cleanup are confirmed.
    const semantic = readSemanticAdmission?.();
    const designAdmission = readDesignAdmission?.();
    if (semantic && designAdmission || !!context?.transferred_product_input !== !!designAdmission) fail("Imported verifier admission scope differs");
    const design = designAdmission ? inspectImportedDesignVerificationEnvelopeV1({ version: 1, request: designAdmission.request,
      request_digest: designAdmission.request_digest, run_id: designAdmission.request.run_start.run_id, verification_request_id: requestId,
      scope, subject_digest: before.digest }, readProductFile(profile.workspace_root, ".artoo/product/research.json"), sha) : undefined;
    const measurementPlan = measureDeclaredPlan(profile, before.files, scope, readReleaseCapabilities, profile.workspace_root,
      semantic?.effective_plan ?? design?.research.measurement_plan, !!design);
    contextDirectory = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-verification-context-"));
    if (inside(contextDirectory, profile.workspace_root)) fail("no context location outside coding workspace");
    chmodSync(contextDirectory, 0o700);
    const contextFile = join(contextDirectory, "context.json");
    writeFileSync(contextFile, JSON.stringify({ version: 1, request_id: requestId, profile_id: profile.id, scope,
      profile_digest: profile.digest, subject_digest: before.digest, context: context ?? null }), { mode: 0o400, flag: "wx" });
    for (const command of profile.commands) {
      if (signal.aborted) { result.outcome = "cancelled"; result.reason = "Verification cancelled"; return result; }
      assertTrusted(profile);
      assertReleaseContext(profile, context, readReleaseCapabilities);
      readSemanticAdmission?.();
      readDesignAdmission?.();
      try {
        const prepared = staticWebProfiles.get(profile)?.get(command.id), capabilityBinding = commandCapabilityBinding(profile, command.id);
        const privateDeadline = prepared?.options.windows_browser_process ? performance.now() + command.timeout_ms : undefined;
        let privateContextSha256: string | undefined;
        let commandContextFile = contextFile;
        if (prepared && capabilityBinding) {
          // Each command receives its own locally derived ID and immutable options;
          // neither remote context nor stdout can select an execution snapshot.
          commandContextFile = join(contextDirectory, `command-${result.checks.length}.json`);
          const browserBackend = prepared.options.windows_browser_process ? readWindowsVerificationBackend(profile) : undefined;
          if (prepared.options.windows_browser_process && !browserBackend) fail("Windows browser Job profile lacks its local backend");
          const browserProcess = prepared.options.windows_browser_process
            ? createWindowsBrowserProcessDescriptor(browserBackend!, {
              request_id: requestId, command_id: command.id, profile_digest: profile.digest,
              subject_digest: before.digest, workspace_root: profile.workspace_root,
            }) : undefined;
          const envelope = { version: 1, request_id: requestId, profile_id: profile.id, scope,
            profile_digest: profile.digest, subject_digest: before.digest, context: context ?? null,
            ...(semantic ? { product_source_verification: semantic.envelope } : {}),
            ...(design ? { product_source_design_verification: design.envelope } : {}),
            static_web_capabilities: { version: 1, binding: capabilityBinding, options: prepared.options },
            ...(browserProcess ? { windows_browser_process: browserProcess } : {}) };
          if (browserProcess) privateContextSha256 = writeWindowsBrowserPrivateContext(browserBackend!, commandContextFile, envelope, privateDeadline!);
          else writeFileSync(commandContextFile, JSON.stringify(envelope), { mode: 0o400, flag: "wx" });
        }
        // This getter re-audits the installation synchronously. Charge it before
        // calculating the remaining opt-in command budget, not during argv evaluation.
        const executionBackend = privateDeadline === undefined ? undefined : readWindowsVerificationBackend(profile);
        const commandTimeoutMs = privateDeadline === undefined ? command.timeout_ms : Math.floor(privateDeadline - performance.now());
        if (commandTimeoutMs < 1) fail("Windows browser private-context admission exhausted the original command deadline");
        // The protected owner preserves POSIX behavior and requires explicit local
        // authority for Windows. Both routes disable Git hooks and await closure.
        const processResult = await runProtectedCommand({ cwd: profile.workspace_root, args: command.argv.slice(1), kind: "materialize", signal }, {
          gitExecutable: command.argv[0]!, readTimeoutMs: Math.min(commandTimeoutMs, 30_000), materializeTimeoutMs: commandTimeoutMs,
          guardParent: true,
          // Temporary browser profiles belong to this node-owned invocation.
          // Remove them only after the entire verifier invocation has confirmed closure.
          maxOutputBytes: MAX_OUTPUT, environment: { PATH: process.env.PATH, LANG: "C.UTF-8",
            TMPDIR: contextDirectory, TMP: contextDirectory, TEMP: contextDirectory, ARTOO_VERIFICATION_CONTEXT_FILE: commandContextFile,
            ...(privateContextSha256 ? { ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256: privateContextSha256 } : {}) },
        }, privateDeadline !== undefined ? executionBackend : process.platform === "win32" ? readWindowsVerificationBackend(profile) : undefined);
        assertReleaseContext(profile, context, readReleaseCapabilities);
        readSemanticAdmission?.();
        readDesignAdmission?.();
        result.checks.push({ id: command.id, exit_code: processResult.status, duration_ms: processResult.elapsedMs,
          output_digest: sha(Buffer.concat([processResult.stdout, Buffer.from("\0stderr\0"), processResult.stderr])) });
        previewCommands?.push(previewDiagnostic(command.id, result.checks.at(-1)!.output_digest, processResult.stdout, processResult.stderr));
        if (processResult.status !== 0) { result.reason = failureReason(`Verification command ${command.id} exited ${processResult.status}`, processResult.stdout, processResult.stderr); break; }
        if (command.observation) {
          let json: unknown;
          try { json = JSON.parse(processResult.stdout.toString("utf8")); } catch { fail(`Verification command ${command.id} did not return its configured observation format`); }
          if (semantic && !isDeepStrictEqual((json as { product_source_mapping?: unknown })?.product_source_mapping, {
            version: 1, admission_digest: semantic.admission_digest, mapping_digest: sha(canonicalProductSourceTransferValueV1(semantic.mapping)),
            request_digest: semantic.envelope.request_digest, source_export_digest: semantic.envelope.request.source_export_digest,
            research_provenance_digest: semantic.envelope.request.source_export.research_provenance_digest, command_id: command.id,
          })) fail("Protected verifier did not confirm the exact foreign research mapping");
          if (semantic) {
            // The handshake is a separate node/child transport field. Remove only
            // that exactly checked field before the unchanged strict report parser.
            const { product_source_mapping: _mapping, ...report } = json as Record<string, unknown>;
            json = report;
          }
          if (design) {
            if (!isDeepStrictEqual((json as { product_source_design_mapping?: unknown })?.product_source_design_mapping,
              importedDesignVerificationEchoV1(design.envelope, command.id, sha))) fail("Protected verifier did not confirm the exact imported-design mapping and invocation");
            const { product_source_design_mapping: _mapping, ...report } = json as Record<string, unknown>; json = report;
          }
          if (revisionEvidence) {
            if (!isDeepStrictEqual((json as { product_design_revision?: unknown })?.product_design_revision, revisionEvidence)) {
              fail("Protected verifier did not confirm the exact design revision and measured file");
            }
            const { product_design_revision: _revision, ...report } = json as Record<string, unknown>; json = report;
          }
          const parsed = StaticWebAcceptanceReportSchema.safeParse(json);
          if (!parsed.success || parsed.data.stage !== stage || parsed.data.format !== command.observation.format) fail(`Verification command ${command.id} returned an invalid or mismatched observation`);
          if (semantic && parsed.data.cases.length !== 0) fail("Foreign research verification cannot execute or accept browser cases");
          if (capabilityBinding && JSON.stringify(parsed.data.capability_binding) !== JSON.stringify(StaticWebCapabilityBindingSchema.parse(capabilityBinding))) {
            fail(`Verification command ${command.id} returned a mismatched capability binding`);
          }
          reports.push({ checkIndex: result.checks.length - 1, command, report: parsed.data });
        }
      } catch (error) {
        if (!(error instanceof OwnedGitError) && !(error instanceof ProtectedCommandError)) throw error;
        if (error instanceof OwnedGitError && !error.receipt.cleanupConfirmed) throw new VerificationCleanupError("Verifier process-group cleanup is unconfirmed; execution remains owned");
        result.checks.push({ id: command.id, exit_code: error instanceof OwnedGitError ? error.receipt.childStatus : error.status,
          duration_ms: error instanceof OwnedGitError ? error.receipt.elapsedMs : error.elapsedMs,
          output_digest: sha(Buffer.concat([error.stdout, Buffer.from("\0stderr\0"), error.stderr])) });
        previewCommands?.push(previewDiagnostic(command.id, result.checks.at(-1)!.output_digest, error.stdout, error.stderr));
        result.outcome = error.code === "aborted" ? "cancelled" : error.code === "timeout" ? "timed_out" : "failed";
        result.reason = failureReason(`Verification command ${command.id}: ${error.code}`, error.stdout, error.stderr); break;
      }
    }
    assertTrusted(profile);
    readDesignAdmission?.();
    const after = subjectManifest(profile);
    assertAcceptedProductInputs(profile.workspace_root, context, after.files);
    if (before.digest !== after.digest) { result.outcome = "failed"; result.reason = "Verification subject changed during checks"; }
    else if (!result.reason && result.checks.length === profile.commands.length && result.checks.every((check) => check.exit_code === 0)) result.outcome = signal.aborted ? "cancelled" : "passed";
    if (result.outcome === "passed" && reports.length) {
      // Only a closed, unchanged, completely measured run can expose reusable scope or screenshots.
      for (const { checkIndex, command, report } of reports) {
        const capabilityBinding = commandCapabilityBinding(profile, command.id);
        const evidenceRoot = command.observation?.evidence_root;
        if (report.version === 3) {
          const prepared = staticWebProfiles.get(profile)?.get(command.id);
          if (!prepared || !isV3WebAcceptanceOptions(prepared.options) || !capabilityBinding || !context || !evidenceRoot) {
            fail("Version 3 browser evidence requires a protected configured program and evidence root");
          }
          const expected = deriveExpectedWebAcceptanceV3(profile.workspace_root, context, prepared.options, capabilityBinding);
          if (report.stage !== expected.stage || report.requirements !== expected.requirements) fail("Browser report differs from the measured product plan");
          const bundle = sealBrowserEvidence({ evidenceRoot, requestId, profileId: profile.id,
            profileDigest: profile.digest, subjectDigest: before.digest, checkId: command.id, scope, report, expectedPrograms: expected.programs });
          result.checks[checkIndex]!.observation = { version: 3, format: "static-web-acceptance.v3", scope, stage: report.stage,
            device_scale_factor: 1, capability_binding: capabilityBinding,
            evidence_bundle: { bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest },
            cases: report.cases.map((item) => {
              const reference = bundle.case_refs.find((ref) => ref.case_id === item.case_id && ref.viewport_id === item.viewport.id);
              if (!reference) fail("Missing sealed browser trace reference");
              return { ...item, trace_ref: reference.trace_ref, captures: item.captures.map((capture) => {
                const image = reference.captures.find((ref) => ref.page_id === capture.page_id);
                if (!image) fail("Missing sealed browser page capture reference");
                return { ...capture, screenshot_ref: image.screenshot_ref };
              }) };
            }) };
          continue;
        }
        if (report.version === 2) {
          const prepared = staticWebProfiles.get(profile)?.get(command.id);
          if (!prepared || !isV2WebAcceptanceOptions(prepared.options) || !capabilityBinding || !context || !evidenceRoot) {
            fail("Version 2 browser evidence requires a protected configured program and evidence root");
          }
          // Reconstruct from the unchanged, measured product and protected options.
          // The child report cannot choose which program the node seals.
          const expected = deriveExpectedWebAcceptanceV2(profile.workspace_root, context, prepared.options, capabilityBinding);
          if (report.stage !== expected.stage || report.requirements !== expected.requirements) fail("Browser report differs from the measured product plan");
          const bundle = sealBrowserEvidence({ evidenceRoot, requestId, profileId: profile.id,
            profileDigest: profile.digest, subjectDigest: before.digest, checkId: command.id, scope, report, expectedPrograms: expected.programs });
          result.checks[checkIndex]!.observation = { version: 2, format: "static-web-acceptance.v2", scope, stage: report.stage,
            device_scale_factor: 1, capability_binding: capabilityBinding,
            evidence_bundle: { bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest },
            cases: report.cases.map((item) => {
              const reference = bundle.case_refs.find((ref) => ref.case_id === item.case_id && ref.viewport_id === item.viewport.id);
              if (!reference) fail("Missing sealed browser trace reference");
              return { ...item, trace_ref: reference.trace_ref, captures: item.captures.map((capture) => {
                const image = reference.captures.find((ref) => ref.page_id === capture.page_id);
                if (!image) fail("Missing sealed browser image reference");
                return { ...capture, screenshot_ref: image.screenshot_ref };
              }) };
            }) };
          continue;
        }
        const observation: VerificationObservation = { version: 1, format: "static-web-acceptance.v1", scope, stage: report.stage,
          cases: report.cases.map((item) => ({ ...item })), ...(capabilityBinding ? { capability_binding: capabilityBinding } : {}) };
        if (evidenceRoot) {
          const bundle = sealBrowserEvidence({ evidenceRoot, requestId, profileId: profile.id,
            profileDigest: profile.digest, subjectDigest: before.digest, checkId: command.id, scope, report });
          observation.evidence_bundle = { bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
          observation.cases = observation.cases.map((item) => ({ ...item,
            screenshot_ref: bundle.case_refs.find((ref) => ref.case_id === item.case_id && ref.viewport === item.viewport)?.screenshot_ref }));
        }
        result.checks[checkIndex]!.observation = observation;
      }
      assertVerificationSubject(profile, before.digest);
      assertAcceptedProductInputs(profile.workspace_root, context, after.files);
      assertReleaseContext(profile, context, readReleaseCapabilities);
      if (signal.aborted) { result.outcome = "cancelled"; result.reason = "Verification cancelled"; }
      else if (!RunVerificationPayloadSchema.safeParse(result).success) fail("Verification observations exceed their bounded contract");
    }
    if (result.outcome === "passed" && measurementPlan) {
      assertReleaseContext(profile, context, readReleaseCapabilities);
      readSemanticAdmission?.();
      readDesignAdmission?.();
      result.measurement_plan = measurementPlan;
      if (!RunVerificationPayloadSchema.safeParse(result).success) fail("Verification measurement plan exceeds its bounded contract");
    }
    if (result.outcome === "passed" && revisionEvidence) {
      const finalRevision = inspectProductDesignRevision(context, readProductFile(profile.workspace_root, ".artoo/product/research.json"),
        readProductFile(profile.workspace_root, ".artoo/product/design.json"));
      if (!isDeepStrictEqual(finalRevision, revisionEvidence) || reports.length !== profile.commands.length) {
        fail("Design revision changed or did not produce every required measured check");
      }
      assertVerificationSubject(profile, before.digest);
      result.product_design_revision = revisionEvidence;
      if (!RunVerificationPayloadSchema.safeParse(result).success) fail("Design revision evidence differs from its measured required files");
    }
  } catch (error) {
    if (error instanceof VerificationCleanupError) { cleanupConfirmed = false; throw error; }
    result.outcome = signal.aborted ? "cancelled" : "failed";
    result.reason = (error instanceof Error ? error.message : "Verification failed").slice(0, 2000);
  } finally {
    if (result.outcome !== "passed") {
      delete result.product_design_revision;
      delete result.measurement_plan;
      for (const check of result.checks) delete check.observation;
    }
    // This fresh directory was created by this invocation, outside the writer's root.
    if (contextDirectory && cleanupConfirmed) rmSync(contextDirectory, { recursive: true, force: true });
  }
  return result;
}
