import { arch as osArch, hostname, platform } from "node:os";
import { fileURLToPath } from "node:url";

import type { NodeHello } from "@artoo/protocol";

import { createAdapterRegistry, type AdapterRegistry, type RuntimeRegistration } from "./adapter-registry.js";
import { createArtoodNode, type ArtoodNode } from "./node-runner.js";
import { claudeCodeRuntime, codexRuntime, type RuntimePresetOptions } from "./runtimes.js";

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
  worktreeBaseRepo?: string;
}

function splitList(value: string | undefined, separators: RegExp = /[;,]/): string[] {
  return (value ?? "")
    .split(separators)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
    worktreeBaseRepo: env.ARTOO_WORKTREE_BASE_REPO?.trim() || undefined
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
    return preset({ allowedRoots: config.allowedRoots });
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
  return createArtoodNode({
    url: config.url,
    hello: helloFor(config),
    registry: buildRegistry(config),
    workspace: { worktreeBaseRepo: config.worktreeBaseRepo }
  });
}

/** Load config, connect, and start dispatching. Connects the real WebSocket. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<ArtoodNode> {
  const config = loadConfigFromEnv(env);
  const node = createNodeFromConfig(config);
  await node.start();
  return node;
}

// Only connect when run directly (e.g. `node dist/main.js`), not when imported by tests.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
