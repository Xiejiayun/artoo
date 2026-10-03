import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createGitCliExecutor, createNodeClient, createProcessAdapter } from "@artoo/artood";
import type { NodeSideTransport, NodeToServerMessage, RunEventMessage } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * Gated end-to-end #23 seam smoke (opt-in only, skipped unless ARTOO_GIT_SMOKE=1):
 *   ARTOO_GIT_SMOKE=1 npx vitest run apps/server/src/branch-e2e-smoke.test.ts
 *
 * Unlike the node-only smoke, this drives the FULL seam the API/persistence path
 * adds: REST `assign{branch_backed:true}` -> server persists the per-run branch +
 * ContextPack -> dispatches run.start over the in-process channel -> a REAL
 * node-client materializes a git worktree on a new branch -> the mock-agent
 * fixture runtime produces an artifact -> committed retention receipt -> run
 * completes with worktree and branch retained -> the server drives the task to review.
 *
 * SAFETY: base repo and the assigned workspace root both live under the OS temp
 * dir (seeded via buildTestServer({ workspaceRoot })) — never the project repo.
 */
const ENABLED = process.env.ARTOO_GIT_SMOKE === "1";
const fixture = fileURLToPath(
  new URL("../../artood/test-fixtures/mock-agent.mjs", import.meta.url),
);

function isRunEvent(m: NodeToServerMessage): m is RunEventMessage {
  return m.kind === "run.event";
}

