import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandAck,
  NodeToServerMessage,
  RunEventMessage,
  RunStartCommand
} from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { describe, expect, it, vi } from "vitest";

import { createAdapterRegistry } from "./adapter-registry.js";
import { createNodeClient } from "./node-client.js";
import { claudeCodeRuntime, codexRuntime } from "./runtimes.js";
import * as processAdapter from "./process-adapter.js";

const mockAgent = fileURLToPath(new URL("../test-fixtures/mock-agent.mjs", import.meta.url));
// Deterministic stand-in for the real CLI: same command both presets use in tests.
const mockCommand = [process.execPath, mockAgent, "--workspace", "{{workspace_root}}", "--context", "{{context_pack_path}}"];

function runStartFor(runtime: string, workspace: string): RunStartCommand {
  return {
    kind: "command",
    id: "cmd_1",
    idempotency_key: "run_1:start",
    type: "run.start",
    payload: {
      run_id: "run_1",
      task_id: "task_1",
      agent_instance_id: "ai_1",
      runtime,
      workspace: { root: workspace },
      context_pack: { id: "ctx_1", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] },
      artifact_rules: { paths: ["*.patch"] }
    }
  };
}

function isRunEvent(m: NodeToServerMessage): m is RunEventMessage {
  return m.kind === "run.event";
}
function isAck(m: NodeToServerMessage): m is CommandAck {
  return m.kind === "command.ack";
}

describe("runtime presets", () => {
  it("uses real CLI read-only controls for planning discussions even on a trusted node", () => {
    const create = vi.spyOn(processAdapter, "createProcessAdapter");
    try {
      codexRuntime({ allowedRoots: ["/ws"], trustedExecution: true });
      claudeCodeRuntime({ allowedRoots: ["/ws"], trustedExecution: true });
      const codex = create.mock.calls[0]![0];
      const claude = create.mock.calls[1]![0];
      expect(codex.discussionCommand).toEqual(expect.arrayContaining(["exec", "--json", "-s", "read-only"]));
      expect(codex.discussionCommand).not.toContain("workspace-write");
      expect(claude.discussionCommand).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", "--disallowedTools", "mcp__*", "--disable-slash-commands"]));
      expect(claude.discussionCommand).not.toContain("bypassPermissions");
      codexRuntime({ allowedRoots: ["/ws"], command: mockCommand });
      expect(create.mock.calls[2]![0].discussionCommand).toBeUndefined();
    } finally { create.mockRestore(); }
  });

  it("declares codex + claude-code runtimes with capability tags", () => {
    const registry = createAdapterRegistry([
      codexRuntime({ allowedRoots: ["/ws"] }),
      claudeCodeRuntime({ allowedRoots: ["/ws"] })
    ]);
    expect(registry.runtimes()).toEqual([
      { runtime: "codex", capabilities: ["code.read", "code.modify"] },
      { runtime: "claude-code", capabilities: ["code.read", "code.modify", "code.review"] }
    ]);
  });

  it("routes run.start to a preset adapter that runs to completion with an artifact", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "artoo-rt-"));
    try {
      const registry = createAdapterRegistry([
        codexRuntime({ allowedRoots: [workspace], command: mockCommand }),
        claudeCodeRuntime({ allowedRoots: [workspace], command: mockCommand })
      ]);
      const channel = createInProcessChannel();
      const client = createNodeClient({ nodeId: "computer_1", transport: channel.node, registry });
      client.start();

      const received: NodeToServerMessage[] = [];
      const done = new Promise<void>((resolve) => {
        channel.serverTransport.subscribe((m) => {
          received.push(m);
          if (isRunEvent(m) && m.event.type === "run.lifecycle" && m.event.payload.phase === "completed") {
            resolve();
          }
        });
      });

      await channel.serverTransport.send(runStartFor("claude-code", workspace));
      await done;
      await client.stop();

      expect(received.filter(isAck)[0]).toMatchObject({ status: "accepted" });
      const runEvents = received.filter(isRunEvent);
      expect(runEvents.some((e) => e.event.type === "artifact.created")).toBe(true);
      expect(runEvents.at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
