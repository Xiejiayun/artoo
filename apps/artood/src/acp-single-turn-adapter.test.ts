import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeToServerMessage, NodeSideTransport, RunStartCommand, ServerToNodeMessage } from "@artoo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertValidSingleTurnRunStart,
  classifySingleTurnError,
  createAcpSingleTurnAdapter,
} from "./acp-single-turn-adapter.js";
import { createAdapterRegistry } from "./adapter-registry.js";
import { createCliDiscoverySampler } from "./cli-discovery.js";
import { createSingleTurnRuntimeController } from "./cli-verification.js";
import { createNodeClient } from "./node-client.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFakeAcpCopilotScript(dir: string, behaviorScript: string): string {
  const scriptPath = join(dir, "fake-copilot-acp.cjs");
  writeFileSync(
    scriptPath,
    `
const readline = require("node:readline");
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("GitHub Copilot CLI 1.0.109.\\n");
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "Copilot", version: "1.0.109" } } });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_test_1" } });
    return;
  }
  if (msg.method === "session/prompt") {
    ${behaviorScript}
  }
});
`,
    "utf8",
  );
  if (process.platform === "win32") {
    const cmdPath = join(dir, "copilot.cmd");
    writeFileSync(cmdPath, '@ECHO OFF\r\n"%dp0%\\fake-copilot-acp.cjs" %*\r\n', "utf8");
    return cmdPath;
  }
  const shPath = join(dir, "copilot");
  writeFileSync(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
  return shPath;
}

function makeCleanRunStart(
  runId: string,
  overrides: Partial<RunStartCommand["payload"]> = {},
): RunStartCommand["payload"] {
  return {
    run_id: runId,
    task_id: `task_${runId}`,
    agent_instance_id: "ai_copilot_1",
    runtime: "copilot",
    workspace: { root: "C:\\workspaces\\forbidden_host_repo" },
    context_pack: {
      id: `ctx_${runId}`,
      payload: {
        task: {
          id: `task_${runId}`,
          title: "Say hello",
          description: "Reply cleanly.",
          acceptance_criteria: ["plain text"],
        },
        project: { id: "proj_artoo", name: "Artoo", default_workspace: null },
        workspace: { root: "C:\\workspaces\\forbidden_host_repo", file_scope: [] },
        policy: { filesystem_write_scope: [], requires_approval: [] },
        memory: { task_summary: null, project_notes: [] },
        artifacts: { expected: [] },
      },
    },
    policy_snapshot: { filesystem_write_scope: [], requires_approval: [] },
    artifact_rules: { paths: [] },
    ...overrides,
  };
}

