import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createArtoodNode, createArtifactUploader, createProcessAdapter, type ArtoodNode } from "@artoo/artood";
import { artifacts, fileLeases } from "@artoo/db";
import type { RuntimeAdapter, ServerToNodeMessage } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { cancelRun, failRunDaemonDisconnect, ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const COMPUTER = "computer_local_mock";
const fixture = fileURLToPath(new URL("../../artood/test-fixtures/mock-agent.mjs", import.meta.url));

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("runtime verification timed out");
}

async function assign(server: TestServer): Promise<{ taskId: string; runId: string }> {
  const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
    project_id: "proj_artoo", title: "Preview runtime verification", acceptance_criteria: ["verified"], required_capabilities: ["code.modify"],
  } });
  const taskId = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto", write_paths: ["src/**"] } });
  expect(assigned.statusCode).toBe(200);
  return { taskId, runId: assigned.json().run.id as string };
}

describe("trusted preview runtime boundaries", () => {
  let server: TestServer | undefined;
  let node: ArtoodNode | undefined;
  let adapter: RuntimeAdapter | undefined;
  let currentRun: string | undefined;
  const dirs: string[] = [];
  const temporary = () => { const path = mkdtempSync(join(tmpdir(), "artoo-preview-")); dirs.push(path); return path; };

  afterEach(async () => {
    if (currentRun) await adapter?.stop({ runId: currentRun }, "user_cancelled").catch(() => {});
    await node?.stop();
    await server?.close();
    node = undefined; server = undefined; adapter = undefined; currentRun = undefined;
    for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  async function connect(workspace: string, command: string[], upload = false): Promise<void> {
    const address = await server!.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `${address.replace("http:", "ws:")}/api/v1/node?token=dev`;
    adapter = createProcessAdapter({ command, allowedRoots: [workspace], artifacts: [{ type: "patch", path: "changes.patch" }] });
    node = createArtoodNode({
      url, hello: { kind: "node.hello", node_id: COMPUTER, protocol_version: "2026-06-11", artood_version: "0.1.0", machine: { hostname: "test", os: process.platform, arch: process.arch } },
      adapter, acknowledgeRunEvents: true, ...(upload ? { uploadArtifact: createArtifactUploader(url, COMPUTER) } : {}),
    });
    await node.start();
    await waitFor(() => server!.nodeRegistry.get(COMPUTER) !== undefined);
  }

  it("cancels over real WebSocket only after both parent and child writer processes stop", async () => {
    const workspace = temporary();
    const script = join(workspace, "writer.mjs");
    writeFileSync(script, `import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
if (process.argv[2] === 'child') { writeFileSync('child.pid',String(process.pid)); setInterval(()=>appendFileSync('child.log','x'),20); }
else { writeFileSync('parent.pid',String(process.pid)); spawn(process.execPath,[process.argv[1],'child'],{stdio:'inherit'}); setInterval(()=>appendFileSync('parent.log','x'),20); }
`);
    server = await buildTestServer({ workspaceRoot: workspace, enableDevRoutes: false });
    await connect(workspace, [process.execPath, script]);
    const { taskId, runId } = await assign(server); currentRun = runId;
    await waitFor(() => existsSync(join(workspace, "child.log")) && existsSync(join(workspace, "parent.log")));
    await waitFor(async () => (await server!.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` })).json().run.status === "running");
    const held = await server.db.db.select().from(fileLeases).where(eq(fileLeases.runId, runId));
    expect(held[0]?.status).toBe("held");
    const cancelled = await server.app.inject({ method: "POST", url: `/api/v1/runs/${runId}/cancel` });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().run.status).toBe("cancelled");
    const childBytes = readFileSync(join(workspace, "child.log")).length;
    const parentBytes = readFileSync(join(workspace, "parent.log")).length;
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(readFileSync(join(workspace, "child.log")).length).toBe(childBytes);
    expect(readFileSync(join(workspace, "parent.log")).length).toBe(parentBytes);
    for (const filename of ["parent.pid", "child.pid"]) {
      const pid = Number(readFileSync(join(workspace, filename), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    }
    const again = await server.app.inject({ method: "POST", url: `/api/v1/runs/${runId}/cancel` });
    expect(again.statusCode).toBe(200);
    expect((await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })).json().task.status).toBe("cancelled");
    expect((await server.db.db.select().from(fileLeases).where(eq(fileLeases.runId, runId)))[0]?.status).toBe("released");
  });

  it("preserves active status and write leases when the execution computer is offline", async () => {
    server = await buildTestServer({ enableDevRoutes: false });
    const { runId } = await assign(server);
    const result = await server.app.inject({ method: "POST", url: `/api/v1/runs/${runId}/cancel` });
    expect(result.statusCode).toBe(409);
    expect((await server.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` })).json().run.status).toBe("queued");
    expect((await server.db.db.select().from(fileLeases).where(eq(fileLeases.runId, runId)))[0]?.status).toBe("held");
  });

  it("retains leases after disconnect timeout until an owning node confirms terminal process state", async () => {
    server = await buildTestServer();
    const { runId } = await assign(server);
    await ingestRunEvent(server.ctx, { runId, nodeId: COMPUTER, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await failRunDaemonDisconnect(server.ctx, runId, COMPUTER);
    expect((await server.db.db.select().from(fileLeases).where(eq(fileLeases.runId, runId)))[0]?.status).toBe("held");
    await ingestRunEvent(server.ctx, { runId, nodeId: COMPUTER, sequence: 1, event: { kind: "lifecycle", phase: "completed" } });
    expect((await server.db.db.select().from(fileLeases).where(eq(fileLeases.runId, runId)))[0]?.status).toBe("released");
  });

  it("acknowledges delayed lifecycle frames after confirmed cancellation without changing settled state", async () => {
    server = await buildTestServer();
    const { runId, taskId } = await assign(server);
    await cancelRun(server.ctx, runId, async () => {});
    for (const [sequence, phase] of ["started", "completed", "cancelled"].entries()) {
      const received = await ingestRunEvent(server.ctx, { runId, nodeId: COMPUTER, sequence, event: { kind: "lifecycle", phase: phase as "started" | "completed" | "cancelled" } });
      expect(received.runStatus).toBe("cancelled");
      expect(received.taskStatus).toBe("cancelled");
    }
    expect((await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })).json().task.status).toBe("cancelled");
  });

  it("rejects unauthenticated, foreign-node, corrupt and oversized artifact uploads", async () => {
    server = await buildTestServer({ artifactDir: temporary() });
    const { runId } = await assign(server);
    const url = `/api/v1/node/runs/${runId}/artifacts?type=patch&path=changes.patch`;
    const payload = Buffer.from("patch bytes");
    const headers = { authorization: "Bearer dev", "content-type": "application/octet-stream", "x-artoo-node-id": COMPUTER,
      "x-artoo-checksum": `sha256:${createHash("sha256").update(payload).digest("hex")}` };
    expect((await server.app.inject({ method: "PUT", url, headers: { ...headers, authorization: "Bearer bad" }, payload })).statusCode).toBe(403);
    expect((await server.app.inject({ method: "PUT", url, headers: { ...headers, "x-artoo-node-id": "computer_other" }, payload })).statusCode).toBe(403);
    expect((await server.app.inject({ method: "PUT", url, headers: { ...headers, "x-artoo-checksum": "sha256:bad" }, payload })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "PUT", url, headers, payload: Buffer.alloc(10 * 1024 * 1024 + 1) })).statusCode).toBe(413);
    expect(await server.db.db.select().from(artifacts).where(eq(artifacts.runId, runId))).toHaveLength(0);
  });

  it("uploads real subprocess artifacts before completion and serves them after workspace removal", async () => {
    const workspace = temporary(); const artifactDir = temporary();
    server = await buildTestServer({ workspaceRoot: workspace, artifactDir, enableDevRoutes: false });
    await connect(workspace, [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--context", "{{context_pack_path}}"], true);
    const { taskId, runId } = await assign(server); currentRun = runId;
    await waitFor(async () => (await server!.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })).json().task.status === "review");
    const records = await server.db.db.select().from(artifacts).where(eq(artifacts.runId, runId));
    expect(records).toHaveLength(1);
    const expectedBytes = readFileSync(join(workspace, "changes.patch"));
    rmSync(workspace, { recursive: true, force: true });
    const downloaded = await server.app.inject({ method: "GET", url: records[0]!.uri });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(expectedBytes);
    expect(records[0]!.checksum).toBe(`sha256:${createHash("sha256").update(downloaded.rawPayload).digest("hex")}`);
    expect(downloaded.headers["content-disposition"]).toContain("attachment");
  });

  it("rejects every cross-node event and forged command rejection", async () => {
    server = await buildTestServer();
    const { runId } = await assign(server);
    const attacker = createInProcessChannel();
    const badBinding = attachNodeBinding(server.ctx, attacker.serverTransport, "computer_attacker");
    for (const nodeId of ["computer_attacker", COMPUTER]) {
      await attacker.node.send({ kind: "run.event", node_id: nodeId, run_id: runId, sequence: 0, event: { type: "run.lifecycle", payload: { phase: "started" } } });
      await attacker.node.send({ kind: "run.event", node_id: nodeId, run_id: runId, sequence: 1, event: { type: "run.output", payload: { stream: "stdout", text: "forged" } } });
      await attacker.node.send({ kind: "run.event", node_id: nodeId, run_id: runId, sequence: 2, event: { type: "artifact.created", payload: { type: "patch", uri: "file:///forged", metadata: {} } } });
    }
    await badBinding.drain();
    expect((await server.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` })).json().run.status).toBe("queued");
    expect(await server.db.db.select().from(artifacts).where(eq(artifacts.runId, runId))).toHaveLength(0);
    await expect(badBinding.dispatchRunStart(runId)).rejects.toThrow("not owned");
    badBinding.close();
    const legit = createInProcessChannel();
    const goodBinding = attachNodeBinding(server.ctx, legit.serverTransport, COMPUTER);
    let dispatched: ServerToNodeMessage | undefined;
    legit.node.subscribe((message) => { dispatched = message; });
    await goodBinding.dispatchRunStart(runId);
    await legit.node.send({ kind: "command.ack", node_id: "computer_attacker", command_id: dispatched!.id, status: "rejected", error_code: "process_start_failed", message: "forged" });
    await goodBinding.drain();
    expect((await server.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` })).json().run.status).toBe("queued");
    goodBinding.close();
  });

  it("does not expose development mutation routes unless explicitly enabled", async () => {
    server = await buildTestServer({ enableDevRoutes: false });
    for (const url of ["/api/v1/dev/runs/run_x/mock-execute", "/api/v1/dev/tasks/task_x/request-approval"]) {
      expect((await server.app.inject({ method: "POST", url })).statusCode).toBe(404);
    }
  });

  async function goalTasks(): Promise<{ goalId: string; taskIds: string[] }> {
    const goalId = (await server!.app.inject({ method: "POST", url: "/api/v1/goals", payload: { project_id: "proj_artoo", title: "Controllable goal" } })).json().goal.id as string;
    const planId = (await server!.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/plans`, payload: {
      task_specs: ["active", "waiting", "backlog"].map((title) => ({ title, acceptance_criteria: ["done"], required_capabilities: ["code.modify"], dependencies: [] })),
    } })).json().plan.id as string;
    const accepted = await server!.app.inject({ method: "POST", url: `/api/v1/plans/${planId}/accept` });
    expect(accepted.statusCode).toBe(200);
    return { goalId, taskIds: accepted.json().task_ids as string[] };
  }

  it("goal pause drains active work, fences assignment, and goal cancel stops the process and every pending child", async () => {
    const workspace = temporary();
    server = await buildTestServer({ workspaceRoot: workspace });
    await connect(workspace, [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--sleep-ms", "10000"]);
    const { goalId, taskIds } = await goalTasks();
    for (const taskId of taskIds.slice(0, 2)) await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskIds[0]}/assign`, payload: { mode: "auto", write_paths: ["src/**"] } });
    currentRun = assigned.json().run.id as string;
    await waitFor(async () => (await server!.app.inject({ method: "GET", url: `/api/v1/runs/${currentRun}` })).json().run.status === "running");
    expect((await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/pause` })).statusCode).toBe(200);
    const fenced = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskIds[1]}/assign`, payload: { mode: "auto" } });
    expect(fenced.statusCode).toBe(409);
    expect(fenced.json().error.details.status).toBe("paused");
    expect((await server.app.inject({ method: "GET", url: `/api/v1/runs/${currentRun}` })).json().run.status).toBe("running");
    const cancelled = await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/cancel` });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().goal.status).toBe("cancelled");
    for (const taskId of taskIds) expect((await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })).json().task.status).toBe("cancelled");
    expect((await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/cancel` })).statusCode).toBe(200);
  });

  it("leaves an offline goal paused and safely cancels a queued run after reconnect without later spawning it", async () => {
    const workspace = temporary();
    server = await buildTestServer({ workspaceRoot: workspace });
    const { goalId, taskIds } = await goalTasks();
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskIds[0]}/ready` });
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskIds[0]}/assign`, payload: { mode: "auto", write_paths: ["src/**"] } });
    currentRun = assigned.json().run.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/cancel` })).statusCode).toBe(409);
    expect((await server.app.inject({ method: "GET", url: `/api/v1/goals/${goalId}` })).json().goal.status).toBe("paused");
    expect((await server.db.db.select().from(fileLeases).where(eq(fileLeases.runId, currentRun)))[0]?.status).toBe("held");
    await connect(workspace, [process.execPath, fixture, "--workspace", "{{workspace_root}}"]);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/cancel` })).statusCode).toBe(200);
    await server.nodeRegistry.get(COMPUTER)!.dispatchRunStart(currentRun);
    expect(existsSync(join(workspace, "context_pack.md"))).toBe(false);
  });
});