describe.skipIf(!ENABLED)("#23 gated e2e: REST assign -> node -> real git worktree", () => {
  let server: TestServer | undefined;
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
    await server?.close();
    server = undefined;
  });

  it("materializes a worktree from a branch-backed assign and retains completed work with committed metadata", async () => {
    // 1. Throwaway base git repo (real git) under tmpdir.
    const baseRepo = mkdtempSync(join(tmpdir(), "artoo-e2e-baserepo-"));
    cleanups.push(() => rmSync(baseRepo, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", baseRepo]);
    execFileSync("git", ["-C", baseRepo, "config", "user.email", "e2e@artoo.test"]);
    execFileSync("git", ["-C", baseRepo, "config", "user.name", "artoo-e2e"]);
    execFileSync("git", ["-C", baseRepo, "commit", "-q", "--allow-empty", "-m", "init"]);

    // 2. Isolated workspace root (not yet materialized) under tmpdir.
    const wsParent = mkdtempSync(join(tmpdir(), "artoo-e2e-ws-"));
    cleanups.push(() => rmSync(wsParent, { recursive: true, force: true }));
    const workspaceRoot = join(wsParent, "run");
    if (!workspaceRoot.startsWith(tmpdir())) {
      throw new Error("e2e refuses to operate outside the OS temp dir");
    }

    // 3. Seed the assigned instance's workspace root to the tmp path so the run's
    //    workspace_root (and the worktree materialization target) is the tmp dir.
    server = await buildTestServer({ workspaceRoot });

    // 4. Bridge the server's node binding to a REAL node-client (real git executor).
    const channel = createInProcessChannel();
    const binding = attachNodeBinding(server.ctx, channel.serverTransport, "computer_local_mock");
    server.ctx.onRunQueued = (runId) => binding.dispatchRunStart(runId);
    cleanups.push(() => binding.close());

    // This seam uses synchronous message delivery, but a run event is accepted
    // only after the real server binding commits and emits its receipt.
    const receipts = new Map<string, string>();
    const unsubscribeReceipts = channel.node.subscribe((message) => {
      if (message.type === "run.event.ack") {
        receipts.set(`${message.payload.run_id}:${message.payload.sequence}`, message.payload.status);
      }
    });
    cleanups.push(unsubscribeReceipts);
    const transport: NodeSideTransport = {
      acknowledgesRunEvents: true,
      subscribe: channel.node.subscribe,
      async send(message) {
        await channel.node.send(message);
        if (isRunEvent(message)) {
          await binding.drain();
          expect(receipts.get(`${message.run_id}:${message.sequence}`)).toBe("accepted");
        }
      },
    };

    const adapter = createProcessAdapter({
      command: [
        process.execPath,
        fixture,
        "--workspace",
        "{{workspace_root}}",
        "--context",
        "{{context_pack_path}}",
      ],
      allowedRoots: [wsParent],
      artifacts: [{ type: "patch", path: "changes.patch" }],
    });
    const node = createNodeClient({
      nodeId: "computer_local_mock",
      transport,
      adapter,
      workspace: { worktreeBaseRepo: baseRepo },
      git: createGitCliExecutor(),
    });
    node.start();
    cleanups.push(() => node.stop());

    const received: NodeToServerMessage[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      channel.serverTransport.subscribe((m) => {
        received.push(m);
        if (m.kind === "command.ack" && m.status === "rejected") reject(new Error(m.message));
        if (isRunEvent(m) && m.event.type === "run.lifecycle" && m.event.payload.phase === "failed") {
          reject(new Error(m.event.payload.reason ?? "Execution failed"));
        }
        if (
          isRunEvent(m) &&
          m.event.type === "run.lifecycle" &&
          m.event.payload.phase === "completed"
        ) {
          resolve();
        }
      });
    });
    void completed.catch(() => {});

    // 5. Drive the seam over REST: create -> ready -> assign(branch_backed).
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "e2e branch-backed",
        acceptance_criteria: ["x"],
        required_capabilities: ["code.modify"],
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    expect(existsSync(workspaceRoot)).toBe(false); // not materialized before run.start

    const assignRes = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto", branch_backed: true },
    });
    expect(assignRes.statusCode).toBe(200);
    const run = assignRes.json().run;
    const branch = `artoo/run-${run.id}`;
    expect(run.workspace_branch).toBe(branch);
    // Defensive: the materialization target MUST be the tmp dir (never the repo).
    // If the seed workspaceRoot passthrough ever breaks, fail loudly here.
    expect(run.workspace_root).toBe(workspaceRoot);

    await completed;
    await node.stop();
    await binding.drain();

    // The fixture runtime produced an artifact inside the real worktree.
    expect(received.filter(isRunEvent).some((e) => e.event.type === "artifact.created")).toBe(true);
    // Product completion preserves the actual worktree and original file bytes.
    expect(existsSync(workspaceRoot)).toBe(true);
    expect(readFileSync(join(workspaceRoot, "changes.patch"), "utf8"))
      .toBe("--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n");
    expect(execFileSync("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim())
      .toBe(realpathSync(workspaceRoot));
    expect(execFileSync("git", ["-C", workspaceRoot, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe(branch);
    // The per-run branch also persists in the source repository.
    const branches = execFileSync("git", ["-C", baseRepo, "branch", "--list", branch]).toString();
    expect(branches).toContain(branch);
    // The server ingested the run lifecycle and drove the task to review.
    const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(snap.statusCode).toBe(200);
    expect(snap.json().task.status).toBe("review");
    expect(snap.json().runs).toHaveLength(1);
    expect(snap.json().runs[0]).toMatchObject({ id: run.id, status: "completed", workspace_root: workspaceRoot,
      workspace_branch: branch, workspace_retention: { version: 1, workspace_root: workspaceRoot,
        workspace_branch: branch, outcome: "completed", reporter_computer_id: "computer_local_mock" } });
    const runEvents = received.filter(isRunEvent);
    const retained = runEvents.findIndex((event) => event.event.type === "run.workspace.retained");
    const terminal = runEvents.findIndex((event) => event.event.type === "run.lifecycle" && event.event.payload.phase === "completed");
    expect(retained).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThan(retained);
    expect(receipts.get(`${run.id}:${runEvents[retained]!.sequence}`)).toBe("accepted");
  });
});
