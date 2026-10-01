import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { NodeToServerMessage, RunStartCommand } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { expect, it, vi } from "vitest";

import { createNodeClient } from "./node-client.js";
import { createProcessAdapter } from "./process-adapter.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

it("preserves actual child edits when process guardian startup fails after the CLI has started writing", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "artoo-startup-retention-")));
  const base = join(temporary, "base"), workspace = join(temporary, "workspace"), hooks = join(temporary, "hooks");
  const globalConfig = join(temporary, "empty.gitconfig");
  const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig };
  const marker = join(temporary, "writer-ready.json"), writer = join(temporary, "writer.cjs");
  const original = "Original committed bytes\n", edited = "Actual CLI edited these tracked bytes\n", added = "Actual CLI created this new file\n";
  const received: NodeToServerMessage[] = [], channel = createInProcessChannel();
  const git = (...args: string[]) => execFileSync("git", ["-C", base, ...args], { encoding: "utf8", timeout: 10000, env: gitEnvironment });
  let injected = false, observedBeforeFailure: string[] = [], ownedPid: number | undefined;
  let client: ReturnType<typeof createNodeClient> | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    mkdirSync(hooks);
    writeFileSync(globalConfig, "");
    execFileSync("git", ["init", "-q", `--template=${hooks}`, base], { timeout: 10000, env: gitEnvironment });
    git("config", "core.hooksPath", hooks); git("config", "user.name", "Owned startup fixture"); git("config", "user.email", "startup@artoo.test");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(base, "tracked.txt"), original); git("add", "tracked.txt");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "Owned baseline");
    writeFileSync(writer, `const fs=require('node:fs');fs.writeFileSync('tracked.txt',${JSON.stringify(edited)});fs.writeFileSync('new.txt',${JSON.stringify(added)});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);setTimeout(()=>process.exit(99),15000);`);
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (command === process.execPath && args?.[0] === "-e" && options?.env?.ELECTRON_RUN_AS_NODE === "1") {
        injected = true;
        const guardian = new EventEmitter() as ChildProcess;
        Object.defineProperty(guardian, "stdin", { value: new PassThrough() });
        void (async () => {
          await expect.poll(() => existsSync(marker), { timeout: 5000 }).toBe(true);
          ownedPid = (JSON.parse(readFileSync(marker, "utf8")) as { pid: number }).pid;
          observedBeforeFailure = [readFileSync(join(workspace, "tracked.txt"), "utf8"), readFileSync(join(workspace, "new.txt"), "utf8")];
          guardian.emit("error", new Error("Injected guardian spawn failure after actual CLI writes"));
        })().catch((error) => guardian.emit("error", error));
        return guardian;
      }
      return actual.spawn(command, args, command === "git" ? { ...options, env: gitEnvironment } : options);
    });
    const adapter = createProcessAdapter({ command: [process.execPath, writer], allowedRoots: [temporary] });
    client = createNodeClient({ nodeId: "startup-node", transport: channel.node, adapter,
      workspace: { worktreeBaseRepo: base, allowedRoots: [temporary] } });
    channel.serverTransport.subscribe((message) => { received.push(message); });
    const start: RunStartCommand = { kind: "command", id: "start-guardian-failure", type: "run.start", idempotency_key: "guardian-failure:start",
      payload: { run_id: "run-guardian-failure", task_id: "task-startup", agent_instance_id: "owned-instance", runtime: adapter.runtimeId,
        workspace: { root: workspace, branch: "artoo/guardian-failure" }, context_pack: { id: "context-startup", uri: "inline" },
        policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] }, artifact_rules: { paths: [] } } };
    client.start(); await channel.serverTransport.send(start);
    await expect.poll(() => received.find((message) => message.kind === "command.ack"), { timeout: 10000 }).toMatchObject({ status: "rejected", error_code: "process_start_failed" });
    await client.stop();
    expect(injected).toBe(true);
    expect(observedBeforeFailure).toEqual([edited, added]);
    expect(ownedPid).toBeGreaterThan(1);
    expect(alive(ownedPid!)).toBe(false);
    const ack = received.find((message) => message.kind === "command.ack");
    expect(ack?.message).toContain("Injected guardian spawn failure after actual CLI writes");
    expect(JSON.parse(ack!.message!.split("Worktree retained for recovery: ")[1]!)).toEqual({
      run_id: "run-guardian-failure", task_id: "task-startup", workspace_root: workspace,
      workspace_branch: "artoo/guardian-failure", outcome: "process_start_failed",
    });
    expect(readFileSync(join(base, "tracked.txt"), "utf8")).toBe(original);
    expect(git("status", "--porcelain")).toBe("");
    expect(existsSync(workspace), "A guardian startup rejection must not erase actual child work").toBe(true);
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe(edited);
    expect(readFileSync(join(workspace, "new.txt"), "utf8")).toBe(added);
  } finally {
    await client?.stop(true);
    if (ownedPid !== undefined && alive(ownedPid)) {
      process.kill(process.platform === "win32" ? ownedPid : -ownedPid, "SIGKILL");
      await expect.poll(() => alive(ownedPid!), { timeout: 5000 }).toBe(false);
    }
    vi.mocked(spawn).mockRestore();
    await channel.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
