// Real HTTP/DB/consent/blob boundaries, controlled node inventory and lifecycle
// events. No provider, physical process or second computer is started here.
import { randomUUID } from "node:crypto";
import {
  agentInstances,
  agents,
  artifacts,
  computers,
  contextPacks,
  devices,
  deviceTokens,
  eventLog,
  messages,
  projects,
  runs,
  taskAgentReviewFeedback,
  taskAgentReviews,
  taskDependencies,
  tasks,
} from "@artoo/db";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { blobChecksum } from "./content-addressed-blob.js";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { generateDeviceToken } from "./services/device-credential.js";
import { grantAiDataSharingConsent, revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import { ingestRunEvent } from "./services/run-service.js";
import { MemoryArtifactStore } from "./test-fixtures/memory-artifact-store.js";
import { buildTestServer, type TestServer } from "./test-support.js";

let server: TestServer;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
});
const reportText = "The artifact omits the required failure response. Add an explicit error contract and its evidence.";

async function setup(external = false) {
  const store = new MemoryArtifactStore();
  const policy = external
    ? buildAiDataSharingPolicy({
        mode: "external",
        providers: [
          { id: "controlled-provider", name: "Controlled provider", privacy_url: "https://example.com/privacy" },
        ],
      })
    : undefined;
  server = await buildTestServer({ artifactStore: store, ...(policy ? { aiDataSharingPolicy: policy } : {}) });
  if (policy) await grantAiDataSharingConsent(server.ctx, policy.version);
  const [computer] = await server.db.db.select().from(computers).where(eq(computers.id, "computer_local_mock"));
  const [agent] = await server.db.db.select().from(agents).where(eq(agents.id, "agent_mock_coder"));
  const [instance] = await server.db.db
    .select()
    .from(agentInstances)
    .where(eq(agentInstances.id, "instance_mock_coder"));
  if (!computer || !agent || !instance) throw new Error("Missing controlled node inventory");
  await server.db.db.insert(computers).values({
    ...computer,
    id: "computer_review_peer",
    displayName: "Controlled peer",
    capabilities: ["code.read", "code.modify"],
  });
  await server.db.db.insert(agents).values({
    ...agent,
    id: "agent_review_peer",
    displayName: "Artifact reviewer",
    capabilities: ["code.read", "code.modify"],
  });
  await server.db.db.insert(agentInstances).values({
    ...instance,
    id: "instance_review_peer",
    computerId: "computer_review_peer",
    agentId: "agent_review_peer",
  });
  const token = generateDeviceToken(),
    sessionId = randomUUID();
  await server.db.db.insert(devices).values({
    id: "device_review_peer",
    organizationId: server.ctx.organizationId,
    displayName: "Controlled peer",
    platform: "windows",
    appVersion: "controlled",
    computerId: "computer_review_peer",
    enrolledByUserId: "user_owner",
    trust: "active",
    createdAt: server.ctx.clock.nowIso(),
  });
  await server.db.db.insert(deviceTokens).values({
    id: "token_review_peer",
    organizationId: server.ctx.organizationId,
    deviceId: "device_review_peer",
    kind: "node",
    tokenLookup: token.lookup,
    tokenHash: token.secretHash,
    status: "active",
    createdAt: server.ctx.clock.nowIso(),
  });
  const session = {
    computerId: "computer_review_peer",
    deviceId: "device_review_peer",
    tokenLookup: token.lookup,
    sessionId,
  };
  server.ctx.getPairedNodeSession = (id) => (id === session.computerId ? { ...session } : undefined);
  server.ctx.supportsDependencyInputs = (id) => id === session.computerId;
  const create = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "Author a bounded contract",
      required_capabilities: ["code.modify"],
      acceptance_criteria: ["Include success and failure responses"],
    },
  });
  expect(create.statusCode, create.body).toBe(201);
  const taskId = create.json().task.id as string;
  expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
  const sourceAssignment = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "manual", agent_instance_id: "instance_mock_coder" },
  });
  expect(sourceAssignment.statusCode, sourceAssignment.body).toBe(200);
  const sourceRun = sourceAssignment.json().run;
  const bytes = Buffer.from("Success returns a versioned result. Failure behavior is not yet specified.\n"),
    checksum = blobChecksum(bytes);
  const upload = await server.app.inject({
    method: "PUT",
    url: `/api/v1/node/runs/${sourceRun.id}/artifacts?type=contract&path=contract.txt`,
    headers: {
      authorization: "Bearer dev",
      "x-artoo-node-id": "computer_local_mock",
      "content-type": "application/octet-stream",
      "x-artoo-checksum": checksum,
    },
    payload: bytes,
  });
  expect(upload.statusCode, upload.body).toBe(201);
  await ingestRunEvent(server.ctx, {
    runId: sourceRun.id,
    nodeId: "computer_local_mock",
    sequence: 1,
    event: { kind: "lifecycle", phase: "started" },
  });
  await ingestRunEvent(server.ctx, {
    runId: sourceRun.id,
    nodeId: "computer_local_mock",
    sequence: 2,
    event: { kind: "lifecycle", phase: "completed" },
  });
  const [artifact] = await server.db.db.select().from(artifacts).where(eq(artifacts.checksum, checksum));
  if (!artifact) throw new Error("Stored author artifact missing");
  const input = {
    version: 1,
    source_run_id: sourceRun.id,
    reviewer_agent_id: "agent_review_peer",
    artifact_ids: [artifact.id],
  };
  const createReview = async () => {
    const response = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/agent-reviews`,
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().review;
  };
  const assignReview = async (reviewTaskId: string) => {
    const response = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${reviewTaskId}/assign`,
      payload: { mode: "manual", agent_instance_id: "instance_review_peer" },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().run;
  };
  const completeReview = async (runId: string, answer: string | null = reportText) => {
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: session.computerId,
      sequence: 1,
      event: { kind: "lifecycle", phase: "started" },
    });
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: session.computerId,
      sequence: 2,
      event:
        answer === null
          ? { kind: "output", stream: "stdout", text: "A log must never become the report" }
          : { kind: "answer", text: answer },
    });
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: session.computerId,
      sequence: 3,
      event: { kind: "lifecycle", phase: "completed" },
    });
  };
  const list = async () => {
    const response = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}/agent-reviews` });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().reviews;
  };
  const apply = (reviewId: string, reviewRunId: string, extra = {}) =>
    server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/agent-reviews/${reviewId}/request-changes`,
      payload: { version: 1, review_run_id: reviewRunId, ...extra },
    });
  const sourceTask = async () => (await server.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  return {
    store,
    taskId,
    sourceRun,
    artifact,
    bytes,
    checksum,
    input,
    createReview,
    assignReview,
    completeReview,
    list,
    apply,
    sourceTask,
    headers: { authorization: `Bearer ${token.raw}`, "x-artoo-session-id": sessionId },
    session,
  };
}

