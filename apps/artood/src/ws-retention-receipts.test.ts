import type { NodeHello, NodeToServerMessage, RunEventMessage } from "@artoo/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeClient } from "./node-client.js";
import { createWebSocketTransport, type WebSocketNodeTransport } from "./ws-transport.js";

const hello: NodeHello = { kind: "node.hello", node_id: "retention-node", protocol_version: "2026-06-11", artood_version: "test",
  machine: { hostname: "owned-fake", os: "darwin", arch: "x64" } };
const report: RunEventMessage = { kind: "run.event", node_id: hello.node_id, run_id: "retention-run", sequence: 1,
  event: { type: "run.workspace.retained", payload: { version: 1, workspace_root: "/owned/run", workspace_branch: "artoo/run", outcome: "completed" } } };
const sockets: FakeSocket[] = [], transports: WebSocketNodeTransport[] = [];
class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly sent: NodeToServerMessage[] = [];
  onSend?: (message: NodeToServerMessage) => void;
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();
  constructor(_url: string) { sockets.push(this); }
  addEventListener(type: string, handler: (event: unknown) => void) { const list = this.handlers.get(type) ?? []; list.push(handler); this.handlers.set(type, list); }
  send(text: string) { const message = JSON.parse(text) as NodeToServerMessage; this.sent.push(message); this.onSend?.(message); }
  emit(type: string, event: unknown) { for (const handler of this.handlers.get(type) ?? []) handler(event); }
  open() { this.readyState = 1; this.emit("open", {}); }
  close() { this.readyState = 3; this.emit("close", { code: 1000 }); }
  drop() { this.readyState = 3; this.emit("close", { code: 1012 }); }
  receipt(sequence = 1, status = "accepted", message?: string) {
    this.emit("message", { data: JSON.stringify({ kind: "command", id: `receipt-${sequence}`, idempotency_key: `receipt-${sequence}`,
      type: "run.event.ack", payload: { run_id: "retention-run", sequence, status, ...(message ? { message } : {}) } }) });
  }
}
function harness(options: { receipts?: boolean; timeout?: number; open?: boolean } = {}) {
  const transport = createWebSocketTransport({ url: "ws://injected.invalid", hello, WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    acknowledgeRunEvents: options.receipts ?? true, retentionReceiptTimeoutMs: options.timeout, reconnectDelayMs: 5 });
  transports.push(transport); void transport.ready.catch(() => {});
  const socket = sockets.at(-1)!; if (options.open !== false) socket.open();
  return { transport, socket };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { for (const transport of transports.splice(0)) await transport.close(); sockets.length = 0; vi.useRealTimers(); });

