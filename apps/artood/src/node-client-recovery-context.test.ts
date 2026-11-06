// Controlled dispatch defense in depth: bypass the protocol parser/admission snapshot only
// to exercise NodeClient's own rejection before adapter selection or physical execution.
// This is not native qualification and does not replace real protocol contract coverage.
import { describe, expect, it, vi } from "vitest";
import { createInProcessChannel, createMockAdapter } from "@artoo/testkit";
import type { CommandAck, RunStartCommand } from "@artoo/protocol";
vi.mock("@artoo/protocol", async original => ({ ...await original<typeof import("@artoo/protocol")>(),
  runStartCommandSchema: { parse: (command: unknown) => command } }));
vi.mock("./owned-result-admission.js", () => ({ snapshotOwnedResultRunAdmission: (request: unknown) => ({ request }) }));
import { createNodeClient } from "./node-client.js";

function ordinary(): RunStartCommand {
  return { kind: "command", id: "start", idempotency_key: "start", type: "run.start", payload: {
    run_id: "run", task_id: "task", agent_instance_id: "instance", runtime: "mock-coder", workspace: { root: "C:/controlled-product" },
    context_pack: { id: "context", uri: "inline" }, policy_snapshot: { filesystem_write_scope: ["C:/controlled-product"], requires_approval: [] },
    artifact_rules: { paths: [] } } };
}

describe("NodeClient dedicated recovery context exclusion", () => {
  for (const context of ["imported_recovery_validation", "imported_recovery_validation_review_subject"] as const) {
    for (const owned of [false, true]) {
      it(`rejects ${context} through ${owned ? "owned result" : "ordinary"} dispatch before an adapter starts`, async () => {
        const command = ordinary();
        command.payload.context_pack.payload = { [context]: {} } as never;
        const dispatch = owned ? { ...command, type: "run.start.owned-result.v1", payload: { run_start: command.payload } } : command;
        const channel = createInProcessChannel(), adapter = createMockAdapter(), start = vi.fn(adapter.start), acks: CommandAck[] = [];
        const client = createNodeClient({ nodeId: "node", transport: channel.node, adapter: { ...adapter, start } });
        channel.serverTransport.subscribe(message => { if (message.kind === "command.ack") acks.push(message); });
        client.start(); await client.ready();
        try {
          await channel.serverTransport.send(dispatch as never);
          expect(start).not.toHaveBeenCalled();
          expect(acks).toMatchObject([{ status: "rejected", message: expect.stringContaining(owned
            ? "does not support ordinary owned-result execution" : "requires its dedicated local operation controller") }]);
        } finally { await client.stop(); }
      });
    }
  }

  it("preserves an ordinary manual start with no recovery descriptor", async () => {
    const channel = createInProcessChannel(), adapter = createMockAdapter(), start = vi.fn(adapter.start), acks: CommandAck[] = [];
    const client = createNodeClient({ nodeId: "node", transport: channel.node, adapter: { ...adapter, start } });
    channel.serverTransport.subscribe(message => { if (message.kind === "command.ack") acks.push(message); });
    client.start(); await client.ready();
    try {
      await channel.serverTransport.send(ordinary());
      // The in-process send queues dispatch; it does not await asynchronous ACK delivery.
      await vi.waitFor(() => expect(acks).toHaveLength(1));
      expect(start).toHaveBeenCalledOnce(); expect(acks).toMatchObject([{ command_id: "start", status: "accepted" }]);
    } finally { await client.stop(); }
  });
});
