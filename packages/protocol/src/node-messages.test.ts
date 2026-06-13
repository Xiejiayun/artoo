import { describe, expect, it } from "vitest";

import {
  artifactCollectCommandSchema,
  commandAckSchema,
  nodeHeartbeatSchema,
  nodeHelloSchema,
  runStopCommandSchema
} from "./node-messages.js";

describe("node.hello", () => {
  const valid = {
    kind: "node.hello",
    node_id: "computer_123",
    protocol_version: "2026-06-11",
    artood_version: "0.1.0",
    machine: { hostname: "workstation", os: "windows", arch: "x64" }
  };

  it("accepts a well-formed hello", () => {
    expect(nodeHelloSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects empty node_id", () => {
    expect(nodeHelloSchema.safeParse({ ...valid, node_id: "" }).success).toBe(false);
  });

  it("rejects a wrong kind discriminator", () => {
    expect(nodeHelloSchema.safeParse({ ...valid, kind: "node.bye" }).success).toBe(false);
  });

  it("requires the machine block", () => {
    const { machine, ...withoutMachine } = valid;
    expect(nodeHelloSchema.safeParse(withoutMachine).success).toBe(false);
  });
});

describe("node.heartbeat", () => {
  const valid = {
    kind: "node.heartbeat",
    node_id: "computer_123",
    sequence: 42,
    resources: { cpu_load: 0.31, memory_used_pct: 62, disk_free_gb: 180 },
    runtimes: [{ runtime: "codex", status: "available", version: "unknown" }],
    running_instances: []
  };

  it("accepts a well-formed heartbeat", () => {
    expect(nodeHeartbeatSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a negative sequence", () => {
    expect(nodeHeartbeatSchema.safeParse({ ...valid, sequence: -1 }).success).toBe(false);
  });

  it("rejects a non-integer sequence", () => {
    expect(nodeHeartbeatSchema.safeParse({ ...valid, sequence: 1.5 }).success).toBe(false);
  });

  it("rejects an unknown runtime status", () => {
    expect(
      nodeHeartbeatSchema.safeParse({
        ...valid,
        runtimes: [{ runtime: "codex", status: "on_fire" }]
      }).success
    ).toBe(false);
  });
});

describe("command.ack", () => {
  const accepted = {
    kind: "command.ack",
    node_id: "computer_123",
    command_id: "cmd_123",
    status: "accepted",
    message: null
  };
  const rejected = {
    kind: "command.ack",
    node_id: "computer_123",
    command_id: "cmd_123",
    status: "rejected",
    error_code: "runtime_missing",
    message: "no codex runtime on this node"
  };

  it("accepts an accepted ack with no error code (message nullable)", () => {
    expect(commandAckSchema.safeParse(accepted).success).toBe(true);
    expect(commandAckSchema.safeParse({ ...accepted, message: undefined }).success).toBe(true);
  });

  it("accepts a rejected ack carrying a closed error code and message", () => {
    expect(commandAckSchema.safeParse(rejected).success).toBe(true);
  });

  it("rejects a rejected ack with no error_code", () => {
    const { error_code, ...withoutCode } = rejected;
    expect(commandAckSchema.safeParse(withoutCode).success).toBe(false);
  });

  it("rejects a rejected ack with an unknown error_code", () => {
    expect(commandAckSchema.safeParse({ ...rejected, error_code: "boom" }).success).toBe(false);
  });

  it("rejects a rejected ack with an empty message", () => {
    expect(commandAckSchema.safeParse({ ...rejected, message: "" }).success).toBe(false);
  });

  it("rejects an unknown ack status", () => {
    expect(commandAckSchema.safeParse({ ...accepted, status: "maybe" }).success).toBe(false);
  });
});

describe("server->node transport commands", () => {
  it("validates run.stop", () => {
    const ok = runStopCommandSchema.safeParse({
      kind: "command",
      id: "cmd_stop_1",
      idempotency_key: "run_1:stop",
      type: "run.stop",
      payload: { run_id: "run_1", reason: "user_cancelled" }
    });
    expect(ok.success).toBe(true);
  });

  it("rejects run.stop missing run_id", () => {
    expect(
      runStopCommandSchema.safeParse({
        kind: "command",
        id: "cmd_stop_1",
        idempotency_key: "run_1:stop",
        type: "run.stop",
        payload: { reason: "user_cancelled" }
      }).success
    ).toBe(false);
  });

  it("validates artifact.collect with glob paths", () => {
    const ok = artifactCollectCommandSchema.safeParse({
      kind: "command",
      id: "cmd_collect_1",
      idempotency_key: "run_1:collect_artifacts",
      type: "artifact.collect",
      payload: { run_id: "run_1", paths: ["artifacts/**", "*.patch"] }
    });
    expect(ok.success).toBe(true);
  });
});