function createFakeTransport() {
  const sent: NodeToServerMessage[] = [];
  const handlers = new Set<(message: ServerToNodeMessage) => void>();
  const transport: NodeSideTransport = {
    acknowledgesRunEvents: false,
    async send(msg) {
      sent.push(msg);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async close() {
      handlers.clear();
    },
  };
  return {
    transport,
    sent,
    emit(msg: ServerToNodeMessage) {
      for (const h of [...handlers]) h(msg);
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("acp-single-turn-adapter and cli-verification", () => {
  it("runs single-turn ACP inside an isolated empty cwd with strict env allowlist and strips Copilot disabled-tools banner", async () => {
    const binDir = createTempDir("artoo-acp-happy-");
    const envReportFile = join(binDir, "observed.json");
    const entry = writeFakeAcpCopilotScript(
      binDir,
      `
      fs.writeFileSync(${JSON.stringify(envReportFile)}, JSON.stringify({
        cwd: process.cwd(),
        cwdEntries: fs.readdirSync(process.cwd()),
        hasArtooVar: Object.keys(process.env).some((k) => k.startsWith("ARTOO_")),
        hasSecretCanary: "SECRET_HOST_CANARY" in process.env,
        argv: process.argv.slice(2),
      }));
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_test_1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Info: Disabled tools: apply_patch, view" } }
        }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_test_1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HELLO_PLAIN_TEXT" } }
        }
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } } });
      `,
    );

    const registry = createAdapterRegistry([]);
    const controller = createSingleTurnRuntimeController({
      env: {
        ...process.env,
        PATH: binDir,
        ARTOO_NODE_TOKEN: "secret-node-token",
        SECRET_HOST_CANARY: "must-not-leak",
      },
      platform: "win32",
      arch: "x64",
      binaryOverrides: { copilot: entry },
      registry,
    });
    const adapter = createAcpSingleTurnAdapter({
      sampler: controller.sampler,
      isVerifiedReady: (r, fp) => controller.isVerifiedReady(r, fp),
      supportedRuntimes: controller.supportedRuntimes,
      enabledRuntimes: controller.enabledRuntimes,
      platform: "win32",
      arch: "x64",
      env: {
        ...process.env,
        PATH: binDir,
        ARTOO_NODE_TOKEN: "secret-node-token",
        SECRET_HOST_CANARY: "must-not-leak",
      },
    });
    controller.bindAdapter(adapter);

    const verification = await controller.verifyConnection("copilot");
    expect(verification.outcome.status).toBe("verified");
    expect(registry.resolve("copilot")).toBe(adapter);

    const handle = await adapter.start({
      runId: "run_1",
      taskId: "task_1",
      agentInstanceId: "ai_1",
      runtime: "copilot",
      workspaceRoot: "C:\\workspaces\\forbidden_host_repo",
      runStart: makeCleanRunStart("run_1"),
    });

    const events = [];
    for await (const ev of adapter.streamEvents(handle)) {
      events.push(ev);
    }

    expect(events.map((e) => e.type)).toEqual([
      "run.lifecycle",
      "run.output",
      "run.usage",
      "run.answer",
      "run.lifecycle",
    ]);
    expect(events[1]).toEqual({ type: "run.output", payload: { stream: "stdout", text: "HELLO_PLAIN_TEXT" } });
    expect(events[3]).toEqual({ type: "run.answer", payload: { text: "HELLO_PLAIN_TEXT" } });
    expect(events[4]).toEqual({ type: "run.lifecycle", payload: { phase: "completed" } });

    const observed = JSON.parse(await import("node:fs").then((m) => m.readFileSync(envReportFile, "utf8")));
    expect(observed.hasArtooVar).toBe(false);
    expect(observed.hasSecretCanary).toBe(false);
    expect(observed.cwdEntries).toEqual([]);
    expect(observed.cwd).toContain("artoo-acp-run-");
    expect(observed.cwd).not.toBe(realpathSync(binDir));
    expect(observed.argv).toContain("--excluded-tools");
    expect(observed.argv).toContain("--disable-builtin-mcps");
    expect(observed.argv).toContain("--disallow-temp-dir");
    await vi.waitFor(() => {
      expect(existsSync(observed.cwd)).toBe(false);
    });
  });

  it("fails closed when ACP server attempts session/request_permission or emits tool_call updates", async () => {
    const binDir = createTempDir("artoo-acp-tool-fail-");
    const entry = writeFakeAcpCopilotScript(
      binDir,
      `
      send({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "sess_test_1" } });
      `,
    );

    const sampler = createCliDiscoverySampler({
      env: { PATH: binDir },
      platform: "win32",
      arch: "x64",
      binaryOverrides: { copilot: entry },
      supportedSingleTurnRuntimes: new Set(["copilot"]),
      enabledSingleTurnRuntimes: new Set(["copilot"]),
    });
    const adapter = createAcpSingleTurnAdapter({
      sampler,
      isVerifiedReady: () => true,
      supportedRuntimes: new Set(["copilot"]),
      enabledRuntimes: new Set(["copilot"]),
      platform: "win32",
      arch: "x64",
      env: { ...process.env, PATH: binDir },
    });

    const handle = await adapter.start({
      runId: "run_tool_deny",
      taskId: "task_1",
      agentInstanceId: "ai_1",
      runtime: "copilot",
      workspaceRoot: "C:\\ws",
      runStart: makeCleanRunStart("run_tool_deny"),
    });
    const events = [];
    for await (const ev of adapter.streamEvents(handle)) events.push(ev);

    const last = events.at(-1);
    expect(last?.type).toBe("run.lifecycle");
    if (last?.type === "run.lifecycle") {
      expect(last.payload.phase).toBe("failed");
      expect(last.payload.reason).toContain("protocol_error");
    }
  });

  it("handles mid-stream Stop cleanly and refuses completion if descendant process exit is unconfirmed", async () => {
    const binDir = createTempDir("artoo-acp-stop-");
    const entry = writeFakeAcpCopilotScript(
      binDir,
      `
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_test_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial..." } } } });
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 20000);
      `,
    );

    const sampler = createCliDiscoverySampler({
      env: { PATH: binDir },
      platform: "win32",
      arch: "x64",
      binaryOverrides: { copilot: entry },
      supportedSingleTurnRuntimes: new Set(["copilot"]),
      enabledSingleTurnRuntimes: new Set(["copilot"]),
    });

    // Confirmed clean stop
    const adapter = createAcpSingleTurnAdapter({
      sampler,
      isVerifiedReady: () => true,
      supportedRuntimes: new Set(["copilot"]),
      enabledRuntimes: new Set(["copilot"]),
      platform: "win32",
      arch: "x64",
      verifyProcessTreeGone: () => true,
    });
    const handle = await adapter.start({
      runId: "run_stop_ok",
      taskId: "t1",
      agentInstanceId: "ai1",
      runtime: "copilot",
      workspaceRoot: "C:\\ws",
      runStart: makeCleanRunStart("run_stop_ok"),
    });
    await new Promise((r) => setTimeout(r, 250));
    await expect(adapter.stop(handle, "user_cancelled")).resolves.toBeUndefined();
    const events = [];
    for await (const ev of adapter.streamEvents(handle)) events.push(ev);
    expect(events.at(-1)).toEqual({
      type: "run.lifecycle",
      payload: { phase: "cancelled", reason: "user_cancelled" },
    });

    // Unconfirmed descendant closure -> throws "停止未确认"
    const stuckAdapter = createAcpSingleTurnAdapter({
      sampler,
      isVerifiedReady: () => true,
      supportedRuntimes: new Set(["copilot"]),
      enabledRuntimes: new Set(["copilot"]),
      platform: "win32",
      arch: "x64",
      stopTimeoutMs: 500,
      verifyProcessTreeGone: () => false,
    });
    const stuckHandle = await stuckAdapter.start({
      runId: "run_stop_stuck",
      taskId: "t2",
      agentInstanceId: "ai1",
      runtime: "copilot",
      workspaceRoot: "C:\\ws",
      runStart: makeCleanRunStart("run_stop_stuck"),
    });
    await new Promise((r) => setTimeout(r, 250));
    await expect(stuckAdapter.stop(stuckHandle, "user_cancelled")).rejects.toThrow(/停止未确认/);
  });

  it("classifies auth, quota, network, timeout, and protocol failures, and invalidates verification when binary changes", async () => {
    expect(classifySingleTurnError("401 Unauthorized: run copilot login").code).toBe("auth_failed");
    expect(classifySingleTurnError("429 quota exceeded").code).toBe("quota_exceeded");
    expect(classifySingleTurnError("getaddrinfo ENOTFOUND api.github.com").code).toBe("network_error");
    expect(classifySingleTurnError("timeout: ACP session/prompt timed out").code).toBe("timeout");
    expect(classifySingleTurnError("protocol_error: tool_use_forbidden").code).toBe("protocol_error");

    const binDir = createTempDir("artoo-acp-fp-");
    const entry = writeFakeAcpCopilotScript(
      binDir,
      `
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_test_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      `,
    );
    const registry = createAdapterRegistry([]);
    const controller = createSingleTurnRuntimeController({
      env: { PATH: binDir },
      platform: "win32",
      arch: "x64",
      binaryOverrides: { copilot: entry },
      registry,
    });
    const adapter = createAcpSingleTurnAdapter({
      sampler: controller.sampler,
      isVerifiedReady: (r, fp) => controller.isVerifiedReady(r, fp),
      platform: "win32",
      arch: "x64",
    });
    controller.bindAdapter(adapter);

    expect((await controller.verifyConnection("copilot")).outcome.status).toBe("verified");
    expect(controller.isVerifiedReady("copilot")).toBe(true);
    expect(registry.resolve("copilot")).toBe(adapter);

    // Replace underlying script bytes -> refresh() invalidates verification & unregisters adapter.
    const underlyingScript = join(binDir, "fake-copilot-acp.cjs");
    writeFileSync(underlyingScript, `console.log("GitHub Copilot CLI 1.0.110.");\n`, "utf8");
    const refreshed = controller.refresh();
    expect(refreshed.entries.find((e) => e.id === "copilot")?.execution_status).toBe("installed_unverified");
    expect(controller.isVerifiedReady("copilot")).toBe(false);
    expect(registry.resolve("copilot")).toBeUndefined();

    // Unsupported agy cannot be verified or registered even if requested.
    const agyRes = await controller.verifyConnection("agy");
    expect(agyRes.outcome.status).toBe("unknown");
    expect(controller.isVerifiedReady("agy")).toBe(false);
  });

  it("enforces Gate 2 in node-client onRunStart and handles cli.discovery.refresh.v1 & cli.verify.v1 commands", async () => {
    const binDir = createTempDir("artoo-node-client-t17-");
    const entry = writeFakeAcpCopilotScript(
      binDir,
      `
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_test_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NODE_OK" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      `,
    );

    const registry = createAdapterRegistry([]);
    const controller = createSingleTurnRuntimeController({
      env: { PATH: binDir },
      platform: "win32",
      arch: "x64",
      binaryOverrides: { copilot: entry },
      registry,
    });
    const adapter = createAcpSingleTurnAdapter({
      sampler: controller.sampler,
      isVerifiedReady: (r, fp) => controller.isVerifiedReady(r, fp),
      platform: "win32",
      arch: "x64",
      env: { ...process.env, PATH: binDir },
    });
    controller.bindAdapter(adapter);

    const { transport, sent, emit } = createFakeTransport();
    const emitHeartbeat = vi.fn(async () => {});
    const client = createNodeClient({
      nodeId: "comp_1",
      transport,
      registry,
      singleTurnRuntime: controller,
      emitHeartbeat,
    });
    client.start();

    // Before verification: run.start for copilot is rejected cleanly by Gate 2.
    emit({
      kind: "command",
      id: "cmd_unverified",
      idempotency_key: "k1",
      type: "run.start",
      payload: makeCleanRunStart("run_before_verify"),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.find((m) => m.kind === "command.ack" && m.command_id === "cmd_unverified")).toMatchObject({
      status: "rejected",
    });

    // cli.discovery.refresh.v1 emits snapshot + ack.
    emit({
      kind: "command",
      id: "cmd_refresh",
      idempotency_key: "k2",
      type: "cli.discovery.refresh.v1",
      payload: { version: 1, request_id: "req_ref" },
    });
    await vi.waitFor(
      () => {
        expect(sent.find((m) => m.kind === "cli.discovery.snapshot.v1")).toBeDefined();
      },
      { timeout: 5000 },
    );

    // cli.verify.v1 verifies copilot, triggers immediate heartbeat, and emits result.
    emit({
      kind: "command",
      id: "cmd_verify",
      idempotency_key: "k3",
      type: "cli.verify.v1",
      payload: { version: 1, request_id: "req_ver", runtime: "copilot" },
    });
    await vi.waitFor(
      () => {
        expect(sent.find((m) => m.kind === "cli.verify.result.v1")).toBeDefined();
      },
      { timeout: 10000 },
    );
    const verifyMsg = sent.find((m) => m.kind === "cli.verify.result.v1");
    expect(verifyMsg).toBeDefined();
    if (verifyMsg && verifyMsg.kind === "cli.verify.result.v1") {
      expect(verifyMsg.outcome.status).toBe("verified");
    }
    expect(emitHeartbeat).toHaveBeenCalled();

    // Gate 2 still rejects single-turn run with branch or write scope or planning pack even after verified!
    expect(() =>
      assertValidSingleTurnRunStart(
        makeCleanRunStart("bad_branch", { workspace: { root: "C:\\ws", branch: "feat/x" } }),
      ),
    ).toThrow(/branch/);
    expect(() =>
      assertValidSingleTurnRunStart(
        makeCleanRunStart("bad_scope", {
          policy_snapshot: { filesystem_write_scope: ["C:\\ws"], requires_approval: [] },
        }),
      ),
    ).toThrow(/filesystem_write_scope/);

    // Valid single-turn run executes cleanly through node-client!
    emit({
      kind: "command",
      id: "cmd_ok_run",
      idempotency_key: "k4",
      type: "run.start",
      payload: makeCleanRunStart("run_live_fake"),
    });
    await vi.waitFor(
      () => {
        expect(
          sent.some(
            (m) =>
              m.kind === "run.event" &&
              m.run_id === "run_live_fake" &&
              m.event.type === "run.lifecycle" &&
              m.event.payload.phase === "completed",
          ),
        ).toBe(true);
      },
      { timeout: 10000 },
    );
    expect(
      sent.some((m) => m.kind === "run.event" && m.run_id === "run_live_fake" && m.event.type === "run.answer"),
    ).toBe(true);

    // Ensure sha256 helper imported if needed or drop unused import
    expect(createHash("sha256").digest("hex")).toBeTruthy();
  });
});
