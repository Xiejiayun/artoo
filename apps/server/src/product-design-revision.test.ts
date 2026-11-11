import { agentInstances, agentRuntimes, agents, appendEvent, artifacts, assistantTurns, autonomousReviews, computers,
  contextPacks, eventLog, goalAutomations, goals, messages, plans, productDesignRevisions, productDesignRevisionRuns,
  rooms, runEvidence, runs, tasks } from "@artoo/db";
import { ContextPackSchema, GoalBudgetsSchema, ProductDesignV2Schema, ProductResearchReportV2Schema, TaskSpecSchema,
  productDevelopmentContext, productStageHandoffPaths, type ContextPack, type DevelopmentStage, type RunVerificationPayload,
  type ProductDesignV2, RunVerificationPayloadSchema, IndependentReviewVerdictSchema } from "@artoo/domain";
import { and, eq } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "@artoo/storage";
import type { ServerContext } from "./context.js";
import * as contentStore from "./content-addressed-blob.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { buildEvent } from "./events.js";
import { writeContentAddressedBlob } from "./content-addressed-blob.js";
import { verificationCapabilitiesV3Fixture } from "./test-fixtures/verification-capabilities.js";
import { MemoryArtifactStore } from "./test-fixtures/memory-artifact-store.js";
import { verificationCapabilityBinding } from "./services/verification-capabilities.js";
import { requestProductDesignRevision } from "./services/product-design-revision-service.js";
import { assertDesignRevisionAssignment, assertDesignRevisionRunAdmission, assertNoActiveDesignRevision,
  bindDesignRevisionRun, designRevisionContextForRun, designRevisionDescriptorDigest, designRevisionDigest,
  latestDesignRevision, prepareDesignRevisionAcceptance, readDesignRevisionFile } from "./services/product-design-revision-guard.js";
import { buildRunContextPack } from "./services/context-pack-service.js";
import { readRunVerificationEvidence } from "./services/verification-service.js";
import { inspectIndependentReview } from "./services/independent-review-service.js";
import { reviewTask } from "./services/lifecycle-service.js";

const organizationId = "org_default", projectId = "proj_artoo", computerId = "computer_local_mock", author = "instance_mock_coder", reviewer = "revision_peer";
const old = "2026-06-12T00:00:00.000Z", root = "C:\\Controlled Revision Workspace", sha = designRevisionDigest;
const request = { version: 1 as const, kind: "add-validation-cases" as const, reason: "Cover the reported count regression", requirement_criteria: [{ requirement_id: "journal", criterion_index: 0 }] };

