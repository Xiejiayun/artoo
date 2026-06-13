import type { AgentInstanceConfig } from "@artoo/protocol";
import type { RunEvent } from "@artoo/protocol";
import { describe, expect, it } from "vitest";

import { createMockAdapter } from "./mock-adapter.js";

const config: AgentInstanceConfig = {
  runId: "run_1",
  taskId: "task_1",
  agentInstanceId: "ai_1",
  runtime: "mock-coder",
  workspaceRoot: "C:/workspace/artoo",
  runStart: {
    run_id: "run_1",
    task_id: "task_1",
    agent_instance_id: "ai_1",
    runtime: "mock-coder",
    workspace: { root: "C:/workspace/artoo" },
    context_pack: { id: "ctx_1", uri: "inline" },
    policy_snapshot: { filesystem_write_scope: ["C:/workspace/artoo"], requires_approval: [] },
    artifact_rules: { paths: ["*.patch"] }
  }
};

async function drain(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iter) {
    out.push(event);
  }
  return out;
}

describe("createMockAdapter", () => {
  it("scripts started -> output(s) -> artifact -> completed from domain payloads", async () => {
    const adapter = createMockAdapter({ outputLines: ["line a", "line b"] });
    const handle = await adapter.start(config);
    const events = await drain(adapter.streamEvents(handle));

    expect(events.map((e) => e.type)).toEqual([
      "run.lifecycle",
      "run.output",
      "run.output",
      "artifact.created",
      "run.lifecycle"
    ]);
    expect(events[0]).toEqual({ type: "run.lifecycle", payload: { phase: "started" } });
    expect(events[1]).toEqual({ type: "run.output", payload: { stream: "stdout", text: "line a" } });
    expect(events.at(-1)).toEqual({ type: "run.lifecycle", payload: { phase: "completed" } });
  });

  it("collectArtifacts returns the run artifact", async () => {
    const adapter = createMockAdapter();
    const handle = await adapter.start(config);
    const artifacts = await adapter.collectArtifacts(handle);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.payload.type).toBe("patch");
  });

  it("honors a custom finalPhase", async () => {
    const adapter = createMockAdapter({ outputLines: [], finalPhase: "failed" });
    const handle = await adapter.start(config);
    const events = await drain(adapter.streamEvents(handle));
    expect(events.at(-1)).toEqual({ type: "run.lifecycle", payload: { phase: "failed" } });
  });

  it("emits a cancelled lifecycle when stopped before output is streamed", async () => {
    const adapter = createMockAdapter({ outputLines: ["a", "b"] });
    const handle = await adapter.start(config);
    await adapter.stop(handle, "user_cancelled");
    const events = await drain(adapter.streamEvents(handle));
    expect(events.map((e) => e.type)).toEqual(["run.lifecycle", "run.lifecycle"]);
    expect(events.at(-1)).toEqual({ type: "run.lifecycle", payload: { phase: "cancelled" } });
  });
});
