import { createNodeClient } from "@artoo/artood";
import { createInProcessChannel, createMockAdapter } from "@artoo/testkit";
import type { RuntimeAdapter } from "@artoo/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const NODE_ID = "computer_local_mock";

interface Wired {
  server: TestServer;
  binding: NodeBinding;
  node: ReturnType<typeof createNodeClient>;
}

async function wire(adapter: RuntimeAdapter): Promise<Wired> {
  const server = await buildTestServer();
  const channel = createInProcessChannel();
  const binding = attachNodeBinding(server.ctx, channel.serverTransport);
  // ctx is shared by reference with the built app, so wiring the hook now takes effect.
  server.ctx.onRunQueued = (runId) => binding.dispatchRunStart(runId);
  const node = createNodeClient({ nodeId: NODE_ID, transport: channel.node, adapter });
  node.start();
  return { server, binding, node };
}

async function createReadyTask(server: TestServer): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "Node binding task",
      acceptance_criteria: ["works"],
      required_capabilities: ["code.modify"],
    },
  });
  const taskId = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  return taskId;
}

async function taskStatus(server: TestServer, taskId: string): Promise<string> {
  const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
  return snap.json().task.status as string;
}

describe("server <-> node protocol binding", () => {
  let wired: Wired | undefined;

  afterEach(async () => {
    if (wired) {
      wired.binding.close();
      await wired.server.close();
    }
    wired = undefined;
  });

  it("assign dispatches run.start; node events flow back and drive the task to review", async () => {
    wired = await wire(createMockAdapter());
    const taskId = await createReadyTask(wired.server);

    // assign -> onRunQueued -> dispatch run.start over the transport
    await wired.server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    // node finishes streaming all run.events, then the server finishes ingesting
    await wired.node.stop();
    await wired.binding.drain();

    expect(await taskStatus(wired.server, taskId)).toBe("review");
    const snap = (
      await wired.server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })
    ).json();
    expect(snap.runs[0].status).toBe("completed");
    expect(snap.artifacts).toHaveLength(1);
  });

  it("rejected run.start (process_start_failed) returns the task to ready (no stuck)", async () => {
    const failingAdapter: RuntimeAdapter = {
      ...createMockAdapter(),
      start: () => Promise.reject(new Error("cannot spawn process")),
    };
    wired = await wire(failingAdapter);
    const taskId = await createReadyTask(wired.server);

    await wired.server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    await wired.node.stop();
    await wired.binding.drain();

    // recovery: run failed, task back to ready (retryable), never stuck
    expect(await taskStatus(wired.server, taskId)).toBe("ready");
    const snap = (
      await wired.server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })
    ).json();
    expect(snap.runs[0].status).toBe("failed");
  });
});
