import {
  agentInstances,
  aiDataSharingConsents,
  appendEvent,
  computers,
  effortProfiles,
  eventLog,
  fileLeases,
  memberSuspensions,
  messages,
  modelProfiles,
  organizations,
  projects,
  runs,
  schedulerExecutionRequests,
  schedulerIntents,
  schedulerShadowAttempts,
  schedulerProjectPolicies,
  skillInstalls,
  tasks,
} from "@artoo/db";
import { ID_PREFIXES } from "@artoo/domain";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, provisionUser } from "./auth/auth-service.js";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { buildEvent } from "./events.js";
import { grantAiDataSharingConsent, revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import {
  cancelSchedulerExecutionRequest,
  createSchedulerExecutionRequest,
  listSchedulerExecutionRequests,
  validateSchedulerExecutionRequestSnapshot,
} from "./services/scheduler-execution-request-service.js";
import { createSchedulerIntent, validateSchedulerIntentForShadow } from "./services/scheduler-intent-service.js";
import { lockSchedulerRequestTask } from "./services/scheduler-request-bindings.js";
import { claimSchedulerShadow } from "./services/scheduler-shadow-lease-service.js";
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

describe("explicit conditional execution requests", () => {
  let server: TestServer;
  const url = (taskId: string) => `/api/v1/tasks/${taskId}/scheduler-execution-requests`;
  function flags() {
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: { org_default: { flags: { execution_requests: true, claim_shadow: true, unified_enqueue: true } } },
      }),
    });
  }
  afterEach(async () => {
    await server?.close();
  });
  async function setup() {
    server = await buildTestServer();
    flags();
    for (const [resource, policy] of policies)
      expect(
        (await server.app.inject({ method: "PUT", url: `/api/v1/${resource}/scheduling-policy`, payload: policy }))
          .statusCode,
      ).toBe(200);
  }
  async function ready(source = false) {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "Explicit one-execution request",
        required_capabilities: ["code.modify"],
        acceptance_criteria: ["ok"],
        ...(source
          ? {
              enqueue_source: {
                version: 1,
                kind: "issue",
                key: "issue-43",
                event_id: "first",
                comment: "Original input",
              },
            }
          : {}),
      },
    });
    expect(response.statusCode).toBe(201);
    const id = response.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
    return id;
  }
  async function input(taskId: string, key = "request-one") {
    return {
      version: 2 as const,
      permission: "execute_once" as const,
      request_key: key,
      base_version: await currentTaskVersion(server.ctx, taskId),
      agent_id: "agent_mock_coder",
      branch_backed: true as const,
      write_paths: ["src/main.ts"],
    };
  }
  async function stage(taskId: string, key = "request-one") {
    return createSchedulerExecutionRequest(server.ctx, taskId, await input(taskId, key));
  }
  const inspect = (taskId: string, requestId: string, ctx = server.ctx) =>
    server.db.transaction(async (tx) => {
      const task = await lockSchedulerRequestTask(ctx, tx, taskId);
      return validateSchedulerExecutionRequestSnapshot(ctx, tx, task, requestId);
    });

  it("captures fresh original-user permission, preserves v1 and creates no execution or grant", async () => {
    await setup();
    await server.db.db
      .update(agentInstances)
      .set({ config: { private_marker: "must-never-leave-the-digest" } })
      .where(eq(agentInstances.id, "instance_mock_coder"));
    const taskId = await ready();
    const { permission: _permission, ...oldInput } = await input(taskId);
    const old = await createSchedulerIntent(server.ctx, taskId, { ...oldInput, version: 1 });
    const request = await input(taskId);
    const before = await server.db.db.select().from(tasks),
      dispatch = vi.fn();
    server.ctx.onRunQueued = dispatch;
    const response = await server.app.inject({ method: "POST", url: url(taskId), payload: request });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      consumer_available: false,
      execution_authorized: false,
      request: {
        version: 2,
        state: "pending",
        actorUserId: "user_owner",
        snapshot: {
          version: 2,
          actor_user_id: "user_owner",
          request,
          policy_revisions: { project: 1, agent: 1, computers: { computer_local_mock: 1 } },
        },
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("must-never-leave-the-digest");
    const row = (await server.db.db.select().from(schedulerExecutionRequests))[0]!;
    expect(await createSchedulerExecutionRequest(server.ctx, taskId, request)).toEqual(row);
    expect(
      (await inspect(taskId, row.id, { ...server.ctx, actorUserId: "daemon-default-is-not-the-user" })).row,
    ).toEqual(row);
    await expect(
      createSchedulerExecutionRequest(server.ctx, taskId, { ...request, write_paths: ["other.ts"] }),
    ).rejects.toThrow("different inputs");
    await expect(stage(taskId, "second")).rejects.toThrow("Cancel the existing");
    expect(
      (await server.app.inject({ method: "POST", url: url(taskId), payload: { ...oldInput, version: 1 } })).statusCode,
    ).toBe(400);
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/scheduler-intents`, payload: request }))
        .statusCode,
    ).toBe(400);
    await expect(
      claimSchedulerShadow(server.ctx, {
        projectId: "proj_artoo",
        taskId,
        intentId: row.id,
        options: { mode: "auto", branchBacked: true },
      }),
    ).rejects.toThrow("missing or cancelled");
    expect(await server.db.db.select().from(schedulerIntents)).toEqual([old]);
    expect(
      (
        await server.db.transaction(async (tx) =>
          validateSchedulerIntentForShadow(
            server.ctx,
            tx,
            await lockSchedulerRequestTask(server.ctx, tx, taskId),
            old.id,
          ),
        )
      ).row,
    ).toEqual(old);
    expect(await server.db.db.select().from(tasks)).toEqual(before);
    for (const table of [runs, fileLeases, schedulerShadowAttempts])
      expect(await server.db.db.select().from(table)).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      (await server.db.db.select().from(eventLog).where(eq(eventLog.type, "scheduler.execution_request.created"))).map(
        (event) => event.actorId,
      ),
    ).toEqual(["user_owner"]);
  });

  it("rejects off scopes, old or forged permission, unsafe paths, task versions and dedicated owners", async () => {
    await setup();
    const taskId = await ready(),
      request = await input(taskId);
    server.ctx.schedulerRollout = undefined;
    await expect(createSchedulerExecutionRequest(server.ctx, taskId, request)).rejects.toThrow("disabled");
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_default: { flags: { execution_requests: true }, projects: { proj_artoo: { execution_requests: false } } },
        },
      }),
    });
    await expect(createSchedulerExecutionRequest(server.ctx, taskId, request)).rejects.toThrow("disabled");
    flags();
    const { permission: _permission, ...missingPermission } = request;
    expect((await server.app.inject({ method: "POST", url: url(taskId), payload: missingPermission })).statusCode).toBe(
      400,
    );
    for (const invalid of [
      { actor_user_id: "forged" },
      { consent_id: "forged" },
      { computer_id: "fixed" },
      { profile_id: "verifier" },
      { argv: ["node"] },
      { branch_backed: false },
      { permission: "publish" },
    ])
      expect(
        (await server.app.inject({ method: "POST", url: url(taskId), payload: { ...request, ...invalid } })).statusCode,
      ).toBe(400);
    for (const path of ["../outside", "C:/outside", "/absolute", "src/../../escape"])
      await expect(
        createSchedulerExecutionRequest(server.ctx, taskId, { ...request, write_paths: [path] }),
      ).rejects.toThrow("Invalid write path");
    for (const base_version of [request.base_version - 1, request.base_version + 1])
      await expect(createSchedulerExecutionRequest(server.ctx, taskId, { ...request, base_version })).rejects.toThrow(
        "Task version changed",
      );
    await expect(
      createSchedulerExecutionRequest(
        { ...server.ctx, automationActor: { type: "system", id: "goal_runner" } },
        taskId,
        request,
      ),
    ).rejects.toThrow("original-user");
    await server.db.db.update(tasks).set({ sourcePlanId: "dedicated-plan" }).where(eq(tasks.id, taskId));
    await expect(createSchedulerExecutionRequest(server.ctx, taskId, request)).rejects.toThrow("dedicated");
    expect(await server.db.db.select().from(schedulerExecutionRequests)).toEqual([]);
  });

  it("uses request authentication and limits cancellation to the original user or a current administrator", async () => {
    await setup();
    const taskId = await ready(),
      request = await input(taskId);
    const member = await provisionUser(server.ctx, {
      subject: "request-member",
      email: "request-member@example.test",
      emailVerified: true,
      displayName: "Member",
    });
    const other = await provisionUser(server.ctx, {
      subject: "other-member",
      email: "other-member@example.test",
      emailVerified: true,
      displayName: "Other",
    });
    const memberSession = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: member.userId });
    const otherSession = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: other.userId });
    const ownerSession = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: "user_owner" });
    server.ctx.authConfig.enforceApiAuth = true;
    expect((await server.app.inject({ method: "POST", url: url(taskId), payload: request })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url: url(taskId) })).statusCode).toBe(401);
    const response = await server.app.inject({
      method: "POST",
      url: url(taskId),
      headers: { authorization: `Bearer ${memberSession.raw}` },
      payload: request,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request.snapshot.actor_user_id).toBe(member.userId);
    const cancelUrl = `${url(taskId)}/${response.json().request.id}/cancel`;
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: cancelUrl,
          headers: { authorization: `Bearer ${otherSession.raw}` },
          payload: { version: 2 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: cancelUrl,
          headers: { authorization: `Bearer ${memberSession.raw}` },
          payload: { version: 1 },
        })
      ).statusCode,
    ).toBe(400);
    const cancelled = await server.app.inject({
      method: "POST",
      url: cancelUrl,
      headers: { authorization: `Bearer ${ownerSession.raw}` },
      payload: { version: 2 },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      consumer_available: false,
      execution_authorized: false,
      request: { state: "cancelled", cancelledByUserId: "user_owner", actorUserId: member.userId },
    });
    expect(
      (await server.db.db.select().from(eventLog).where(eq(eventLog.type, "scheduler.execution_request.created")))[0]
        ?.actorId,
    ).toBe(member.userId);
  });

  it("requires explicit scoped policies before capturing conditional execution permission", async () => {
    await setup();
    const taskId = await ready();
    await server.db.db.delete(schedulerProjectPolicies).where(eq(schedulerProjectPolicies.projectId, "proj_artoo"));
    await expect(stage(taskId)).rejects.toThrow("Explicit project and Agent scheduling policies are required");
    expect(await server.db.db.select().from(schedulerExecutionRequests)).toEqual([]);
  });

  it("keeps exact original AI consent instead of substituting a later grant", async () => {
    await setup();
    server.ctx.aiDataSharingPolicy = buildAiDataSharingPolicy({
      mode: "external",
      providers: [{ id: "test", name: "Test Provider", privacy_url: "https://example.com/privacy" }],
    });
    await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
    const taskId = await ready(),
      row = await stage(taskId);
    await revokeAiDataSharingConsent(server.ctx);
    await expect(inspect(taskId, row.id)).rejects.toThrow("Review and allow");
    await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
    expect(
      (await server.db.db.select().from(aiDataSharingConsents)).find((grant) => grant.revokedAt === null)?.id,
    ).not.toBe(row.snapshot.ai_sharing.consent_id);
    await expect(inspect(taskId, row.id)).rejects.toThrow("Review and allow");
    await revokeAiDataSharingConsent(server.ctx);
    expect((await cancelSchedulerExecutionRequest(server.ctx, taskId, row.id)).state).toBe("cancelled");
  });

  it("revalidates the original user's active membership under another caller's context", async () => {
    await setup();
    const taskId = await ready(),
      row = await stage(taskId);
    server.ctx.authConfig.allowedEmails = ["different@example.test"];
    await expect(inspect(taskId, row.id, { ...server.ctx, actorUserId: "other" })).rejects.toThrow("active access");
    server.ctx.authConfig.allowedEmails = undefined;
    await server.db.db.insert(memberSuspensions).values({
      organizationId: "org_default",
      userId: "user_owner",
      suspendedAt: server.ctx.clock.nowIso(),
      suspendedByUserId: "user_owner",
      reason: "Controlled request revocation",
    });
    await expect(inspect(taskId, row.id, { ...server.ctx, actorUserId: "other" })).rejects.toThrow("active access");
  });

  it("preserves execution approval and rejects its replacement even after approval", async () => {
    await setup();
    const taskId = await ready();
    const ask = () =>
      server.app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/execution-approval`,
        payload: { summary: "Review before work", risk: "high" },
      });
    const approve = async (id: string) =>
      expect(
        (
          await server.app.inject({
            method: "POST",
            url: `/api/v1/approvals/${id}/resolve`,
            payload: { decision: "approved" },
          })
        ).statusCode,
      ).toBe(200);
    const approval = await ask();
    expect(approval.statusCode).toBe(201);
    await expect(stage(taskId)).rejects.toThrow("Execution approval is required");
    await approve(approval.json().approval.id);
    const row = await stage(taskId),
      replacement = await ask();
    expect(replacement.statusCode).toBe(201);
    await expect(inspect(taskId, row.id)).rejects.toThrow("Execution approval is required");
    await approve(replacement.json().approval.id);
    await expect(inspect(taskId, row.id)).rejects.toThrow("task_input_version changed");
    expect((await server.db.db.select().from(schedulerExecutionRequests))[0]).toEqual(row);
  });

  for (const [resource, policy] of policies)
    it(`rejects equal, changed and restored ${resource} policy revisions`, async () => {
      await setup();
      const taskId = await ready(),
        row = await stage(taskId);
      for (const next of [policy, { ...policy, max_concurrent_runs: 3 }, policy]) {
        expect(
          (await server.app.inject({ method: "PUT", url: `/api/v1/${resource}/scheduling-policy`, payload: next }))
            .statusCode,
        ).toBe(200);
        await expect(inspect(taskId, row.id)).rejects.toThrow("policy_revisions changed");
      }
      expect((await server.db.db.select().from(schedulerExecutionRequests))[0]).toEqual(row);
    });

  for (const target of ["instance", "workspace", "computer", "model", "effort", "project", "pool", "skill"] as const)
    it(`rejects ${target} configuration drift without rewriting the captured snapshot`, async () => {
      await setup();
      const taskId = await ready(),
        row = await stage(taskId);
      switch (target) {
        case "instance":
          await server.db.db
            .update(agentInstances)
            .set({ config: { changed: true } })
            .where(eq(agentInstances.id, "instance_mock_coder"));
          break;
        case "workspace":
          await server.db.db
            .update(agentInstances)
            .set({ workspaceRoot: "changed-workspace" })
            .where(eq(agentInstances.id, "instance_mock_coder"));
          break;
        case "computer":
          await server.db.db
            .update(computers)
            .set({ capabilities: ["code.modify"] })
            .where(eq(computers.id, "computer_local_mock"));
          break;
        case "model":
          await server.db.db.update(modelProfiles).set({ config: { changed: true } });
          break;
        case "effort":
          await server.db.db.update(effortProfiles).set({ config: { changed: true } });
          break;
        case "project":
          await server.db.db
            .update(projects)
            .set({ defaultWorkspace: "changed-project-root" })
            .where(eq(projects.id, "proj_artoo"));
          break;
        case "pool": {
          const [instance] = await server.db.db
            .select()
            .from(agentInstances)
            .where(eq(agentInstances.id, "instance_mock_coder"));
          await server.db.db.insert(agentInstances).values({ ...instance!, id: "extra-instance" });
          break;
        }
        case "skill": {
          const now = server.ctx.clock.nowIso();
          await server.db.db.insert(skillInstalls).values({
            id: "extra-skill",
            organizationId: "org_default",
            projectId: "proj_artoo",
            skillId: "skill.extra",
            name: "Extra",
            version: "1.0.0",
            enabled: true,
            manifest: {},
            capabilities: [],
            compatibleRuntimes: ["mock"],
            permissionSummary: {},
            installedByType: "user",
            installedById: "user_owner",
            installedAt: now,
            updatedAt: now,
          });
          break;
        }
      }
      await expect(inspect(taskId, row.id)).rejects.toThrow("configuration_digest changed");
      expect((await server.db.db.select().from(schedulerExecutionRequests))[0]).toEqual(row);
    });

  it("checks queue and source input changes, including restored values with a newer durable event", async () => {
    await setup();
    const taskId = await ready(true),
      row = await stage(taskId);
    const [comment] = await server.db.db.select().from(messages).where(eq(messages.taskId, taskId));
    expect(comment?.body).toBe("Original input");
    await server.db.db.update(messages).set({ body: "Moderated input" }).where(eq(messages.id, comment!.id));
    await expect(inspect(taskId, row.id)).rejects.toThrow("task_input_digest changed");
    await server.db.db.update(messages).set({ body: comment!.body }).where(eq(messages.id, comment!.id));
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
    await expect(inspect(taskId, row.id)).rejects.toThrow("task_input_version changed");
    await cancelSchedulerExecutionRequest(server.ctx, taskId, row.id);
    const fresh = await stage(taskId, "after-input");
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
    await expect(inspect(taskId, fresh.id)).rejects.toThrow();
  });

  it("keeps history and cancellation scoped and idempotent after consent withdrawal and rollout disablement", async () => {
    await setup();
    const taskId = await ready(),
      request = await input(taskId),
      row = await createSchedulerExecutionRequest(server.ctx, taskId, request);
    const otherTask = await ready();
    await expect(cancelSchedulerExecutionRequest(server.ctx, otherTask, row.id)).rejects.toThrow("not found");
    await expect(inspect(otherTask, row.id)).rejects.toThrow("missing or cancelled");
    await server.db.db
      .insert(organizations)
      .values({ id: "foreign", name: "Foreign", createdAt: server.ctx.clock.nowIso() });
    const foreign = { ...server.ctx, organizationId: "foreign" };
    await expect(createSchedulerExecutionRequest(foreign, taskId, request)).rejects.toThrow();
    await expect(listSchedulerExecutionRequests(foreign, taskId)).rejects.toThrow("not found");
    await expect(cancelSchedulerExecutionRequest(foreign, taskId, row.id)).rejects.toThrow();
    server.ctx.schedulerRollout = undefined;
    const cancelled = await cancelSchedulerExecutionRequest(server.ctx, taskId, row.id);
    expect(await cancelSchedulerExecutionRequest(server.ctx, taskId, row.id)).toEqual(cancelled);
    expect((await server.app.inject({ method: "GET", url: url(taskId) })).json()).toMatchObject({
      requests: [{ id: row.id, state: "cancelled", snapshot: row.snapshot }],
      consumer_available: false,
      execution_authorized: false,
    });
    flags();
    expect(await createSchedulerExecutionRequest(server.ctx, taskId, request)).toEqual(cancelled);
    await expect(inspect(taskId, row.id)).rejects.toThrow("missing or cancelled");
    const next = await stage(taskId, "fresh-after-cancel");
    expect((await inspect(taskId, next.id)).row.id).toBe(next.id);
    expect(
      (await server.db.db.select().from(schedulerExecutionRequests)).find((entry) => entry.id === row.id)?.snapshot,
    ).toEqual(row.snapshot);
    expect(await server.db.db.select().from(runs)).toEqual([]);
  });

  it("rolls request creation and cancellation back with failed audit persistence", async () => {
    await setup();
    const taskId = await ready(),
      request = await input(taskId),
      original = server.ctx.idGen.generate;
    const events = await server.db.db.select().from(eventLog);
    server.ctx.idGen.generate = (prefix) => {
      if (prefix === ID_PREFIXES.event) throw new Error("audit unavailable");
      return original(prefix);
    };
    try {
      await expect(createSchedulerExecutionRequest(server.ctx, taskId, request)).rejects.toThrow("audit unavailable");
    } finally {
      server.ctx.idGen.generate = original;
    }
    expect(await server.db.db.select().from(schedulerExecutionRequests)).toEqual([]);
    expect(await server.db.db.select().from(eventLog)).toEqual(events);
    const row = await stage(taskId);
    server.ctx.idGen.generate = () => {
      throw new Error("audit unavailable");
    };
    try {
      await expect(cancelSchedulerExecutionRequest(server.ctx, taskId, row.id)).rejects.toThrow("audit unavailable");
    } finally {
      server.ctx.idGen.generate = original;
    }
    expect(await server.db.db.select().from(schedulerExecutionRequests)).toEqual([row]);
  });
});
