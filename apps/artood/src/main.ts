import { recordWindowsStartupPhase, recordWindowsStartupFailure, completeWindowsStartupDiagnostics } from "./windows-startup-diagnostics.js";
export { acquirePublishedProductOwnership, createPublishedProduct } from "./published-product.js";
import { arch as osArch, hostname, platform } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { NodeHello } from "@artoo/protocol";

import { createAdapterRegistry, type AdapterRegistry, type RuntimeRegistration } from "./adapter-registry.js";
import { createArtifactUploader } from "./artifact-upload.js";
import { runtimeAvailable } from "./cli-resolver.js";
import { createRegistryHeartbeat } from "./heartbeat.js";
import { createArtoodNode, type ArtoodNode } from "./node-runner.js";
import { claudeCodeRuntime, codexRuntime, type CodexSettings, type RuntimePresetOptions } from "./runtimes.js";
import { createManagedBootstrap, validateManagedJournalBinding, validateManagedJournalPreparation,
  type ManagedJournalBinding } from "./managed/managed-bootstrap.js";
import { provisionLocalJournal, upgradeLocalJournalForOwnedResults } from "./managed/journal.js";
import { initializeOwnedResultProfilesFile } from "./owned-result-profiles.js";
import { DeliveryCancelled } from "./managed/managed-delivery.js";
import { loadVerificationProfilesFile, type VerificationProfile } from "./verification.js";
import { loadReleaseProfilesFile, type ReleaseProfile } from "./product-release.js";
import { prepareWindowsProcessInstallation } from "./windows-process-installation.js";
import { prepareWindowsReleaseStorage, type PreparedWindowsReleaseStorage } from "./windows-release-storage.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { ResearchOptions } from "./research.js";
import { supervisedSelection, launchWindowsSupervisedCli, runWindowsSupervisedDaemon } from "./windows-daemon-launcher.js";
import { prepareProductSourceConfiguration } from "./product-source-config.js";
import { prepareProductBootstrapGit, type PreparedProductBootstrapGit } from "./product-bootstrap-git.js";
import { prepareCleanDaemonConfiguration, type PreparedCleanDaemonConfiguration } from "./windows-clean-local-configuration.js";
import type { PreparedWindowsDaemonSupervisorAuthority } from "./windows-supervisor-authority.js";

/**
 * artood node entrypoint: an env-driven bootstrap that wires the runtime presets,
 * node identity, and (opt-in) git worktree support into {@link createArtoodNode}
 * and connects to the server's node WebSocket.
 *
 * Config surface (env):
 * - `ARTOO_NODE_URL`           (required) ws URL incl. token, e.g. ws://h:4000/api/v1/node?token=dev
 * - `ARTOO_NODE_ID`            (required) computer/node id sent in node.hello
 * - `ARTOO_RUNTIMES`           csv of runtime presets to register (default: codex,claude-code)
 * - `ARTOO_ALLOWED_ROOTS`      (required) `;`/`,`-separated filesystem roots the adapters may operate in
 * - `ARTOO_REPORT_ARTIFACTS`   `default` (collect the preset's report) or explicit `none`
 * - `ARTOO_VERIFICATION_PROFILES_FILE` absolute administrator JSON file outside coding roots;
 *   reserves dedicated ordinary workspaces and enables node-owned verification on POSIX
 *   or an explicitly qualified Windows process installation.
 * - `ARTOO_WINDOWS_PROCESS_BUNDLE` + `ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256` opt into
 *   a protected local Windows helper installation. Both are required together;
 *   all allowed roots must be existing physical directories outside that installation.
 * - `ARTOO_OWNED_RESULT_PROFILES_FILE` protected local JSON; managed fresh-allocation
 *   startup opens previously initialized stores after an explicit journal v4 upgrade.
 * - `ARTOO_WORKTREE_BASE_REPO` (opt-in) git repo to create per-run worktrees from. Absent ->
 *                              branch-backed runs are rejected with process_start_failed (#19/#23).
 * - `ARTOO_MANAGED_EXECUTION`  explicit 0/1 new-allocation choice for a prepared profile.
 *   A profile also requires all `ARTOO_JOURNAL_*` fields listed below, including
 *   its separately saved server origin and node ID. Missing binding keeps ordinary startup.
 *   IPC-owned desktop launches additionally require `--prepared-journal` in argv;
 *   inherited environment fields alone cannot select that desktop execution path.
 *
 * Config loading qualifies local profiles and optional installations. Builders
 * are exported for tests; `main` only runs when this module is executed directly.
 */
const PROTOCOL_VERSION = "2026-06-11";
const ARTOOD_VERSION = "0.1.0";

