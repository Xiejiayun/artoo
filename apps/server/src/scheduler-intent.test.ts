import {
  agentInstances,
  aiDataSharingConsents,
  appendEvent,
  eventLog,
  fileLeases,
  memberSuspensions,
  messages,
  modelProfiles,
  organizations,
  runs,
  schedulerIntents,
  schedulerProjectPolicies,
  schedulerShadowAttempts,
  tasks,
  users,
} from "@artoo/db";
import { eq } from "drizzle-orm";
import { ID_PREFIXES } from "@artoo/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { createSession, provisionUser } from "./auth/auth-service.js";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { buildEvent } from "./events.js";
import { grantAiDataSharingConsent, revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import { cancelSchedulerIntent, createSchedulerIntent } from "./services/scheduler-intent-service.js";
import { cancelSchedulerShadow, claimSchedulerShadow } from "./services/scheduler-shadow-lease-service.js";
import { currentTaskVersion } from "./services/sync-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const policies = [
  ["projects/proj_artoo", { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 }],
  [
    "agents/agent_mock_coder",
    { version: 1, pinned_computer_id: null, required_runtimes: ["mock"], required_labels: [], max_concurrent_runs: 2 },
  ],
  ["computers/computer_local_mock", { version: 1, labels: [], max_concurrent_runs: 2 }],
] as const;

