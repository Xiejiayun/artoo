import { nodeHelloSchema } from "@artoo/protocol";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import * as nodeRunner from "./node-runner.js";

import {
  buildRegistry,
  createNodeFromConfig,
  helloFor,
  loadConfigFromEnv,
  installShutdownHandlers,
  type ArtoodConfig
} from "./main.js";

const baseEnv = {
  ARTOO_NODE_URL: "ws://h:4000/api/v1/node?token=dev",
  ARTOO_NODE_ID: "computer_1",
  ARTOO_ALLOWED_ROOTS: "/ws"
};

function configWith(overrides: Partial<ArtoodConfig> = {}): ArtoodConfig {
  return { url: "ws://example.invalid", nodeId: "c1", runtimes: ["codex"], allowedRoots: ["/ws"], ...overrides };
}

describe("loadConfigFromEnv", () => {
  it("passes only local provider metadata and an env key name to runtime presets", () => {
    const config = loadConfigFromEnv({ ...baseEnv, ARTOO_CODEX_BINARY: process.execPath, ARTOO_CODEX_MODEL: "copilot-test",
      ARTOO_CODEX_PROVIDER_URL: "http://127.0.0.1:18181/v1", ARTOO_CODEX_PROVIDER_KEY: "never-in-config" });
    expect(config.codex).toEqual({ binaryPath: process.execPath, model: "copilot-test", baseUrl: "http://127.0.0.1:18181/v1", apiKeyEnv: "ARTOO_CODEX_PROVIDER_KEY" });
    expect(JSON.stringify(config)).not.toContain("never-in-config");
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_CODEX_MODEL: "test", ARTOO_CODEX_PROVIDER_URL: "https://example.test/v1" }).codex?.apiKeyEnv).toBeUndefined();
    expect(loadConfigFromEnv(baseEnv).codex).toEqual({});
    for (const values of [{ ARTOO_CODEX_BINARY: "relative.exe" }, { ARTOO_CODEX_PROVIDER_URL: "http://remote.example/v1" },
      { ARTOO_CODEX_PROVIDER_URL: "https://user:secret@example.test/v1" }, { ARTOO_CODEX_PROVIDER_URL: "https://example.test/v1?key=secret" }, { ARTOO_CODEX_PROVIDER_URL: "https://example.test/v1" }]) {
      expect(() => loadConfigFromEnv({ ...baseEnv, ...values })).toThrow();
    }
  });
  it("requires an explicit local opt-in for trusted execution", () => {
    expect(loadConfigFromEnv(baseEnv).trustedExecution).toBe(false);
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_TRUSTED_EXECUTION: "true" }).trustedExecution).toBe(false);
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_TRUSTED_EXECUTION: "1" }).trustedExecution).toBe(true);
  });
  it("parses required url + nodeId", () => {
    const config = loadConfigFromEnv({ ...baseEnv });
    expect(config.url).toBe("ws://h:4000/api/v1/node?token=dev");
    expect(config.nodeId).toBe("computer_1");
    expect(config.allowedRoots).toEqual(["/ws"]);
  });

  it("defaults runtimes to codex + claude-code", () => {
    expect(loadConfigFromEnv({ ...baseEnv }).runtimes).toEqual(["codex", "claude-code"]);
  });

  it("parses ARTOO_RUNTIMES as a trimmed csv", () => {
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_RUNTIMES: "codex" }).runtimes).toEqual(["codex"]);
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_RUNTIMES: " codex , claude-code " }).runtimes).toEqual([
      "codex",
      "claude-code"
    ]);
  });

  it("reads worktreeBaseRepo only when set and non-blank", () => {
    expect(loadConfigFromEnv({ ...baseEnv }).worktreeBaseRepo).toBeUndefined();
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_WORKTREE_BASE_REPO: "   " }).worktreeBaseRepo).toBeUndefined();
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_WORKTREE_BASE_REPO: "C:/repo" }).worktreeBaseRepo).toBe("C:/repo");
  });

  it("parses ARTOO_HEARTBEAT_INTERVAL_MS only when a positive finite number", () => {
    expect(loadConfigFromEnv({ ...baseEnv }).heartbeatIntervalMs).toBeUndefined();
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_HEARTBEAT_INTERVAL_MS: "500" }).heartbeatIntervalMs).toBe(500);
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_HEARTBEAT_INTERVAL_MS: "0" }).heartbeatIntervalMs).toBeUndefined();
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_HEARTBEAT_INTERVAL_MS: "-5" }).heartbeatIntervalMs).toBeUndefined();
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_HEARTBEAT_INTERVAL_MS: "abc" }).heartbeatIntervalMs).toBeUndefined();
  });

  it("splits allowedRoots on ; or ,", () => {
    expect(loadConfigFromEnv({ ...baseEnv, ARTOO_ALLOWED_ROOTS: "C:/a; C:/b , C:/c" }).allowedRoots).toEqual([
      "C:/a",
      "C:/b",
      "C:/c"
    ]);
  });

  it("throws naming the missing required var(s)", () => {
    expect(() => loadConfigFromEnv({ ARTOO_NODE_ID: "c1", ARTOO_ALLOWED_ROOTS: "/ws" })).toThrow(/ARTOO_NODE_URL/);
    expect(() => loadConfigFromEnv({ ARTOO_NODE_URL: "ws://x", ARTOO_ALLOWED_ROOTS: "/ws" })).toThrow(/ARTOO_NODE_ID/);
    expect(() => loadConfigFromEnv({ ARTOO_NODE_URL: "ws://x", ARTOO_NODE_ID: "c1" })).toThrow(/ARTOO_ALLOWED_ROOTS/);
    expect(() => loadConfigFromEnv({})).toThrow(/ARTOO_NODE_URL.*ARTOO_NODE_ID.*ARTOO_ALLOWED_ROOTS/);
  });
});

