import assert from "node:assert/strict";
import { execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentInstanceHandle, RunEvent } from "@artoo/protocol";
import { createProcessAdapter, getOwnedStartupReceipt, getOwnedStopReceipt, type OwnedRunAdmission } from "../../../apps/artood/dist/process-adapter.js";
import { provisionRunNamespace } from "../../../apps/artood/dist/owned/workspace-namespace.js";
import { prepareOwnedWorktree, reserveOwnedWorktree, materializeOwnedWorktree, type MaterializedWorktree } from "../../../apps/artood/dist/owned/worktree-reservation.js";
import { OwnedGitError } from "../../../apps/artood/dist/owned/owned-git.js";
import type { FreshLaunchPermit, Journal, StartRequest, TerminalSettlement } from "../../../apps/artood/dist/managed/journal-types.js";

interface Lifetime { role: string; pid?: number; close?: string; exit?: string; code?: number | null; signal?: string | null; groupAbsent?: boolean }
let uncertain = false;
export function assertPhysicalFixturesClosed(): void { if (uncertain) throw new Error("Physical fixture cleanup remains uncertain"); }
const absent = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
};
async function until(predicate: () => boolean, milliseconds = 10000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Real physical fixture observation deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function helperFailure(error: unknown): void {
  const seen = new Set<unknown>();
  for (let item = error; item && typeof item === "object" && !seen.has(item);) {
    seen.add(item);
    if (item instanceof OwnedGitError && !item.receipt.cleanupConfirmed) uncertain = true;
    item = Object.getOwnPropertyDescriptor(item, "cause")?.value;
  }
}
/** Every mode uses the real Git and producer; modes select actual cancellation
 * timing/persistence, never synthetic physical-closure proof. */
export async function physicalRun(journal: Journal, permit: FreshLaunchPermit, request: StartRequest, root: string,
  mode: "unsettled" | "settled" | "settled-failed" | "settled-cancelled" | "startup-cancel" | "startup-not-spawned") {
  const payload = request.payload, source = join(root, `source-${request.runId}`), program = join(root, `writer-${request.runId}.cjs`);
  mkdirSync(source, { mode: 0o700 }); mkdirSync(payload.workspace_allocation!.base_path, { recursive: true, mode: 0o700 });
  const gitEnvironment = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: source, env: gitEnvironment, encoding: "utf8", timeout: 10000 }).trim();
  git("init", "-q"); git("config", "user.name", "Journal fixture"); git("config", "user.email", "journal@example.invalid");
  writeFileSync(join(source, "tracked.txt"), "original fixture bytes\n"); git("add", "tracked.txt"); git("commit", "-qm", "fixture baseline");
  const head = git("rev-parse", "HEAD");
  writeFileSync(program, "const fs=require('node:fs');fs.readFileSync(process.argv[2]);fs.writeFileSync('ready',String(process.pid));console.log('real journal fixture');setInterval(()=>{if(fs.existsSync('release'))process.exit(0)},20);setTimeout(()=>process.exit(91),15000);\n", { flag: "wx", mode: 0o600 });
  const childProcesses = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  const original = childProcesses.spawn, lifetimes: Lifetime[] = [], controller = new AbortController();
  const observeClosure = () => ({ at: new Date().toISOString(), processes: lifetimes.map((row) => ({ ...row,
    childAbsent: row.pid !== undefined && absent(row.pid), groupAbsent: row.pid !== undefined && absent(-row.pid),
  })) });
  const assertClosedObservation = (observation: ReturnType<typeof observeClosure>) => {
    for (const row of observation.processes) assert(row.exit && row.close && row.childAbsent && row.groupAbsent);
  };
  childProcesses.spawn = ((...args: Parameters<typeof original>) => {
    const child = Reflect.apply(original, childProcesses, args) as ChildProcess;
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const opts = (Array.isArray(args[1]) ? args[2] : args[1]) as SpawnOptions | undefined;
    if (opts?.detached) {
      const role = args[0] === "/usr/bin/git" ? "git" : argv[0] === program ? "cli" : "guardian";
      const row: Lifetime = { role, pid: child.pid }; lifetimes.push(row);
      child.once("exit", () => { row.exit = new Date().toISOString(); });
      child.once("close", (code, signal) => { row.close = new Date().toISOString(); row.code = code; row.signal = signal; });
      if (mode === "startup-cancel" && role === "guardian") controller.abort(new Error("Cancel after actual guardian creation"));
    }
    return child;
  }) as typeof original;
  syncBuiltinESMExports();
  const adapter = createProcessAdapter({ command: [process.execPath, program, "{{context_pack_path}}"], allowedRoots: [root] });
  let handle: AgentInstanceHandle | undefined, admission: OwnedRunAdmission | undefined, worktree: MaterializedWorktree | undefined;
  let stream: Promise<void> | undefined;
  const events: RunEvent[] = [];
  try {
    await journal.advance(permit, "preparing");
    const input = { root: payload.workspace.root, basePath: payload.workspace_allocation!.base_path,
      agentInstanceId: payload.agent_instance_id, runId: payload.run_id, sourceRepo: source, allowedRoots: [root] };
    const options = { gitExecutable: "/usr/bin/git", environment: gitEnvironment, readTimeoutMs: 10000, materializeTimeoutMs: 30000, terminationTimeoutMs: 5000 };
    await provisionRunNamespace(input, options);
    worktree = await materializeOwnedWorktree(await reserveOwnedWorktree(await prepareOwnedWorktree({ ...input, branch: payload.workspace.branch! }, options)));
    await journal.advance(permit, "launch_intent");
    if (mode === "startup-not-spawned") controller.abort(new Error("Actual startup cancellation before spawn"));
    let startupError: unknown;
    try {
      const started = await journal.startOwnedProcess(permit, adapter, worktree, controller.signal);
      handle = started.handle; admission = started.admission;
    } catch (error) { startupError = error; }
    if (mode === "startup-cancel" || mode === "startup-not-spawned") {
      assert.equal(handle, undefined); assert(startupError);
      const closureObservation = observeClosure(); assertClosedObservation(closureObservation);
      const launchCount = lifetimes.length;
      await assert.rejects(journal.startOwnedProcess(permit, adapter, worktree, new AbortController().signal), /unused committed launch_intent/);
      assert.equal(lifetimes.length, launchCount);
      let settled;
      if (mode === "startup-cancel") {
        assert(lifetimes.some((row) => row.role === "cli"));
        await assert.rejects(journal.settleOwnedStartupFailure(permit, { ...worktree }, startupError), /this journal admission/);
        await assert.rejects(journal.settleOwnedStartupFailure(permit, worktree, new Error(String(startupError))), /authenticated spawned-child/);
        settled = await journal.settleOwnedStartupFailure(permit, worktree, startupError);
      } else {
        await assert.rejects(journal.settleOwnedStartupFailure(permit, worktree, startupError), /not_spawned remains unknown/);
        assert.equal(lifetimes.filter((row) => row.role !== "git").length, 0);
      }
      assert.equal(git("rev-parse", "HEAD"), head); assert.equal(git("status", "--porcelain"), "");
      return { case: mode, settled, lifetimes, closureObservation, noStartedEvent: true, sourceUnchanged: true,
        proofBoundary: "The journal privately authenticates the actual startup error; public serialized fields are not authority",
        actualWriterChildren: lifetimes.filter((row) => row.role === "cli").length, physicalCleanupConfirmed: true };
    }
    if (startupError) throw startupError;
    assert(handle && admission);
    const launchCount = lifetimes.length;
    await assert.rejects(adapter.startOwnedRun({ runId: payload.run_id, taskId: payload.task_id, agentInstanceId: payload.agent_instance_id,
      runtime: payload.runtime, workspaceRoot: payload.workspace.root, runStart: payload }, worktree, admission, new AbortController().signal), /fresh authenticated owned admission/);
    assert.equal(lifetimes.length, launchCount);
    const started = await journal.recordStarted(permit, adapter, handle);
    await journal.appendEvent(permit, "fixture:started", { type: "run.lifecycle", payload: { phase: "started" } });
    stream = (async () => { for await (const event of adapter.streamEvents(handle!)) events.push(event); })();
    await until(() => existsSync(join(payload.workspace.root, "ready")));
    writeFileSync(join(payload.workspace.root, "release"), "natural completion");
    await stream;
    const raw = await adapter.stopOwnedRun(handle, admission, "shutdown"), proof = getOwnedStopReceipt(raw, admission, handle);
    const closureObservation = observeClosure(); assertClosedObservation(closureObservation);
    assert.equal(proof?.kind, "confirmed_closed"); assert.equal(proof?.facts?.childSpawned, true);
    assert(lifetimes.some((row) => row.role === "cli")); assert(lifetimes.some((row) => row.role === "guardian"));
    for (const row of lifetimes.filter((value) => value.role === "guardian")) { assert.equal(row.code, 0); assert.equal(row.signal, null); }
    const terminal = [...events].reverse().find((event) => event.type === "run.lifecycle" && event.payload.phase === "completed");
    assert(terminal?.type === "run.lifecycle" && terminal.payload.phase === "completed");
    let settled;
    if (mode.startsWith("settled")) {
      // Failed/cancelled are explicitly labelled settlement-policy fixtures;
      // the underlying spawned writer and physical closure remain genuine.
      const phase = mode === "settled-failed" ? "failed" : mode === "settled-cancelled" ? "cancelled" : "completed";
      const settlement: TerminalSettlement = { terminal: phase === "completed" ? terminal as TerminalSettlement["terminal"]
        : { type: "run.lifecycle", payload: { phase, reason: `original_${phase}_reason` } }, retentionOutcome: phase };
      await assert.rejects(journal.settleOwnedProcess(permit, handle, { ...raw }, settlement), /authenticated physical/);
      settled = await journal.settleOwnedProcess(permit, handle, raw, settlement);
    }
    assert.equal(git("rev-parse", "HEAD"), head); assert.equal(git("status", "--porcelain"), "");
    return { case: mode.startsWith("settled") ? "real-producer-settled" : "real-producer-not-settled", settlementPolicyFixture: mode !== "settled", started, settled, terminal,
      actualProof: proof, lifetimes, closureObservation, contextSha256: createHash("sha256").update(readFileSync(join(payload.workspace.root, "context_pack.md"))).digest("hex"),
      contextText: readFileSync(join(payload.workspace.root, "context_pack.md"), "utf8"), sourceUnchanged: true, physicalCleanupConfirmed: true };
  } catch (error) {
    helperFailure(error);
    if (!handle && admission && worktree && getOwnedStartupReceipt(error, admission, worktree)?.kind !== "not_spawned") uncertain = true;
    throw error;
  } finally {
    try {
      if (handle && admission) {
        const raw = await adapter.stopOwnedRun(handle, admission, "shutdown");
        if (getOwnedStopReceipt(raw, admission, handle)?.kind !== "confirmed_closed") throw new Error("Physical cleanup lacks producer closure proof");
        if (stream) await stream;
      }
      await until(() => lifetimes.every((row) => row.pid !== undefined && !!row.close && !!row.exit && absent(row.pid) && absent(-row.pid)));
    } catch (error) { uncertain = true; throw error; }
    finally { childProcesses.spawn = original; syncBuiltinESMExports(); }
  }
}