describe("durable original-user shadow scheduling intent", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  async function setup() {
    server = await buildTestServer();
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: { org_default: { flags: { claim_shadow: true, unified_enqueue: true } } },
      }),
    });
    for (const [resource, policy] of policies)
      expect(
        (await server.app.inject({ method: "PUT", url: `/api/v1/${resource}/scheduling-policy`, payload: policy }))
          .statusCode,
      ).toBe(200);
  }
  async function ready(source = false) {
    const result = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "Original scheduling request",
        required_capabilities: ["code.modify"],
        acceptance_criteria: ["ok"],
        ...(source
          ? {
              enqueue_source: {
                version: 1,
                kind: "issue",
                key: "issue-42",
                event_id: "comment-1",
                comment: "Original input",
              },
            }
          : {}),
      },
    });
    expect(result.statusCode).toBe(201);
    const id = result.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
    return id;
  }
  async function input(taskId: string, key = "request-1") {
    return {
      version: 1 as const,
      request_key: key,
      base_version: await currentTaskVersion(server.ctx, taskId),
      agent_id: "agent_mock_coder",
      branch_backed: true as const,
      write_paths: ["src/main.ts"],
    };
  }
  async function stage(taskId: string, key = "request-1") {
    return createSchedulerIntent(server.ctx, taskId, await input(taskId, key));
  }
  const claim = (taskId: string, intentId: string, ctx = server.ctx) =>
    claimSchedulerShadow(ctx, {
      projectId: "proj_artoo",
      taskId,
      intentId,
      options: { mode: "auto", branchBacked: true },
    });

  it("captures the original user and exact bindings, replays once and feeds only its Agent into shadow ranking", async () => {
    await setup();
    await server.db.db
      .update(agentInstances)
      .set({ config: { private_test_marker: "must-not-be-persisted-in-intent" } })
      .where(eq(agentInstances.id, "instance_mock_coder"));
    const taskId = await ready(),
      request = await input(taskId);
    const before = await server.db.db.select().from(tasks),
      dispatch = vi.fn();
    server.ctx.onRunQueued = dispatch;
    const response = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/scheduler-intents`,
      payload: request,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      active: false,
      execution_authorized: false,
      intent: {
        actorUserId: "user_owner",
        state: "pending",
        executionAuthorized: false,
        snapshot: {
          actor_user_id: "user_owner",
          task_id: taskId,
          request,
          queue_revision: null,
          policy_revisions: { project: 1, agent: 1, computers: { computer_local_mock: 1 } },
          execution_authorized: false,
        },
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("must-not-be-persisted-in-intent");
    const row = (await server.db.db.select().from(schedulerIntents))[0]!;
    expect(await createSchedulerIntent(server.ctx, taskId, request)).toEqual(row);
    expect(await server.db.db.select().from(schedulerIntents)).toEqual([row]);
    await expect(
      createSchedulerIntent(server.ctx, taskId, {
        ...request,
        write_paths: ["src/different.ts"],
      }),
    ).rejects.toThrow("different inputs");
    await expect(
      createSchedulerIntent(server.ctx, taskId, {
        ...request,
        request_key: "second-pending-request",
      }),
    ).rejects.toThrow("Cancel the existing");
    await expect(
      createSchedulerIntent(server.ctx, taskId, {
        ...request,
        write_paths: ["../outside.ts"],
      }),
    ).rejects.toThrow("Invalid write path");
    for (const options of [
      { mode: "manual" as const, branchBacked: true },
      { mode: "auto" as const, branchBacked: false },
      { mode: "auto" as const, branchBacked: true, agentInstanceId: "instance_mock_coder" },
      { mode: "auto" as const, branchBacked: true, importedDesignRunId: "unrelated-reservation" },
    ])
      await expect(
        claimSchedulerShadow(server.ctx, {
          projectId: "proj_artoo",
          taskId,
          intentId: row.id,
          options,
        }),
      ).rejects.toThrow("original pooled scheduling request");
    const result = await claim(taskId, row.id, { ...server.ctx, actorUserId: "daemon-default-is-not-the-user" });
    expect(result.kind).toBe("claimed");
    if (!("binding" in result)) throw new Error("Expected a shadow claim");
    expect(result.snapshot.intent_provenance).toEqual({
      version: 1,
      intent_id: row.id,
      task_id: taskId,
      agent_id: row.agentId,
      actor_user_id: "user_owner",
      snapshot_digest: row.snapshotDigest,
      execution_authorized: false,
    });
    expect(result.snapshot.candidates.length).toBeGreaterThan(0);
    expect(result.snapshot.candidates.every((candidate) => candidate.agent_id === row.agentId)).toBe(true);
    expect(await server.db.db.select().from(tasks)).toEqual(before);
    for (const table of [runs, fileLeases]) expect(await server.db.db.select().from(table)).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    const history = await server.db.db.select().from(schedulerShadowAttempts);
    await cancelSchedulerShadow(server.ctx, result.binding);
    await cancelSchedulerIntent(server.ctx, taskId, row.id);
    const cancelledHistory = await server.db.db.select().from(schedulerShadowAttempts);
    expect(cancelledHistory[0]?.snapshot).toEqual(history[0]?.snapshot);
    expect((await server.db.db.select().from(schedulerIntents))[0]?.snapshot).toEqual(row.snapshot);
    await expect(claim(taskId, row.id)).rejects.toThrow("missing or cancelled");
  });

  it("rejects disabled staging, forged authority, stale or future versions and dedicated task owners", async () => {
    await setup();
    const taskId = await ready(),
      request = await input(taskId);
    server.ctx.schedulerRollout = undefined;
    await expect(createSchedulerIntent(server.ctx, taskId, request)).rejects.toThrow("disabled");
    await setupFlags();
    for (const invalid of [
      { actor_user_id: "someone" },
      { consent_id: "consent" },
      { profile_id: "verifier" },
      { branch_backed: false },
    ])
      expect(
        (
          await server.app.inject({
            method: "POST",
            url: `/api/v1/tasks/${taskId}/scheduler-intents`,
            payload: { ...request, ...invalid },
          })
        ).statusCode,
      ).toBe(400);
    for (const base_version of [request.base_version - 1, request.base_version + 1])
      await expect(createSchedulerIntent(server.ctx, taskId, { ...request, base_version })).rejects.toThrow(
        "Task version changed",
      );
    await expect(
      createSchedulerIntent({ ...server.ctx, automationActor: { type: "system", id: "goal_runner" } }, taskId, request),
    ).rejects.toThrow("original-user");
    await server.db.db.update(tasks).set({ sourcePlanId: "dedicated-plan" }).where(eq(tasks.id, taskId));
    await expect(createSchedulerIntent(server.ctx, taskId, request)).rejects.toThrow("dedicated");
    expect(await server.db.db.select().from(schedulerIntents)).toEqual([]);
  });
  async function setupFlags() {
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT:
        '{"version":1,"workspaces":{"org_default":{"flags":{"claim_shadow":true,"unified_enqueue":true}}}}',
    });
  }

  it("takes its actor from the authenticated request scope and enforces cancellation ownership", async () => {
    await setup();
    const taskId = await ready(),
      request = await input(taskId);
    const member = await provisionUser(server.ctx, {
      subject: "intent-member",
      email: "intent-member@example.test",
      emailVerified: true,
      displayName: "Intent member",
    });
    const session = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: member.userId });
    const owner = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: "user_owner" });
    server.ctx.authConfig.enforceApiAuth = true;
    const url = `/api/v1/tasks/${taskId}/scheduler-intents`;
    expect((await server.app.inject({ method: "POST", url, payload: request })).statusCode).toBe(401);
    const response = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${session.raw}` },
      payload: request,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().intent.actorUserId).toBe(member.userId);
    expect(response.json().intent.snapshot.actor_user_id).toBe(member.userId);
    const id = response.json().intent.id as string;
    const audit = (await server.db.db.select().from(eventLog).where(eq(eventLog.type, "scheduler.intent.created")))[0];
    expect(audit?.actorId).toBe(member.userId);
    const cancelled = await server.app.inject({
      method: "POST",
      url: `${url}/${id}/cancel`,
      headers: { authorization: `Bearer ${owner.raw}` },
      payload: { version: 1 },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().intent.cancelledByUserId).toBe("user_owner");
  });

  it("requires explicit scoped policies and retains the original execution approval", async () => {
    await setup();
    const taskId = await ready(),
      request = await input(taskId);
    const [policy] = await server.db.db.select().from(schedulerProjectPolicies);
    await server.db.db.delete(schedulerProjectPolicies).where(eq(schedulerProjectPolicies.projectId, "proj_artoo"));
    await expect(createSchedulerIntent(server.ctx, taskId, request)).rejects.toThrow("Explicit project and Agent");
    await server.db.db.insert(schedulerProjectPolicies).values(policy!);
    const approval = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/execution-approval`,
      payload: { summary: "Review before work", risk: "high" },
    });
    expect(approval.statusCode).toBe(201);
    await expect(stage(taskId)).rejects.toThrow("Execution approval is required");
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: `/api/v1/approvals/${approval.json().approval.id}/resolve`,
          payload: { decision: "approved" },
        })
      ).statusCode,
    ).toBe(200);
    const row = await stage(taskId);
    const replacement = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/execution-approval`,
      payload: { summary: "Fresh review", risk: "high" },
    });
    expect(replacement.statusCode).toBe(201);
    await expect(claim(taskId, row.id)).rejects.toThrow("Execution approval is required");
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: `/api/v1/approvals/${replacement.json().approval.id}/resolve`,
          payload: { decision: "approved" },
        })
      ).statusCode,
    ).toBe(200);
    await expect(claim(taskId, row.id)).rejects.toThrow("task_input_version changed");
    expect((await server.db.db.select().from(schedulerIntents))[0]).toEqual(row);
    expect(await server.db.db.select().from(runs)).toEqual([]);
  });

  it("never substitutes a new consent grant or a daemon actor for the original user's withdrawn authorization", async () => {
    await setup();
    server.ctx.aiDataSharingPolicy = buildAiDataSharingPolicy({
      mode: "external",
      providers: [{ id: "test", name: "Test Provider", privacy_url: "https://example.com/privacy" }],
    });
    await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
    const taskId = await ready(),
      row = await stage(taskId);
    await revokeAiDataSharingConsent(server.ctx);
    await expect(claim(taskId, row.id)).rejects.toThrow("Review and allow");
    await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
    const grants = await server.db.db.select().from(aiDataSharingConsents);
    expect(grants.find((grant) => grant.revokedAt === null)?.id).not.toBe(row.snapshot.ai_sharing.consent_id);
    await expect(claim(taskId, row.id)).rejects.toThrow("Review and allow");
    // Withdrawal must never prevent stopping the old request.
    await revokeAiDataSharingConsent(server.ctx);
    expect((await cancelSchedulerIntent(server.ctx, taskId, row.id)).state).toBe("cancelled");
    expect(await server.db.db.select().from(schedulerShadowAttempts)).toEqual([]);
  });

  it("revalidates active access for the original user, including when another context samples the claim", async () => {
    await setup();
    const taskId = await ready(),
      row = await stage(taskId);
    server.ctx.authConfig.allowedEmails = ["different-user@example.test"];
    await expect(claim(taskId, row.id, { ...server.ctx, actorUserId: "other-user" })).rejects.toThrow("active access");
    server.ctx.authConfig.allowedEmails = undefined;
    await server.db.db.insert(memberSuspensions).values({
      organizationId: "org_default",
      userId: "user_owner",
      suspendedAt: server.ctx.clock.nowIso(),
      suspendedByUserId: "user_owner",
      reason: "Controlled original-user revocation check",
    });
    await expect(claim(taskId, row.id, { ...server.ctx, actorUserId: "other-user" })).rejects.toThrow("active access");
    expect(await server.db.db.select().from(schedulerShadowAttempts)).toEqual([]);
  });

  for (const [resource, policy] of policies)
    it(`rejects every accepted ${resource} policy edit, including equal and restored values`, async () => {
      await setup();
      const taskId = await ready(),
        row = await stage(taskId);
      for (const next of [{ ...policy, max_concurrent_runs: 3 }, policy, policy]) {
        expect(
          (await server.app.inject({ method: "PUT", url: `/api/v1/${resource}/scheduling-policy`, payload: next }))
            .statusCode,
        ).toBe(200);
        await expect(claim(taskId, row.id)).rejects.toThrow("policy_revisions changed");
      }
      expect((await server.db.db.select().from(schedulerIntents))[0]).toEqual(row);
    });

  it("rejects queue changes and configuration/profile drift without rewriting the staged snapshot", async () => {
    await setup();
    const taskId = await ready(),
      row = await stage(taskId);
    expect(
      (
        await server.app.inject({
          method: "PUT",
          url: `/api/v1/tasks/${taskId}/scheduler-queue-metadata`,
          payload: {
            version: 1,
            not_before_ms: 0,
            preferred_computer_id: null,
            prefer_until_ms: null,
          },
        })
      ).statusCode,
    ).toBe(200);
    await expect(claim(taskId, row.id)).rejects.toThrow();
    await cancelSchedulerIntent(server.ctx, taskId, row.id);
    const fresh = await stage(taskId, "after-queue");
    const [instance] = await server.db.db
      .select()
      .from(agentInstances)
      .where(eq(agentInstances.id, "instance_mock_coder"));
    await server.db.db
      .update(agentInstances)
      .set({ workspaceRoot: "changed-workspace" })
      .where(eq(agentInstances.id, instance!.id));
    await expect(claim(taskId, fresh.id)).rejects.toThrow("configuration_digest changed");
    await server.db.db
      .update(agentInstances)
      .set({ workspaceRoot: instance!.workspaceRoot })
      .where(eq(agentInstances.id, instance!.id));
    const [model] = await server.db.db.select().from(modelProfiles).limit(1);
    await server.db.db
      .update(modelProfiles)
      .set({ config: { changed: true } })
      .where(eq(modelProfiles.id, model!.id));
    await expect(claim(taskId, fresh.id)).rejects.toThrow("configuration_digest changed");
    expect((await server.db.db.select().from(schedulerIntents))[0]?.snapshot).toEqual(row.snapshot);
  });

  it("invalidates an input change even after its old value is restored, and checks current source comments", async () => {
    await setup();
    const taskId = await ready(true),
      row = await stage(taskId);
    const [comment] = await server.db.db.select().from(messages).where(eq(messages.taskId, taskId));
    expect(comment?.body).toBe("Original input");
    await server.db.db
      .update(messages)
      .set({ moderatedAt: server.ctx.clock.nowIso(), moderatedByUserId: "user_owner" })
      .where(eq(messages.id, comment!.id));
    await expect(claim(taskId, row.id)).rejects.toThrow("task_input_digest changed");
    await server.db.db
      .update(messages)
      .set({ moderatedAt: null, moderatedByUserId: null })
      .where(eq(messages.id, comment!.id));
    await server.db.transaction(async (tx) => {
      await appendEvent(
        tx,
        buildEvent(server.ctx, {
          type: "task.updated",
          actorType: "user",
          actorId: "user_owner",
          taskId,
          projectId: "proj_artoo",
          correlationId: taskId,
          payload: { title: "Changed and restored" },
        }),
      );
    });
    await expect(claim(taskId, row.id)).rejects.toThrow("task_input_version changed");
  });

  it("keeps cancellation scoped, durable, idempotent and available with rollout off", async () => {
    await setup();
    const taskId = await ready(),
      request = await input(taskId),
      row = await createSchedulerIntent(server.ctx, taskId, request);
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(users).values({
      id: "member",
      organizationId: "org_default",
      email: "member@example.com",
      displayName: "Member",
      role: "member",
      createdAt: now,
    });
    await expect(cancelSchedulerIntent({ ...server.ctx, actorUserId: "member" }, taskId, row.id)).rejects.toThrow(
      "owner or admin",
    );
    await server.db.db.insert(organizations).values({ id: "foreign", name: "Foreign", createdAt: now });
    expect(
      (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}/scheduler-intents` })).json().intents,
    ).toHaveLength(1);
    await expect(
      createSchedulerIntent({ ...server.ctx, organizationId: "foreign" }, taskId, request),
    ).rejects.toThrow();
    const other = await ready();
    await expect(claim(other, row.id)).rejects.toThrow("missing or cancelled");
    server.ctx.schedulerRollout = undefined;
    const cancelled = await cancelSchedulerIntent(server.ctx, taskId, row.id);
    expect(await cancelSchedulerIntent(server.ctx, taskId, row.id)).toEqual(cancelled);
    await setupFlags();
    expect((await createSchedulerIntent(server.ctx, taskId, request)).state).toBe("cancelled");
    await expect(claim(taskId, row.id)).rejects.toThrow("missing or cancelled");
    expect(await server.db.db.select().from(runs)).toEqual([]);
  });

  it("rolls back both creation and cancellation with their audit writes", async () => {
    await setup();
    const taskId = await ready(),
      request = await input(taskId),
      generate = server.ctx.idGen.generate;
    const events = await server.db.db.select().from(eventLog);
    server.ctx.idGen.generate = (prefix) => {
      if (prefix === ID_PREFIXES.event) throw new Error("audit unavailable");
      return generate(prefix);
    };
    try {
      await expect(createSchedulerIntent(server.ctx, taskId, request)).rejects.toThrow("audit unavailable");
    } finally {
      server.ctx.idGen.generate = generate;
    }
    expect(await server.db.db.select().from(schedulerIntents)).toEqual([]);
    expect(await server.db.db.select().from(eventLog)).toEqual(events);
    const row = await stage(taskId);
    server.ctx.idGen.generate = () => {
      throw new Error("audit unavailable");
    };
    try {
      await expect(cancelSchedulerIntent(server.ctx, taskId, row.id)).rejects.toThrow("audit unavailable");
    } finally {
      server.ctx.idGen.generate = generate;
    }
    expect(await server.db.db.select().from(schedulerIntents)).toEqual([row]);
  });
});
