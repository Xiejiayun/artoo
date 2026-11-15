import {
  eventLog,
  organizations,
  runs,
  schedulerAgentPolicies,
  schedulerComputerPolicies,
  schedulerProjectPolicies,
  schedulerShadowAttempts,
  schedulerShadowObservations,
} from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { cancelSchedulerShadow, claimSchedulerShadow } from "./services/scheduler-shadow-lease-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const targets = [
  {
    kind: "project",
    resource: "projects/proj_artoo",
    table: schedulerProjectPolicies,
    policy: { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 },
  },
  {
    kind: "agent",
    resource: "agents/agent_mock_coder",
    table: schedulerAgentPolicies,
    policy: {
      version: 1,
      pinned_computer_id: null,
      required_runtimes: ["mock"],
      required_labels: [],
      max_concurrent_runs: 2,
    },
  },
  {
    kind: "computer",
    resource: "computers/computer_local_mock",
    table: schedulerComputerPolicies,
    policy: { version: 1, labels: [], max_concurrent_runs: 2 },
  },
] as const;

describe("persistent scheduling policy revisions", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  const put = (resource: string, policy: object) =>
    server.app.inject({ method: "PUT", url: `/api/v1/${resource}/scheduling-policy`, payload: policy });

  for (const target of targets) {
    it(`increments ${target.kind} revisions even for repeated and reverted values at the same clock time`, async () => {
      server = await buildTestServer();
      for (const [index, policy] of [
        target.policy,
        { ...target.policy, max_concurrent_runs: 3 },
        target.policy,
        target.policy,
      ].entries()) {
        const response = await put(target.resource, policy);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          active: false,
          policy: {
            revision: index + 1,
            policy,
            updatedByUserId: "user_owner",
          },
        });
        // The existing endpoint returns the database's timestamptz spelling.
        // Compare instants so local +08 and CI UTC test the same clock fence.
        expect(Date.parse(response.json().policy.updatedAt)).toBe(Date.parse(server.ctx.clock.nowIso()));
        expect(
          (await server.app.inject({ method: "GET", url: `/api/v1/${target.resource}/scheduling-policy` })).json(),
        ).toEqual(response.json());
      }
      const before = await server.db.db.select().from(target.table);
      const audits = await server.db.db.select().from(eventLog).where(eq(eventLog.type, "scheduler.policy.updated"));
      expect(audits.map((event) => event.payload)).toEqual(
        [1, 2, 3, 4].map((revision, index) => ({
          version: 1,
          kind: target.kind,
          target_id: target.resource.split("/")[1],
          revision,
          policy: index === 1 ? { ...target.policy, max_concurrent_runs: 3 } : target.policy,
          execution_authorized: false,
        })),
      );
      expect((await put(target.resource, { ...target.policy, revision: 1 })).statusCode).toBe(400);
      expect(await server.db.db.select().from(target.table)).toEqual(before);
      expect(await server.db.db.select().from(runs)).toEqual([]);
    });

    it(`rolls back ${target.kind} revisions with audit failure and rejects exhaustion or foreign scope`, async () => {
      server = await buildTestServer();
      expect((await put(target.resource, target.policy)).statusCode).toBe(200);
      const before = await server.db.db.select().from(target.table);
      const events = await server.db.db.select().from(eventLog);
      const generate = server.ctx.idGen.generate;
      server.ctx.idGen.generate = () => events[0]!.id;
      try {
        expect((await put(target.resource, target.policy)).statusCode).toBe(500);
      } finally {
        server.ctx.idGen.generate = generate;
      }
      expect(await server.db.db.select().from(target.table)).toEqual(before);
      expect(await server.db.db.select().from(eventLog)).toEqual(events);
      await server.db.db.update(target.table).set({ revision: Number.MAX_SAFE_INTEGER });
      expect((await put(target.resource, target.policy)).statusCode).toBe(409);
      expect((await server.db.db.select().from(target.table))[0]?.revision).toBe(Number.MAX_SAFE_INTEGER);
      expect(await server.db.db.select().from(eventLog)).toEqual(events);
      await server.db.db
        .insert(organizations)
        .values({ id: "foreign", name: "Foreign", createdAt: server.ctx.clock.nowIso() });
      await server.db.db.update(target.table).set({ organizationId: "foreign", revision: 1 });
      const foreign = await server.db.db.select().from(target.table);
      expect((await put(target.resource, target.policy)).statusCode).toBe(409);
      expect(await server.db.db.select().from(target.table)).toEqual(foreign);
      expect(await server.db.db.select().from(eventLog)).toEqual(events);
    });
  }

  it("captures exact revisions for ordinary observations and shadow claims without rewriting their history", async () => {
    server = await buildTestServer();
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: '{"version":1,"workspaces":{"org_default":{"flags":{"claim_shadow":true}}}}',
    });
    for (const target of targets) expect((await put(target.resource, target.policy)).statusCode).toBe(200);
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "Revision provenance",
        required_capabilities: ["code.modify"],
        acceptance_criteria: ["ok"],
      },
    });
    const taskId = created.json().task.id as string;
    expect(created.statusCode).toBe(201);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    const claimed = await claimSchedulerShadow(server.ctx, {
      projectId: "proj_artoo",
      taskId,
      options: { mode: "auto", branchBacked: false },
    });
    expect(claimed.kind).toBe("claimed");
    if (!("binding" in claimed)) throw new Error("Missing shadow binding");
    const original = {
      version: 1,
      project_id: "proj_artoo",
      project: 1,
      agents: { agent_mock_coder: 1 },
      computers: { computer_local_mock: 1 },
    };
    expect(claimed.snapshot.policy_revisions).toEqual(original);
    expect((await cancelSchedulerShadow(server.ctx, claimed.binding)).kind).toBe("updated");
    const historicalAttempts = await server.db.db.select().from(schedulerShadowAttempts);
    expect((await put(targets[0].resource, targets[0].policy)).statusCode).toBe(200);
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } }))
        .statusCode,
    ).toBe(200);
    const observations = await server.db.db.select().from(schedulerShadowObservations);
    expect(observations[0]?.snapshot.policy_revisions).toEqual({ ...original, project: 2 });
    for (const target of targets) expect((await put(target.resource, target.policy)).statusCode).toBe(200);
    expect(await server.db.db.select().from(schedulerShadowAttempts)).toEqual(historicalAttempts);
    expect(await server.db.db.select().from(schedulerShadowObservations)).toEqual(observations);
    expect(
      (
        await server.app.inject({ method: "GET", url: "/api/v1/projects/proj_artoo/scheduler-shadow-observations" })
      ).json().observations[0].snapshot.policy_revisions,
    ).toEqual({ ...original, project: 2 });
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
  });
});