const RUNTIME_PRESETS: Record<string, (options: RuntimePresetOptions) => RuntimeRegistration> = {
  codex: codexRuntime,
  "claude-code": claudeCodeRuntime
};

export interface ArtoodConfig {
  url: string;
  nodeId: string;
  runtimes: string[];
  allowedRoots: string[];
  trustedExecution?: boolean;
  worktreeBaseRepo?: string;
  /** Heartbeat interval override (ms); omitted = createArtoodNode's 10s default. */
  heartbeatIntervalMs?: number;
  codex?: CodexSettings;
  /** Local operator choice; never controlled by a task or server payload. */
  reportArtifacts?: "default" | "none";
  /** Exact saved local binding; it remains present when new allocations are disabled. */
  managedJournal?: ManagedJournalBinding;
  allowNewAllocations?: boolean;
  /** Local administrator-owned file, never server/task-supplied commands. */
  verificationProfiles?: readonly VerificationProfile[];
  /** Opaque authority returned by protected local Windows installation qualification. */
  windowsProcessBackend?: PreparedWindowsProcessBackend;
  releaseProfiles?: readonly ReleaseProfile[];
  windowsReleaseStorage?: ReadonlyMap<string, PreparedWindowsReleaseStorage>;
  ownedResultProfilesFile?: string;
  research?: ResearchOptions;
  initializeRepository?: boolean;
  /** Prepared from the supervisor's exact protected local source configuration, never task metadata. */
  productBootstrapGit?: PreparedProductBootstrapGit;
  /** Same-process local preparation after native Supervisor qualification. */
  prepareCleanLifecycle?: (supervisor: PreparedWindowsDaemonSupervisorAuthority) => PreparedCleanDaemonConfiguration;
  /** Versioned protected local selection of source transfer and continuation roles. */
  productSourceConfigFile?: string;
  /** Internal supervised CLI selection; checked again against genuine native authority. */
  requireSupervisorLifetime?: boolean;
}

const JOURNAL_ENV_KEYS = ["ARTOO_JOURNAL_VERSION", "ARTOO_JOURNAL_SERVER_ORIGIN", "ARTOO_JOURNAL_NODE_ID",
  "ARTOO_JOURNAL_DIRECTORY", "ARTOO_JOURNAL_NAMESPACE", "ARTOO_JOURNAL_CONTROLLER_SCOPE"] as const;

function managedSettingsFromEnv(env: NodeJS.ProcessEnv, connection: { url: string; nodeId: string }): Pick<ArtoodConfig, "managedJournal" | "allowNewAllocations"> {
  const mode = env.ARTOO_MANAGED_EXECUTION === "" ? undefined : env.ARTOO_MANAGED_EXECUTION;
  if (mode !== undefined && mode !== "0" && mode !== "1") throw new Error("ARTOO_MANAGED_EXECUTION must be 0 or 1");
  const hasBinding = JOURNAL_ENV_KEYS.some((key) => env[key] !== undefined && env[key] !== "");
  if (!hasBinding) {
    if (mode === "1") throw new Error("Managed execution requires a complete saved journal binding");
    return {};
  }
  if (mode === undefined) throw new Error("A prepared journal requires explicit ARTOO_MANAGED_EXECUTION=0 or 1");
  const missing = JOURNAL_ENV_KEYS.filter((key) => env[key] === undefined || env[key] === "");
  if (missing.length) throw new Error(`Incomplete managed journal binding: ${missing.join(", ")}`);
  if (env.ARTOO_JOURNAL_VERSION !== "1") throw new Error("ARTOO_JOURNAL_VERSION must be 1");
  const managedJournal = validateManagedJournalBinding({ version: 1,
    serverOrigin: env.ARTOO_JOURNAL_SERVER_ORIGIN, nodeId: env.ARTOO_JOURNAL_NODE_ID,
    directory: env.ARTOO_JOURNAL_DIRECTORY, expectedNamespace: env.ARTOO_JOURNAL_NAMESPACE,
    controllerScope: env.ARTOO_JOURNAL_CONTROLLER_SCOPE }, connection);
  return { managedJournal, allowNewAllocations: mode === "1" };
}

/** Desktop supplies this argv selector only alongside its exact saved binding. */
export function validateManagedLaunchSelection(config: Pick<ArtoodConfig, "managedJournal">,
  launch: { ipc: boolean; args: readonly string[] }): void {
  const selected = launch.args.includes("--prepared-journal");
  if (selected && !config.managedJournal) throw new Error("--prepared-journal requires a complete saved journal binding");
  if (launch.ipc && config.managedJournal && !selected) {
    throw new Error("Desktop managed journal startup requires explicit --prepared-journal selection");
  }
}

