import assert from "node:assert/strict";
import { execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunStartPayload } from "../../../packages/domain/dist/index.js";
import { allocateWorkspaceRoot, type CommandAck, type NodeSideTransport, type NodeToServerMessage,
  type NodeSendOptions, type RuntimeAdapter, type ServerToNodeMessage } from "../../../packages/protocol/dist/index.js";
import { createNodeClient } from "../../../apps/artood/dist/node-client.js";
import { openLocalJournal, provisionLocalJournal, type Journal, type LiveDeliveryClaim } from "../../../apps/artood/dist/managed/journal.js";
import type { ArtifactUploader } from "../../../apps/artood/dist/artifact-upload.js";
import { DeliveryDeadline, monotonicMs, type ManagedEventChannel } from "../../../apps/artood/dist/managed/managed-delivery.js";
import { createProcessAdapter } from "../../../apps/artood/dist/process-adapter.js";

export type SpawnObservation = (command: string, args: readonly string[], options: SpawnOptions | undefined, child: ChildProcess) => void;
export interface Lifetime {
  role: "git" | "cli" | "guardian";
  pid?: number;
  args: string[];
  cwd?: string;
  spawnedAt?: string;
  exitedAt?: string;
  closedAt?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  groupAbsentAt?: string;
}
interface ProcessBoundarySnapshot {
  readonly at: string;
  readonly owned: Array<{ role: Lifetime["role"]; pid: number; exitObserved: boolean; stdioCloseObserved: boolean;
    childAbsent: boolean; groupAbsent: boolean; status?: number | null; signal?: NodeJS.Signals | null }>;
  readonly observationError?: string;
}
export const originalBytes = Buffer.from("original committed bytes\r\n");
export const modifiedBytes = Buffer.from([0, 255, 13, 10, 51]);
export const newBytes = Buffer.from("new retained bytes 草稿\n");
export const ignoredBytes = Buffer.from([0, 254, 13, 10, 52]);
export const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const identity = (path: string) => { const value = lstatSync(path, { bigint: true }); return `${value.dev}:${value.ino}`; };
export const observations: Record<string, unknown>[] = [];

