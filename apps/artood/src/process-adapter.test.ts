import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentInstanceConfig, RunEvent } from "@artoo/protocol";
import { WorkspaceScopeError } from "@artoo/protocol";
import { describe, expect, it } from "vitest";

import { createProcessAdapter } from "./process-adapter.js";

const fixture = fileURLToPath(new URL("../test-fixtures/mock-agent.mjs", import.meta.url));
const structuredFixture = fileURLToPath(new URL("../test-fixtures/structured-agent.mjs", import.meta.url));

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "artoo-proc-"));
}

function makeConfig(workspace: string): AgentInstanceConfig {
  const contextPack = {
    task: {
      id: "task_1",
      title: "Process adapter task",
      description: "Make the runtime prove it received the task.",
      acceptance_criteria: ["write changes.patch"]
    },
    project: { id: "proj_1", name: "Artoo", default_workspace: workspace },
    workspace: { root: workspace, file_scope: ["src/**"] },
    policy: { filesystem_write_scope: [workspace], requires_approval: ["git.push"] },
    memory: { task_summary: null, project_notes: ["prefer small patches"] },
    artifacts: { expected: ["changes.patch"] }
  };
  return {
    runId: "run_1",
    taskId: "task_1",
    agentInstanceId: "ai_1",
    runtime: "codex",
    workspaceRoot: workspace,
    runStart: {
      run_id: "run_1",
      task_id: "task_1",
      agent_instance_id: "ai_1",
      runtime: "codex",
      workspace: { root: workspace },
      context_pack: { id: "ctx_1", payload: contextPack },
      policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] },
      artifact_rules: { paths: ["*.patch"] }
    }
  };
}

async function drain(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iter) {
    out.push(event);
  }
  return out;
}

function isOutput(e: RunEvent): e is Extract<RunEvent, { type: "run.output" }> {
  return e.type === "run.output";
}