function codexSettingsFromEnv(env: NodeJS.ProcessEnv): CodexSettings {
  const binaryPath = env.ARTOO_CODEX_BINARY?.trim() || undefined;
  const model = env.ARTOO_CODEX_MODEL?.trim() || undefined;
  const baseUrl = env.ARTOO_CODEX_PROVIDER_URL?.trim() || undefined;
  if (binaryPath && (!isAbsolute(binaryPath) || /[\u0000-\u001f\u007f]/.test(binaryPath))) throw new Error("ARTOO_CODEX_BINARY must be an absolute program path");
  if (model && /[\u0000-\u001f\u007f]/.test(model)) throw new Error("Invalid ARTOO_CODEX_MODEL");
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error("Invalid ARTOO_CODEX_PROVIDER_URL"); }
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
      throw new Error("ARTOO_CODEX_PROVIDER_URL requires HTTPS or loopback HTTP without credentials, query or fragment");
    }
    if (!model) throw new Error("ARTOO_CODEX_MODEL is required for a Responses API");
  }
  return { ...(binaryPath ? { binaryPath } : {}), ...(model ? { model } : {}), ...(baseUrl ? { baseUrl,
    ...(env.ARTOO_CODEX_PROVIDER_KEY ? { apiKeyEnv: "ARTOO_CODEX_PROVIDER_KEY" } : {}) } : {}) };
}

function splitList(value: string | undefined, separators: RegExp = /[;,]/): string[] {
  return (value ?? "")
    .split(separators)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Parse a positive-finite ms override, else undefined (keep the built-in default). */
function parsePositiveMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function windowsProcessBackendFromEnv(env: NodeJS.ProcessEnv, allowedRoots: readonly string[], managed: boolean): PreparedWindowsProcessBackend | undefined {
  if (env.ARTOO_WINDOWS_PROCESS_BUNDLE === undefined && env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256 === undefined) return undefined;
  if (process.platform !== "win32") throw new Error("Windows process installation is supported only on Windows");
  const directory = env.ARTOO_WINDOWS_PROCESS_BUNDLE?.trim(), manifestSha256 = env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256?.trim();
  if (!directory || !manifestSha256) throw new Error("ARTOO_WINDOWS_PROCESS_BUNDLE and ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256 must both be provided");
  if (!isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory)) throw new Error("ARTOO_WINDOWS_PROCESS_BUNDLE must be an absolute local directory");
  if (!/^sha256:[a-f0-9]{64}$/.test(manifestSha256)) throw new Error("ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256 must be a sha256 digest");
  if (managed) throw new Error("Windows process installation cannot be combined with managed execution");
  return prepareWindowsProcessInstallation({ directory, manifestSha256, writableWorkspaceRoots: allowedRoots });
}

