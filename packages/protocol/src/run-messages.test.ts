import type { RunStartPayload } from "@artoo/domain";
import { describe, expect, it } from "vitest";

import {
  commandSchema,
  runEventBodySchema,
  runEventMessageSchema,
  runStartCommandSchema
} from "./node-messages.js";

const runStart: RunStartPayload = {
  run_id: "run_1",
  task_id: "task_1",
  agent_instance_id: "ai_1",
  runtime: "codex",
  workspace: { root: "C:/workspace/artoo" },
  context_pack: { id: "ctx_1", uri: "inline" },
  policy_snapshot: {
    filesystem_write_scope: ["C:/workspace/artoo"],
    requires_approval: ["git.push", "external.post"]
  },
  artifact_rules: { paths: ["artifacts/**", "*.patch"] }
};

const runStartCommand = {
  kind: "command",
  id: "cmd_start_1",
  idempotency_key: "run_1:start",
  type: "run.start",
  payload: runStart
};

describe("run.start command", () => {
  it("accepts a command carrying a valid domain RunStartPayload", () => {
    expect(runStartCommandSchema.safeParse(runStartCommand).success).toBe(true);
  });

  it("is selected by the command discriminated union", () => {
    const parsed = commandSchema.parse(runStartCommand);
    expect(parsed.type).toBe("run.start");
  });

  it("rejects a payload that violates the domain contract (context_pack without uri/payload)", () => {
    const bad = {
      ...runStartCommand,
      payload: { ...runStart, context_pack: { id: "ctx_1" } }
    };
    expect(runStartCommandSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty protocol-critical id from the domain payload", () => {
    const bad = { ...runStartCommand, payload: { ...runStart, run_id: "" } };
    expect(runStartCommandSchema.safeParse(bad).success).toBe(false);
  });
});

describe("run.event body", () => {
  it("accepts each domain payload variant", () => {
    expect(runEventBodySchema.safeParse({ type: "run.output", payload: { stream: "stdout", text: "ok" } }).success).toBe(true);
    expect(runEventBodySchema.safeParse({ type: "run.lifecycle", payload: { phase: "completed" } }).success).toBe(true);
    expect(
      runEventBodySchema.safeParse({
        type: "artifact.created",
        payload: { type: "patch", uri: "file:///x.patch", metadata: {} }
      }).success
    ).toBe(true);
  });

  it("rejects an unknown event type", () => {
    expect(runEventBodySchema.safeParse({ type: "run.exploded", payload: {} }).success).toBe(false);
  });

  it("rejects a payload mismatched to its event type", () => {
    expect(runEventBodySchema.safeParse({ type: "run.output", payload: { phase: "completed" } }).success).toBe(false);
  });
});

describe("run.event message", () => {
  const message = {
    kind: "run.event",
    node_id: "computer_1",
    run_id: "run_1",
    sequence: 0,
    event: { type: "run.output", payload: { stream: "stdout", text: "tests passed" } }
  };

  it("accepts a well-formed run.event with the transport tuple", () => {
    expect(runEventMessageSchema.safeParse(message).success).toBe(true);
  });

  it("rejects a negative sequence", () => {
    expect(runEventMessageSchema.safeParse({ ...message, sequence: -1 }).success).toBe(false);
  });

  it("rejects an empty node_id / run_id", () => {
    expect(runEventMessageSchema.safeParse({ ...message, node_id: "" }).success).toBe(false);
    expect(runEventMessageSchema.safeParse({ ...message, run_id: "" }).success).toBe(false);
  });
});
