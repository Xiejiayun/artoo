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
const ignoredBytes = Buffer.from([0, 254, 2, 13, 10, 66, 91]);
const patchBytes = Buffer.from("diff --git a/implementation.txt b/implementation.txt\n--- a/implementation.txt\n+++ b/implementation.txt\n@@ -1 +1 @@\n-before\n+after\n");
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
  it.each(["completed", "completed-with-partial-patch", "completed-with-rejected-recovery", "failed", "cancelled",
    "typed-completed", "typed-completed-with-partial-patch", "typed-completed-with-rejected-report", "typed-completed-with-rejected-terminal", "typed-cancelled"] as const)("retains actual writes after process exit for %s", async (scenario) => {
    const typed = scenario.startsWith("typed-");
    const mode = scenario.replace(/^typed-/, "");
    const withPatch = mode === "completed-with-partial-patch";
    const rejectRecovery = mode === "completed-with-rejected-recovery";
    const rejectReport = mode === "completed-with-rejected-report";
    const rejectTerminal = mode === "completed-with-rejected-terminal";
    const processPhase = mode.startsWith("completed") ? "completed" : mode;
    const deliveryError = rejectRecovery ? "recovery output unavailable" : rejectReport ? "typed report unavailable" : rejectTerminal ? "completed receipt unavailable" : null;
    const phase = deliveryError ? "failed" : processPhase;
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "artoo-retention-git-")));
    const baseRepo = join(temporary, "base"), workspaceRoot = join(temporary, "workspace"), hooks = join(temporary, "empty-hooks");
    const branch = `artoo/retention-${scenario}`, fixture = join(temporary, "writer.cjs"), launchesPath = join(temporary, "launches.txt");
    const trackedPath = join(workspaceRoot, "tracked.bin"), newPath = join(workspaceRoot, "new.bin"), ignoredPath = join(workspaceRoot, "ignored.bin");
    const patchPath = join(workspaceRoot, "changes.patch"), storedPatch = join(temporary, "uploaded.patch");
    const uploads: RunEventMessage["event"][] = [], committedMetadata: RunEventMessage[] = [];
    const releasePath = join(workspaceRoot, "release"), messages: NodeToServerMessage[] = [], attempted: NodeToServerMessage[] = [], gitCalls: string[][] = [];
    const git = (...args: string[]) => execFileSync("git", ["-C", baseRepo, ...args], { encoding: "utf8", timeout: 10000 });
    const channel = createInProcessChannel();
    let client: NodeClient | undefined, ownedPid: number | undefined, stops = 0;
    try {
      mkdirSync(hooks);
      execFileSync("git", ["init", "-q", `--template=${hooks}`, baseRepo], { timeout: 10000 });
      git("config", "user.email", "retention@artoo.test");
      git("config", "user.name", "artoo-retention-test");
      git("config", "core.hooksPath", hooks);
      git("config", "core.autocrlf", "false");
      writeFileSync(join(baseRepo, "tracked.bin"), originalBytes);
      writeFileSync(join(baseRepo, ".gitignore"), "ignored.bin\n");
      writeFileSync(join(baseRepo, "implementation.txt"), "before\n");
      git("add", "tracked.bin", ".gitignore", "implementation.txt");
      git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "owned retention fixture");
      const baselineHead = git("rev-parse", "HEAD");
      writeFileSync(fixture, `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(launchesPath)}, process.pid + '\\n');
if (!readFileSync('tracked.bin').equals(Buffer.from('${originalBytes.toString("base64")}', 'base64'))) process.exit(43);
writeFileSync('tracked.bin', Buffer.from('${modifiedBytes.toString("base64")}', 'base64'));
writeFileSync('new.bin', Buffer.from('${newBytes.toString("base64")}', 'base64'));
writeFileSync('ignored.bin', Buffer.from('${ignoredBytes.toString("base64")}', 'base64'));
if (${withPatch}) {
  writeFileSync('implementation.txt', 'after\\n');
  writeFileSync('changes.patch', Buffer.from('${patchBytes.toString("base64")}', 'base64'));
}
process.stdout.write('RETENTION_READY ' + JSON.stringify({ pid: process.pid, root: process.cwd() }) + '\\n');
// Stay alive until the test has verified the writes. Cancellation has no release
// file and must terminate through the real process adapter's run.stop path.
setInterval(() => { if (existsSync('release')) process.exit(${processPhase === "completed" ? 0 : 23}); }, 10);
setTimeout(() => process.exit(91), 15000); // Bounded fallback if the test aborts.
`);
      channel.serverTransport.subscribe((message) => {
        messages.push(message);
        if (message.kind === "run.event" && message.event.type === "run.output" && message.event.payload.text.startsWith("RETENTION_READY ")) {
          ownedPid = (JSON.parse(message.event.payload.text.slice("RETENTION_READY ".length)) as { pid: number }).pid;
        }
      });
      const realGit = createGitCliExecutor();
      const adapter = createProcessAdapter({ command: [process.execPath, fixture], allowedRoots: [temporary],
        ...(withPatch ? { artifacts: [{ type: "patch", path: "changes.patch" }] } : {}) });
      const stop = adapter.stop;
      adapter.stop = async (...args) => { stops++; await stop(...args); expect(alive(ownedPid!)).toBe(false); };
      client = createNodeClient({ nodeId: "owned-retention-node", adapter,
        transport: { ...channel.node, acknowledgesRunEvents: typed, async send(message) {
          attempted.push(message);
          if (message.kind === "run.event" && message.event.type === "run.workspace.retained") {
            expect(typed).toBe(true);
            expect(alive(ownedPid!)).toBe(false);
            expect(message.event.payload).toMatchObject({ version: 1, workspace_root: workspaceRoot, workspace_branch: branch });
            if (rejectReport && message.event.payload.outcome === "completed") throw new Error("typed report unavailable");
            // Simulated committed-receipt ledger, separate from the real Git and
            // process/byte assertions. This is not a live server transaction.
            committedMetadata.push(message);
          }
          if (typed && message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase === "completed") {
            expect(committedMetadata.at(-1)?.event).toMatchObject({ type: "run.workspace.retained", payload: { outcome: "completed" } });
            if (rejectTerminal) throw new Error("completed receipt unavailable");
          }
          if (rejectRecovery && message.kind === "run.event" && message.event.type === "run.output"
            && message.event.payload.text.startsWith(retentionPrefix)
            && JSON.parse(message.event.payload.text.slice(retentionPrefix.length)).outcome === "completed") {
            expect(alive(ownedPid!)).toBe(false);
            return Promise.reject(new Error("recovery output unavailable"));
          }
          return channel.node.send(message);
        } },
        workspace: { worktreeBaseRepo: baseRepo, allowedRoots: [temporary] },
        git: { async run(args) { gitCalls.push([...args]); await realGit.run(args); } },
        uploadArtifact: async (runId, root, event) => {
          expect(runId).toBe("retention-run"); expect(root).toBe(workspaceRoot);
          expect(readFileSync(patchPath)).toEqual(patchBytes);
          writeFileSync(storedPatch, readFileSync(patchPath));
          const uploaded = { ...event, payload: { ...event.payload, uri: "artoo://owned-test/changes.patch" } };
          uploads.push(uploaded);
          return uploaded;
        },
      });
      const command: RunStartCommand = { kind: "command", id: "start-retention", type: "run.start", idempotency_key: "retention:start",
        payload: { run_id: "retention-run", task_id: "retention-task", agent_instance_id: "owned-instance", runtime: adapter.runtimeId,
          workspace: { root: workspaceRoot, branch }, context_pack: { id: "retention-context", uri: "inline" },
          policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: [] }, artifact_rules: { paths: [] },
          ...(typed ? { workspace_retention_reporting: "typed-v1" } : {}) } };
      expect(existsSync(workspaceRoot)).toBe(false);
      client.start();
      await channel.serverTransport.send(command);
      await expect.poll(() => ownedPid, { timeout: 10000 }).toBeTypeOf("number");
      expect(ownedPid).toBeGreaterThan(1);
      expect(alive(ownedPid!)).toBe(true);
      expect(readFileSync(trackedPath)).toEqual(modifiedBytes);
      expect(readFileSync(newPath)).toEqual(newBytes);
      expect(readFileSync(ignoredPath)).toEqual(ignoredBytes);
      expect(execFileSync("git", ["-C", workspaceRoot, "check-ignore", "ignored.bin"], { encoding: "utf8", timeout: 10000 })).toBe("ignored.bin\n");
      expect(git("worktree", "list", "--porcelain")).toContain(`worktree ${workspaceRoot}\nHEAD ${baselineHead.trim()}\nbranch refs/heads/${branch}`);
      expect(execFileSync("git", ["-C", workspaceRoot, "status", "--porcelain"], { encoding: "utf8", timeout: 10000 })).toContain(" M tracked.bin");
      expect(gitCalls).toEqual([["-C", baseRepo, "worktree", "add", "-b", branch, workspaceRoot]]);

      if (phase === "cancelled") {
        await channel.serverTransport.send({ kind: "command", id: "stop-retention", type: "run.stop", idempotency_key: "retention:stop",
          payload: { run_id: "retention-run", reason: "user_cancelled" } });
      } else writeFileSync(releasePath, "exit now\n");
      await expect.poll(() => runEvents(messages).at(-1)?.event, { timeout: 10000 }).toMatchObject({
        type: "run.lifecycle", payload: { phase, reason: deliveryError ?? (phase === "completed" ? null : phase === "failed" ? "exit 23" : "user_cancelled") },
      });
      await client.stop(); // Includes all delivery and bookkeeping, without deleting the workspace.
      expect(alive(ownedPid!)).toBe(false);
      if (process.platform !== "win32") expect(alive(-ownedPid!)).toBe(false);
      expect(git("rev-parse", "HEAD")).toBe(baselineHead);
      expect(git("status", "--porcelain")).toBe("");
      expect(readFileSync(join(baseRepo, "tracked.bin"))).toEqual(originalBytes);
      expect(existsSync(join(baseRepo, "new.bin"))).toBe(false);
      expect(git("rev-parse", branch)).toBe(baselineHead);
      const diagnostics = runEvents(messages).filter((message) => message.event.type === "run.output" && message.event.payload.text.startsWith(retentionPrefix));
      expect(readFileSync(trackedPath)).toEqual(modifiedBytes);
      expect(readFileSync(newPath)).toEqual(newBytes);
      expect(readFileSync(ignoredPath)).toEqual(ignoredBytes);
      expect(git("worktree", "list", "--porcelain")).toContain(`worktree ${workspaceRoot}\n`);
      expect(gitCalls).toEqual([["-C", baseRepo, "worktree", "add", "-b", branch, workspaceRoot]]);
      expect(readFileSync(launchesPath, "utf8")).toBe(`${ownedPid}\n`);
      expect(diagnostics).toHaveLength(rejectTerminal ? 2 : 1);
      const diagnostic = diagnostics.at(-1)!.event;
      if (diagnostic.type !== "run.output") throw new Error("Expected recovery output");
      expect(JSON.parse(diagnostic.payload.text.slice(retentionPrefix.length))).toEqual({
        run_id: "retention-run", task_id: "retention-task", workspace_root: workspaceRoot, workspace_branch: branch, outcome: deliveryError ? "incomplete_delivery" : phase,
      });
      const events = runEvents(messages);
      const attempts = runEvents(attempted);
      expect(attempts.map((message) => message.sequence)).toEqual(attempts.map((_, index) => index));
      expect(stops).toBe(phase === "cancelled" || deliveryError ? 1 : 0);
      if (rejectRecovery || rejectReport) expect(attempts.some((message) => message.event.type === "run.lifecycle" && message.event.payload.phase === "completed")).toBe(false);
      const reports = events.flatMap((message) => message.event.type === "run.workspace.retained" ? [{ sequence: message.sequence, ...message.event.payload }] : []);
      expect(reports.map((report) => report.outcome)).toEqual(typed ? (rejectTerminal ? ["completed", "incomplete_delivery"] : [deliveryError ? "incomplete_delivery" : phase]) : []);
      expect(committedMetadata).toEqual(events.filter((message) => message.event.type === "run.workspace.retained"));
      if (reports.length === 2) expect(reports[1]!.sequence).toBeGreaterThan(reports[0]!.sequence);
      expect(events.at(-2)).toBe(diagnostics.at(-1));
      expect(events.at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase } });
      expect(events.filter((message) => message.event.type === "artifact.created").map((message) => message.event)).toEqual(uploads);
      expect(uploads).toHaveLength(withPatch ? 1 : 0);
      expect(readFileSync(join(baseRepo, "implementation.txt"), "utf8")).toBe("before\n");
      expect(existsSync(join(baseRepo, "ignored.bin"))).toBe(false);
      if (withPatch) {
        expect(readFileSync(storedPatch)).toEqual(patchBytes);
        expect(readFileSync(patchPath)).toEqual(patchBytes);
        expect(readFileSync(join(workspaceRoot, "implementation.txt"), "utf8")).toBe("after\n");
        execFileSync("git", ["-C", baseRepo, "apply", "--check", storedPatch], { timeout: 10000 });
        expect(patchBytes.toString()).not.toMatch(/new\.bin|ignored\.bin|tracked\.bin/);
        expect(events.at(typed ? -4 : -3)?.event).toEqual(uploads[0]);
      } else expect(existsSync(storedPatch)).toBe(false);
      if (phase === "cancelled") {
        expect(existsSync(releasePath)).toBe(false);
        expect(messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "stop-retention", status: "accepted" }));
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
