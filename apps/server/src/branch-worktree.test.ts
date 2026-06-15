import type { NodeTransport, RunStartCommand, ServerToNodeMessage } from "@artoo/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

async function createReadyTask(server: TestServer): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "t",
      acceptance_criteria: ["x"],
      required_capabilities: ["code.modify"],
    },
  });
  const id = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` });
  return id;
}

async function assign(server: TestServer, taskId: string, body: Record<string, unknown> = {}) {
  return server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "auto", ...body },
  });
}

describe("#23 branch-backed worktree opt-in (persistence)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("persists an explicit workspace_branch verbatim", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const res = await assign(server, task, { workspace_branch: "feature/Login-Fix" });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.workspace_branch).toBe("feature/Login-Fix"); // source-case preserved
  });

  it("generates a deterministic artoo/run-<id> branch for branch_backed", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const res = await assign(server, task, { branch_backed: true });
    const run = res.json().run;
    expect(run.workspace_branch).toBe(`artoo/run-${run.id}`);
  });

  it("rejects providing both workspace_branch and branch_backed (400)", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const res = await assign(server, task, { workspace_branch: "feature/x", branch_backed: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects blank or padded workspace_branch values", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const blank = await assign(server, task, { workspace_branch: "   " });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error.code).toBe("validation_error");

    const padded = await assign(server, task, { workspace_branch: " feature/x " });
    expect(padded.statusCode).toBe(400);
    expect(padded.json().error.code).toBe("validation_error");
  });

  it("ordinary assign leaves workspace_branch null (back-compat)", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const res = await assign(server, task);
    expect(res.statusCode).toBe(200);
    expect(res.json().run.workspace_branch ?? null).toBeNull();
  });
});

describe("#23 run.start dispatch carries branch, policy_snapshot unchanged", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function dispatchAndCapture(taskBody: Record<string, unknown>): Promise<RunStartCommand> {
    server = await buildTestServer();
    const sent: ServerToNodeMessage[] = [];
    const transport: NodeTransport = {
      send: async (message) => {
        sent.push(message);
      },
      subscribe: () => () => {},
      close: async () => {},
    };
    const binding = attachNodeBinding(server.ctx, transport);
    const task = await createReadyTask(server);
    const runId = (await assign(server, task, taskBody)).json().run.id as string;
    await binding.dispatchRunStart(runId);
    binding.close();
    const cmd = sent.find((m) => (m as { type?: string }).type === "run.start");
    if (cmd === undefined) {
      throw new Error("no run.start command was dispatched");
    }
    return cmd as RunStartCommand;
  }

  it("includes workspace.branch for a branch-backed run; keeps write scope = [root]", async () => {
    const cmd = await dispatchAndCapture({ branch_backed: true });
    expect(cmd.payload.workspace.branch).toMatch(/^artoo\/run-/);
    // The node worktree-root authorization stays [workspaceRoot] — write_paths
    // narrowing must not leak into run.start policy_snapshot.
    expect(cmd.payload.policy_snapshot.filesystem_write_scope).toEqual([cmd.payload.workspace.root]);
  });

  it("omits workspace.branch for an ordinary run", async () => {
    const cmd = await dispatchAndCapture({});
    expect(cmd.payload.workspace.branch ?? null).toBeNull();
    expect(cmd.payload.policy_snapshot.filesystem_write_scope).toEqual([cmd.payload.workspace.root]);
  });
});
