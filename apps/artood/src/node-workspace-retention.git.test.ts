import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeToServerMessage, RunEventMessage, RunStartCommand } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { describe, expect, it } from "vitest";
import { createNodeClient, type NodeClient } from "./node-client.js";
import { createProcessAdapter } from "./process-adapter.js";
import { createGitCliExecutor } from "./workspace-binding.js";

// Like worktree-git-smoke.test.ts, this integration test is opt-in. All Git
// mutations and child writes use a test-owned repository below the OS temp dir.
// ARTOO_GIT_SMOKE=1 npx vitest run apps/artood/src/node-workspace-retention.git.test.ts
const ENABLED = process.env.ARTOO_GIT_SMOKE === "1";
const originalBytes = Buffer.from("committed original contents\r\n");
const modifiedBytes = Buffer.from([0, 255, 1, 13, 10, 65, 90]);
const newBytes = Buffer.from("new unsaved file — retain every byte\n", "utf8");
const retentionPrefix = "Worktree retained for recovery: ";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function runEvents(messages: NodeToServerMessage[]): RunEventMessage[] {
  return messages.filter((message): message is RunEventMessage => message.kind === "run.event");
}

describe.skipIf(!ENABLED)("real Git worktree retention with an owned process", () => {
  it.each(["completed", "failed", "cancelled"] as const)("verifies actual writes, process exit and workspace cleanup for %s", async (phase) => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "artoo-retention-git-")));
    const baseRepo = join(temporary, "base"), workspaceRoot = join(temporary, "workspace"), hooks = join(temporary, "empty-hooks");
    const branch = `artoo/retention-${phase}`, fixture = join(temporary, "writer.cjs");
    const trackedPath = join(workspaceRoot, "tracked.bin"), newPath = join(workspaceRoot, "new.bin");
    const releasePath = join(workspaceRoot, "release"), messages: NodeToServerMessage[] = [], gitCalls: string[][] = [];
    const git = (...args: string[]) => execFileSync("git", ["-C", baseRepo, ...args], { encoding: "utf8", timeout: 10000 });
    const channel = createInProcessChannel();
    let client: NodeClient | undefined, ownedPid: number | undefined;
    try {
      mkdirSync(hooks);
      execFileSync("git", ["init", "-q", `--template=${hooks}`, baseRepo], { timeout: 10000 });
      git("config", "user.email", "retention@artoo.test");
      git("config", "user.name", "artoo-retention-test");
      git("config", "core.hooksPath", hooks);
      git("config", "core.autocrlf", "false");
      writeFileSync(join(baseRepo, "tracked.bin"), originalBytes);
      git("add", "tracked.bin");
      git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "owned retention fixture");
      const baselineHead = git("rev-parse", "HEAD");
      writeFileSync(fixture, `
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
if (!readFileSync('tracked.bin').equals(Buffer.from('${originalBytes.toString("base64")}', 'base64'))) process.exit(43);
writeFileSync('tracked.bin', Buffer.from('${modifiedBytes.toString("base64")}', 'base64'));
writeFileSync('new.bin', Buffer.from('${newBytes.toString("base64")}', 'base64'));
process.stdout.write('RETENTION_READY ' + JSON.stringify({ pid: process.pid, root: process.cwd() }) + '\\n');
// Stay alive until the test has verified the writes. Cancellation has no release
// file and must terminate through the real process adapter's run.stop path.
setInterval(() => { if (existsSync('release')) process.exit(${phase === "completed" ? 0 : 23}); }, 10);
setTimeout(() => process.exit(91), 15000); // Bounded fallback if the test aborts.
`);
      channel.serverTransport.subscribe((message) => {
        messages.push(message);
        if (message.kind === "run.event" && message.event.type === "run.output" && message.event.payload.text.startsWith("RETENTION_READY ")) {
          ownedPid = (JSON.parse(message.event.payload.text.slice("RETENTION_READY ".length)) as { pid: number }).pid;
        }
      });
      const realGit = createGitCliExecutor();
      const adapter = createProcessAdapter({ command: [process.execPath, fixture], allowedRoots: [temporary] });
      client = createNodeClient({ nodeId: "owned-retention-node", transport: channel.node, adapter,
        workspace: { worktreeBaseRepo: baseRepo, allowedRoots: [temporary] },
        git: { async run(args) { gitCalls.push([...args]); await realGit.run(args); } },
      });
      const command: RunStartCommand = { kind: "command", id: "start-retention", type: "run.start", idempotency_key: "retention:start",
        payload: { run_id: "retention-run", task_id: "retention-task", agent_instance_id: "owned-instance", runtime: adapter.runtimeId,
          workspace: { root: workspaceRoot, branch }, context_pack: { id: "retention-context", uri: "inline" },
          policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: [] }, artifact_rules: { paths: [] } } };
      expect(existsSync(workspaceRoot)).toBe(false);
      client.start();
      await channel.serverTransport.send(command);
      await expect.poll(() => ownedPid, { timeout: 10000 }).toBeTypeOf("number");
      expect(ownedPid).toBeGreaterThan(1);
      expect(alive(ownedPid!)).toBe(true);
      expect(readFileSync(trackedPath)).toEqual(modifiedBytes);
      expect(readFileSync(newPath)).toEqual(newBytes);
      expect(git("worktree", "list", "--porcelain")).toContain(`worktree ${workspaceRoot}\nHEAD ${baselineHead.trim()}\nbranch refs/heads/${branch}`);
      expect(execFileSync("git", ["-C", workspaceRoot, "status", "--porcelain"], { encoding: "utf8", timeout: 10000 })).toContain(" M tracked.bin");
      expect(gitCalls).toEqual([["-C", baseRepo, "worktree", "add", "-b", branch, workspaceRoot]]);

      if (phase === "cancelled") {
        await channel.serverTransport.send({ kind: "command", id: "stop-retention", type: "run.stop", idempotency_key: "retention:stop",
          payload: { run_id: "retention-run", reason: "user_cancelled" } });
      } else writeFileSync(releasePath, "exit now\n");
      await expect.poll(() => runEvents(messages).at(-1)?.event, { timeout: 10000 }).toMatchObject({
        type: "run.lifecycle", payload: { phase, reason: phase === "completed" ? null : phase === "failed" ? "exit 23" : "user_cancelled" },
      });
      await client.stop(); // Terminal delivery precedes async worktree cleanup.
      expect(alive(ownedPid!)).toBe(false);
      if (process.platform !== "win32") expect(alive(-ownedPid!)).toBe(false);
      expect(git("rev-parse", "HEAD")).toBe(baselineHead);
      expect(git("status", "--porcelain")).toBe("");
      expect(readFileSync(join(baseRepo, "tracked.bin"))).toEqual(originalBytes);
      expect(existsSync(join(baseRepo, "new.bin"))).toBe(false);
      expect(git("rev-parse", branch)).toBe(baselineHead);
      const diagnostics = runEvents(messages).filter((message) => message.event.type === "run.output" && message.event.payload.text.startsWith(retentionPrefix));
      if (phase === "completed") {
        expect(existsSync(workspaceRoot)).toBe(false);
        expect(git("worktree", "list", "--porcelain")).not.toContain(`worktree ${workspaceRoot}\n`);
        expect(gitCalls).toHaveLength(2);
        expect(gitCalls[1]).toEqual(["-C", baseRepo, "worktree", "remove", "--force", workspaceRoot]);
        expect(diagnostics).toEqual([]);
      } else {
        expect(readFileSync(trackedPath)).toEqual(modifiedBytes);
        expect(readFileSync(newPath)).toEqual(newBytes);
        expect(git("worktree", "list", "--porcelain")).toContain(`worktree ${workspaceRoot}\n`);
        expect(gitCalls).toHaveLength(1);
        expect(diagnostics).toHaveLength(1);
        const diagnostic = diagnostics[0]!.event;
        if (diagnostic.type !== "run.output") throw new Error("Expected recovery output");
        expect(JSON.parse(diagnostic.payload.text.slice(retentionPrefix.length))).toEqual({
          run_id: "retention-run", task_id: "retention-task", workspace_root: workspaceRoot, workspace_branch: branch, outcome: phase,
        });
        if (phase === "cancelled") {
          expect(existsSync(releasePath)).toBe(false);
          expect(messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "stop-retention", status: "accepted" }));
        }
      }
    } finally {
      try { await client?.stop(true); }
      finally {
        // A failing assertion must not leave this fixture's process or worktree.
        // Never search for or signal processes outside the PID captured above.
        if (ownedPid !== undefined && alive(ownedPid)) {
          process.kill(process.platform === "win32" ? ownedPid : -ownedPid, "SIGKILL");
          await expect.poll(() => alive(ownedPid!), { timeout: 5000 }).toBe(false);
        }
        try { if (existsSync(workspaceRoot)) git("worktree", "remove", "--force", workspaceRoot); }
        finally { await channel.close(); rmSync(temporary, { recursive: true, force: true }); }
        expect(existsSync(temporary)).toBe(false);
      }
    }
  });
});
