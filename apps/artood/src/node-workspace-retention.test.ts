import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NodeToServerMessage, RunEventMessage, RunStartCommand, RuntimeAdapter } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeClient } from "./node-client.js";
import type { GitExecutor } from "./workspace-binding.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

type Outcome = "completed" | "failed" | "cancelled" | "incomplete";
const retentionPrefix = "Worktree retained for recovery: ";
function runEvents(messages: NodeToServerMessage[]): RunEventMessage[] {
  return messages.filter((message): message is RunEventMessage => message.kind === "run.event");
}

/** Git is simulated, but deletion and both file bodies are real. This unit
 * fixture does not invoke the opt-in real-git/process smoke or any repository. */
async function runWorkspaceCase({ phase, rejectRetention = false, rejectTerminal = false, uploadFails = false, ordinary = false, lateCompletion = false }: {
  phase: Outcome; rejectRetention?: false | "sync" | "async"; rejectTerminal?: boolean; uploadFails?: boolean; ordinary?: boolean; lateCompletion?: boolean;
}) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "artoo-retention-unit-")));
  cleanups.push(() => rmSync(temporary, { recursive: true, force: true }));
  const baseRepo = join(temporary, "base"), workspaceRoot = join(temporary, "run-workspace");
  mkdirSync(baseRepo);
  const baselinePath = join(baseRepo, "tracked.bin"), modifiedPath = join(workspaceRoot, "tracked.bin"), newPath = join(workspaceRoot, "untracked.bin");
  const originalBytes = Buffer.from("previous tracked contents\r\n"), modifiedBytes = Buffer.from([0, 255, 1, 13, 10, 65, 90]);
  const newBytes = Buffer.from("new unsaved file — retain every byte\n", "utf8");
  writeFileSync(baselinePath, originalBytes);
  const materialize = () => { mkdirSync(workspaceRoot); copyFileSync(baselinePath, modifiedPath); };
  if (ordinary) materialize();
  const gitCalls: string[][] = [];
  const git: GitExecutor = { async run(args) {
    gitCalls.push([...args]);
    expect(args.at(-1)).toBe(workspaceRoot);
    if (args.includes("add")) materialize();
    else if (args.includes("remove")) rmSync(workspaceRoot, { recursive: true, force: true });
    else throw new Error("Unexpected unit git command");
  } };
  let releaseStop!: () => void, markStarted!: () => void, stops = 0;
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const adapter: RuntimeAdapter = {
    runtimeId: "retention-unit",
    async start(config) {
      expect(readFileSync(modifiedPath)).toEqual(originalBytes);
      writeFileSync(modifiedPath, modifiedBytes); writeFileSync(newPath, newBytes);
      return { runId: config.runId };
    },
    async *streamEvents() {
      yield { type: "run.lifecycle", payload: { phase: "started" } };
      if (phase === "cancelled") await stopGate;
      if (uploadFails) yield { type: "artifact.created", payload: { type: "patch", uri: pathToFileURL(newPath).href, metadata: {}, checksum: null } };
      if (phase !== "incomplete") yield { type: "run.lifecycle", payload: { phase, reason: phase === "failed" ? "actual adapter failure" : phase === "cancelled" ? "user_cancelled" : undefined } };
      if (lateCompletion) yield { type: "run.lifecycle", payload: { phase: "completed" } };
    },
    async stop() { stops++; releaseStop(); },
    async collectArtifacts() { return []; },
  };
  const channel = createInProcessChannel(), attempted: NodeToServerMessage[] = [], received: NodeToServerMessage[] = [];
  let terminalRejected = false;
  channel.serverTransport.subscribe((message) => {
    received.push(message);
    if (message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase === "started") markStarted();
  });
  const client = createNodeClient({ nodeId: "owned-node", adapter, git, workspace: { worktreeBaseRepo: baseRepo },
    transport: { ...channel.node, send(message) {
      attempted.push(message);
      if (rejectRetention && message.kind === "run.event" && message.event.type === "run.output" && message.event.payload.text.startsWith(retentionPrefix)) {
        if (rejectRetention === "async") return Promise.reject(new Error("retention diagnostic transport unavailable"));
        throw new Error("retention diagnostic transport unavailable");
      }
      if (rejectTerminal && !terminalRejected && message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase !== "started") {
        terminalRejected = true; throw new Error("terminal transport unavailable");
      }
      return channel.node.send(message);
    } },
    ...(uploadFails ? { uploadArtifact: async () => { throw new Error("artifact upload unavailable"); } } : {}),
  });
  cleanups.push(() => client.stop(true));
  const command: RunStartCommand = { kind: "command", id: "start-retained-run", type: "run.start", idempotency_key: "retained-run:start",
    payload: { run_id: "retained-run", task_id: "retained-task", agent_instance_id: "owned-instance", runtime: adapter.runtimeId,
      workspace: { root: workspaceRoot, ...(ordinary ? {} : { branch: "artoo/retained-run" }) },
      context_pack: { id: "retention-context", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: [] }, artifact_rules: { paths: ["*.patch"] } } };
  client.start();
  await channel.serverTransport.send(command);
  if (phase === "cancelled") {
    await started;
    expect(readFileSync(modifiedPath)).toEqual(modifiedBytes); expect(readFileSync(newPath)).toEqual(newBytes);
    await channel.serverTransport.send({ kind: "command", id: "stop-retained-run", type: "run.stop", idempotency_key: "retained-run:stop",
      payload: { run_id: "retained-run", reason: "user_cancelled" } });
  }
  await client.stop();
  return { baseRepo, baselinePath, workspaceRoot, modifiedPath, modifiedBytes, newPath, newBytes, originalBytes, gitCalls, received, attempted, stops };
}

