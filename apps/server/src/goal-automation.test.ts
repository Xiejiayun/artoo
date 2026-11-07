import { agentInstances, agents, computers, contextPacks, discussions, assistantTurns, eventLog, goalAutomations, goals, messages, runEvidence, runEventIngest, runs, tasks } from "@artoo/db";
import { ContextPackSchema, type RunVerificationPayload, type VerificationRequirement } from "@artoo/domain";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { createGoalAutomationDispatcher, getGoalAutomation } from "./services/goal-automation-service.js";
import { createDiscussionDispatcher } from "./services/discussion-service.js";
import { createAssistantDispatcher } from "./services/assistant-service.js";
import { failRunDaemonDisconnect, failRunStart, ingestRunEvent, ingestWireRunEvent } from "./services/run-service.js";
import { getGoal, pauseGoal, resumeGoal, transitionGoal } from "./services/goal-service.js";
import { grantAiDataSharingConsent, revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { getGoalProductRelease, ingestProductReleaseReceipt } from "./services/product-release-service.js";

const digest = `sha256:${"a".repeat(64)}`;
const specs = [{ title: "Implement", description: "Build the requested API", acceptance_criteria: ["The API returns the requested result"], required_capabilities: ["code.modify"] },
  { title: "Finish", description: "Complete workspace documentation", acceptance_criteria: ["Usage is documented"], dependencies: [{ ref: "0", type: "blocks" }] }];

describe("autonomous verified-workspace orchestration", () => {
  let server: TestServer;
  const stop = async () => {};
  beforeEach(async () => {
    server = await buildTestServer({ workspaceRoot: "/workspace/verified" });
    // Deterministic provider/node fixtures: no live model or host process is launched.
    await server.db.db.update(computers).set({ os: "linux" });
    await server.db.db.update(agentInstances).set({ runtime: "codex" });
    const [agent] = await server.db.db.select().from(agents);
    const [instance] = await server.db.db.select().from(agentInstances);
    await server.db.db.insert(agents).values({ ...agent!, id: "agent_reviewer", kind: "reviewer" });
    await server.db.db.insert(agentInstances).values({ ...instance!, id: "instance_reviewer", agentId: "agent_reviewer" });
    server.ctx.supportsExecutionFeature = (_computer, feature) => feature === "run-verification.v1";
    server.ctx.supportsVerificationProfile = (computer, profile, project, root) => computer === "computer_local_mock"
      && profile === "default" && project === "proj_artoo" && root === "/workspace/verified";
  });
  afterEach(async () => { await server.close(); });

  async function create(maxRetries = 3, key = "autonomous-request", releaseProfile?: string) {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/autonomous-goals", headers: { "idempotency-key": key },
      payload: { project_id: "proj_artoo", objective: "Build a documented API", max_retries: maxRetries,
        ...(releaseProfile ? { release_profile_id: releaseProfile } : {}) } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().goal.id as string;
  }
  const taskRows = (goalId: string) => server.db.db.select().from(tasks).where(eq(tasks.goalId, goalId)).orderBy(asc(tasks.sourcePlanSpecRef));
  const runRows = (taskId: string) => server.db.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.id));

  async function plan(goalId: string, taskSpecs: unknown[] = specs) {
    const worker = createGoalAutomationDispatcher(server.ctx, stop);
    await worker.pump();
    const automation = await getGoalAutomation(server.ctx, goalId);
    expect(automation?.discussion_id, automation?.last_error ?? "planning should start").toBeTruthy();
    const discussionWorker = createDiscussionDispatcher(server.ctx, stop);
    const assistant = createAssistantDispatcher(server.ctx);
    for (let index = 0; index < 3; index++) {
      await discussionWorker.pump(); await assistant.pump();
      const [discussion] = await server.db.db.select().from(discussions).where(eq(discussions.id, automation!.discussion_id!));
      const [turn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, discussion!.activeTurnId!));
      expect(turn?.status, turn?.error ?? "planning turn should execute").toBe("running");
      const [run] = await server.db.db.select().from(runs).where(eq(runs.id, turn!.runId!));
      const [storedPack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run!.contextPackId!));
      const pack = ContextPackSchema.parse(storedPack!.payload);
      const [root] = await server.db.db.select().from(messages).where(eq(messages.id, discussion!.threadRootId));
      expect(root).toMatchObject({ actorType: "system", actorId: "goal_runner" });
      expect(root!.body).toContain("Build a documented API");
      expect(root!.body).toContain("Acceptance criteria:");
      expect(root!.body).toContain("The configured node verification profile passes against the delivered workspace.");
      expect(pack.conversation?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: root!.id, actor_id: "goal_runner", body: root!.body }),
      ]));
      await ingestRunEvent(server.ctx, { runId: run!.id, nodeId: run!.computerId, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
      await ingestRunEvent(server.ctx, { runId: run!.id, nodeId: run!.computerId, sequence: 1,
        event: { kind: "answer", text: index === 2 ? JSON.stringify({ rationale: "Fixture plan", task_specs: taskSpecs }) : `Concrete planning contribution ${index}` } });
      await ingestRunEvent(server.ctx, { runId: run!.id, nodeId: run!.computerId, sequence: 2, event: { kind: "lifecycle", phase: "completed" } });
      await assistant.pump();
    }
    await discussionWorker.pump();
    await Promise.all([worker.pump(), createGoalAutomationDispatcher(server.ctx, stop).pump()]);
    expect((await getGoalAutomation(server.ctx, goalId))?.plan_id).toBeTruthy();
    await assistant.stop(); await discussionWorker.stop(); await worker.stop();
    return taskRows(goalId);
  }

  async function startTask(goalId: string, taskId: string) {
    const worker = createGoalAutomationDispatcher(server.ctx, stop);
    for (let step = 0; step < 3 && !(await runRows(taskId)).some((run) => run.status === "queued"); step++) await worker.pump();
    const taskRuns = await runRows(taskId), run = taskRuns.at(-1)!;
    expect(run?.status, (await getGoalAutomation(server.ctx, goalId))?.last_error ?? "task should dispatch").toBe("queued");
    expect(run.verificationRequirement).toMatchObject({ version: 1, profile_id: "default" });
    await worker.stop();
    return run;
  }

  async function finish(run: typeof runs.$inferSelect, outcome: "passed" | "failed" | "missing" = "passed", terminal: "completed" | "failed" = "completed") {
    await ingestWireRunEvent(server.ctx, { kind: "run.event", node_id: run.computerId, run_id: run.id, sequence: 0, event: { type: "run.lifecycle", payload: { phase: "started" } } });
    if (outcome !== "missing") {
      const requirement = run.verificationRequirement as VerificationRequirement;
      const payload: RunVerificationPayload = { ...requirement, profile_digest: digest, subject_digest: digest, outcome,
        checks: [{ id: "behavior", exit_code: outcome === "passed" ? 0 : 1, duration_ms: 10, output_digest: digest }], required_files: [],
        ...(outcome === "failed" ? { reason: "Behavior check rejected the implementation" } : {}) };
      await ingestWireRunEvent(server.ctx, { kind: "run.event", node_id: run.computerId, run_id: run.id, sequence: 1, event: { type: "run.verification", payload } });
    }
    await ingestWireRunEvent(server.ctx, { kind: "run.event", node_id: run.computerId, run_id: run.id, sequence: outcome === "missing" ? 1 : 2,
      event: { type: "run.lifecycle", payload: { phase: terminal, ...(terminal === "failed" ? { reason: "process failed" } : {}) } } });
  }

  it("turns one idempotent request into a planned DAG and evidence-reviewed completion across recreated dispatchers", async () => {
    const goalId = await create(); expect(await create()).toBe(goalId);
    expect(await server.db.db.select().from(goals)).toHaveLength(1);
    const children = await plan(goalId);
    expect(children).toHaveLength(2);
    const automationPlan = (await getGoalAutomation(server.ctx, goalId))!.plan_id;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/plans/${automationPlan}/accept` })).statusCode).toBe(403);
    for (const task of children) {
      const run = await startTask(goalId, task.id);
      await Promise.all([createGoalAutomationDispatcher(server.ctx, stop).pump(), createGoalAutomationDispatcher(server.ctx, stop).pump()]);
      expect(await runRows(task.id)).toHaveLength(1);
      await finish(run);
      const external = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/review`, payload: { outcome: "accepted" } });
      expect(external.statusCode).toBe(403);
      await createGoalAutomationDispatcher(server.ctx, stop).pump();
      const [evidence] = await server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, run.id));
      const [review] = await server.db.db.select().from(eventLog).where(and(eq(eventLog.taskId, task.id), eq(eventLog.type, "review.completed")));
      expect(review?.payload).toMatchObject({ outcome: "accepted", verified_run_id: run.id,
        verification_evidence_id: evidence!.id, verification_request_id: (run.verificationRequirement as VerificationRequirement).request_id,
        profile_digest: digest, subject_digest: digest });
      const [receipt] = await server.db.db.select().from(runEventIngest).where(and(eq(runEventIngest.runId, run.id), eq(runEventIngest.sequence, 1)));
      expect(receipt?.eventId).toBe(evidence!.eventId);
      const [verificationEvent] = await server.db.db.select().from(eventLog).where(eq(eventLog.id, evidence!.eventId));
      expect(verificationEvent).toMatchObject({ runId: run.id, type: "run.verification", actorType: "system", actorId: run.computerId });
    }
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoal(server.ctx, goalId))?.status).toBe("completed");
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "completed", delivery: "verified_workspace" });
    const reviews = await server.db.db.select().from(eventLog).where(eq(eventLog.type, "review.completed"));
    expect(reviews.filter((event) => children.some((task) => task.id === event.taskId))).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorType: "system", actorId: "goal_runner" }),
    ]));
  });

  it("retries failed checks with a new request and never accepts absent or old evidence", async () => {
    const goalId = await create(); const [task] = await plan(goalId, specs.slice(0, 1));
    const first = await startTask(goalId, task!.id); await finish(first, "failed");
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(1);
    const second = await startTask(goalId, task!.id);
    expect(second.verificationRequirement).not.toEqual(first.verificationRequirement);
    await finish(second, "missing"); await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoal(server.ctx, goalId))?.status).toBe("running");
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(2);
    const third = await startTask(goalId, task!.id); await finish(third); await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoal(server.ctx, goalId))?.status).toBe("completed");
    const reviewEvents = await server.db.db.select().from(eventLog).where(and(eq(eventLog.taskId, task!.id), eq(eventLog.type, "review.completed")));
    expect(reviewEvents.map((event) => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "accepted", verified_run_id: third.id,
        verification_request_id: (third.verificationRequirement as VerificationRequirement).request_id }),
    ]));
  });

  it("keeps all-done publication goals running through reconciliation until the exact healthy release receipt", async () => {
    const goalId = await create(3, "publish-objective", "site"), [task] = await plan(goalId, specs.slice(0, 1));
    server.ctx.supportsReleaseProfile = () => true;
    const run = await startTask(goalId, task!.id); await finish(run);
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await taskRows(goalId))[0]?.status).toBe("done");
    expect((await getGoal(server.ctx, goalId))?.status).toBe("running");
    const reconciled = await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/reconcile` });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json().goal_status).toBe("running");
    await expect(transitionGoal(server.ctx, goalId, "all_tasks_terminal")).rejects.toThrow(/verified task and release gates/);
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    const release = await getGoalProductRelease(server.ctx, goalId);
    expect(release?.status).toBe("queued");
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "executing", delivery: "verified_workspace" });
    const receipt = { request: release!.request, release_profile_digest: digest, artifact_digest: release!.request.subject_digest,
      outcome: "published" as const, endpoint: "https://product.example", previous_release_id: null,
      health_checks: [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: server.ctx.clock.nowIso() }] };
    await expect(ingestProductReleaseReceipt(server.ctx, run.computerId, { ...receipt,
      artifact_digest: `sha256:${"b".repeat(64)}`,
      request: { ...receipt.request, subject_digest: `sha256:${"b".repeat(64)}` } })).rejects.toThrow(/immutable request/);
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoal(server.ctx, goalId))?.status).toBe("running");
    await ingestProductReleaseReceipt(server.ctx, run.computerId, receipt);
    await pauseGoal(server.ctx, goalId);
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoal(server.ctx, goalId))?.status).toBe("paused");
    expect((await getGoalAutomation(server.ctx, goalId))?.delivery).toBe("verified_workspace");
    await resumeGoal(server.ctx, goalId);
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoal(server.ctx, goalId))?.status).toBe("completed");
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "completed", delivery: "published_product" });
    const completed = await server.db.db.select().from(eventLog).where(and(eq(eventLog.goalId, goalId), eq(eventLog.type, "goal.completed")));
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ trigger: "product_release_healthy", endpoint: receipt.endpoint });
  });

  it("stops at the retry budget and refuses expected-artifact claims without actual outputs", async () => {
    const goalId = await create(0); const [task] = await plan(goalId, [{ ...specs[0], expected_artifacts: [{ type: "report", description: "Implementation evidence" }] }]);
    const run = await startTask(goalId, task!.id); await finish(run);
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "failed" });
    expect((await getGoal(server.ctx, goalId))?.status).not.toBe("completed");
    expect((await taskRows(goalId))[0]?.status).toBe("review");
  });

  it("does not accept a failed process even when it reported passing verification", async () => {
    const goalId = await create(0); const [task] = await plan(goalId, specs.slice(0, 1));
    await finish(await startTask(goalId, task!.id), "passed", "failed");
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoal(server.ctx, goalId))?.status).not.toBe("completed");
    expect((await taskRows(goalId))[0]?.status).toBe("blocked");
  });

  it("fences planning and task dispatch during pause and cancels its separate planning session", async () => {
    const goalId = await create(); const worker = createGoalAutomationDispatcher(server.ctx, stop);
    await worker.pump(); await pauseGoal(server.ctx, goalId); await worker.pump();
    const discussion = createDiscussionDispatcher(server.ctx, stop); await discussion.pump();
    expect(await server.db.db.select().from(assistantTurns)).toHaveLength(0);
    await resumeGoal(server.ctx, goalId); expect((await getGoal(server.ctx, goalId))?.status).toBe("draft");
    await discussion.pump(); expect(await server.db.db.select().from(assistantTurns)).toHaveLength(1);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/cancel` })).statusCode).toBe(200); await worker.pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("cancelled");
    const [session] = await server.db.db.select().from(discussions);
    expect(session?.status).toBe("cancelled");
    await worker.stop(); await discussion.stop();
  });

  it("keeps the original consent bound after withdrawal and a later regrant", async () => {
    const policy = buildAiDataSharingPolicy({ mode: "external", providers: [{ id: "fixture", name: "Fixture", privacy_url: "https://provider.example.com/privacy" }] });
    server.ctx.aiDataSharingPolicy = policy; await grantAiDataSharingConsent(server.ctx, policy.version);
    const goalId = await create(); const worker = createGoalAutomationDispatcher(server.ctx, stop);
    await revokeAiDataSharingConsent(server.ctx); await grantAiDataSharingConsent(server.ctx, policy.version);
    await worker.pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("waiting");
    expect(await server.db.db.select().from(discussions)).toHaveLength(0);
    await worker.stop();
  });

  it("rejects manual assignments, unsupported nodes and changing the fixed workspace", async () => {
    const goalId = await create(); const [task] = await plan(goalId, specs.slice(0, 1));
    const attempt = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task!.id}/assign`, payload: { mode: "auto" } });
    expect(attempt.statusCode).toBe(403);
    const automation = await getGoalAutomation(server.ctx, goalId);
    await server.db.db.update(agentInstances).set({ workspaceRoot: "/different" }).where(eq(agentInstances.id, automation!.agent_instance_id!));
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("failed");
    expect(await runRows(task!.id)).toHaveLength(0);
  });

  it("reserves the whole workspace between executions and rejects normalized parent/child overlap", async () => {
    const goalId = await create(); const [task] = await plan(goalId, specs.slice(0, 1));
    await finish(await startTask(goalId, task!.id));
    const manual = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Other work", acceptance_criteria: ["Separate result"], required_capabilities: [],
    } })).json().task;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${manual.id}/ready` });
    await server.db.db.update(agentInstances).set({ workspaceRoot: "/workspace/verified/sub/../sub" }).where(eq(agentInstances.id, "instance_reviewer"));
    const attempted = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${manual.id}/assign`, payload: { mode: "manual", agent_instance_id: "instance_reviewer" } });
    expect(attempted.statusCode, attempted.body).toBe(409);
    expect(attempted.body).toContain("reserved for another autonomous goal");
    expect(await runRows(manual.id)).toHaveLength(0);
    await createGoalAutomationDispatcher(server.ctx, stop).pump(); await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("completed");
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${manual.id}/assign`, payload: { mode: "manual", agent_instance_id: "instance_reviewer" } })).statusCode).toBe(200);
  });

  it("waits when a real second participant or verification node is unavailable", async () => {
    const goalId = await create(); server.ctx.supportsExecutionFeature = () => false;
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.last_error).toContain("verification-capable");
    expect(await server.db.db.select().from(discussions)).toHaveLength(0);
  });

  it("skips the first feature-capable candidate when its profile binding does not match and selects the advertised worker", async () => {
    const [computer] = await server.db.db.select().from(computers);
    await server.db.db.insert(computers).values({ ...computer!, id: "computer_verified", hostname: "verified-host" });
    await server.db.db.update(agentInstances).set({ computerId: "computer_verified", workspaceRoot: "/workspace/matched" }).where(eq(agentInstances.id, "instance_reviewer"));
    const [reviewer] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_reviewer"));
    await server.db.db.insert(agentInstances).values({ ...reviewer!, id: "instance_zreviewer" });
    server.ctx.supportsVerificationProfile = (computerId, profile, project, root) => computerId === "computer_verified"
      && profile === "default" && project === "proj_artoo" && root === "/workspace/matched";
    const goalId = await create(); await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "planning", agent_instance_id: "instance_reviewer",
      computer_id: "computer_verified", workspace_root: "/workspace/matched" });
  });

  it("skips a higher-ranked planning reviewer advertising another project's workspace", async () => {
    const [reviewer] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_reviewer"));
    await server.db.db.insert(agentInstances).values({ ...reviewer!, id: "instance_aaa_other", workspaceRoot: "/workspace/other-project" });
    server.ctx.supportsVerificationProfile = (computer, profile, project, root) => computer === "computer_local_mock"
      && profile === "default" && ((project === "proj_artoo" && root === "/workspace/verified")
        || (project === "proj_other" && root === "/workspace/other-project"));
    const goalId = await create(); await plan(goalId, specs.slice(0, 1));
    const automation = await getGoalAutomation(server.ctx, goalId);
    const [discussion] = await server.db.db.select().from(discussions).where(eq(discussions.id, automation!.discussion_id!));
    expect(discussion!.participants).toEqual([
      expect.objectContaining({ agent_instance_id: "instance_mock_coder" }),
      expect.objectContaining({ agent_instance_id: "instance_reviewer" }),
    ]);
    expect(await server.db.db.select().from(runs).where(eq(runs.agentInstanceId, "instance_aaa_other"))).toHaveLength(0);
  });

  it("waits without creating a partial discussion when only the writer advertises the requested binding", async () => {
    await server.db.db.update(agentInstances).set({ workspaceRoot: "/workspace/other-project" }).where(eq(agentInstances.id, "instance_reviewer"));
    const goalId = await create(); await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "waiting", discussion_id: null, agent_instance_id: null });
    expect((await getGoalAutomation(server.ctx, goalId))?.last_error).toContain("second available planning instance");
    expect(await server.db.db.select().from(discussions)).toHaveLength(0);
  });

  it("does not plan on a feature-only legacy node or assign after a current profile binding disappears", async () => {
    const advertised = server.ctx.supportsVerificationProfile;
    server.ctx.supportsVerificationProfile = undefined;
    const goalId = await create(); await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.last_error).toContain("verification profile");
    expect(await server.db.db.select().from(discussions)).toHaveLength(0);
    server.ctx.supportsVerificationProfile = advertised;
    const [task] = await plan(goalId, specs.slice(0, 1));
    server.ctx.supportsVerificationProfile = () => false;
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.last_error).toContain("no longer advertises");
    expect(await runRows(task!.id)).toHaveLength(0);
    server.ctx.supportsVerificationProfile = advertised;
    expect((await startTask(goalId, task!.id)).status).toBe("queued");
  });

  it("persists the exact advertised canonical root for an ordinary autonomous run", async () => {
    await server.db.db.update(agentInstances).set({ workspaceRoot: "/workspace/./verified/" }).where(eq(agentInstances.id, "instance_mock_coder"));
    const goalId = await create(); const [task] = await plan(goalId, specs.slice(0, 1));
    const run = await startTask(goalId, task!.id);
    expect((await getGoalAutomation(server.ctx, goalId))?.workspace_root).toBe("/workspace/verified");
    expect(run).toMatchObject({ workspaceRoot: "/workspace/verified", workspaceBranch: null, workspaceAllocation: null });
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.contextPackId!));
    expect(ContextPackSchema.parse(stored!.payload).workspace.root).toBe("/workspace/verified");
  });

  it("does not reserve a workspace with an unconfirmed disconnected writer, even without file leases", async () => {
    const task = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Existing writer", acceptance_criteria: ["Finish"], required_capabilities: [],
    } })).json().task;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/ready` });
    const run = (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/assign`, payload: { mode: "auto" } })).json().run;
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: run.computer_id, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await failRunDaemonDisconnect(server.ctx, run.id, run.computer_id);
    const goalId = await create(); await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.status).toBe("waiting");
    expect(await server.db.db.select().from(discussions)).toHaveLength(0);
    await failRunDaemonDisconnect(server.ctx, run.id, run.computer_id, true);
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect((await getGoalAutomation(server.ctx, goalId))?.discussion_id).toBeTruthy();
  });

  it("rejects manual planning before the first automatic pump instead of losing the fixed worker", async () => {
    const goalId = await create();
    const response = await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/discussions`, payload: {
      participants: [{ agent_instance_id: "instance_mock_coder", role: "Writer" }, { agent_instance_id: "instance_reviewer", role: "Reviewer" }],
      rounds: 1, max_minutes: 5,
    } });
    expect(response.statusCode, response.body).toBe(403);
    expect(await server.db.db.select().from(discussions)).toHaveLength(0);
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "planning", agent_instance_id: "instance_mock_coder",
      computer_id: "computer_local_mock", workspace_root: "/workspace/verified" });
    expect((await getGoalAutomation(server.ctx, goalId))?.discussion_id).toBeTruthy();
  });

  it("fails and stops an incomplete historical planning adoption rather than waiting forever", async () => {
    const goalId = await create(); const worker = createGoalAutomationDispatcher(server.ctx, stop);
    await worker.pump();
    const original = await getGoalAutomation(server.ctx, goalId);
    // Restore the incomplete state produced by the old non-atomic adoption path.
    await server.db.db.update(goalAutomations).set({ discussionId: null, agentInstanceId: null, computerId: null, workspaceRoot: null }).where(eq(goalAutomations.goalId, goalId));
    await worker.stop(); await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "failed", discussion_id: original!.discussion_id });
    expect((await getGoalAutomation(server.ctx, goalId))?.last_error).toContain("missing the fixed worker");
    const [stopping] = await server.db.db.select().from(discussions).where(eq(discussions.id, original!.discussion_id!));
    expect(stopping?.status).toBe("stopping");
    const discussionWorker = createDiscussionDispatcher(server.ctx, stop); await discussionWorker.pump();
    const [discussion] = await server.db.db.select().from(discussions).where(eq(discussions.id, original!.discussion_id!));
    expect(discussion?.status).toBe("cancelled");
    await discussionWorker.stop();
    expect(await server.db.db.select().from(discussions)).toHaveLength(1);
  });

  it.each([0, 2])("bounds actual rejected run.start acknowledgements at max_retries=%i", async (maxRetries) => {
    const goalId = await create(maxRetries); const [task] = await plan(goalId, specs.slice(0, 1));
    let run = await startTask(goalId, task!.id);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await failRunStart(server.ctx, run.id, "permission_denied", "The requested verification profile is not configured");
      const [failed] = await server.db.db.select().from(runs).where(eq(runs.id, run.id));
      expect(failed?.status).toBe("failed");
      expect(failed?.startedAt).not.toBeNull(); // This is a start attempt, not a run.started acknowledgement.
      expect((await taskRows(goalId))[0]?.status).toBe("ready");
      await createGoalAutomationDispatcher(server.ctx, stop).pump();
      if (attempt < maxRetries) {
        expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(attempt + 1);
        run = (await runRows(task!.id)).at(-1)!;
        expect(run.status).toBe("queued");
      }
    }
    await createGoalAutomationDispatcher(server.ctx, stop).pump();
    expect(await runRows(task!.id)).toHaveLength(maxRetries + 1);
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(maxRetries);
    expect(await getGoalAutomation(server.ctx, goalId)).toMatchObject({ status: "failed", last_error: "Goal retry budget would be exceeded" });
  });

  it("counts a genuinely started execution failure once through retryTask, not again on reassignment", async () => {
    const goalId = await create(1); const [task] = await plan(goalId, specs.slice(0, 1));
    const first = await startTask(goalId, task!.id);
    await finish(first, "missing", "failed");
    const worker = createGoalAutomationDispatcher(server.ctx, stop);
    await worker.pump();
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(1);
    const second = await startTask(goalId, task!.id);
    expect(second.id).not.toBe(first.id);
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(1);
    await finish(second); await worker.pump();
    expect((await getGoal(server.ctx, goalId))?.status).toBe("completed");
    await worker.stop();
  });
});
