import { contextPacks, eventLog, runEvidence, runs } from "@artoo/db";
import { ContextPackSchema, type RunVerificationPayload } from "@artoo/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestWireRunEvent } from "./services/run-service.js";
import { inspectRunVerification, readRunVerificationEvidence } from "./services/verification-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { measurementPlanEvidenceFixture } from "./test-fixtures/measurement-plan.js";

const other = `sha256:${"9".repeat(64)}`;
describe("node-only measurement-plan evidence persistence and reads", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });
  async function createRun(policy = true) {
    const task = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: { project_id: "proj_artoo",
      title: "Qualify declared measurement feasibility", required_capabilities: ["code.modify"], acceptance_criteria: ["Preserve original requirements"] } })).json().task;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/ready` })).statusCode).toBe(200);
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/assign`, payload: { mode: "auto" } });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const fixture = measurementPlanEvidenceFixture();
    const [run] = await server.db.db.update(runs).set({ verificationRequirement: fixture.requirement })
      .where(eq(runs.id, assigned.json().run.id)).returning();
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run!.contextPackId!));
    const context = ContextPackSchema.parse(stored!.payload);
    context.verification_capabilities = fixture.context.verification_capabilities;
    context.product_development = fixture.context.product_development;
    if (!policy) { delete context.verification_capabilities!.measurement_plan_policy; delete fixture.payload.measurement_plan; }
    await server.db.db.update(contextPacks).set({ payload: context }).where(eq(contextPacks.id, run!.contextPackId!));
    await ingestWireRunEvent(server.ctx, { kind: "run.event", node_id: run!.computerId, run_id: run!.id, sequence: 0,
      event: { type: "run.lifecycle", payload: { phase: "started" } } });
    return { ...fixture, run: run!, context };
  }
  function frame(run: typeof runs.$inferSelect, payload: RunVerificationPayload) {
    return { kind: "run.event" as const, node_id: run.computerId, run_id: run.id, sequence: 1,
      event: { type: "run.verification" as const, payload } };
  }

  it("persists a final node summary as evidence while the task remains unaccepted", async () => {
    const f = await createRun();
    await ingestWireRunEvent(server.ctx, frame(f.run, f.payload));
    const evidence = await readRunVerificationEvidence(server.ctx, server.db.db, f.run.id);
    expect(evidence?.payload.measurement_plan).toEqual(f.payload.measurement_plan);
    expect((await inspectRunVerification(server.ctx, server.db.db, f.run)).passed).toBe(true);
    expect((await server.app.inject({ url: `/api/v1/tasks/${f.run.taskId}` })).json().task.status).toBe("running");
    const [event] = await server.db.db.select().from(eventLog).where(eq(eventLog.id, evidence!.eventId));
    expect(event).toMatchObject({ actorType: "system", actorId: f.run.computerId, type: "run.verification" });
    expect(await readRunVerificationEvidence({ ...server.ctx, organizationId: "foreign" }, server.db.db, f.run.id)).toBeNull();
  });

  it("rejects missing, preview and inconsistent summaries atomically before an audit or evidence row survives", async () => {
    const f = await createRun();
    for (const mode of ["missing", "preview", "hash", "size", "check", "count", "claim"] as const) {
      const payload = structuredClone(f.payload);
      if (mode === "missing") delete payload.measurement_plan;
      if (mode === "preview") payload.measurement_plan!.scope = "preview";
      if (mode === "hash") payload.measurement_plan!.research.checksum = other;
      if (mode === "size") payload.measurement_plan!.research.size++;
      if (mode === "check") payload.measurement_plan!.used_checks[0]!.config_digest = other;
      if (mode === "count") payload.measurement_plan!.mapped_criterion_count--;
      if (mode === "claim") Object.assign(payload.measurement_plan!, { claim: "semantic-completeness" });
      await expect(ingestWireRunEvent(server.ctx, frame(f.run, payload)), mode).rejects.toThrow();
      expect(await server.db.db.select().from(runEvidence)).toHaveLength(0);
      expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "run.verification"))).toHaveLength(0);
    }
    await ingestWireRunEvent(server.ctx, frame(f.run, f.payload));
    expect((await readRunVerificationEvidence(server.ctx, server.db.db, f.run.id))?.payload).toEqual(f.payload);
  });

  it("uses the persisted context rather than a current advertisement and rejects malformed or changed policy bindings", async () => {
    const f = await createRun();
    server.ctx.getVerificationCapabilities = () => { throw new Error("Qualification must not consult today's advertisement"); };
    for (const mode of ["malformed", "missing-policy", "different-binding", "missing-stage"] as const) {
      const context = structuredClone(f.context);
      if (mode === "missing-policy") delete context.verification_capabilities!.measurement_plan_policy;
      if (mode === "different-binding") context.verification_capabilities!.checks[0]!.contract_digest = other;
      if (mode === "missing-stage") delete context.product_development;
      await server.db.db.update(contextPacks).set({ payload: mode === "malformed" ? { invalid: true } : context })
        .where(eq(contextPacks.id, f.run.contextPackId!));
      await expect(ingestWireRunEvent(server.ctx, frame(f.run, f.payload))).rejects.toThrow();
      expect(await server.db.db.select().from(runEvidence)).toHaveLength(0);
    }
    await server.db.db.update(contextPacks).set({ payload: f.context }).where(eq(contextPacks.id, f.run.contextPackId!));
    await ingestWireRunEvent(server.ctx, frame(f.run, f.payload));
    expect((await inspectRunVerification(server.ctx, server.db.db, f.run)).passed).toBe(true);
  });

  it("requalifies identically on reads and inspection even if both saved payload projections are changed together", async () => {
    const f = await createRun(); await ingestWireRunEvent(server.ctx, frame(f.run, f.payload));
    const evidence = (await readRunVerificationEvidence(server.ctx, server.db.db, f.run.id))!;
    for (const mode of ["missing", "preview", "hash", "size", "stage"] as const) {
      const payload = structuredClone(f.payload);
      if (mode === "missing") delete payload.measurement_plan;
      if (mode === "preview") payload.measurement_plan!.scope = "preview";
      if (mode === "hash") payload.measurement_plan!.research.checksum = other;
      if (mode === "size") payload.measurement_plan!.research.size++;
      if (mode === "stage") payload.checks[0]!.observation!.stage = "design";
      await server.db.db.update(runEvidence).set({ payload }).where(eq(runEvidence.id, evidence.id));
      await server.db.db.update(eventLog).set({ payload }).where(eq(eventLog.id, evidence.eventId));
      expect(await readRunVerificationEvidence(server.ctx, server.db.db, f.run.id)).toBeNull();
      expect((await inspectRunVerification(server.ctx, server.db.db, f.run)).passed).toBe(false);
    }
    await server.db.db.update(runEvidence).set({ payload: f.payload }).where(eq(runEvidence.id, evidence.id));
    await server.db.db.update(eventLog).set({ payload: f.payload }).where(eq(eventLog.id, evidence.eventId));
    await server.db.db.update(contextPacks).set({ payload: { invalid: true } }).where(eq(contextPacks.id, f.run.contextPackId!));
    expect(await readRunVerificationEvidence(server.ctx, server.db.db, f.run.id)).toBeNull();
    expect((await inspectRunVerification(server.ctx, server.db.db, f.run)).passed).toBe(false);
  });

  it("retains failed diagnostics without a summary under the policy", async () => {
    const f = await createRun();
    const payload: RunVerificationPayload = { ...f.payload, outcome: "failed", checks: [], reason: "Research mapping is infeasible" };
    delete payload.measurement_plan;
    await ingestWireRunEvent(server.ctx, frame(f.run, payload));
    expect((await readRunVerificationEvidence(server.ctx, server.db.db, f.run.id))?.payload).toEqual(payload);
    expect(await inspectRunVerification(server.ctx, server.db.db, f.run)).toMatchObject({ passed: false, reason: payload.reason });
  });

  it("rejects a missing or misbound context instead of treating a bound receipt as legacy", async () => {
    const f = await createRun();
    const missing = structuredClone(f.payload); delete missing.measurement_plan;
    await server.db.db.update(runs).set({ contextPackId: "missing_context" }).where(eq(runs.id, f.run.id));
    await expect(ingestWireRunEvent(server.ctx, frame(f.run, missing))).rejects.toThrow("lacks its persisted context");
    expect(await server.db.db.select().from(runEvidence)).toHaveLength(0);
    await server.db.db.update(runs).set({ contextPackId: f.run.contextPackId }).where(eq(runs.id, f.run.id));
    await ingestWireRunEvent(server.ctx, frame(f.run, f.payload));
    const evidence = (await readRunVerificationEvidence(server.ctx, server.db.db, f.run.id))!;
    const unrelated = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Unrelated task", required_capabilities: ["code.read"], acceptance_criteria: [] } })).json().task;
    for (const binding of [{ runId: "other_run", taskId: f.run.taskId }, { runId: f.run.id, taskId: unrelated.id as string }]) {
      await server.db.db.update(contextPacks).set(binding).where(eq(contextPacks.id, f.run.contextPackId!));
      for (const payload of [f.payload, missing]) {
        await server.db.db.update(runEvidence).set({ payload }).where(eq(runEvidence.id, evidence.id));
        await server.db.db.update(eventLog).set({ payload }).where(eq(eventLog.id, evidence.eventId));
        expect(await readRunVerificationEvidence(server.ctx, server.db.db, f.run.id)).toBeNull();
        expect((await inspectRunVerification(server.ctx, server.db.db, f.run)).passed).toBe(false);
      }
    }
  });

  it("preserves no-policy final receipts while refusing an unsolicited upgrade", async () => {
    const f = await createRun(false);
    const unsolicited = { ...f.payload, measurement_plan: measurementPlanEvidenceFixture().payload.measurement_plan };
    await expect(ingestWireRunEvent(server.ctx, frame(f.run, unsolicited))).rejects.toThrow("no persisted policy");
    await ingestWireRunEvent(server.ctx, frame(f.run, f.payload));
    expect((await inspectRunVerification(server.ctx, server.db.db, f.run)).passed).toBe(true);
    expect((await readRunVerificationEvidence(server.ctx, server.db.db, f.run.id))?.payload).not.toHaveProperty("measurement_plan");
  });
});