/** Parse the artood config from environment variables, throwing on missing required keys. */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv): ArtoodConfig {
  const url = env.ARTOO_NODE_URL?.trim();
  const nodeId = env.ARTOO_NODE_ID?.trim();
  const allowedRoots = splitList(env.ARTOO_ALLOWED_ROOTS);
  const missing = [
    ...(url ? [] : ["ARTOO_NODE_URL"]),
    ...(nodeId ? [] : ["ARTOO_NODE_ID"]),
    ...(allowedRoots.length > 0 ? [] : ["ARTOO_ALLOWED_ROOTS"])
  ];
  if (url === undefined || nodeId === undefined || missing.length > 0) {
    throw new Error(`artood: missing required env var(s): ${missing.join(", ")}`);
  }
  const runtimes = splitList(env.ARTOO_RUNTIMES, /,/);
  const reportArtifacts = env.ARTOO_REPORT_ARTIFACTS?.trim() || undefined;
  if (reportArtifacts !== undefined && reportArtifacts !== "default" && reportArtifacts !== "none") {
    throw new Error("ARTOO_REPORT_ARTIFACTS must be default or none");
  }
  if (env.ARTOO_RESEARCH_ENABLED !== undefined && !["", "0", "1"].includes(env.ARTOO_RESEARCH_ENABLED)) throw new Error("ARTOO_RESEARCH_ENABLED must be 0 or 1");
  if (env.ARTOO_INITIALIZE_REPOSITORY !== undefined && !["", "0", "1"].includes(env.ARTOO_INITIALIZE_REPOSITORY)) throw new Error("ARTOO_INITIALIZE_REPOSITORY must be 0 or 1");
  if (env.ARTOO_RESEARCH_ENABLED === "1" && !env.ARTOO_RESEARCH_RECEIPTS_DIR) throw new Error("Research requires ARTOO_RESEARCH_RECEIPTS_DIR outside writable roots");
  const managed = managedSettingsFromEnv(env, { url, nodeId });
  const windowsProcessBackend = windowsProcessBackendFromEnv(env, allowedRoots, managed.managedJournal !== undefined);
  const productSourceConfigFile = env.ARTOO_PRODUCT_SOURCE_CONFIG_FILE;
  if (productSourceConfigFile !== undefined && (!productSourceConfigFile || !isAbsolute(productSourceConfigFile)
    || /[\u0000-\u001f\u007f]/.test(productSourceConfigFile) || !windowsProcessBackend)) {
    throw new Error("ARTOO_PRODUCT_SOURCE_CONFIG_FILE requires an absolute protected file and native Windows backend");
  }
  const verificationProfiles = env.ARTOO_VERIFICATION_PROFILES_FILE ? loadVerificationProfilesFile(env.ARTOO_VERIFICATION_PROFILES_FILE, allowedRoots) : undefined;
  const releaseProfiles = env.ARTOO_RELEASE_PROFILES_FILE ? loadReleaseProfilesFile(env.ARTOO_RELEASE_PROFILES_FILE, verificationProfiles, allowedRoots) : undefined;
  const windowsReleaseStorage = windowsProcessBackend && releaseProfiles?.length ? new Map(releaseProfiles.map(profile => [profile.storage_root,
    prepareWindowsReleaseStorage({ directory: profile.storage_root, writableWorkspaceRoots: allowedRoots })])) : undefined;
  return {
    url,
    nodeId,
    runtimes: runtimes.length > 0 ? runtimes : ["codex", "claude-code"],
    allowedRoots,
    trustedExecution: env.ARTOO_TRUSTED_EXECUTION === "1",
    codex: codexSettingsFromEnv(env),
    ...(reportArtifacts ? { reportArtifacts } : {}),
    ...managed,
    worktreeBaseRepo: env.ARTOO_WORKTREE_BASE_REPO?.trim() || undefined,
    heartbeatIntervalMs: parsePositiveMs(env.ARTOO_HEARTBEAT_INTERVAL_MS),
    ...(verificationProfiles ? { verificationProfiles } : {}),
    ...(windowsProcessBackend ? { windowsProcessBackend } : {}),
    ...(productSourceConfigFile ? { productSourceConfigFile } : {}),
    ...(env.ARTOO_OWNED_RESULT_PROFILES_FILE ? { ownedResultProfilesFile: env.ARTOO_OWNED_RESULT_PROFILES_FILE } : {}),
    ...(releaseProfiles ? { releaseProfiles } : {}),
    ...(windowsReleaseStorage ? { windowsReleaseStorage } : {}),
    ...(env.ARTOO_RESEARCH_ENABLED === "1" ? { research: { receiptDirectory: env.ARTOO_RESEARCH_RECEIPTS_DIR!,
      ...(env.ARTOO_RESEARCH_BRAVE_KEY ? { braveApiKeyEnv: "ARTOO_RESEARCH_BRAVE_KEY" } : {}) } } : {}),
    ...(env.ARTOO_INITIALIZE_REPOSITORY === "1" ? { initializeRepository: true } : {})
  };
}

/** Build the runtime adapter registry from the configured preset names. */
export function buildRegistry(config: ArtoodConfig): AdapterRegistry {
  const registrations = config.runtimes.map((name) => {
    const preset = RUNTIME_PRESETS[name];
    if (preset === undefined) {
      throw new Error(
        `artood: unknown runtime preset '${name}' (known: ${Object.keys(RUNTIME_PRESETS).join(", ")})`
      );
    }
    return preset({ allowedRoots: config.allowedRoots, trustedExecution: config.trustedExecution,
      research: config.research, initializeRepository: config.initializeRepository, productBootstrapGit: config.productBootstrapGit,
      ...(config.reportArtifacts === "none" ? { artifacts: [] } : {}),
      ...(name === "codex" ? { codex: config.codex } : {}) });
  });
  return createAdapterRegistry(registrations);
}

/** Build the node.hello identity frame from config + this machine's os details. */
export function helloFor(config: ArtoodConfig): NodeHello {
  return {
    kind: "node.hello",
    node_id: config.nodeId,
    protocol_version: PROTOCOL_VERSION,
    artood_version: ARTOOD_VERSION,
    machine: { hostname: hostname(), os: platform(), arch: osArch() }
  };
}