it("creates an idempotent ready opinion sibling without a Run, parent, Goal or ordinary dependency", async () => {
  const f = await setup(),
    first = await f.createReview(),
    second = await f.createReview();
  expect(second).toEqual(first);
  const [task] = await server.db.db.select().from(tasks).where(eq(tasks.id, first.review_task_id));
  expect(task).toMatchObject({
    status: "ready",
    parentTaskId: null,
    goalId: null,
    sourcePlanId: null,
    executionPolicyTaskId: null,
    assigneeId: "agent_review_peer",
  });
  expect(await server.db.db.select().from(runs).where(eq(runs.taskId, task!.id))).toHaveLength(0);
  expect(
    await server.db.db.select().from(taskDependencies).where(eq(taskDependencies.toTaskId, task!.id)),
  ).toHaveLength(0);
  expect(await f.list()).toMatchObject([{ stale: false, report: null, review_run_id: null }]);
  expect((await f.sourceTask()).status).toBe("review");
  await expect(
    server.db.db
      .update(taskAgentReviews)
      .set({ reviewerAgentId: "agent_mock_coder" })
      .where(eq(taskAgentReviews.id, first.id)),
  ).rejects.toThrow();
});

it("rejects self-review, foreign-project reviewers, unknown artifacts and oversize aggregate input before inserting a sibling", async () => {
  const f = await setup(),
    before = await server.db.db.select({ id: tasks.id }).from(tasks);
  const request = (payload: Record<string, unknown>) =>
    server.app.inject({ method: "POST", url: `/api/v1/tasks/${f.taskId}/agent-reviews`, payload });
  expect((await request({ ...f.input, reviewer_agent_id: "agent_mock_coder" })).statusCode).toBe(403);
  expect((await request({ ...f.input, artifact_ids: ["other-artifact"] })).statusCode).toBe(409);
  await server.db.db.insert(projects).values({
    id: "project_unrelated",
    organizationId: server.ctx.organizationId,
    name: "Other project",
    createdAt: server.ctx.clock.nowIso(),
  });
  await server.db.db
    .update(agentInstances)
    .set({ projectId: "project_unrelated" })
    .where(eq(agentInstances.id, "instance_review_peer"));
  expect((await request(f.input)).statusCode).toBe(400);
  await server.db.db
    .update(agentInstances)
    .set({ projectId: "proj_artoo" })
    .where(eq(agentInstances.id, "instance_review_peer"));
  await server.db.db.insert(artifacts).values({
    ...f.artifact,
    id: "second_large_artifact",
    metadata: { ...(f.artifact.metadata as object), size: 6 * 1024 * 1024 },
  });
  await server.db.db
    .update(artifacts)
    .set({ metadata: { ...(f.artifact.metadata as object), size: 6 * 1024 * 1024 } })
    .where(eq(artifacts.id, f.artifact.id));
  expect((await request({ ...f.input, artifact_ids: [f.artifact.id, "second_large_artifact"] })).statusCode).toBe(409);
  expect(await server.db.db.select({ id: tasks.id }).from(tasks)).toEqual(before);
  expect(await server.db.db.select().from(taskAgentReviews)).toHaveLength(0);
});

