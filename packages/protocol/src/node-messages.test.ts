import { describe, expect, it } from "vitest";

import {
  artifactCollectCommandSchema,
  commandAckSchema,
  nodeHeartbeatSchema,
  nodeHelloSchema,
  nodeSessionProbeSchema,
  nodeSessionReadyCommandSchema,
  nodeSessionPongCommandSchema,
  runStopCommandSchema,
  runEventBodySchema,
  runtimeStatusSchema
} from "./node-messages.js";

describe("structured runtime results", () => {
  it("accepts final answers and partial provider usage while rejecting invalid quantities", () => {
    expect(runEventBodySchema.safeParse({ type: "run.answer", payload: { text: "Final answer" } }).success).toBe(true);
    expect(runEventBodySchema.safeParse({ type: "run.usage", payload: { input_tokens: 12 } }).success).toBe(true);
    expect(runEventBodySchema.safeParse({ type: "run.usage", payload: { cost_usd: -1 } }).success).toBe(false);
    expect(runEventBodySchema.safeParse({ type: "run.usage", payload: { input_tokens: 1.5 } }).success).toBe(false);
    expect(runEventBodySchema.safeParse({ type: "run.answer", payload: { text: "x".repeat(200_001) } }).success).toBe(false);
  });
});

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

  it("accepts versioned workspace suggestions without requiring them from older nodes", () => {
    expect(nodeHelloSchema.parse(valid).workspace_roots).toBeUndefined();
    const workspace_roots = { version: 1, paths: ["C:/ArtooWorkspaces", "/home/member/ArtooWorkspaces"] };
    expect(nodeHelloSchema.parse({ ...valid, workspace_roots }).workspace_roots).toEqual(workspace_roots);
    for (const invalid of [{ version: 2, paths: ["/work"] }, { version: 1, paths: ["relative"] }, { version: 1, paths: ["/work\nsecret"] }, { version: 1, paths: [] }]) {
      expect(nodeHelloSchema.safeParse({ ...valid, workspace_roots: invalid }).success).toBe(false);
    }
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

describe("session identifier compatibility", () => {
  function frames(token: string) {
    const node_id = "computer_123", command = { kind: "command", id: "cmd_1", idempotency_key: "key_1" };
    return [
      [nodeHelloSchema, { kind: "node.hello", node_id, protocol_version: "2026-06-11", artood_version: "0.1.0",
        machine: { hostname: "workstation", os: "windows", arch: "x64" },
        managed_receipts: { version: 1, nonce: token, required_contract: "run-event-body-v1" } }],
      [nodeSessionProbeSchema, { kind: "node.session.probe", node_id, session_id: token, probe_id: token }],
      [nodeSessionReadyCommandSchema, { ...command, type: "node.session.ready",
        payload: { version: 1, node_id, hello_nonce: token, session_id: token, receipt_contract: "run-event-body-v1",
          sequence_max: 2147483647, liveness: { probe_interval_ms: 1000, probe_timeout_ms: 5000 } } }],
      [nodeSessionPongCommandSchema, { ...command, type: "node.session.pong",
        payload: { node_id, session_id: token, probe_id: token } }],
    ] as const;
  }

  it.each(["12345678-1234-4000-8000-123456789abc", "ABCDEF12-ABCD-0000-0000-ABCDEF123456"])(
    "preserves the original opaque hexadecimal token shape and case: %s", (token) => {
      for (const [schema, frame] of frames(token)) expect(schema.parse(frame)).toEqual(frame);
    },
  );

  it.each(["", "ABCDEF12-ABCD-0000-0000-ABCDEF12345Z", "ABCDEF12ABCD00000000ABCDEF123456", " 12345678-1234-4000-8000-123456789abc"])(
    "still rejects malformed session identifiers: %j", (token) => {
      for (const [schema, frame] of frames(token)) expect(schema.safeParse(frame).success).toBe(false);
    },
  );
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

  it("keeps an explicit empty runtime snapshot distinct from an absent snapshot", () => {
    expect(nodeHeartbeatSchema.parse({ ...valid, runtimes: [] }).runtimes).toEqual([]);
    const { runtimes: _runtimes, ...absent } = valid;
    expect(nodeHeartbeatSchema.safeParse(absent).success).toBe(false);
  });

  it("preserves finite JSON integer sequences beyond the safe range and existing bounds", () => {
    for (const sequence of [0, 42, 9007199254740992]) {
      const wire = JSON.parse(JSON.stringify({ ...valid, sequence }));
      expect(nodeHeartbeatSchema.parse(wire).sequence).toBe(sequence);
    }
    for (const sequence of [-1, 1.5, NaN, Infinity, -Infinity, null, undefined]) {
      expect(nodeHeartbeatSchema.safeParse({ ...valid, sequence }).success).toBe(false);
    }
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

  it("defaults runtime capabilities to [] when absent (back-compat)", () => {
    // Old heartbeats (no capabilities key) must still parse, yielding [].
    const parsed = nodeHeartbeatSchema.parse(valid);
    expect(parsed.runtimes[0]?.capabilities).toEqual([]);
  });

  it("accepts and preserves runtime capability tags", () => {
    const parsed = nodeHeartbeatSchema.parse({
      ...valid,
      runtimes: [
        { runtime: "codex", status: "available", capabilities: ["code.read", "code.modify"] }
      ]
    });
    expect(parsed.runtimes[0]?.capabilities).toEqual(["code.read", "code.modify"]);
  });

  it("normalizes a runtime status's capabilities to [] (never undefined)", () => {
    const parsed = runtimeStatusSchema.parse({ runtime: "codex", status: "available" });
    expect(parsed.capabilities).toEqual([]);
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
