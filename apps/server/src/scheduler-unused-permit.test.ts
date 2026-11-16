import { randomUUID } from "node:crypto";
import {
  agentInstances,
  agentRuntimes,
  computers,
  devices,
  deviceTokens,
  eventLog,
  fileLeases,
  runEventIngest,
  runs,
  schedulerExecutionLeases,
  schedulerExecutionRequests,
  schedulerRunCredentials,
} from "@artoo/db";
import { adapterRunEventBodySchema } from "@artoo/protocol";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import { claimSchedulerExecutionRequest } from "./services/lifecycle-service.js";
import { ingestSchedulerWireRunEvent, ingestWireRunEvent } from "./services/run-service.js";
import { createSchedulerExecutionRequest } from "./services/scheduler-execution-request-service.js";
import { closeSchedulerExecutionLease } from "./services/scheduler-execution-lease-service.js";
import { putSchedulerPolicy } from "./services/scheduler-policy-service.js";
import { acquireSchedulerRunCredential, schedulerRunStatus } from "./services/scheduler-run-service.js";
import { grantSchedulerStart } from "./services/scheduler-start-grant-service.js";
import { prepareSchedulerStartProposal } from "./services/scheduler-start-proposal-service.js";
import { currentTaskVersion } from "./services/sync-service.js";

