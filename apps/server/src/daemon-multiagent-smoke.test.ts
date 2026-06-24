import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeClient, createProcessAdapter } from "@artoo/artood";
import { agentInstances, agentRuntimes, agents, computers, eventLog } from "@artoo/db";
import { createInProcessChannel } from "@artoo/testkit";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #111 (v2-L / V3 gate-0): daemon + multi-agent production smoke. Gated, opt-in:
 *   ARTOO_DAEMON_SMOKE=1 npx vitest run apps/server/src/daemon-multiagent-smoke.test.ts
 *
 * Drives ONE in-process server with 2-3 in-process daemon node-clients (real
 * `mock-agent.mjs` runtime fixture) against one parent DAG to validate the live
 * multi-agent path end to end: capability routing, heartbeat visibility,
 * concurrent runs + artifacts, write-lease (disjoint + conflict), DAG unlock +
 * failure-block, approval block/resume, audit replay/export, node
 * restart/reconnect, and security refusals (revoked token, node_id mismatch,
 * dev-escape disabled). This is a smoke/validation gate, NOT a daemon rewrite.
 *
 * Every phase logs an `EVID` marker so the run stdout is the evidence artifact.
 */
const ENABLED = process.env.ARTOO_DAEMON_SMOKE === "1";
const ISO = "2026-06-13T00:00:00.000Z";
const FIXTURE = fileURLToPath(new URL("../../artood/test-fixtures/mock-agent.mjs", import.meta.url));

const NODE_HELLO = (nodeId: string): string =>
  JSON.stringify({
    kind: "node.hello",
    node_id: nodeId,
    protocol_version: "2026-06-11",
    artood_version: "0.1.0",
    machine: { hostname: "localhost", os: "windows", arch: "x64" },
  });

