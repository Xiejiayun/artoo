import { createNodeClient } from "@artoo/artood";
import type { RuntimeAdapter } from "@artoo/protocol";
import { createInProcessChannel, createMockAdapter } from "@artoo/testkit";
import { eventLog, runs } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const NODE_ID = "computer_local_mock";

/** An adapter whose run stays alive (streamEvents blocks after `started`) until
 *  `finish()` is called — so the daemon keeps the run handle in its live map. */
function blockingAdapter(): { adapter: RuntimeAdapter; finish: () => void } {
  const base = createMockAdapter();
  let release = (): void => {};
  const gate = new Promise<void>((r) => (release = r));
  const adapter: RuntimeAdapter = {
    ...base,
    async *streamEvents() {
      yield { type: "run.lifecycle", payload: { phase: "started" } };
      await gate;
      yield { type: "run.lifecycle", payload: { phase: "completed" } };
    },
  };
  return { adapter, finish: () => release() };
}

interface Wired {
  server: TestServer;
  binding: NodeBinding;
  node: ReturnType<typeof createNodeClient>;
}

async function createReadyTask(server: TestServer): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: "proj_artoo", title: "resume task", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"] },
  });
  const taskId = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  return taskId;
}

async function waitFor(cond: () => Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

describe("run.resume daemon handler (#115 P2-S3b)", () => {
  let wired: Wired | undefined;
  let finishAdapter: (() => void) | undefined;

  afterEach(async () => {
    finishAdapter?.();
    if (wired) {
      await wired.node.stop().catch(() => {});
      wired.binding.close();
      await wired.server.close();
    }
    wired = undefined;
    finishAdapter = undefined;
  });

  async function runStatus(server: TestServer, runId: string): Promise<string> {
    return (await server.db.db.select({ s: runs.status }).from(runs).where(eq(runs.id, runId)))[0]!.s;
  }
  async function taskStatus(server: TestServer, taskId: string): Promise<string> {
    return (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })).json().task.status as string;
  }

  it("accepted resume (run still live on the node) does not transition server state", async () => {
    const server = await buildTestServer();
    const channel = createInProcessChannel();
    const binding = attachNodeBinding(server.ctx, channel.serverTransport, NODE_ID);
    server.ctx.onRunQueued = (runId) => binding.dispatchRunStart(runId);
    const { adapter, finish } = blockingAdapter();
    finishAdapter = finish;
    const node = createNodeClient({ nodeId: NODE_ID, transport: channel.node, adapter });
    node.start();
    wired = { server, binding, node };

    const taskId = await createReadyTask(server);
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    const runId = assigned.json().run.id as string;
    await waitFor(async () => (await runStatus(server, runId)) === "running");

    await binding.dispatchRunResume(runId);
    await new Promise((r) => setTimeout(r, 50)); // let the accepted ack round-trip
    await binding.drain();

    expect(await runStatus(server, runId)).toBe("running"); // accepted → unchanged
    expect(await taskStatus(server, taskId)).toBe("running");
  });

  it("rejected resume (process_exited) fails the run via daemon_disconnect and blocks the task", async () => {
    const server = await buildTestServer();
    const channel = createInProcessChannel();
    const binding = attachNodeBinding(server.ctx, channel.serverTransport, NODE_ID);
    // Do NOT route run.start to the daemon: the run runs on the server only, so the
    // daemon has no handle for it (simulates a process lost across a disconnect).
    server.ctx.onRunQueued = () => Promise.resolve();
    const node = createNodeClient({ nodeId: NODE_ID, transport: channel.node, adapter: createMockAdapter() });
    node.start();
    wired = { server, binding, node };

    const taskId = await createReadyTask(server);
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    const runId = assigned.json().run.id as string;
    await ingestRunEvent(server.ctx, { runId, nodeId: NODE_ID, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    expect(await runStatus(server, runId)).toBe("running");

    await binding.dispatchRunResume(runId);
    await new Promise((r) => setTimeout(r, 50)); // rejected ack round-trip
    await binding.drain();

    expect(await runStatus(server, runId)).toBe("failed");
    const run = (await server.db.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
    expect(run.failureReason).toBe("daemon_disconnect");
    expect(await taskStatus(server, taskId)).toBe("blocked");

    const failed = await server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "run.failed"), eq(eventLog.runId, runId)));
    expect(failed).toHaveLength(1); // idempotent: exactly one run.failed

    await binding.dispatchRunResume(runId);
    await new Promise((r) => setTimeout(r, 50)); // duplicate rejected ack round-trip
    await binding.drain();

    const afterDuplicate = await server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "run.failed"), eq(eventLog.runId, runId)));
    expect(afterDuplicate).toHaveLength(1);
  });
});
