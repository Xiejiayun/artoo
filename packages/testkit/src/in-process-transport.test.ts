import type { RunEventMessage, RunStopCommand } from "@artoo/protocol";
import { describe, expect, it } from "vitest";

import { createInProcessChannel } from "./in-process-transport.js";

const stopCommand: RunStopCommand = {
  kind: "command",
  id: "cmd_1",
  idempotency_key: "run_1:stop",
  type: "run.stop",
  payload: { run_id: "run_1", reason: "user_cancelled" }
};

const runEvent: RunEventMessage = {
  kind: "run.event",
  node_id: "n1",
  run_id: "run_1",
  sequence: 0,
  event: { type: "run.output", payload: { stream: "stdout", text: "hi" } }
};

describe("InProcessChannel", () => {
  it("delivers server->node commands to node subscribers", async () => {
    const ch = createInProcessChannel();
    const received: RunStopCommand[] = [];
    ch.node.subscribe((m) => received.push(m as RunStopCommand));
    await ch.serverTransport.send(stopCommand);
    expect(received).toEqual([stopCommand]);
  });

  it("delivers node->server messages to server subscribers", async () => {
    const ch = createInProcessChannel();
    const received: RunEventMessage[] = [];
    ch.serverTransport.subscribe((m) => received.push(m as RunEventMessage));
    await ch.node.send(runEvent);
    expect(received).toEqual([runEvent]);
  });

  it("stops delivery after unsubscribe", async () => {
    const ch = createInProcessChannel();
    const received: unknown[] = [];
    const unsubscribe = ch.node.subscribe((m) => received.push(m));
    unsubscribe();
    await ch.serverTransport.send(stopCommand);
    expect(received).toEqual([]);
  });

  it("rejects sends after close", async () => {
    const ch = createInProcessChannel();
    await ch.close();
    await expect(ch.serverTransport.send(stopCommand)).rejects.toThrow(/closed/);
    await expect(ch.node.send(runEvent)).rejects.toThrow(/closed/);
  });
});
