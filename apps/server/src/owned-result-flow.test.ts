import { createHash } from "node:crypto";
import { agentInstances, agentRuntimes, computers, contextPacks, runEvidence, runEventIngest, runs, tasks } from "@artoo/db";
import { NodeOwnedResultProfileDescriptorV1Schema, NodeOwnedResultVerificationEvidenceV1Schema,
  canonicalOwnedResultRequirementV1, canonicalOwnedResultVerificationIntentV1, OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST,
  type NodeOwnedResultProfileDescriptorV1, type Run } from "@artoo/domain";
import type { NodeRunEvent, NodeTransport, RunEventMessage, ServerToNodeMessage } from "@artoo/protocol";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { parseOwnedResultAssignment } from "./services/owned-result-service.js";
import { cancelRun, ingestRunEvent, ingestWireRunEvent } from "./services/run-service.js";
import { qualifyRunEventMessage } from "./services/run-event-receipt.js";

const NODE = "computer_local_mock", INSTANCE = "ai_owned_result";
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
// Controlled protocol evidence only. These tests exercise migrated storage,
// real assignment/dispatch/ingest/review boundaries, never a provider or process verifier.
const descriptor = NodeOwnedResultProfileDescriptorV1Schema.parse({ version: 1, node_id: NODE, project_id: "proj_artoo",
  result_profile: { id: "results", digest: sha("profile"), repository_binding: sha("repo"), baseline_commit: "a".repeat(40) },
  verifier_template: { id: "checks", digest: sha("template") }, workspace_strategy: "per-run", verification_mode: "plain-commands",
  verification_context_policy: { version: 1, mode: "none" }, content_paths: ["src"],
  scope: "authored-result command verification; no product-stage, review or publication acceptance" });

