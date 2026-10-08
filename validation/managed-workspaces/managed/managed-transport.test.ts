import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { WebSocket as PeerSocket } from "ws";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_RECEIPT_CONTRACT, type RunEventMessage } from "../../../packages/protocol/dist/index.js";
import { createManagedWebSocketTransport, type ManagedWebSocketOptions } from "../../../apps/artood/dist/managed/managed-ws-transport.js";
import { monotonicMs, type ManagedExposureContext } from "../../../apps/artood/dist/managed/managed-delivery.js";
import { authenticatedReceiver, command, hello, pause, scriptedPeer, until } from "./ws-network.fixture.js";

const evidence: unknown[] = [];
type Peer = Awaited<ReturnType<typeof scriptedPeer>>;
type SocketPeer = Peer["peers"][number];
function ready(peer: SocketPeer, overrides: Record<string, unknown> = {}) {
  const observed = peer.messages.find((m) => m.kind === "node.hello");
  return command("node.session.ready", { version: 1, node_id: observed.node_id,
    hello_nonce: observed.managed_receipts.nonce, session_id: randomUUID(), receipt_contract: MANAGED_RECEIPT_CONTRACT,
    sequence_max: 2147483647, liveness: { probe_interval_ms: 10000, probe_timeout_ms: 10000 }, ...overrides });
}
function auto(peer: Peer, transform: (message: any) => any = (message) => message) {
  peer.onMessage((socket, message) => {
    if (message.kind === "node.hello") peer.send(socket, transform(ready(socket)));
    if (message.kind === "node.session.probe") peer.send(socket, command("node.session.pong", message));
  });
}
async function fixture(options: Partial<ManagedWebSocketOptions> = {}, automatic = true) {
  const peer = await scriptedPeer(); if (automatic) auto(peer);
  const link = createManagedWebSocketTransport({ url: peer.url, namespace: "T-only-fixture", hello: hello("computer_T"), reconnectDelayMs: 20, ...options });
  const delivered: unknown[] = []; link.transport.subscribe((message) => delivered.push(message));
  link.start();
  return { peer, link, delivered, async close() { await link.close(); await peer.close(); } };
}
function frame(sequence = 0, text = "fixture body"): RunEventMessage {
  return { kind: "run.event", node_id: "computer_T", run_id: "run_T", sequence,
    event: { type: "run.output", payload: { stream: "stdout", text } } };
}
function context(message: RunEventMessage, deadline = monotonicMs() + 30000, signal = new AbortController().signal): ManagedExposureContext {
  return { namespace: "T-only-fixture", nodeId: message.node_id, runId: message.run_id, sequence: message.sequence,
    eventId: randomUUID(), attemptId: randomUUID(), clockId: "transport-fixture-clock", deadlineTickMs: deadline,
    contentSha256: createHash("sha256").update(JSON.stringify(message.event)).digest("hex"), signal };
}
const ack = (sequence: number, run = "run_T", status = "accepted") => command("run.event.ack", { run_id: run, sequence, status });
const eventFrames = (peer: Peer) => peer.peers.flatMap((p) => p.messages).filter((m) => m.kind === "run.event");

