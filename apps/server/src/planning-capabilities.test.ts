import { agentInstances, agents, assistantRunDispatches, assistantTurns, computers, contextPacks, discussions, goalAutomations, messages, runs, tasks } from "@artoo/db";
import { AutonomousPlanningRequestV1Schema, ContextPackSchema, type VerificationCapabilities } from "@artoo/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { createGoalAutomationDispatcher, getGoalAutomation } from "./services/goal-automation-service.js";
import { createDiscussionDispatcher, retryAutonomousSynthesis } from "./services/discussion-service.js";
import { canDispatchAssistantRun, createAssistantDispatcher } from "./services/assistant-service.js";
import { ingestRunEvent } from "./services/run-service.js";
import { buildRunContextPack } from "./services/context-pack-service.js";
import { verificationCapabilitiesFixture } from "./test-fixtures/verification-capabilities.js";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import type { NodeTransport, ServerToNodeMessage } from "@artoo/protocol";

const root = "/workspace/planning", computerId = "computer_local_mock", projectId = "proj_artoo", stop = async () => {};

/** Durable server/node-advertisement fixtures; no model or operating-system process is launched. */
describe("fixed autonomous planning capability snapshot", () => {
  let server: TestServer, advertised: VerificationCapabilities | undefined;
  const bindings: NodeBinding[] = [];
  const getter = vi.fn();
  beforeEach(async () => {
    server = await buildTestServer({ workspaceRoot: root });
    await server.db.db.update(computers).set({ os: "linux" });
    await server.db.db.update(agentInstances).set({ runtime: "codex" });
    const [agent] = await server.db.db.select().from(agents), [instance] = await server.db.db.select().from(agentInstances);
    await server.db.db.insert(agents).values({ ...agent!, id: "agent_reviewer", kind: "reviewer", capabilities: ["code.read"] });
    await server.db.db.insert(agentInstances).values({ ...instance!, id: "instance_reviewer", agentId: "agent_reviewer" });
    advertised = verificationCapabilitiesFixture(); getter.mockReset().mockImplementation(() => advertised && structuredClone(advertised));
    server.ctx.supportsExecutionFeature = (_node, feature) => feature === "run-verification.v1";
    server.ctx.supportsVerificationProfile = (node, profile, project, workspace) => node === computerId && profile === "default" && project === projectId && workspace === root;
    server.ctx.getVerificationCapabilities = getter;
    server.ctx.onRunQueued = async () => {};
  });
  afterEach(async () => { for (const binding of bindings.splice(0)) binding.close(); await server.close(); });
  const pump = () => createGoalAutomationDispatcher(server.ctx, stop).pump();
  async function create() {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/autonomous-goals", headers: { "idempotency-key": "planning-fixture" },
      payload: { project_id: projectId, objective: "Preserve the exact product requirement", max_retries: 3 } });
    expect(response.statusCode, response.body).toBe(201); return response.json().goal.id as string;
  }
  async function select() { const goalId = await create(); await pump(); return goalId; }
  async function queueNext(goalId: string) {
    await createDiscussionDispatcher(server.ctx, stop).pump(); await createAssistantDispatcher(server.ctx).pump();
    const automation = (await getGoalAutomation(server.ctx, goalId))!;
    const [discussion] = await server.db.db.select().from(discussions).where(eq(discussions.id, automation.discussion_id!));
    const [turn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, discussion!.activeTurnId!));
    return { automation, discussion: discussion!, turn: turn!,
      run: turn!.runId ? (await server.db.db.select().from(runs).where(eq(runs.id, turn!.runId)))[0] : undefined };
  }
  async function context(run: typeof runs.$inferSelect) {
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.contextPackId!));
    return ContextPackSchema.parse(stored!.payload);
  }
  async function complete(run: typeof runs.$inferSelect, answer = "Concrete planning contribution") {
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: run.computerId, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: run.computerId, sequence: 1, event: { kind: "answer", text: answer } });
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: run.computerId, sequence: 2, event: { kind: "lifecycle", phase: "completed" } });
    await createAssistantDispatcher(server.ctx).pump();
  }

  it("atomically selects one fixed writer and one snapshot under concurrent/recreated pumps", async () => {
    const goalId = await create(); await Promise.all([pump(), pump()]);
    const automation = (await getGoalAutomation(server.ctx, goalId))!;
    expect(automation.planning_capability_snapshot).toEqual({ version: 1, computer_id: computerId, project_id: projectId,
      workspace_root: root, verification_profile_id: "default", capabilities: advertised });
    expect(getter).toHaveBeenCalledTimes(1); expect(getter).toHaveBeenCalledWith(computerId, "default", projectId, root);
    expect(await server.db.db.select().from(discussions)).toHaveLength(1);
    advertised!.checks[0]!.contract.viewports[0]!.width = 999;
    await pump(); expect((await getGoalAutomation(server.ctx, goalId))!.planning_capability_snapshot).toEqual(automation.planning_capability_snapshot);
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it("rolls back the discussion and selected snapshot together when the final binding write fails", async () => {
    const goalId = await create();
    await server.db.db.execute(sql`CREATE FUNCTION reject_planning_bind() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.discussion_id IS NOT NULL AND OLD.discussion_id IS NULL THEN RAISE EXCEPTION 'controlled final binding failure'; END IF;
        RETURN NEW;
      END $$`);
    await server.db.db.execute(sql`CREATE TRIGGER reject_planning_bind BEFORE UPDATE ON goal_automations FOR EACH ROW EXECUTE FUNCTION reject_planning_bind()`);
    await pump(); const automation = (await getGoalAutomation(server.ctx, goalId))!;
    expect(automation).toMatchObject({ discussion_id: null, computer_id: null, workspace_root: null, planning_capability_snapshot: null });
    expect(automation.last_error).toContain('update "goal_automations"');
    expect(await server.db.db.select().from(discussions)).toHaveLength(0);
    expect(await server.db.db.select().from(tasks)).toHaveLength(0);
  });

  it("preserves every round, synthesis and repair request inside one snapshot without execution authority", async () => {
    const goalId = await select(), snapshot = (await getGoalAutomation(server.ctx, goalId))!.planning_capability_snapshot;
    for (let index = 0; index < 3; index++) {
      const current = await queueNext(goalId); expect(current.turn.status, current.turn.error ?? "").toBe("running");
      const payload = await context(current.run!);
      const [request] = await server.db.db.select().from(messages).where(eq(messages.id, current.turn.userMessageId));
      const envelope = AutonomousPlanningRequestV1Schema.parse(JSON.parse(payload.conversation!.current_request));
      expect(envelope.request).toBe(request!.body); expect(envelope.planning_capability_snapshot).toEqual(snapshot);
      expect(envelope.request).toContain("Preserve every explicit user requirement");
      expect(payload.conversation!.messages.some(message => message.body.includes("Preserve the exact product requirement"))).toBe(true);
      expect(payload.policy).toMatchObject({ execution_mode: "discussion", filesystem_write_scope: [] });
      expect(payload.verification_capabilities).toBeUndefined(); expect(payload.product_development).toBeUndefined();
      expect(current.run!.verificationRequirement).toBeNull();
      const [task] = await server.db.db.select().from(tasks).where(eq(tasks.id, current.run!.taskId)); expect(task!.goalId).toBeNull();
      await complete(current.run!);
    }
    await createDiscussionDispatcher(server.ctx, stop).pump();
    const automation = (await getGoalAutomation(server.ctx, goalId))!;
    await retryAutonomousSynthesis({ ...server.ctx, automationActor: { type: "system", id: "goal_runner" } }, automation.discussion_id!, "Exact repair feedback: missing scope", 1);
    const repaired = await queueNext(goalId), payload = await context(repaired.run!);
    const envelope = AutonomousPlanningRequestV1Schema.parse(JSON.parse(payload.conversation!.current_request));
    expect(envelope.request).toContain("Exact repair feedback: missing scope"); expect(envelope.planning_capability_snapshot).toEqual(snapshot);
  });

  it("gives a reviewer on another computer the writer's snapshot", async () => {
    const [computer] = await server.db.db.select().from(computers);
    await server.db.db.insert(computers).values({ ...computer!, id: "computer_reviewer", displayName: "Reviewer" });
    await server.db.db.update(agentInstances).set({ computerId: "computer_reviewer", workspaceRoot: "/review-only" }).where(eq(agentInstances.id, "instance_reviewer"));
    const ordinary = server.ctx.supportsVerificationProfile!;
    server.ctx.supportsVerificationProfile = (...args) => ordinary(...args) || args[0] === "computer_reviewer" && args[1] === "default" && args[2] === projectId && args[3] === "/review-only";
    const goalId = await select(), first = await queueNext(goalId); await complete(first.run!);
    getter.mockClear(); const second = await queueNext(goalId);
    expect(second.run!.computerId).toBe("computer_reviewer");
    const envelope = JSON.parse((await context(second.run!)).conversation!.current_request);
    expect(envelope.planning_capability_snapshot.computer_id).toBe(computerId);
    expect(getter).toHaveBeenCalledTimes(1); expect(getter).toHaveBeenCalledWith(computerId, "default", projectId, root);
  });

  it("keeps the fixed writer getter and reviewer send in one synchronous segment across a microtask disconnect", async () => {
    const [computer] = await server.db.db.select().from(computers);
    await server.db.db.insert(computers).values({ ...computer!, id: "computer_reviewer", displayName: "Reviewer" });
    await server.db.db.update(agentInstances).set({ computerId: "computer_reviewer", workspaceRoot: "/review-only" }).where(eq(agentInstances.id, "instance_reviewer"));
    const ordinary = server.ctx.supportsVerificationProfile!;
    let writerConnected = true;
    server.ctx.supportsVerificationProfile = (...args) => writerConnected && ordinary(...args)
      || args[0] === "computer_reviewer" && args[1] === "default" && args[2] === projectId && args[3] === "/review-only";
    const goalId = await select(), first = await queueNext(goalId); await complete(first.run!);
    const reviewer = await queueNext(goalId); expect(reviewer.run!.computerId).toBe("computer_reviewer");
    const order: string[] = [], sent: ServerToNodeMessage[] = [];
    getter.mockClear().mockImplementation(() => {
      order.push("writer:get");
      queueMicrotask(() => { writerConnected = false; order.push("writer:disconnect"); });
      return structuredClone(advertised);
    });
    const binding = attachNodeBinding(server.ctx, { async send(message) {
      expect(writerConnected).toBe(true); order.push("reviewer:send"); sent.push(message);
    }, subscribe() { return () => {}; }, async close() {} }, "computer_reviewer");
    bindings.push(binding); await binding.dispatchRunStart(reviewer.run!.id);
    expect(getter).toHaveBeenCalledTimes(1); expect(getter).toHaveBeenCalledWith(computerId, "default", projectId, root);
    expect(order).toEqual(["writer:get", "reviewer:send", "writer:disconnect"]);
    expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ type: "run.start", payload: { run_id: reviewer.run!.id } });
    expect(writerConnected).toBe(false);
  });

  it("defers the writer getter until the returned synchronous recheck is invoked", async () => {
    const goalId = await select(), current = await queueNext(goalId);
    let recheck: (() => void) | undefined; getter.mockClear();
    expect(await canDispatchAssistantRun(server.ctx, current.run!, { recheckPlanningCapabilities: false,
      onPlanningRecheckReady: value => { recheck = value; } })).toBe(true);
    expect(recheck).toBeTypeOf("function"); expect(getter).not.toHaveBeenCalled();
    advertised!.checks[0]!.contract.viewports[0]!.width = 987;
    expect(() => recheck!()).toThrow("fixed planning capability snapshot"); expect(getter).toHaveBeenCalledTimes(1);
  });

  it.each(["profile_digest", "config_digest", "contract_digest", "scope", "missing", "profile", "feature"] as const)(
    "rejects capability drift before assigning any planner: %s", async scenario => {
      const goalId = await select(), snapshot = (await getGoalAutomation(server.ctx, goalId))!.planning_capability_snapshot;
      if (scenario === "profile_digest") advertised!.profile_digest = `sha256:${"b".repeat(64)}`;
      else if (scenario === "config_digest" || scenario === "contract_digest") advertised!.checks[0]![scenario] = `sha256:${"d".repeat(64)}`;
      else if (scenario === "scope") advertised!.checks[0]!.contract.viewports[0]!.width = 999;
      else if (scenario === "missing") advertised = undefined;
      else if (scenario === "profile") server.ctx.supportsVerificationProfile = () => false;
      else server.ctx.supportsExecutionFeature = () => false;
      getter.mockClear(); const current = await queueNext(goalId);
      expect(current.run).toBeUndefined(); expect(current.turn.status).toBe("waiting");
      expect(current.turn.error).toMatch(/capabilit|verification profile/);
      expect(getter).toHaveBeenCalledTimes(scenario === "feature" || scenario === "profile" ? 0 : 1);
      expect(current.automation.planning_capability_snapshot).toEqual(snapshot);
    });

  it("rejects unknown-to-known drift for a newly captured null capability", async () => {
    advertised = undefined; const goalId = await select();
    expect((await getGoalAutomation(server.ctx, goalId))!.planning_capability_snapshot?.capabilities).toBeNull();
    advertised = verificationCapabilitiesFixture(); const current = await queueNext(goalId);
    expect(current.run).toBeUndefined(); expect(current.turn.error).toContain("fixed planning capability snapshot");
  });

  it("blocks queued replay drift and resumes the same run/context when the exact snapshot is restored", async () => {
    const goalId = await select(), current = await queueNext(goalId), original = structuredClone(advertised);
    advertised!.checks[0]!.contract.viewports[0]!.width = 999;
    getter.mockClear(); await expect(canDispatchAssistantRun(server.ctx, current.run!)).rejects.toThrow("fixed planning capability snapshot");
    expect(getter).toHaveBeenCalledTimes(1);
    const queuedHook = vi.fn(); server.ctx.onRunQueued = queuedHook; await createAssistantDispatcher(server.ctx).pump(); expect(queuedHook).not.toHaveBeenCalled();
    expect((await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, current.turn.id)))[0]).toMatchObject({ status: "waiting", runId: current.run!.id });
    advertised = original; await createAssistantDispatcher(server.ctx).pump(); expect(queuedHook).toHaveBeenCalledWith(current.run!.id);
    const [unchanged] = await server.db.db.select().from(runs).where(eq(runs.id, current.run!.id)); expect(unchanged).toEqual(current.run);
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
  });

  it("rechecks the actual final-send scope once and restores only its own known-unsent exposure claim", async () => {
    const goalId = await select(), current = await queueNext(goalId), original = structuredClone(advertised), sent: ServerToNodeMessage[] = [];
    const transport: NodeTransport = { async send(message) { sent.push(message); }, subscribe() { return () => {}; }, async close() {} };
    const binding = attachNodeBinding(server.ctx, transport, computerId); bindings.push(binding);
    advertised!.checks[0]!.contract.viewports[0]!.width = 999; getter.mockClear();
    await expect(binding.dispatchRunStart(current.run!.id)).rejects.toThrow("fixed planning capability snapshot");
    expect(getter).toHaveBeenCalledTimes(1); expect(sent).toHaveLength(0);
    expect((await server.db.db.select().from(assistantRunDispatches).where(eq(assistantRunDispatches.runId, current.run!.id)))[0]).toMatchObject({ state: "prepared", exposedAt: null });
    advertised = original; getter.mockClear(); await binding.dispatchRunStart(current.run!.id);
    expect(getter).toHaveBeenCalledTimes(1); expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ type: "run.start", payload: { run_id: current.run!.id } });
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
  });

  it("never clears exposure after send was invoked, even when transport throws", async () => {
    const goalId = await select(), current = await queueNext(goalId);
    const first = attachNodeBinding(server.ctx, { async send() { throw new Error("unknown delivery"); }, subscribe() { return () => {}; }, async close() {} }, computerId);
    bindings.push(first); await expect(first.dispatchRunStart(current.run!.id)).rejects.toThrow("unknown delivery");
    expect((await server.db.db.select().from(assistantRunDispatches).where(eq(assistantRunDispatches.runId, current.run!.id)))[0]?.state).toBe("exposed");
    const sent: ServerToNodeMessage[] = [], second = attachNodeBinding(server.ctx, { async send(message) { sent.push(message); }, subscribe() { return () => {}; }, async close() {} }, computerId);
    bindings.push(second); await second.dispatchRunStart(current.run!.id);
    expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ type: "run.resume", payload: { run_id: current.run!.id } });
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
  });

  it("retains the conservative exposure fence for an unknown pre-send failure", async () => {
    const goalId = await select(), current = await queueNext(goalId), sent: ServerToNodeMessage[] = [];
    const first = attachNodeBinding(server.ctx, { async send(message) { sent.push(message); }, subscribe() { return () => {}; }, async close() {} }, computerId);
    bindings.push(first); getter.mockImplementationOnce(() => { throw new Error("registry state could not be read"); });
    await expect(first.dispatchRunStart(current.run!.id)).rejects.toThrow("registry state could not be read"); expect(sent).toHaveLength(0);
    expect((await server.db.db.select().from(assistantRunDispatches).where(eq(assistantRunDispatches.runId, current.run!.id)))[0]?.state).toBe("exposed");
    const second = attachNodeBinding(server.ctx, { async send(message) { sent.push(message); }, subscribe() { return () => {}; }, async close() {} }, computerId);
    bindings.push(second); await second.dispatchRunStart(current.run!.id);
    expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ type: "run.resume", payload: { run_id: current.run!.id } });
  });

  it.each(["legacy-exact", "legacy-tampered", "captured-unknown", "changed-envelope", "actual-context"] as const)(
    "enforces exact persisted planning context with a narrow historical fallback: %s", async scenario => {
      if (scenario === "captured-unknown") advertised = undefined;
      const goalId = await select(), current = await queueNext(goalId), payload = await context(current.run!);
      const [request] = await server.db.db.select().from(messages).where(eq(messages.id, current.turn.userMessageId));
      if (scenario.startsWith("legacy")) await server.db.db.update(goalAutomations).set({ planningCapabilitySnapshot: null }).where(eq(goalAutomations.goalId, goalId));
      if (scenario === "changed-envelope") {
        const envelope = JSON.parse(payload.conversation!.current_request); envelope.request += " altered"; payload.conversation!.current_request = JSON.stringify(envelope);
      } else payload.conversation!.current_request = request!.body + (scenario === "legacy-tampered" ? " altered" : "");
      if (scenario !== "actual-context") await server.db.db.update(contextPacks).set({ payload }).where(eq(contextPacks.id, current.run!.contextPackId!));
      getter.mockClear();
      if (scenario === "legacy-exact") {
        expect(await canDispatchAssistantRun(server.ctx, current.run!)).toBe(true); expect(getter).not.toHaveBeenCalled();
        const sent: ServerToNodeMessage[] = [], binding = attachNodeBinding(server.ctx, { async send(message) { sent.push(message); },
          subscribe() { return () => {}; }, async close() {} }, computerId);
        bindings.push(binding); await binding.dispatchRunStart(current.run!.id);
        expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ type: "run.start", payload: { run_id: current.run!.id } });
        expect(getter).not.toHaveBeenCalled();
        expect((await getGoalAutomation(server.ctx, goalId))!.planning_capability_snapshot).toBeNull();
      } else await expect(canDispatchAssistantRun(server.ctx, current.run!, scenario === "actual-context" ? { context: payload } : {})).rejects.toThrow("original request and capability snapshot");
    });

  it("keeps historical recovery unsampled and uses an explicit null envelope for its next new context", async () => {
    const goalId = await select(), automation = (await getGoalAutomation(server.ctx, goalId))!;
    await server.db.db.update(goalAutomations).set({ discussionId: null, planningCapabilitySnapshot: null }).where(eq(goalAutomations.goalId, goalId));
    getter.mockClear(); await pump(); const current = await queueNext(goalId);
    expect(current.automation.discussion_id).toBe(automation.discussion_id); expect(current.automation.planning_capability_snapshot).toBeNull();
    expect(JSON.parse((await context(current.run!)).conversation!.current_request).planning_capability_snapshot).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not import planning scope through a foreign project discussion link", async () => {
    const goalId = await select(), current = await queueNext(goalId);
    const [task] = await server.db.db.select().from(tasks).where(eq(tasks.id, current.run!.taskId));
    await expect(server.db.transaction(tx => buildRunContextPack(server.ctx, tx, { runId: "run_foreign", task: { ...task!, projectId: "foreign_project" },
      assistantTurnId: current.turn.id, workspaceRoot: root }))).rejects.toThrow("does not belong to this task's project");
  });
});
