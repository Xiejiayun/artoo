import { agentInstances, agents, assistantTurns, computers, contextPacks, discussions, eventLog, goalAutomations, goalProductHandoffs, messages, runs, tasks } from "@artoo/db";
import { AutonomousPlanningRequestV1Schema, ContextPackSchema, DiscussionParticipantSchema, StartDiscussionRequestSchema, TaskSpecSchema } from "@artoo/domain";
import { eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import { settledServerFixture } from "./test-fixtures/settled-server-fixture.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { automaticSourceHandoffPlanErrors } from "./services/automatic-product-handoff-service.js";
import { createGoalAutomationDispatcher } from "./services/goal-automation-service.js";
import { createDiscussionDispatcher } from "./services/discussion-service.js";
import { createAssistantDispatcher } from "./services/assistant-service.js";
import { ingestRunEvent } from "./services/run-service.js";
import { releaseAcceptanceFixture } from "./test-fixtures/release-acceptance.js";

describe("automatic source handoff original request authorization", () => {
  const lifecycle = settledServerFixture<{ server?: TestServer }>(() => ({}));
  const it = lifecycle.it, server = () => lifecycle.current().server!;
  lifecycle.beforeEach(async state => { state.server = await lifecycle.acquire(buildTestServer({
    onResourceAcquired: resource => lifecycle.own(resource) })); });
  lifecycle.afterEach();
  const request = { project_id: "proj_artoo", objective: "Build and publish a journal", execution_mode: "agent_team", release_profile_id: "site" };
  it("records the API user's opt-in separately from system selection and leaves legacy goals fixed", async () => {
    const legacy = await server().app.inject({ method: "POST", url: "/api/v1/autonomous-goals", payload: request });
    expect(legacy.statusCode).toBe(201); expect(legacy.json().automation.source_handoff).toBeNull();
    const created = await server().app.inject({ method: "POST", url: "/api/v1/autonomous-goals",
      payload: { ...request, source_handoff: { version: 1, mode: "automatic" } } });
    expect(created.statusCode).toBe(201); const id = created.json().goal.id as string;
    expect(created.json().automation.source_handoff).toEqual({ version: 1, mode: "automatic" });
    const events = await server().db.db.select().from(eventLog).where(eq(eventLog.goalId, id));
    expect(events.find(event => event.type === "goal.product-handoff.authorized")).toMatchObject({ actorType: "user", actorId: "user_owner",
      payload: { source_handoff: { version: 1, mode: "automatic" }, policy_version: server().ctx.aiDataSharingPolicy!.version } });
    expect(events.some(event => event.type === "goal.product-handoff.selected")).toBe(false);
    await expect(server().db.db.update(goalAutomations).set({ sourceHandoff: null }).where(eq(goalAutomations.goalId, id))).rejects.toThrow();
    await expect(server().db.db.update(goalAutomations).set({ sourceHandoff: { version: 1, mode: "automatic" } })
      .where(eq(goalAutomations.goalId, legacy.json().goal.id))).rejects.toThrow();
    const dispatcher = createGoalAutomationDispatcher(server().ctx, async () => {});
    try { await dispatcher.pump(); } finally { await dispatcher.stop(); }
    expect(await server().db.db.select().from(goalProductHandoffs)).toHaveLength(0);
  });
  it("starts automatic handoff planning within the role contract and retains routing constraints through synthesis repair", async () => {
    const s = server(), ctx = s.ctx, computerId = "computer_local_mock", workspace = "C:\\artoo\\planning";
    // Controlled authenticated advertisement and replies; real dispatchers/context construction,
    // with no model, native helper, browser or product execution.
    await s.db.db.update(computers).set({ os: "windows" });
    await s.db.db.update(agentInstances).set({ runtime: "codex", workspaceRoot: workspace });
    await s.db.db.update(agents).set({ capabilities: ["code.read", "code.modify", "code.review", "research.web"] });
    const [agent] = await s.db.db.select().from(agents), [instance] = await s.db.db.select().from(agentInstances);
    await s.db.db.insert(agents).values({ ...agent!, id: "agent_planning_peer", kind: "reviewer" });
    await s.db.db.insert(agentInstances).values({ ...instance!, id: "instance_planning_peer", agentId: "agent_planning_peer" });
    const measured = releaseAcceptanceFixture("research"), release = { ...measured.release,
      binding: { ...measured.release.binding, workspace_root: workspace } };
    const features = new Set(["run-verification.v1", "product-stage-verification.v1", "measurement-plan.v2",
      "product-release.acceptance.v1", "product-source-transfer.v2", "product-source-transfer.measurement-v2.v1", "product-source-operations.v1"]);
    const verificationScope = (node: string, profile: string, project: string, root: string) =>
      node === computerId && profile === "default" && project === "proj_artoo" && root === workspace;
    const releaseScope = (node: string, profile: string, project: string, root: string, verifier: string) =>
      profile === "site" && verificationScope(node, verifier, project, root);
    ctx.supportsExecutionFeature = (node, feature) => node === computerId && features.has(feature);
    ctx.supportsVerificationProfile = verificationScope;
    ctx.getVerificationWorkspace = (node, profile, project, root) => verificationScope(node, profile, project, root) ? workspace : undefined;
    ctx.getVerificationCapabilities = (node, profile, project, root) => verificationScope(node, profile, project, root) ? structuredClone(measured.capabilities) : undefined;
    ctx.supportsReleaseProfile = releaseScope;
    ctx.getReleaseCapabilities = (node, profile, project, root, verifier) => releaseScope(node, profile, project, root, verifier) ? structuredClone(release) : undefined;
    ctx.getPairedNodeSession = node => node === computerId ? { computerId, deviceId: "controlled_planning_device",
      tokenLookup: "controlled_planning_token", sessionId: "controlled_planning_session" } : undefined;
    ctx.getProductSourceRouting = node => node === computerId ? { version: 1, source_exports: [structuredClone(release)], destination_mappings: [] } : undefined;
    ctx.onRunQueued = async () => {};
    const errors: unknown[] = [], onError = (error: unknown) => { errors.push(error); }, stop = async () => {};
    const goalWorker = createGoalAutomationDispatcher(ctx, stop, onError), planner = createDiscussionDispatcher(ctx, stop, onError);
    const assistant = createAssistantDispatcher(ctx);
    try {
      const created = await s.app.inject({ method: "POST", url: "/api/v1/autonomous-goals",
        payload: { ...request, source_handoff: { version: 1, mode: "automatic" } } });
      expect(created.statusCode, created.body).toBe(201);
      const goalId = created.json().goal.id as string;
      await goalWorker.pump();
      expect(errors).toEqual([]);
      const [automation] = await s.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, goalId));
      expect(automation).toMatchObject({ status: "planning", lastError: null, sourceHandoff: { version: 1, mode: "automatic" } });
      expect(automation!.discussionId).toBeTruthy();
      const [discussion] = await s.db.db.select().from(discussions).where(eq(discussions.id, automation!.discussionId!));
      const participants = StartDiscussionRequestSchema.parse({ participants: discussion!.participants }).participants;
      expect(participants).toHaveLength(2);
      expect(participants.every(participant => participant.role.length <= 200)).toBe(true);
      expect(participants.every(participant => !participant.role.includes("Automatic source handoff"))).toBe(true);
      expect(DiscussionParticipantSchema.safeParse({ ...participants[0]!, role: "x".repeat(200) }).success).toBe(true);
      expect(DiscussionParticipantSchema.safeParse({ ...participants[0]!, role: "x".repeat(201) }).success).toBe(false);
      const routing = "Automatic source handoff is authorized. Plan exactly four ordered research, design, implementation and validation tasks, each after research with one hard dependency on the immediately preceding stage. The system selects the destination from administrator-prepared mappings; do not select machines or commands in task text.";
      const next = async () => {
        await planner.pump(); await assistant.pump();
        const [current] = await s.db.db.select().from(discussions).where(eq(discussions.id, discussion!.id));
        const [turn] = await s.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, current!.activeTurnId!));
        expect(turn?.status, turn?.error ?? "Planning must reach the real assistant dispatcher").toBe("running");
        const [run] = await s.db.db.select().from(runs).where(eq(runs.id, turn!.runId!));
        const [stored] = await s.db.db.select().from(contextPacks).where(eq(contextPacks.id, run!.contextPackId!));
        const [message] = await s.db.db.select().from(messages).where(eq(messages.id, turn!.userMessageId));
        const context = ContextPackSchema.parse(stored!.payload);
        const envelope = AutonomousPlanningRequestV1Schema.parse(JSON.parse(context.conversation!.current_request));
        expect(message!.actorType).toBe("system");
        expect(envelope.request).toBe(message!.body);
        expect(envelope.request).toContain(routing);
        expect(envelope.planning_capability_snapshot).toEqual(automation!.planningCapabilitySnapshot);
        expect(context.policy).toMatchObject({ execution_mode: "discussion", filesystem_write_scope: [] });
        expect(context.product_development).toBeUndefined();
        expect(run!.verificationRequirement).toBeNull();
        return { run: run!, message: message!, prompt: envelope.request };
      };
      const finish = async (run: typeof runs.$inferSelect, answer: string) => {
        await ingestRunEvent(ctx, { runId: run.id, nodeId: run.computerId, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
        await ingestRunEvent(ctx, { runId: run.id, nodeId: run.computerId, sequence: 1, event: { kind: "answer", text: answer } });
        await ingestRunEvent(ctx, { runId: run.id, nodeId: run.computerId, sequence: 2, event: { kind: "lifecycle", phase: "completed" } });
        await assistant.pump();
      };
      const specs = ["research", "design", "implementation", "validation"].map((stage, index) => TaskSpecSchema.parse({ title: stage,
        development_stage: stage, acceptance_criteria: [stage], required_capabilities: ["code.modify"],
        dependencies: index ? [{ ref: String(index - 1), type: "blocks" }] : [] }));
      const tooMany = [...specs, { ...specs[3]!, title: "Extra validation", dependencies: [{ ref: "3", type: "blocks" }] }];
      for (let step = 0; step < 3; step++) {
        const current = await next();
        if (step === 2) {
          expect(current.prompt).not.toContain("execute this plan in one fixed workspace");
          expect(current.prompt).toContain("administrator-prepared destination");
        }
        await finish(current.run, step === 2 ? JSON.stringify({ rationale: "Controlled invalid five-task plan", task_specs: tooMany }) : `Controlled planning contribution ${step}`);
      }
      await planner.pump(); await goalWorker.pump();
      const repair = await next();
      expect(repair.message.actorId).toBe("goal_runner");
      expect(repair.message.payload).toMatchObject({ plan_repair_attempt: 1 });
      expect(repair.prompt).toContain("Automatic source handoff requires exactly four ordered");
      expect(repair.prompt).not.toContain("execute this plan in one fixed workspace");
      await finish(repair.run, JSON.stringify({ rationale: "Controlled valid four-stage plan", task_specs: specs }));
      await planner.pump(); await goalWorker.pump();
      const [accepted] = await s.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, goalId));
      expect(accepted!.planId).toBeTruthy();
      expect(accepted!.status).toBe("executing");
      expect(await s.db.db.select().from(tasks).where(eq(tasks.goalId, goalId))).toHaveLength(4);
      expect(await s.db.db.select().from(goalProductHandoffs)).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally { await assistant.stop(); await planner.stop(); await goalWorker.stop(); }
  });
  it("rejects grant version changes and grants without an Agent Team publication request", async () => {
    for (const change of [{ execution_mode: "single_agent" }, { release_profile_id: undefined }, { source_handoff: { version: 2, mode: "automatic" } }]) {
      const response = await server().app.inject({ method: "POST", url: "/api/v1/autonomous-goals",
        payload: { ...request, source_handoff: { version: 1, mode: "automatic" }, ...change } });
      expect(response.statusCode).toBe(400);
    }
  });
  it("requires the supported first-hop four-stage plan without weakening ordinary plan validation", () => {
    const specs = ["research", "design", "implementation", "validation"].map((stage, index) => TaskSpecSchema.parse({ title: stage,
      development_stage: stage, acceptance_criteria: [stage], dependencies: index ? [{ ref: String(index - 1), type: "blocks" }] : [] }));
    expect(automaticSourceHandoffPlanErrors(specs)).toEqual([]);
    expect(automaticSourceHandoffPlanErrors([...specs, specs[3]!])).not.toEqual([]);
    expect(automaticSourceHandoffPlanErrors(specs.map((spec, index) => index === 2 ? { ...spec, dependencies: [{ ref: "0", type: "blocks" as const }] } : spec))).not.toEqual([]);
  });
});