it("T01 legacy real receiver keeps existing business flow without unsolicited managed ready", async () => {
  const receiver = await authenticatedReceiver(); const messages: any[] = [];
  const socket = new WebSocket(receiver.nodeUrl);
  try {
    socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("legacy connect failed")), { once: true }); });
    socket.send(JSON.stringify(hello(receiver.nodeId)));
    socket.send(JSON.stringify({ kind: "node.heartbeat", node_id: receiver.nodeId, sequence: 0,
      resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 20 }, runtimes: [{ runtime: "process", status: "available", capabilities: ["code.modify"] }], running_instances: [] }));
    await until(() => Boolean(receiver.server.nodeRegistry.get(receiver.nodeId)), "legacy registration");
    let created: Response | undefined;
    await until(async () => { created = await receiver.request("POST", `/api/v1/computers/${receiver.nodeId}/instances`, { runtime: "process", workspace_root: "/tmp/T-only-workspace" }); return created.status === 201; }, "legacy runtime heartbeat");
    const instance = (await created!.json() as any).agent_instance.id;
    const task = await receiver.request("POST", "/api/v1/tasks", { project_id: "proj_artoo", title: "T01 transport only", acceptance_criteria: ["capture command"], required_capabilities: ["code.modify"] });
    const taskId = (await task.json() as any).task.id;
    expect((await receiver.request("POST", `/api/v1/tasks/${taskId}/ready`)).status).toBe(200);
    expect((await receiver.request("POST", `/api/v1/tasks/${taskId}/assign`, { mode: "manual", agent_instance_id: instance })).status).toBe(200);
    await until(() => messages.some((m) => m.type === "run.start"), "legacy business command");
    expect(messages.some((m) => m.type === "node.session.ready")).toBe(false);
    expect(receiver.server.nodeRegistry.get(receiver.nodeId)!.supportsExecutionFeature("workspace-allocation.per-run-v1")).toBe(false);
    const legacyBinding = receiver.server.nodeRegistry.get(receiver.nodeId);
    for (const failure of ["callback_error", "closing_before_callback"]) {
      const originalSend = PeerSocket.prototype.send; let failedPong = false;
      const spy = vi.spyOn(PeerSocket.prototype, "send").mockImplementation(function (this: PeerSocket, data, ...args) {
        const message = JSON.parse(String(data));
        if (message.type === "node.session.pong" && !failedPong) {
          failedPong = true; const callback = args.find((value) => typeof value === "function") as ((error?: Error) => void) | undefined;
          if (failure === "closing_before_callback") { this.close(); callback?.(); }
          else queueMicrotask(() => callback?.(new Error("labelled first-pong local write failure")));
          return;
        }
        Reflect.apply(originalSend, this, [data, ...args]);
      });
      const managed = createManagedWebSocketTransport({ url: receiver.nodeUrl, namespace: "T01-private-handshake", hello: hello(receiver.nodeId) });
      try { managed.start(); await expect(managed.ready).rejects.toThrow(); expect(failedPong).toBe(true);
        expect(receiver.server.nodeRegistry.get(receiver.nodeId)).toBe(legacyBinding);
        await pause(30); expect(receiver.server.nodeRegistry.get(receiver.nodeId)).toBe(legacyBinding);
      } finally { await managed.close(); spy.mockRestore(); }
    }
    evidence.push({ case: "T01", receiver: "real credential/authenticated qualified receiver, legacy mode", routes: receiver.routes, messages, writers: 0 });
  } finally { socket.close(); await until(() => socket.readyState === WebSocket.CLOSED, "legacy socket closure"); await receiver.close(); }
  const f = await fixture({}, false);
  try { expect(f.link.transport.acknowledgesRunEvents).toBe(true); expect(() => f.link.channel.assertCurrentSession()).toThrow(); }
  finally { await f.close(); }
});

it("T02 absent ready expires real 10s handshake and cannot release buffered work", async () => {
  const f = await fixture({}, false);
  try {
    await until(() => Boolean(f.peer.peers[0]?.messages.length), "initial hello"); const peer = f.peer.peers[0]!;
    f.peer.send(peer, command("run.resume", { run_id: "never_admitted" }));
    await expect(f.link.ready).rejects.toThrow(/deadline/);
    if (peer.socket.readyState === 1) f.peer.send(peer, ready(peer));
    expect(f.delivered).toHaveLength(0); expect(f.link.connected).toBe(false); expect(eventFrames(f.peer)).toHaveLength(0);
    evidence.push({ case: "T02", generations: f.link.diagnostics.generation, deliveredBusinessCommands: f.delivered.length,
      scope: "Transport boundary: no business command released to a subscriber; this fixture does not instantiate a producer" });
  } finally { await f.close(); }
});

it("T03 unknown version, receipt profile and int32 contract fail without fallback", async () => {
  for (const override of [{ version: 2 }, { receipt_contract: "unknown" }, { sequence_max: 2147483648 }]) {
    const f = await fixture({}, false);
    try { await until(() => Boolean(f.peer.peers[0]?.messages.length), "hello"); f.peer.send(f.peer.peers[0]!, ready(f.peer.peers[0]!, override));
      await expect(f.link.ready).rejects.toThrow(/incompatible/); expect(f.delivered).toHaveLength(0); expect(f.link.connected).toBe(false);
    } finally { await f.close(); }
  }
});

