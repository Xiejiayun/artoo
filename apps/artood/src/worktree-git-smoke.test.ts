import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NodeToServerMessage, RunEventMessage, RunStartCommand } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeClient } from "./node-client.js";
import { createProcessAdapter } from "./process-adapter.js";
import { createGitCliExecutor } from "./workspace-binding.js";

/**
 * Gated real-git worktree smoke (#23). Opt-in only: skipped unless
 * `ARTOO_GIT_SMOKE=1`, so the normal `npm test` run never shells out to git.
 * Run it explicitly with:
 *   ARTOO_GIT_SMOKE=1 npx vitest run apps/artood/src/worktree-git-smoke.test.ts
 *
 * It builds a throwaway base git repo and an isolated workspace under the OS temp
 * dir (NEVER the project repo), then drives a branch-backed run.start through the
 * real node-client + real git executor + the mock-agent fixture runtime, proving:
 * worktree materialized on a NEW branch (`-b`) -> fixture produces an artifact ->
 * run completes -> worktree removed on cleanup -> the branch persists in the base
 * repo.
 */
const ENABLED = process.env.ARTOO_GIT_SMOKE === "1";
const fixture = fileURLToPath(new URL("../test-fixtures/mock-agent.mjs", import.meta.url));

function isRunEvent(m: NodeToServerMessage): m is RunEventMessage {
  return m.kind === "run.event";
}

describe.skipIf(!ENABLED)("gated git worktree smoke (real git)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("materializes a real worktree on a new branch, runs a fixture runtime, then cleans up", async () => {
    // 1. Throwaway base git repo (real git init + one commit).
    const baseRepo = mkdtempSync(join(tmpdir(), "artoo-smoke-baserepo-"));
    cleanups.push(() => rmSync(baseRepo, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", baseRepo]);
    execFileSync("git", ["-C", baseRepo, "config", "user.email", "smoke@artoo.test"]);
    execFileSync("git", ["-C", baseRepo, "config", "user.name", "artoo-smoke"]);
    execFileSync("git", ["-C", baseRepo, "commit", "-q", "--allow-empty", "-m", "init"]);

    // 2. Isolated worktree root (does not exist yet; git creates it). SAFETY:
    //    everything lives under the OS temp dir, never the project repo.
    const workspaceParent = mkdtempSync(join(tmpdir(), "artoo-smoke-ws-"));
    cleanups.push(() => rmSync(workspaceParent, { recursive: true, force: true }));
    const workspaceRoot = join(workspaceParent, "run1");
    if (!workspaceRoot.startsWith(tmpdir())) {
      throw new Error("git smoke refuses to operate outside the OS temp dir");
    }
    const branch = "artoo/run-smoke1";

    // 3. Node client with the REAL git executor, opt-in worktreeBaseRepo, and a
    //    real process adapter spawning the mock-agent fixture as the runtime.
    const channel = createInProcessChannel();
    const adapter = createProcessAdapter({
      command: [
        process.execPath,
        fixture,
        "--workspace",
        "{{workspace_root}}",
        "--context",
        "{{context_pack_path}}"
      ],
      allowedRoots: [workspaceParent],
      artifacts: [{ type: "patch", path: "changes.patch" }]
    });
    const client = createNodeClient({
      nodeId: "computer_smoke",
      transport: channel.node,
      adapter,
      workspace: { worktreeBaseRepo: baseRepo },
      git: createGitCliExecutor()
    });
    client.start();
    cleanups.push(() => {
      void client.stop();
    });

    const received: NodeToServerMessage[] = [];
    const completed = new Promise<void>((resolve) => {
      channel.serverTransport.subscribe((m) => {
        received.push(m);
        if (isRunEvent(m) && m.event.type === "run.lifecycle" && m.event.payload.phase === "completed") {
          resolve();
        }
      });
    });

    const runStart: RunStartCommand = {
      kind: "command",
      id: "cmd_smoke",
      idempotency_key: "run_smoke:start",
      type: "run.start",
      payload: {
        run_id: "run_smoke",
        task_id: "task_smoke",
        agent_instance_id: "ai_smoke",
        runtime: "mock",
        workspace: { root: workspaceRoot, branch },
        context_pack: { id: "ctx_smoke", uri: "inline" },
        policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: [] },
        artifact_rules: { paths: ["*.patch"] }
      }
    };

    expect(existsSync(workspaceRoot)).toBe(false); // not materialized yet
    await channel.serverTransport.send(runStart);
    await completed;
    await client.stop();

    const runEvents = received.filter(isRunEvent);
    expect(runEvents.some((e) => e.event.type === "artifact.created")).toBe(true);
    expect(runEvents.at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
    // Worktree was removed on terminal cleanup...
    expect(existsSync(workspaceRoot)).toBe(false);
    // ...but the branch the run created persists in the base repo.
    const branches = execFileSync("git", ["-C", baseRepo, "branch", "--list", branch]).toString();
    expect(branches).toContain(branch);
  });
});
