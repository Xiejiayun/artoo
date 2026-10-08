import { assistantTurns, eventLog, messages, runEventIngest, runs, tasks } from "@artoo/db";
import type { Run } from "@artoo/domain";
import type { NodeRunEvent, NodeTransport, RunEventMessage, ServerToNodeMessage } from "@artoo/protocol";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { createServerNodeTransport, parseNodeToServer, type RawServerSocket } from "./ws/ws-node-transport.js";
import { enqueueAssistantTurn } from "./services/assistant-service.js";
import { assignTask, markReady } from "./services/lifecycle-service.js";
import { getRun, ingestRunEvent, ingestWireRunEvent } from "./services/run-service.js";
import { qualifyRunEventMessage } from "./services/run-event-receipt.js";

const NODE = "computer_local_mock", ROOT = "/owned/receipt-fixture";
type Kind = "started" | "output" | "answer" | "usage" | "artifact" | "retention" | "terminal";
const kinds: Kind[] = ["started", "output", "answer", "usage", "artifact", "retention", "terminal"];
const frame = (run: Run, sequence: number, event: NodeRunEvent): RunEventMessage =>
  ({ kind: "run.event", node_id: NODE, run_id: run.id, sequence, event });
function body(kind: Kind, run: Run): NodeRunEvent {
  switch (kind) {
    case "started": return { type: "run.lifecycle", payload: { phase: "started", reason: "provider-started" } };
    case "output": return { type: "run.output", payload: { stream: "stdout", text: "one" } };
    case "answer": return { type: "run.answer", payload: { text: "answer one" } };
    case "usage": return { type: "run.usage", payload: { input_tokens: 1, cost_usd: 0, currency: "USD", provider_session_id: "p1" } };
    case "artifact": return { type: "artifact.created", payload: { type: "report", uri: "report.txt", metadata: { nested: { a: 1, b: 2 } }, checksum: null } };
    case "retention": return { type: "run.workspace.retained", payload: { version: 1, workspace_root: run.workspace_root!, workspace_branch: run.workspace_branch!, outcome: "completed" } };
    case "terminal": return { type: "run.lifecycle", payload: { phase: "completed", reason: null } };
  }
}
function changed(event: NodeRunEvent): NodeRunEvent {
  switch (event.type) {
    case "run.lifecycle": return { ...event, payload: { ...event.payload, reason: "changed" } };
    case "run.output": return { ...event, payload: { ...event.payload, text: "two" } };
    case "run.answer": return { ...event, payload: { text: "answer two" } };
    case "run.usage": return { ...event, payload: { ...event.payload, cost_usd: 2 } };
    case "artifact.created": return { ...event, payload: { ...event.payload, metadata: { nested: { a: 1, b: 3 } } } };
    case "run.workspace.retained": return { ...event, payload: { ...event.payload, outcome: "incomplete_delivery" } };
  }
}