let server: TestServer;
afterEach(async () => {
  await server?.close();
});
const computerId = "computer_local_mock";
async function setup() {
  server = await buildTestServer();
  let time = Date.parse(server.ctx.clock.nowIso());
  server.ctx.clock = { now: () => new Date(time), nowIso: () => new Date(time).toISOString() };
  server.ctx.schedulerRollout = loadSchedulerRollout({
    ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
      version: 1,
      workspaces: {
        org_default: {
          flags: Object.fromEntries(
            [
              "execution_requests",
              "daemon_claim",
              "isolated_workspaces",
              "capacity_admission",
              "unified_enqueue",
              "attempt_credentials",
            ].map((flag) => [flag, true]),
          ),
        },
      },
    }),
  });
  await server.db.db.update(computers).set({ os: "linux" }).where(eq(computers.id, computerId));
  const [seed] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
  await server.db.db.update(agentInstances).set({ status: "disabled" }).where(eq(agentInstances.id, seed!.id));
  // Controlled advertised runtime: this fixture starts no CLI, helper or Provider.
  // Per-run allocation requires the same canonical ai_ identity as real inventory.
  await server.db.db.insert(agentInstances).values({
    ...seed!,
    id: "ai_unused",
    runtime: "codex",
    workspaceRoot: "/fixture/repository",
    config: {
      concurrency_limit: 2,
      worktree_workspace_base: { version: 1, strategy: "per-run", basePath: "/fixture/attempts" },
    },
  });
  await server.db.db.insert(agentRuntimes).values({
    id: "unused-runtime",
    organizationId: server.ctx.organizationId,
    computerId,
    runtime: "codex",
    status: "available",
    capabilities: [],
    lastSeenAt: server.ctx.clock.nowIso(),
    metadata: {},
  });
  const session = {
    computerId,
    deviceId: "unused-device",
    tokenLookup: "controlled-unused-lookup",
    sessionId: randomUUID(),
  };
  await server.db.db.insert(devices).values({
    id: session.deviceId,
    organizationId: server.ctx.organizationId,
    displayName: "Controlled unused permit node",
    platform: "linux",
    appVersion: "fixture",
    computerId,
    enrolledByUserId: "user_owner",
    trust: "active",
    createdAt: server.ctx.clock.nowIso(),
  });
  await server.db.db.insert(deviceTokens).values({
    id: "unused-token",
    organizationId: server.ctx.organizationId,
    deviceId: session.deviceId,
    kind: "node",
    tokenLookup: session.tokenLookup,
    tokenHash: "fixture-not-an-authenticated-token",
    status: "active",
    createdAt: server.ctx.clock.nowIso(),
  });
  server.ctx.getPairedNodeSession = (id) => (id === computerId ? { ...session } : undefined);
  server.ctx.supportsExecutionFeature = (id, feature) =>
    id === computerId && feature === "workspace-allocation.per-run-v1";
  for (const [kind, id, policy] of [
    ["project", "proj_artoo", { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 }],
    [
      "agent",
      "agent_mock_coder",
      {
        version: 1,
        pinned_computer_id: null,
        required_runtimes: ["codex"],
        required_labels: [],
        max_concurrent_runs: 2,
      },
    ],
    ["computer", computerId, { version: 1, labels: [], max_concurrent_runs: 2 }],
  ] as const)
    await putSchedulerPolicy(server.ctx, kind, id, policy);
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "Unused physical permit",
      required_capabilities: ["code.modify"],
      acceptance_criteria: ["Preserve original permission"],
    },
  });
  const taskId = created.json().task.id as string;
  expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
  const request = await createSchedulerExecutionRequest(server.ctx, taskId, {
    version: 2,
    permission: "execute_once",
    request_key: "one",
    agent_id: "agent_mock_coder",
    base_version: await currentTaskVersion(server.ctx, taskId),
    branch_backed: true,
    write_paths: [`src/${taskId}.ts`],
  });
  const input = { taskId, requestId: request.id, computerId, sessionId: session.sessionId };
  await claimSchedulerExecutionRequest(server.ctx, input);
  const proposal = await prepareSchedulerStartProposal(server.ctx, input);
  const { grant } = await grantSchedulerStart(server.ctx, input, {
    version: 1,
    request_id: request.id,
    run_id: proposal.proposal.prepared_start.run_id,
    proposal_digest: proposal.proposal_digest,
    ready_id: randomUUID(),
    journal_namespace: randomUUID(),
    node_attempt_id: randomUUID(),
  });
  const owner = await acquireSchedulerRunCredential(server.ctx, input, grant);
  if (owner.status !== "issued") throw Error("Expected a fresh controlled lifecycle credential");
  const binding = owner.lease.binding;
  const frame = {
    kind: "scheduler.run.event.v1" as const,
    node_id: computerId,
    session_id: session.sessionId,
    binding,
    credential: owner.credential,
    frame: {
      kind: "run.event" as const,
      node_id: computerId,
      run_id: grant.run_id,
      sequence: 0,
      event: {
        type: "scheduler.permit_unused" as const,
        payload: {
          version: 1 as const,
          scope: "scheduler-unused-permit.v1" as const,
          grant_id: binding.grant_id,
          journal_namespace: binding.journal_namespace,
          node_attempt_id: binding.node_attempt_id,
          process_never_started: true as const,
        },
      },
    },
  };
  return {
    input,
    session,
    grant,
    owner,
    frame,
    advance(ms: number) {
      time += ms;
    },
  };
}
async function snapshot() {
  return {
    runs: await server.db.db.select().from(runs),
    leases: await server.db.db.select().from(fileLeases),
    execution: await server.db.db.select().from(schedulerExecutionLeases),
    credentials: await server.db.db.select().from(schedulerRunCredentials),
    receipts: await server.db.db.select().from(runEventIngest),
    events: await server.db.db.select().from(eventLog),
  };
}