/** Construct (without connecting) an {@link ArtoodNode} from config. */
export function createNodeFromConfig(config: ArtoodConfig): ArtoodNode {
  if (config.requireSupervisorLifetime && !config.productSourceConfigFile) throw Error("Supervised CLI requires explicit source recovery configuration");
  if (config.productSourceConfigFile !== undefined && (!config.windowsProcessBackend || config.managedJournal !== undefined)) {
    throw new Error("Product source configuration requires ordinary native Windows execution");
  }
  if (config.windowsProcessBackend !== undefined) {
    if (process.platform !== "win32") throw new Error("Windows process installation is supported only on Windows");
    if (config.managedJournal !== undefined) throw new Error("Windows process installation cannot be combined with managed execution");
  }
  if (config.allowNewAllocations !== undefined && typeof config.allowNewAllocations !== "boolean") {
    throw new Error("New-allocation choice must be a boolean");
  }
  if (!config.managedJournal && config.allowNewAllocations === true) throw new Error("Managed execution requires a saved journal binding");
  const binding = config.managedJournal === undefined ? undefined
    : validateManagedJournalBinding(config.managedJournal, { url: config.url, nodeId: config.nodeId });
  if (binding && config.allowNewAllocations === undefined) throw new Error("Prepared journal requires an explicit new-allocation choice");
  if (binding && config.verificationProfiles?.length) throw new Error("Verification profiles require a non-managed ordinary-workspace worker");
  if (config.ownedResultProfilesFile && (!binding || config.allowNewAllocations !== true)) throw new Error("Owned-result profiles require a prepared journal with fresh allocations enabled");
  const registry = buildRegistry(config);
  const common = {
    url: config.url,
    hello: helloFor(config),
    registry,
    heartbeat: createRegistryHeartbeat({
      nodeId: config.nodeId, registry,
      statusForRuntime: (runtime) => runtimeAvailable(runtime, runtime === "codex" ? config.codex?.binaryPath : undefined) ? "available" : "missing",
    }),
    uploadArtifact: createArtifactUploader(config.url, config.nodeId),
    workspace: { worktreeBaseRepo: config.worktreeBaseRepo, allowedRoots: config.allowedRoots },
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    verificationProfiles: config.verificationProfiles,
    windowsProcessBackend: config.windowsProcessBackend,
    releaseProfiles: config.releaseProfiles,
    windowsReleaseStorage: config.windowsReleaseStorage,
    productSourceConfigFile: config.productSourceConfigFile,
    requireSupervisorLifetime: config.requireSupervisorLifetime,
    prepareCleanLifecycle: config.prepareCleanLifecycle,
    research: config.research,
  };
  return binding ? createManagedBootstrap({ ...common, binding, allowNewAllocations: config.allowNewAllocations!,
    ...(config.ownedResultProfilesFile ? { ownedResultProfilesFile: config.ownedResultProfilesFile } : {}) })
    : createArtoodNode({ ...common, acknowledgeRunEvents: true });
}

