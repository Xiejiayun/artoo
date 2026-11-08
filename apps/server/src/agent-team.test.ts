import { agentInstances, agents, assistantRunDispatches, assistantTurns, autonomousReviews, computers, contextPacks, discussions, eventLog, goalAutomations, goals, runEvidence, runs, tasks } from "@artoo/db";
import { AutonomousPlanningRequestV1Schema, ContextPackSchema, productStageHandoffPaths,
  type ProductReleaseReceipt, type RunVerificationPayload, type VerificationRequirement } from "@artoo/domain";
import type { NodeTransport, RunEventMessage, ServerToNodeMessage } from "@artoo/protocol";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { createGoalAutomationDispatcher, getGoalAutomation, stopAutonomousGoalPlanning } from "./services/goal-automation-service.js";
import { createDiscussionDispatcher } from "./services/discussion-service.js";
import { createAssistantDispatcher } from "./services/assistant-service.js";
import { validatePlanTaskSpecs } from "./services/plan-service.js";
import { failRunDaemonDisconnect, ingestWireRunEvent } from "./services/run-service.js";
import { pauseGoal, resumeGoal } from "./services/goal-service.js";
import { recoverInterruptedRuns } from "./services/execution-recovery-service.js";
import { createGraceWindowManager } from "./ws/grace-window.js";
import { buildRunContextPack } from "./services/context-pack-service.js";
import { verificationCapabilitiesFixture, verificationCapabilitiesV3Fixture } from "./test-fixtures/verification-capabilities.js";
import { verificationCapabilityBinding } from "./services/verification-capabilities.js";
import { releaseAcceptanceFixture } from "./test-fixtures/release-acceptance.js";
import { releaseAcceptanceBindingDigest } from "./services/release-acceptance.js";
import { getGoalProductRelease, ingestProductReleaseReceipt, ingestProductReleaseHealthReport } from "./services/product-release-service.js";
import { randomUUID } from "node:crypto";
import { APPLICATION_VERIFICATION_FEATURE_V1, type ApplicationVerificationObservationV1 } from "@artoo/domain";
import { readRunVerificationEvidence } from "./services/verification-service.js";
import { runStartCommandSchema } from "@artoo/protocol";

const digest = `sha256:${"a".repeat(64)}`, changedDigest = `sha256:${"b".repeat(64)}`;
const specs = ["research", "design", "implementation", "validation"].map((stage, index) => ({
  title: stage, description: `Complete ${stage} with actual deliverables`, development_stage: stage,
  acceptance_criteria: [`The ${stage} deliverable meets the requirement`], required_capabilities: ["code.modify"],
  dependencies: index ? [{ ref: String(index - 1), type: "blocks" }] : [],
}));

