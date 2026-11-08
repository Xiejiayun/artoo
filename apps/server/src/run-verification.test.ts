import { contextPacks, eventLog, runEvidence, runEventIngest, runs } from "@artoo/db";
import { ContextPackSchema, productDevelopmentContext, productStageHandoffPaths, type RunVerificationPayload } from "@artoo/domain";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestRunEvent, ingestWireRunEvent } from "./services/run-service.js";
import { inspectRunVerification, readRunVerificationEvidence } from "./services/verification-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { verificationCapabilitiesFixture } from "./test-fixtures/verification-capabilities.js";
import { verificationCapabilityBinding } from "./services/verification-capabilities.js";

const digest = `sha256:${"a".repeat(64)}`;
const requirement = { version: 1, request_id: "verification_request", profile_id: "default" };
const passed: RunVerificationPayload = { ...requirement, version: 1, profile_digest: digest, subject_digest: digest,
  outcome: "passed", checks: [{ id: "behavior", exit_code: 0, duration_ms: 12, output_digest: digest }],
  required_files: [{ path: "src/main.ts", checksum: digest, size: 24 }] };

describe("qualified node verification evidence", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });

  async function createRun(withRequirement = true) {
    const task = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Verify the actual implementation", acceptance_criteria: ["Measured checks pass"], required_capabilities: ["code.modify"],
    } })).json().task;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/ready` })).statusCode).toBe(200);
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/assign`, payload: { mode: "auto" } });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const id = assigned.json().run.id as string;
    // Model an already-authorized assignment snapshot without invoking the autonomous dispatcher.
    if (withRequirement) await server.db.db.update(runs).set({ verificationRequirement: requirement }).where(eq(runs.id, id));
    return (await server.db.db.select().from(runs).where(eq(runs.id, id)))[0]!;
  }
  function frame(run: typeof runs.$inferSelect, sequence: number, payload: RunVerificationPayload = passed) {
    return { kind: "run.event", node_id: run.computerId, run_id: run.id, sequence, event: { type: "run.verification", payload } };
  }
  const lifecycle = (run: typeof runs.$inferSelect, sequence: number, phase: "started" | "completed") => ingestWireRunEvent(server.ctx, {
    kind: "run.event", node_id: run.computerId, run_id: run.id, sequence, event: { type: "run.lifecycle", payload: { phase } },
  });

  it("stores real node attribution and immutable evidence without itself accepting the task", async () => {
    const run = await createRun();
    await lifecycle(run, 0, "started");
    const result = await ingestWireRunEvent(server.ctx, frame(run, 1));
    expect(result).toMatchObject({ deduped: false, runStatus: "running", taskStatus: "running" });
    const evidence = await readRunVerificationEvidence(server.ctx, server.db.db, run.id);
    expect(evidence).toMatchObject({ runId: run.id, requestId: requirement.request_id, payload: passed });
    const event = (await server.db.db.select().from(eventLog).where(eq(eventLog.id, evidence!.eventId)))[0];
    expect(event).toMatchObject({ type: "run.verification", actorType: "system", actorId: run.computerId, runId: run.id });
    await lifecycle(run, 2, "completed");
    expect((await inspectRunVerification(server.ctx, server.db.db, run)).passed).toBe(true);
    expect((await server.app.inject({ url: `/api/v1/tasks/${run.taskId}` })).json().task.status).toBe("review");
    expect(await readRunVerificationEvidence({ ...server.ctx, organizationId: "org_elsewhere" }, server.db.db, run.id)).toBeNull();
    await server.db.db.update(runs).set({ verificationRequirement: { ...requirement, request_id: "replacement_request" } }).where(eq(runs.id, run.id));
    expect((await inspectRunVerification(server.ctx, server.db.db, run)).passed).toBe(false);
    await server.db.db.update(runs).set({ verificationRequirement: requirement }).where(eq(runs.id, run.id));
    // A projection that no longer matches its audit event cannot authorize review.
    await server.db.db.update(runEvidence).set({ payload: { ...passed, reason: "Altered projection" } }).where(eq(runEvidence.id, evidence!.id));
    expect(await readRunVerificationEvidence(server.ctx, server.db.db, run.id)).toBeNull();
  });

  it("rejects wrong ownership, absent requirements and mismatched request/profile atomically", async () => {
    const run = await createRun();
    await lifecycle(run, 0, "started");
    await expect(ingestWireRunEvent(server.ctx, { ...frame(run, 1), node_id: "wrong_node" })).rejects.toThrow("owned by this node");
    await expect(ingestWireRunEvent(server.ctx, frame(run, 1, { ...passed, request_id: "old_request" }))).rejects.toThrow("persisted requirement");
    await expect(ingestWireRunEvent(server.ctx, frame(run, 1, { ...passed, profile_id: "unrequested" }))).rejects.toThrow("persisted requirement");
    await lifecycle(run, 1, "completed");
    const unrestricted = await createRun(false);
    await lifecycle(unrestricted, 0, "started");
    await expect(ingestWireRunEvent(server.ctx, frame(unrestricted, 1))).rejects.toThrow("persisted requirement");
    expect(await server.db.db.select().from(runEvidence)).toEqual([]);
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "run.verification"))).toEqual([]);
  });
  it("requires passed receipts to carry every exact capability binding from the persisted request", async () => {
    const run = await createRun(), capabilities = verificationCapabilitiesFixture();
    const capability_binding = verificationCapabilityBinding(capabilities);
    await server.db.db.update(runs).set({ verificationRequirement: { ...requirement, capability_binding } }).where(eq(runs.id, run.id));
    await lifecycle(run, 0, "started");
    const payload: RunVerificationPayload = { ...passed, checks: [{ ...passed.checks[0]!, id: "acceptance", observation: {
      version: 1, format: "static-web-acceptance.v1", scope: "final", stage: "research", cases: [],
      capability_binding: { version: 1, profile_digest: capabilities.profile_digest, ...capability_binding.checks[0]! },
    } }] };
    await expect(ingestWireRunEvent(server.ctx, frame(run, 1, passed))).rejects.toThrow("persisted requirement");
    const variants = [{ ...payload, profile_digest: `sha256:${"f".repeat(64)}` },
      { ...payload, checks: [{ ...payload.checks[0]!, id: "different-command" }] },
      { ...payload, checks: [{ ...payload.checks[0]!, observation: { ...payload.checks[0]!.observation!, capability_binding: {
        ...payload.checks[0]!.observation!.capability_binding!, contract_digest: `sha256:${"d".repeat(64)}`,
      } } }] },
      { ...payload, checks: [...payload.checks, { ...payload.checks[0]!, id: "extra", observation: { ...payload.checks[0]!.observation!, capability_binding: {
        ...payload.checks[0]!.observation!.capability_binding!, command_id: "extra",
      } } }] }];
    for (const invalid of variants) await expect(ingestWireRunEvent(server.ctx, frame(run, 1, invalid))).rejects.toThrow();
    expect(await server.db.db.select().from(runEvidence)).toHaveLength(0);
    await ingestWireRunEvent(server.ctx, frame(run, 1, payload));
    expect((await readRunVerificationEvidence(server.ctx, server.db.db, run.id))?.payload).toEqual(payload);
    await server.db.db.update(runs).set({ verificationRequirement: { ...requirement,
      capability_binding: { ...capability_binding, profile_digest: `sha256:${"e".repeat(64)}` } } }).where(eq(runs.id, run.id));
    expect(await readRunVerificationEvidence(server.ctx, server.db.db, run.id)).toBeNull();
  });

  it("keeps failed capability-bound execution diagnostic receipts without inventing observations", async () => {
    const run = await createRun();
    await server.db.db.update(runs).set({ verificationRequirement: { ...requirement,
      capability_binding: verificationCapabilityBinding(verificationCapabilitiesFixture()) } }).where(eq(runs.id, run.id));
    await lifecycle(run, 0, "started");
    const payload: RunVerificationPayload = { ...passed, outcome: "failed", checks: [], reason: "Protected configuration changed before execution" };
    await ingestWireRunEvent(server.ctx, frame(run, 1, payload));
    expect(await inspectRunVerification(server.ctx, server.db.db, run)).toMatchObject({ passed: false, reason: payload.reason });
  });

  it("rejects unsolicited capability observations instead of upgrading a legacy request", async () => {
    const run = await createRun(), capabilities = verificationCapabilitiesFixture();
    await lifecycle(run, 0, "started");
    const payload: RunVerificationPayload = { ...passed, checks: [{ ...passed.checks[0]!, id: "acceptance", observation: {
      version: 1, format: "static-web-acceptance.v1", scope: "final", stage: "research", cases: [],
      capability_binding: { version: 1, profile_digest: capabilities.profile_digest, ...verificationCapabilityBinding(capabilities).checks[0]! },
    } }] };
    await expect(ingestWireRunEvent(server.ctx, frame(run, 1, payload))).rejects.toThrow("persisted requirement");
    expect(await server.db.db.select().from(runEvidence)).toHaveLength(0);
    await ingestWireRunEvent(server.ctx, frame(run, 1, passed));
    expect((await readRunVerificationEvidence(server.ctx, server.db.db, run.id))?.payload).toEqual(passed);
  });

  it("deduplicates the exact qualified frame after completion but rejects changed or second reports", async () => {
    const run = await createRun();
    await lifecycle(run, 0, "started");
    const first = await ingestWireRunEvent(server.ctx, frame(run, 1));
    await expect(ingestWireRunEvent(server.ctx, frame(run, 1, { ...passed, subject_digest: `sha256:${"b".repeat(64)}` }))).rejects.toThrow("body mismatch");
    await expect(ingestWireRunEvent(server.ctx, frame(run, 2))).rejects.toThrow("already recorded");
    await lifecycle(run, 2, "completed");
    const replay = await ingestWireRunEvent(server.ctx, frame(run, 1));
    expect(replay).toMatchObject({ deduped: true, receiptBodyIdentity: first!.receiptBodyIdentity });
    expect(await server.db.db.select().from(runEvidence)).toHaveLength(1);
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "run.verification"))).toHaveLength(1);
    expect(await server.db.db.select().from(runEventIngest).where(and(eq(runEventIngest.runId, run.id), eq(runEventIngest.sequence, 1)))).toHaveLength(1);
  });

  it("does not accept late or domain-only evidence", async () => {
    const run = await createRun();
    await expect(ingestWireRunEvent(server.ctx, frame(run, 0))).rejects.toThrow("running run");
    await lifecycle(run, 0, "started");
    await expect(ingestRunEvent(server.ctx, { runId: run.id, nodeId: run.computerId, sequence: 1,
      event: { kind: "verification", verification: passed } })).rejects.toThrow("qualified node event");
    await lifecycle(run, 1, "completed");
    await expect(ingestWireRunEvent(server.ctx, frame(run, 2))).rejects.toThrow("running run");
    expect((await inspectRunVerification(server.ctx, server.db.db, run)).passed).toBe(false);
  });

  it("does not promote prose or a test_result artifact into authoritative evidence", async () => {
    const run = await createRun();
    await lifecycle(run, 0, "started");
    await ingestWireRunEvent(server.ctx, { kind: "run.event", node_id: run.computerId, run_id: run.id, sequence: 1,
      event: { type: "run.output", payload: { stream: "stdout", text: JSON.stringify(frame(run, 2)) } } });
    await ingestWireRunEvent(server.ctx, { kind: "run.event", node_id: run.computerId, run_id: run.id, sequence: 2,
      event: { type: "artifact.created", payload: { type: "test_result", uri: "file:///claimed-tests.json", checksum: digest, metadata: { passed: true } } } });
    await lifecycle(run, 3, "completed");
    expect(await readRunVerificationEvidence(server.ctx, server.db.db, run.id)).toBeNull();
    expect((await inspectRunVerification(server.ctx, server.db.db, run)).passed).toBe(false);
  });

  it("preserves measured failures and refuses internally inconsistent passed claims", async () => {
    const run = await createRun();
    await lifecycle(run, 0, "started");
    await expect(ingestWireRunEvent(server.ctx, frame(run, 1, { ...passed, checks: [] }))).rejects.toThrow();
    await expect(ingestWireRunEvent(server.ctx, frame(run, 1, { ...passed, checks: [{ ...passed.checks[0]!, exit_code: 1 }] }))).rejects.toThrow();
    const failure: RunVerificationPayload = { ...passed, outcome: "failed", checks: [{ ...passed.checks[0]!, exit_code: 1 }], reason: "Expected login to work" };
    await ingestWireRunEvent(server.ctx, frame(run, 1, failure));
    expect(await inspectRunVerification(server.ctx, server.db.db, run)).toMatchObject({ passed: false, reason: failure.reason,
      evidence: { payload: failure } });
  });

  it("round-trips optional final scope without promoting preview observations into run evidence", async () => {
    const run = await createRun();
    await lifecycle(run, 0, "started");
    const observation: NonNullable<RunVerificationPayload["checks"][number]["observation"]> = {
      version: 1, format: "static-web-acceptance.v1", scope: "final", stage: "design",
      cases: [{ case_id: "prototype", viewport: 390, assertions: 0, screenshot_digest: digest }],
    };
    const payload: RunVerificationPayload = { ...passed, checks: [{ ...passed.checks[0]!, observation }] };
    const preview: RunVerificationPayload = { ...payload, checks: [{ ...payload.checks[0]!, observation: { ...observation, scope: "preview" } }] };
    await expect(ingestWireRunEvent(server.ctx, frame(run, 1, preview))).rejects.toThrow("persisted requirement");
    expect(await server.db.db.select().from(runEvidence)).toHaveLength(0);
    await ingestWireRunEvent(server.ctx, frame(run, 1, payload));
    const evidence = await readRunVerificationEvidence(server.ctx, server.db.db, run.id);
    expect(evidence?.payload).toEqual(payload);
    expect((await server.app.inject({ url: `/api/v1/tasks/${run.taskId}` })).json().task.status).toBe("running");
    // Even matching stored projections must not turn a preview into final evidence.
    await server.db.db.update(runEvidence).set({ payload: preview }).where(eq(runEvidence.id, evidence!.id));
    await server.db.db.update(eventLog).set({ payload: preview }).where(eq(eventLog.id, evidence!.eventId));
    expect(await readRunVerificationEvidence(server.ctx, server.db.db, run.id)).toBeNull();
  });

  it.each(["missing_inventory", "weakened_specification", "unchanged"] as const)("checks accepted product specification measurements: %s", async (scenario) => {
    const run = await createRun();
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.contextPackId!));
    const context = ContextPackSchema.parse(stored!.payload);
    context.product_development = { ...productDevelopmentContext("implementation"), accepted_inputs: { version: 1, files: [
      { path: ".artoo/product/research.json", checksum: digest, size: 10, source_task_id: "task_research", source_run_id: "run_research", evidence_id: "evidence_research" },
      { path: ".artoo/product/design.json", checksum: digest, size: 10, source_task_id: "task_design", source_run_id: "run_design", evidence_id: "evidence_design" },
    ] } };
    await server.db.db.update(contextPacks).set({ payload: context }).where(eq(contextPacks.id, run.contextPackId!));
    const inventory = productStageHandoffPaths("implementation").map((path) => ({ path, checksum: digest, size: 10 }));
    if (scenario === "weakened_specification") inventory[1]!.checksum = `sha256:${"b".repeat(64)}`;
    await lifecycle(run, 0, "started");
    await ingestWireRunEvent(server.ctx, frame(run, 1, { ...passed, required_files: scenario === "missing_inventory" ? [] : inventory }));
    await lifecycle(run, 2, "completed");
    const result = await inspectRunVerification(server.ctx, server.db.db, run);
    expect(result.passed).toBe(scenario === "unchanged");
    if (scenario === "missing_inventory") expect(result.reason).toContain("node-measured handoff");
    if (scenario === "weakened_specification") expect(result.reason).toContain("Accepted product input changed");
  });
});