function expectPreserved(fixture: Awaited<ReturnType<typeof runWorkspaceCase>>) {
  expect(readFileSync(fixture.modifiedPath)).toEqual(fixture.modifiedBytes);
  expect(readFileSync(fixture.newPath)).toEqual(fixture.newBytes);
  expect(readFileSync(fixture.baselinePath)).toEqual(fixture.originalBytes);
  expect(fixture.gitCalls.some((args) => args.includes("remove"))).toBe(false);
}

describe("worktree retention", () => {
  it.each(["completed", "failed", "cancelled"] as const)("preserves existing-file edits and new files after a delivered %s outcome", async (phase) => {
    const fixture = await runWorkspaceCase({ phase });
    expectPreserved(fixture);
    const events = runEvents(fixture.received), diagnostic = events.find((message) => message.event.type === "run.output");
    expect(diagnostic?.event.type).toBe("run.output");
    if (diagnostic?.event.type !== "run.output") throw new Error("Expected persistent recovery diagnostic");
    expect(diagnostic.event.payload.stream).toBe("stderr");
    expect(JSON.parse(diagnostic.event.payload.text.slice(retentionPrefix.length))).toEqual({
      run_id: "retained-run", task_id: "retained-task", workspace_root: fixture.workspaceRoot,
      workspace_branch: "artoo/retained-run", outcome: phase,
    });
    expect(events.at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase } });
    expect(events.map((message) => message.sequence)).toEqual(events.map((_, index) => index));
    expect(fixture.stops).toBe(phase === "cancelled" ? 1 : 0);
  });

  it.each(["sync", "async"] as const)("does not complete when required recovery output is rejected: %s", async (rejectRetention) => {
    const fixture = await runWorkspaceCase({ phase: "completed", rejectRetention });
    expectPreserved(fixture);
    expect(runEvents(fixture.attempted).some((message) => message.event.type === "run.lifecycle" && message.event.payload.phase === "completed")).toBe(false);
    expect(runEvents(fixture.received).at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: {
      phase: "failed", reason: "retention diagnostic transport unavailable",
    } });
    expect(fixture.stops).toBe(1);
  });

  it.each([["failed", "sync"], ["failed", "async"], ["cancelled", "sync"], ["cancelled", "async"]] as const)("keeps the actual %s reason when retention output delivery fails: %s", async (phase, rejectRetention) => {
    const fixture = await runWorkspaceCase({ phase, rejectRetention });
    expectPreserved(fixture);
    expect(runEvents(fixture.received).at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: {
      phase, reason: phase === "failed" ? "actual adapter failure" : "user_cancelled",
    } });
    expect(fixture.stops).toBe(phase === "cancelled" ? 1 : 0);
  });

  it("corrects the recovery outcome when completed terminal delivery fails", async () => {
    const fixture = await runWorkspaceCase({ phase: "completed", rejectTerminal: true });
    expectPreserved(fixture);
    const events = runEvents(fixture.received);
    expect(events.at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed", reason: "terminal transport unavailable" } });
    const diagnostics = events.flatMap((message) => message.event.type === "run.output"
      ? [JSON.parse(message.event.payload.text.slice(retentionPrefix.length))] : []);
    expect(diagnostics.map((diagnostic) => diagnostic.outcome)).toEqual(["completed", "incomplete_delivery"]);
    expect(events.at(-2)?.event.type).toBe("run.output");
    expect(runEvents(fixture.attempted).map((message) => message.sequence)).toEqual(runEvents(fixture.attempted).map((_, index) => index));
    expect(fixture.stops).toBe(1);
  });

  it("retains file bytes and the original upload error when artifact transfer fails", async () => {
    const fixture = await runWorkspaceCase({ phase: "completed", uploadFails: true });
    expectPreserved(fixture);
    expect(runEvents(fixture.received).some((message) => message.event.type === "artifact.created")).toBe(false);
    expect(runEvents(fixture.received).at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed", reason: "artifact upload unavailable" } });
  });

  it("does not equate stream exhaustion without completion to successful execution", async () => {
    const fixture = await runWorkspaceCase({ phase: "incomplete" });
    expectPreserved(fixture);
  });

  it.each(["failed", "cancelled"] as const)("does not erase a %s retention decision when a later completion frame arrives", async (phase) => {
    const fixture = await runWorkspaceCase({ phase, lateCompletion: true });
    expectPreserved(fixture);
  });

  it.each(["completed", "failed"] as const)("leaves ordinary workspaces intact without a retention diagnostic after %s", async (phase) => {
    const fixture = await runWorkspaceCase({ phase, ordinary: true });
    expectPreserved(fixture); expect(fixture.gitCalls).toEqual([]);
    expect(runEvents(fixture.received).map((message) => message.event.type)).toEqual(["run.lifecycle", "run.lifecycle"]);
  });
});
