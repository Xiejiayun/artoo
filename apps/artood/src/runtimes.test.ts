import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import type { PreparedProductBootstrapGit } from "./product-bootstrap-git.js";
import { PRODUCT_VERIFICATION_LIFECYCLE_GUIDANCE } from "@artoo/domain";

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
  it("passes the same node-local bootstrap choice to both runtime presets", () => {
    const token = Object.freeze({}) as PreparedProductBootstrapGit, create = vi.spyOn(processAdapter, "createProcessAdapter");
    try {
      codexRuntime({ allowedRoots: ["/ws"], initializeRepository: true, productBootstrapGit: token });
      claudeCodeRuntime({ allowedRoots: ["/ws"], initializeRepository: true, productBootstrapGit: token });
      for (const [options] of create.mock.calls) {
        expect(options.productBootstrapGit).toBe(token); expect(options.initializeRepository).toBe(true);
      }
    } finally { create.mockRestore(); }
  });
  it("pages the complete author and reviewer context while preserving ordinary file-based prompts", () => {
    const create = vi.spyOn(processAdapter, "createProcessAdapter");
    try {
      codexRuntime({ allowedRoots: ["/ws"] });
      claudeCodeRuntime({ allowedRoots: ["/ws"] });
      for (const [options] of create.mock.calls) {
        for (const argv of [options.productCommand!, options.reviewCommand!]) {
          const prompt = argv.find(arg => arg.startsWith("First call mcp__artoo_workspace__context"));
          expect(prompt).toContain("offset:0 and limit:4096");
          expect(prompt).toContain("artoo-context-text-page.v1");
          expect(prompt).toContain("every page through eof:true");
          expect(prompt).toContain("first checksum as expected_checksum");
          expect(prompt).toContain("same checksum and size");
          expect(prompt).toContain("never guess omitted instructions");
          expect(prompt).not.toContain("Read the file {{context_pack_path}}");
        }
        for (const argv of [options.command, options.discussionCommand!]) {
          expect(argv.some(arg => arg.startsWith("Read the file {{context_pack_path}}. If its payload contains conversation"))).toBe(true);
          expect(argv.join(" ")).not.toContain("artoo-context-text-page.v1");
        }
      }
    } finally { create.mockRestore(); }
  });

  it("explains final evidence timing to authors and both review paths without changing manual prompts", () => {
    const create = vi.spyOn(processAdapter, "createProcessAdapter");
    try {
      codexRuntime({ allowedRoots: ["/ws"] });
      claudeCodeRuntime({ allowedRoots: ["/ws"] });
      for (const [options] of create.mock.calls) {
        for (const argv of [options.productCommand!, options.readOnlyCommand!, options.reviewCommand!]) {
          const prompt = argv.find(arg => arg.startsWith("First call mcp__artoo_workspace__context"));
          expect(prompt).toContain(PRODUCT_VERIFICATION_LIFECYCLE_GUIDANCE);
          expect(prompt).toContain("preview evidence is diagnostic, not final acceptance");
          expect(prompt).toContain("Missing coverage remains missing");
        }
        for (const argv of [options.command, options.discussionCommand!]) {
          expect(argv.join(" ")).not.toContain(PRODUCT_VERIFICATION_LIFECYCLE_GUIDANCE);
        }
      }
    } finally { create.mockRestore(); }
  });

  it("gives product authors only scoped workspace and research tools without changing ordinary commands", () => {
    const create = vi.spyOn(processAdapter, "createProcessAdapter");
    try {
      claudeCodeRuntime({ allowedRoots: ["/ws"], trustedExecution: true });
      const options = create.mock.calls[0]![0], command = options.productCommand!;
      expect(options.command).toContain("bypassPermissions");
      expect(command).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk", "--strict-mcp-config", "{{workspace_tools_mcp_path}}"]));
      expect(command[command.indexOf("--tools") + 1]).toBe("");
      const allowed = command[command.indexOf("--allowedTools") + 1]!.split(",");
      expect(allowed).toEqual(["context", "list", "read", "mkdir", "write", "edit", "remove", "verify", "read_evidence"].map((name) => `mcp__artoo_workspace__${name}`));
      expect(options.reviewCommand![options.reviewCommand!.indexOf("--allowedTools") + 1]).toBe("mcp__artoo_workspace__context,mcp__artoo_workspace__read_evidence");
      expect(options.reviewCommand![options.reviewCommand!.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
      expect(command).not.toContain("bypassPermissions");
      for (const argv of [command, options.discussionCommand!]) {
        expect(argv).toEqual(expect.arrayContaining(["--setting-sources", "user", "--disable-slash-commands", "--no-session-persistence"]));
        expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!)).toMatchObject({ disableAllHooks: true, disableClaudeAiConnectors: true });
      }
      claudeCodeRuntime({ allowedRoots: ["/ws"], command: mockCommand });
      expect(create.mock.calls[1]![0].productCommand).toBeUndefined();
    } finally { create.mockRestore(); }
  });
  it("wires opt-in broker tools for actual coding presets while keeping read-only discussions restricted", () => {
    const root = mkdtempSync(join(tmpdir(), "artoo-research-runtime-")), workspace = join(root, "workspace"); mkdirSync(workspace);
    const create = vi.spyOn(processAdapter, "createProcessAdapter");
    try {
      const options = { allowedRoots: [workspace], research: { receiptDirectory: join(root, "receipts"), braveApiKeyEnv: "LOCAL_RESEARCH_KEY" }, initializeRepository: true };
      expect(codexRuntime(options).capabilities).toContain("research.web");
      expect(claudeCodeRuntime(options).capabilities).toContain("research.web");
      const codex = create.mock.calls[0]![0], claude = create.mock.calls[1]![0];
      expect(codex.command.join(" ")).toContain("mcp_servers.artoo_research.command");
      expect(codex.command.join(" ")).toContain("{{research_config_json}}");
      expect(codex.productCommand!.join(" ")).toContain("{{workspace_tools_config_json}}");
      expect(codex.productCommand!.join(" ")).toContain("mcp_servers.artoo_workspace.tool_timeout_sec=960");
      expect(codex.productCommand!.join(" ")).toContain("mcp__artoo_workspace__verify");
      expect(codex.productCommand!.join(" ")).toContain("{{research_config_json}}");
      const approvalSettings = codex.productCommand!.filter((arg) => arg.includes(".approval_mode="));
      expect(approvalSettings).toEqual([
        ...["context", "list", "read", "mkdir", "write", "edit", "remove", "verify", "read_evidence"].map((name) => `mcp_servers.artoo_workspace.tools.${name}.approval_mode="approve"`),
        ...["fetch", "search"].map((name) => `mcp_servers.artoo_research.tools.${name}.approval_mode="approve"`),
      ]);
      expect(codex.productCommand).toContain('mcp_servers.artoo_workspace.enabled_tools=["context","list","read","mkdir","write","edit","remove","verify","read_evidence"]');
      expect(codex.reviewCommand).toContain('mcp_servers.artoo_workspace.enabled_tools=["context","read_evidence"]');
      expect(codex.reviewCommand!.filter((arg) => arg.includes(".approval_mode="))).toEqual(["context", "read_evidence"].map((name) => `mcp_servers.artoo_workspace.tools.${name}.approval_mode="approve"`));
      expect(codex.productCommand).toContain('mcp_servers.artoo_research.enabled_tools=["fetch","search"]');
      expect(codex.productCommand).toContain('mcp_servers.artoo_workspace.default_tools_approval_mode="prompt"');
      expect(codex.productCommand).toContain('mcp_servers.artoo_research.default_tools_approval_mode="prompt"');
      expect(codex.command.join(" ")).not.toContain(".approval_mode=");
      expect(codex.discussionCommand!.join(" ")).not.toContain(".approval_mode=");
      expect(codex.command.join(" ")).not.toContain("mcp_servers.artoo_workspace");
      expect(codex.discussionCommand!.join(" ")).not.toContain("mcp_servers");
      expect(claude.command).toEqual(expect.arrayContaining(["--mcp-config", "{{research_mcp_path}}", "mcp__artoo_research__fetch,mcp__artoo_research__search"]));
      expect(claude.discussionCommand).toContain("mcp__*");
      expect(codex.initializeRepository).toBe(true);
      expect(codexRuntime({ ...options, command: mockCommand }).capabilities).not.toContain("research.web");
    } finally { create.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("uses the configured program and Responses provider for tasks and read-only discussions without putting a key in argv", () => {
    const create = vi.spyOn(processAdapter, "createProcessAdapter");
    try {
      codexRuntime({ allowedRoots: ["/ws"], codex: { binaryPath: process.execPath, model: 'model-"quoted"', baseUrl: "http://127.0.0.1:18181/v1", apiKeyEnv: "ARTOO_CODEX_PROVIDER_KEY" } });
      const options = create.mock.calls[0]![0];
      for (const argv of [options.command, options.productCommand!, options.discussionCommand!]) {
        expect(argv[0]).toBe(process.execPath);
        expect(argv).toEqual(expect.arrayContaining(["--json", "--ephemeral", 'model_provider="artoo_desktop"', 'model_providers.artoo_desktop.wire_api="responses"', 'model_providers.artoo_desktop.env_key="ARTOO_CODEX_PROVIDER_KEY"', `model=${JSON.stringify('model-"quoted"')}`]));
      }
      expect(options.command).toContain("workspace-write");
      expect(options.productCommand).toContain("read-only");
      expect(options.productCommand).not.toContain("workspace-write");
      expect(options.discussionCommand).toContain("read-only");
      expect(options.discussionCommand).not.toContain("workspace-write");
      expect(options.outputFormat).toBe("codex-json");
      codexRuntime({ allowedRoots: ["/ws"], codex: { model: "test", baseUrl: "https://example.test/v1" } });
      expect(create.mock.calls[1]![0].command.some((arg) => arg.includes("env_key"))).toBe(false);
    } finally { create.mockRestore(); }
  });
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
      expect(create.mock.calls[2]![0].productCommand).toBeUndefined();
    } finally { create.mockRestore(); }
  });

  it("declares codex + claude-code runtimes with capability tags", () => {
    const registry = createAdapterRegistry([
      codexRuntime({ allowedRoots: ["/ws"] }),
      claudeCodeRuntime({ allowedRoots: ["/ws"] })
    ]);
    expect(registry.runtimes()).toEqual([
      { runtime: "codex", capabilities: ["code.read", "code.modify", "code.review", "test.run"] },
      { runtime: "claude-code", capabilities: ["code.read", "code.modify", "code.review", "test.run"] }
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