describe("buildRegistry", () => {
  it("registers the configured runtime presets in order", () => {
    const registry = buildRegistry(configWith({ runtimes: ["codex", "claude-code"], allowedRoots: ["/ws"] }));
    expect(registry.runtimes().map((r) => r.runtime)).toEqual(["codex", "claude-code"]);
  });

  it("throws on an unknown preset name", () => {
    expect(() => buildRegistry(configWith({ runtimes: ["nope"] }))).toThrow(/unknown runtime preset 'nope'/);
  });
});

describe("helloFor", () => {
  it("builds a wire-valid node.hello carrying the node id and machine info", () => {
    const hello = helloFor(configWith({ nodeId: "computer_9" }));
    expect(nodeHelloSchema.safeParse(hello).success).toBe(true);
    expect(hello.node_id).toBe("computer_9");
    expect(hello.machine.hostname.length).toBeGreaterThan(0);
    expect(hello.machine.os.length).toBeGreaterThan(0);
  });
});

describe("createNodeFromConfig", () => {
  it("advertises availability from the configured executable rather than a different PATH runtime", () => {
    const create = vi.spyOn(nodeRunner, "createArtoodNode");
    try {
      createNodeFromConfig(configWith({ codex: { binaryPath: process.execPath } }));
      expect(create.mock.calls[0]![0].heartbeat!().runtimes[0]?.status).toBe("available");
      createNodeFromConfig(configWith({ codex: { binaryPath: `${process.execPath}.missing` } }));
      expect(create.mock.calls[1]![0].heartbeat!().runtimes[0]?.status).toBe("missing");
    } finally { create.mockRestore(); }
  });
  it("constructs a node (with worktree config) without connecting", () => {
    const node = createNodeFromConfig(configWith({ worktreeBaseRepo: "C:/repo" }));
    expect(typeof node.start).toBe("function");
    expect(typeof node.stop).toBe("function");
  });
});

describe("desktop worker shutdown", () => {
  it("waits for node process cleanup before disconnecting and exiting, and deduplicates signals", async () => {
    const events: string[] = [];
    let stopped!: () => void;
    const gate = new Promise<void>((resolve) => { stopped = resolve; });
    const host = Object.assign(new EventEmitter(), {
      connected: true, disconnect: () => events.push("disconnect"), exit: (code: number) => events.push(`exit:${code}`),
    });
    const remove = installShutdownHandlers({ start: async () => {}, stop: async () => { events.push("stop"); await gate; } }, host);
    host.emit("message", { type: "shutdown" });
    host.emit("SIGTERM");
    expect(events).toEqual(["stop"]);
    stopped();
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["stop", "disconnect", "exit:0"]);
    remove();
    expect(host.listenerCount("message")).toBe(0);
  });
});