it("requires the chosen logical reviewer, negotiated actual-input support and an isolated same-machine workspace", async () => {
  const f = await setup(),
    review = await f.createReview();
  const assign = (id: string) =>
    server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${review.review_task_id}/assign`,
      payload: { mode: "manual", agent_instance_id: id },
    });
  expect((await assign("instance_mock_coder")).statusCode).toBe(409);
  server.ctx.supportsDependencyInputs = () => false;
  expect((await assign("instance_review_peer")).statusCode).toBe(409);
  server.ctx.supportsDependencyInputs = () => true;
  await server.db.db
    .update(agentInstances)
    .set({ computerId: "computer_local_mock" })
    .where(eq(agentInstances.id, "instance_review_peer"));
  server.ctx.getPairedNodeSession = (id) => ({ ...f.session, computerId: id });
  expect((await assign("instance_review_peer")).statusCode).toBe(409);
  expect(await server.db.db.select().from(runs).where(eq(runs.taskId, review.review_task_id))).toHaveLength(0);
});

it("delivers exact frozen bytes from a review source only to its paired reviewer and rechecks after blob IO", async () => {
  const f = await setup(),
    review = await f.createReview(),
    run = await f.assignReview(review.review_task_id);
  const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
  expect(pack?.payload).toMatchObject({
    agent_review_subject: { review_id: review.id, source_run_id: f.sourceRun.id },
    dependency_context: {
      entries: [{ dependency_type: "user_requested_review", status: "review", workspace_root: null }],
    },
  });
  const url = `/api/v1/node/runs/${run.id}/dependency-artifacts/${f.artifact.id}/content`;
  const downloaded = await server.app.inject({ method: "GET", url, headers: f.headers });
  expect(downloaded.statusCode, downloaded.body).toBe(200);
  expect(downloaded.rawPayload).toEqual(f.bytes);
  expect(
    (await server.app.inject({ method: "GET", url, headers: { ...f.headers, "x-artoo-session-id": randomUUID() } }))
      .statusCode,
  ).toBe(403);
  const read = f.store.read.bind(f.store);
  vi.spyOn(f.store, "read").mockImplementation(async (checksum, size) => {
    const bytes = await read(checksum, size);
    await server.db.db.update(tasks).set({ status: "ready" }).where(eq(tasks.id, f.taskId));
    return bytes;
  });
  expect((await server.app.inject({ method: "GET", url, headers: f.headers })).statusCode).toBe(409);
});

it("keeps final opinions advisory until explicit user feedback and freezes their exact provenance into the author's retry", async () => {
  const f = await setup(),
    review = await f.createReview(),
    run = await f.assignReview(review.review_task_id);
  await f.completeReview(run.id);
  expect((await f.sourceTask()).status).toBe("review");
  expect(await f.list()).toMatchObject([{ report: reportText, review_run_id: run.id, stale: false, applied_at: null }]);
  const forged = await f.apply(review.id, run.id, { report: "Client replacement" });
  expect(forged.statusCode).toBe(400);
  const applied = await f.apply(review.id, run.id, { comment: "Preserve the success contract." });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().task.status).toBe("ready");
  const [feedback] = await server.db.db.select().from(taskAgentReviewFeedback);
  expect(feedback).toMatchObject({ reviewId: review.id, reviewRunId: run.id, requestedByUserId: "user_owner" });
  const [event] = await server.db.db.select().from(eventLog).where(eq(eventLog.id, feedback!.reviewEventId));
  expect(event?.payload).toMatchObject({
    outcome: "changes_requested",
    comment: expect.stringContaining(reportText),
    agent_review_feedback: {
      review_id: review.id,
      review_run_id: run.id,
      report_message_id: feedback!.reportMessageId,
    },
  });
  expect((event?.payload as { comment: string }).comment).toContain(review.id);
  expect(await f.list()).toMatchObject([{ stale: true, applied_event_id: feedback!.reviewEventId }]);
  expect((await f.apply(review.id, run.id)).statusCode).toBe(409);
  const retried = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${f.taskId}/assign`,
    payload: { mode: "manual", agent_instance_id: "instance_mock_coder" },
  });
  expect(retried.statusCode, retried.body).toBe(200);
  const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.runId, retried.json().run.id));
  expect(pack?.payload).toMatchObject({
    review_feedback: { entries: [{ comment: (event?.payload as { comment: string }).comment }] },
  });
});

