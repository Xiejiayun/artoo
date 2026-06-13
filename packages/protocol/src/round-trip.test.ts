import type {
  ArtifactPayload,
  RunLifecyclePayload,
  RunOutputPayload,
  RunStartPayload
} from "@artoo/domain";
import { describe, expect, it } from "vitest";

import {
  runEventMessageSchema,
  runStartCommandSchema
} from "./node-messages.js";

/**
 * Contract test for the domain/protocol boundary: a domain payload, once wrapped
 * in a protocol wire envelope and round-tripped through JSON + schema parse, must
 * come back byte-for-byte equal. This proves protocol frames (never redefines)
 * domain payloads — a single source of truth with no shape drift.
 */
describe("payload round-trip through protocol envelope", () => {
  function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
    return schema.parse(JSON.parse(JSON.stringify(value)));
  }

  it("preserves a RunStartPayload through the run.start command", () => {
    const payload: RunStartPayload = {
      run_id: "run_1",
      task_id: "task_1",
      agent_instance_id: "ai_1",
      runtime: "codex",
      workspace: { root: "C:/workspace/artoo", branch: "artoo/task-6" },
      context_pack: { id: "ctx_1", uri: "inline" },
      policy_snapshot: {
        filesystem_write_scope: ["C:/workspace/artoo"],
        requires_approval: ["git.push"]
      },
      artifact_rules: { paths: ["artifacts/**"] }
    };
    const command = {
      kind: "command" as const,
      id: "cmd_1",
      idempotency_key: "run_1:start",
      type: "run.start" as const,
      payload
    };
    expect(roundTrip(runStartCommandSchema, command).payload).toEqual(payload);
  });

  it("preserves each run.event payload variant", () => {
    const output: RunOutputPayload = { stream: "stderr", text: "warning: x" };
    const lifecycle: RunLifecyclePayload = { phase: "failed", reason: "exit 1" };
    const artifact: ArtifactPayload = {
      type: "patch",
      uri: "file:///out.patch",
      metadata: { files: 3 },
      checksum: "sha256:abc"
    };

    const base = { kind: "run.event" as const, node_id: "n1", run_id: "run_1" };
    expect(roundTrip(runEventMessageSchema, { ...base, sequence: 0, event: { type: "run.output", payload: output } }).event.payload).toEqual(output);
    expect(roundTrip(runEventMessageSchema, { ...base, sequence: 1, event: { type: "run.lifecycle", payload: lifecycle } }).event.payload).toEqual(lifecycle);
    expect(roundTrip(runEventMessageSchema, { ...base, sequence: 2, event: { type: "artifact.created", payload: artifact } }).event.payload).toEqual(artifact);
  });
});
