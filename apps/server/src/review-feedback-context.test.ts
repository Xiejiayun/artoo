import { contextPacks, eventLog, messages, organizations, tasks, users } from "@artoo/db";
import { ContextPackSchema } from "@artoo/domain";
import type { RunStartCommand, ServerToNodeMessage } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { buildRunContextPack } from "./services/context-pack-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("ordinary run review feedback context", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });

  async function createTask() {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Reviewed implementation", description: "Original task description",
      acceptance_criteria: ["Review corrections are implemented"], required_capabilities: ["code.modify"],
    } });
    expect(created.statusCode).toBe(201);
    const task = created.json().task as { id: string; room_id: string };
    const ready = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/ready` });
    expect(ready.statusCode).toBe(200);
    return task;
  }

  async function assign(taskId: string) {
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    expect(assigned.statusCode, assigned.body).toBe(200);
    return assigned.json().run as { id: string; context_pack_id: string };
  }

  async function complete(runId: string) {
    const completed = await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({ runStatus: "completed", taskStatus: "review" });
  }

  async function review(taskId: string, comment?: string | null, outcome: "changes_requested" | "accepted" = "changes_requested") {
    const result = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/review`, payload: { outcome, comment } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().task.status).toBe(outcome === "accepted" ? "done" : "ready");
    const events = await server.db.db.select().from(eventLog).where(and(eq(eventLog.taskId, taskId), eq(eventLog.type, "review.completed"))).orderBy(asc(eventLog.position));
    return events.at(-1)!;
  }

  async function pack(contextPackId: string) {
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, contextPackId));
    expect(stored).toBeDefined();
    return ContextPackSchema.parse(stored!.payload);
  }

  function feedback(event: typeof eventLog.$inferSelect) {
    const payload = event.payload as { comment: string };
    return {
      event_id: event.id, position: event.position, task_id: event.taskId,
      actor: { type: event.actorType, id: event.actorId },
      occurred_at: event.occurredAt, comment: payload.comment,
    };
  }

  it("delivers actual R1/C1 review feedback to R2 and R3 in event order, retaining immutable packs and original messages", async () => {
    const task = await createTask();
    const firstRun = await assign(task.id);
    const firstPack = await pack(firstRun.context_pack_id);
    expect(firstPack).not.toHaveProperty("review_feedback");
    await complete(firstRun.id);
    const snapshot = (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${task.id}` })).json();
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]).toMatchObject({ type: "report", run_id: firstRun.id });

    const firstComment = "  C1: preserve exact Unicode 修正\n\tand spacing  ";
    const firstReview = await review(task.id, firstComment);
    expect(firstReview).toMatchObject({ organizationId: server.ctx.organizationId, projectId: "proj_artoo", taskId: task.id,
      actorType: "user", actorId: server.ctx.actorUserId, runId: null, payload: { outcome: "changes_requested", comment: firstComment } });
    await server.db.db.insert(users).values({ id: "user_next_runner", organizationId: server.ctx.organizationId,
      email: "next-runner@artoo.dev", displayName: "Next runner", role: "owner", createdAt: server.ctx.clock.nowIso() });
    server.ctx.actorUserId = "user_next_runner";
    expect(server.ctx.actorUserId).not.toBe(firstReview.actorId);
    const secondRun = await assign(task.id);
    expect(secondRun.id).not.toBe(firstRun.id);
    const secondPack = await pack(secondRun.context_pack_id);
    expect(secondPack).toMatchObject({ review_feedback: { version: 1, entries: [feedback(firstReview)] } });
    expect(secondPack.task.description).toBe("Original task description");
    expect(secondPack).not.toHaveProperty("conversation");

    const channel = createInProcessChannel();
    const binding = attachNodeBinding(server.ctx, channel.serverTransport, "computer_local_mock");
    const sent: ServerToNodeMessage[] = [];
    const unsubscribe = channel.node.subscribe((message) => { sent.push(message); });
    try {
      await binding.dispatchRunStart(secondRun.id);
      const command = sent.find((message) => message.kind === "command" && message.type === "run.start") as RunStartCommand | undefined;
      expect(command?.payload.context_pack).toMatchObject({ id: secondRun.context_pack_id, payload: secondPack });
    } finally {
      unsubscribe();
      binding.close();
    }

    await complete(secondRun.id);
    const secondReview = await review(task.id, "C2: also cover the empty case");
    expect(secondReview.actorId).toBe("user_next_runner");
    // Fixed-clock events share a timestamp; the DB position supplies actual order.
    expect(secondReview.occurredAt).toBe(firstReview.occurredAt);
    expect(secondReview.position).toBeGreaterThan(firstReview.position);
    const thirdRun = await assign(task.id);
    expect(new Set([firstRun.id, secondRun.id, thirdRun.id]).size).toBe(3);
    const thirdPack = await pack(thirdRun.context_pack_id);
    expect(thirdPack).toMatchObject({ review_feedback: { version: 1, entries: [feedback(firstReview), feedback(secondReview)] } });
    expect(await pack(firstRun.context_pack_id)).toEqual(firstPack);
    expect(await pack(secondRun.context_pack_id)).toEqual(secondPack);
    expect(await server.db.db.select().from(messages).where(and(eq(messages.roomId, task.room_id), eq(messages.kind, "text")))).toEqual([]);
  });

  it("excludes absent, null, empty and whitespace-only review comments", async () => {
    const task = await createTask();
    let currentRun = await assign(task.id);
    for (const comment of [undefined, null, "", " \t\r\n "]) {
      await complete(currentRun.id);
      await review(task.id, comment);
      currentRun = await assign(task.id);
      expect(await pack(currentRun.context_pack_id)).not.toHaveProperty("review_feedback");
    }
  });

  it("excludes another task's actual review feedback", async () => {
    const otherTask = await createTask();
    await complete((await assign(otherTask.id)).id);
    const otherReview = await review(otherTask.id, "Only correct the other task");
    expect(otherReview.taskId).toBe(otherTask.id);
    const target = await createTask();
    const run = await assign(target.id);
    expect(await pack(run.context_pack_id)).not.toHaveProperty("review_feedback");
  });

  it("excludes an accepted review on the same task", async () => {
    const task = await createTask();
    await complete((await assign(task.id)).id);
    const accepted = await review(task.id, "Accepted, this is not another correction", "accepted");
    expect(accepted.payload).toMatchObject({ outcome: "accepted" });
    const [row] = await server.db.db.select().from(tasks).where(eq(tasks.id, task.id));
    // Acceptance closes the task, so test the builder directly instead of
    // manufacturing a reopen transition or a review event.
    const built = await server.ctx.db.transaction((tx) => buildRunContextPack(server.ctx, tx, {
      runId: "run_accepted_context_filter", task: row!, workspaceRoot: null,
    }));
    expect(await pack(built.contextPackId)).not.toHaveProperty("review_feedback");
  });

  it("does not read same-task review events from a different organization scope", async () => {
    const task = await createTask();
    await complete((await assign(task.id)).id);
    const actualReview = await review(task.id, "Original organization only");
    expect(actualReview.organizationId).toBe(server.ctx.organizationId);
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other organization", createdAt: server.ctx.clock.nowIso() });
    const [row] = await server.db.db.select().from(tasks).where(eq(tasks.id, task.id));
    // Hold the task selector constant to isolate the organization predicate;
    // the review itself was generated by the actual Review API route.
    const scopedContext = { ...server.ctx, organizationId: "org_other" };
    const built = await server.ctx.db.transaction((tx) => buildRunContextPack(scopedContext, tx, {
      runId: "run_other_organization_context_filter", task: row!, workspaceRoot: null,
    }));
    expect(await pack(built.contextPackId)).not.toHaveProperty("review_feedback");
  });
});