/** Load config, connect, and start dispatching. Connects the real WebSocket. */
export async function main(env: NodeJS.ProcessEnv = process.env, host: ShutdownHost = process,
  supervisedReady?: () => Promise<void>): Promise<ArtoodNode> {
  let node: ArtoodNode, launchId: string | undefined;
  try {
    recordWindowsStartupPhase("load_configuration");
    const config = loadConfigFromEnv(env);
    if (supervisedReady) {
      config.requireSupervisorLifetime = true;
      if (env.ARTOO_SOURCE_CLEAN_CONFIG_FILE !== undefined) {
        const lineageFile = env.ARTOO_SOURCE_CLEAN_CONFIG_FILE, observerId = env.ARTOO_SOURCE_LIFECYCLE_OBSERVER_ID;
        const entry = process.argv[1];
        if (!lineageFile || !observerId || !entry) throw Error("Clean daemon requires its original protected parent configuration");
        config.prepareCleanLifecycle = supervisor => prepareCleanDaemonConfiguration({ config, env, entry, lineageFile, observerId, supervisor });
      }
      if (config.initializeRepository) {
        recordWindowsStartupPhase("bootstrap_git");
        if (!config.productSourceConfigFile || !env.ARTOO_SUPERVISED_BOOTSTRAP_GIT) throw Error("Supervised bootstrap requires its protected Git selection");
        const local = prepareProductSourceConfiguration({ file: config.productSourceConfigFile, allowedRoots: config.allowedRoots });
        let expected: unknown;
        try { expected = JSON.parse(env.ARTOO_SUPERVISED_BOOTSTRAP_GIT); }
        catch { throw Error("Supervised bootstrap Git descriptor is invalid"); }
        config.productBootstrapGit = prepareProductBootstrapGit({ file: local.config.gitExecutable, allowedRoots: config.allowedRoots, expected,
          assertConfigurationUnchanged: () => { if (local.read().identity !== local.original.identity) throw Error("Product bootstrap source configuration changed"); } });
      }
    }
    if (host.connected === false) throw new Error("Desktop IPC disconnected before worker startup");
    validateManagedLaunchSelection(config, { ipc: host.connected !== undefined, args: (host.argv ?? []).slice(2) });
    launchId = workerLaunchId(env, host, config.managedJournal !== undefined);
    recordWindowsStartupPhase("create_node");
    node = createNodeFromConfig(config);
  } catch (cause) {
    recordWindowsStartupFailure(cause);
    if (host.connected === undefined) throw cause; // Standalone CLI has no owned IPC lifetime.
    const errors = [asError(cause)];
    // No node has started and no shutdown listener exists yet. Close this IPC
    // owner explicitly so malformed settings cannot leave an idle child alive.
    try { await disconnectOwnedIpc(host); } catch (error) { errors.push(asError(error)); }
    host.exit(1); throw combinedFailure(errors);
  }
  const shutdown = installShutdownHandlers(node, host, { launchId });
  let readyPhase = false;
  try {
    recordWindowsStartupPhase("start_node");
    await node.start();
    if (supervisedReady) {
      recordWindowsStartupPhase("await_registration");
      if (!node.executionReady) throw Error("Supervised daemon has no registered source readiness signal");
      await node.executionReady;
    }
    readyPhase = true;
    await Promise.resolve(); // Observe a failure already published with readiness.
    if (shutdown.stopping) { await shutdown.completion; throw new DeliveryCancelled("Worker stopped before ready"); }
    if (launchId) {
      await sendOwnedIpc(host, { type: "worker.ready", launchId }, () => !shutdown.stopping);
      if (shutdown.stopping) { await shutdown.completion; throw new DeliveryCancelled("Worker stopped during ready notification"); }
    }
    if (supervisedReady) {
      recordWindowsStartupPhase("execution_ready");
      await supervisedReady();
      if (shutdown.stopping) { await shutdown.completion; throw new DeliveryCancelled("Supervised daemon stopped during ready notification"); }
      completeWindowsStartupDiagnostics();
    }
    return node;
  } catch (cause) {
    recordWindowsStartupFailure(cause);
    let error = cause;
    // Startup cancellation after an intentional Stop is not a new fatal error.
    // An actual ready-send failure still taints a simultaneous requested Stop.
    if ((launchId || supervisedReady) && (!shutdown.stopping || (readyPhase && !(cause instanceof DeliveryCancelled)))) {
      try { await shutdown.fail(cause); } catch (failure) { error = failure; }
    } else if (shutdown.completion) {
      try { await shutdown.completion; } catch (failure) { error = failure; }
    }
    shutdown(); throw error;
  }
}

export interface ShutdownHost {
  on(event: string, listener: (message?: unknown) => void): unknown;
  off(event: string, listener: (message?: unknown) => void): unknown;
  connected?: boolean;
  disconnect?: () => void;
  argv?: readonly string[];
  send?: (message: Record<string, unknown>, callback: (error: Error | null) => void) => unknown;
  exit(code: number): unknown;
}

const IPC_OPERATION_MS = 5000;
function asError(cause: unknown): Error { return cause instanceof Error ? cause : new Error(String(cause)); }
function combinedFailure(errors: readonly Error[]): Error {
  return errors.length === 1 ? errors[0]! : new AggregateError([...errors], `${errors[0]?.message}; additional daemon cleanup failures`, { cause: errors[0] });
}
function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function requireOwnedIpc(host: ShutdownHost): void {
  if (host.connected !== true || !host.send || !host.disconnect) throw new Error("This worker operation requires its connected desktop IPC owner");
}
function workerLaunchId(env: NodeJS.ProcessEnv, host: ShutdownHost, prepared: boolean): string | undefined {
  const value = env.ARTOO_WORKER_LAUNCH_ID;
  if (value === undefined || value === "") {
    if (prepared && host.connected !== undefined) throw new Error("Prepared desktop startup requires ARTOO_WORKER_LAUNCH_ID");
    return undefined;
  }
  const id = uuid(value, "ARTOO_WORKER_LAUNCH_ID"); requireOwnedIpc(host); return id;
}
function sendOwnedIpc(host: ShutdownHost, message: Record<string, unknown>, allowed: () => boolean = () => true): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (done) return; done = true; clearTimeout(timer); host.off("disconnect", lost);
      if (error) reject(error); else resolve();
    };
    const lost = (): void => finish(new Error("Desktop IPC disconnected before message acknowledgement"));
    host.on("disconnect", lost);
    try {
      requireOwnedIpc(host);
      if (!allowed()) { finish(new DeliveryCancelled("Worker notification was cancelled before send")); return; }
      timer = setTimeout(() => finish(new Error("Desktop IPC message acknowledgement timed out")), IPC_OPERATION_MS);
      host.send!(message, (error) => finish(error ?? undefined));
    } catch (error) { finish(asError(error)); }
  });
}
function disconnectOwnedIpc(host: ShutdownHost): Promise<void> {
  if (host.connected === false) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (done) return; done = true; clearTimeout(timer); host.off("disconnect", disconnected);
      if (error) reject(error); else resolve();
    };
    const disconnected = (): void => finish();
    host.on("disconnect", disconnected);
    try {
      requireOwnedIpc(host);
      timer = setTimeout(() => finish(new Error("Desktop IPC disconnect was not observed")), IPC_OPERATION_MS);
      host.disconnect!();
    } catch (error) { finish(asError(error)); }
  });
}

