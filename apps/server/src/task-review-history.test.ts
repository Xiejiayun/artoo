import { artifacts, contextPacks, eventLog, organizations, users } from "@artoo/db";
import { ContextPackSchema, TaskReviewSchema } from "@artoo/domain";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getTaskSnapshot } from "./services/task-service.js";
import { listTaskReviews } from "./services/review-history-service.js";
import { ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("durable task review history", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });

  async function createTask() {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Durable corrections", acceptance_criteria: ["Reviewed"], required_capabilities: ["code.modify"],
    } });
    expect(response.statusCode).toBe(201);
    const taskId = response.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    return taskId;
  }

  async function assign(taskId: string) {
    const response = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().run as { id: string; context_pack_id: string };
  }

  async function complete(runId: string) {
    const response = await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function snapshot(taskId: string) {
    const response = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  async function review(taskId: string, outcome: "accepted" | "changes_requested", comment?: string | null) {
    const before = await snapshot(taskId);
    const response = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome, comment, base_version: before.version_cursor } });
    expect(response.statusCode, response.body).toBe(200);
    return snapshot(taskId);
  }

  async function pack(contextPackId: string) {
    const [row] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, contextPackId));
    return ContextPackSchema.parse(row!.payload);
  }

  it("reloads exact ordered reviews, reviewer names and immutable task artifact inventories across later executions", async () => {
    const other = await createTask();
    await complete((await assign(other)).id);
    await review(other, "changes_requested", "Other task only");
    const taskId = await createTask();
    const r1 = await assign(taskId);
    await complete(r1.id);
    const [a1] = await server.db.db.select().from(artifacts).where(eq(artifacts.runId, r1.id));
    await server.db.db.insert(organizations).values({ id: "org_foreign", name: "Foreign", createdAt: server.ctx.clock.nowIso() });
    // A mismatched legacy row must not contaminate the current org's inventory.
    await server.db.db.insert(artifacts).values({ ...a1!, id: "artifact_foreign", organizationId: "org_foreign" });

    const c1 = "  C1: 保留原文\n\tFix the first report.  ";
    const afterC1 = await review(taskId, "changes_requested", c1);
    expect(afterC1.reviews).toHaveLength(1);
    const first = TaskReviewSchema.parse(afterC1.reviews[0]);
    expect(first).toEqual({ event_id: expect.any(String), position: expect.any(Number), task_id: taskId,
      outcome: "changes_requested", comment: c1, actor: { type: "user", id: "user_owner" }, actor_name: "Owner",
      occurred_at: expect.any(String), artifact_ids: [a1!.id] });
    expect(afterC1.artifacts.map((item: { id: string }) => item.id)).toEqual([a1!.id]);
    expect((await snapshot(taskId)).reviews).toEqual(afterC1.reviews);

    await server.db.db.insert(users).values({ id: "user_reviewer_two", organizationId: server.ctx.organizationId,
      email: "reviewer-two@artoo.dev", displayName: "Second reviewer", role: "owner", createdAt: server.ctx.clock.nowIso() });
    server.ctx.actorUserId = "user_reviewer_two";
    const r2 = await assign(taskId);
    const r2Pack = await pack(r2.context_pack_id);
    expect(r2Pack.review_feedback?.entries).toEqual([expect.objectContaining({ event_id: first.event_id,
      comment: c1, actor: first.actor, artifact_ids: [a1!.id] })]);
    await complete(r2.id);
    const [a2] = await server.db.db.select().from(artifacts).where(eq(artifacts.runId, r2.id));
    const afterC2 = await review(taskId, "changes_requested", "C2: follow-up correction");
    expect(afterC2.reviews).toHaveLength(2);
    expect(afterC2.reviews[0]).toEqual(first);
    expect(afterC2.reviews[1]).toMatchObject({ actor: { type: "user", id: "user_reviewer_two" }, actor_name: "Second reviewer",
      artifact_ids: [a1!.id, a2!.id].sort(), comment: "C2: follow-up correction" });
    expect(afterC2.reviews[1].position).toBeGreaterThan(first.position);
    expect(afterC2.reviews[1].occurred_at).toBe(first.occurred_at);
    const r3 = await assign(taskId);
    expect((await pack(r3.context_pack_id)).review_feedback?.entries).toEqual([
      expect.objectContaining({ event_id: first.event_id, comment: c1, artifact_ids: [a1!.id] }),
      expect.objectContaining({ event_id: afterC2.reviews[1].event_id, comment: "C2: follow-up correction", artifact_ids: [a1!.id, a2!.id].sort() }),
    ]);
    expect(await pack(r2.context_pack_id)).toEqual(r2Pack);
    expect((await snapshot(taskId)).reviews).toEqual(afterC2.reviews);
    const stored = await server.db.db.select().from(eventLog).where(and(eq(eventLog.taskId, taskId), eq(eventLog.type, "review.completed"))).orderBy(asc(eventLog.position));
    expect(stored.map((row) => (row.payload as { artifact_ids: string[] }).artifact_ids)).toEqual([[a1!.id], [a1!.id, a2!.id].sort()]);
    await expect(getTaskSnapshot({ ...server.ctx, organizationId: "org_foreign" }, taskId)).rejects.toThrow("task not found");
    expect(await listTaskReviews({ ...server.ctx, organizationId: "org_foreign" }, server.db.db, taskId, "proj_artoo")).toEqual([]);
  });

  it("retains absent, null, empty and whitespace comments and accepted outcomes in history, without injecting them as corrections", async () => {
    const taskId = await createTask();
    let run = await assign(taskId);
    const comments = [undefined, null, "", " \t\n "];
    for (const comment of comments) {
      await complete(run.id);
      await review(taskId, "changes_requested", comment);
      run = await assign(taskId);
      expect(await pack(run.context_pack_id)).not.toHaveProperty("review_feedback");
    }
    await complete(run.id);
    const accepted = await review(taskId, "accepted", "Accepted as delivered");
    expect(accepted.reviews.map((row: { comment: string | null }) => row.comment)).toEqual([null, null, "", " \t\n ", "Accepted as delivered"]);
    expect(accepted.reviews.at(-1).outcome).toBe("accepted");
    expect(accepted.reviews.every((row: { artifact_ids: string[] | null }) => Array.isArray(row.artifact_ids))).toBe(true);
    expect((await snapshot(taskId)).reviews).toEqual(accepted.reviews);
  });

  it("keeps legacy artifact attribution unknown and a missing reviewer's identity durable", async () => {
    const taskId = await createTask();
    await complete((await assign(taskId)).id);
    await server.db.db.insert(users).values({ id: "user_retired", organizationId: server.ctx.organizationId,
      email: "retired@artoo.dev", displayName: "Retired reviewer", role: "owner", createdAt: server.ctx.clock.nowIso() });
    server.ctx.actorUserId = "user_retired";
    await review(taskId, "changes_requested", "Legacy correction");
    const [event] = await server.db.db.select().from(eventLog).where(and(eq(eventLog.taskId, taskId), eq(eventLog.type, "review.completed")));
    // Restore the legacy shape after generating the actual review via its API.
    await server.db.db.update(eventLog).set({ payload: { outcome: "changes_requested", comment: "Legacy correction" } }).where(eq(eventLog.id, event!.id));
    await server.db.db.delete(users).where(eq(users.id, "user_retired"));
    server.ctx.actorUserId = "user_owner";
    const restored = await snapshot(taskId);
    expect(restored.reviews).toEqual([expect.objectContaining({ event_id: event!.id,
      actor: { type: "user", id: "user_retired" }, actor_name: null, artifact_ids: null })]);
    const next = await assign(taskId);
    expect((await pack(next.context_pack_id)).review_feedback?.entries).toEqual([expect.objectContaining({ event_id: event!.id, artifact_ids: null })]);
  });

  it("records an empty artifact inventory when a real completed run produced no artifact", async () => {
    const taskId = await createTask();
    const run = await assign(taskId);
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: "computer_local_mock", sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: "computer_local_mock", sequence: 1, event: { kind: "lifecycle", phase: "completed" } });
    const reviewed = await review(taskId, "changes_requested", "Supply the missing report");
    expect(reviewed.artifacts).toEqual([]);
    expect(reviewed.reviews[0].artifact_ids).toEqual([]);
    const next = await assign(taskId);
    expect((await pack(next.context_pack_id)).review_feedback?.entries[0]?.artifact_ids).toEqual([]);
  });

  it("treats a malformed legacy artifact inventory as wholly unknown without breaking history or execution", async () => {
    const taskId = await createTask();
    await complete((await assign(taskId)).id);
    await review(taskId, "changes_requested", "Legacy inventory correction");
    const [event] = await server.db.db.select().from(eventLog).where(and(eq(eventLog.taskId, taskId), eq(eventLog.type, "review.completed")));
    for (const artifact_ids of [false, "artifact_old", {}, ["artifact_valid", null], [""], ["artifact_duplicate", "artifact_duplicate"]]) {
      await server.db.db.update(eventLog).set({ payload: { ...(event!.payload as Record<string, unknown>), artifact_ids } }).where(eq(eventLog.id, event!.id));
      const loaded = await snapshot(taskId);
      expect(loaded.reviews).toHaveLength(1);
      expect(loaded.reviews[0]).toMatchObject({ event_id: event!.id, comment: "Legacy inventory correction", artifact_ids: null });
    }
    const next = await assign(taskId);
    expect((await pack(next.context_pack_id)).review_feedback?.entries).toEqual([
      expect.objectContaining({ event_id: event!.id, artifact_ids: null, comment: "Legacy inventory correction" }),
    ]);
  });

  it("rejects a review from an older artifact/task snapshot without creating history or changing the current review state", async () => {
    const taskId = await createTask();
    await complete((await assign(taskId)).id);
    const old = await snapshot(taskId);
    await review(taskId, "changes_requested", "First correction");
    await complete((await assign(taskId)).id);
    const current = await snapshot(taskId);
    const stale = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "accepted", comment: "Stale acceptance", base_version: old.version_cursor } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.reason).toBe("stale_base_version");
    const reloaded = await snapshot(taskId);
    expect(reloaded.task.status).toBe("review");
    expect(reloaded.reviews).toEqual(current.reviews);
    expect(reloaded.artifacts).toEqual(current.artifacts);
    expect(reloaded.version_cursor).toBe(current.version_cursor);
    const accepted = await review(taskId, "accepted", "Current acceptance");
    expect(accepted.reviews).toHaveLength(2);
    expect(accepted.reviews.at(-1).artifact_ids).toEqual(current.artifacts.map((row: { id: string }) => row.id).sort());
  });
});
