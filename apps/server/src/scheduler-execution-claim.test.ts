import {
  agentInstances,
  agentRuntimes,
  computers,
  contextPacks,
  devices,
  deviceTokens,
  eventLog,
  fileLeases,
  runs,
  schedulerDecisions,
  schedulerExecutionRequests,
  schedulerPreparedStarts,
  tasks,
} from "@artoo/db";
import { createInProcessChannel } from "@artoo/testkit";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { loadSchedulerRollout, type SchedulerRolloutFlag } from "./config/scheduler-rollout.js";
import { attachNodeBinding } from "./node-binding.js";
import { grantAiDataSharingConsent, revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import { claimSchedulerExecutionRequest } from "./services/lifecycle-service.js";
import {
  cancelSchedulerExecutionRequest,
  createSchedulerExecutionRequest,
} from "./services/scheduler-execution-request-service.js";
import { currentTaskVersion } from "./services/sync-service.js";
import { assertSchedulerPreparedStartUnchanged } from "./services/scheduler-prepared-start-service.js";
import {
  revalidateSchedulerPreparedStart,
  revalidateSchedulerPreparedStartInTransaction,
} from "./services/scheduler-start-revalidation-service.js";
import { scheduleTask } from "./services/scheduler.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const COMPUTER = "computer_local_mock",
  INSTANCE = "ai_claim";
const session = {
  computerId: COMPUTER,
  deviceId: "claim-node",
  tokenLookup: "controlled-fixture-lookup",
  sessionId: "session-one",
};
const switches: SchedulerRolloutFlag[] = [
  "execution_requests",
  "daemon_claim",
  "isolated_workspaces",
  "capacity_admission",
  "unified_enqueue",
];

describe("internal scheduling consumption kernel (real DB, no Provider or node execution)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  function flags(disabled?: SchedulerRolloutFlag) {
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: { org_default: { flags: Object.fromEntries(switches.map((key) => [key, key !== disabled])) } },
      }),
    });
  }
  async function setup() {
    server = await buildTestServer();
    flags();
    await server.db.db.update(computers).set({ os: "linux" }).where(eq(computers.id, COMPUTER));
    // Controlled inventory only: no CLI, credentials, subprocess or Provider is invoked.
    const [seed] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    if (!seed) throw new Error("Missing controlled instance fixture");
    await server.db.db.update(agentInstances).set({ status: "disabled" }).where(eq(agentInstances.id, seed.id));
    await server.db.db.insert(agentInstances).values({
      ...seed,
      id: INSTANCE,
      runtime: "codex",
      workspaceRoot: "/fixture/repository",
      config: {
        concurrency_limit: 2,
        worktree_workspace_base: { version: 1, strategy: "per-run", basePath: "/fixture/attempts" },
      },
    });
    await server.db.db.insert(agentRuntimes).values({
      id: "claim-runtime",
      organizationId: "org_default",
      computerId: COMPUTER,
      runtime: "codex",
      status: "available",
      capabilities: [],
      lastSeenAt: server.ctx.clock.nowIso(),
      metadata: {},
    });
    await server.db.db.insert(devices).values({
      id: session.deviceId,
      organizationId: "org_default",
      displayName: "Controlled paired node",
      platform: "linux",
      appVersion: "fixture",
      computerId: COMPUTER,
      enrolledByUserId: "user_owner",
      trust: "active",
      createdAt: server.ctx.clock.nowIso(),
    });
    await server.db.db.insert(deviceTokens).values({
      id: "claim-token",
      organizationId: "org_default",
      deviceId: session.deviceId,
      kind: "node",
      tokenLookup: session.tokenLookup,
      tokenHash: "fixture-never-authenticated",
      status: "active",
      createdAt: server.ctx.clock.nowIso(),
    });
    server.ctx.getPairedNodeSession = () => ({ ...session });
    server.ctx.supportsExecutionFeature = (_computer, feature) => feature === "workspace-allocation.per-run-v1";
    server.ctx.onRunQueued = vi.fn(async () => {});
    for (const [resource, policy] of [
      ["projects/proj_artoo", { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 }],
      [
        "agents/agent_mock_coder",
        {
          version: 1,
          pinned_computer_id: null,
          required_runtimes: ["codex"],
          required_labels: [],
          max_concurrent_runs: 2,
        },
      ],
      [`computers/${COMPUTER}`, { version: 1, labels: [], max_concurrent_runs: 2 }],
    ] as const)
      expect(
        (await server.app.inject({ method: "PUT", url: `/api/v1/${resource}/scheduling-policy`, payload: policy }))
          .statusCode,
      ).toBe(200);
  }
  async function stage(source = false, approval = false) {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "One conditional execution",
        acceptance_criteria: ["ok"],
        required_capabilities: ["code.modify"],
        ...(source
          ? {
              enqueue_source: {
                version: 1,
                kind: "issue",
                key: "claim-source",
                event_id: "one",
                comment: "Original input",
              },
            }
          : {}),
      },
    });
    expect(response.statusCode).toBe(201);
    const taskId = response.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    if (approval) {
      const gate = await server.app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/execution-approval`,
        payload: { summary: "Approve this execution", risk: "high" },
      });
      expect(gate.statusCode).toBe(201);
      expect(
        (
          await server.app.inject({
            method: "POST",
            url: `/api/v1/approvals/${gate.json().approval.id}/resolve`,
            payload: { decision: "approved" },
          })
        ).statusCode,
      ).toBe(200);
    }
    const request = {
      version: 2 as const,
      permission: "execute_once" as const,
      request_key: "one",
      agent_id: "agent_mock_coder",
      base_version: await currentTaskVersion(server.ctx, taskId),
      branch_backed: true as const,
      write_paths: [`src/${taskId}.ts`],
    };
    const row = await createSchedulerExecutionRequest(server.ctx, taskId, request);
    return { taskId, requestId: row.id, computerId: COMPUTER, sessionId: session.sessionId };
  }
  const claim = (input: Awaited<ReturnType<typeof stage>>) =>
    claimSchedulerExecutionRequest(
      {
        ...server.ctx,
        actorUserId: "daemon-is-not-the-user",
        automationActor: { type: "system", id: "goal_runner" },
      },
      input,
    );
  async function snapshot() {
    return {
      tasks: await server.db.db.select().from(tasks),
      runs: await server.db.db.select().from(runs),
      packs: await server.db.db.select().from(contextPacks),
      decisions: await server.db.db.select().from(schedulerDecisions),
      requests: await server.db.db.select().from(schedulerExecutionRequests),
      prepared: await server.db.db.select().from(schedulerPreparedStarts),
      leases: await server.db.db.select().from(fileLeases),
      events: await server.db.db.select().from(eventLog),
    };
  }
  async function unchanged(input: Awaited<ReturnType<typeof stage>>, message?: string) {
    const before = await snapshot();
    await expect(claim(input)).rejects.toThrow(message);
    expect(await snapshot()).toEqual(before);
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  }

  it("atomically binds one original-user Run, audit, context and leases; response replay creates and dispatches nothing", async () => {
    await setup();
    const input = await stage(true),
      result = await claim(input);
    expect(result.run).toMatchObject({
      task_id: input.taskId,
      status: "queued",
      agent_instance_id: INSTANCE,
      workspace_allocation: { version: 1, strategy: "per-run", base_path: "/fixture/attempts" },
    });
    expect(result.run.workspace_branch).toBe(`artoo/run-${result.run.id}`);
    const [row] = await server.db.db.select().from(schedulerExecutionRequests);
    expect(row).toMatchObject({
      state: "consumed",
      consumedRunId: result.run.id,
      consumedDeviceId: session.deviceId,
      consumedSessionId: session.sessionId,
    });
    const before = await snapshot();
    expect(before.runs).toHaveLength(1);
    expect(before.runs[0]!.requestedByUserId).toBe("user_owner");
    expect(before.packs).toHaveLength(1);
    expect(before.decisions).toHaveLength(1);
    expect(before.leases).toHaveLength(1);
    expect(before.prepared).toHaveLength(1);
    const prepared = before.prepared[0]!.snapshot;
    expect(prepared).toMatchObject({
      version: 1,
      request_id: row!.id,
      request_snapshot_digest: row!.snapshotDigest,
      run_id: result.run.id,
      actor_user_id: "user_owner",
      device_id: session.deviceId,
      session_id: session.sessionId,
      execution_authorized: false,
    });
    expect(prepared.assigned.task_input_digest).not.toBe(row!.snapshot.task_input_digest);
    expect(prepared.assigned.task_input_version).toBeGreaterThan(row!.snapshot.task_input_version);
    expect(await assertSchedulerPreparedStartUnchanged(server.ctx, server.db.db, input.requestId)).toEqual(prepared);
    expect(before.packs[0]!.payload).toMatchObject({ source_inputs: { entries: [{ body: "Original input" }] } });
    expect(before.events.find((event) => event.type === "scheduler.execution_request.consumed")).toMatchObject({
      actorType: "system",
      actorId: "scheduler",
      payload: {
        actor_user_id: "user_owner",
        request_id: row!.id,
        ranking_snapshot: { manual_agent_instance_id: null },
      },
    });
    expect(await claim(input)).toEqual(result);
    expect(await snapshot()).toEqual(before);
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
    await expect(cancelSchedulerExecutionRequest(server.ctx, input.taskId, input.requestId)).rejects.toThrow(
      "was consumed",
    );
    const channel = createInProcessChannel(),
      send = vi.spyOn(channel.serverTransport, "send");
    const binding = attachNodeBinding(server.ctx, channel.serverTransport, COMPUTER, [
      "workspace-allocation.per-run-v1",
    ]);
    try {
      await expect(binding.dispatchRunStart(result.run.id)).rejects.toThrow("node-owned attempt protocol");
      expect(send).not.toHaveBeenCalled();
    } finally {
      binding.close();
    }
    // SQL history is immutable, including after process/Task lifecycle changes.
    for (const update of [
      sql`state='pending',consumed_run_id=NULL,consumed_device_id=NULL,consumed_session_id=NULL,consumed_at=NULL`,
      sql`consumed_session_id='replacement'`,
      sql`consumed_at=now()`,
    ])
      await expect(server.db.db.execute(sql`UPDATE scheduler_execution_requests SET ${update}`)).rejects.toThrow();
    await expect(server.db.db.execute(sql`DELETE FROM scheduler_execution_requests`)).rejects.toThrow();
  });

  it("requires every startup scope, paired credential, current session, inventory and real isolated allocation", async () => {
    await setup();
    const input = await stage();
    for (const flag of ["daemon_claim", "capacity_admission", "isolated_workspaces", "execution_requests"] as const) {
      flags(flag);
      await unchanged(input, "disabled");
    }
    flags();
    const getSession = server.ctx.getPairedNodeSession;
    server.ctx.getPairedNodeSession = () => undefined;
    await unchanged(input, "paired node session");
    server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: "replaced" });
    await unchanged(input, "paired node session");
    server.ctx.getPairedNodeSession = getSession;
    server.ctx.supportsExecutionFeature = () => false;
    await unchanged(input, "allocation session");
    server.ctx.supportsExecutionFeature = () => true;
    await server.db.db.update(deviceTokens).set({ expiresAt: server.ctx.clock.nowIso() });
    await unchanged(input, "credential");
    await server.db.db.update(deviceTokens).set({ expiresAt: null, status: "revoked" });
    await unchanged(input, "credential");
    await server.db.db.update(deviceTokens).set({ status: "active" });
    await server.db.db.update(agentRuntimes).set({ status: "missing" });
    await unchanged(input, "eligible");
    await server.db.db.update(agentRuntimes).set({ status: "available" });
    // Changing even a benign configuration invalidates the original request.
    await server.db.db.update(agentInstances).set({ config: {} }).where(eq(agentInstances.id, INSTANCE));
    await unchanged(input, "configuration_digest");
  });

  it("rejects branch-only requests without per-run isolation and preserves all pre-claim state", async () => {
    await setup();
    await server.db.db.update(agentInstances).set({ config: {} }).where(eq(agentInstances.id, INSTANCE));
    const input = await stage();
    await unchanged(input, "exact isolated Run");
    // A DB caller cannot mark consumption without a real matching Run either.
    await expect(
      server.db.db.execute(sql`UPDATE scheduler_execution_requests SET state='consumed', consumed_session_id='one'`),
    ).rejects.toThrow();
  });

  it("rolls back Run, assignment, decision, context and leases if consumption audit fails", async () => {
    await setup();
    const input = await stage();
    await server.db.db.execute(sql`CREATE FUNCTION reject_claim_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type='scheduler.execution_request.consumed' THEN RAISE EXCEPTION 'injected claim audit failure'; END IF; RETURN NEW; END $$`);
    await server.db.db.execute(
      sql`CREATE TRIGGER reject_claim_audit BEFORE INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION reject_claim_audit()`,
    );
    await unchanged(input);
    await server.db.db.execute(sql`DROP TRIGGER reject_claim_audit ON event_log`);
    expect((await claim(input)).run.status).toBe("queued");
  });

  it("keeps bound approvals and detects drift in the actual assigned Task, frozen context, Run, decision, leases and configuration", async () => {
    await setup();
    const input = await stage(true, true);
    const result = await claim(input);
    const [stored] = await server.db.db.select().from(schedulerPreparedStarts);
    const compare = (tx: Parameters<typeof assertSchedulerPreparedStartUnchanged>[1]) =>
      assertSchedulerPreparedStartUnchanged(server.ctx, tx, input.requestId);
    expect(await compare(server.db.db)).toEqual(stored!.snapshot);
    const before = await snapshot();
    for (const change of [
      sql`UPDATE tasks SET title='Changed after assignment' WHERE id=${input.taskId}`,
      sql`UPDATE approvals SET summary='Changed approval' WHERE task_id=${input.taskId}`,
      sql`UPDATE context_packs SET payload=payload || '{"changed":true}'::jsonb WHERE id=${result.run.context_pack_id}`,
      sql`UPDATE runs SET workspace_branch='changed' WHERE id=${result.run.id}`,
      sql`UPDATE scheduler_decisions SET reason='changed' WHERE id=${result.scheduler_decision.id}`,
      sql`UPDATE file_leases SET status='released' WHERE run_id=${result.run.id}`,
      sql`UPDATE agent_instances SET config=config || '{"changed":true}'::jsonb WHERE id=${INSTANCE}`,
      sql`UPDATE scheduler_project_policies SET revision=revision+1 WHERE project_id='proj_artoo'`,
    ]) {
      const rollback = new Error("rollback controlled drift");
      await expect(
        server.db.db.transaction(async (tx) => {
          await tx.execute(change);
          await expect(compare(tx)).rejects.toThrow("inputs changed");
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await snapshot()).toEqual(before);
      expect(await compare(server.db.db)).toEqual(stored!.snapshot);
    }
    for (const change of [
      sql`UPDATE scheduler_prepared_starts SET snapshot_digest=${`sha256:${"a".repeat(64)}`}`,
      sql`UPDATE scheduler_prepared_starts SET created_at=now()`,
      sql`DELETE FROM scheduler_prepared_starts`,
    ])
      await expect(server.db.db.execute(change)).rejects.toMatchObject({
        cause: { code: "P0001", message: "Prepared scheduling start history is immutable" },
      });
    const lateInput = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "One conditional execution",
        acceptance_criteria: ["ok"],
        required_capabilities: ["code.modify"],
        enqueue_source: {
          version: 1,
          kind: "issue",
          key: "claim-source",
          event_id: "two",
          comment: "New input after preparation",
        },
      },
    });
    expect(lateInput.statusCode).toBe(201);
    expect(lateInput.json().task.id).toBe(input.taskId);
    await expect(compare(server.db.db)).rejects.toThrow("inputs changed");
    expect(await server.db.db.select().from(schedulerPreparedStarts)).toEqual([stored]);
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  });

  it("rolls back the complete consumption when immutable prepared-start recording fails", async () => {
    await setup();
    const input = await stage();
    await server.db.db.execute(sql`CREATE FUNCTION reject_prepared_start() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected prepared-start failure'; END $$`);
    await server.db.db.execute(sql`CREATE TRIGGER reject_prepared_start BEFORE INSERT ON scheduler_prepared_starts
      FOR EACH ROW EXECUTE FUNCTION reject_prepared_start()`);
    await unchanged(input);
    await server.db.db.execute(sql`DROP TRIGGER reject_prepared_start ON scheduler_prepared_starts`);
    await claim(input);
    expect(await server.db.db.select().from(schedulerPreparedStarts)).toHaveLength(1);
  });

  it("rolls back if the paired session changes while preparing the Run and never transfers a consumed claim", async () => {
    await setup();
    const input = await stage();
    const generate = server.ctx.idGen.generate.bind(server.ctx.idGen);
    let replaced = false;
    server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: replaced ? "new-session" : session.sessionId });
    server.ctx.idGen.generate = (prefix) => {
      if (prefix === "run") replaced = true;
      return generate(prefix);
    };
    await unchanged(input, "original paired allocation session");
    server.ctx.idGen.generate = generate;
    server.ctx.getPairedNodeSession = () => ({ ...session });
    const result = await claim(input);
    server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: "new-session" });
    await unchanged({ ...input, sessionId: "new-session" }, "cannot move");
    expect((await server.db.db.select().from(runs))[0]!.id).toBe(result.run.id);
  });

  it("rejects a credential that reaches its expiry while the claim is preparing, without consuming permission or resources", async () => {
    await setup();
    const input = await stage();
    let time = Date.parse(server.ctx.clock.nowIso());
    const expires = time + 1000;
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    await server.db.db.update(deviceTokens).set({ expiresAt: new Date(expires).toISOString() });
    const generate = server.ctx.idGen.generate.bind(server.ctx.idGen);
    server.ctx.idGen.generate = (prefix) => {
      if (prefix === "run") time = expires;
      return generate(prefix);
    };
    await unchanged(input, "credential");
    expect(await server.db.db.select().from(schedulerPreparedStarts)).toHaveLength(0);
    server.ctx.idGen.generate = generate;
    await server.db.db.update(deviceTokens).set({ expiresAt: new Date(expires + 1000).toISOString() });
    expect((await claim(input)).run.status).toBe("queued");
  });

  it("retains exact consent, original-user access, cancellation and instance capacity gates", async () => {
    await setup();
    server.ctx.aiDataSharingPolicy = buildAiDataSharingPolicy({
      mode: "external",
      providers: [{ id: "fixture", name: "Fixture", privacy_url: "https://example.com/privacy" }],
    });
    await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
    const input = await stage();
    await revokeAiDataSharingConsent(server.ctx);
    await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
    await unchanged(input, "Review and allow");
    await cancelSchedulerExecutionRequest(server.ctx, input.taskId, input.requestId);
    await unchanged(input, "cancelled");
    const fresh = await stage();
    const auth = server.ctx.authConfig;
    server.ctx.authConfig = { ...auth, allowedEmails: ["another@example.com"] };
    await unchanged(fresh, "active access");
    server.ctx.authConfig = auth;
    await claim(fresh);
    const second = await stage();
    await claim(second);
    const third = await stage();
    await unchanged(third, "eligible");
    expect(
      await server.db.db
        .select()
        .from(schedulerExecutionRequests)
        .where(
          and(eq(schedulerExecutionRequests.id, third.requestId), eq(schedulerExecutionRequests.state, "pending")),
        ),
    ).toHaveLength(1);
  });

  it("enforces each shared project, Agent and computer quota below the instance limit", async () => {
    await setup();
    const [instance] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, INSTANCE));
    await server.db.db
      .update(agentInstances)
      .set({ config: { ...(instance!.config as Record<string, unknown>), concurrency_limit: 4 } })
      .where(eq(agentInstances.id, INSTANCE));
    const policies = [
      ["projects/proj_artoo", { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 4 }],
      [
        "agents/agent_mock_coder",
        {
          version: 1,
          pinned_computer_id: null,
          required_runtimes: ["codex"],
          required_labels: [],
          max_concurrent_runs: 4,
        },
      ],
      [`computers/${COMPUTER}`, { version: 1, labels: [], max_concurrent_runs: 4 }],
    ] as const;
    const put = async (resource: string, policy: object) =>
      expect(
        (
          await server.app.inject({
            method: "PUT",
            url: `/api/v1/${resource}/scheduling-policy`,
            payload: policy,
          })
        ).statusCode,
      ).toBe(200);
    for (const [resource, policy] of policies) await put(resource, policy);
    await claim(await stage());
    for (const [resource, policy] of policies) {
      await put(resource, { ...policy, max_concurrent_runs: 1 });
      await unchanged(await stage(), "no selected eligible");
      await put(resource, policy);
    }
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
  });

  it("revalidates an exact single-slot prepared reservation without freeing capacity or granting another execution", async () => {
    await setup();
    const [instance] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, INSTANCE));
    await server.db.db
      .update(agentInstances)
      .set({
        config: {
          ...(instance!.config as Record<string, unknown>),
          concurrency_limit: 1,
        },
      })
      .where(eq(agentInstances.id, INSTANCE));
    for (const table of ["scheduler_project_policies", "scheduler_agent_policies", "scheduler_computer_policies"])
      await server.db.db.execute(
        sql.raw(`UPDATE ${table} SET policy=jsonb_set(policy,'{max_concurrent_runs}','1'::jsonb)`),
      );
    const input = await stage(true, true);
    const pending = await snapshot();
    await expect(revalidateSchedulerPreparedStart(server.ctx, input)).rejects.toThrow("already consumed");
    expect(await snapshot()).toEqual(pending);
    const result = await claim(input);
    const before = await snapshot();
    await expect(revalidateSchedulerPreparedStartInTransaction(server.ctx, server.db.db, input)).rejects.toThrow(
      "transaction",
    );
    await expect(
      server.db.db.transaction((tx) => revalidateSchedulerPreparedStartInTransaction(server.ctx, tx, input), {
        isolationLevel: "repeatable read",
      }),
    ).rejects.toThrow("read committed");
    const ordinary = () =>
      scheduleTask(server.db.db, server.ctx, ["code.modify"], {
        mode: "manual",
        projectId: "proj_artoo",
        branchBacked: true,
        agentInstanceId: INSTANCE,
      });
    await expect(ordinary()).rejects.toThrow("eligible");
    for (let count = 0; count < 2; count++) {
      expect(await revalidateSchedulerPreparedStart(server.ctx, input)).toMatchObject({
        version: 1,
        request_id: input.requestId,
        run_id: result.run.id,
        agent_instance_id: INSTANCE,
        computer_id: COMPUTER,
        execution_authorized: false,
      });
      expect(await snapshot()).toEqual(before);
    }
    await expect(ordinary()).rejects.toThrow("eligible");
    // Controlled overcommit injects another actual queued reservation. Neither
    // per-instance eligibility nor any of the three quotas may subtract it.
    await server.db.db.insert(runs).values({ ...before.runs[0]!, id: "run_other_reservation" });
    const occupied = await snapshot();
    await expect(revalidateSchedulerPreparedStart(server.ctx, input)).rejects.toThrow("eligible");
    expect(await snapshot()).toEqual(occupied);
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  });

  it("rechecks prepared-start scopes, original access, current session, credential and runtime facts without writes", async () => {
    await setup();
    const input = await stage();
    await claim(input);
    const unchangedRevalidation = async (message: string) => {
      const before = await snapshot();
      await expect(revalidateSchedulerPreparedStart(server.ctx, input)).rejects.toThrow(message);
      expect(await snapshot()).toEqual(before);
    };
    for (const flag of ["daemon_claim", "capacity_admission", "isolated_workspaces", "execution_requests"] as const) {
      flags(flag);
      await unchangedRevalidation("disabled");
    }
    flags();
    const auth = server.ctx.authConfig;
    server.ctx.authConfig = { ...auth, allowedEmails: ["another@example.com"] };
    await unchangedRevalidation("active access");
    server.ctx.authConfig = auth;
    server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: "replaced" });
    await unchangedRevalidation("paired node session");
    server.ctx.getPairedNodeSession = () => ({ ...session });
    for (const [change, restore, message] of [
      [
        sql`UPDATE device_tokens SET expires_at=${server.ctx.clock.nowIso()}`,
        sql`UPDATE device_tokens SET expires_at=NULL`,
        "credential",
      ],
      [sql`UPDATE agent_runtimes SET status='missing'`, sql`UPDATE agent_runtimes SET status='available'`, "eligible"],
      [
        sql`UPDATE agent_instances SET status='disabled' WHERE id=${INSTANCE}`,
        sql`UPDATE agent_instances SET status='idle' WHERE id=${INSTANCE}`,
        "eligible",
      ],
      [
        sql`UPDATE computers SET status='offline' WHERE id=${COMPUTER}`,
        sql`UPDATE computers SET status='online' WHERE id=${COMPUTER}`,
        "online",
      ],
      [
        sql`UPDATE tasks SET title='Changed input' WHERE id=${input.taskId}`,
        sql`UPDATE tasks SET title='One conditional execution' WHERE id=${input.taskId}`,
        "inputs changed",
      ],
    ] as const) {
      await server.db.db.execute(change);
      await unchangedRevalidation(message);
      await server.db.db.execute(restore);
      expect((await revalidateSchedulerPreparedStart(server.ctx, input)).execution_authorized).toBe(false);
    }
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  });

  it.each(["project", "agent", "computer"] as const)(
    "keeps every other reservation in the prepared-start %s quota",
    async (kind) => {
      await setup();
      const table = {
        project: "scheduler_project_policies",
        agent: "scheduler_agent_policies",
        computer: "scheduler_computer_policies",
      }[kind];
      await server.db.db.execute(
        sql.raw(`UPDATE ${table} SET policy=jsonb_set(policy,'{max_concurrent_runs}','1'::jsonb)`),
      );
      const input = await stage();
      await claim(input);
      expect((await revalidateSchedulerPreparedStart(server.ctx, input)).execution_authorized).toBe(false);
      const [original] = await server.db.db.select().from(runs);
      await server.db.db.insert(runs).values({ ...original!, id: "run_other_reservation" });
      const before = await snapshot();
      await expect(revalidateSchedulerPreparedStart(server.ctx, input)).rejects.toThrow("scheduling policy");
      expect(await snapshot()).toEqual(before);
      expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
    },
  );

  it("requires the original exact consent again for a consumed prepared Run", async () => {
    await setup();
    server.ctx.aiDataSharingPolicy = buildAiDataSharingPolicy({
      mode: "external",
      providers: [{ id: "fixture", name: "Fixture", privacy_url: "https://example.com/privacy" }],
    });
    await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
    const input = await stage();
    await claim(input);
    expect((await revalidateSchedulerPreparedStart(server.ctx, input)).execution_authorized).toBe(false);
    await revokeAiDataSharingConsent(server.ctx);
    for (const consent of ["withdrawn", "replaced"]) {
      if (consent === "replaced") await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
      const before = await snapshot();
      await expect(revalidateSchedulerPreparedStart(server.ctx, input)).rejects.toThrow("Review and allow");
      expect(await snapshot()).toEqual(before);
    }
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  });
});
