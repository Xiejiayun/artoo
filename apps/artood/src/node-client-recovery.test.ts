// Controlled dispatch seam only: no native supervisor or execution qualification.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInProcessChannel, createMockAdapter } from "@artoo/testkit";
import type { CommandAck, RunStartCommand } from "@artoo/protocol";
const recovery = vi.hoisted(() => ({ handle: vi.fn(), isActive: vi.fn(), allowsOrdinary: vi.fn(), readRuntime: vi.fn(),
  invalidate: vi.fn(), settled: vi.fn() }));
vi.mock("./source-recovery-client.js", () => ({ createProductSourceRecoveryClient: () => recovery }));
import { createNodeClient } from "./node-client.js";
beforeEach(() => {
  vi.resetAllMocks(); recovery.handle.mockResolvedValue(false); recovery.isActive.mockReturnValue(false); recovery.settled.mockResolvedValue(undefined);
});
const command: RunStartCommand = { kind: "command", id: "start", idempotency_key: "start", type: "run.start", payload: {
  run_id: "run", task_id: "task", agent_instance_id: "instance", runtime: "mock-coder", workspace: { root: "C:/controlled-product" },
  context_pack: { id: "context", uri: "inline" }, policy_snapshot: { filesystem_write_scope: ["C:/controlled-product"], requires_approval: [] },
  artifact_rules: { paths: [] } } };
describe("Node guardian dispatch fence", () => {
  it("rejects ordinary starts before registration without invoking an adapter", async () => {
    const channel = createInProcessChannel(), adapter = createMockAdapter(), start = vi.fn(adapter.start), activate = vi.fn(), acks: CommandAck[] = [];
    const client = createNodeClient({ nodeId: "node", transport: channel.node, adapter: { ...adapter, start },
      productSourceRecovery: { configuration: {} as never, features: ["product.source.recovery.v1"], isCurrent: () => true, activate } });
    channel.serverTransport.subscribe(message => { if (message.kind === "command.ack") acks.push(message); });
    client.start(); await client.ready(); await channel.serverTransport.send(command); await client.stop();
    expect(start).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled();
    expect(acks).toMatchObject([{ status: "rejected", message: expect.stringContaining("registration") }]);
    expect(recovery.invalidate).toHaveBeenCalledOnce(); expect(recovery.settled).toHaveBeenCalledOnce();
  });
  it("keeps recovered epochs on the dedicated flow even when registration is active", async () => {
    recovery.isActive.mockReturnValue(true); recovery.allowsOrdinary.mockReturnValue(false);
    const channel = createInProcessChannel(), adapter = createMockAdapter(), start = vi.fn(adapter.start), acks: CommandAck[] = [];
    const client = createNodeClient({ nodeId: "node", transport: channel.node, adapter: { ...adapter, start },
      productSourceRecovery: { configuration: {} as never, features: [], isCurrent: () => true, activate: vi.fn() } });
    channel.serverTransport.subscribe(message => { if (message.kind === "command.ack") acks.push(message); });
    client.start(); await channel.serverTransport.send(command); await client.stop();
    expect(start).not.toHaveBeenCalled(); expect(recovery.readRuntime).not.toHaveBeenCalled();
    expect(acks).toMatchObject([{ status: "rejected", message: expect.stringContaining("fresh dedicated validation") }]);
  });
  it("reports recovery handshake failure to the node lifetime owner", async () => {
    recovery.handle.mockRejectedValue(Error("Guardian identity changed"));
    const channel = createInProcessChannel(), failure = vi.fn(), client = createNodeClient({ nodeId: "node", transport: channel.node, adapter: createMockAdapter(),
      productSourceRecovery: { configuration: {} as never, features: [], isCurrent: () => true, activate: vi.fn(), onFailure: failure } });
    client.start(); await channel.serverTransport.send(command); await client.stop();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: "Guardian identity changed" }));
  });
});