it("rolls author transition and review event back when persisting applied feedback fails", async () => {
  const f = await setup(),
    review = await f.createReview(),
    run = await f.assignReview(review.review_task_id);
  await f.completeReview(run.id);
  await server.db.db.execute(
    sql.raw(
      "CREATE FUNCTION controlled_feedback_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled feedback storage failure'; END $$",
    ),
  );
  await server.db.db.execute(
    sql.raw(
      "CREATE TRIGGER controlled_feedback_insert_failure BEFORE INSERT ON task_agent_review_feedback FOR EACH ROW EXECUTE FUNCTION controlled_feedback_insert_failure()",
    ),
  );
  expect((await f.apply(review.id, run.id)).statusCode).toBe(500);
  expect((await f.sourceTask()).status).toBe("review");
  expect(await server.db.db.select().from(taskAgentReviewFeedback)).toHaveLength(0);
  expect(
    await server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.taskId, f.taskId), eq(eventLog.type, "review.completed"))),
  ).toHaveLength(0);
  await server.db.db.execute(sql.raw("DROP TRIGGER controlled_feedback_insert_failure ON task_agent_review_feedback"));
  const retry = await f.apply(review.id, run.id);
  expect(retry.statusCode, retry.body).toBe(200);
});

it("never promotes stdout or a moderated latest answer into an applicable report", async () => {
  const f = await setup(),
    review = await f.createReview(),
    run = await f.assignReview(review.review_task_id);
  await f.completeReview(run.id, null);
  expect(await f.list()).toMatchObject([{ report: null }]);
  expect((await f.apply(review.id, run.id)).statusCode).toBe(409);
  await server.db.db.insert(messages).values({
    id: "controlled_old_answer",
    organizationId: server.ctx.organizationId,
    roomId: (await server.db.db.select().from(tasks).where(eq(tasks.id, review.review_task_id)))[0]!.roomId!,
    taskId: review.review_task_id,
    runId: run.id,
    actorType: "agent",
    actorId: "instance_review_peer",
    kind: "text",
    body: "Older answer",
    createdAt: server.ctx.clock.nowIso(),
  });
  await server.db.db.insert(messages).values({
    id: "controlled_moderated_answer",
    organizationId: server.ctx.organizationId,
    roomId: (await server.db.db.select().from(tasks).where(eq(tasks.id, review.review_task_id)))[0]!.roomId!,
    taskId: review.review_task_id,
    runId: run.id,
    actorType: "agent",
    actorId: "instance_review_peer",
    kind: "text",
    body: reportText,
    moderatedAt: server.ctx.clock.nowIso(),
    moderatedByUserId: "user_owner",
    createdAt: server.ctx.clock.nowIso(),
  });
  expect(await f.list()).toMatchObject([{ report: null }]);
  expect((await f.apply(review.id, run.id)).statusCode).toBe(409);
  expect((await f.sourceTask()).status).toBe("review");
});

it("keeps a candidate stale after the author leaves review even if status and timestamp are restored", async () => {
  const f = await setup(),
    review = await f.createReview(),
    original = await f.sourceTask();
  expect(
    (
      await server.app.inject({
        method: "POST",
        url: `/api/v1/tasks/${f.taskId}/review`,
        payload: { outcome: "changes_requested", comment: "Author must revise" },
      })
    ).statusCode,
  ).toBe(200);
  await server.db.db
    .update(tasks)
    .set({ status: "review", updatedAt: original.updatedAt })
    .where(eq(tasks.id, f.taskId));
  expect(await f.list()).toMatchObject([{ stale: true }]);
  const response = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${review.review_task_id}/assign`,
    payload: { mode: "manual", agent_instance_id: "instance_review_peer" },
  });
  expect(response.statusCode).toBe(409);
});

it("does not revive an old review relation by granting a fresh external sharing consent", async () => {
  const f = await setup(true),
    review = await f.createReview();
  await revokeAiDataSharingConsent(server.ctx);
  await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy!.version);
  const response = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${review.review_task_id}/assign`,
    payload: { mode: "manual", agent_instance_id: "instance_review_peer" },
  });
  expect(response.statusCode, response.body).toBe(428);
  expect(await f.list()).toMatchObject([{ stale: true }]);
  expect(await server.db.db.select().from(runs).where(eq(runs.taskId, review.review_task_id))).toHaveLength(0);
});
