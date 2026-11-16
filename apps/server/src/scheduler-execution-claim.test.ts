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
  runEventIngest,
  schedulerDecisions,
  schedulerExecutionRequests,
  schedulerPreparedStarts,
  schedulerStartGrants,
  schedulerExecutionLeases,
  schedulerAttemptCredentials,
  schedulerRunCredentials,
  schedulerRunStopIntents,
  tasks,
} from "@artoo/db";
import { createInProcessChannel } from "@artoo/testkit";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { loadSchedulerRollout, type SchedulerRolloutFlag } from "./config/scheduler-rollout.js";
import { attachNodeBinding } from "./node-binding.js";
import { auditDigestV1 } from "./audit-signature.js";
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
  withRevalidatedSchedulerPreparedStart,
} from "./services/scheduler-start-revalidation-service.js";
import {
  prepareSchedulerStartProposal,
  prepareSchedulerStartProposalInTransaction,
} from "./services/scheduler-start-proposal-service.js";
import { scheduleTask } from "./services/scheduler.js";
import { grantSchedulerStart, grantSchedulerStartInTransaction } from "./services/scheduler-start-grant-service.js";
import {
  closeSchedulerExecutionLease,
  renewSchedulerExecutionLease,
} from "./services/scheduler-execution-lease-service.js";
import {
  acquireSchedulerAttemptCredential,
  renewSchedulerAttemptCredential,
} from "./services/scheduler-attempt-credential-service.js";
import { randomUUID } from "node:crypto";
import { createManagedWebSocketTransport } from "@artoo/artood";
import { generateDeviceToken } from "./services/device-credential.js";
import * as proposalService from "./services/scheduler-start-proposal-service.js";
import * as grantService from "./services/scheduler-start-grant-service.js";
import * as attemptService from "./services/scheduler-attempt-credential-service.js";
import {
  cancelRun,
  failRunStart,
  failRunDaemonDisconnect,
  ingestRunEvent,
  ingestWireRunEvent,
  ingestSchedulerWireRunEvent,
} from "./services/run-service.js";
import {
  acquireSchedulerRunCredential,
  requestSchedulerRunStop,
  schedulerRunStatus,
} from "./services/scheduler-run-service.js";
import { getProjectControlView } from "./services/control-view-service.js";
import { buildTestServer, type TestServer, type BuildTestServerOptions } from "./test-support.js";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMPUTER = "computer_local_mock",
  INSTANCE = "ai_claim";