function evid(phase: string, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`EVID ${phase} | ${msg}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

interface NodeSpec {
  computerId: string;
  agentId: string;
  runtimeId: string;
  instanceId: string;
  caps: string[];
}

/** Seed an online+idle computer/agent/runtime/instance with disjoint caps so the
 *  scheduler routes a child task to exactly one node by required_capabilities. */
async function seedNode(srv: TestServer, spec: NodeSpec, workspaceRoot: string): Promise<void> {
  const org = "org_default";
  await srv.db.db.insert(computers).values({
    id: spec.computerId, organizationId: org, displayName: spec.computerId, hostname: spec.computerId,
    os: "windows", arch: "x64", status: "online", lastHeartbeatAt: ISO,
    resources: {}, capabilities: spec.caps, createdAt: ISO,
  });
  await srv.db.db.insert(agents).values({
    id: spec.agentId, organizationId: org, displayName: spec.agentId, kind: "mock",
    status: "idle", capabilities: spec.caps, createdAt: ISO,
  });
  await srv.db.db.insert(agentRuntimes).values({
    id: spec.runtimeId, organizationId: org, computerId: spec.computerId, runtime: "mock",
    version: "0.1.0", status: "available", lastSeenAt: ISO, metadata: {},
  });
  await srv.db.db.insert(agentInstances).values({
    id: spec.instanceId, organizationId: org, computerId: spec.computerId, agentId: spec.agentId,
    runtime: "mock", modelProfileId: "model_standard_coding", effortProfileId: "effort_standard_coding",
    status: "idle", workspaceRoot, config: {}, createdAt: ISO,
  });
}

interface WiredNode {
  computerId: string;
  binding: ReturnType<typeof attachNodeBinding>;
  node: ReturnType<typeof createNodeClient>;
  channel: ReturnType<typeof createInProcessChannel>;
}

function wireNode(srv: TestServer, computerId: string, wsParent: string): WiredNode {
  const channel = createInProcessChannel();
  const binding = attachNodeBinding(srv.ctx, channel.serverTransport);
  srv.nodeRegistry.register(computerId, binding);
  const adapter = createProcessAdapter({
    command: [process.execPath, FIXTURE, "--workspace", "{{workspace_root}}", "--context", "{{context_pack_path}}"],
    allowedRoots: [wsParent],
    artifacts: [{ type: "patch", path: "changes.patch" }],
  });
  const node = createNodeClient({ nodeId: computerId, transport: channel.node, adapter });
  node.start();
  return { computerId, binding, node, channel };
}

describe.skipIf(!ENABLED)("#111 daemon + multi-agent production smoke", () => {
  let srv: TestServer | undefined;
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await srv?.close();
    srv = undefined;
  });

  const post = (url: string, payload?: unknown) =>
    srv!.app.inject({ method: "POST", url, payload: payload ?? {} });
  const get = (url: string) => srv!.app.inject({ method: "GET", url });

  async function taskStatus(taskId: string): Promise<string> {
    return (await get(`/api/v1/tasks/${taskId}`)).json().task.status as string;
  }

  /** Create a ready child under the parent with a single required capability. */
  async function createChild(parentId: string, title: string, caps: string[]): Promise<string> {
    const r = await post("/api/v1/tasks", {
      project_id: "proj_artoo", title, acceptance_criteria: ["works"],
      required_capabilities: caps, parent_task_id: parentId,
    });
    expect(r.statusCode).toBe(201);
    return r.json().task.id as string;
  }

  /** ready -> assign(auto). Returns { runId, computerId, reason }. */
  async function assignAuto(taskId: string): Promise<{ runId: string; computerId: string; reason: string }> {
    expect((await post(`/api/v1/tasks/${taskId}/ready`)).statusCode).toBeLessThan(300);
    const a = await post(`/api/v1/tasks/${taskId}/assign`, { mode: "auto" });
    expect(a.statusCode).toBeLessThan(300);
    const body = a.json();
    return { runId: body.run.id, computerId: body.run.computer_id, reason: body.scheduler_decision.reason };
  }

  /** A common multi-node fixture: seed parent + 4 disjoint-capability nodes,
   *  wire 3 of them (D stays unwired so its runs sit queued for the approval
   *  phase). The seeded computer_local_mock is taken offline so routing is
   *  unambiguous. */
  async function setupTeam(): Promise<{
    parentId: string;
    wsParent: string;
    nodes: Record<"A" | "B" | "C", WiredNode>;
  }> {
    const wsParent = mkdtempSync(join(tmpdir(), "artoo-mas-ws-"));
    cleanups.push(() => rmSync(wsParent, { recursive: true, force: true }));

    // Take the single seeded node offline so child routing is unambiguous.
    await srv!.db.db.update(computers).set({ status: "offline" }).where(eq(computers.id, "computer_local_mock"));

    const specs: Array<NodeSpec & { ws: string }> = [
      { computerId: "computer_a", agentId: "agent_a", runtimeId: "rt_a", instanceId: "inst_a", caps: ["code.modify"], ws: join(wsParent, "a") },
      { computerId: "computer_b", agentId: "agent_b", runtimeId: "rt_b", instanceId: "inst_b", caps: ["test.run"], ws: join(wsParent, "b") },
      { computerId: "computer_c", agentId: "agent_c", runtimeId: "rt_c", instanceId: "inst_c", caps: ["code.review"], ws: join(wsParent, "c") },
      { computerId: "computer_d", agentId: "agent_d", runtimeId: "rt_d", instanceId: "inst_d", caps: ["doc.write"], ws: join(wsParent, "d") },
    ];
    for (const s of specs) {
      mkdirSync(s.ws, { recursive: true });
      await seedNode(srv!, s, s.ws);
    }

    const A = wireNode(srv!, "computer_a", wsParent);
    const B = wireNode(srv!, "computer_b", wsParent);
    const C = wireNode(srv!, "computer_c", wsParent);
    for (const w of [A, B, C]) {
      cleanups.push(async () => {
        await w.node.stop();
        w.binding.close();
        srv!.nodeRegistry.unregister(w.computerId, w.binding);
        await w.channel.close();
      });
    }

    const parent = await post("/api/v1/tasks", {
      project_id: "proj_artoo", title: "V3 goal: ship multi-agent smoke", acceptance_criteria: ["all children done"],
    });
    return { parentId: parent.json().task.id as string, wsParent, nodes: { A, B, C } };
  }

  it("Phase A: capability routing + concurrent live runs + heartbeat + artifacts", async () => {
    srv = await buildTestServer({ workspaceRoot: mkdtempSync(join(tmpdir(), "artoo-mas-seed-")) });
    const { parentId } = await setupTeam();

    const childA = await createChild(parentId, "edit code", ["code.modify"]);
    const childB = await createChild(parentId, "run tests", ["test.run"]);

    const rA = await assignAuto(childA);
    const rB = await assignAuto(childB);
    expect(rA.computerId).toBe("computer_a");
    expect(rB.computerId).toBe("computer_b");
    expect(rA.reason).toBe("capability_match_and_idle");
    evid("A.routing", `childA->${rA.computerId} childB->${rB.computerId} reason=${rA.reason}`);

    // Concurrent live runs complete on their respective nodes -> task to review.
    await waitFor(async () => (await taskStatus(childA)) === "review", "childA review");
    await waitFor(async () => (await taskStatus(childB)) === "review", "childB review");
    evid("A.concurrent", "both child runs completed concurrently on distinct nodes");

    // Heartbeat visibility per node.
    const rtA = (await get("/api/v1/computers/computer_a/runtimes")).json().runtimes;
    expect(rtA.some((r: { runtime: string; status: string }) => r.runtime === "mock" && r.status === "available")).toBe(true);
    evid("A.heartbeat", `computer_a runtimes: ${rtA.map((r: { runtime: string }) => r.runtime).join(",")}`);

    // Artifact aggregation: the real fixture wrote changes.patch -> artifact.created.
    const bundleA = (await get(`/api/v1/tasks/${childA}/audit-bundle`)).json().bundle;
    expect(bundleA.artifacts.length).toBeGreaterThan(0);
    evid("A.artifacts", `childA artifacts=${bundleA.artifacts.length} type=${bundleA.artifacts[0]?.type}`);
  });

  it("Phase B: write leases — disjoint acquire ok, overlapping write rejected", async () => {
    srv = await buildTestServer({ workspaceRoot: mkdtempSync(join(tmpdir(), "artoo-mas-seed-")) });
    const { parentId } = await setupTeam();
    const t1 = await createChild(parentId, "lease holder 1", ["code.modify"]);
    const t2 = await createChild(parentId, "lease holder 2", ["test.run"]);

    const okA = await post("/api/v1/leases", { task_id: t1, path: "src/alpha", mode: "write" });
    const okB = await post("/api/v1/leases", { task_id: t2, path: "src/beta", mode: "write" });
    expect(okA.statusCode).toBe(201);
    expect(okB.statusCode).toBe(201);
    evid("B.disjoint", "two disjoint write leases acquired (201/201)");

    const conflict = await post("/api/v1/leases", { task_id: t2, path: "src/alpha/inner.ts", mode: "write" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("conflict");
    evid("B.conflict", `overlapping write lease rejected: ${conflict.statusCode} ${conflict.json().error.code}`);
  });

  it("Phase C: DAG dependency unlock on accept; failure block propagation", async () => {
    srv = await buildTestServer({ workspaceRoot: mkdtempSync(join(tmpdir(), "artoo-mas-seed-")) });
    const { parentId } = await setupTeam();

    // childC (review) depends on childA (edit). Unlock when childA accepted.
    const childA = await createChild(parentId, "edit code", ["code.modify"]);
    const childC = await createChild(parentId, "review code", ["code.review"]);
    expect((await post(`/api/v1/tasks/${childC}/dependencies`, { depends_on_task_id: childA, type: "blocks" })).statusCode).toBe(201);

    // Drive childA to done via a live node run + review accept.
    const rA = await assignAuto(childA);
    expect(rA.computerId).toBe("computer_a");
    await waitFor(async () => (await taskStatus(childA)) === "review", "childA review");
    expect((await post(`/api/v1/tasks/${childA}/review`, { outcome: "accepted" })).statusCode).toBeLessThan(300);
    await waitFor(async () => (await taskStatus(childC)) === "ready", "childC unlocked");
    evid("C.unlock", "childC auto-unlocked to ready after childA accepted");

    // Failure-block: childE depends on childD; fail childD's run -> blocked + advisory event; childE stays backlog.
    const childD = await createChild(parentId, "edit code 2", ["code.modify"]);
    const childE = await createChild(parentId, "review code 2", ["code.review"]);
    expect((await post(`/api/v1/tasks/${childE}/dependencies`, { depends_on_task_id: childD, type: "blocks" })).statusCode).toBe(201);
    const rD = await assignAuto(childD);
    const failed = await post(`/api/v1/dev/runs/${rD.runId}/mock-execute?outcome=failed`);
    expect(failed.statusCode).toBeLessThan(300);
    await waitFor(async () => (await taskStatus(childD)) === "blocked", "childD blocked");
    expect(await taskStatus(childE)).toBe("backlog");
    const blockedEvents = await srv.db.db.select().from(eventLog).where(eq(eventLog.type, "dag.node.blocked"));
    expect(blockedEvents.length).toBeGreaterThan(0);
    evid("C.block", `childD failed->blocked; childE stayed backlog; dag.node.blocked events=${blockedEvents.length}`);
  });

  it("Phase D: approval block -> resume (approved); reject -> blocked", async () => {
    srv = await buildTestServer({ workspaceRoot: mkdtempSync(join(tmpdir(), "artoo-mas-seed-")) });
    const { parentId } = await setupTeam();

    // childD routes to the UNWIRED computer_d, so the run stays queued; we flip it
    // to running deterministically via a started lifecycle event, then gate it.
    const task = await createChild(parentId, "deploy (needs approval)", ["doc.write"]);
    const r = await assignAuto(task);
    expect(r.computerId).toBe("computer_d");
    await ingestRunEvent(srv.ctx, { runId: r.runId, nodeId: "computer_d", sequence: 1, event: { kind: "lifecycle", phase: "started" } });
    await waitFor(async () => (await taskStatus(task)) === "running", "task running");

    const req = await post(`/api/v1/dev/tasks/${task}/request-approval`, { action: "deploy.release", risk: "high", summary: "Release to prod", run_id: r.runId });
    expect(req.statusCode).toBe(201);
    const approvalId = req.json().approval.id as string;
    expect(await taskStatus(task)).toBe("awaiting_approval");
    evid("D.block", `task blocked on approval ${approvalId}`);

    const resolved = await post(`/api/v1/approvals/${approvalId}/resolve`, { decision: "approved", comment: "ok" });
    expect(resolved.json().approval.status).toBe("approved");
    await waitFor(async () => (await taskStatus(task)) === "running", "task resumed running");
    evid("D.resume", "approval granted -> task resumed to running");

    // Reject path on a second gated task -> blocked.
    const task2 = await createChild(parentId, "risky op (reject)", ["doc.write"]);
    const r2 = await assignAuto(task2);
    await ingestRunEvent(srv.ctx, { runId: r2.runId, nodeId: "computer_d", sequence: 1, event: { kind: "lifecycle", phase: "started" } });
    await waitFor(async () => (await taskStatus(task2)) === "running", "task2 running");
    const req2 = await post(`/api/v1/dev/tasks/${task2}/request-approval`, { action: "rm.rf", risk: "high", summary: "Dangerous", run_id: r2.runId });
    const rej = await post(`/api/v1/approvals/${req2.json().approval.id}/resolve`, { decision: "rejected", comment: "no" });
    expect(rej.json().approval.status).toBe("rejected");
    await waitFor(async () => (await taskStatus(task2)) === "blocked", "task2 blocked after reject");
    evid("D.reject", "approval rejected -> task blocked");
  });

  it("Phase E: audit bundle replay (monotonic position) + deterministic export", async () => {
    srv = await buildTestServer({ workspaceRoot: mkdtempSync(join(tmpdir(), "artoo-mas-seed-")) });
    const { parentId } = await setupTeam();
    const child = await createChild(parentId, "audited work", ["code.modify"]);
    const r = await assignAuto(child);
    expect(r.computerId).toBe("computer_a");
    await waitFor(async () => (await taskStatus(child)) === "review", "child review");

    const bundle = (await get(`/api/v1/tasks/${child}/audit-bundle`)).json().bundle;
    const positions = bundle.events.map((e: { position: number }) => e.position);
    expect(positions).toEqual([...positions].sort((a: number, b: number) => a - b));
    expect(bundle.runs.length).toBeGreaterThan(0);
    evid("E.replay", `audit bundle events=${positions.length} monotonic; runs=${bundle.runs.length} artifacts=${bundle.artifacts.length}`);

    const exp1 = (await get(`/api/v1/tasks/${child}/audit-bundle/export`)).json().export;
    const exp2 = (await get(`/api/v1/tasks/${child}/audit-bundle/export`)).json().export;
    expect(exp1.schema_version).toBe("v1alpha1");
    expect(exp1.bundle_sha256).toMatch(/^sha256:[0-9a-f]+$/);
    expect(exp1.bundle_sha256).toBe(exp2.bundle_sha256);
    evid("E.export", `deterministic export sha=${exp1.bundle_sha256.slice(0, 23)}... signing=${exp1.signing.status}`);
  });

  it("Phase F: node restart/reconnect lands a subsequent run", async () => {
    srv = await buildTestServer({ workspaceRoot: mkdtempSync(join(tmpdir(), "artoo-mas-seed-")) });
    const { parentId, wsParent, nodes } = await setupTeam();

    // First run on node A.
    const child1 = await createChild(parentId, "pre-restart", ["code.modify"]);
    const r1 = await assignAuto(child1);
    expect(r1.computerId).toBe("computer_a");
    await waitFor(async () => (await taskStatus(child1)) === "review", "child1 review");

    // Restart node A: stop + unregister, then reconnect under same computerId.
    await nodes.A.node.stop();
    nodes.A.binding.close();
    srv.nodeRegistry.unregister("computer_a", nodes.A.binding);
    await nodes.A.channel.close();
    expect(srv.nodeRegistry.get("computer_a")).toBeUndefined();
    evid("F.stop", "node A stopped + unregistered");

    const A2 = wireNode(srv, "computer_a", wsParent);
    cleanups.push(async () => {
      await A2.node.stop();
      A2.binding.close();
      srv!.nodeRegistry.unregister("computer_a", A2.binding);
      await A2.channel.close();
    });
    expect(srv.nodeRegistry.get("computer_a")).toBeDefined();

    // A subsequent run lands on the reconnected node.
    const child2 = await createChild(parentId, "post-restart", ["code.modify"]);
    const r2 = await assignAuto(child2);
    expect(r2.computerId).toBe("computer_a");
    await waitFor(async () => (await taskStatus(child2)) === "review", "child2 review after reconnect");
    evid("F.reconnect", "reconnected node A executed a fresh run to review");
  });
});

describe.skipIf(!ENABLED)("#111 daemon security refusals (real WS)", () => {
  let srv: TestServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets) try { s.close(); } catch { /* ignore */ }
    sockets.length = 0;
    await srv?.close();
    srv = undefined;
  });

  async function listen(server: TestServer): Promise<string> {
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    return new URL(address).port;
  }

  interface Issued { deviceId: string; computerId: string; nodeToken: string; controlToken: string }
  async function issueEnrolledDevice(server: TestServer): Promise<Issued> {
    const code = (await server.app.inject({ method: "POST", url: "/api/v1/devices/pairings", payload: {} })).json().code as string;
    const claimed = (await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: { code, platform: "windows", app_version: "2.0.0", display_name: "Node" } })).json();
    const deviceId = claimed.device.id as string;
    const enrolled = (await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/enroll`, payload: {} })).json();
    return { deviceId, computerId: enrolled.computer_id as string, nodeToken: claimed.node_token as string, controlToken: claimed.control_token as string };
  }

  it("Phase G1: revoked device token -> node WS refused (1008) + registry drop", async () => {
    srv = await buildTestServer();
    const port = await listen(srv);
    const dev = await issueEnrolledDevice(srv);

    const node = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=${dev.nodeToken}`);
    sockets.push(node);
    await new Promise((r) => node.on("open", r));
    node.send(NODE_HELLO(dev.computerId));
    await waitFor(() => srv!.nodeRegistry.get(dev.computerId) !== undefined, "node registered");
    evid("G1.connected", `enrolled node registered for ${dev.computerId}`);

    await srv.app.inject({ method: "POST", url: `/api/v1/devices/${dev.deviceId}/revoke`, payload: {} });
    await waitFor(() => srv!.nodeRegistry.get(dev.computerId) === undefined, "node dropped after revoke");

    const refused = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=${dev.nodeToken}`);
    sockets.push(refused);
    const code = await new Promise<number>((r) => refused.on("close", (c) => r(c)));
    expect(code).toBe(1008);
    evid("G1.refused", `revoked node token reconnect closed ${code}`);
  });

  it("Phase G2: node_id / credential mismatch -> refused (1008)", async () => {
    srv = await buildTestServer();
    const port = await listen(srv);
    const dev = await issueEnrolledDevice(srv);

    const node = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=${dev.nodeToken}`);
    sockets.push(node);
    await new Promise((r) => node.on("open", r));
    node.send(NODE_HELLO("computer_WRONG"));
    const code = await new Promise<number>((r) => node.on("close", (c) => r(c)));
    expect(code).toBe(1008);
    expect(srv.nodeRegistry.get("computer_WRONG")).toBeUndefined();
    evid("G2.mismatch", `node_id mismatch hello closed ${code}`);
  });

  it("Phase G3: dev-escape disabled -> token=dev refused (1008)", async () => {
    srv = await buildTestServer({ deviceAuth: { devNodeToken: null, devControlEscape: false, pairingPepper: "test-pepper" } });
    const port = await listen(srv);
    const node = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=dev`);
    sockets.push(node);
    const code = await new Promise<number>((r) => node.on("close", (c) => r(c)));
    expect(code).toBe(1008);
    evid("G3.devescape", `token=dev refused with dev-escape disabled, closed ${code}`);
  });
});