describe("owned result assignment through qualified dispatch and committed receipts", () => {
  let server: TestServer;
  const bindings: NodeBinding[] = [], sent: ServerToNodeMessage[] = [];
  beforeEach(async () => {
    server = await buildTestServer({ workspaceRoot: "/source" }); server.ctx.onRunQueued = async () => {};
    const [seed] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    if (!seed) throw new Error("Missing seeded instance");
    await server.db.db.update(agentInstances).set({ status: "disabled" }).where(eq(agentInstances.id, seed.id));
    await server.db.db.update(computers).set({ os: "linux" }).where(eq(computers.id, NODE));
    await server.db.db.update(agentRuntimes).set({ runtime: "fixture" }).where(eq(agentRuntimes.computerId, NODE));
    // Per-run allocation requires the production ai_ identifier contract; the
    // legacy demo seed intentionally predates that namespace.
    await server.db.db.insert(agentInstances).values({ ...seed, id: INSTANCE, runtime: "fixture", config: { concurrency_limit: 4,
      worktree_workspace_base: { version: 1, strategy: "per-run", basePath: "/allocated" } } });
  });
  afterEach(async () => { for (const binding of bindings.splice(0)) binding.close(); sent.length = 0; await server.close(); });
  function bind(profiles: NodeOwnedResultProfileDescriptorV1[] = [structuredClone(descriptor)], managed = true) {
    const transport: NodeTransport = { subscribe: () => () => {}, close: async () => {}, async send(message) {
      if (message.type === "run.event.ack" && message.payload.status === "accepted") {
        const [receipt] = await server.db.db.select().from(runEventIngest).where(and(eq(runEventIngest.runId, message.payload.run_id),
          eq(runEventIngest.sequence, message.payload.sequence)));
        expect(receipt?.bodyIdentity).toBeTruthy(); // ACK is sent only after the actual transaction committed.
      }
      sent.push(structuredClone(message));
    } };
    const binding: NodeBinding = attachNodeBinding(server.ctx, transport, NODE, ["workspace-allocation.per-run-v1", "owned-result-run.v1"],
      () => server.nodeRegistry.get(NODE) === binding, [], [], profiles, () => managed);
    bindings.push(binding); server.nodeRegistry.register(NODE, binding); return binding;
  }
  async function ready() {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: { project_id: "proj_artoo",
      title: "Fixed result", acceptance_criteria: ["Keep the result"], required_capabilities: ["code.modify"] } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
    return id;
  }
  const assign = (taskId: string, input: { kind: "baseline" } | { kind: "accepted_run"; run_id: string } = { kind: "baseline" }) =>
    server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign-owned-result`, payload: {
      version: 1, agent_instance_id: INSTANCE, result_profile_id: "results", verifier_template_id: "checks", input,
    } });
  async function queued() {
    const taskId = await ready(), response = await assign(taskId);
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json().run as Run;
    const [stored] = await server.db.db.select().from(runs).where(eq(runs.id, run.id));
    return { taskId, run, stored: stored!, assignment: parseOwnedResultAssignment(stored!)! };
  }
  const frame = (run: Run, sequence: number, event: NodeRunEvent): RunEventMessage => ({ kind: "run.event", node_id: NODE, run_id: run.id, sequence, event });
  async function deliver(binding: NodeBinding, message: RunEventMessage) {
    const count = sent.length; binding.receive(message); await binding.drain();
    return sent.slice(count).filter(value => value.type === "run.event.ack").at(-1)?.payload.status;
  }
  function evidence(value: Awaited<ReturnType<typeof queued>>, passed = true) {
    const { request, author_launch_digest } = value.assignment, requirement = request.requirement, start = request.run_start;
    const payload = { version: 1, request_id: requirement.request_id, profile_id: "checks", profile_digest: sha("physical profile"),
      subject_digest: sha("actual subject"), outcome: passed ? "passed" : "failed",
      checks: [{ id: "check", exit_code: passed ? 0 : 7, duration_ms: 3, output_digest: sha("output") }], required_files: [] };
    const result = NodeOwnedResultVerificationEvidenceV1Schema.parse({ version: 1, kind: "authored-result-verification", requirement,
      requirement_digest: sha(canonicalOwnedResultRequirementV1(requirement)), author: { run_id: start.run_id, task_id: start.task_id,
        agent_instance_id: start.agent_instance_id, runtime: start.runtime, workspace: start.workspace,
        launch_binding_digest: author_launch_digest, author_context_digest: requirement.author_context_digest },
      template: { ...descriptor.verifier_template, node_id: NODE, project_id: "proj_artoo" },
      result: { kind: "authored", reference: { result_id: requirement.capture_request_id, receipt_digest: sha(`receipt:${start.run_id}`) },
        profile_id: "results", profile_digest: descriptor.result_profile.digest, repository_binding: descriptor.result_profile.repository_binding,
        base_commit: value.assignment.accepted_input?.commit ?? descriptor.result_profile.baseline_commit,
        commit: "b".repeat(40), tree: "c".repeat(40), manifest_digest: sha("manifest"),
        inputs: requirement.input.kind === "result" ? [requirement.input.reference] : [] },
      verification: { receipt: { verification_id: requirement.request_id, receipt_digest: sha("verifier receipt") },
        intent_digest: sha("temporary"), workspace: { root: `/verified/${requirement.request_id}`, branch: `verified/${requirement.request_id}` },
        execution: { version: 1, request_id: requirement.request_id, profile_id: "checks", profile_digest: payload.profile_digest,
          workspace_root: `/verified/${requirement.request_id}`, subject_digest: payload.subject_digest, context_digest: OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST }, payload },
      scope: "historical plain-command node evidence; no product-stage, independent review or publication acceptance" });
    result.verification.intent_digest = sha(canonicalOwnedResultVerificationIntentV1(result)); return result;
  }
  const retained = (run: Run): NodeRunEvent => ({ type: "run.workspace.retained", payload: {
    version: 1, workspace_root: run.workspace_root!, workspace_branch: run.workspace_branch!, outcome: "completed" } });
  async function complete(binding: NodeBinding, value: Awaited<ReturnType<typeof queued>>) {
    expect(await deliver(binding, frame(value.run, 0, { type: "run.lifecycle", payload: { phase: "started" } }))).toBe("accepted");
    const measured = frame(value.run, 1, { type: "run.owned-result.verification", payload: evidence(value) });
    expect(await deliver(binding, measured)).toBe("accepted");
    expect(await deliver(binding, measured)).toBe("accepted");
    const [receipt] = await server.db.db.select().from(runEventIngest).where(and(eq(runEventIngest.runId, value.run.id), eq(runEventIngest.sequence, 1)));
    expect(receipt?.bodyIdentity).toBe(qualifyRunEventMessage(measured).bodyIdentity);
    expect(await deliver(binding, frame(value.run, 2, retained(value.run)))).toBe("accepted");
    expect(await deliver(binding, frame(value.run, 3, { type: "run.lifecycle", payload: { phase: "completed" } }))).toBe("accepted");
    return measured;
  }

  it("persists and resends the complete original request, then accepts exact evidence, review and result continuation", async () => {
    const binding = bind(), value = await queued();
    await binding.dispatchRunStart(value.run.id);
    expect(sent[0]).toMatchObject({ type: "run.start.owned-result.v1", idempotency_key: `${value.run.id}:start`, payload: value.assignment.request });
    expect(value.stored.verificationRequirement).toBeNull();
    await server.db.db.update(agentInstances).set({ config: { concurrency_limit: 4,
      worktree_workspace_base: { version: 1, strategy: "per-run", basePath: "/changed" } } }).where(eq(agentInstances.id, INSTANCE));
    await binding.dispatchRunStart(value.run.id);
    expect(sent[1]).toMatchObject({ payload: value.assignment.request });
    await expect(server.db.db.update(runs).set({ ownedResultAssignment: null }).where(eq(runs.id, value.run.id))).rejects.toThrow();
    const measured = await complete(binding, value);
    expect(await deliver(binding, measured)).toBe("accepted");
    expect(await server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, value.run.id))).toHaveLength(1);
    const beforeReview = await assign(await ready(), { kind: "accepted_run", run_id: value.run.id });
    expect(beforeReview.statusCode).toBe(409);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${value.taskId}/review`, payload: { outcome: "accepted" } })).statusCode).toBe(200);
    const next = await assign(await ready(), { kind: "accepted_run", run_id: value.run.id });
    expect(next.statusCode, next.body).toBe(200);
    const [stored] = await server.db.db.select().from(runs).where(eq(runs.id, next.json().run.id));
    expect(parseOwnedResultAssignment(stored!)?.request.requirement.input).toEqual({ kind: "result", reference: evidence(value).result.reference });
    const changed = structuredClone(measured); if (changed.event.type !== "run.owned-result.verification") throw new Error("fixture");
    changed.event.payload.result.manifest_digest = sha("changed");
    expect(await deliver(binding, changed)).toBe("rejected");
  });

  it("refuses raw completion, ordinary verification and forged assignment evidence without partial state effects", async () => {
    const binding = bind(), value = await queued();
    const start = frame(value.run, 0, { type: "run.lifecycle", payload: { phase: "started" } });
    await expect(ingestWireRunEvent(server.ctx, start)).rejects.toThrow("current qualified managed");
    await expect(ingestRunEvent(server.ctx, { runId: value.run.id, nodeId: NODE, sequence: 0,
      event: { kind: "lifecycle", phase: "started" } })).rejects.toThrow("current qualified managed");
    expect(await deliver(binding, start)).toBe("accepted");
    expect(await deliver(binding, frame(value.run, 3, { type: "run.lifecycle", payload: { phase: "completed" } }))).toBe("rejected");
    const wrong = evidence(value); wrong.author.launch_binding_digest = sha("another launch");
    expect(await deliver(binding, frame(value.run, 1, { type: "run.owned-result.verification", payload: wrong }))).toBe("rejected");
    expect(await deliver(binding, frame(value.run, 1, { type: "run.verification", payload: evidence(value).verification.payload }))).toBe("rejected");
    expect(await deliver(binding, frame(value.run, 1, { type: "run.owned-result.verification", payload: evidence(value, false) }))).toBe("accepted");
    expect(await deliver(binding, frame(value.run, 2, retained(value.run)))).toBe("rejected");
    expect(await deliver(binding, frame(value.run, 2, { type: "run.lifecycle", payload: { phase: "failed", reason: "verified failure" } }))).toBe("accepted");
    expect((await server.db.db.select().from(runs).where(eq(runs.id, value.run.id)))[0]?.status).toBe("failed");
  });

  it("requires managed session readiness and exact current profile/context while preserving ordinary manual assignment", async () => {
    bind([structuredClone(descriptor)], false);
    const taskId = await ready(); expect((await assign(taskId)).statusCode).toBe(409);
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
    const binding = bind(), value = await queued();
    const altered = structuredClone(descriptor); altered.verifier_template.digest = sha("different template");
    const replacement = bind([altered]);
    await expect(binding.dispatchRunStart(value.run.id)).rejects.toThrow("no longer current");
    await expect(replacement.dispatchRunStart(value.run.id)).rejects.toThrow("original owned result profile");
    const restored = bind();
    const [context] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, value.stored.contextPackId!));
    await server.db.db.update(contextPacks).set({ payload: { ...(context!.payload as object), unexpected: true } }).where(eq(contextPacks.id, context!.id));
    await expect(restored.dispatchRunStart(value.run.id)).rejects.toThrow();
    const ordinary = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "manual", agent_instance_id: INSTANCE } });
    expect(ordinary.statusCode, ordinary.body).toBe(200);
    expect((await server.db.db.select().from(runs).where(eq(runs.id, ordinary.json().run.id)))[0]?.ownedResultAssignment).toBeNull();
  });

  it("rolls evidence back if session qualification changes during ingestion and never upgrades a cancelled author", async () => {
    const binding = bind(), value = await queued();
    expect(await deliver(binding, frame(value.run, 0, { type: "run.lifecycle", payload: { phase: "started" } }))).toBe("accepted");
    let checks = 0;
    const measured = frame(value.run, 1, { type: "run.owned-result.verification", payload: evidence(value) });
    await expect(ingestWireRunEvent(server.ctx, measured, () => ++checks === 1)).rejects.toThrow("current qualified managed");
    expect(checks).toBe(2);
    expect(await server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, value.run.id))).toHaveLength(0);
    expect(await server.db.db.select().from(runEventIngest).where(and(eq(runEventIngest.runId, value.run.id), eq(runEventIngest.sequence, 1)))).toHaveLength(0);
    // Controlled stop callback: this server test owns no operating-system child.
    await cancelRun(server.ctx, value.run.id, async () => {});
    expect(await deliver(binding, measured)).toBe("rejected");
    expect(await deliver(binding, frame(value.run, 3, { type: "run.lifecycle", payload: { phase: "completed" } }))).toBe("rejected");
    expect((await server.db.db.select().from(runs).where(eq(runs.id, value.run.id)))[0]?.status).toBe("cancelled");
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, value.taskId)))[0]?.status).toBe("cancelled");
  });

  it("withdraws review and continuation eligibility after a qualified incomplete-delivery correction", async () => {
    const binding = bind(), value = await queued(); await complete(binding, value);
    const correction = frame(value.run, 4, { type: "run.workspace.retained", payload: { version: 1,
      workspace_root: value.run.workspace_root!, workspace_branch: value.run.workspace_branch!, outcome: "incomplete_delivery" } });
    expect(await deliver(binding, correction)).toBe("accepted");
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${value.taskId}/review`, payload: { outcome: "accepted" } })).statusCode).toBe(409);
    expect((await assign(await ready(), { kind: "accepted_run", run_id: value.run.id })).statusCode).toBe(409);
    expect((await server.db.db.select().from(runs).where(eq(runs.id, value.run.id)))[0]?.status).toBe("completed");
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, value.taskId)))[0]?.status).toBe("review");
  });
});