const session = {
  computerId: COMPUTER,
  deviceId: "claim-node",
  tokenLookup: "controlled-fixture-lookup",
  sessionId: randomUUID() as string,
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
  const links: ReturnType<typeof createManagedWebSocketTransport>[] = [];
  const artifactDirectories: string[] = [];
  afterEach(async () => {
    for (const link of links.splice(0)) await link.close();
    await server?.close();
    // These wire cases write no blobs. An unexpected nonempty directory is retained.
    for (const directory of artifactDirectories.splice(0)) await rmdir(directory);
    vi.restoreAllMocks();
  });
  function flags(disabled?: SchedulerRolloutFlag, attemptCredentials = false) {
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_default: {
            flags: Object.fromEntries(
              [...switches, ...(attemptCredentials ? ["attempt_credentials"] : [])].map((key) => [
                key,
                key !== disabled,
              ]),
            ),
          },
        },
      }),
    });
  }
  async function setup(options?: BuildTestServerOptions) {
    server = await buildTestServer(options);
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
  async function waitFor(predicate: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Controlled scheduler socket did not reach its expected state");
  }
  async function liveChannel(withLease = false) {
    const artifactDir = await mkdtemp(join(tmpdir(), "artoo-scheduler-wire-"));
    artifactDirectories.push(artifactDir);
    await setup({ artifactDir });
    if (withLease) flags(undefined, true);
    const token = generateDeviceToken();
    await server.db.db
      .update(deviceTokens)
      .set({ tokenLookup: token.lookup, tokenHash: token.secretHash })
      .where(eq(deviceTokens.id, "claim-token"));
    // Restore the production registry resolvers instead of setup's internal-kernel fixtures.
    server.ctx.getPairedNodeSession = (id) => server.nodeRegistry.get(id)?.getPairedNodeSession?.();
    server.ctx.supportsExecutionFeature = (id, feature) =>
      server.nodeRegistry.get(id)?.supportsExecutionFeature(feature) ?? false;
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    const namespace = randomUUID();
    const connect = async () => {
      const link = createManagedWebSocketTransport({
        url: `${address.replace(/^http/, "ws")}/api/v1/node?token=${token.raw}`,
        hello: {
          kind: "node.hello",
          node_id: COMPUTER,
          protocol_version: "2026-06-11",
          artood_version: "controlled-fixture",
          machine: { hostname: "controlled-fixture", os: "linux", arch: "x64" },
          execution_features: ["workspace-allocation.per-run-v1"],
        },
        namespace,
        schedulerStart: true,
        ...(withLease ? { schedulerLease: true as const } : {}),
      });
      links.push(link);
      link.start();
      await link.ready;
      await waitFor(() => server.ctx.getPairedNodeSession?.(COMPUTER)?.sessionId === link.currentSession?.sessionId);
      return link;
    };
    const link = await connect(),
      input = { ...(await stage()), sessionId: link.currentSession!.sessionId };
    await claim(input);
    return { link, input, connect };
  }
  async function snapshot() {
    return {
      tasks: await server.db.db.select().from(tasks),
      runs: await server.db.db.select().from(runs),
      packs: await server.db.db.select().from(contextPacks),
      decisions: await server.db.db.select().from(schedulerDecisions),
      requests: await server.db.db.select().from(schedulerExecutionRequests),
      prepared: await server.db.db.select().from(schedulerPreparedStarts),
      grants: await server.db.db.select().from(schedulerStartGrants),
      executionLeases: await server.db.db.select().from(schedulerExecutionLeases),
      attemptCredentials: await server.db.db.select().from(schedulerAttemptCredentials),
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

  it("builds one complete immutable proposal from current fenced evidence without writes or dispatch", async () => {
    await setup();
    const input = await stage(true, true);
    await expect(prepareSchedulerStartProposal(server.ctx, input)).rejects.toThrow("already consumed");
    const claimed = await claim(input),
      before = await snapshot();
    const result = await prepareSchedulerStartProposal(server.ctx, input);
    expect(result.execution_authorized).toBe(false);
    expect(result.proposal.prepared_start).toEqual(before.prepared[0]!.snapshot);
    expect(result.proposal.run_start).toEqual({
      run_id: claimed.run.id,
      task_id: input.taskId,
      agent_instance_id: INSTANCE,
      runtime: "codex",
      workspace: { root: claimed.run.workspace_root, branch: claimed.run.workspace_branch },
      workspace_allocation: claimed.run.workspace_allocation,
      workspace_retention_reporting: "typed-v1",
      context_pack: {
        id: claimed.run.context_pack_id,
        payload: before.packs.find((pack) => pack.id === claimed.run.context_pack_id)!.payload,
      },
      policy_snapshot: {
        filesystem_write_scope: [claimed.run.workspace_root],
        requires_approval: ["git.push", "external.post"],
      },
      artifact_rules: { paths: ["artifacts/**", "*.patch"] },
    });
    expect(result.proposal_digest).toBe(auditDigestV1({ kind: "scheduler-start-proposal.v1", ...result.proposal }));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.proposal.run_start.context_pack.payload!.task)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(session.tokenLookup);
    expect(result).not.toHaveProperty("permit");
    expect(await prepareSchedulerStartProposal(server.ctx, input)).toEqual(result);
    expect(await snapshot()).toEqual(before);
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
    await expect(prepareSchedulerStartProposalInTransaction(server.ctx, server.db.db, input)).rejects.toThrow(
      "transaction",
    );
    await expect(
      server.db.db.transaction((tx) => prepareSchedulerStartProposalInTransaction(server.ctx, tx, input), {
        isolationLevel: "repeatable read",
      }),
    ).rejects.toThrow("read committed");
    flags("daemon_claim");
    await expect(prepareSchedulerStartProposal(server.ctx, input)).rejects.toThrow("disabled");
    expect(await snapshot()).toEqual(before);
  });

  it.each(["expiry", "session", "capability"] as const)(
    "rechecks %s after awaited fenced completion and rolls back callback writes",
    async (changed) => {
      await setup();
      const input = await stage();
      await claim(input);
      let time = Date.parse(server.ctx.clock.nowIso());
      const expires = time + 1000;
      server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
      await server.db.db.update(deviceTokens).set({ expiresAt: new Date(expires).toISOString() });
      const before = await snapshot(),
        completed = vi.fn();
      await expect(
        server.db.db.transaction(
          (tx) =>
            withRevalidatedSchedulerPreparedStart(server.ctx, tx, input, async (prepared) => {
              expect(prepared.run_id).toBe(before.runs[0]!.id);
              await tx
                .update(tasks)
                .set({ title: "A callback write that must roll back" })
                .where(eq(tasks.id, input.taskId));
              if (changed === "expiry") time = expires;
              else if (changed === "session")
                server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: "replacement" });
              else server.ctx.supportsExecutionFeature = () => false;
              completed();
              return "not returned as authority";
            }),
          { isolationLevel: "read committed" },
        ),
      ).rejects.toThrow(changed === "expiry" ? "credential" : "allocation session");
      expect(completed).toHaveBeenCalledOnce();
      expect(await snapshot()).toEqual(before);
      expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
    },
  );

  it("propagates a fenced completion failure and rolls its writes back", async () => {
    await setup();
    const input = await stage();
    await claim(input);
    const before = await snapshot(),
      failure = new Error("controlled proposal read failure");
    await expect(
      server.db.db.transaction(
        (tx) =>
          withRevalidatedSchedulerPreparedStart(server.ctx, tx, input, async () => {
            await tx.update(tasks).set({ title: "Not committed" }).where(eq(tasks.id, input.taskId));
            throw failure;
          }),
        { isolationLevel: "read committed" },
      ),
    ).rejects.toBe(failure);
    expect(await snapshot()).toEqual(before);
  });

  async function readyStart() {
    await setup();
    const input = await stage(true, true);
    await claim(input);
    const proposal = await prepareSchedulerStartProposal(server.ctx, input);
    return {
      input,
      ready: {
        version: 1 as const,
        request_id: input.requestId,
        run_id: proposal.proposal.prepared_start.run_id,
        proposal_digest: proposal.proposal_digest,
        journal_namespace: randomUUID(),
        node_attempt_id: randomUUID(),
        ready_id: randomUUID(),
      },
    };
  }

  it("persists one bounded grant and returns the same authorization on response loss without extending its deadline", async () => {
    const { input, ready } = await readyStart();
    let time = Date.parse(server.ctx.clock.nowIso());
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    const before = await snapshot();
    const first = await grantSchedulerStart(server.ctx, input, ready);
    expect(first.remaining_ms).toBe(5000);
    expect(first.grant).toMatchObject({
      ...ready,
      actor_user_id: "user_owner",
      device_id: session.deviceId,
      computer_id: COMPUTER,
      session_id: session.sessionId,
      scope: "scheduler-start.once.v1",
    });
    expect(Date.parse(first.grant.expires_at) - Date.parse(first.grant.issued_at)).toBe(5000);
    expect(Object.isFrozen(first.grant)).toBe(true);
    expect(JSON.stringify(first)).not.toContain(session.tokenLookup);
    const saved = await snapshot();
    expect(saved.grants).toHaveLength(1);
    expect(saved.events.filter((event) => event.type === "scheduler.start_grant.created")).toHaveLength(1);
    expect(saved.executionLeases).toHaveLength(1);
    expect(saved.executionLeases[0]).toMatchObject({
      state: "active",
      epoch: 1,
      binding: {
        run_id: first.grant.run_id,
        request_id: input.requestId,
        grant_id: first.grant.grant_id,
        journal_namespace: ready.journal_namespace,
        node_attempt_id: ready.node_attempt_id,
      },
    });
    expect(Date.parse(saved.executionLeases[0]!.expiresAt) - Date.parse(saved.executionLeases[0]!.claimedAt)).toBe(
      30_000,
    );
    const { grants: _newGrants, executionLeases: _newLeases, events: _newEvents, ...other } = saved;
    const { grants: _oldGrants, executionLeases: _oldLeases, events: _oldEvents, ...oldOther } = before;
    expect(other).toEqual(oldOther);
    expect(await prepareSchedulerStartProposal(server.ctx, input)).toMatchObject({
      proposal_digest: ready.proposal_digest,
    });
    time += 1234;
    // A replacement server context represents no in-memory authorization cache.
    expect(await grantSchedulerStart({ ...server.ctx }, input, ready)).toEqual({ ...first, remaining_ms: 3766 });
    expect(await snapshot()).toEqual(saved);
    time += 3766;
    await expect(grantSchedulerStart(server.ctx, input, ready)).rejects.toThrow("expired");
    expect(await snapshot()).toEqual(saved);
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  });

  it("renews exact logical ownership after start-grant expiry without changing Run or physical reservations", async () => {
    const { input, ready } = await readyStart();
    let time = Date.parse(server.ctx.clock.nowIso());
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    await grantSchedulerStart(server.ctx, input, ready);
    time += 6000;
    await expect(grantSchedulerStart(server.ctx, input, ready)).rejects.toThrow("expired");
    // Controlled lifecycle rows only; this suite creates no physical process.
    await server.db.db
      .update(runs)
      .set({ status: "running", startedAt: server.ctx.clock.nowIso() })
      .where(eq(runs.id, ready.run_id));
    await server.db.db.update(tasks).set({ status: "running" }).where(eq(tasks.id, input.taskId));
    const before = await snapshot(),
      binding = before.executionLeases[0]!.binding;
    const renewed = await renewSchedulerExecutionLease(
      { ...server.ctx, actorUserId: "paired-node-is-not-the-user" },
      input,
      binding,
    );
    expect(renewed).toMatchObject({ state: "active", binding, closed_at: null });
    expect(renewed.expires_at).toBe(new Date(time + 30_000).toISOString().replace("Z", "000Z"));
    const { executionLeases: _old, events: _oldEvents, ...oldOther } = before;
    const after = await snapshot();
    const { executionLeases: _new, events: _newEvents, ...newOther } = after;
    expect(newOther).toEqual(oldOther);
    expect(after.events.filter((event) => event.type === "scheduler.execution_lease.renewed")).toHaveLength(1);
    await expect(grantSchedulerStart(server.ctx, input, ready)).rejects.toThrow("original queued assignment");
    expect(await snapshot()).toEqual(after);
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  });

  it("rejects every changed lease identity, original-session transfer and expired credential without writes", async () => {
    const { input, ready } = await readyStart();
    const time = Date.parse(server.ctx.clock.nowIso());
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    await grantSchedulerStart(server.ctx, input, ready);
    const before = await snapshot(),
      binding = before.executionLeases[0]!.binding;
    for (const [key, value] of Object.entries(binding)) {
      const replacement =
        key === "version"
          ? 2
          : key === "epoch"
            ? 2
            : typeof value === "string" && /^[a-f\d]{8}-/.test(value)
              ? randomUUID()
              : "different";
      await expect(
        renewSchedulerExecutionLease(server.ctx, input, { ...binding, [key]: replacement }),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    }
    for (const disabled of switches) {
      flags(disabled);
      // unified_enqueue controls new Task insertion, not an already consumed lease.
      if (disabled === "unified_enqueue") continue;
      await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow("disabled");
      expect(await snapshot()).toEqual(before);
    }
    flags();
    server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: "replacement" });
    await expect(
      renewSchedulerExecutionLease(server.ctx, { ...input, sessionId: "replacement" }, binding),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    server.ctx.getPairedNodeSession = () => ({ ...session });
    await server.db.db.update(deviceTokens).set({ expiresAt: new Date(time).toISOString() });
    await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow("credential");
    expect(await snapshot()).toEqual(before);
  });

  it("compares renewal observations and expiry at database microsecond precision and never revives a closed lease", async () => {
    const { input, ready } = await readyStart();
    const base = new Date(Date.parse(server.ctx.clock.nowIso()) + 1000).toISOString().slice(0, 19);
    let now = `${base}.000123Z`;
    server.ctx.clock = { now: () => new Date(now), nowIso: () => now };
    await grantSchedulerStart(server.ctx, input, ready);
    const binding = (await snapshot()).executionLeases[0]!.binding;
    now = `${base}.000124Z`;
    const renewed = await renewSchedulerExecutionLease(server.ctx, input, binding);
    const saved = await snapshot();
    now = `${base}.000123Z`;
    await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow("clock regressed");
    await expect(closeSchedulerExecutionLease(server.ctx, binding, "revoked")).rejects.toThrow("stale");
    expect(await snapshot()).toEqual(saved);
    now = renewed.expires_at.replace(/124Z$/, "123Z");
    await expect(closeSchedulerExecutionLease(server.ctx, binding, "expired")).rejects.toThrow("not yet eligible");
    expect(await snapshot()).toEqual(saved);
    now = renewed.expires_at;
    await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow("expired");
    const expired = await closeSchedulerExecutionLease(server.ctx, binding, "expired");
    expect(expired).toMatchObject({ state: "expired", closed_at: now });
    const closed = await snapshot();
    await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow("expired");
    await expect(closeSchedulerExecutionLease(server.ctx, binding, "revoked")).rejects.toThrow("stale");
    expect(await snapshot()).toEqual(closed);
    expect(closed.runs).toEqual(saved.runs);
    expect(closed.leases).toEqual(saved.leases);
    expect(closed.tasks).toEqual(saved.tasks);
  });

  it("refuses renewal after Run termination, Task withdrawal or original-assignee drift", async () => {
    const { input, ready } = await readyStart();
    const time = Date.parse(server.ctx.clock.nowIso());
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    await grantSchedulerStart(server.ctx, input, ready);
    const binding = (await snapshot()).executionLeases[0]!.binding;
    // Controlled DB lifecycle states, never physical closure evidence.
    for (const state of ["completed", "failed", "cancelled"] as const) {
      await server.db.db.update(runs).set({ status: state }).where(eq(runs.id, ready.run_id));
      const before = await snapshot();
      await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow("active assignment");
      expect(await snapshot()).toEqual(before);
    }
    await server.db.db.update(runs).set({ status: "queued" }).where(eq(runs.id, ready.run_id));
    for (const patch of [
      { status: "cancelled" as const },
      { status: "review" as const },
      { status: "assigned" as const, assigneeType: "user" as const, assigneeId: "user_owner" },
    ]) {
      await server.db.db.update(tasks).set(patch).where(eq(tasks.id, input.taskId));
      const before = await snapshot();
      await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow(
        "original active assignment",
      );
      expect(await snapshot()).toEqual(before);
    }
  });

  it("revokes logical ownership while retaining reservations and prevents replay of its still-current start grant", async () => {
    const { input, ready } = await readyStart();
    const time = Date.parse(server.ctx.clock.nowIso());
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    await grantSchedulerStart(server.ctx, input, ready);
    const before = await snapshot(),
      binding = before.executionLeases[0]!.binding;
    await closeSchedulerExecutionLease(server.ctx, binding, "revoked");
    const saved = await snapshot();
    await expect(grantSchedulerStart(server.ctx, input, ready)).rejects.toThrow("lease is closed");
    await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow("stale");
    expect(await snapshot()).toEqual(saved);
    expect(saved.runs).toEqual(before.runs);
    expect(saved.leases).toEqual(before.leases);
    expect(saved.tasks).toEqual(before.tasks);
  });

  it.each(["session", "credential", "expiry", "clock", "audit"] as const)(
    "rolls renewal and event back when %s changes during persistence",
    async (changed) => {
      const { input, ready } = await readyStart();
      let time = Date.parse(server.ctx.clock.nowIso());
      server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
      if (changed === "credential")
        await server.db.db.update(deviceTokens).set({ expiresAt: new Date(time + 40_000).toISOString() });
      await grantSchedulerStart(server.ctx, input, ready);
      const before = await snapshot(),
        binding = before.executionLeases[0]!.binding,
        generate = server.ctx.idGen.generate.bind(server.ctx.idGen);
      server.ctx.idGen = {
        generate(prefix) {
          if (changed === "session") server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: "replacement" });
          if (changed === "credential") time += 40_000;
          if (changed === "expiry") time += 30_000;
          if (changed === "clock") time -= 1;
          return changed === "audit" ? before.events[0]!.id : generate(prefix);
        },
      };
      await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  async function attemptCredential() {
    const { input, ready } = await readyStart();
    let time = Date.parse(server.ctx.clock.nowIso());
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_default: { flags: Object.fromEntries([...switches, "attempt_credentials"].map((key) => [key, true])) },
        },
      }),
    });
    const { grant } = await grantSchedulerStart(server.ctx, input, ready);
    const acquired = await acquireSchedulerAttemptCredential(server.ctx, input, grant);
    if (acquired.status !== "issued") throw new Error("Expected a new controlled credential");
    return {
      input,
      grant,
      ...acquired,
      advance(ms: number) {
        time += ms;
      },
    };
  }

  it("commits scheduler lifecycle and durable Stop only through the separate scoped authority", async () => {
    const f = await attemptCredential();
    const acquired = await acquireSchedulerRunCredential(server.ctx, f.input, f.grant);
    if (acquired.status !== "issued") throw new Error("Expected lifecycle credential");
    const frame = (sequence: number, phase: "started" | "cancelled") => ({
      kind: "scheduler.run.event.v1",
      node_id: COMPUTER,
      session_id: f.input.sessionId,
      binding: f.lease.binding,
      credential: acquired.credential,
      frame: {
        kind: "run.event",
        node_id: COMPUTER,
        run_id: f.grant.run_id,
        sequence,
        event: { type: "run.lifecycle", payload: { phase } },
      },
    });
    await expect(
      ingestSchedulerWireRunEvent(server.ctx, { ...frame(0, "started"), credential: f.credential }),
    ).rejects.toThrow();
    const started = await ingestSchedulerWireRunEvent(server.ctx, frame(0, "started"));
    expect(started).toMatchObject({ runStatus: "running", taskStatus: "running", deduped: false });
    const beforeStop = await snapshot();
    expect(await requestSchedulerRunStop(server.ctx, f.grant.run_id)).toEqual({ stop_requested: true });
    expect(await requestSchedulerRunStop(server.ctx, f.grant.run_id)).toEqual({ stop_requested: true });
    const waiting = await snapshot();
    expect(waiting.runs).toEqual(beforeStop.runs);
    expect(waiting.leases).toEqual(beforeStop.leases);
    expect(await server.db.db.select().from(schedulerRunStopIntents)).toHaveLength(1);
    expect(await schedulerRunStatus(server.ctx, f.input, f.lease.binding, acquired.credential)).toMatchObject({
      stop_requested: true,
    });
    const publicView = await getProjectControlView(server.ctx, f.lease.binding.project_id, { limit: 100 });
    expect(publicView.tasks.find((entry) => entry.task.id === f.input.taskId)).toMatchObject({
      latest_run: { id: f.grant.run_id, status: "running" },
      execution_lease: { id: f.lease.binding.lease_id, stop_requested: true, closed_at: null },
    });
    expect(JSON.stringify(publicView)).not.toContain(acquired.credential.secret);
    expect(await failRunDaemonDisconnect(server.ctx, f.grant.run_id, COMPUTER, false)).toEqual({ failed: false });
    expect((await snapshot()).runs).toEqual(waiting.runs);
    const terminal = frame(1, "cancelled");
    expect(await ingestSchedulerWireRunEvent(server.ctx, terminal)).toMatchObject({
      runStatus: "cancelled",
      deduped: false,
    });
    expect((await server.db.db.select().from(schedulerRunCredentials))[0]!.revokedAt).not.toBeNull();
    expect((await snapshot()).leases.every((lease) => lease.releasedAt !== null)).toBe(true);
    expect(await ingestSchedulerWireRunEvent(server.ctx, terminal)).toMatchObject({
      runStatus: "cancelled",
      deduped: true,
    });
    await expect(ingestSchedulerWireRunEvent(server.ctx, frame(2, "cancelled"))).rejects.toThrow();
    await expect(
      ingestSchedulerWireRunEvent(server.ctx, {
        ...terminal,
        frame: { ...terminal.frame, event: { type: "run.lifecycle", payload: { phase: "failed" } } },
      }),
    ).rejects.toThrow("body mismatch");
    const serialized = JSON.stringify({
      ...(await snapshot()),
      credentials: await server.db.db.select().from(schedulerRunCredentials),
    });
    expect(serialized).not.toContain(acquired.credential.secret);
  });

  it.each(["expiry", "session"] as const)(
    "rolls scoped lifecycle and qualified receipt back on final %s fencing",
    async (changed) => {
      const f = await attemptCredential(),
        acquired = await acquireSchedulerRunCredential(server.ctx, f.input, f.grant);
      if (acquired.status !== "issued") throw new Error("Expected lifecycle credential");
      const before = await snapshot(),
        generate = server.ctx.idGen.generate.bind(server.ctx.idGen);
      server.ctx.idGen = {
        generate(prefix) {
          if (changed === "expiry") f.advance(30_000);
          else server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: randomUUID() });
          return generate(prefix);
        },
      };
      await expect(
        ingestSchedulerWireRunEvent(server.ctx, {
          kind: "scheduler.run.event.v1",
          node_id: COMPUTER,
          session_id: f.input.sessionId,
          binding: f.lease.binding,
          credential: acquired.credential,
          frame: {
            kind: "run.event",
            node_id: COMPUTER,
            run_id: f.grant.run_id,
            sequence: 0,
            event: { type: "run.lifecycle", payload: { phase: "started" } },
          },
        }),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await server.db.db.select().from(runEventIngest)).toHaveLength(0);
    },
  );

  it("issues one hash-only credential, retains it on replay and renews both expiries after the start window", async () => {
    const { input, grant, credential, lease, advance } = await attemptCredential();
    const before = await snapshot();
    expect(before.attemptCredentials).toHaveLength(1);
    expect(before.attemptCredentials[0]).toMatchObject({
      id: credential.credential_id,
      leaseId: lease.binding.lease_id,
      secretHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      revokedAt: null,
    });
    expect(JSON.stringify(before)).not.toContain(credential.secret);
    expect(JSON.stringify(before.events)).not.toContain(before.attemptCredentials[0]!.secretHash);
    expect(before.events.filter((event) => event.type === "scheduler.attempt_credential.issued")).toHaveLength(1);
    // A replacement context has no recoverable plaintext cache, even after response loss.
    expect(await acquireSchedulerAttemptCredential({ ...server.ctx }, input, grant)).toEqual({
      status: "retained",
      lease,
    });
    expect(await snapshot()).toEqual(before);
    advance(6000);
    const renewed = await renewSchedulerAttemptCredential(server.ctx, input, lease.binding, credential);
    expect(Date.parse(renewed.expires_at)).toBe(Date.parse(lease.expires_at) + 6000);
    const after = await snapshot();
    expect(Date.parse(after.attemptCredentials[0]!.expiresAt)).toBe(Date.parse(renewed.expires_at));
    const {
      attemptCredentials: _oldCredentials,
      executionLeases: _oldLeases,
      events: _oldEvents,
      ...oldOther
    } = before;
    const { attemptCredentials: _newCredentials, executionLeases: _newLeases, events: _newEvents, ...newOther } = after;
    expect(newOther).toEqual(oldOther);
    expect(after.events.filter((event) => event.type === "scheduler.attempt_credential.renewed")).toHaveLength(1);
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  });

  it("requires independent secret, exact persisted grant, complete lease scope and original paired session", async () => {
    const { input, grant, credential, lease } = await attemptCredential();
    const before = await snapshot();
    for (const patch of [
      { secret: "A".repeat(43) },
      { credential_id: randomUUID() },
      { scope: "scheduler-start.once.v1" },
      { secret: "short" },
      { unexpected: true },
    ]) {
      await expect(
        renewSchedulerAttemptCredential(server.ctx, input, lease.binding, { ...credential, ...patch }),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    }
    for (const [key, value] of Object.entries(lease.binding)) {
      const replacement =
        key === "version"
          ? 2
          : key === "epoch"
            ? 2
            : typeof value === "string" && /^[a-f\d]{8}-/.test(value)
              ? randomUUID()
              : "different";
      await expect(
        renewSchedulerAttemptCredential(server.ctx, input, { ...lease.binding, [key]: replacement }, credential),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    }
    for (const patch of [
      { project_id: "different" },
      { computer_id: "other" },
      { grant_id: randomUUID() },
      { expires_at: "2099-01-01T00:00:00.000Z" },
    ]) {
      await expect(acquireSchedulerAttemptCredential(server.ctx, input, { ...grant, ...patch })).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    }
    await expect(
      renewSchedulerAttemptCredential({ ...server.ctx, organizationId: "another" }, input, lease.binding, credential),
    ).rejects.toThrow();
    server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: "replacement" });
    await expect(
      renewSchedulerAttemptCredential(server.ctx, { ...input, sessionId: "replacement" }, lease.binding, credential),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("does not transfer a valid credential to another real consumed Run", async () => {
    const first = await attemptCredential();
    const input = await stage();
    await claim(input);
    const proposal = await prepareSchedulerStartProposal(server.ctx, input);
    const { grant } = await grantSchedulerStart(server.ctx, input, {
      version: 1,
      request_id: input.requestId,
      run_id: proposal.proposal.prepared_start.run_id,
      proposal_digest: proposal.proposal_digest,
      journal_namespace: randomUUID(),
      node_attempt_id: randomUUID(),
      ready_id: randomUUID(),
    });
    const second = await acquireSchedulerAttemptCredential(server.ctx, input, grant);
    if (second.status !== "issued") throw new Error("Missing second controlled credential");
    const before = await snapshot();
    await expect(
      renewSchedulerAttemptCredential(server.ctx, input, second.lease.binding, first.credential),
    ).rejects.toThrow("not valid");
    expect(await snapshot()).toEqual(before);
    await expect(
      renewSchedulerAttemptCredential(server.ctx, input, second.lease.binding, second.credential),
    ).resolves.toMatchObject({ binding: second.lease.binding });
  });

  it("keeps independent credential expiry closed even when internal logical ownership is extended", async () => {
    const { input, grant, credential, lease, advance } = await attemptCredential();
    advance(1000);
    await renewSchedulerExecutionLease(server.ctx, input, lease.binding);
    advance(29_000);
    const before = await snapshot();
    await expect(acquireSchedulerAttemptCredential(server.ctx, input, grant)).rejects.toThrow("expired");
    await expect(renewSchedulerAttemptCredential(server.ctx, input, lease.binding, credential)).rejects.toThrow(
      "expired",
    );
    expect(await snapshot()).toEqual(before);
  });

  it.each(["completed", "failed", "cancelled", "ended_at", "lease"] as const)(
    "revokes attempt credentials on %s and preserves physical reservations",
    async (reason) => {
      const { input, grant, credential, lease } = await attemptCredential();
      const before = await snapshot();
      if (reason === "lease") await closeSchedulerExecutionLease(server.ctx, lease.binding, "revoked");
      else
        await server.db.db
          .update(runs)
          .set(reason === "ended_at" ? { endedAt: server.ctx.clock.nowIso() } : { status: reason })
          .where(eq(runs.id, lease.binding.run_id));
      const after = await snapshot();
      expect(after.attemptCredentials[0]!.revokedAt).not.toBeNull();
      expect(after.attemptCredentials[0]!.revokedAt).toBe(after.attemptCredentials[0]!.observedAt);
      expect(after.leases).toEqual(before.leases);
      await expect(acquireSchedulerAttemptCredential(server.ctx, input, grant)).rejects.toThrow();
      await expect(renewSchedulerAttemptCredential(server.ctx, input, lease.binding, credential)).rejects.toThrow();
      expect(await snapshot()).toEqual(after);
    },
  );

  it.each(["issue", "renew"] as const)("rolls %s and all metadata back when its audit fails", async (operation) => {
    const { input, grant, credential, lease, advance } = await attemptCredential();
    if (operation === "issue") {
      // The next real request gets a fresh grant; no credential history is removed.
      const next = await stage();
      await claim(next);
      const proposal = await prepareSchedulerStartProposal(server.ctx, next);
      const { grant: nextGrant } = await grantSchedulerStart(server.ctx, next, {
        version: 1,
        request_id: next.requestId,
        run_id: proposal.proposal.prepared_start.run_id,
        proposal_digest: proposal.proposal_digest,
        journal_namespace: randomUUID(),
        node_attempt_id: randomUUID(),
        ready_id: randomUUID(),
      });
      const before = await snapshot();
      await server.db.db.execute(sql`CREATE FUNCTION reject_attempt_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.type='scheduler.attempt_credential.issued' THEN RAISE EXCEPTION 'injected credential audit failure'; END IF; RETURN NEW; END $$`);
      await server.db.db.execute(
        sql`CREATE TRIGGER reject_attempt_audit BEFORE INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION reject_attempt_audit()`,
      );
      await expect(acquireSchedulerAttemptCredential(server.ctx, next, nextGrant)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } else {
      advance(1000);
      const before = await snapshot();
      await server.db.db.execute(sql`CREATE FUNCTION reject_attempt_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.type='scheduler.attempt_credential.renewed' THEN RAISE EXCEPTION 'injected credential audit failure'; END IF; RETURN NEW; END $$`);
      await server.db.db.execute(
        sql`CREATE TRIGGER reject_attempt_audit BEFORE INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION reject_attempt_audit()`,
      );
      await expect(renewSchedulerAttemptCredential(server.ctx, input, lease.binding, credential)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    }
    expect(grant.grant_id).toBe(lease.binding.grant_id);
  });

  it.each(["session", "expiry", "clock"] as const)(
    "rolls both expiries back when %s changes after credential persistence",
    async (changed) => {
      const { input, credential, lease, advance } = await attemptCredential();
      advance(1000);
      const before = await snapshot(),
        generate = server.ctx.idGen.generate.bind(server.ctx.idGen);
      let events = 0;
      server.ctx.idGen = {
        generate(prefix) {
          // First event records lease renewal; second records credential renewal.
          if (++events === 2) {
            if (changed === "session")
              server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: "replacement" });
            else advance(changed === "clock" ? -1 : 30_000);
          }
          return generate(prefix);
        },
      };
      await expect(renewSchedulerAttemptCredential(server.ctx, input, lease.binding, credential)).rejects.toThrow();
      expect(events).toBe(2);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("requires attempt rollout in the real project and rejects revoked paired credentials independently", async () => {
    const { input, grant, credential, lease } = await attemptCredential();
    const before = await snapshot();
    flags();
    await expect(acquireSchedulerAttemptCredential(server.ctx, input, grant)).rejects.toThrow("disabled");
    await expect(renewSchedulerAttemptCredential(server.ctx, input, lease.binding, credential)).rejects.toThrow(
      "disabled",
    );
    expect(await snapshot()).toEqual(before);
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_default: {
            flags: Object.fromEntries([...switches, "attempt_credentials"].map((key) => [key, true])),
            projects: { proj_artoo: { attempt_credentials: false } },
          },
        },
      }),
    });
    await expect(renewSchedulerAttemptCredential(server.ctx, input, lease.binding, credential)).rejects.toThrow(
      "disabled",
    );
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_default: { flags: Object.fromEntries([...switches, "attempt_credentials"].map((key) => [key, true])) },
        },
      }),
    });
    await server.db.db.update(deviceTokens).set({ status: "revoked", revokedAt: server.ctx.clock.nowIso() });
    await expect(renewSchedulerAttemptCredential(server.ctx, input, lease.binding, credential)).rejects.toThrow(
      "paired credential",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("caps new and replayed remaining lifetime at the original current credential expiry", async () => {
    const { input, ready } = await readyStart();
    const time = Date.parse(server.ctx.clock.nowIso());
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    await server.db.db.update(deviceTokens).set({ expiresAt: new Date(time + 1200).toISOString() });
    const first = await grantSchedulerStart(server.ctx, input, ready);
    expect(first.remaining_ms).toBe(1200);
    expect(first.grant.expires_at).toBe(new Date(time + 1200).toISOString());
    await server.db.db.update(deviceTokens).set({ expiresAt: new Date(time + 500).toISOString() });
    expect(await grantSchedulerStart(server.ctx, input, ready)).toEqual({ ...first, remaining_ms: 500 });
    await server.db.db.update(deviceTokens).set({ expiresAt: new Date(time + 20_000).toISOString() });
    expect(await grantSchedulerStart(server.ctx, input, ready)).toEqual(first);
  });

  it("rejects ordinary events, cancellation and absence claims for a consumed scheduler Run without changing reservations", async () => {
    await setup();
    const input = await stage(),
      result = await claim(input),
      runId = result.run.id,
      before = await snapshot();
    const stop = vi.fn(async () => {});
    const channel = createInProcessChannel(),
      send = vi.spyOn(channel.serverTransport, "send");
    const binding = attachNodeBinding(server.ctx, channel.serverTransport, COMPUTER, [
      "workspace-allocation.per-run-v1",
    ]);
    const envelope = {
      runId,
      nodeId: COMPUTER,
      sequence: 0,
      event: { kind: "lifecycle" as const, phase: "started" as const },
    };
    try {
      for (const action of [
        () => ingestRunEvent(server.ctx, envelope),
        () =>
          ingestWireRunEvent(server.ctx, {
            kind: "run.event",
            node_id: COMPUTER,
            run_id: runId,
            sequence: 0,
            event: { type: "run.lifecycle", payload: { phase: "started" } },
          }),
        () => cancelRun(server.ctx, runId, stop),
        () => failRunStart(server.ctx, runId, "process_start_failed", "ordinary rejection"),
        () => failRunDaemonDisconnect(server.ctx, runId, COMPUTER, true),
        () => binding.dispatchRunResume(runId),
        () => binding.dispatchRunStop(runId),
      ]) {
        await expect(action()).rejects.toThrow("scoped node-owned attempt protocol");
        expect(await snapshot()).toEqual(before);
        expect(await server.db.db.select().from(runEventIngest)).toHaveLength(0);
      }
      expect(stop).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      binding.close();
    }
  });

  it("retains scheduler leases when disconnect is unknown and rejects a later ordinary absence assertion", async () => {
    await setup();
    const input = await stage(),
      result = await claim(input),
      runId = result.run.id;
    expect(await failRunDaemonDisconnect(server.ctx, runId, COMPUTER, false)).toEqual({ failed: true });
    const before = await snapshot();
    expect(before.runs[0]).toMatchObject({ status: "failed", failureReason: "daemon_disconnect" });
    expect(before.leases[0]?.releasedAt).toBeNull();
    await expect(failRunDaemonDisconnect(server.ctx, runId, COMPUTER, true)).rejects.toThrow(
      "scoped node-owned attempt protocol",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("rejects mode, binding and attempt changes without creating or replacing grant history", async () => {
    const { input, ready } = await readyStart();
    const before = await snapshot();
    for (const invalid of [
      { ...ready, request_id: "other" },
      { ...ready, run_id: "other" },
      { ...ready, proposal_digest: `sha256:${"b".repeat(64)}` },
      { ...ready, version: 2 as never },
      { ...ready, node_attempt_id: "not-a-uuid" },
      { ...ready, execution_authorized: true },
    ])
      await expect(grantSchedulerStart(server.ctx, input, invalid)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await grantSchedulerStart(server.ctx, input, ready);
    const saved = await snapshot();
    for (const changed of [
      { ...ready, journal_namespace: randomUUID() },
      { ...ready, node_attempt_id: randomUUID() },
      { ...ready, ready_id: randomUUID() },
    ])
      await expect(grantSchedulerStart(server.ctx, input, changed)).rejects.toThrow("another node attempt");
    expect(await snapshot()).toEqual(saved);
    await expect(grantSchedulerStartInTransaction(server.ctx, server.db.db, input, ready)).rejects.toThrow(
      "transaction",
    );
    await expect(
      server.db.db.transaction((tx) => grantSchedulerStartInTransaction(server.ctx, tx, input, ready), {
        isolationLevel: "repeatable read",
      }),
    ).rejects.toThrow("read committed");
    flags("daemon_claim");
    await expect(grantSchedulerStart(server.ctx, input, ready)).rejects.toThrow("disabled");
    expect(await snapshot()).toEqual(saved);
  });

  it.each(["deadline", "credential", "session", "capability", "audit"] as const)(
    "rolls grant and audit back when %s changes during awaited grant persistence",
    async (changed) => {
      const { input, ready } = await readyStart();
      let time = Date.parse(server.ctx.clock.nowIso());
      server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
      if (changed === "credential")
        await server.db.db.update(deviceTokens).set({ expiresAt: new Date(time + 1000).toISOString() });
      const before = await snapshot(),
        generate = server.ctx.idGen.generate.bind(server.ctx.idGen);
      server.ctx.idGen = {
        generate(prefix) {
          if (changed === "deadline") time += 5000;
          else if (changed === "credential") time += 1000;
          else if (changed === "session")
            server.ctx.getPairedNodeSession = () => ({ ...session, sessionId: "replacement" });
          else if (changed === "capability") server.ctx.supportsExecutionFeature = () => false;
          return changed === "audit" ? before.events[0]!.id : generate(prefix);
        },
      };
      await expect(grantSchedulerStart(server.ctx, input, ready)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
    },
  );

  it("refuses grant replay after credential withdrawal and after a backwards server clock", async () => {
    const { input, ready } = await readyStart();
    const time = Date.parse(server.ctx.clock.nowIso());
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    await grantSchedulerStart(server.ctx, input, ready);
    const before = await snapshot();
    server.ctx.clock = { now: () => new Date(time - 1), nowIso: () => new Date(time - 1).toISOString() };
    await expect(grantSchedulerStart(server.ctx, input, ready)).rejects.toThrow("clock continuity");
    expect(await snapshot()).toEqual(before);
    server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
    await server.db.db.update(deviceTokens).set({ status: "revoked", revokedAt: server.ctx.clock.nowIso() });
    await expect(grantSchedulerStart(server.ctx, input, ready)).rejects.toThrow("credential");
    expect(await snapshot()).toEqual(before);
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

  it("rejects unsupported, dev-token and ordinary scheduler registrations over real sockets", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "artoo-scheduler-wire-"));
    artifactDirectories.push(artifactDir);
    await setup({ artifactDir });
    const token = generateDeviceToken();
    await server.db.db
      .update(deviceTokens)
      .set({ tokenLookup: token.lookup, tokenHash: token.secretHash })
      .where(eq(deviceTokens.id, "claim-token"));
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    for (const candidate of [
      { token: token.raw, version: 2, managed: true, allocation: true, leaseVersion: null },
      { token: "dev", version: 1, managed: true, allocation: true, leaseVersion: null },
      { token: token.raw, version: 1, managed: false, allocation: true, leaseVersion: null },
      { token: token.raw, version: 1, managed: true, allocation: false, leaseVersion: null },
      { token: token.raw, version: 1, managed: true, allocation: true, leaseVersion: 2 },
      { token: token.raw, version: null, managed: true, allocation: true, leaseVersion: 1 },
      { token: token.raw, version: null, managed: false, allocation: true, leaseVersion: 1 },
    ]) {
      const socket = new WebSocket(`${address.replace(/^http/, "ws")}/api/v1/node?token=${candidate.token}`);
      try {
        const closed = new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Unsupported scheduler registration was not closed")), 3000);
          socket.addEventListener(
            "close",
            (event) => {
              clearTimeout(timer);
              resolve(event.code);
            },
            { once: true },
          );
        });
        socket.addEventListener("open", () =>
          socket.send(
            JSON.stringify({
              kind: "node.hello",
              node_id: COMPUTER,
              protocol_version: "2026-06-11",
              artood_version: "controlled-fixture",
              machine: { hostname: "fixture", os: "linux", arch: "x64" },
              ...(candidate.allocation ? { execution_features: ["workspace-allocation.per-run-v1"] } : {}),
              ...(candidate.managed
                ? { managed_receipts: { version: 1, nonce: randomUUID(), required_contract: "run-event-body-v1" } }
                : {}),
              ...(candidate.version === null
                ? {}
                : { scheduler_start: { version: candidate.version, journal_namespace: randomUUID() } }),
              ...(candidate.leaseVersion === null ? {} : { scheduler_lease: { version: candidate.leaseVersion } }),
            }),
          ),
        );
        expect(await closed).toBe(1008);
      } finally {
        socket.close();
      }
      expect(server.nodeRegistry.get(COMPUTER)).toBeUndefined();
    }
    expect(await server.db.db.select().from(schedulerStartGrants)).toHaveLength(0);
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });

  it("exchanges an existing proposal and immutable grant over a real paired WebSocket without dispatch", async () => {
    const { link, input } = await liveChannel(),
      lane = link.openSchedulerStartSession();
    const observed = vi.fn();
    link.transport.subscribe(observed);
    const proposal = await lane.propose(input);
    expect(proposal.execution_authorized).toBe(false);
    expect(proposal.proposal.prepared_start).toMatchObject({
      request_id: input.requestId,
      session_id: input.sessionId,
      actor_user_id: "user_owner",
      device_id: session.deviceId,
      computer_id: COMPUTER,
    });
    const ready = {
      version: 1 as const,
      request_id: input.requestId,
      run_id: proposal.proposal.prepared_start.run_id,
      journal_namespace: lane.session.namespace,
      node_attempt_id: randomUUID(),
      ready_id: randomUUID(),
      proposal_digest: proposal.proposal_digest,
    };
    const first = await lane.grant({ taskId: input.taskId, ready });
    expect(first.remaining_ms).toBe(5000);
    server.ctx.clock = { now: () => new Date("2026-06-13T00:00:01.000Z"), nowIso: () => "2026-06-13T00:00:01.000Z" };
    expect(await lane.grant({ taskId: input.taskId, ready })).toEqual({ ...first, remaining_ms: 4000 });
    await expect(
      link.transport.send({
        kind: "scheduler.start.ready.v1",
        node_id: COMPUTER,
        session_id: input.sessionId,
        exchange_id: randomUUID(),
        task_id: input.taskId,
        ready,
      }),
    ).rejects.toThrow("generation-bound");
    expect(await server.db.db.select().from(schedulerStartGrants)).toHaveLength(1);
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
    expect(observed).not.toHaveBeenCalled();
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
    flags("daemon_claim");
    await expect(lane.propose(input)).rejects.toThrow("proposal was rejected");
    await expect(lane.grant({ taskId: input.taskId, ready })).rejects.toThrow("grant was rejected");
    expect(await server.db.db.select().from(schedulerStartGrants)).toHaveLength(1);
  });

  async function liveLease() {
    const wire = await liveChannel(true),
      lane = wire.link.openSchedulerStartSession(),
      proposal = await lane.propose(wire.input);
    const { grant } = await lane.grant({
      taskId: wire.input.taskId,
      ready: {
        version: 1,
        request_id: wire.input.requestId,
        run_id: proposal.proposal.prepared_start.run_id,
        journal_namespace: lane.session.namespace,
        node_attempt_id: randomUUID(),
        ready_id: randomUUID(),
        proposal_digest: proposal.proposal_digest,
      },
    });
    return { ...wire, grant, lane: wire.link.openSchedulerLeaseSession() };
  }

  it("acquires and renews over a real paired private lane without leaking credentials to ordinary subscribers", async () => {
    const { link, input, grant, lane } = await liveLease(),
      observed = vi.fn();
    link.transport.subscribe(observed);
    let secret = "";
    const acquire = attemptService.acquireSchedulerAttemptCredential;
    vi.spyOn(attemptService, "acquireSchedulerAttemptCredential").mockImplementation(async (...args) => {
      const result = await acquire(...args);
      if (result.status === "issued") secret = result.credential.secret;
      return result;
    });
    const before = await snapshot(),
      acquired = await lane.acquire(grant);
    if (acquired.status !== "acquired") throw new Error("Expected one real private renewal handle");
    expect(secret).toHaveLength(43);
    expect(JSON.stringify(acquired)).not.toContain(secret);
    expect(observed).not.toHaveBeenCalled();
    const issued = await snapshot();
    expect(JSON.stringify(issued)).not.toContain(secret);
    expect(await lane.acquire(grant)).toEqual({ status: "retained", lease: acquired.lease });
    expect(await snapshot()).toEqual(issued);
    await expect(
      link.transport.send({
        kind: "scheduler.lease.acquire.v1",
        node_id: COMPUTER,
        session_id: input.sessionId,
        exchange_id: randomUUID(),
        grant,
      }),
    ).rejects.toThrow("generation-bound");
    server.ctx.clock = { now: () => new Date("2026-06-13T00:00:06.000Z"), nowIso: () => "2026-06-13T00:00:06.000Z" };
    const renewed = await acquired.renewal.renew();
    expect(renewed.expires_at).toBe("2026-06-13T00:00:36.000000Z");
    const after = await snapshot();
    expect(Date.parse(after.attemptCredentials[0]!.expiresAt)).toBe(Date.parse(renewed.expires_at));
    expect(after.runs).toEqual(before.runs);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.leases).toEqual(before.leases);
    expect(observed).not.toHaveBeenCalled();
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
    acquired.renewal.forget();
    await expect(acquired.renewal.renew()).rejects.toThrow("forgotten");
    expect((await lane.acquire(grant)).status).toBe("retained");
    expect(await snapshot()).toEqual(after);
  });

  it("keeps heartbeat moving during awaited renewal and rejects a replaced session without transferring the credential", async () => {
    const { link, grant, lane, connect } = await liveLease(),
      acquired = await lane.acquire(grant);
    if (acquired.status !== "acquired") throw new Error("Expected one real private renewal handle");
    let release!: () => void,
      entered!: () => void,
      finished!: () => void,
      renewalEntered = false;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      completed = new Promise<void>((resolve) => {
        finished = resolve;
      });
    const renew = attemptService.renewSchedulerAttemptCredential;
    const delayed = vi.spyOn(attemptService, "renewSchedulerAttemptCredential").mockImplementation(async (...args) => {
      renewalEntered = true;
      entered();
      await gate;
      try {
        return await renew(...args);
      } finally {
        finished();
      }
    });
    const pending = acquired.renewal.renew(),
      rejected = expect(pending).rejects.toThrow();
    try {
      await started;
      server.ctx.clock = { now: () => new Date("2026-06-13T00:00:01.000Z"), nowIso: () => "2026-06-13T00:00:01.000Z" };
      await link.transport.send({
        kind: "node.heartbeat",
        node_id: COMPUTER,
        sequence: 1,
        resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 },
        running_instances: [],
        runtimes: [],
      });
      await waitFor(async () => {
        const [row] = await server.db.db.select().from(computers).where(eq(computers.id, COMPUTER));
        return Date.parse(row!.lastHeartbeatAt!) === Date.parse("2026-06-13T00:00:01.000Z");
      });
      const replacement = await connect(),
        before = await snapshot();
      release();
      await completed;
      // Force the replaced generation through its normal registry gate.
      await link.transport.send({
        kind: "node.heartbeat",
        node_id: COMPUTER,
        sequence: 2,
        resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 },
        running_instances: [],
        runtimes: [],
      });
      await rejected;
      expect(acquired.renewal.signal.aborted).toBe(true);
      const next = replacement.openSchedulerLeaseSession();
      await expect(next.acquire(grant)).rejects.toThrow("original session");
      await expect(next.acquire({ ...grant, session_id: next.session.sessionId })).rejects.toThrow(
        "acquisition was rejected",
      );
      expect(await snapshot()).toEqual(before);
    } finally {
      release();
      if (renewalEntered) await completed;
      delayed.mockRestore();
    }
  });

  it("keeps heartbeat independent of awaited proposal work and withholds a replaced session's reply", async () => {
    const { link, input, connect } = await liveChannel(),
      lane = link.openSchedulerStartSession();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const original = proposalService.prepareSchedulerStartProposal;
    const delayed = vi.spyOn(proposalService, "prepareSchedulerStartProposal").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const pending = lane.propose(input),
      failed = expect(pending).rejects.toThrow();
    try {
      await started;
      server.ctx.clock = { now: () => new Date("2026-06-13T00:00:01.000Z"), nowIso: () => "2026-06-13T00:00:01.000Z" };
      await link.transport.send({
        kind: "node.heartbeat",
        node_id: COMPUTER,
        sequence: 1,
        resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 },
        running_instances: [],
        runtimes: [{ runtime: "codex", status: "available", capabilities: [] }],
      });
      await waitFor(async () => {
        const [row] = await server.db.db.select().from(computers).where(eq(computers.id, COMPUTER));
        return Date.parse(row!.lastHeartbeatAt!) === Date.parse("2026-06-13T00:00:01.000Z");
      });
      const replacement = await connect();
      expect(replacement.currentSession!.sessionId).not.toBe(input.sessionId);
      release();
      // Old-session probes are denied by the real registry gate and close this generation.
      await link.transport.send({
        kind: "node.heartbeat",
        node_id: COMPUTER,
        sequence: 2,
        resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 },
        running_instances: [],
        runtimes: [],
      });
      await failed;
      expect(lane.signal.aborted).toBe(true);
      delayed.mockRestore();
      await expect(replacement.openSchedulerStartSession().propose(input)).rejects.toThrow("proposal was rejected");
      expect(await server.db.db.select().from(schedulerStartGrants)).toHaveLength(0);
      expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
    } finally {
      release();
      delayed.mockRestore();
    }
  });

  it("rejects revoked paired credentials again after ready work has been queued", async () => {
    const { link, input } = await liveChannel(),
      lane = link.openSchedulerStartSession(),
      proposal = await lane.propose(input);
    const ready = {
      version: 1 as const,
      request_id: input.requestId,
      run_id: proposal.proposal.prepared_start.run_id,
      journal_namespace: lane.session.namespace,
      node_attempt_id: randomUUID(),
      ready_id: randomUUID(),
      proposal_digest: proposal.proposal_digest,
    };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const original = grantService.grantSchedulerStart;
    const delayed = vi.spyOn(grantService, "grantSchedulerStart").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const pending = lane.grant({ taskId: input.taskId, ready }),
      failed = expect(pending).rejects.toThrow("grant was rejected");
    try {
      await started;
      await server.db.db
        .update(deviceTokens)
        .set({ status: "revoked", revokedAt: server.ctx.clock.nowIso() })
        .where(eq(deviceTokens.id, "claim-token"));
      release();
      await failed;
      expect(await server.db.db.select().from(schedulerStartGrants)).toHaveLength(0);
      expect(await server.db.db.select().from(runs)).toHaveLength(1);
      expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
    } finally {
      release();
      delayed.mockRestore();
    }
  });

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
    const proposal = await prepareSchedulerStartProposal(server.ctx, input);
    const ready = {
      version: 1 as const,
      request_id: input.requestId,
      run_id: proposal.proposal.prepared_start.run_id,
      proposal_digest: proposal.proposal_digest,
      journal_namespace: randomUUID(),
      node_attempt_id: randomUUID(),
      ready_id: randomUUID(),
    };
    await grantSchedulerStart(server.ctx, input, ready);
    const binding = (await snapshot()).executionLeases[0]!.binding;
    await revokeAiDataSharingConsent(server.ctx);
    for (const consent of ["withdrawn", "replaced"]) {
      if (consent === "replaced") await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
      const before = await snapshot();
      await expect(revalidateSchedulerPreparedStart(server.ctx, input)).rejects.toThrow("Review and allow");
      await expect(grantSchedulerStart(server.ctx, input, ready)).rejects.toThrow("Review and allow");
      await expect(renewSchedulerExecutionLease(server.ctx, input, binding)).rejects.toThrow("Review and allow");
      expect(await snapshot()).toEqual(before);
    }
    expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  });
});