export interface ShutdownRegistration {
  (): void;
  readonly stopping: boolean;
  readonly failure: Error | undefined;
  readonly completion: Promise<void> | undefined;
  fail(cause: unknown): Promise<void>;
}

/** Desktop IPC and terminal signals share the same confirmed process-tree stop. */
export function installShutdownHandlers(node: ArtoodNode, host: ShutdownHost = process,
  options: { launchId?: string } = {}): ShutdownRegistration {
  const launchId = options.launchId === undefined ? undefined : uuid(options.launchId, "worker launch ID");
  let stopping = false, removed = false, exited = false, work: Promise<void> | undefined;
  const errors: Error[] = [];
  const remember = (cause: unknown): void => { const error = asError(cause); if (!errors.includes(error)) errors.push(error); };
  const shutdown = (cause?: unknown): Promise<void> => {
    if (cause !== undefined) remember(cause);
    if (work) return work;
    stopping = true;
    work = (async () => {
      let clean = false;
      try { await node.stop(); clean = true; } catch (error) { remember(error); }
      await Promise.resolve(); // First-failure notification wins over simultaneous clean Stop.
      if (launchId) {
        if (clean) {
          try { await sendOwnedIpc(host, { type: "worker.stopped", launchId }); } catch (error) { remember(error); }
        }
        try { await disconnectOwnedIpc(host); } catch (error) { remember(error); }
      } else if (clean && host.connected) {
        try { host.disconnect?.(); } catch (error) { remember(error); }
      }
      if (!exited) { exited = true; host.exit(errors.length ? 1 : 0); }
      if (errors.length) throw combinedFailure(errors);
    })();
    void work.catch(() => {});
    return work;
  };
  const requestStop = (): void => { void shutdown(); };
  const failed = (error: unknown): void => { if (!removed) void shutdown(asError(error)); };
  void node.failed?.then(failed, failed);
  const message = (value?: unknown): void => {
    if (value && typeof value === "object" && "type" in value && value.type === "shutdown") {
      if (launchId && (!("launchId" in value) || value.launchId !== launchId)) return;
      requestStop();
    }
  };
  host.on("message", message);
  // A managed desktop worker must not outlive its IPC owner after a crash.
  // Standalone CLI processes have no `connected` property or IPC lifetime.
  if (host.connected !== undefined) host.on("disconnect", requestStop);
  host.on("SIGINT", requestStop);
  host.on("SIGTERM", requestStop);
  const remove = (): void => {
    removed = true;
    host.off("message", message);
    host.off("disconnect", requestStop);
    host.off("SIGINT", requestStop);
    host.off("SIGTERM", requestStop);
  };
  return Object.defineProperties(remove, {
    stopping: { get: () => stopping }, failure: { get: () => errors[0] }, completion: { get: () => work },
    fail: { value: (cause: unknown) => shutdown(asError(cause)) },
  }) as ShutdownRegistration;
}

