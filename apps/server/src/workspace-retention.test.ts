import { appendEvent, eventLog, fileLeases, runEventIngest, runs } from "@artoo/db";
import type { Run, RunWorkspaceRetainedPayload } from "@artoo/domain";
import type { NodeTransport, ServerToNodeMessage } from "@artoo/protocol";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildEvent } from "./events.js";
import { attachNodeBinding } from "./node-binding.js";
import { failRunStart, getRun, ingestRunEvent } from "./services/run-service.js";
import { getTaskSnapshot } from "./services/task-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const computer = "computer_local_mock";
const root = "/owned/Retained 项目";
let server: TestServer;
afterEach(async () => { vi.restoreAllMocks(); await server?.close(); });

async function assigned(branch = true): Promise<Run> {
  const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
    project_id: "proj_artoo", title: "retained execution", acceptance_criteria: ["keep every byte"], required_capabilities: ["code.modify"],
  } });
  const taskId = created.json().task.id as string;
  expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
  const response = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "auto", ...(branch ? { branch_backed: true } : {}), write_paths: ["Src/Work.ts"] } });
  expect(response.statusCode).toBe(200);
  return response.json().run;
}
function payload(run: Run, outcome: RunWorkspaceRetainedPayload["outcome"] = "completed"): RunWorkspaceRetainedPayload {
  return { version: 1, workspace_root: run.workspace_root!, workspace_branch: run.workspace_branch!, outcome };
}
const ingest = (run: Run, sequence: number, outcome: RunWorkspaceRetainedPayload["outcome"] = "completed") =>
  ingestRunEvent(server.ctx, { runId: run.id, nodeId: computer, sequence, event: { kind: "workspace_retained", retention: payload(run, outcome) } });
const events = (run: Run) => server.db.db.select().from(eventLog).where(and(eq(eventLog.runId, run.id), eq(eventLog.type, "run.workspace.retained")));