describe("bounded typed retention receipts without live sockets", () => {
  it.each([false, true])("advertises the actual committed receipt setting: %s", async (receipts) => {
    const { transport } = harness({ receipts }); await transport.ready;
    expect(transport.acknowledgesRunEvents).toBe(receipts);
  });

  it("keeps receipt capability consistent if the caller mutates its configuration object", async () => {
    const options = { url: "ws://injected.invalid", hello, WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      acknowledgeRunEvents: true, retentionReceiptTimeoutMs: 20 };
    const transport = createWebSocketTransport(options); transports.push(transport);
    const socket = sockets.at(-1)!; socket.open(); await transport.ready;
    options.acknowledgeRunEvents = false;
    let settled = false;
    const sent = transport.send(report).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.acknowledgesRunEvents).toBe(true); expect(settled).toBe(false);
    socket.receipt(); await sent; expect(settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["accepted", "rejected"])("settles once and clears the deadline on a %s receipt", async (status) => {
    const { transport, socket } = harness({ timeout: 20 });
    let settled = 0;
    const result = transport.send(report).then(() => { settled++; return "accepted"; }, (error: Error) => { settled++; return error.message; });
    expect(vi.getTimerCount()).toBe(1);
    socket.receipt(1, status, "report rejected");
    expect(await result).toBe(status === "accepted" ? "accepted" : "report rejected");
    expect(vi.getTimerCount()).toBe(0);
    socket.receipt(); await vi.advanceTimersByTimeAsync(30); expect(settled).toBe(1);
  });

  it("uses a 30-second default measured from enqueue", async () => {
    const { transport } = harness();
    let settled = false;
    const result = transport.send(report).catch((error: Error) => { settled = true; return error.message; });
    await vi.advanceTimersByTimeAsync(29_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe("workspace retention receipt timed out after 30000ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reset its deadline on reconnect, removes timed-out replay, and ignores late ACK", async () => {
    const { transport, socket } = harness({ timeout: 40 });
    let rejected = 0;
    const result = transport.send(report).catch((error: Error) => { rejected++; return error.message; });
    await vi.advanceTimersByTimeAsync(10); socket.drop();
    await vi.advanceTimersByTimeAsync(5); const replaySocket = sockets.at(-1)!; replaySocket.open();
    expect(replaySocket.sent.filter((m) => m.kind === "run.event")).toEqual([report]);
    await vi.advanceTimersByTimeAsync(24); expect(rejected).toBe(0);
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe("workspace retention receipt timed out after 40ms");
    replaySocket.receipt(); expect(rejected).toBe(1);
    replaySocket.drop(); await vi.advanceTimersByTimeAsync(5); const afterTimeout = sockets.at(-1)!; afterTimeout.open();
    expect(afterTimeout.sent.filter((m) => m.kind === "run.event")).toEqual([]);
    afterTimeout.receipt(); await vi.advanceTimersByTimeAsync(50); expect(rejected).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("times out an event enqueued while disconnected before it can replay", async () => {
    const { transport, socket } = harness({ timeout: 4 }); socket.drop();
    const result = transport.send(report).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(4); expect(await result).toBe("workspace retention receipt timed out after 4ms");
    await vi.advanceTimersByTimeAsync(1); const reconnect = sockets.at(-1)!; reconnect.open();
    expect(reconnect.sent).toEqual([hello]);
  });

  it("clears the typed deadline and rejects once on close", async () => {
    const { transport } = harness({ timeout: 20 }); let rejections = 0;
    const result = transport.send(report).catch((error: Error) => { rejections++; return error.message; });
    await transport.close(); expect(await result).toBe("websocket closed"); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30); expect(rejections).toBe(1);
  });

  it("does not clobber a pending typed receipt or extend its deadline with a duplicate send", async () => {
    const { transport } = harness({ timeout: 20 });
    const original = transport.send(report).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(10);
    await expect(transport.send(report)).rejects.toThrow("workspace retention event is already pending");
    await vi.advanceTimersByTimeAsync(10); expect(await original).toBe("workspace retention receipt timed out after 20ms");
  });

  it("does not add this new deadline to ordinary lifecycle events", async () => {
    const { transport, socket } = harness({ timeout: 10 }); let settled = false;
    const ordinary: RunEventMessage = { ...report, event: { type: "run.lifecycle", payload: { phase: "completed" } } };
    const sent = transport.send(ordinary).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(40); expect(settled).toBe(false); expect(vi.getTimerCount()).toBe(0);
    socket.receipt(); await sent; expect(settled).toBe(true);
  });

  it("keeps required receipt capacity after more than 1000 unacknowledged best-effort outputs", async () => {
    const { transport, socket } = harness({ timeout: 20 });
    const errors: string[] = []; let diagnosticsSettled = 0;
    const diagnostics = Array.from({ length: 1005 }, (_, index): RunEventMessage => ({ ...report, sequence: index + 10,
      event: { type: "run.output", payload: { stream: "stderr", text: `optional diagnostic ${index}` } } }));
    for (const message of diagnostics) {
      void transport.send(message, { delivery: "best-effort" }).then(() => { diagnosticsSettled++; }, (error: Error) => { errors.push(error.message); });
    }
    let metadataSettled = false, terminalSettled = false;
    const metadata = transport.send(report).then(() => { metadataSettled = true; }, (error: Error) => { errors.push(error.message); });
    const terminalMessage: RunEventMessage = { ...report, sequence: 2, event: { type: "run.lifecycle", payload: { phase: "completed" } } };
    const terminal = transport.send(terminalMessage).then(() => { terminalSettled = true; }, (error: Error) => { errors.push(error.message); });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([]); expect(diagnosticsSettled).toBe(1005);
    expect(metadataSettled).toBe(false); expect(terminalSettled).toBe(false);
    // Options are local only: the actual wire frames remain unchanged.
    expect(socket.sent).toEqual([hello, ...diagnostics, report, terminalMessage]);
    expect(vi.getTimerCount()).toBe(1);
    socket.receipt(); socket.receipt(2); await Promise.all([metadata, terminal]);
    expect(metadataSettled).toBe(true); expect(terminalSettled).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("drops offline best-effort output and never replays even an unacknowledged online diagnostic", async () => {
    const { transport, socket } = harness();
    const output: RunEventMessage = { ...report, sequence: 2, event: { type: "run.output", payload: { stream: "stderr", text: "optional" } } };
    let settled = 0;
    const online = transport.send(output, { delivery: "best-effort" }).then(() => { settled++; }, () => {});
    socket.drop();
    const offline = transport.send({ ...output, sequence: 3 }, { delivery: "best-effort" }).then(() => { settled++; }, () => {});
    const requiredOutput = { ...output, sequence: 4 };
    let requiredSettled = false;
    const required = transport.send(requiredOutput).then(() => { requiredSettled = true; }, () => {});
    await vi.advanceTimersByTimeAsync(5); const reconnect = sockets.at(-1)!; reconnect.open();
    expect(reconnect.sent).toEqual([hello, requiredOutput]);
    expect(settled).toBe(2); expect(requiredSettled).toBe(false); expect(vi.getTimerCount()).toBe(0);
    reconnect.receipt(4); await Promise.all([online, offline, required]); expect(requiredSettled).toBe(true);
  });

  it.each([report, { ...report, event: { type: "run.lifecycle", payload: { phase: "completed" } } } satisfies RunEventMessage])(
    "rejects best-effort sequence collisions with pending $event.type", async (requiredMessage) => {
      const { transport, socket } = harness({ timeout: 20 }); let requiredSettled = false;
      const required = transport.send(requiredMessage).then(() => { requiredSettled = true; }, () => {});
      const output: RunEventMessage = { ...requiredMessage, event: { type: "run.output", payload: { stream: "stderr", text: "optional" } } };
      await expect(transport.send(output, { delivery: "best-effort" })).rejects.toThrow("best-effort output cannot reuse a pending run event sequence");
      expect(socket.sent).toEqual([hello, requiredMessage]); expect(requiredSettled).toBe(false);
      socket.receipt(requiredMessage.sequence); await required; expect(requiredSettled).toBe(true); expect(vi.getTimerCount()).toBe(0);
    });

  it("drops best-effort output before the first open and rejects it after explicit close", async () => {
    const { transport, socket } = harness({ open: false });
    const output: RunEventMessage = { ...report, event: { type: "run.output", payload: { stream: "stderr", text: "optional" } } };
    await transport.send(output, { delivery: "best-effort" });
    expect(socket.sent).toEqual([]); socket.open(); await transport.ready;
    expect(socket.sent).toEqual([hello]);
    await transport.close();
    await expect(transport.send(output, { delivery: "best-effort" })).rejects.toThrow("websocket is closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replay a best-effort output whose local socket send throws", async () => {
    const { transport, socket } = harness();
    const output: RunEventMessage = { ...report, event: { type: "run.output", payload: { stream: "stderr", text: "optional" } } };
    socket.onSend = () => { throw new Error("local send failed"); };
    await expect(transport.send(output, { delivery: "best-effort" })).rejects.toThrow("local send failed");
    socket.drop(); await vi.advanceTimersByTimeAsync(5); const reconnect = sockets.at(-1)!; reconnect.open();
    expect(reconnect.sent).toEqual([hello]); expect(vi.getTimerCount()).toBe(0);
  });

  const requiredFrames: NodeToServerMessage[] = [
    report,
    { ...report, event: { type: "run.lifecycle", payload: { phase: "completed" } } },
    { ...report, event: { type: "artifact.created", payload: { type: "patch", uri: "fix.patch", metadata: {} } } },
    { ...report, event: { type: "run.answer", payload: { text: "answer" } } },
    { ...report, event: { type: "run.usage", payload: { input_tokens: 1 } } },
    hello,
    { kind: "node.heartbeat", node_id: hello.node_id, sequence: 0, resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 }, runtimes: [], running_instances: [] },
    { kind: "command.ack", node_id: hello.node_id, command_id: "start", status: "accepted" },
  ];
  it.each(requiredFrames.flatMap((message) => (["open", "offline", "closed"] as const).map((state) => ({
    message, state, type: message.kind === "run.event" ? message.event.type : message.kind,
  }))))("rejects best-effort misuse for $type while $state", async ({ message, state }) => {
      const { transport, socket } = harness();
      if (state === "offline") socket.drop();
      if (state === "closed") await transport.close();
      let result: string | undefined;
      const rejected = transport.send(message, { delivery: "best-effort" }).then(() => { result = "accepted"; }, (error: Error) => { result = error.message; });
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toBe("best-effort delivery is only supported for run.output"); await rejected;
      expect(socket.sent).toEqual([hello]);
      if (state === "offline") {
        await vi.advanceTimersByTimeAsync(5); const reconnect = sockets.at(-1)!; reconnect.open();
        expect(reconnect.sent).toEqual([hello]);
      }
      expect(vi.getTimerCount()).toBe(0);
    });

  it.each([false, true])("keeps typed terminal delivery live when only the diagnostic ACK is missing (typed timeout: %s)", async (timeoutCompleted) => {
    const { transport, socket } = harness({ timeout: 10 });
    const committed: RunEventMessage[] = [];
    let stops = 0;
    socket.onSend = (message) => {
      if (message.kind !== "run.event" || message.event.type === "run.output") return;
      if (timeoutCompleted && message.event.type === "run.workspace.retained" && message.event.payload.outcome === "completed") return;
      committed.push(message); socket.receipt(message.sequence);
    };
    const client = createNodeClient({ nodeId: hello.node_id, transport, workspace: { worktreeBaseRepo: "/owned/base" }, git: { async run() {} },
      adapter: { runtimeId: "fake", async start(config) { return { runId: config.runId }; },
        async *streamEvents() {
          yield { type: "run.lifecycle", payload: { phase: "started" } };
          yield { type: "run.lifecycle", payload: { phase: "completed" } };
        }, async stop() { stops++; }, async collectArtifacts() { return []; } } });
    client.start();
    try {
      socket.emit("message", { data: JSON.stringify({ kind: "command", id: "typed-start", type: "run.start", idempotency_key: "typed-start",
        payload: { run_id: "retention-run", task_id: "task", agent_instance_id: "instance", runtime: "fake", workspace: { root: "/owned/run", branch: "artoo/run" },
          context_pack: { id: "ctx", uri: "inline" }, policy_snapshot: { filesystem_write_scope: ["/owned/run"], requires_approval: [] }, artifact_rules: { paths: [] },
          workspace_retention_reporting: "typed-v1" } }) });
      await vi.advanceTimersByTimeAsync(timeoutCompleted ? 10 : 0);
      expect(socket.sent.filter((message) => message.kind === "run.event" && message.event.type === "run.output")).toHaveLength(1);
      expect(committed.at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: timeoutCompleted ? "failed" : "completed" } });
      const metadata = committed.find((message) => message.event.type === "run.workspace.retained")!;
      expect(metadata.event).toMatchObject({ payload: { outcome: timeoutCompleted ? "incomplete_delivery" : "completed" } });
      expect(metadata.sequence).toBeLessThan(committed.at(-1)!.sequence);
      expect(stops).toBe(timeoutCompleted ? 1 : 0);
    } finally {
      // No optional receipt remains for close to reject; required cleanup still
      // leaves no timer or unhandled rejection.
      await transport.close(); await client.stop(true);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, "typed-future"])("new worker sends no typed frame to an unadvertised server: %s", async (advertisement) => {
    const { transport, socket } = harness({ timeout: 10 });
    const committed: NodeToServerMessage[] = [];
    socket.onSend = (message) => {
      if (message.kind !== "run.event") return;
      expect(message.event.type).not.toBe("run.workspace.retained");
      committed.push(message); socket.receipt(message.sequence); // Receipt follows simulated commit.
    };
    const client = createNodeClient({ nodeId: hello.node_id, transport, workspace: { worktreeBaseRepo: "/owned/base" }, git: { async run() {} },
      adapter: { runtimeId: "fake", async start(config) { return { runId: config.runId }; },
        async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "completed" } }; }, async stop() {}, async collectArtifacts() { return []; } } });
    client.start();
    try {
      socket.emit("message", { data: JSON.stringify({ kind: "command", id: "start", type: "run.start", idempotency_key: "start",
        payload: { run_id: "retention-run", task_id: "task", agent_instance_id: "instance", runtime: "fake", workspace: { root: "/owned/run", branch: "artoo/run" },
          context_pack: { id: "ctx", uri: "inline" }, policy_snapshot: { filesystem_write_scope: ["/owned/run"], requires_approval: [] }, artifact_rules: { paths: [] },
          ...(advertisement ? { workspace_retention_reporting: advertisement } : {}) } }) });
      await client.stop();
      expect(committed.map((m) => m.kind === "run.event" ? m.event.type : m.kind)).toEqual(["run.output", "run.lifecycle"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await client.stop(true); }
  });
});