it("T04 wrong hello nonce rejects buffered commands", async () => {
  const f = await fixture({}, false);
  try { await until(() => Boolean(f.peer.peers[0]?.messages.length), "hello"); const peer = f.peer.peers[0]!;
    f.peer.send(peer, command("run.resume", { run_id: "never_admitted" })); f.peer.send(peer, ready(peer, { hello_nonce: randomUUID() }));
    await expect(f.link.ready).rejects.toThrow(/incompatible/); expect(f.delivered).toHaveLength(0);
  } finally { await f.close(); }
});

it("T05 wrong node and pong session cannot admit a managed session", async () => {
  const f = await fixture({}, false);
  try { await until(() => Boolean(f.peer.peers[0]?.messages.length), "hello"); const peer = f.peer.peers[0]!;
    f.peer.send(peer, ready(peer, { node_id: "wrong_authenticated_node" })); await expect(f.link.ready).rejects.toThrow(/incompatible/);
  } finally { await f.close(); }
  const g = await fixture({}, false);
  try { await until(() => Boolean(g.peer.peers[0]?.messages.length), "hello"); const peer = g.peer.peers[0]!;
    g.peer.send(peer, ready(peer)); await until(() => peer.messages.some((m) => m.kind === "node.session.probe"), "first probe");
    const probe = peer.messages.find((m) => m.kind === "node.session.probe");
    g.peer.send(peer, command("node.session.pong", { ...probe, session_id: randomUUID() }));
    expect(() => g.link.channel.assertCurrentSession()).toThrow(); await expect(g.link.ready).rejects.toThrow(/deadline|probe/);
  } finally { await g.close(); }
});

it("T06 stale generation callbacks cannot alter a replacement qualified session", async () => {
  const sockets: WebSocket[] = [];
  class ObservedSocket extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } }
  const f = await fixture({ WebSocketImpl: ObservedSocket });
  try { await f.link.ready; const old = f.link.currentSession!; f.peer.peers[0]!.socket.terminate();
    await until(() => Boolean(f.link.currentSession && f.link.currentSession.generation > old.generation), "new qualified generation");
    const current = f.link.currentSession!;
    sockets[0]!.dispatchEvent(new Event("open"));
    sockets[0]!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(ready(f.peer.peers[0]!)) }));
    sockets[0]!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(command("node.session.pong", { node_id: "computer_T", session_id: old.sessionId, probe_id: randomUUID() })) }));
    sockets[0]!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(command("run.resume", { run_id: "stale" })) }));
    sockets[0]!.dispatchEvent(new CloseEvent("close", { code: 1008 }));
    expect(f.link.channel.assertCurrentSession()).toBe(current); expect(current.helloNonce).not.toBe(old.helloNonce); expect(f.delivered).toHaveLength(0);
  } finally { await f.close(); }
});

it("T07 wrong tuple, malformed and overflow ACKs cannot settle another observer", async () => {
  const f = await fixture();
  try { await f.link.ready; const message = frame(), promise = f.link.channel.exposeOnce(message, context(message)); let settled = false; void promise.then(() => { settled = true; });
    const peer = f.peer.peers[0]!;
    for (const reply of [ack(1), ack(0, "wrong"), ack(2147483648), ack(-1), ack(0, "run_T", "unknown")]) f.peer.send(peer, reply);
    await pause(60); expect(settled).toBe(false); expect(f.link.diagnostics.receiptObservers).toBe(1);
    f.peer.send(peer, ack(0)); expect(await promise).toBe("accepted"); f.peer.send(peer, ack(0)); await pause(20);
    expect(f.link.diagnostics.receiptObservers).toBe(0); expect(eventFrames(f.peer)).toHaveLength(1);
  } finally { await f.close(); }
});

it("T08 ordinary send forbids run.event and exposure snapshots reject pending body changes", async () => {
  const f = await fixture();
  try { await f.link.ready; const message = frame(), original = structuredClone(message);
    await expect(f.link.transport.send(message)).rejects.toThrow(/durable one-shot/);
    const pending = f.link.channel.exposeOnce(message, context(message)); message.event = frame(0, "mutated").event;
    await expect(f.link.channel.exposeOnce(message, context(message))).rejects.toThrow(/body changed/);
    await until(() => eventFrames(f.peer).length === 1, "one serialized exposure"); expect(eventFrames(f.peer)[0]).toEqual(original);
    f.peer.send(f.peer.peers[0]!, ack(0)); expect(await pending).toBe("accepted");
  } finally { await f.close(); }
});