describe("Agent Team execution and independent source-bound review", () => {
  let server: TestServer;
  const bindings: NodeBinding[] = [];
  const stop = async () => {};
  const pump = () => createGoalAutomationDispatcher(server.ctx, stop).pump();
  const taskRows = (goalId: string) => server.db.db.select().from(tasks).where(eq(tasks.goalId, goalId)).orderBy(asc(tasks.sourcePlanSpecRef));
  beforeEach(async () => {
    server = await buildTestServer({ workspaceRoot: "/workspace/team" });
    // Controlled authenticated-node/provider fixtures. This suite does not call a live model.
    await server.db.db.update(computers).set({ os: "linux" });
    await server.db.db.update(agentInstances).set({ runtime: "codex" });
    await server.db.db.update(agents).set({ capabilities: ["code.read", "code.modify", "code.review", "research.web"] });
    const [agent] = await server.db.db.select().from(agents), [instance] = await server.db.db.select().from(agentInstances);
    await server.db.db.insert(agents).values({ ...agent!, id: "agent_specialist", kind: "reviewer" });
    await server.db.db.insert(agentInstances).values({ ...instance!, id: "instance_specialist", agentId: "agent_specialist" });
    server.ctx.supportsExecutionFeature = (_node, feature) => ["run-verification.v1", "product-stage-verification.v1"].includes(feature);
    server.ctx.supportsVerificationProfile = (node, profile, project, root) => node === "computer_local_mock"
      && profile === "default" && project === "proj_artoo" && root === "/workspace/team";
  });
  afterEach(async () => { for (const binding of bindings.splice(0)) binding.close(); await server.close(); });

  function reconnect(root = "/workspace/team", nodeOs?: string,
    additionalProfiles: Array<{ profile_id: string; project_id: string; workspace_root: string }> = []) {
    const sent: ServerToNodeMessage[] = [];
    const transport: NodeTransport = { async send(message) { sent.push(structuredClone(message)); }, subscribe() { return () => {}; }, async close() {} };
    const binding: NodeBinding = attachNodeBinding(server.ctx, transport, "computer_local_mock", ["run-verification.v1", "product-stage-verification.v1"],
      () => server.nodeRegistry.get("computer_local_mock") === binding,
      [{ profile_id: "default", project_id: "proj_artoo", workspace_root: root }, ...additionalProfiles], undefined, undefined, undefined, nodeOs);
    bindings.push(binding); server.nodeRegistry.register("computer_local_mock", binding);
    return { binding, sent };
  }

  async function complete(run: typeof runs.$inferSelect, answer?: string, source = digest, receipt = true, files: RunVerificationPayload["required_files"] = [],
    outcome: "passed" | "failed" = "passed", observation?: RunVerificationPayload["checks"][number]["observation"], omitApplication = false) {
    let sequence = 0;
    const send = (event: RunEventMessage["event"]) => ingestWireRunEvent(server.ctx,
      { kind: "run.event", node_id: run.computerId, run_id: run.id, sequence: sequence++, event });
    await send({ type: "run.lifecycle", payload: { phase: "started" } });
    if (answer !== undefined) await send({ type: "run.answer", payload: { text: answer } });
    if (run.verificationRequirement && receipt) {
      const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.contextPackId!));
      const context = ContextPackSchema.parse(stored!.payload);
      const stage = context.product_development?.stage ?? context.review_subject?.development_stage;
      const measured = new Map((stage ? productStageHandoffPaths(stage) : []).map((path) => [path, { path, checksum: digest, size: 10 }]));
      for (const file of files) measured.set(file.path, file);
      const request = run.verificationRequirement as VerificationRequirement;
      if (request.capability_binding && outcome === "passed") {
        if (!stage) throw new Error("Capability fixture requires an actual product stage");
        observation = { version: 1, format: "static-web-acceptance.v1", scope: "final", stage, cases: [], ...observation,
          capability_binding: { version: 1, profile_digest: request.capability_binding.profile_digest,
            ...request.capability_binding.checks.find((check) => check.command_id === "acceptance")! } };
        if (context.app_delivery) observation = { version: 3, format: "static-web-acceptance.v3", scope: "final", stage,
          device_scale_factor: 1, cases: [], evidence_bundle: { bundle_id: "controlled_app_bundle", manifest_digest: digest },
          capability_binding: { version: 1, profile_digest: request.capability_binding.profile_digest,
            ...request.capability_binding.checks.find(check => check.command_id === "acceptance")! } };
      }
      const payload: RunVerificationPayload = { version: 1, request_id: request.request_id, profile_id: request.profile_id,
        profile_digest: request.capability_binding?.profile_digest ?? digest, subject_digest: source, outcome, checks: [{ id: "acceptance", exit_code: outcome === "passed" ? 0 : 1, duration_ms: 10, output_digest: digest,
          ...(observation ? { observation } : {}) }], required_files: [...measured.values()] };
      if (request.application && outcome === "passed" && !omitApplication && (stage === "implementation" || stage === "validation")) {
        // Controlled node evidence only: these digests/closures do not claim a native compiler, app service or browser run.
        payload.application = applicationObservation(run.id, request, stage, source);
      }
      if (outcome === "passed" && context.verification_capabilities?.measurement_plan_policy?.version === 2 && context.release_capabilities) {
        const fixture = releaseAcceptanceFixture(stage), summary = fixture.payload.measurement_plan;
        if (summary?.version !== 2) throw new Error("Expected controlled publication summary");
        payload.measurement_plan = { ...summary, research: measured.get(".artoo/product/research.json")! as typeof summary.research,
          used_checks: request.capability_binding!.checks,
          pending_release: summary.pending_release.map(ref => ({ ...ref, release_binding: context.release_capabilities!.binding })) };
      }
      await send({ type: "run.verification", payload });
    }
    await send({ type: "run.lifecycle", payload: { phase: "completed" } });
  }

  async function create(team = true, maxRetries = 3, application = false) {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/autonomous-goals", headers: { "idempotency-key": "team-objective" },
      payload: { project_id: "proj_artoo", objective: "Build a journal product", max_retries: maxRetries, ...(team ? { execution_mode: "agent_team" } : {}),
        ...(application ? { app_delivery: { version: 1, kind: "local-application-development" } } : {}) } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().goal.id as string;
  }

  async function plan(goalId: string, proposal: unknown = { rationale: "A staged product team", task_specs: specs }) {
    await pump();
    const automation = await getGoalAutomation(server.ctx, goalId);
    expect(automation?.discussion_id, automation?.last_error ?? "planning should start").toBeTruthy();
    const planner = createDiscussionDispatcher(server.ctx, stop), assistant = createAssistantDispatcher(server.ctx);
    for (let step = 0; step < 3; step++) {
      await planner.pump(); await assistant.pump();
      const [discussion] = await server.db.db.select().from(discussions).where(eq(discussions.id, automation!.discussion_id!));
      const [turn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, discussion!.activeTurnId!));
      expect(turn?.status, turn?.error ?? "planning should run").toBe("running");
      const [run] = await server.db.db.select().from(runs).where(eq(runs.id, turn!.runId!));
      await complete(run!, step === 2 ? JSON.stringify(proposal) : `Planning contribution ${step}`);
      await assistant.pump();
    }
    await planner.pump(); await pump();
    await planner.stop(); await assistant.stop();
    return taskRows(goalId);
  }

  function applicationObservation(runId: string, request: VerificationRequirement, stage: "implementation" | "validation", source = digest): ApplicationVerificationObservationV1 {
    const expected = request.application?.expected_candidate;
    return { version: 1, scope: "local-development-api-browser-reopen", stage, run_id: runId, request_id: request.request_id,
      origin_run_id: expected?.origin_run_id ?? runId, origin_request_id: expected?.origin_request_id ?? request.request_id,
      candidate: expected?.candidate ?? { version: 1, subject_digest: source, source_digest: digest, artifact_digest: digest,
        toolchain_digest: digest, package_digest: digest, schema_digest: digest, qualified_for_product: false }, qualified_for_product: false,
      acceptance: { version: 1, cases: [{ case_id: "save", program_digest: digest, trace_digest: digest, assertions: 1, capture_digests: [digest] }],
        persistence: { request_digest: digest, before_read_digest: digest, after_read_digest: digest, replay_response_digest: digest,
          after_replay_read_digest: digest, browser_trace_digest: digest },
        closures: { compiler: true, initialize: true, services: 2, browser: true }, test_store_id: randomUUID() } };
  }

  async function applicationWorker() {
    const root = "C:\\Work Space\\Team", capabilities = verificationCapabilitiesV3Fixture();
    capabilities.profile_digest = digest;
    capabilities.application = { version: 1, kind: "local-application-development", claim: "configured", config_digest: digest,
      contract_digest: changedDigest, source_paths: ["product/client", "product/server", ".artoo/product/application.json"],
      definition_format: "artoo.application-definition.v1", test_scope: "normal-api-browser-reopen", failure_recovery: "unsupported",
      browser_viewport: { width: 1280, height: 900, device_scale_factor: 1 },
      publication: "unsupported", qualified_for_product: false };
    await server.db.db.update(computers).set({ os: "windows" });
    await server.db.db.update(agentInstances).set({ workspaceRoot: root });
    server.ctx.supportsExecutionFeature = (node, feature) => server.nodeRegistry.get(node)?.supportsExecutionFeature(feature) ?? false;
    server.ctx.supportsVerificationProfile = (node, profile, project, workspace) =>
      server.nodeRegistry.get(node)?.supportsVerificationProfile(profile, project, workspace) ?? false;
    server.ctx.onRunQueued = async () => {};
    // Windows planning must resolve the exact root from the current authenticated
    // advertisement. Register it before planning; keep the real workspace and capability getters.
    const sent: ServerToNodeMessage[] = [];
    const connect = (application = true) => {
      const transport: NodeTransport = { async send(message) { sent.push(structuredClone(message)); }, subscribe() { return () => {}; }, async close() {} };
      const binding: NodeBinding = attachNodeBinding(server.ctx, transport, "computer_local_mock",
        ["run-verification.v1", "product-stage-verification.v1", "verification-capabilities.v1", ...(application ? [APPLICATION_VERIFICATION_FEATURE_V1] : [])],
        () => server.nodeRegistry.get("computer_local_mock") === binding,
        [{ profile_id: "default", project_id: "proj_artoo", workspace_root: root, capabilities }], undefined, undefined, undefined, "windows");
      bindings.push(binding); server.nodeRegistry.register("computer_local_mock", binding); return binding;
    };
    const binding = connect();
    expect(server.ctx.getVerificationWorkspace?.("computer_local_mock", "default", "proj_artoo", root)).toBe(root);
    return { root, capabilities, sent, connect, binding };
  }

  it("routes an explicitly authorized application through actual planning, four stages and fresh independent review, then waits for unsupported publication", async () => {
    const { sent, connect, binding: initialBinding } = await applicationWorker();
    const goalId = await create(true, 3, true), stageTasks = await plan(goalId);
    let binding = initialBinding;
    const original = await getGoalAutomation(server.ctx, goalId);
    expect(original?.planning_capability_snapshot?.app_delivery).toEqual({ version: 1, kind: "local-application-development" });
    for (const task of stageTasks) {
      const author = await start(goalId, task.id), requirement = author.verificationRequirement as VerificationRequirement;
      expect(requirement.application).toMatchObject({ version: 1, config_digest: digest, contract_digest: changedDigest });
      if (task.title === "implementation") {
        const old = connect(false);
        await expect(old.dispatchRunStart(author.id)).rejects.toMatchObject({ details: { reason: "unsupported_application_verification" } });
        binding = connect();
      }
      await binding.dispatchRunStart(author.id);
      const startCommand = sent.find(message => message.kind === "command" && message.type === "run.start" && message.payload.run_id === author.id)!;
      expect(runStartCommandSchema.parse(startCommand).payload.verification?.application).toEqual(requirement.application);
      await complete(author);
      const peer = await verdict(author), source = await readRunVerificationEvidence(server.ctx, server.db.db, author.id);
      const reviewed = await readRunVerificationEvidence(server.ctx, server.db.db, peer.run.id);
      if (task.title === "implementation" || task.title === "validation") {
        expect(reviewed?.payload.application).toMatchObject({ run_id: peer.run.id, origin_run_id: author.id,
          origin_request_id: requirement.request_id, candidate: source?.payload.application?.candidate, qualified_for_product: false });
        expect(reviewed?.payload.application?.acceptance.test_store_id).not.toBe(source?.payload.application?.acceptance.test_store_id);
      } else expect(source?.payload.application).toBeUndefined();
    }
    await pump();
    expect((await taskRows(goalId)).every(task => task.status === "done")).toBe(true);
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "waiting", delivery: "verified_workspace",
      last_error: expect.stringContaining("publication remains unsupported") });
    expect((await server.db.db.select().from(goals).where(eq(goals.id, goalId)))[0]?.status).toBe("running");
    expect(await getGoalProductRelease(server.ctx, goalId)).toBeNull();
  });

  it("refuses application planning on an old node and makes the original application grant immutable", async () => {
    await applicationWorker();
    const goalId = await create(true, 3, true);
    server.ctx.supportsExecutionFeature = (_node, feature) => feature !== APPLICATION_VERIFICATION_FEATURE_V1;
    await pump();
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "waiting", discussion_id: null });
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
    await expect(server.db.db.update(goalAutomations).set({ appDelivery: null }).where(eq(goalAutomations.goalId, goalId))).rejects.toThrow();
    await expect(server.db.db.update(goalAutomations).set({ status: "completed" }).where(eq(goalAutomations.goalId, goalId))).rejects.toThrow();
  });

  it("rejects missing application measurement and requalifies current-run, origin and authorization bindings on read", async () => {
    await applicationWorker();
    const goalId = await create(true, 3, true), stageTasks = await plan(goalId);
    for (const task of stageTasks.slice(0, 2)) { const run = await start(goalId, task.id); await complete(run); await verdict(run); }
    const author = await start(goalId, stageTasks[2]!.id);
    await expect(complete(author, undefined, digest, true, [], "passed", undefined, true)).rejects.toThrow("lacks successful evidence");
    await complete(author);
    const evidence = (await readRunVerificationEvidence(server.ctx, server.db.db, author.id))!;
    expect(evidence.payload.application).toBeDefined();
    for (const application of [undefined, { ...evidence.payload.application!, run_id: "another-run" },
      { ...evidence.payload.application!, origin_run_id: "another-author" }, { ...evidence.payload.application!, origin_request_id: "another-request" }]) {
      const payload = { ...evidence.payload, application };
      await server.db.db.update(runEvidence).set({ payload }).where(eq(runEvidence.id, evidence.id));
      await server.db.db.update(eventLog).set({ payload }).where(eq(eventLog.id, evidence.eventId));
      expect(await readRunVerificationEvidence(server.ctx, server.db.db, author.id)).toBeNull();
    }
    await server.db.db.update(runEvidence).set({ payload: evidence.payload }).where(eq(runEvidence.id, evidence.id));
    await server.db.db.update(eventLog).set({ payload: evidence.payload }).where(eq(eventLog.id, evidence.eventId));
    expect(await readRunVerificationEvidence(server.ctx, server.db.db, author.id)).not.toBeNull();
    await server.db.db.update(eventLog).set({ actorId: "another-user" }).where(and(eq(eventLog.goalId, goalId), eq(eventLog.type, "goal.application-development.authorized")));
    expect(await readRunVerificationEvidence(server.ctx, server.db.db, author.id)).toBeNull();
  });

  async function start(goalId: string, taskId: string) {
    for (let step = 0; step < 3; step++) {
      await pump();
      const rows = await server.db.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.id));
      if (rows.at(-1)?.status === "queued") return rows.at(-1)!;
    }
    throw new Error((await getGoalAutomation(server.ctx, goalId))?.last_error ?? "Task did not start");
  }

  async function startReview(subject: typeof runs.$inferSelect) {
    await Promise.all([pump(), createGoalAutomationDispatcher(server.ctx, stop).pump()]);
    const reviews = await server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.subjectRunId, subject.id));
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    await createAssistantDispatcher(server.ctx).pump();
    const [turn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, review.turnId));
    expect(turn?.status, turn?.error ?? "review should run").toBe("running");
    const [run] = await server.db.db.select().from(runs).where(eq(runs.id, turn!.runId!));
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run!.contextPackId!));
    expect(ContextPackSchema.parse(pack!.payload)).toMatchObject({ policy: { execution_mode: "discussion", filesystem_write_scope: [] } });
    expect(ContextPackSchema.parse(pack!.payload).product_development).toBeUndefined();
    expect(ContextPackSchema.parse(pack!.payload).review_subject).toMatchObject({ version: 1, task_id: subject.taskId, run_id: subject.id,
      evidence_id: review.evidenceId, subject_digest: digest });
    expect(ContextPackSchema.parse(pack!.payload).review_subject?.verification).toMatchObject({ version: 1,
      request_id: (subject.verificationRequirement as VerificationRequirement).request_id, profile_id: "default", profile_digest: digest,
      checks: [{ id: "acceptance", output_digest: digest }] });
    expect(run?.agentInstanceId).not.toBe(subject.agentInstanceId);
    expect(run?.verificationRequirement).toMatchObject({ expected_subject_digest: digest });
    return { review, run: run! };
  }

  async function windowsWorker(os = "win32", ambiguous = false) {
    const root = "C:\\Work Space\\Team";
    await server.db.db.update(computers).set({ os });
    await server.db.db.update(agentInstances).set({ workspaceRoot: "c:/WORK SPACE/team/" });
    await server.db.db.update(agentInstances).set({ workspaceRoot: "C:\\work space\\TEAM\\" }).where(eq(agentInstances.id, "instance_specialist"));
    // Controlled authenticated advertisement only; no native Windows verifier is launched.
    server.ctx.supportsExecutionFeature = (node, feature) => server.nodeRegistry.get(node)?.supportsExecutionFeature(feature) ?? false;
    server.ctx.supportsVerificationProfile = (node, profile, project, path) =>
      server.nodeRegistry.get(node)?.supportsVerificationProfile(profile, project, path) ?? false;
    server.ctx.onRunQueued = async () => {};
    return { root, ...reconnect(root, os, ambiguous ? [{ profile_id: "conflicting", project_id: "proj_artoo", workspace_root: "c:/work space/team/" }] : []) };
  }

  it.each(["win32", "windows"])("keeps the node's exact %s root through team selection, author and independent review dispatch", async (os) => {
    const { root, binding, sent } = await windowsWorker(os);
    const goalId = await create(), [research] = await plan(goalId);
    const automation = await getGoalAutomation(server.ctx, goalId);
    expect(automation).toMatchObject({ workspace_root: root, computer_id: "computer_local_mock", execution_mode: "agent_team" });
    expect(new Set(automation!.team!.members.map(member => member.agent_instance_id)).size).toBe(2);
    expect(automation!.planning_capability_snapshot?.workspace_root).toBe(root);
    const author = await start(goalId, research!.id);
    expect(author.workspaceRoot).toBe(root); await binding.dispatchRunStart(author.id);
    await complete(author, "Controlled research handoff");
    const peer = await startReview(author);
    expect(peer.run.workspaceRoot).toBe(root); await binding.dispatchRunStart(peer.run.id);
    for (const run of [author, peer.run]) {
      const start = sent.find(message => message.kind === "command" && message.type === "run.start" && message.payload.run_id === run.id);
      expect(start).toMatchObject({ type: "run.start", payload: { workspace: { root }, context_pack: { payload: { workspace: { root } } } } });
      const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.contextPackId!));
      expect(ContextPackSchema.parse(stored!.payload).workspace.root).toBe(root);
    }
    expect(peer.run.agentInstanceId).not.toBe(author.agentInstanceId);
    expect(peer.run.verificationRequirement).toMatchObject({ expected_subject_digest: digest });
    expect((await getGoalAutomation(server.ctx, goalId))?.workspace_root).toBe(root);
  });

  it.each(["ambiguous advertisement", "peer outside workspace"])("does not form a Windows team with %s", async (scenario) => {
    await windowsWorker("win32", scenario === "ambiguous advertisement");
    if (scenario === "peer outside workspace") {
      await server.db.db.update(agentInstances).set({ workspaceRoot: "C:\\Different" }).where(eq(agentInstances.id, "instance_specialist"));
    }
    const goalId = await create(); await pump();
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "waiting", discussion_id: null, workspace_root: null, team: null });
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });

  it("does not reinterpret a fixed Windows root after an authenticated reconnect changes its spelling", async () => {
    const { root } = await windowsWorker();
    const goalId = await create(), [research] = await plan(goalId);
    reconnect("c:\\WORK SPACE\\TEAM", "win32");
    for (let step = 0; step < 3; step++) await pump();
    const automation = await getGoalAutomation(server.ctx, goalId);
    expect(automation?.workspace_root).toBe(root); expect(automation?.status).toBe("waiting");
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, research!.id))).toHaveLength(0);
  });

  it("blocks an already queued Windows run if the replacement session advertises colliding roots", async () => {
    const { root } = await windowsWorker();
    const goalId = await create(), [research] = await plan(goalId), author = await start(goalId, research!.id);
    const { binding, sent } = reconnect(root, "win32", [{ profile_id: "conflicting", project_id: "proj_artoo", workspace_root: "c:/work space/team/" }]);
    await expect(binding.dispatchRunStart(author.id)).rejects.toThrow("verification profile");
    expect(sent).toHaveLength(0);
    const [stored] = await server.db.db.select().from(runs).where(eq(runs.id, author.id));
    expect(stored).toMatchObject({ workspaceRoot: root, status: "queued" });
    expect((await getGoalAutomation(server.ctx, goalId))?.workspace_root).toBe(root);
  });

  it("puts one authenticated capability snapshot in the first research context and its persisted request", async () => {
    const capabilities = verificationCapabilitiesFixture(), changed = structuredClone(capabilities);
    changed.profile_digest = changedDigest;
    const getter = vi.fn().mockReturnValue(capabilities);
    server.ctx.getVerificationCapabilities = getter;
    const goalId = await create(), [research] = await plan(goalId);
    expect((await getGoalAutomation(server.ctx, goalId))?.planning_capability_snapshot?.capabilities).toEqual(capabilities);
    // Capture/planning checks have their own reads. This assertion isolates the
    // first execution boundary: its context and request must share one value.
    getter.mockReset().mockReturnValueOnce(capabilities).mockReturnValue(changed);
    const author = await start(goalId, research!.id);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(getter).toHaveBeenCalledWith(author.computerId, "default", "proj_artoo", "/workspace/team");
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, author.contextPackId!));
    const context = ContextPackSchema.parse(stored!.payload);
    expect(context.verification_capabilities).toEqual({ ...capabilities, profile_id: "default" });
    expect(context.goal_context?.objective).toBe("Build a journal product");
    expect(context.product_development?.stage).toBe("research");
    expect(author.verificationRequirement).toMatchObject({ capability_binding: verificationCapabilityBinding(capabilities) });
  });

  it("does not downgrade to unknown scope when the selected node disconnects before the capability snapshot", async () => {
    const goalId = await create(), [research] = await plan(goalId);
    const previous = server.ctx.supportsVerificationProfile!;
    let profileReads = 0;
    server.ctx.supportsVerificationProfile = (...args) => ++profileReads === 1 && previous(...args);
    const getter = vi.fn(() => verificationCapabilitiesFixture());
    server.ctx.getVerificationCapabilities = getter;
    for (let step = 0; step < 3 && profileReads < 2; step++) await pump();
    expect(profileReads).toBe(2);
    expect(getter).not.toHaveBeenCalled();
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, research!.id))).toHaveLength(0);
    expect((await getGoalAutomation(server.ctx, goalId))?.last_error).toContain("selected node verification profile is no longer available");
  });

  it.each([false, true])("uses the bound v3 storage opt-in for research guidance: %s", async (storageFault) => {
    const capabilities = verificationCapabilitiesV3Fixture(storageFault), changed = verificationCapabilitiesV3Fixture(!storageFault);
    const getter = vi.fn().mockReturnValue(capabilities);
    server.ctx.getVerificationCapabilities = getter;
    const goalId = await create(), [research] = await plan(goalId);
    getter.mockReset().mockReturnValueOnce(capabilities).mockReturnValue(changed);
    const author = await start(goalId, research!.id);
    expect(getter).toHaveBeenCalledTimes(1);
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, author.contextPackId!));
    const context = ContextPackSchema.parse(stored!.payload);
    expect(context.verification_capabilities).toEqual({ ...capabilities, profile_id: "default" });
    expect(context.goal_context?.objective).toBe("Build a journal product");
    expect(context.product_development?.stage).toBe("research");
    expect(context.product_development?.instructions.join("\n").includes("storage_checks")).toBe(storageFault);
    expect(author.verificationRequirement).toMatchObject({ capability_binding: verificationCapabilityBinding(capabilities) });
  });

  it.each([false, true])("keeps accepted research capabilities bound through peers and later authors with historical planning=%s", async historical => {
    const capabilities = verificationCapabilitiesFixture();
    server.ctx.getVerificationCapabilities = () => structuredClone(capabilities);
    const goalId = await create(), [research, design] = await plan(goalId);
    if (historical) await server.db.db.update(goalAutomations).set({ planningCapabilitySnapshot: null }).where(eq(goalAutomations.goalId, goalId));
    const author = await start(goalId, research!.id);
    await complete(author);
    const peer = await verdict(author), next = await start(goalId, design!.id);
    for (const run of [peer.run, next]) {
      expect(run.verificationRequirement).toMatchObject({ capability_binding: verificationCapabilityBinding(capabilities) });
      const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.contextPackId!));
      expect(ContextPackSchema.parse(stored!.payload).verification_capabilities).toEqual({ ...capabilities, profile_id: "default" });
    }
  });

  it.each([false, true])("distinguishes captured unknown from historical SQL NULL before first research: historical=%s", async historical => {
    const goalId = await create(), [research] = await plan(goalId);
    if (historical) await server.db.db.update(goalAutomations).set({ planningCapabilitySnapshot: null }).where(eq(goalAutomations.goalId, goalId));
    const getter = vi.fn(() => verificationCapabilitiesFixture()); server.ctx.getVerificationCapabilities = getter;
    if (historical) {
      const author = await start(goalId, research!.id);
      expect(author.verificationRequirement).toMatchObject({ capability_binding: verificationCapabilityBinding(verificationCapabilitiesFixture()) });
      expect((await getGoalAutomation(server.ctx, goalId))!.planning_capability_snapshot).toBeNull();
      expect(getter).toHaveBeenCalledTimes(1);
    } else {
      await expect(start(goalId, research!.id)).rejects.toThrow("fixed planning capability snapshot");
      expect(await server.db.db.select().from(runs).where(eq(runs.taskId, research!.id))).toHaveLength(0);
    }
  });

  it.each(["profile_digest", "config_digest", "contract_digest", "missing_advertisement"] as const)(
    "stops later author stages when accepted research capability binding changes: %s", async (scenario) => {
      let capabilities: ReturnType<typeof verificationCapabilitiesFixture> | undefined = verificationCapabilitiesFixture();
      server.ctx.getVerificationCapabilities = () => capabilities && structuredClone(capabilities);
      const goalId = await create(), [research, design] = await plan(goalId), author = await start(goalId, research!.id);
      await complete(author); await verdict(author);
      if (scenario === "missing_advertisement") capabilities = undefined;
      else if (scenario === "profile_digest") capabilities.profile_digest = changedDigest;
      else capabilities.checks[0]![scenario] = `sha256:${"f".repeat(64)}`;
      await expect(start(goalId, design!.id)).rejects.toThrow("differ from the accepted node receipt");
      expect(await server.db.db.select().from(runs).where(eq(runs.taskId, design!.id))).toHaveLength(0);
      expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("waiting");
    });

  it("requires measurement-plan enforcement at first research assignment and reuses the same selected snapshot", async () => {
    const capabilities = verificationCapabilitiesFixture(); capabilities.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
    const getter = vi.fn(() => structuredClone(capabilities)); server.ctx.getVerificationCapabilities = getter;
    server.ctx.supportsExecutionFeature = () => true;
    const goalId = await create(), [research] = await plan(goalId);
    await pump(); // Advance the planned root from backlog to ready before the measured assignment attempt.
    expect((await taskRows(goalId))[0]!.status).toBe("ready");
    getter.mockClear(); server.ctx.supportsExecutionFeature = (_node, feature) => feature !== "measurement-plan.v1";
    // One pump is one assignment attempt; the start helper deliberately retries.
    await pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.last_error).toContain("cannot enforce its measurement-plan policy");
    expect(getter).toHaveBeenCalledOnce();
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, research!.id))).toHaveLength(0);
    getter.mockClear(); server.ctx.supportsExecutionFeature = () => true;
    const author = await start(goalId, research!.id); expect(getter).toHaveBeenCalledOnce();
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, author.contextPackId!));
    expect(ContextPackSchema.parse(stored!.payload).verification_capabilities).toEqual({ ...capabilities, profile_id: "default" });
    expect(author.verificationRequirement).toMatchObject({ capability_binding: verificationCapabilityBinding(capabilities) });
  });

  it("does not backfill a new advertised scope into a legacy accepted research receipt", async () => {
    const goalId = await create(), [research, design] = await plan(goalId), author = await start(goalId, research!.id);
    await complete(author); await verdict(author);
    server.ctx.getVerificationCapabilities = () => verificationCapabilitiesFixture();
    await expect(start(goalId, design!.id)).rejects.toThrow("unknown verification capabilities");
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, design!.id))).toHaveLength(0);
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, author.contextPackId!));
    expect(ContextPackSchema.parse(stored!.payload).verification_capabilities).toBeUndefined();
    expect(author.verificationRequirement).not.toHaveProperty("capability_binding");
  });

  it("hands only authenticated measured browser scope to the peer and requalifies its source receipt", async () => {
    const goalId = await create(), [research, design] = await plan(goalId);
    const researcher = await start(goalId, research!.id);
    await complete(researcher); const researchReview = await verdict(researcher);
    const [legacyPack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, researchReview.run.contextPackId!));
    expect(ContextPackSchema.parse(legacyPack!.payload).review_subject?.verification?.checks[0]?.observation).toBeUndefined();
    const author = await start(goalId, design!.id);
    const observation: NonNullable<RunVerificationPayload["checks"][number]["observation"]> = {
      version: 1, format: "static-web-acceptance.v1", scope: "final", stage: "design",
      cases: [390, 1280].map((viewport) => ({ case_id: "prototype", viewport, assertions: 0, screenshot_digest: digest,
        screenshot_ref: `image_${viewport}` })), evidence_bundle: { bundle_id: "bundle_design", manifest_digest: digest },
    };
    await complete(author, "All V01 through V17 passed", digest, true, [], "passed", observation);
    const peer = await startReview(author);
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, peer.run.contextPackId!));
    const projection = ContextPackSchema.parse(pack!.payload).review_subject!.verification!;
    expect(projection.checks).toEqual([{ id: "acceptance", output_digest: digest, observation }]);
    expect(JSON.stringify(projection)).not.toContain("V17");
    const [evidence] = await server.db.db.select().from(runEvidence).where(eq(runEvidence.id, peer.review.evidenceId));
    await server.db.db.update(runEvidence).set({ payload: { ...(evidence!.payload as RunVerificationPayload), subject_digest: changedDigest } })
      .where(eq(runEvidence.id, evidence!.id));
    const [reviewTask] = await server.db.db.select().from(tasks).where(eq(tasks.id, peer.review.reviewTaskId));
    await expect(buildRunContextPack(server.ctx, server.db.db, { runId: peer.run.id, assistantTurnId: peer.review.turnId,
      task: reviewTask!, workspaceRoot: peer.run.workspaceRoot })).rejects.toThrow("source verification is no longer qualified");
  });

  async function verdict(subject: typeof runs.$inferSelect, outcome: "accepted" | "changes_requested" = "accepted", source = digest, binding = subject.id, receipt = true,
    files: RunVerificationPayload["required_files"] = []) {
    const { review, run } = await startReview(subject);
    await complete(run, JSON.stringify({ version: 1, reviewed_run_id: binding, verification_evidence_id: review.evidenceId,
      subject_digest: digest, outcome, summary: outcome === "accepted" ? "Inspected the implementation and found no blockers" : "Persistence fails after restart",
      findings: outcome === "accepted" ? [] : [{ severity: "blocking", file: "src/store.ts", description: "Persist entries before acknowledging save" }] }), source, receipt, files);
    await createAssistantDispatcher(server.ctx).pump(); await pump();
    return { review, run };
  }

  it("keeps canonical release criteria pending through accepted author/peer stages and settles only the final validation author receipt", async () => {
    const f = releaseAcceptanceFixture(); f.release.binding.workspace_root = "/workspace/team";
    server.ctx.supportsExecutionFeature = () => true;
    server.ctx.getVerificationCapabilities = () => structuredClone(f.capabilities);
    server.ctx.supportsReleaseProfile = () => true;
    server.ctx.getReleaseCapabilities = () => structuredClone(f.release);
    const response = await server.app.inject({ method: "POST", url: "/api/v1/autonomous-goals", headers: { "idempotency-key": "publication-criteria" },
      payload: { project_id: "proj_artoo", objective: "Build and publish a journal product", execution_mode: "agent_team",
        verification_profile_id: "default", release_profile_id: "site", max_retries: 3 } });
    expect(response.statusCode, response.body).toBe(201);
    const goalId = response.json().goal.id as string, stageTasks = await plan(goalId);
    let authorId = "", peerId = "";
    for (const task of stageTasks) {
      const author = await start(goalId, task.id); await complete(author);
      const peer = await verdict(author); authorId = author.id; peerId = peer.run.id;
      expect((await getGoalAutomation(server.ctx, goalId))?.delivery).toBe("verified_workspace");
    }
    await pump();
    const release = (await getGoalProductRelease(server.ctx, goalId))!;
    expect(release).toMatchObject({ status: "queued", receipt: null, request: { run_id: authorId,
      acceptance_binding: { version: 1, criteria: [{ requirement_id: "publication", criterion_index: 0 }] } } });
    expect(release.request.run_id).not.toBe(peerId);
    const receipt: ProductReleaseReceipt = { request: release.request, release_profile_digest: f.release.binding.release_profile_digest,
      artifact_digest: release.request.subject_digest, outcome: "published", endpoint: "http://127.0.0.1:12345", previous_release_id: null,
      health_checks: [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: server.ctx.clock.nowIso() }],
      acceptance: { version: 1, binding_digest: releaseAcceptanceBindingDigest(release.request.acceptance_binding!),
        scope: "node-http-point-in-time", settled_criteria: release.request.acceptance_binding!.criteria } };
    await expect(ingestProductReleaseReceipt(server.ctx, release.computer_id,
      { ...receipt, acceptance: { ...receipt.acceptance!, binding_digest: changedDigest } })).rejects.toThrow("settled every");
    await ingestProductReleaseReceipt(server.ctx, release.computer_id, receipt);
    await ingestProductReleaseReceipt(server.ctx, release.computer_id, structuredClone(receipt));
    const health = { version: 1 as const, event_id: "publication-degraded", sequence: 1, request: release.request,
      release_profile_digest: receipt.release_profile_digest, artifact_digest: receipt.artifact_digest!, state: "degraded" as const,
      active_release_id: release.id, active_artifact_digest: receipt.artifact_digest, consecutive_failures: 1,
      health_checks: receipt.health_checks.map(check => ({ ...check, status_code: 503, passed: false })), recovery_checks: [], checked_at: server.ctx.clock.nowIso() };
    await ingestProductReleaseHealthReport(server.ctx, release.computer_id, health); await pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("executing");
    await ingestProductReleaseHealthReport(server.ctx, release.computer_id, { ...health, event_id: "publication-healthy", sequence: 2,
      state: "healthy", consecutive_failures: 0, health_checks: receipt.health_checks });
    await pump();
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "completed", delivery: "published_product" });
    const completion = await server.db.db.select().from(eventLog).where(and(eq(eventLog.goalId, goalId), eq(eventLog.type, "goal.completed")));
    expect(completion).toHaveLength(1);
    expect(completion[0]!.payload).toMatchObject({ trigger: "product_release_healthy", settlement: { version: 1, run_id: authorId,
      release_id: release.id, health_event_id: "publication-healthy", health_sequence: 2, criteria: receipt.acceptance!.settled_criteria } });
    await server.db.db.update(goalAutomations).set({ status: "waiting" }).where(eq(goalAutomations.goalId, goalId));
    await pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("completed");
    // Controlled persistence corruption must not turn a completed status into acceptance authority.
    await server.db.db.update(eventLog).set({ payload: { trigger: "product_release_healthy" } }).where(eq(eventLog.id, completion[0]!.id));
    await server.db.db.update(goalAutomations).set({ status: "waiting" }).where(eq(goalAutomations.goalId, goalId));
    await pump();
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "waiting", delivery: "verified_workspace",
      last_error: "Completed publication has no recorded exact acceptance settlement" });
  });

  async function lostAuxiliaryStart(kind: "planning" | "reviewer", failTransport = false) {
    const goalId = await create(), dispatch = server.ctx.onRunQueued;
    const loseDelivery = () => { if (failTransport) server.ctx.onRunQueued = async () => { throw new Error("Node disconnected after assignment commit"); }; };
    let run: typeof runs.$inferSelect;
    if (kind === "planning") {
      await pump(); await createDiscussionDispatcher(server.ctx, stop).pump(); loseDelivery();
      await createAssistantDispatcher(server.ctx).pump();
      run = (await server.db.db.select().from(runs))[0]!;
    } else {
      const [task] = await plan(goalId), author = await start(goalId, task!.id);
      await complete(author); loseDelivery(); run = (await startReview(author)).run;
    }
    server.ctx.onRunQueued = dispatch;
    expect(run.status).toBe("queued");
    expect((await server.db.db.select().from(assistantRunDispatches).where(eq(assistantRunDispatches.runId, run.id)))[0])
      .toMatchObject({ version: 1, state: "prepared", exposedAt: null });
    return { goalId, run };
  }

  it.each(["planning", "reviewer"] as const)("redelivers a committed %s start after reconnect and dispatcher recreation with the same run and idempotency key", async (kind) => {
    const { run } = await lostAuxiliaryStart(kind), { sent } = reconnect();
    await createAssistantDispatcher(server.ctx).pump();
    await createAssistantDispatcher(server.ctx).pump();
    expect(sent).toHaveLength(2);
    for (const message of sent) expect(message).toMatchObject({ type: "run.start", idempotency_key: `${run.id}:start`, payload: { run_id: run.id, task_id: run.taskId } });
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, run.taskId))).toHaveLength(1);
    await complete(run, "Recovered execution answer");
    await createAssistantDispatcher(server.ctx).pump();
    expect(sent).toHaveLength(2);
  });

  it.each(["planning", "reviewer"] as const)("recovers %s transport failure after commit without replacing its run", async (kind) => {
    const { run } = await lostAuxiliaryStart(kind, true), { sent } = reconnect();
    await createAssistantDispatcher(server.ctx).pump();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "run.start", payload: { run_id: run.id } });
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, run.taskId))).toHaveLength(1);
  });

  it.each(["planning", "reviewer"] as const)("rebuilds the server restart snapshot and replays its queued %s start instead of resuming a nonexistent process", async (kind) => {
    const { run } = await lostAuxiliaryStart(kind);
    const grace = createGraceWindowManager({ graceMs: 30000, onExpire: () => { throw new Error("Recovery window unexpectedly expired"); } });
    try {
      expect(await recoverInterruptedRuns(server.ctx, grace)).toMatchObject({ runs: 1 });
      const recovered = grace.disarm(run.computerId);
      expect(recovered).toEqual([run.id]);
      const { binding, sent } = reconnect();
      await binding.dispatchRunResume(recovered[0]!);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: "run.start", idempotency_key: `${run.id}:start`, payload: { run_id: run.id } });
      const [delivery] = await server.db.db.select().from(assistantRunDispatches).where(eq(assistantRunDispatches.runId, run.id));
      expect(delivery?.state).toBe("exposed");
      expect(Date.parse(delivery!.exposedAt!)).toBe(server.ctx.clock.now().getTime());
      expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("queued");
      expect(await server.db.db.select().from(runs).where(eq(runs.taskId, run.taskId))).toHaveLength(1);
    } finally { grace.close?.(); }
  });

  it.each(["planning", "reviewer"] as const)("keeps exposed and legacy %s starts behind the process-recovery fence on a new binding", async (kind) => {
    const { run } = await lostAuxiliaryStart(kind), first = reconnect();
    await first.binding.dispatchRunStart(run.id);
    expect(first.sent[0]).toMatchObject({ type: "run.start" });
    const second = reconnect();
    await second.binding.dispatchRunStart(run.id);
    await second.binding.dispatchRunStart(run.id);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]).toMatchObject({ type: "run.resume", payload: { run_id: run.id } });
    // Pre-migration assistant runs have no durable proof of non-exposure.
    await server.db.db.delete(assistantRunDispatches).where(eq(assistantRunDispatches.runId, run.id));
    const legacy = reconnect();
    await legacy.binding.dispatchRunResume(run.id);
    expect(legacy.sent).toHaveLength(1);
    expect(legacy.sent[0]).toMatchObject({ type: "run.resume", payload: { run_id: run.id } });
    expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("queued");
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, run.taskId))).toHaveLength(1);
  });

  it("retains exposed uncertainty when transport throws before its delivery outcome is known", async () => {
    const { run } = await lostAuxiliaryStart("planning");
    let observedExposure: string | undefined;
    let dispatchDb: typeof server.db.db | undefined;
    const transport: NodeTransport = { async send() {
      expect(dispatchDb).toBeDefined();
      observedExposure = (await dispatchDb!.select().from(assistantRunDispatches).where(eq(assistantRunDispatches.runId, run.id)))[0]?.state;
      throw new Error("Socket write outcome is unknown");
    }, subscribe() { return () => {}; }, async close() {} };
    const binding = attachNodeBinding(server.ctx, transport, run.computerId);
    bindings.push(binding);
    const transaction = server.db.transaction.bind(server.db);
    // The real send holds the computer fence in a transaction. An outer PGlite
    // query from this test transport would wait on the transaction awaiting send.
    const captureTransaction = vi.spyOn(server.db, "transaction").mockImplementation(fn => transaction(async tx => {
      const previous = dispatchDb;
      dispatchDb = tx;
      try { return await fn(tx); } finally { dispatchDb = previous; }
    }));
    try { await expect(binding.dispatchRunStart(run.id)).rejects.toThrow("Socket write outcome is unknown"); }
    finally { captureTransaction.mockRestore(); }
    expect(observedExposure).toBe("exposed");
    // Exposure must survive the real dispatch transaction's rollback on send failure.
    expect((await server.db.db.select().from(assistantRunDispatches).where(eq(assistantRunDispatches.runId, run.id)))[0])
      .toMatchObject({ state: "exposed" });
    const connected = reconnect();
    await connected.binding.dispatchRunResume(run.id);
    expect(connected.sent).toHaveLength(1);
    expect(connected.sent[0]).toMatchObject({ type: "run.resume" });
    expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("queued");
  });

  it.each(["planning", "reviewer"] as const)("rechecks pause, original authorization and cancellation before replaying a %s start", async (kind) => {
    const { goalId, run } = await lostAuxiliaryStart(kind), { sent } = reconnect();
    await pauseGoal(server.ctx, goalId); await createAssistantDispatcher(server.ctx).pump();
    expect(sent).toHaveLength(0);
    await resumeGoal(server.ctx, goalId);
    const policy = server.ctx.aiDataSharingPolicy!;
    server.ctx.aiDataSharingPolicy = { ...policy, version: "changed-disclosure" };
    await createAssistantDispatcher(server.ctx).pump(); expect(sent).toHaveLength(0);
    server.ctx.aiDataSharingPolicy = policy;
    const admitted = server.ctx.authConfig.allowedEmails;
    server.ctx.authConfig.allowedEmails = ["not-the-requester@example.test"];
    await createAssistantDispatcher(server.ctx).pump(); expect(sent).toHaveLength(0);
    server.ctx.authConfig.allowedEmails = admitted;
    await createAssistantDispatcher(server.ctx).pump(); expect(sent).toHaveLength(1);
    await stopAutonomousGoalPlanning(server.ctx, goalId, stop);
    await createAssistantDispatcher(server.ctx).pump();
    expect(sent).toHaveLength(1);
    expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("cancelled");
  });

  it.each(["planning", "reviewer"] as const)("fences a %s pause occurring after the replay pump but before node dispatch", async (kind) => {
    const { goalId, run } = await lostAuxiliaryStart(kind), { binding, sent } = reconnect();
    server.ctx.onRunQueued = async (id) => { await pauseGoal(server.ctx, goalId); await binding.dispatchRunStart(id); };
    await createAssistantDispatcher(server.ctx).pump();
    expect(sent).toHaveLength(0);
    expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("queued");
  });

  it("uses distinct stage contributors and exact-source peer review before each acceptance, surviving recreated dispatchers", async () => {
    const goalId = await create(), children = await plan(goalId);
    expect(children).toHaveLength(4);
    const team = (await getGoalAutomation(server.ctx, goalId))!.team!;
    const authors = new Set<string>();
    const accepted = new Map<string, { taskId: string; runId: string; evidenceId: string }>();
    for (const [index, task] of children.entries()) {
      const run = await start(goalId, task.id); authors.add(run.agentInstanceId);
      expect(run.agentInstanceId).toBe(team.members.find((member) => member.stage === specs[index]!.development_stage)!.agent_instance_id);
      const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.contextPackId!));
      const product = ContextPackSchema.parse(pack!.payload).product_development!;
      expect(product.stage).toBe(specs[index]!.development_stage);
      const priorStages = index === 0 ? [] : index === 1 ? ["research"] : ["research", "design"];
      expect(product.accepted_inputs).toEqual({ version: 1, files: priorStages.map((stage) => ({
        path: `.artoo/product/${stage}.json`, checksum: digest, size: 10,
        source_task_id: accepted.get(stage)!.taskId, source_run_id: accepted.get(stage)!.runId, evidence_id: accepted.get(stage)!.evidenceId,
      })) });
      await complete(run);
      await pump();
      expect((await taskRows(goalId))[index]?.status).toBe("review");
      expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/review`, payload: { outcome: "accepted" } })).statusCode).toBe(403);
      const peer = await verdict(run);
      const [evidence] = await server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, run.id));
      accepted.set(specs[index]!.development_stage, { taskId: task.id, runId: run.id, evidenceId: evidence!.id });
      const [event] = await server.db.db.select().from(eventLog).where(and(eq(eventLog.taskId, task.id), eq(eventLog.type, "review.completed")));
      expect(event?.payload).toMatchObject({ outcome: "accepted", verified_run_id: run.id, independent_review_id: peer.review.id,
        reviewer_run_id: peer.run.id, subject_digest: digest });
    }
    expect(authors.size).toBe(2);
    expect((await server.db.db.select().from(goals).where(eq(goals.id, goalId)))[0]?.status).toBe("completed");
  });

  it.each(["source_changed", "stale_binding", "changes_requested", "missing_receipt", "required_file_changed"])("repairs and retests instead of accepting %s", async (failure) => {
    const goalId = await create(), [task] = await plan(goalId);
    const first = await start(goalId, task!.id); await complete(first);
    await verdict(first, failure === "changes_requested" ? "changes_requested" : "accepted", failure === "source_changed" ? changedDigest : digest,
      failure === "stale_binding" ? "run_old" : first.id, failure !== "missing_receipt",
      failure === "required_file_changed" ? [{ path: "contract.json", checksum: changedDigest, size: 12 }] : []);
    expect((await taskRows(goalId))[0]?.status).toBe("ready");
    expect((await server.db.db.select().from(goals).where(eq(goals.id, goalId)))[0]?.retryCount).toBe(1);
    const retry = await start(goalId, task!.id);
    expect(retry.id).not.toBe(first.id);
    expect(retry.verificationRequirement).not.toEqual(first.verificationRequirement);
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, retry.contextPackId!));
    expect(ContextPackSchema.parse(pack!.payload).review_feedback?.entries.length).toBeGreaterThan(0);
    await complete(retry); await verdict(retry);
    expect((await taskRows(goalId))[0]?.status).toBe("done");
    expect(await server.db.db.select().from(autonomousReviews)).toHaveLength(2);
  });

  it("fences queued reviewers during pause and resumes the same durable intent", async () => {
    const goalId = await create(), [task] = await plan(goalId);
    const author = await start(goalId, task!.id); await complete(author); await pump();
    const [review] = await server.db.db.select().from(autonomousReviews);
    await pauseGoal(server.ctx, goalId); await createAssistantDispatcher(server.ctx).pump();
    expect((await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, review!.turnId)))[0]?.runId).toBeNull();
    await resumeGoal(server.ctx, goalId); await pump();
    await verdict(author);
    expect((await taskRows(goalId))[0]?.status).toBe("done");
  });

  it("repairs malformed reviewer output on the same verified source once without rerunning the author", async () => {
    const goalId = await create(), [task] = await plan(goalId);
    const author = await start(goalId, task!.id); await complete(author);
    const first = await startReview(author);
    await complete(first.run, "I inspected it and it looks good, but this response is not JSON.");
    await createAssistantDispatcher(server.ctx).pump();
    await Promise.all([pump(), createGoalAutomationDispatcher(server.ctx, stop).pump()]);
    const [repaired] = await server.db.db.select().from(autonomousReviews);
    expect(repaired).toMatchObject({ id: first.review.id, subjectRunId: author.id, evidenceId: first.review.evidenceId,
      subjectDigest: digest, reviewerInstanceId: first.run.agentInstanceId, status: "pending" });
    expect(repaired!.turnId).not.toBe(first.review.turnId);
    expect((await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, first.review.turnId)))[0]).toMatchObject({ status: "completed", runId: first.run.id });
    expect((await server.db.db.select().from(goals).where(eq(goals.id, goalId)))[0]?.retryCount).toBe(1);
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, task!.id))).toHaveLength(1);
    expect((await taskRows(goalId))[0]?.status).toBe("review");
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await server.db.db.select().from(goals).where(eq(goals.id, goalId)))[0]?.retryCount).toBe(1);
    const second = await verdict(author);
    expect(second.review.id).toBe(first.review.id);
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.run.agentInstanceId).toBe(first.run.agentInstanceId);
    expect(second.run.verificationRequirement).toMatchObject({ expected_subject_digest: digest });
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, task!.id))).toHaveLength(1);
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, first.review.reviewTaskId))).toHaveLength(2);
    expect(await server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, first.run.id))).toHaveLength(1);
    expect((await taskRows(goalId))[0]?.status).toBe("done");
  });

  it("never repairs review formatting over failed node checks and never exceeds the format repair budget", async () => {
    const goalId = await create(true, 1), [task] = await plan(goalId);
    const author = await start(goalId, task!.id); await complete(author);
    const peer = await startReview(author);
    await complete(peer.run, "malformed verdict", digest, true, [], "failed");
    await createAssistantDispatcher(server.ctx).pump(); await pump();
    // Failed actual checks require implementation correction, regardless of response formatting.
    expect((await taskRows(goalId))[0]?.status).toBe("ready");
    expect((await server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.id, peer.review.id)))[0]?.turnId).toBe(peer.review.turnId);
    const retry = await start(goalId, task!.id); await complete(retry);
    const secondPeer = await startReview(retry);
    await complete(secondPeer.run, "malformed verdict after retry budget exhausted");
    await createAssistantDispatcher(server.ctx).pump(); await pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("failed");
    expect((await server.db.db.select().from(goals).where(eq(goals.id, goalId)))[0]?.retryCount).toBe(1);
    expect(await server.db.db.select().from(runs).where(eq(runs.taskId, task!.id))).toHaveLength(2);
    expect(await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.taskId, secondPeer.review.reviewTaskId))).toHaveLength(1);
  });

  it("does not form an independent team from two instances of one agent identity", async () => {
    await server.db.db.update(agentInstances).set({ agentId: "agent_mock_coder" }).where(eq(agentInstances.id, "instance_specialist"));
    const goalId = await create(); await pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("waiting");
    expect(await server.db.db.select().from(discussions)).toHaveLength(0);
  });

  it("repairs an incomplete synthesis with concrete diagnostics and one bounded retry", async () => {
    const goalId = await create();
    expect(await plan(goalId, { rationale: "Incomplete", task_specs: specs.slice(0, 1) })).toHaveLength(0);
    expect((await server.db.db.select().from(goals).where(eq(goals.id, goalId)))[0]?.retryCount).toBe(1);
    const [discussion] = await server.db.db.select().from(discussions);
    expect(discussion?.status).toBe("running");
    await createAssistantDispatcher(server.ctx).pump();
    const [turn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, discussion!.activeTurnId!));
    expect(turn?.status, turn?.error ?? "repair should run").toBe("running");
    const [run] = await server.db.db.select().from(runs).where(eq(runs.id, turn!.runId!));
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run!.contextPackId!));
    const request = AutonomousPlanningRequestV1Schema.parse(JSON.parse(ContextPackSchema.parse(pack!.payload).conversation!.current_request)).request;
    expect(request).toContain("missing the design stage");
    const example = JSON.parse(/matching: (\{[^\n]+\})\. Use 1 to 50 tasks\./.exec(request)![1]!);
    expect(validatePlanTaskSpecs(example.task_specs)).toMatchObject([{ development_stage: "research", dependencies: [],
      expected_artifacts: [{ type: "report", description: "stage handoff" }] }]);
    expect(request).toContain('Use "expected_artifacts":[{"type":"report","description":"stage handoff"}] or "expected_artifacts":[].');
    expect(request).toContain('For a later task depending on task 0, use dependencies: [{"ref":"0","type":"blocks"}].');
    await complete(run!, JSON.stringify({ rationale: "Repaired full plan", task_specs: specs }));
    await createAssistantDispatcher(server.ctx).pump();
    await createDiscussionDispatcher(server.ctx, stop).pump(); await pump();
    expect(await taskRows(goalId)).toHaveLength(4);
  });

  it("cancels a queued independent review without accepting or starting it", async () => {
    const goalId = await create(), [task] = await plan(goalId);
    const author = await start(goalId, task!.id); await complete(author); await pump();
    const response = await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/cancel` });
    expect(response.statusCode, response.body).toBe(200);
    const [review] = await server.db.db.select().from(autonomousReviews);
    expect(review?.status).toBe("cancelled");
    const [turn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, review!.turnId));
    expect(turn).toMatchObject({ status: "cancelled", runId: null });
    expect((await server.db.db.select().from(goals).where(eq(goals.id, goalId)))[0]?.status).toBe("cancelled");
  });

  it("keeps a disconnected reviewer reserved until its actual process stop is confirmed", async () => {
    const goalId = await create(), [task] = await plan(goalId);
    const author = await start(goalId, task!.id); await complete(author);
    const { review, run } = await startReview(author);
    await ingestWireRunEvent(server.ctx, { kind: "run.event", node_id: run.computerId, run_id: run.id, sequence: 0,
      event: { type: "run.lifecycle", payload: { phase: "started" } } });
    await failRunDaemonDisconnect(server.ctx, run.id, run.computerId, false);
    await createAssistantDispatcher(server.ctx).pump(); await pump();
    expect((await taskRows(goalId))[0]?.status).toBe("review");
    expect((await server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.id, review.id)))[0]?.status).toBe("pending");
    await expect(stopAutonomousGoalPlanning(server.ctx, goalId, async () => { throw new Error("Node offline"); })).rejects.toThrow("Node offline");
    expect((await server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.id, review.id)))[0]?.status).toBe("pending");
    let stopped: string | undefined;
    await stopAutonomousGoalPlanning(server.ctx, goalId, async (_ctx, id) => { stopped = id; });
    expect(stopped).toBe(run.id);
    expect((await server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.id, review.id)))[0]?.status).toBe("cancelled");
  });
});
