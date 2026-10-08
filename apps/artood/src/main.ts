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
import { provisionLocalJournal } from "./managed/journal.js";
import { DeliveryCancelled } from "./managed/managed-delivery.js";

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
 * - `ARTOO_WORKTREE_BASE_REPO` (opt-in) git repo to create per-run worktrees from. Absent ->
 *                              branch-backed runs are rejected with process_start_failed (#19/#23).
 * - `ARTOO_MANAGED_EXECUTION`  explicit 0/1 new-allocation choice for a prepared profile.
 *   A profile also requires all `ARTOO_JOURNAL_*` fields listed below, including
 *   its separately saved server origin and node ID. Missing binding keeps ordinary startup.
 *   IPC-owned desktop launches additionally require `--prepared-journal` in argv;
 *   inherited environment fields alone cannot select that desktop execution path.
 *
 * The config/registry/hello builders are pure and exported for tests; `main` is
 * only invoked when this module is executed directly (not when imported).
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
  return {
    url,
    nodeId,
    runtimes: runtimes.length > 0 ? runtimes : ["codex", "claude-code"],
    allowedRoots,
    trustedExecution: env.ARTOO_TRUSTED_EXECUTION === "1",
    codex: codexSettingsFromEnv(env),
    ...(reportArtifacts ? { reportArtifacts } : {}),
    ...managedSettingsFromEnv(env, { url, nodeId }),
    worktreeBaseRepo: env.ARTOO_WORKTREE_BASE_REPO?.trim() || undefined,
    heartbeatIntervalMs: parsePositiveMs(env.ARTOO_HEARTBEAT_INTERVAL_MS)
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
  if (config.allowNewAllocations !== undefined && typeof config.allowNewAllocations !== "boolean") {
    throw new Error("New-allocation choice must be a boolean");
  }
  if (!config.managedJournal && config.allowNewAllocations === true) throw new Error("Managed execution requires a saved journal binding");
  const binding = config.managedJournal === undefined ? undefined
    : validateManagedJournalBinding(config.managedJournal, { url: config.url, nodeId: config.nodeId });
  if (binding && config.allowNewAllocations === undefined) throw new Error("Prepared journal requires an explicit new-allocation choice");
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
    heartbeatIntervalMs: config.heartbeatIntervalMs
  };
  return binding ? createManagedBootstrap({ ...common, binding, allowNewAllocations: config.allowNewAllocations! })
    : createArtoodNode({ ...common, acknowledgeRunEvents: true });
}

/** Load config, connect, and start dispatching. Connects the real WebSocket. */
export async function main(env: NodeJS.ProcessEnv = process.env, host: ShutdownHost = process): Promise<ArtoodNode> {
  let node: ArtoodNode, launchId: string | undefined;
  try {
    const config = loadConfigFromEnv(env);
    if (host.connected === false) throw new Error("Desktop IPC disconnected before worker startup");
    validateManagedLaunchSelection(config, { ipc: host.connected !== undefined, args: (host.argv ?? []).slice(2) });
    launchId = workerLaunchId(env, host, config.managedJournal !== undefined);
    node = createNodeFromConfig(config);
  } catch (cause) {
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
    await node.start();
    readyPhase = true;
    await Promise.resolve(); // Observe a failure already published with readiness.
    if (shutdown.stopping) { await shutdown.completion; throw new DeliveryCancelled("Worker stopped before ready"); }
    if (launchId) {
      await sendOwnedIpc(host, { type: "worker.ready", launchId }, () => !shutdown.stopping);
      if (shutdown.stopping) { await shutdown.completion; throw new DeliveryCancelled("Worker stopped during ready notification"); }
    }
    return node;
  } catch (cause) {
    let error = cause;
    // Startup cancellation after an intentional Stop is not a new fatal error.
    // An actual ready-send failure still taints a simultaneous requested Stop.
    if (launchId && (!shutdown.stopping || (readyPhase && !(cause instanceof DeliveryCancelled)))) {
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
