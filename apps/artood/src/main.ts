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
 * - `ARTOO_WORKTREE_BASE_REPO` (opt-in) git repo to create per-run worktrees from. Absent ->
 *                              branch-backed runs are rejected with process_start_failed (#19/#23).
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
  return {
    url,
    nodeId,
    runtimes: runtimes.length > 0 ? runtimes : ["codex", "claude-code"],
    allowedRoots,
    trustedExecution: env.ARTOO_TRUSTED_EXECUTION === "1",
    codex: codexSettingsFromEnv(env),
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
    return preset({ allowedRoots: config.allowedRoots, trustedExecution: config.trustedExecution, ...(name === "codex" ? { codex: config.codex } : {}) });
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
  const registry = buildRegistry(config);
  return createArtoodNode({
    url: config.url,
    hello: helloFor(config),
    registry,
    heartbeat: createRegistryHeartbeat({
      nodeId: config.nodeId, registry,
      statusForRuntime: (runtime) => runtimeAvailable(runtime, runtime === "codex" ? config.codex?.binaryPath : undefined) ? "available" : "missing",
    }),
    uploadArtifact: createArtifactUploader(config.url, config.nodeId),
    acknowledgeRunEvents: true,
    workspace: { worktreeBaseRepo: config.worktreeBaseRepo, allowedRoots: config.allowedRoots },
    heartbeatIntervalMs: config.heartbeatIntervalMs
  });
}

/** Load config, connect, and start dispatching. Connects the real WebSocket. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<ArtoodNode> {
  const config = loadConfigFromEnv(env);
  if (process.connected === false) throw new Error("Desktop IPC disconnected before worker startup");
  const node = createNodeFromConfig(config);
  const removeHandlers = installShutdownHandlers(node);
  try { await node.start(); } catch (error) { removeHandlers(); throw error; }
  return node;
}

export interface ShutdownHost {
  on(event: string, listener: (message?: unknown) => void): unknown;
  off(event: string, listener: (message?: unknown) => void): unknown;
  connected?: boolean;
  disconnect?: () => void;
  exit(code: number): unknown;
}

/** Desktop IPC and terminal signals share the same confirmed process-tree stop. */
export function installShutdownHandlers(node: ArtoodNode, host: ShutdownHost = process): () => void {
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void node.stop().then(() => {
      if (host.connected) host.disconnect?.();
      host.exit(0);
    }, () => host.exit(1));
  };
  const message = (value?: unknown): void => {
    if (value && typeof value === "object" && "type" in value && value.type === "shutdown") shutdown();
  };
  host.on("message", message);
  // A managed desktop worker must not outlive its IPC owner after a crash.
  // Standalone CLI processes have no `connected` property or IPC lifetime.
  if (host.connected !== undefined) host.on("disconnect", shutdown);
  host.on("SIGINT", shutdown);
  host.on("SIGTERM", shutdown);
  return () => {
    host.off("message", message);
    host.off("disconnect", shutdown);
    host.off("SIGINT", shutdown);
    host.off("SIGTERM", shutdown);
  };
}

// Only connect when run directly (e.g. `node dist/main.js`), not when imported by tests.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