it("settles only the original scoped unused permit and replays its exact qualified receipt without exit claims", async () => {
  const f = await setup();
  expect(adapterRunEventBodySchema.safeParse(f.frame.frame.event).success).toBe(false);
  await expect(ingestWireRunEvent(server.ctx, f.frame.frame)).rejects.toThrow("scoped");
  expect(await ingestSchedulerWireRunEvent(server.ctx, f.frame)).toMatchObject({
    deduped: false,
    runStatus: "cancelled",
    taskStatus: "cancelled",
  });
  const stored = await snapshot();
  expect(stored.leases.length).toBeGreaterThan(0);
  expect(stored.leases.every((lease) => lease.status === "released")).toBe(true);
  expect(stored.execution[0]!.state).toBe("revoked");
  expect(stored.credentials[0]!.revokedAt).not.toBeNull();
  expect(stored.events.find((event) => event.type === "scheduler.permit_unused")?.payload).toMatchObject({
    process_never_started: true,
    binding: f.frame.binding,
  });
  expect(
    stored.events
      .filter((event) => event.runId === f.grant.run_id)
      .some(
        (event) =>
          event.payload !== null &&
          typeof event.payload === "object" &&
          "process_exit_confirmed" in event.payload &&
          event.payload.process_exit_confirmed === true,
      ),
  ).toBe(false);
  expect(JSON.stringify(stored)).not.toContain(f.owner.credential.secret);
  expect(await ingestSchedulerWireRunEvent(server.ctx, f.frame)).toMatchObject({
    deduped: true,
    runStatus: "cancelled",
  });
  expect(await snapshot()).toEqual(stored);
  expect((await server.db.db.select().from(schedulerExecutionRequests))[0]!.state).toBe("consumed");
  expect(stored.runs).toHaveLength(1);
});

it.each(["expired", "revoked"] as const)(
  "allows closure alone after logical %s without restoring lifecycle or renewal authority",
  async (state) => {
    const f = await setup();
    f.advance(31_000);
    await closeSchedulerExecutionLease(server.ctx, f.frame.binding, state);
    await expect(schedulerRunStatus(server.ctx, f.input, f.frame.binding, f.owner.credential)).rejects.toThrow();
    await expect(
      ingestSchedulerWireRunEvent(server.ctx, {
        ...f.frame,
        frame: { ...f.frame.frame, event: { type: "run.lifecycle", payload: { phase: "started" } } },
      }),
    ).rejects.toThrow();
    expect(await ingestSchedulerWireRunEvent(server.ctx, f.frame)).toMatchObject({
      runStatus: "cancelled",
      deduped: false,
    });
    expect((await snapshot()).execution[0]!.state).toBe(state);
  },
);

it("allows original-owner relinquishment after AI-sharing withdrawal without disclosing task or Provider content", async () => {
  const f = await setup();
  await revokeAiDataSharingConsent(server.ctx);
  expect(await ingestSchedulerWireRunEvent(server.ctx, f.frame)).toMatchObject({ runStatus: "cancelled" });
});

it.each(["run.output", "run.lifecycle"] as const)("rejects unused evidence after a prior %s receipt", async (type) => {
  const f = await setup();
  const event =
    type === "run.output"
      ? { type, payload: { stream: "stdout", text: "Controlled existing output" } }
      : { type, payload: { phase: "started" } };
  await ingestSchedulerWireRunEvent(server.ctx, { ...f.frame, frame: { ...f.frame.frame, event } });
  const before = await snapshot();
  await expect(
    ingestSchedulerWireRunEvent(server.ctx, { ...f.frame, frame: { ...f.frame.frame, sequence: 1 } }),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});

it("rejects mismatched journal identity and rolls closure back when the original session is replaced during commit", async () => {
  const f = await setup(),
    before = await snapshot();
  for (const field of ["grant_id", "journal_namespace", "node_attempt_id"] as const)
    await expect(
      ingestSchedulerWireRunEvent(server.ctx, {
        ...f.frame,
        frame: {
          ...f.frame.frame,
          event: { ...f.frame.frame.event, payload: { ...f.frame.frame.event.payload, [field]: randomUUID() } },
        },
      }),
    ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  const generate = server.ctx.idGen.generate.bind(server.ctx.idGen);
  server.ctx.idGen = {
    generate(prefix) {
      server.ctx.getPairedNodeSession = () => ({ ...f.session, sessionId: randomUUID() });
      return generate(prefix);
    },
  };
  await expect(ingestSchedulerWireRunEvent(server.ctx, f.frame)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
