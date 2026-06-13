import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentInstanceConfig, RunEvent } from "@artoo/protocol";
import { WorkspaceScopeError } from "@artoo/protocol";
import { describe, expect, it } from "vitest";

import { createProcessAdapter } from "./process-adapter.js";

const fixture = fileURLToPath(new URL("../test-fixtures/mock-agent.mjs", import.meta.url));

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "artoo-proc-"));
}

function makeConfig(workspace: string): AgentInstanceConfig {
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
      context_pack: { id: "ctx_1", uri: "inline" },
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
      expect(readFileSync(join(ws, "context_pack.md"), "utf8")).toContain("Context Pack ctx_1");
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
});