describe("qualified full-body run receipts through the real binding", () => {
  let server: TestServer;
  const bindings: NodeBinding[] = [];
  beforeEach(async () => { server = await buildTestServer({ workspaceRoot: ROOT }); });
  afterEach(async () => { for (const b of bindings.splice(0)) b.close(); await server.close(); });

  async function assigned() {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "receipt fixture", acceptance_criteria: ["exact receipt"], required_capabilities: ["code.modify"],
    } });
    expect(created.statusCode).toBe(201);
    const task = created.json().task as { id: string; room_id: string };
    const { turn } = await enqueueAssistantTurn(server.ctx, task.room_id, { body: "receipt answer", client_request_id: `request:${task.id}` });
    await markReady(server.ctx, task.id);
    const { run } = await assignTask(server.ctx, task.id, { mode: "auto", branch_backed: true, write_paths: ["Src/Work.ts"] }, turn.id);
    return { run, task, turn };
  }
  function binding(onSend?: (message: ServerToNodeMessage) => Promise<void>) {
    const sent: ServerToNodeMessage[] = [];
    const transport: NodeTransport = { subscribe: () => () => {}, close: async () => {}, async send(message) {
      sent.push(message); await onSend?.(message);
    } };
    const value = attachNodeBinding(server.ctx, transport, NODE); bindings.push(value);
    return { value, sent };
  }
  async function deliver(target: ReturnType<typeof binding>, message: RunEventMessage) {
    target.value.receive(message); await target.value.drain();
    return target.sent.filter((m) => m.type === "run.event.ack").at(-1)?.payload.status;
  }
  async function state() {
    const result: Record<string, unknown> = {};
    for (const name of ["runs", "tasks", "event_log", "messages", "run_usage", "artifacts", "integration_queue", "file_leases", "assistant_turns"]) {
      result[name] = (await server.db.db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM ${name} t ORDER BY to_jsonb(t)::text`))).rows;
    }
    return result;
  }
  async function started(run: Run) { await ingestWireRunEvent(server.ctx, frame(run, 0, body("started", run))); }

  it.each(kinds)("qualifies first %s, accepts exact replay and rejects a changed body without repeated effects", async (kind) => {
    const { run } = await assigned();
    if (kind !== "started") await started(run);
    const message = frame(run, kind === "started" ? 0 : 1, body(kind, run));
    let committedAtAck = 0;
    const target = binding(async (ack) => {
      if (ack.type === "run.event.ack" && ack.payload.status === "accepted") {
        const receipt = (await server.db.db.select().from(runEventIngest).where(and(eq(runEventIngest.runId, run.id), eq(runEventIngest.sequence, message.sequence))))[0];
        expect(receipt?.bodyIdentity).toBe(qualifyRunEventMessage(message).bodyIdentity); committedAtAck++;
      }
    });
    expect(await deliver(target, message)).toBe("accepted");
    const first = await state();
    expect(await deliver(target, structuredClone(message))).toBe("accepted");
    expect(await state()).toEqual(first);
    expect(await deliver(target, { ...message, event: changed(message.event) })).toBe("rejected");
    expect(await state()).toEqual(first);
    expect(committedAtAck).toBe(2);
    expect((await server.db.db.select().from(runEventIngest).where(and(eq(runEventIngest.runId, run.id), eq(runEventIngest.sequence, message.sequence))))).toHaveLength(1);
  });

  it("rejects a retained tuple replayed as output and keeps latest retention separate", async () => {
    const { run } = await assigned(), target = binding(); await started(run);
    expect(await deliver(target, frame(run, 1, body("retention", run)))).toBe("accepted");
    const first = await state();
    expect(await deliver(target, frame(run, 1, body("output", run)))).toBe("rejected");
    expect(await state()).toEqual(first);
    expect((await getRun(server.ctx, run.id)).workspace_retention?.outcome).toBe("completed");
  });

  it("does not qualify NULL direct history, distinguishes a mismatch, and never accepts a caller hash", async () => {
    const { run } = await assigned();
    const legacy = { runId: run.id, nodeId: NODE, sequence: 1, event: { kind: "output" as const, stream: "stdout" as const, text: "one" } };
    expect(await ingestRunEvent(server.ctx, legacy)).not.toHaveProperty("receiptBodyIdentity");
    expect((await ingestRunEvent(server.ctx, legacy)).deduped).toBe(true);
    const wire = frame(run, 1, body("output", run));
    const first = await state();
    await expect(ingestWireRunEvent(server.ctx, wire)).rejects.toThrow("legacy run event receipt has no qualified body identity");
    expect(await state()).toEqual(first);
    await expect(ingestWireRunEvent(server.ctx, legacy)).rejects.toThrow();
    const qualified = await ingestWireRunEvent(server.ctx, { ...wire, sequence: 2, body_identity: "forged" });
    expect(qualified?.receiptBodyIdentity).toBe(qualifyRunEventMessage(wire).bodyIdentity);
    await expect(ingestWireRunEvent(server.ctx, { ...wire, sequence: 2, event: changed(wire.event) })).rejects.toThrow("run event receipt body mismatch");
    await expect(ingestRunEvent(server.ctx, { ...legacy, sequence: 2 })).rejects.toThrow("requires the original wire frame");
    expect((await server.db.db.select().from(runEventIngest).where(eq(runEventIngest.sequence, 1)))[0]?.bodyIdentity).toBeNull();
    const target = binding();
    expect(await deliver(target, wire)).toBe("rejected");
  });

  it("pins the received frame before enqueue and maps that same parsed body", async () => {
    const { run } = await assigned(), target = binding();
    const message = frame(run, 1, { type: "run.output", payload: { stream: "stdout", text: "original" } });
    const identity = qualifyRunEventMessage(message).bodyIdentity;
    target.value.receive(message);
    if (message.event.type !== "run.output") throw new Error("Expected output");
    message.event.payload.text = "mutated";
    await target.value.drain();
    const event = (await server.db.db.select().from(eventLog).where(and(eq(eventLog.runId, run.id), eq(eventLog.type, "run.output"))))[0];
    expect(event?.payload).toEqual({ stream: "stdout", text: "original" });
    expect((await server.db.db.select().from(runEventIngest).where(eq(runEventIngest.runId, run.id)))[0]?.bodyIdentity).toBe(identity);
  });

  it("drops raw int32 overflow, rejects direct overflow before SQL, and retains endpoint boundaries", async () => {
    const { run } = await assigned(); const before = await state();
    const raw = JSON.stringify(frame(run, 2147483648, body("output", run)));
    expect(parseNodeToServer(raw)).toBeNull();
    const incoming: Array<(data: unknown) => void> = [], sent: string[] = [];
    const socket: RawServerSocket = { send: (data) => { sent.push(data); }, close() {},
      on(event: "message" | "close", callback: ((data: unknown) => void) | (() => void)) {
        if (event === "message") incoming.push(callback as (data: unknown) => void);
      } };
    const rawBinding = attachNodeBinding(server.ctx, createServerNodeTransport(socket), NODE); bindings.push(rawBinding);
    for (const receive of incoming) receive(raw);
    await rawBinding.drain(); expect(sent).toEqual([]);
    await expect(ingestRunEvent(server.ctx, { runId: run.id, nodeId: NODE, sequence: 2147483648,
      event: { kind: "output", stream: "stdout", text: "overflow" } })).rejects.toThrow("nonnegative int32");
    expect(await state()).toEqual(before);
    expect((await ingestWireRunEvent(server.ctx, frame(run, 2147483647, body("output", run))))?.deduped).toBe(false);
  });

  it("accepts commit-then-ACK-loss on a fresh binding without a second answer relation", async () => {
    const { run, turn } = await assigned(); await started(run);
    const message = frame(run, 1, body("answer", run));
    const lost = binding(async (ack) => { if (ack.type === "run.event.ack") throw new Error("simulated ACK loss after commit"); });
    await deliver(lost, message);
    const first = await state();
    expect(await deliver(binding(), message)).toBe("accepted"); expect(await state()).toEqual(first);
    const answers = await server.db.db.select().from(messages).where(and(eq(messages.runId, run.id), eq(messages.kind, "text")));
    expect(answers).toHaveLength(1);
    expect((await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, turn.id)))[0]?.responseMessageId).toBe(answers[0]!.id);
  });

  it.each(["completed-first", "correction-first"] as const)("preserves settled Run/Task and latest retention for %s", async (order) => {
    const { run } = await assigned(); await started(run);
    await ingestWireRunEvent(server.ctx, frame(run, 1, body("retention", run)));
    const completed = frame(run, 2, body("terminal", run));
    const correction = frame(run, 3, changed(body("retention", run)));
    const failed = frame(run, 4, { type: "run.lifecycle", payload: { phase: "failed", reason: "incomplete_delivery" } });
    for (const event of order === "completed-first" ? [completed, correction, failed] : [correction, failed, completed]) {
      expect(await ingestWireRunEvent(server.ctx, event)).toHaveProperty("receiptBodyIdentity");
    }
    expect((await getRun(server.ctx, run.id)).workspace_retention?.outcome).toBe("incomplete_delivery");
    expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe(order === "completed-first" ? "completed" : "failed");
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, run.task_id)))[0]?.status).toBe(order === "completed-first" ? "review" : "blocked");
    expect((await server.db.db.select().from(eventLog).where(and(eq(eventLog.runId, run.id), eq(eventLog.type, "run.reconciled"))))).toHaveLength(1);
  });

  it("rechecks wire ownership under the run lock and does not ACK foreign frames", async () => {
    const { run } = await assigned(), target = binding(); const before = await state();
    const foreign = { ...frame(run, 1, body("output", run)), node_id: "other-node" };
    await expect(ingestWireRunEvent(server.ctx, foreign)).rejects.toThrow("not owned by this node");
    target.value.receive(foreign); await target.value.drain(); expect(target.sent).toEqual([]);
    expect(await state()).toEqual(before);
  });
});