/** Controlled node-event / database fixtures. No model, browser, native execution, or publication is performed. */
describe("local independently qualified additive design revision", () => {
  let server: TestServer, directory: string;
  const capabilities = verificationCapabilitiesV3Fixture();
  capabilities.measurement_plan_policy = { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] };
  const selected = capabilities.checks[0]!, binding = verificationCapabilityBinding(capabilities);
  const research = ProductResearchReportV2Schema.parse({ version: 1, objective: "Journal", assumptions: [],
    requirements: [{ id: "journal", description: "Render journal", priority: "must", acceptance_criteria: ["Render the entry count"] }],
    sources: [{ id: "source", url: "https://example.com/spec", title: "Controlled source", retrieved_at: old, content_digest: sha("source") }],
    findings: [{ summary: "Entry count is required", source_ids: ["source"] }], decisions: [],
    measurement_plan: { version: 2, profile_digest: capabilities.profile_digest, entries: [{ method: "workspace-check", requirement_id: "journal", criterion_index: 0,
      command_id: selected.command_id, config_digest: selected.config_digest, contract_digest: selected.contract_digest,
      actions: ["navigate", "assert_count"], keys: [], viewports: selected.contract.viewports, needs: [] }] } });
  const design = ProductDesignV2Schema.parse({ version: 2, requirement_ids: ["journal"], information_architecture: ["Journal"],
    user_flows: [{ id: "view", name: "View", requirement_ids: ["journal"], steps: ["Read entry count"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Entries", states: ["Empty", "Full"], accessibility: ["Named controls"], responsive: ["Responsive"] }],
    prototype: { entrypoint: "product/index.html", description: "Journal" }, data_model: [], api_contracts: [], decisions: [{ decision: "Show count", rationale: "User requirement" }],
    validation_cases: [{ id: "old_case", method: "workspace-check", requirement_ids: ["journal"], requirement_criteria: request.requirement_criteria,
      procedure: ["Count entries"], expected_result: "One entry", browser_program: { version: 3, contract_digest: selected.contract_digest,
        steps: [{ action: "navigate", page: "main", path: "/" }, { action: "assert_count", page: "main", selector: ".entry", count: 1 }] } }] });
  let researchPin: { path: ".artoo/product/research.json"; checksum: string; size: number; source_task_id: string; source_run_id: string; evidence_id: string };
  let designPin: { path: ".artoo/product/design.json"; checksum: string; size: number; source_task_id: string; source_run_id: string; evidence_id: string };
  const atomic = () => ({ ...server.ctx, automationActor: { type: "system" as const, id: "goal_runner" as const } });
  const getRun = async (id: string) => (await server.db.db.select().from(runs).where(eq(runs.id, id)))[0]!;
  const getTask = async (id: string) => (await server.db.db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const createRevision = () => server.db.transaction(tx => requestProductDesignRevision(atomic(), tx,
    { goalId: "goal_revision", implementationTaskId: "implementation", implementationRunId: "implementation_old", requestingReviewId: "review_implementation_old" }));

  async function retain(runId: string, path: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n"), run = await getRun(runId), checksum = sha(bytes);
    await writeContentAddressedBlob(directory, bytes);
    await server.db.db.insert(artifacts).values({ id: `artifact_${runId}_${path.includes("research") ? "research" : "design"}`, organizationId, taskId: run.taskId, runId,
      type: "report", uri: "controlled://content", checksum, metadata: { storage_key: checksum.slice(7), size: bytes.length, computer_id: computerId }, createdAt: old });
    return { path, checksum, size: bytes.length };
  }
  function context(stage: DevelopmentStage, taskId: string): ContextPack {
    return ContextPackSchema.parse({ task: { id: taskId, title: stage, description: "Controlled fixture", acceptance_criteria: ["Deliver"] },
      project: { id: projectId, name: "Fixture", default_workspace: root }, workspace: { root, file_scope: [] }, policy: { filesystem_write_scope: [root], requires_approval: [] },
      memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] }, verification_capabilities: { ...capabilities, profile_id: "default" },
      goal_context: { version: 1, goal_id: "goal_revision", objective: "Journal", acceptance_criteria: ["Render count"], plan: { id: "plan_revision", version: 1, rationale: "Fixture", spec_ref: String(["research", "design", "implementation", "validation"].indexOf(stage)) } },
      product_development: { ...productDevelopmentContext(stage), accepted_inputs: { version: 1, files: stage === "research" ? [] : stage === "design" ? [researchPin] : [researchPin, designPin] } } });
  }
  async function storeRun(runId: string, taskId: string, pack: ContextPack, status = "completed", instanceId = author) {
    const requirement = { version: 1, request_id: `verify_${runId}`, profile_id: "default", capability_binding: binding,
      ...(pack.review_subject ? { expected_subject_digest: pack.review_subject.subject_digest } : {}) };
    await server.db.db.insert(contextPacks).values({ id: `pack_${runId}`, organizationId, taskId, runId, payload: pack, sourceMemoryIds: [], createdAt: old });
    await server.db.db.insert(runs).values({ id: runId, organizationId, taskId, computerId, agentInstanceId: instanceId, runtimeId: "codex", status,
      contextPackId: `pack_${runId}`, workspaceRoot: root, verificationRequirement: requirement, requestedByUserId: "user_owner",
      aiDataSharingPolicyVersion: server.ctx.aiDataSharingPolicy!.version, createdAt: runId.endsWith("_old") || runId.startsWith("peer_") ? old : server.ctx.clock.nowIso() });
    return getRun(runId);
  }
  function measured(runId: string, stage: DevelopmentStage, currentDesign = design, revision?: ContextPack["product_design_revision"]): RunVerificationPayload {
    const cases = stage === "research" ? [] : currentDesign.validation_cases.filter(test => test.method === "workspace-check").flatMap(test =>
      selected.contract.viewports.map((viewport, index) => ({ case_id: test.id, viewport, program_digest: sha(JSON.stringify({})), assertions: 1, operation_count: 2,
        trace_digest: sha("trace"), trace_size: 10, trace_ref: `trace_${test.id}_${index}`, captures: [{ page_id: "main", timing: { kind: "case-end" }, screenshot_digest: sha("image"), screenshot_ref: `image_${test.id}_${index}` }] })));
    // The production canonicalization, not the fixture's display serialization, binds programs.
    for (const item of cases) { const test = currentDesign.validation_cases.find(test => test.id === item.case_id)!;
      if (test.method === "workspace-check") item.program_digest = sha(canonical(test.browser_program)); }
    const designFact = revision ? { path: designPin.path, checksum: sha(Buffer.from(JSON.stringify(currentDesign, null, 2) + "\n")), size: Buffer.byteLength(JSON.stringify(currentDesign, null, 2) + "\n") } : designPin;
    const files = productStageHandoffPaths(stage).map(path => path === researchPin.path ? { path, checksum: researchPin.checksum, size: researchPin.size }
      : path === designPin.path ? { path, checksum: designFact.checksum, size: designFact.size } : { path, checksum: sha(path), size: 10 });
    return RunVerificationPayloadSchema.parse({ version: 1, request_id: `verify_${runId}`, profile_id: "default", profile_digest: capabilities.profile_digest,
      subject_digest: sha(revision ? "new source" : "old source"), outcome: "passed", required_files: files,
      checks: [{ id: "acceptance", exit_code: 0, duration_ms: 1, output_digest: sha("output"), observation: { version: 3, format: "static-web-acceptance.v3", scope: "final", stage,
        device_scale_factor: 1, capability_binding: { version: 1, profile_digest: capabilities.profile_digest, ...binding.checks[0] }, cases,
        evidence_bundle: { bundle_id: `bundle_${runId}`, manifest_digest: sha("manifest") } } }],
      measurement_plan: { version: 2, claim: "declared-mapping-feasibility", scope: "final", policy: capabilities.measurement_plan_policy,
        research: { path: researchPin.path, checksum: researchPin.checksum, size: researchPin.size }, measurement_plan_digest: sha(JSON.stringify(research.measurement_plan)),
        must_criterion_count: 1, mapped_criterion_count: 1, workspace_criterion_count: 1, release_criterion_count: 0, pending_release: [], used_checks: binding.checks },
      ...(revision ? { product_design_revision: { version: 1, revision_id: revision.revision_id, scope: "all-declared-workspace-design-cases",
        descriptor_digest: designRevisionDescriptorDigest(revision), baseline_checksum: revision.baseline.design.checksum, revised_design: designFact } } : {}) });
  }
  async function evidence(runId: string, payload: RunVerificationPayload) {
    const run = await getRun(runId), event = buildEvent(server.ctx, { type: "run.verification", actorType: "system", actorId: computerId,
      correlationId: runId, taskId: run.taskId, runId, payload });
    await appendEvent(server.db.db, event);
    await server.db.db.insert(runEvidence).values({ id: `evidence_${runId}`, organizationId, runId, requestId: payload.request_id, payload, eventId: event.id, createdAt: old });
  }
  async function review(runId: string, outcome: "accepted" | "changes_requested", currentDesign = design, revision?: ContextPack["product_design_revision"]) {
    const subject = await getRun(runId), source = (await readRunVerificationEvidence(server.ctx, server.db.db, runId))!;
    expect(source).toBeTruthy();
    const stage = (await designRevisionContextForRun(server.ctx, server.db.db, runId))!.product_development!.stage;
    const taskId = `review_task_${runId}`, peerRunId = `peer_${runId}`, turnId = `turn_${runId}`, messageId = `response_${runId}`, rootId = `request_${runId}`;
    await server.db.db.insert(tasks).values({ id: taskId, organizationId, projectId, roomId: "room_revision", title: "Review", status: "done", createdByType: "system", createdById: "goal_runner", createdAt: old, updatedAt: old });
    const pack = context(stage, taskId); delete pack.product_development;
    pack.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    pack.review_subject = { version: 1, task_id: subject.taskId, run_id: runId, evidence_id: source.id, subject_digest: source.payload.subject_digest!, development_stage: stage,
      verification: { version: 1, request_id: source.requestId, profile_id: "default", profile_digest: source.payload.profile_digest,
        measurement_plan: source.payload.measurement_plan, checks: source.payload.checks.map(({ id, output_digest, observation }) => ({ id, output_digest, observation })) } };
    pack.conversation = { room_id: "room_revision", turn_id: turnId, current_request: "Review", messages: [], history_truncated: false };
    if (revision) pack.product_design_revision = revision;
    await storeRun(peerRunId, taskId, pack, "completed", reviewer);
    const verdict = IndependentReviewVerdictSchema.parse({ version: 1, reviewed_run_id: runId, verification_evidence_id: source.id, subject_digest: source.payload.subject_digest,
      outcome, summary: "Controlled review", findings: outcome === "accepted" ? [] : [{ severity: "blocking", description: "Missing count regression coverage" }],
      ...(outcome === "changes_requested" ? { design_revision_request: request } : {}) });
    await server.db.db.insert(messages).values([{ id: rootId, organizationId, roomId: "room_revision", taskId, actorType: "system", actorId: "goal_runner", kind: "text", body: "Review", createdAt: old },
      { id: messageId, organizationId, roomId: "room_revision", taskId, runId: peerRunId, actorType: "agent", actorId: reviewer, kind: "text", body: JSON.stringify(verdict), createdAt: old }]);
    await server.db.db.insert(assistantTurns).values({ id: turnId, organizationId, roomId: "room_revision", taskId, actorUserId: "user_owner", clientRequestId: turnId,
      agentInstanceId: reviewer, userMessageId: rootId, status: "completed", runId: peerRunId, responseMessageId: messageId, aiDataSharingPolicyVersion: server.ctx.aiDataSharingPolicy!.version, createdAt: old, updatedAt: old });
    await server.db.db.insert(autonomousReviews).values({ id: `review_${runId}`, organizationId, goalId: "goal_revision", taskId: subject.taskId, subjectRunId: runId,
      evidenceId: source.id, subjectDigest: source.payload.subject_digest!, reviewerInstanceId: reviewer, reviewTaskId: taskId, turnId, status: outcome, createdAt: old, updatedAt: old });
    await evidence(peerRunId, measured(peerRunId, stage, currentDesign, revision));
    return { runId: peerRunId, payload: (await readRunVerificationEvidence(server.ctx, server.db.db, peerRunId))!.payload, reviewId: `review_${runId}` };
  }
  function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "artoo-design-revision-")); server = await buildTestServer({ workspaceRoot: root, artifactDir: directory });
    server.ctx.productSourceArtifactDir = directory;
    await server.db.db.update(agentInstances).set({ runtime: "codex" });
    await server.db.db.update(agentRuntimes).set({ runtime: "codex" });
    await server.db.db.update(agents).set({ capabilities: ["code.read", "code.modify", "code.review"] });
    const [a] = await server.db.db.select().from(agents), [i] = await server.db.db.select().from(agentInstances);
    await server.db.db.insert(agents).values({ ...a!, id: "revision_peer_agent" });
    await server.db.db.insert(agentInstances).values({ ...i!, id: reviewer, agentId: "revision_peer_agent" });
    server.ctx.supportsExecutionFeature = () => true; server.ctx.supportsVerificationProfile = () => true;
    server.ctx.getVerificationCapabilities = () => structuredClone(capabilities);
    await server.db.db.insert(goals).values({ id: "goal_revision", organizationId, projectId, ownerUserId: "user_owner", title: "Journal", objective: "Journal", status: "running",
      budgets: GoalBudgetsSchema.parse({ max_retries: 4 }), currentPlanId: "plan_revision", createdAt: old, updatedAt: old });
    await server.db.db.insert(rooms).values({ id: "room_revision", organizationId, projectId, goalId: "goal_revision", type: "goal", name: "Revision", createdAt: old });
    await server.db.db.update(goals).set({ roomId: "room_revision" });
    const stages = ["research", "design", "implementation", "validation"] as const;
    await server.db.db.insert(plans).values({ id: "plan_revision", organizationId, goalId: "goal_revision", version: 1, authorType: "system", authorId: "goal_runner", status: "accepted",
      taskSpecs: stages.map(stage => TaskSpecSchema.parse({ title: stage, development_stage: stage, acceptance_criteria: ["Deliver"], required_capabilities: ["code.modify"] })), createdAt: old });
    await server.db.db.insert(goalAutomations).values({ goalId: "goal_revision", organizationId, actorUserId: "user_owner", policyVersion: server.ctx.aiDataSharingPolicy!.version, status: "executing",
      planId: "plan_revision", agentInstanceId: author, computerId, workspaceRoot: root, verificationProfileId: "default", executionMode: "agent_team", createdAt: old, updatedAt: old,
      team: { version: 1, members: stages.map(stage => ({ stage, agent_instance_id: stage === "research" || stage === "validation" ? reviewer : author })), reviewer_instance_ids: [author, reviewer] } });
    for (const [index, stage] of stages.entries()) await server.db.db.insert(tasks).values({ id: stage, organizationId, projectId, goalId: "goal_revision", sourcePlanId: "plan_revision",
      sourcePlanSpecRef: String(index), roomId: "room_revision", title: stage, status: stage === "implementation" ? "review" : stage === "validation" ? "backlog" : "done",
      acceptanceCriteria: ["Deliver"], createdByType: "system", createdById: "goal_runner", createdAt: old, updatedAt: old });
    researchPin = { path: ".artoo/product/research.json", checksum: sha(Buffer.from(JSON.stringify(research, null, 2) + "\n")), size: Buffer.byteLength(JSON.stringify(research, null, 2) + "\n"), source_task_id: "research", source_run_id: "research_old", evidence_id: "evidence_research_old" };
    designPin = { path: ".artoo/product/design.json", checksum: sha(Buffer.from(JSON.stringify(design, null, 2) + "\n")), size: Buffer.byteLength(JSON.stringify(design, null, 2) + "\n"), source_task_id: "design", source_run_id: "design_old", evidence_id: "evidence_design_old" };
    for (const stage of ["research", "design", "implementation"] as const) { await storeRun(`${stage}_old`, stage, context(stage, stage)); await evidence(`${stage}_old`, measured(`${stage}_old`, stage)); }
    await retain("research_old", researchPin.path, research); await retain("design_old", designPin.path, design);
    await review("design_old", "accepted"); await review("implementation_old", "changes_requested");
  });
  afterEach(async () => { await server?.close(); if (directory) { const target = resolve(directory), parent = resolve(tmpdir()) + sep;
    if (!target.startsWith(parent) || !target.split(sep).at(-1)!.startsWith("artoo-design-revision-")) throw new Error("Unsafe cleanup target"); await rm(target, { recursive: true, force: true }); } });

  it("records exact raw baseline, reopens the original task and debits the shared retry once across duplicate requests", async () => {
    const before = await server.db.db.select().from(runEvidence), [revision, duplicate] = await Promise.all([createRevision(), createRevision()]);
    expect(duplicate.id).toBe(revision.id); expect((await getTask("design")).status).toBe("ready"); expect((await getTask("implementation")).status).toBe("ready");
    expect((await server.db.db.select().from(goals))[0]!.retryCount).toBe(1);
    expect((revision.intent as { baseline: { design: { text: string } } }).baseline.design.text).toBe(JSON.stringify(design, null, 2) + "\n");
    expect(await server.db.db.select().from(runEvidence)).toEqual(before);
    expect(await server.db.db.select().from(productDesignRevisions)).toHaveLength(1);
  });
  it("rolls back the immutable intent and both task effects when the retry budget is exhausted", async () => {
    await server.db.db.update(goals).set({ budgets: GoalBudgetsSchema.parse({ max_retries: 0 }) });
    await expect(createRevision()).rejects.toThrow("retry budget"); expect(await server.db.db.select().from(productDesignRevisions)).toHaveLength(0);
    expect((await getTask("design")).status).toBe("done"); expect((await getTask("implementation")).status).toBe("review");
  });
  it("binds raw reviewer response bytes while allowing the typed reason's documented whitespace normalization", async () => {
    const [response] = await server.db.db.select().from(messages).where(eq(messages.id, "response_implementation_old"));
    const raw = JSON.stringify({ ...JSON.parse(response!.body), design_revision_request: { ...request, reason: `  \n${request.reason}\t ` } });
    await server.db.db.update(messages).set({ body: raw }).where(eq(messages.id, response!.id));
    const revision = await createRevision(), intent = revision.intent as { request: typeof request; requesting_review: { response_digest: string } };
    expect(intent.request.reason).toBe(request.reason); expect(intent.requesting_review.response_digest).toBe(sha(raw));
  });
  it("rejects a substantive request change during retained baseline reads and rolls back all effects", async () => {
    const originalRead = contentStore.readContentAddressedBlob;
    await expect(server.db.transaction(async tx => {
      let changed = false;
      const [response] = await tx.select().from(messages).where(eq(messages.id, "response_implementation_old"));
      const hook = vi.spyOn(contentStore, "readContentAddressedBlob").mockImplementation(async (...args) => {
        const bytes = await originalRead(...args);
        if (!changed && args[1] === designPin.checksum) {
          changed = true;
          await tx.update(messages).set({ body: JSON.stringify({ ...JSON.parse(response!.body), design_revision_request: { ...request, reason: "A different substantive regression request" } }) }).where(eq(messages.id, response!.id));
        }
        return bytes;
      });
      try { return await requestProductDesignRevision(atomic(), tx, { goalId: "goal_revision", implementationTaskId: "implementation",
        implementationRunId: "implementation_old", requestingReviewId: "review_implementation_old" }); } finally { hook.mockRestore(); }
    })).rejects.toThrow("requesting response changed during content retrieval");
    expect(await server.db.db.select().from(productDesignRevisions)).toHaveLength(0); expect((await getTask("design")).status).toBe("done");
    expect((await server.db.db.select().from(goals))[0]!.retryCount).toBe(0);
  });
  it.each(["missing", "substituted"])("rejects %s actual baseline content before reopening or charging", async change => {
    const file = join(directory, designPin.checksum.slice(7));
    if (change === "missing") await rm(file); else await writeFile(file, "x".repeat(designPin.size));
    await expect(createRevision()).rejects.toMatchObject({ code: "conflict", httpStatus: 409, message: expect.stringContaining("Retained product bytes") });
    expect((await getTask("design")).status).toBe("done");
    expect((await server.db.db.select().from(goals))[0]!.retryCount).toBe(0);
  });
  it("propagates remote storage failures without misclassifying or charging a design revision", async () => {
    const read = vi.fn();
    server.ctx.artifactStore = { read, write: vi.fn() };
    for (const error of [new Error("Supabase Storage read timed out"), new Error("Supabase Storage read failed (HTTP 403)")]) {
      read.mockRejectedValueOnce(error);
      await expect(createRevision()).rejects.toBe(error);
      expect(await server.db.db.select().from(productDesignRevisions)).toHaveLength(0);
      expect((await getTask("design")).status).toBe("done");
      expect((await server.db.db.select().from(goals))[0]!.retryCount).toBe(0);
    }
  });
  it("rejects invalid JSON and UTF-8 after a successful retained-content read", async () => {
    const artifactStore = new MemoryArtifactStore(), run = await getRun("design_old");
    for (const bytes of [Buffer.from('{"unfinished":'), Buffer.from([0xff])]) {
      const checksum = sha(bytes), pin = { path: designPin.path, checksum, size: bytes.length };
      await artifactStore.write(bytes);
      await server.db.db.update(artifacts).set({ checksum,
        metadata: { storage_key: checksum.slice(7), size: bytes.length, computer_id: computerId } }).where(eq(artifacts.runId, run.id));
      await expect(readDesignRevisionFile({ ...server.ctx, artifactStore }, server.db.db, run, pin)).rejects.toMatchObject({
        code: "conflict", httpStatus: 409, message: expect.stringContaining("Retained product bytes") });
    }
  });
  it.each(["manual", "paused", "prototype-only", "old-node", "changed-response"])("fails closed on %s authority or capability", async change => {
    if (change === "manual") { await expect(server.db.transaction(tx => requestProductDesignRevision(server.ctx, tx,
      { goalId: "goal_revision", implementationTaskId: "implementation", implementationRunId: "implementation_old", requestingReviewId: "review_implementation_old" }))).rejects.toThrow("Only the original"); return; }
    if (change === "paused") await server.db.db.update(goals).set({ status: "paused" });
    if (change === "prototype-only") server.ctx.getVerificationCapabilities = () => { const copy = structuredClone(capabilities); copy.checks[0]!.contract.stage_policy.design = "prototype-only"; return copy; };
    if (change === "old-node") server.ctx.supportsExecutionFeature = () => false;
    if (change === "changed-response") await server.db.db.update(messages).set({ body: "Use prose as permission" }).where(eq(messages.id, "response_implementation_old"));
    await expect(createRevision()).rejects.toThrow(); expect(await server.db.db.select().from(productDesignRevisions)).toHaveLength(0);
  });
  it("rejects live/uncertain workspace occupants and keeps queued historical contexts fenced after creation", async () => {
    await storeRun("old_queued_validation", "validation", context("validation", "validation"), "queued");
    await expect(createRevision()).rejects.toThrow("processes, leases and uncertain closures");
    await server.db.db.update(runs).set({ status: "failed", failureReason: "daemon_disconnect" }).where(eq(runs.id, "old_queued_validation"));
    await expect(createRevision()).rejects.toThrow("uncertain closures");
    await server.db.db.update(runs).set({ failureReason: "controlled_closed" }).where(eq(runs.id, "old_queued_validation"));
    await createRevision();
    for (const id of ["design_old", "implementation_old", "old_queued_validation", "peer_design_old"])
      await expect(assertDesignRevisionRunAdmission(atomic(), server.db.db, await getRun(id), { live: true })).rejects.toThrow();
    await expect(assertNoActiveDesignRevision(atomic(), server.db.db, "goal_revision")).rejects.toThrow("Publication");
    await expect(assertDesignRevisionAssignment(atomic(), server.db.db, await getTask("implementation"),
      { instanceId: author, computerId, workspaceRoot: root, capabilities })).rejects.toThrow("other stages");
  });
  it("prevents direct mutation/deletion of the recorded request and baseline", async () => {
    const revision = await createRevision();
    await expect(server.db.db.update(productDesignRevisions).set({ actorUserId: "other" }).where(eq(productDesignRevisions.id, revision.id))).rejects.toThrow();
    await expect(server.db.db.delete(productDesignRevisions).where(eq(productDesignRevisions.id, revision.id))).rejects.toThrow();
    await expect(server.db.db.update(productDesignRevisions).set({ state: "accepted" }).where(eq(productDesignRevisions.id, revision.id))).rejects.toThrow();
  });
  it("accepts only the bound revised author and independent peer, settles atomically and repins downstream contexts", async () => {
    const revision = await createRevision(), newDesign = structuredClone(design);
    newDesign.validation_cases.push({ ...structuredClone(design.validation_cases[0]!), id: "new_regression" });
    const runId = "revision_author", task = await getTask("design");
    await server.db.transaction(async tx => {
      const pack = await buildRunContextPack(atomic(), tx, { runId, task, workspaceRoot: root, verification: { profile_id: "default", capabilities } });
      await tx.update(tasks).set({ status: "assigned" }).where(eq(tasks.id, "design"));
      await tx.insert(runs).values({ id: runId, organizationId, taskId: "design", computerId, agentInstanceId: author, runtimeId: "codex", status: "queued", contextPackId: pack.contextPackId,
        workspaceRoot: root, requestedByUserId: "user_owner", aiDataSharingPolicyVersion: server.ctx.aiDataSharingPolicy!.version,
        verificationRequirement: { version: 1, request_id: `verify_${runId}`, profile_id: "default", capability_binding: binding }, createdAt: server.ctx.clock.nowIso() });
      await bindDesignRevisionRun(atomic(), tx, runId);
    });
    const pack = (await designRevisionContextForRun(server.ctx, server.db.db, runId))!, descriptor = pack.product_design_revision!;
    expect(descriptor.revision_id).toBe(revision.id); expect(pack.product_development!.accepted_inputs!.files).toEqual([researchPin]);
    await expect(assertDesignRevisionRunAdmission(atomic(), server.db.db, await getRun(runId), { live: true })).resolves.toBeUndefined();
    const runBinding = (await server.db.db.select().from(productDesignRevisionRuns))[0]!;
    await expect(server.db.db.update(productDesignRevisionRuns).set({ descriptorDigest: sha("substituted") }).where(eq(productDesignRevisionRuns.runId, runId))).rejects.toThrow();
    expect(runBinding.descriptorDigest).toBe(designRevisionDescriptorDigest(descriptor));
    await retain(runId, designPin.path, newDesign); const payload = measured(runId, "design", newDesign, descriptor); await evidence(runId, payload);
    await server.db.db.update(runs).set({ status: "completed" }).where(eq(runs.id, runId)); await server.db.db.update(tasks).set({ status: "review" }).where(eq(tasks.id, "design"));
    const peer = await review(runId, "accepted", newDesign, descriptor), source = (await readRunVerificationEvidence(server.ctx, server.db.db, runId))!;
    expect((await inspectIndependentReview(server.ctx, server.db.db, await getRun(runId), source)).status).toBe("accepted");
    const missing = structuredClone(peer.payload); delete missing.product_design_revision;
    await expect(prepareDesignRevisionAcceptance(atomic(), server.db.db, await getRun(runId), payload, { ...peer, payload: missing })).rejects.toThrow("attestation differs");
    const partial = structuredClone(peer.payload); partial.checks[0]!.observation!.cases.pop();
    await expect(prepareDesignRevisionAcceptance(atomic(), server.db.db, await getRun(runId), payload, { ...peer, payload: partial })).rejects.toThrow("every declared case");
    const originalRead = contentStore.readContentAddressedBlob;
    await expect(server.db.transaction(async tx => {
      let changed = false;
      const [response] = await tx.select().from(messages).where(eq(messages.id, `response_${runId}`));
      const hook = vi.spyOn(contentStore, "readContentAddressedBlob").mockImplementation(async (...args) => {
        const bytes = await originalRead(...args);
        if (!changed && args[1] === payload.product_design_revision!.revised_design.checksum) {
          changed = true;
          await tx.update(messages).set({ body: JSON.stringify({ ...JSON.parse(response!.body), summary: "A concurrent valid but different response" }) }).where(eq(messages.id, response!.id));
        }
        return bytes;
      });
      const bound = { ...atomic(), db: { ...server.db, db: tx, transaction: async <T>(fn: (inner: DrizzleDb) => Promise<T>) => fn(tx) } } as ServerContext;
      try { return await reviewTask(bound, "design", { outcome: "accepted" }); } finally { hook.mockRestore(); }
    })).rejects.toThrow("reviewer changed during retained-content");
    expect((await getTask("design")).status).toBe("review"); expect((await latestDesignRevision(server.ctx, server.db.db, "goal_revision"))!.state).toBe("active");
    await reviewTask(atomic(), "design", { outcome: "accepted" });
    expect((await latestDesignRevision(server.ctx, server.db.db, "goal_revision"))!.state).toBe("accepted"); expect((await getTask("design")).status).toBe("done");
    await expect(assertDesignRevisionRunAdmission(atomic(), server.db.db, await getRun("implementation_old"), { acceptance: true })).rejects.toThrow("superseded design");
    const implementationTask = await getTask("implementation");
    await server.db.transaction(async tx => { const result = await buildRunContextPack(atomic(), tx, { runId: "next_implementation", task: implementationTask, workspaceRoot: root,
      verification: { profile_id: "default", capabilities } }); const [next] = await tx.select().from(contextPacks).where(eq(contextPacks.id, result.contextPackId));
      expect(ContextPackSchema.parse(next!.payload).product_development!.accepted_inputs!.files.find(file => file.path === designPin.path)).toMatchObject({ source_run_id: runId, evidence_id: source.id, checksum: payload.product_design_revision!.revised_design.checksum }); });
    expect((await designRevisionContextForRun(server.ctx, server.db.db, "implementation_old"))!.product_development!.accepted_inputs!.files).toEqual([researchPin, designPin]);
  });
});