it("T09 cancellation, expiry and bounded pre-ready buffers cannot release stale work", async () => {
  const f = await fixture();
  try { await f.link.ready; const controller = new AbortController(); controller.abort(new Error("cancelled fixture")); const message = frame();
    await expect(f.link.channel.exposeOnce(message, context(message, monotonicMs() + 30000, controller.signal))).rejects.toThrow(/cancelled/);
    await expect(f.link.channel.exposeOnce(message, context(message, monotonicMs() - 1))).rejects.toThrow(/expired/);
    f.peer.peers[0]!.socket.terminate(); await until(() => !f.link.connected, "lost generation");
    const waitAbort = new AbortController(); const wait = f.link.channel.waitUntilUsable(monotonicMs() + 30000, waitAbort.signal); waitAbort.abort(new Error("wait cancelled"));
    await expect(wait).rejects.toThrow(/cancelled/); await until(() => f.link.connected, "replacement ready"); expect(eventFrames(f.peer)).toHaveLength(0);
  } finally { await f.close(); }
  for (const byteBound of [false, true]) {
    const g = await fixture({}, false);
    try { await until(() => Boolean(g.peer.peers[0]?.messages.length), "hello"); const peer = g.peer.peers[0]!;
      for (let i = 0; i < (byteBound ? 5 : 17); i++) g.peer.send(peer, command("run.resume", { run_id: byteBound ? "x".repeat(1024 * 1024) : `queued_${i}` }));
      await expect(g.link.ready).rejects.toThrow(/buffer/); expect(g.delivered).toHaveLength(0); expect(g.link.diagnostics.bufferedCommands).toBe(0);
    } finally { await g.close(); }
  }
  const g = await fixture({}, false);
  try { await until(() => Boolean(g.peer.peers[0]?.messages.length), "hello"); const peer = g.peer.peers[0]!;
    g.peer.send(peer, { ...(command("run.resume", { run_id: "expired" }) as object), deadline_at: new Date(Date.now() - 1000).toISOString() });
    auto(g.peer); g.peer.send(peer, ready(peer)); await g.link.ready;
    await until(() => peer.messages.some((m) => m.kind === "command.ack" && m.status === "rejected"), "expired command rejection"); expect(g.delivered).toHaveLength(0);
  } finally { await g.close(); }
});

it("T10 receipt count/bytes and late observers are finite; close cancels without replay", async () => {
  const f = await fixture(); const pending: Promise<unknown>[] = [];
  try { await f.link.ready;
    for (let sequence = 0; sequence < 64; sequence++) { const message = frame(sequence); pending.push(f.link.channel.exposeOnce(message, context(message)).catch((error) => error)); }
    const extra = frame(64); await expect(f.link.channel.exposeOnce(extra, context(extra))).rejects.toThrow(/capacity/);
    expect(f.link.diagnostics.receiptObservers).toBe(64); await f.link.close(); await Promise.all(pending);
    expect(f.link.diagnostics).toMatchObject({ receiptObservers: 0, receiptBytes: 0, bufferedCommands: 0 }); const generations = f.peer.peers.length; await pause(60); expect(f.peer.peers).toHaveLength(generations);
  } finally { await f.close(); }
  const g = await fixture(); const large: Promise<unknown>[] = [];
  try { await g.link.ready; for (let i = 0; i < 8; i++) { const message = frame(i, "b".repeat(1024 * 1024 - 200)); large.push(g.link.channel.exposeOnce(message, context(message)).catch((error) => error)); }
    const extra = frame(8, "b".repeat(1024)); await expect(g.link.channel.exposeOnce(extra, context(extra))).rejects.toThrow(/capacity/); expect(g.link.diagnostics.receiptBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  } finally { await g.close(); await Promise.all(large); }
  const h = await fixture();
  try { await h.link.ready; const message = frame(); const pendingReceipt = h.link.channel.exposeOnce(message, context(message, monotonicMs() + 80));
    await expect(pendingReceipt).rejects.toThrow(/retired/); expect(h.link.diagnostics.receiptObservers).toBe(0); expect(h.link.connected).toBe(true);
  } finally { await h.close(); }
});

afterAll(() => { const directory = process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR; if (!directory) throw new Error("Reviewed owned harness required");
  writeFileSync(join(directory, "transport-observations.json"), JSON.stringify({ scope: "T02-T10 scripted loopback peers; no physical/qualified receipt claims", evidence }, null, 2)); });