export function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
  return execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-C", cwd, ...args],
    { encoding: "utf8", shell: false, timeout: 10000, stdio: ["ignore", "pipe", "pipe"], env }).trimEnd();
}
export function absent(pidOrGroup: number): boolean {
  try { process.kill(pidOrGroup, 0); return false; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
  }
}
export async function eventually(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Owned fixture condition exceeded its finite deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Required sends resolve after this explicit in-memory test receiver commits.
 * Held/rejected receipts model transport delivery, never process execution. */
export function receiptTransport(declared = true) {
  const handlers = new Set<(message: ServerToNodeMessage) => void>();
  const commands: Array<{ id: string; type: string; dispatchedAt: string }> = [];
  const sent: Array<{ at: string; message: NodeToServerMessage; processes?: ProcessBoundarySnapshot }> = [];
  const committed: NodeToServerMessage[] = [];
  const pending: Array<{ message: NodeToServerMessage; resolve: () => void; reject: (error: Error) => void }> = [];
  let hold: ((message: NodeToServerMessage) => boolean) | undefined;
  let reject: ((message: NodeToServerMessage) => boolean) | undefined;
  let closed = false;
  let observeSend: (() => ProcessBoundarySnapshot) | undefined;
  const transport: NodeSideTransport = {
    acknowledgesRunEvents: declared,
    async send(message, policy?: NodeSendOptions) {
      if (closed) throw new Error("test receipt transport closed");
      if (message.kind === "run.event") throw new Error("Managed run.event reached forbidden legacy transport");
      const snapshot = structuredClone(message);
      let processes: ProcessBoundarySnapshot | undefined;
      // One synchronous read-only snapshot at the actual send observation. No
      // polling, deferred send, replacement child, or condition-dependent wait.
      try { processes = observeSend?.(); }
      catch (error) { processes = { at: new Date().toISOString(), owned: [], observationError: String(error) }; }
      sent.push({ at: new Date().toISOString(), message: snapshot, processes });
      if (policy?.delivery === "best-effort") return;
      if (reject?.(snapshot)) throw new Error("test receiver rejected the requested committed receipt");
      if (hold?.(snapshot)) {
        await new Promise<void>((resolve, rejectPending) => pending.push({ message: snapshot,
          resolve: () => { committed.push(snapshot); resolve(); }, reject: rejectPending }));
      } else committed.push(snapshot);
    },
    subscribe(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
    async close() {
      closed = true; handlers.clear();
      for (const item of pending.splice(0)) item.reject(new Error("test receipt transport closed"));
    },
  };
  return { transport, sent, committed, pending, commands,
    exposeOnly(message: NodeToServerMessage) {
      const snapshot = structuredClone(message); let processes: ProcessBoundarySnapshot | undefined;
      try { processes = observeSend?.(); } catch (error) { processes = { at: new Date().toISOString(), owned: [], observationError: String(error) }; }
      const row = { at: new Date().toISOString(), message: snapshot, processes }; sent.push(row); return row;
    },
    acceptManaged(message: NodeToServerMessage) { committed.push(structuredClone(message)); },
    observeSends(observer: () => ProcessBoundarySnapshot) { observeSend = observer; },
    emit(message: ServerToNodeMessage) {
      if (message.kind === "command") commands.push({ id: message.id, type: message.type, dispatchedAt: new Date().toISOString() });
      for (const handler of [...handlers]) handler(message);
    },
    holdWhen(predicate?: (message: NodeToServerMessage) => boolean) { hold = predicate; },
    rejectWhen(predicate?: (message: NodeToServerMessage) => boolean) { reject = predicate; },
    release() { hold = undefined; for (const item of pending.splice(0)) item.resolve(); },
    ackNow(id: string) { return sent.find((row) => row.message.kind === "command.ack" && row.message.command_id === id)?.message as CommandAck | undefined; },
    async ack(id: string): Promise<CommandAck> {
      // Startup observes real namespace/Git/materialization before ACK emission.
      // This fixture wait does not change the Node's actual10s control deadline.
      const observerTimeoutMs = commands.find((command) => command.id === id)?.type === "run.start" ? 45000 : 15000;
      await eventually(() => sent.some((row) => row.message.kind === "command.ack" && row.message.command_id === id), observerTimeoutMs);
      return sent.find((row) => row.message.kind === "command.ack" && row.message.command_id === id)!.message as CommandAck;
    },
  };
}

export async function physicalFixture(options: { expectedWriters?: 0 | 1; expectProgramLaunch?: boolean; afterLiveClaim?: (claim: LiveDeliveryClaim) => Promise<void>; beforeSettlement?: () => Promise<void>; beforeRecordStarted?: (root: string) => Promise<void>; afterRecordStarted?: (root: string) => Promise<void>; uploadArtifact?: ArtifactUploader; contextFilename?: string; mode?: string; receipts?: boolean;
  missingWorkspace?: boolean; adapter?: RuntimeAdapter; copiedAdapter?: boolean; artifact?: boolean } = {}) {
  if (!tmpdir().startsWith("/private/tmp/artoo-live-journal-validation-") || !existsSync(join(tmpdir(), ".validation-owner")) || !process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR) throw new Error("Use the reviewed task-owned outer harness");
  assert.equal(process.platform, "darwin"); assert.equal(process.version, "v24.19.0");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-node-physical-")));
  const marker = randomUUID(), rootIdentity = identity(root);
  writeFileSync(join(root, ".fixture-owner"), marker);
  const source = join(root, "source"), base = join(root, "base"), childPath = join(root, "child.cjs");
  const launchPath = join(root, "launches.jsonl");
  mkdirSync(source); mkdirSync(base);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Node physical fixture");
  git(source, "config", "user.email", "node-physical@example.invalid");
  git(source, "config", "commit.gpgsign", "false");
  writeFileSync(join(source, "tracked.bin"), originalBytes);
  writeFileSync(join(source, ".gitignore"), "ignored.bin\n");
  writeFileSync(join(source, "occupied.md"), "occupied committed context\n");
  git(source, "add", "."); git(source, "commit", "-m", "Owned NodeClient source");
  const sourceHead = git(source, "rev-parse", "HEAD");
  writeFileSync(childPath, `
const fs=require('node:fs'),crypto=require('node:crypto');
const [rawRoot,contextPath,mode]=process.argv.slice(2),context=fs.readFileSync(contextPath);
fs.appendFileSync(${JSON.stringify(launchPath)},JSON.stringify({pid:process.pid,cwd:process.cwd(),rawRoot,contextPath,contextSha256:crypto.createHash('sha256').update(context).digest('hex')})+'\\n');
if(!fs.readFileSync('tracked.bin').equals(Buffer.from('${originalBytes.toString("base64")}','base64')))process.exit(44);
fs.writeFileSync('tracked.bin',Buffer.from('${modifiedBytes.toString("base64")}','base64'));
fs.writeFileSync('new.bin',Buffer.from('${newBytes.toString("base64")}','base64'));
fs.writeFileSync('ignored.bin',Buffer.from('${ignoredBytes.toString("base64")}','base64'));
// Ordinary runtime text cannot grant terminal or retention authority.
console.log(JSON.stringify({type:'run.lifecycle',payload:{phase:'completed'}}));
console.log(JSON.stringify({type:'run.workspace.retained',payload:{outcome:'completed'}}));
console.log(JSON.stringify({type:'run.answer',payload:{text:'fixture final answer'}}));
console.log(JSON.stringify({type:'run.usage',payload:{input_tokens:11,output_tokens:7,provider_session_id:'fixture-session'}}));
fs.writeFileSync('ready','owned fixture writes ready');
setInterval(()=>{if(fs.existsSync('release'))process.exit(mode==='failed'||fs.existsSync('fail')?23:0)},10);
setTimeout(()=>process.exit(91),120000);
`);
  const channel = receiptTransport(options.receipts ?? true);
  const factoryAdapter = createProcessAdapter({ runtimeId: "process",
    command: [process.execPath, childPath, "{{workspace_root}}", "{{context_pack_path}}", options.mode ?? "completed"],
    allowedRoots: [source, base], ...(options.artifact ? { artifacts: [{ path: "new.bin", type: "file" as const }] } : {}), ...(options.contextFilename ? { contextPackFilename: options.contextFilename } : {}) });
  const actualAdapter = options.adapter ?? (options.copiedAdapter ? { ...factoryAdapter } : factoryAdapter);
  const workspace = { worktreeBaseRepo: source, allowedRoots: [source, base] };
  const ownedGit = { gitExecutable: "/usr/bin/git", readTimeoutMs: 10000, materializeTimeoutMs: 60000,
    terminationTimeoutMs: 5000, environment: { ...process.env } };
  const legacyGitCalls: string[][] = [];
  const location = { directory: join(root, "journal"), controllerScope: "live-fixture", nodeId: "computer_physical" };
  const provisioned = await provisionLocalJournal(location);
  const journalOptions = { ...location, expectedNamespace: provisioned.namespace };
  const journal = await openLocalJournal(journalOptions);
  const nodeJournal: Journal = { ...journal,
    claimNextLiveDelivery: async (...args) => {
      const claim = await journal.claimNextLiveDelivery(...args);
      // Observe a real committed claim; only its return to the coordinator is held.
      await options.afterLiveClaim?.(claim);
      return claim;
    },
    recordStarted: async (...args) => { await options.beforeRecordStarted?.(root); const result = await journal.recordStarted(...args); await options.afterRecordStarted?.(root); return result; },
    settleOwnedProcess: async (...args) => { await options.beforeSettlement?.(); return journal.settleOwnedProcess(...args); },
  };
  const exposed: Array<{ message: NodeToServerMessage; at: string; processes?: ProcessBoundarySnapshot }> = [];
  let receiverHold: ((frame: NodeToServerMessage) => boolean) | undefined;
  let receiverReject: ((frame: NodeToServerMessage) => boolean) | undefined;
  let failOnce: ((frame: NodeToServerMessage) => boolean) | undefined;
  const held: Array<{ frame: NodeToServerMessage; resolve(value: "accepted" | "rejected"): void }> = [];
  // Local session fixture for the adapted live20 regression only. This is not
  // network handshake/liveness evidence; the separate WS cases use the factory.
  const fixtureSession = Object.freeze({ namespace: journal.namespace, nodeId: "computer_physical",
    generation: 1, sessionId: "fixture-session", helloNonce: "fixture-nonce" });
  const managedChannel: ManagedEventChannel = {
    assertCurrentSession(expected) { if (expected && expected !== fixtureSession) throw new Error("Fixture session changed"); return fixtureSession; },
    async waitUntilUsable(deadline, signal) { signal.throwIfAborted(); if (monotonicMs() >= deadline) throw new DeliveryDeadline("Fixture original deadline expired"); return fixtureSession; },
    async exposeOnce(frame) {
    const snapshot = structuredClone(frame);
    // Explicit fixture receiver only: one observation per exposure, no replay.
    const observed = channel.exposeOnly(snapshot); exposed.push({ message: snapshot, at: observed.at, processes: observed.processes });
    // Explicit receiver timing fixture: ensure the real program reached its
    // ready marker before rejecting a startup receipt. No execution proof is
    // manufactured, and exposure still records the actual earlier boundary.
    if (snapshot.event.type === "run.lifecycle" && snapshot.event.payload.phase === "started") {
      await eventually(() => records().some((record) => existsSync(join(record.rawRoot, "ready"))));
    }
    if (failOnce?.(snapshot)) {
      failOnce = undefined;
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("fixture transport failed after possible exposure");
    }
    if (receiverReject?.(snapshot)) return "rejected";
    if (receiverHold?.(snapshot)) return new Promise((resolve) => held.push({ frame: snapshot, resolve(status) {
      if (status === "accepted") channel.acceptManaged(snapshot); resolve(status);
    } }));
    channel.acceptManaged(snapshot); return "accepted";
  } };
  const client = createNodeClient({ nodeId: "computer_physical", transport: channel.transport, adapter: actualAdapter,
    workspace: options.missingWorkspace ? {} : workspace, ownedGit, managedJournal: { journal: nodeJournal, channel: managedChannel },
    ...(options.uploadArtifact ? { uploadArtifact: options.uploadArtifact } : {}),
    git: { async run(args) { legacyGitCalls.push([...args]); throw new Error("Physical mode used the forbidden legacy executor"); } } });
  client.start();
  const lifetimes: Lifetime[] = [], runtimePids = new Set<number>();
  channel.observeSends(() => ({ at: new Date().toISOString(), owned: lifetimes.filter((row) => row.pid !== undefined)
    .map((row) => ({ role: row.role, pid: row.pid!, exitObserved: Boolean(row.exitedAt),
      stdioCloseObserved: Boolean(row.closedAt), childAbsent: absent(row.pid!), groupAbsent: absent(-row.pid!),
      status: row.status, signal: row.signal })) }));
  let observeAction: SpawnObservation | undefined;
  let expectedShutdownUncertainty = false;
  const records = () => existsSync(launchPath) ? readFileSync(launchPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    pid: number; cwd: string; rawRoot: string; contextPath: string; contextSha256: string;
  }) : [];
  const observe: SpawnObservation = (command, args, spawnOptions, child) => {
    const cwd = typeof spawnOptions?.cwd === "string" ? spawnOptions.cwd : undefined;
    const role: Lifetime["role"] | undefined = command === "/usr/bin/git" && cwd?.startsWith(root + "/") ? "git"
      : command === process.execPath && args[0] === childPath ? "cli"
      : command === process.execPath && args[0] === "-e" && args[1]?.includes("let disarmed=false")
        && runtimePids.has(Number(args[2])) ? "guardian" : undefined;
    if (!role) return;
    if (role === "cli" && child.pid !== undefined) runtimePids.add(child.pid);
    const row: Lifetime = { role, pid: child.pid, args: [...args], cwd }; lifetimes.push(row);
    child.once("spawn", () => { row.spawnedAt = new Date().toISOString(); });
    child.once("exit", () => { row.exitedAt = new Date().toISOString(); });
    child.once("close", (status, signal) => {
      row.closedAt = new Date().toISOString(); row.status = status; row.signal = signal;
      if (row.pid && absent(-row.pid)) row.groupAbsentAt = new Date().toISOString();
    });
    observeAction?.(command, args, spawnOptions, child);
  };
  const payload = (suffix: string): RunStartPayload => {
    const runId = `run_${suffix}`, taskId = `task_${suffix}`, basePath = `${base}//`;
    const allocated = allocateWorkspaceRoot({ workspaceRoot: null, branchBacked: true, targetComputerOs: process.platform,
      agentInstanceId: "ai_physical", runId, worktreeBase: { version: 1, strategy: "per-run", basePath } })!;
    return { run_id: runId, task_id: taskId, agent_instance_id: "ai_physical", runtime: "process",
      workspace: { root: allocated, branch: `user/jiaxie/physical-${suffix}` },
      workspace_allocation: { version: 1, strategy: "per-run", base_path: basePath }, workspace_retention_reporting: "typed-v1",
      context_pack: { id: `ctx_${suffix}`, payload: {
        task: { id: taskId, title: "Node physical fixture", description: "Keep this admitted instruction", acceptance_criteria: ["one owned writer"] },
        project: { id: "project_physical", name: "Physical fixture", default_workspace: null },
        workspace: { root: allocated, file_scope: ["tracked.bin"] },
        policy: { filesystem_write_scope: ["tracked.bin"], requires_approval: [] },
        memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      } }, policy_snapshot: { filesystem_write_scope: [allocated], requires_approval: [] }, artifact_rules: { paths: [] } };
  };
  return { root, source, base, sourceHead, childPath, channel, client, workspace, ownedGit, actualAdapter,
    journal, nodeJournal, journalOptions, exposed, held, managedChannel,
    failManagedOnce(predicate: (frame: NodeToServerMessage) => boolean) { failOnce = predicate; },
    holdManaged(predicate?: (frame: NodeToServerMessage) => boolean) { receiverHold = predicate; },
    rejectManaged(predicate?: (frame: NodeToServerMessage) => boolean) { receiverReject = predicate; },
    releaseManaged(status: "accepted" | "rejected" = "accepted") { receiverHold = undefined; for (const item of held.splice(0)) item.resolve(status); },
    legacyGitCalls, lifetimes, records, observe, payload,
    onSpawn(action?: SpawnObservation) { observeAction = action; },
    expectShutdownUncertainty() { expectedShutdownUncertainty = true; },
    start(id: string, value: RunStartPayload) { channel.emit({ kind: "command", id, idempotency_key: `${value.run_id}:start`, type: "run.start", payload: value }); },
    stop(id: string, runId: string) { channel.emit({ kind: "command", id, idempotency_key: id, type: "run.stop", payload: { run_id: runId, reason: "user_cancelled" } }); },
    resume(id: string, runId: string) { channel.emit({ kind: "command", id, idempotency_key: id, type: "run.resume", payload: { run_id: runId } }); },
    release(value: RunStartPayload) { writeFileSync(join(value.workspace.root, "release"), "release fixture"); },
    assertSource() { assert.equal(git(source, "rev-parse", "HEAD"), sourceHead); assert.equal(git(source, "status", "--porcelain"), ""); },
    async finishDelivery() { await client.stop(false); client.start(); },
    async close(remove: boolean) {
      observeAction = undefined;
      receiverHold = undefined; for (const item of held.splice(0)) item.resolve("accepted");
      channel.release();
      let shutdownError: unknown;
      try { await client.stop(true); } catch (error) { shutdownError = error; }
      await channel.transport.close!();
      await journal.close();
      try {
        await eventually(() => lifetimes.every((row) => {
          if (!row.pid) return true;
          if (!row.groupAbsentAt && absent(-row.pid)) row.groupAbsentAt = new Date().toISOString();
          return Boolean(row.closedAt && row.groupAbsentAt && absent(row.pid));
        }), 10000);
      } catch (error) {
        observations.push({ case: "fixture-cleanup", root, removed: false, cleanupUncertain: true, lifetimes });
        throw error;
      }
      if (shutdownError && !expectedShutdownUncertainty) {
        observations.push({ case: "fixture-cleanup", root, removed: false, shutdownError: String(shutdownError), lifetimes });
        throw shutdownError;
      }
      this.assertSource();
      assert.equal(identity(root), rootIdentity); assert.equal(readFileSync(join(root, ".fixture-owner"), "utf8"), marker);
      observations.push({ case: "fixture-cleanup", root, removed: remove, knownGroupsAbsent: true,
        shutdownUncertaintyExpected: expectedShutdownUncertainty, shutdownError: shutdownError ? String(shutdownError) : null,
        lifetimes, commands: channel.commands, messages: channel.sent, committed: channel.committed, exposed, journalOptions, journalClosed: true, sourceUnchanged: true, launches: records(), expectedWriters: options.expectedWriters ?? 1, expectProgramLaunch: options.expectProgramLaunch ?? (options.expectedWriters !== 0) });
      if (remove) { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
    },
  };
}