describe("node-owned historical workspace retention", () => {
  it("advertises support only for persisted worktree identity and acknowledges after commit", async () => {
    server = await buildTestServer({ workspaceRoot: root });
    const run = await assigned();
    const sent: ServerToNodeMessage[] = [];
    let committedAtReceipt = false;
    const transport: NodeTransport = { subscribe: () => () => {}, close: async () => {}, async send(message) {
      if (message.type === "run.event.ack" && message.payload.status === "accepted") committedAtReceipt = (await events(run)).length === 1;
      sent.push(message);
    } };
    const binding = attachNodeBinding(server.ctx, transport, computer);
    try {
      await binding.dispatchRunStart(run.id);
      expect(sent[0]).toMatchObject({ type: "run.start", payload: { workspace_retention_reporting: "typed-v1", workspace: { root, branch: run.workspace_branch } } });
      binding.receive({ kind: "run.event", node_id: computer, run_id: run.id, sequence: 0,
        event: { type: "run.workspace.retained", payload: payload(run) } });
      await binding.drain();
      expect(committedAtReceipt).toBe(true);
      expect(sent.at(-1)).toMatchObject({ type: "run.event.ack", payload: { sequence: 0, status: "accepted" } });
      binding.receive({ kind: "run.event", node_id: computer, run_id: run.id, sequence: 1,
        event: { type: "run.workspace.retained", payload: { ...payload(run), workspace_root: "/wrong" } } });
      await binding.drain();
      expect(sent.at(-1)).toMatchObject({ type: "run.event.ack", payload: { sequence: 1, status: "rejected" } });
      expect(await events(run)).toHaveLength(1);
      await server.db.db.update(runs).set({ workspaceRoot: null }).where(eq(runs.id, run.id));
      await binding.dispatchRunStart(run.id);
      expect(sent.at(-1)).not.toHaveProperty("payload.workspace_retention_reporting");
    } finally { binding.close(); }
  });

  it("hydrates the same compact provenance in run, task and audit reads without changing status or leases", async () => {
    server = await buildTestServer({ workspaceRoot: root });
    const run = await assigned();
    const leasesBefore = await server.db.db.select().from(fileLeases);
    const ingested = await ingest(run, 7);
    expect(ingested.runStatus).toBe("queued");
    expect(ingested.taskStatus).toBe("assigned");
    expect(await server.db.db.select().from(fileLeases)).toEqual(leasesBefore);
    const [event] = await events(run);
    expect(event).toMatchObject({ actorType: "system", actorId: computer, taskId: run.task_id, sequence: 7,
      payload: { ...payload(run), reporter_computer_id: computer } });
    const projection = { ...payload(run), reporter_computer_id: computer, event_id: event!.id, position: event!.position,
      sequence: 7, reported_at: "2026-06-13T00:00:00.000Z" };
    const single = (await server.app.inject({ method: "GET", url: `/api/v1/runs/${run.id}` })).json().run;
    const task = (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${run.task_id}` })).json();
    const audit = (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${run.task_id}/audit-bundle` })).json().bundle;
    expect(single.workspace_retention).toEqual(projection);
    expect(task.runs[0].workspace_retention).toEqual(projection);
    expect(audit.runs[0].workspace_retention).toEqual(projection);
    expect(audit.events.filter((item: { type: string }) => item.type === "run.workspace.retained")).toHaveLength(1);
    expect(task.version_cursor).toBeGreaterThanOrEqual(event!.position);
  });

  it("dedupes an exact replay but rejects sequence collisions and preserves only the later correction", async () => {
    server = await buildTestServer({ workspaceRoot: root });
    const run = await assigned();
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: computer, sequence: 0, event: { kind: "output", stream: "stdout", text: "not evidence" } });
    await expect(ingest(run, 0)).rejects.toThrow("different event");
    await ingest(run, 1);
    expect((await ingest(run, 1)).deduped).toBe(true);
    await expect(ingest(run, 1, "failed")).rejects.toThrow("different event");
    await expect(ingest(run, 2, "failed")).rejects.toThrow("incomplete-delivery correction");
    await expect(ingest(run, 0, "incomplete_delivery")).rejects.toThrow();
    await ingest(run, 3, "incomplete_delivery");
    expect((await ingest(run, 3, "incomplete_delivery")).deduped).toBe(true);
    await expect(ingest(run, 4)).rejects.toThrow("incomplete-delivery correction");
    expect(await events(run)).toHaveLength(2);
    const receipts = await server.db.db.select().from(runEventIngest).where(eq(runEventIngest.runId, run.id));
    expect(receipts).toHaveLength(3); // original output and the two distinct reports
    expect((await getRun(server.ctx, run.id)).workspace_retention).toMatchObject({ outcome: "incomplete_delivery", sequence: 3 });
  });

  it("performs run and task retention reads wholly within repeatable-read snapshots", async () => {
    server = await buildTestServer({ workspaceRoot: root });
    const run = await assigned();
    await ingest(run, 1);
    const transaction = vi.spyOn(server.db.db, "transaction");
    // An outer-database read would escape the snapshot that loaded the run identity.
    vi.spyOn(server.db.db, "select").mockImplementation(() => { throw new Error("read escaped the transaction"); });
    vi.spyOn(server.db.db, "selectDistinctOn").mockImplementation(() => { throw new Error("retention read escaped the transaction"); });
    const single = await getRun(server.ctx, run.id);
    const snapshot = await getTaskSnapshot(server.ctx, run.task_id);
    expect(single.workspace_retention).toEqual(snapshot.runs[0]!.workspace_retention);
    expect(transaction).toHaveBeenCalledTimes(2);
    for (const call of transaction.mock.calls) expect(call[1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
  });

  it("rejects wrong owner, exact path, branch, ordinary workspace and caller-supplied provenance", async () => {
    server = await buildTestServer({ workspaceRoot: root });
    const run = await assigned();
    for (const retention of [{ ...payload(run), workspace_root: root.toLowerCase() }, { ...payload(run), workspace_branch: "other" },
      { ...payload(run), reporter_computer_id: computer }, { ...payload(run), version: 2 }]) {
      await expect(ingestRunEvent(server.ctx, { runId: run.id, nodeId: computer, sequence: 1,
        event: { kind: "workspace_retained", retention: retention as RunWorkspaceRetainedPayload } })).rejects.toThrow();
    }
    await expect(ingestRunEvent(server.ctx, { runId: run.id, nodeId: "other-computer", sequence: 1,
      event: { kind: "workspace_retained", retention: payload(run) } })).rejects.toThrow("owning node");
    await expect(ingestRunEvent({ ...server.ctx, organizationId: "other-org" }, { runId: run.id, nodeId: computer, sequence: 1,
      event: { kind: "workspace_retained", retention: payload(run) } })).rejects.toThrow("run not found");
    await server.db.db.update(runs).set({ workspaceBranch: null }).where(eq(runs.id, run.id));
    await expect(ingest(run, 1)).rejects.toThrow("exact bound worktree");
    expect(await events(run)).toHaveLength(0);
    expect((await getRun(server.ctx, run.id)).workspace_retention).toBeNull();
  });

  it("keeps retention before completed but permits metadata after an independently settled cancellation", async () => {
    server = await buildTestServer({ workspaceRoot: root });
    const run = await assigned();
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: computer, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await ingest(run, 1);
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: computer, sequence: 2, event: { kind: "lifecycle", phase: "completed" } });
    const lifecycle = (await server.db.db.select().from(eventLog).where(and(eq(eventLog.runId, run.id), eq(eventLog.type, "run.completed"))))[0]!;
    expect((await events(run))[0]!.position).toBeLessThan(lifecycle.position);
    const stopped = await assigned();
    await ingestRunEvent(server.ctx, { runId: stopped.id, nodeId: computer, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await ingestRunEvent(server.ctx, { runId: stopped.id, nodeId: computer, sequence: 1, event: { kind: "lifecycle", phase: "cancelled" } });
    const leases = await server.db.db.select().from(fileLeases);
    await ingest(stopped, 2, "cancelled");
    expect((await getRun(server.ctx, stopped.id)).status).toBe("cancelled");
    expect(await server.db.db.select().from(fileLeases)).toEqual(leases);
  });

  it("selects one indexed report per run independent of output volume and never resurrects malformed latest evidence", async () => {
    server = await buildTestServer({ workspaceRoot: root });
    const run = await assigned();
    await ingest(run, 1);
    const [originalRun] = await server.db.db.select().from(runs).where(eq(runs.id, run.id));
    await server.db.db.insert(runs).values({ ...originalRun!, id: `${run.id}-other`, workspaceRoot: "/owned/other", workspaceBranch: "artoo/other" });
    const other = { ...run, id: `${run.id}-other`, workspace_root: "/owned/other", workspace_branch: "artoo/other" };
    await ingest(other, 2, "failed");
    await server.db.db.insert(eventLog).values(Array.from({ length: 150 }, (_, n) => buildEvent(server.ctx, {
      type: "run.output", actorType: "agent", actorId: run.agent_instance_id, correlationId: run.task_id,
      taskId: run.task_id, runId: run.id, payload: { stream: "stdout", text: "x".repeat(1000) }, sequence: n + 10,
    })));
    const read = await getRun(server.ctx, run.id);
    expect(read.workspace_retention).toMatchObject({ sequence: 1 });
    expect(JSON.stringify(read).length).toBeLessThan(2000);
    const snapshot = await getTaskSnapshot(server.ctx, run.task_id);
    expect(snapshot.runs).toHaveLength(2);
    expect(snapshot.runs.find((item) => item.id === run.id)?.workspace_retention).toMatchObject({ sequence: 1, workspace_root: root });
    expect(snapshot.runs.find((item) => item.id === other.id)?.workspace_retention).toMatchObject({ sequence: 2, workspace_root: "/owned/other", outcome: "failed" });
    const index = await server.db.db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'event_log_workspace_retention_run_idx'`);
    expect(index.rows[0]?.indexdef).toContain("organization_id, run_id, \"position\" DESC");
    expect(index.rows[0]?.indexdef).toContain("run.workspace.retained");
    const original = (await events(run))[0]!;
    const originalPayload = original.payload as Record<string, unknown>;
    await server.db.transaction(async (tx) => { await appendEvent(tx, { ...buildEvent(server.ctx, {
      type: "run.workspace.retained", actorType: "agent", actorId: run.agent_instance_id,
      correlationId: run.task_id, taskId: run.task_id, runId: run.id, sequence: 999, payload: originalPayload,
    }) }); });
    expect((await getRun(server.ctx, run.id)).workspace_retention).toBeNull();
    await server.db.transaction(async (tx) => { await appendEvent(tx, buildEvent(server.ctx, {
      type: "run.workspace.retained", actorType: "system", actorId: computer,
      correlationId: run.task_id, taskId: run.task_id, runId: run.id, sequence: 1000,
      payload: { ...originalPayload, exists: true }, // invalid extra field in a restored/latest row
    })); });
    expect((await getRun(server.ctx, run.id)).workspace_retention).toBeNull();
    const task = (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${run.task_id}` })).json();
    expect(task.runs.find((item: Run) => item.id === run.id).workspace_retention).toBeNull();
    expect(task.runs.find((item: Run) => item.id === other.id).workspace_retention).toMatchObject({ outcome: "failed" });
  });

  it("never promotes a legacy diagnostic or a startup rejection into typed retention", async () => {
    server = await buildTestServer({ workspaceRoot: root });
    const run = await assigned(false);
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: computer, sequence: 0, event: {
      kind: "output", stream: "stderr", text: `Worktree retained for recovery: ${JSON.stringify({ ...payload(run), workspace_branch: "claimed" })}`,
    } });
    expect((await getRun(server.ctx, run.id)).workspace_retention).toBeNull();
    expect(await events(run)).toEqual([]);
    await failRunStart(server.ctx, run.id, "process_start_failed", "Worktree retained for recovery: untyped startup diagnostic");
    expect(await getRun(server.ctx, run.id)).toMatchObject({ status: "failed", workspace_retention: null });
  });
});