const cmd = [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--context", "{{context_pack_path}}"];

describe("createProcessAdapter", () => {
  it("refuses discussion before writing context when the custom runtime has no restricted command", async () => {
    const ws = makeWorkspace();
    try {
      const config = makeConfig(ws);
      config.runStart.context_pack.payload!.policy.execution_mode = "discussion";
      const adapter = createProcessAdapter({ command: cmd, allowedRoots: [ws] });
      await expect(adapter.start(config)).rejects.toThrow("read-only discussion command");
      expect(existsSync(join(ws, "context_pack.md"))).toBe(false);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("selects the restricted discussion command and never publishes stale workspace artifacts", async () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, "changes.patch"), "stale patch from earlier work");
      const config = makeConfig(ws);
      config.runStart.context_pack.payload!.policy.execution_mode = "discussion";
      const adapter = createProcessAdapter({ command: ["unrestricted-command-must-not-run"],
        discussionCommand: [process.execPath, structuredFixture, "codex"], outputFormat: "codex-json",
        allowedRoots: [ws], artifacts: [{ type: "patch", path: "changes.patch" }] });
      const handle = await adapter.start(config);
      const events = await drain(adapter.streamEvents(handle));
      expect(events.some((event) => event.type === "run.answer")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
      expect(events.some((event) => event.type === "artifact.created")).toBe(false);
      expect(await adapter.collectArtifacts(handle)).toEqual([]);
      expect(readFileSync(join(ws, "changes.patch"), "utf8")).toBe("stale patch from earlier work");
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it.each(["codex", "claude"] as const)("extracts the %s final answer and usage from a real JSONL subprocess", async (provider) => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({ command: [process.execPath, structuredFixture, provider],
        outputFormat: provider === "codex" ? "codex-json" : "claude-json", allowedRoots: [ws] });
      const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(ws))));
      expect(events.filter((event) => event.type === "run.answer")).toEqual([{ type: "run.answer", payload: { text: "已完成你的请求，测试通过。" } }]);
      const usage = events.find((event) => event.type === "run.usage");
      expect(usage).toMatchObject({ payload: { input_tokens: provider === "codex" ? 101 : 91, provider_session_id: `fixture_${provider}` } });
      if (provider === "codex") expect(usage!.payload).not.toHaveProperty("cost_usd");
      else expect(usage!.payload).toHaveProperty("cost_usd", 0.005);
      expect(events.filter(isOutput).some((event) => event.payload.text.includes("Inspecting files"))).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
      expect(events.findIndex((event) => event.type === "run.answer")).toBeLessThan(events.length - 1);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("fails a provider error result even when the CLI exits zero and preserves reported spend", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({ command: [process.execPath, structuredFixture, "error"], outputFormat: "claude-json", allowedRoots: [ws] });
      const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(ws))));
      expect(events.some((event) => event.type === "run.answer")).toBe(false);
      expect(events.find((event) => event.type === "run.usage")).toMatchObject({ payload: { cost_usd: 0.002 } });
      expect(events.at(-1)).toEqual({ type: "run.lifecycle", payload: { phase: "failed", reason: "Turn limit reached" } });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it.each(["codex", "claude"] as const)("preserves the %s provider error when its unterminated final record exits nonzero", async (provider) => {
    const ws = makeWorkspace();
    const reason = "API Error: 400 The requested model is not supported.";
    const record = provider === "claude"
      ? { type: "result", subtype: "success", is_error: true, result: reason, total_cost_usd: 0.002 }
      : { type: "turn.failed", error: { message: reason } };
    try {
      const adapter = createProcessAdapter({
        command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(record))}); process.exitCode = 1;`],
        outputFormat: provider === "claude" ? "claude-json" : "codex-json", allowedRoots: [ws],
      });
      const events = await drain(adapter.streamEvents(await adapter.start(makeConfig(ws))));
      expect(events.some((event) => event.type === "run.answer")).toBe(false);
      expect(events.filter((event) => event.type === "run.lifecycle" && event.payload.phase === "failed")).toEqual([
        { type: "run.lifecycle", payload: { phase: "failed", reason } },
      ]);
      if (provider === "claude") expect(events.find((event) => event.type === "run.usage")).toMatchObject({ payload: { cost_usd: 0.002 } });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("spawns, streams stdout/stderr, collects the artifact, and completes", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: cmd,
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const handle = await adapter.start(makeConfig(ws));
      const events = await drain(adapter.streamEvents(handle));

      expect(events[0]).toEqual({ type: "run.lifecycle", payload: { phase: "started" } });

      const stdout = events.filter(isOutput).filter((e) => e.payload.stream === "stdout").map((e) => e.payload.text);
      expect(stdout).toContain("mock-agent: reading context");
      expect(stdout).toContain("mock-agent: done");
      expect(events.filter(isOutput).some((e) => e.payload.stream === "stderr" && e.payload.text.includes("warning"))).toBe(true);

      const artifact = events.find((e) => e.type === "artifact.created");
      expect(artifact?.payload).toMatchObject({ type: "patch" });

      expect(events.at(-1)).toEqual({ type: "run.lifecycle", payload: { phase: "completed", reason: null } });

      // context pack was written into the workspace for the agent
      expect(existsSync(join(ws, "context_pack.md"))).toBe(true);
      const context = readFileSync(join(ws, "context_pack.md"), "utf8");
      expect(context).toContain("Context Pack ctx_1");
      expect(context).toContain("## Task");
      expect(context).toContain("title: Process adapter task");
      expect(context).toContain("- write changes.patch");
      expect(context).toContain("## Raw Payload");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("maps a non-zero exit to run.lifecycle failed", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--fail"],
        allowedRoots: [ws]
      });
      const handle = await adapter.start(makeConfig(ws));
      const events = await drain(adapter.streamEvents(handle));
      expect(events.at(-1)).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed" } });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects an out-of-scope workspace before spawning", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({ command: cmd, allowedRoots: [join(ws, "allowed")] });
      await expect(adapter.start(makeConfig(ws))).rejects.toBeInstanceOf(WorkspaceScopeError);
      // nothing was written outside scope
      expect(existsSync(join(ws, "context_pack.md"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects a context pack path that escapes the workspace", async () => {
    const ws = makeWorkspace();
    const escapedName = `${basename(ws)}-context_pack.md`;
    try {
      const adapter = createProcessAdapter({
        command: cmd,
        allowedRoots: [ws],
        contextPackFilename: `../${escapedName}`
      });
      await expect(adapter.start(makeConfig(ws))).rejects.toBeInstanceOf(WorkspaceScopeError);
      expect(existsSync(join(ws, "..", escapedName))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(join(ws, "..", escapedName), { force: true });
    }
  });

  it("rejects a junction/symlink that escapes the local workspace root", async () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace();
    try {
      symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
      const adapter = createProcessAdapter({ command: cmd, allowedRoots: [workspace], contextPackFilename: "escape/context_pack.md" });
      await expect(adapter.start(makeConfig(workspace))).rejects.toBeInstanceOf(WorkspaceScopeError);
      expect(existsSync(join(outside, "context_pack.md"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects artifact specs that escape the workspace before writing context", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: cmd,
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "../escaped.patch" }]
      });
      await expect(adapter.start(makeConfig(ws))).rejects.toBeInstanceOf(WorkspaceScopeError);
      expect(existsSync(join(ws, "context_pack.md"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects spawn failures from start", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: ["artoo-missing-command-for-test"],
        allowedRoots: [ws]
      });
      await expect(adapter.start(makeConfig(ws))).rejects.toThrow();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("maps stop to run.lifecycle cancelled without collecting completion artifacts", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: [
          process.execPath,
          fixture,
          "--workspace",
          "{{workspace_root}}",
          "--context",
          "{{context_pack_path}}",
          "--sleep-ms",
          "5000"
        ],
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const handle = await adapter.start(makeConfig(ws));
      const eventsPromise = drain(adapter.streamEvents(handle));
      await adapter.stop(handle, "user_cancelled");
      const events = await eventsPromise;

      expect(events.at(-1)).toEqual({
        type: "run.lifecycle",
        payload: { phase: "cancelled", reason: "user_cancelled" }
      });
      expect(events.some((e) => e.type === "artifact.created")).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("collectArtifacts returns the workspace artifact with a checksum", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: cmd,
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const handle = await adapter.start(makeConfig(ws));
      await drain(adapter.streamEvents(handle));
      const artifacts = await adapter.collectArtifacts(handle);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.payload.type).toBe("patch");
      expect(artifacts[0]?.payload.checksum).toMatch(/^sha256:/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("closes child stdin so a stdin-reading process does not hang", async () => {
    const ws = makeWorkspace();
    try {
      const adapter = createProcessAdapter({
        command: [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--read-stdin"],
        allowedRoots: [ws],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const handle = await adapter.start(makeConfig(ws));
      // The fixture blocks until stdin EOF; if the adapter left stdin open this
      // would never reach a terminal lifecycle (the run would hang).
      const events = await drain(adapter.streamEvents(handle));
      expect(events.at(-1)).toEqual({ type: "run.lifecycle", payload: { phase: "completed", reason: null } });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