/** One-off owned initialization. This path never parses provider or node-connection settings. */
export async function provisionManagedJournal(env: NodeJS.ProcessEnv, host: ShutdownHost = process): Promise<void> {
  const errors: Error[] = [];
  const remember = (cause: unknown): void => { const error = asError(cause); if (!errors.includes(error)) errors.push(error); };
  let disconnecting = false;
  const interrupted = (): void => remember(new DeliveryCancelled("Journal preparation was interrupted"));
  const ownerLost = (): void => { if (!disconnecting) remember(new Error("Desktop IPC owner disconnected during journal preparation")); };
  try {
    requireOwnedIpc(host);
    const requestId = uuid(env.ARTOO_JOURNAL_REQUEST_ID, "ARTOO_JOURNAL_REQUEST_ID");
    if (env.ARTOO_JOURNAL_VERSION !== "1") throw new Error("ARTOO_JOURNAL_VERSION must be 1");
    if (env.ARTOO_JOURNAL_NAMESPACE) throw new Error("Journal provisioning does not accept an existing namespace");
    const preparation = validateManagedJournalPreparation({ version: 1,
      serverOrigin: env.ARTOO_JOURNAL_SERVER_ORIGIN, nodeId: env.ARTOO_JOURNAL_NODE_ID,
      directory: env.ARTOO_JOURNAL_DIRECTORY, controllerScope: env.ARTOO_JOURNAL_CONTROLLER_SCOPE });
    host.on("disconnect", ownerLost); host.on("SIGINT", interrupted); host.on("SIGTERM", interrupted);
    const receipt = await provisionLocalJournal({ directory: preparation.directory,
      controllerScope: preparation.controllerScope, nodeId: preparation.nodeId });
    const namespace = uuid(receipt.namespace, "provisioned journal namespace");
    if (!errors.length) await sendOwnedIpc(host, { type: "journal.provisioned", requestId, namespace }, () => errors.length === 0);
  } catch (error) { remember(error); }
  finally {
    disconnecting = true;
    if (host.connected === true) { try { await disconnectOwnedIpc(host); } catch (error) { remember(error); } }
    host.off("disconnect", ownerLost); host.off("SIGINT", interrupted); host.off("SIGTERM", interrupted);
  }
  host.exit(errors.length ? 1 : 0);
  if (errors.length) throw combinedFailure(errors);
}

/** Dispatch provisioning before normal config, registry, provider or WebSocket construction. */
export async function runDaemonEntrypoint(env: NodeJS.ProcessEnv = process.env, host: ShutdownHost = process): Promise<ArtoodNode | void> {
  const args = (host.argv ?? []).slice(2);
  const supervised = supervisedSelection(args, host.connected !== undefined);
  if (supervised === "parent") return launchWindowsSupervisedCli(env, loadConfigFromEnv(env), fileURLToPath(import.meta.url));
  if (supervised === "daemon") return runWindowsSupervisedDaemon(env, host, (controlled, ready) => main(env, controlled, ready));
  const initializeResults = args.includes("--initialize-owned-result-profiles"), upgradeResults = args.includes("--upgrade-owned-result-journal");
  if (initializeResults || upgradeResults) {
    if (host.connected !== undefined || initializeResults && upgradeResults || args.includes("--prepared-journal") || args.includes("--provision-managed-journal")) {
      throw new Error("Owned-result administration requires one explicit standalone offline selector");
    }
    if (initializeResults) {
      const path = env.ARTOO_OWNED_RESULT_PROFILES_FILE, nodeId = env.ARTOO_NODE_ID, roots = splitList(env.ARTOO_ALLOWED_ROOTS);
      if (!path || !nodeId || !roots.length) throw new Error("Result initialization requires local profiles file, node ID and coding roots");
      const profiles = await initializeOwnedResultProfilesFile(path, nodeId, roots);
      console.log(JSON.stringify({ kind: "owned-result-profiles.initialized", version: 1, node_id: profiles.node_id, descriptors: profiles.descriptors }));
    } else {
      if (env.ARTOO_MANAGED_EXECUTION !== "0" || !env.ARTOO_NODE_URL || !env.ARTOO_NODE_ID) throw new Error("Offline result journal upgrade requires the saved connection binding and ARTOO_MANAGED_EXECUTION=0");
      const binding = managedSettingsFromEnv(env, { url: env.ARTOO_NODE_URL, nodeId: env.ARTOO_NODE_ID }).managedJournal;
      if (!binding) throw new Error("Result journal upgrade requires an existing saved namespace");
      const receipt = await upgradeLocalJournalForOwnedResults({ directory: binding.directory, controllerScope: binding.controllerScope,
        nodeId: binding.nodeId, expectedNamespace: binding.expectedNamespace });
      console.log(JSON.stringify({ kind: "owned-result-journal.upgraded", ...receipt }));
    }
    return;
  }
  if (args.includes("--provision-managed-journal")) {
    if (args.includes("--prepared-journal")) {
      const errors = [new Error("Provisioning and prepared execution selectors cannot be combined")];
      if (host.connected === true) { try { await disconnectOwnedIpc(host); } catch (error) { errors.push(asError(error)); } }
      host.exit(1); throw combinedFailure(errors);
    }
    return provisionManagedJournal(env, host);
  }
  return main(env, host);
}

// Only connect when run directly (e.g. `node dist/main.js`), not when imported by tests.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  runDaemonEntrypoint().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
