import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { agentRuntimes, contextPacks, eventLog, runEventIngest, runs, tasks } from "../../../packages/db/dist/index.js";
import { eq } from "drizzle-orm";
import { RunStartPayloadSchema, type RunStartPayload } from "../../../packages/domain/dist/index.js";
import type { NodeHeartbeat } from "../../../packages/protocol/dist/index.js";
import { createManagedNodeRunner, type ManagedNodeRunner } from "../../../apps/artood/dist/managed/managed-node-runner.js";
import { openLocalJournal, provisionLocalJournal, type Journal, type JournalRun } from "../../../apps/artood/dist/managed/journal.js";
import { createProcessAdapter } from "../../../apps/artood/dist/process-adapter.js";
import type { ArtifactUploader } from "../../../apps/artood/dist/artifact-upload.js";
import { absent, git, ignoredBytes, modifiedBytes, newBytes, originalBytes, type Lifetime, type SpawnObservation } from "./live.fixture.js";
import { authenticatedReceiver, closeSetupResources, hello, privateProxy, until } from "./ws-network.fixture.js";

export const writerObservations: unknown[] = [];
export interface OutboxRow { sequence: number; event_id: string; content_json: string; content_sha256: string; committed: number;
  attempts_json: string; role: string; deadline_tick_ms: number | null; clock_id: string | null; superseded: number }
export interface WriterOptions { silent?: boolean; artifact?: boolean; uploadArtifact?: ArtifactUploader;
  afterRecordStarted?: () => Promise<void>; WebSocketImpl?: typeof WebSocket; heartbeatIntervalMs?: number }

/** Creates assets, actual server, canonical process adapter, journal and real WS
 * runner. It never supplies a synthetic start payload, receipt or closure. */
export async function managedWriterFixture(options: WriterOptions = {}) {
  if (!tmpdir().startsWith("/private/tmp/artoo-ws-journal-validation-") || !existsSync(join(tmpdir(), ".validation-owner")) || !process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR) throw new Error("Use reviewed owned WS harness");
  assert.equal(process.platform, "darwin"); assert.equal(process.version, "v24.19.0");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-managed-writer-")));
  const owner = randomUUID(), ownerStat = lstatSync(root, { bigint: true });
  writeFileSync(join(root, ".fixture-owner"), owner);
  const setupResources: Array<{ name: string; close(): Promise<void> }> = [];
  try {
  const source = join(root, "source"), base = join(root, "base"), childPath = join(root, "child.cjs"), launchPath = join(root, "launches.jsonl");
  mkdirSync(source); mkdirSync(base);
  git(source, "init", "--initial-branch=main"); git(source, "config", "user.name", "Managed WebSocket fixture");
  git(source, "config", "user.email", "managed-fixture@example.invalid"); git(source, "config", "commit.gpgsign", "false");
  writeFileSync(join(source, "tracked.bin"), originalBytes); writeFileSync(join(source, ".gitignore"), "ignored.bin\n");
  git(source, "add", "."); git(source, "commit", "-m", "Owned managed WebSocket source"); const sourceHead = git(source, "rev-parse", "HEAD");
  writeFileSync(childPath, `
const fs=require('node:fs'),crypto=require('node:crypto');
const [rawRoot,contextPath]=process.argv.slice(2),context=fs.readFileSync(contextPath);
fs.appendFileSync(${JSON.stringify(launchPath)},JSON.stringify({pid:process.pid,cwd:process.cwd(),rawRoot,contextPath,contextSha256:crypto.createHash('sha256').update(context).digest('hex')})+'\\n');
if(!fs.readFileSync('tracked.bin').equals(Buffer.from('${originalBytes.toString("base64")}','base64')))process.exit(44);
fs.writeFileSync('tracked.bin',Buffer.from('${modifiedBytes.toString("base64")}','base64'));
fs.writeFileSync('new.bin',Buffer.from('${newBytes.toString("base64")}','base64'));
fs.writeFileSync('ignored.bin',Buffer.from('${ignoredBytes.toString("base64")}','base64'));
${options.silent ? "" : `console.log(JSON.stringify({type:'run.lifecycle',payload:{phase:'completed'}}));
console.log(JSON.stringify({type:'run.workspace.retained',payload:{outcome:'completed'}}));
console.log(JSON.stringify({type:'run.answer',payload:{text:'fixture final answer'}}));
console.log(JSON.stringify({type:'run.usage',payload:{input_tokens:11,output_tokens:7,provider_session_id:'fixture-session'}}));`}
fs.writeFileSync('ready','actual owned writer ready');let count=0;
setInterval(()=>{fs.writeFileSync('alive',String(++count));if(fs.existsSync('release'))process.exit(0)},25);
setTimeout(()=>process.exit(91),120000);
`);
  const receiver = await authenticatedReceiver(source);
  setupResources.push({ name: "authenticated-receiver", close: () => receiver.close() });
  const proxy = await privateProxy(receiver.nodeUrl);
  setupResources.push({ name: "private-proxy", close: () => proxy.close() });
  const location = { directory: join(root, "journal"), controllerScope: "managed-ws-fixture", nodeId: receiver.nodeId };
  const provisioned = await provisionLocalJournal(location), journalOptions = { ...location, expectedNamespace: provisioned.namespace };
  let journal = await openLocalJournal(journalOptions), activeJournal: Journal = journal;
  setupResources.push({ name: "journal-worker", close: () => journal.close() });
  const nodeJournal: Journal = { ...journal, recordStarted: async (...args) => { const result = await journal.recordStarted(...args); await options.afterRecordStarted?.(); return result; } };
  const adapter = createProcessAdapter({ runtimeId: "process", command: [process.execPath, childPath, "{{workspace_root}}", "{{context_pack_path}}"],
    allowedRoots: [source, base], ...(options.artifact ? { artifacts: [{ type: "file" as const, path: "new.bin" }] } : {}) });
  const workspace = { worktreeBaseRepo: source, allowedRoots: [source, base] };
  const ownedGit = { gitExecutable: "/usr/bin/git", readTimeoutMs: 10000, materializeTimeoutMs: 60000, terminationTimeoutMs: 5000, environment: { ...process.env } };
  let heartbeatSequence = 0;
  const heartbeat = (): NodeHeartbeat => ({ kind: "node.heartbeat", node_id: receiver.nodeId, sequence: heartbeatSequence++,
    resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 20 }, runtimes: [{ runtime: "process", status: "available", capabilities: ["code.modify"] }], running_instances: [] });
  const makeRunner = (value: Journal) => createManagedNodeRunner({ url: proxy.url, hello: hello(receiver.nodeId), journal: value,
    adapter, workspace, ownedGit, heartbeat, heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10000, reconnectDelayMs: 50,
    ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}), ...(options.uploadArtifact ? { uploadArtifact: options.uploadArtifact } : {}) });
  let runner = makeRunner(nodeJournal), payload: RunStartPayload | undefined, taskId: string | undefined;
  setupResources.push({ name: "unstarted-managed-runner", close: () => runner.stop() });
  const allRunners: ManagedNodeRunner[] = [runner], lifetimes: Lifetime[] = [], runtimePids = new Set<number>();
  const launches = () => existsSync(launchPath) ? readFileSync(launchPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; cwd: string; rawRoot: string; contextPath: string; contextSha256: string }) : [];
  const physical = () => lifetimes.filter((row) => row.pid !== undefined).map((row) => ({ role: row.role, pid: row.pid!, exitObserved: Boolean(row.exitedAt),
    stdioCloseObserved: Boolean(row.closedAt), childAbsent: absent(row.pid!), groupAbsent: absent(-row.pid!) }));
  proxy.observePhysical(physical);
  const observe: SpawnObservation = (command, args, spawnOptions, child) => {
    const cwd = typeof spawnOptions?.cwd === "string" ? spawnOptions.cwd : undefined;
    const role = command === "/usr/bin/git" && cwd?.startsWith(root + "/") ? "git"
      : command === process.execPath && args[0] === childPath ? "cli"
      : command === process.execPath && args[0] === "-e" && args[1]?.includes("let disarmed=false") && runtimePids.has(Number(args[2])) ? "guardian" : undefined;
    if (!role) return; if (role === "cli" && child.pid) runtimePids.add(child.pid);
    const row: Lifetime = { role, pid: child.pid, args: [...args], cwd }; lifetimes.push(row);
    child.once("spawn", () => { row.spawnedAt = new Date().toISOString(); }); child.once("exit", () => { row.exitedAt = new Date().toISOString(); });
    child.once("close", (status, signal) => { row.closedAt = new Date().toISOString(); row.status = status; row.signal = signal;
      if (row.pid && absent(-row.pid)) row.groupAbsentAt = new Date().toISOString(); });
  };
  const query = () => { if (!payload) throw new Error("No actual dispatched start captured"); return { expectedNamespace: journal.namespace, runId: payload.run_id }; };
  const rows = (): OutboxRow[] => {
    const db = new DatabaseSync(join(location.directory, "journal.sqlite"), { readOnly: true, allowExtension: false });
    try { db.exec("PRAGMA busy_timeout=500"); return db.prepare("SELECT sequence,event_id,content_json,content_sha256,committed,attempts_json,role,deadline_tick_ms,clock_id,superseded FROM outbox WHERE namespace=? AND run_id=? ORDER BY sequence").all(journal.namespace, query().runId) as unknown as OutboxRow[]; }
    finally { db.close(); }
  };
  return { root, source, base, sourceHead, receiver, proxy, adapter, workspace, ownedGit, lifetimes, launches, physical, observe, rows, query, journalOptions,
    get runner() { return runner; }, get journal() { return journal; }, get payload() { if (!payload) throw new Error("No real dispatched payload"); return payload; },
    async begin() {
      await runner.start();
      await until(async () => (await receiver.server.db.db.select().from(agentRuntimes).where(eq(agentRuntimes.computerId, receiver.nodeId))).some((row) => row.runtime === "process" && row.status === "available"), "actual advertised process runtime");
      const configured = await receiver.request("POST", `/api/v1/computers/${receiver.nodeId}/instances`, { runtime: "process", workspace_root: source, display_name: "Managed test executor" });
      assert.equal(configured.status, 201); const instance = (await configured.json() as any).agent_instance.id as string;
      const allocation = await receiver.request("PATCH", `/api/v1/agent-instances/${instance}/worktree-workspace-base`, { version: 1, strategy: "per-run", basePath: base }); assert.equal(allocation.status, 200);
      const created = await receiver.request("POST", "/api/v1/tasks", { project_id: "proj_artoo", title: "Managed actual writer", description: "Keep the actual admitted instruction", acceptance_criteria: ["one owned writer"], required_capabilities: ["code.modify"] });
      assert.equal(created.status, 201); taskId = (await created.json() as any).task.id;
      assert.equal((await receiver.request("POST", `/api/v1/tasks/${taskId}/ready`)).status, 200);
      const assigned = await receiver.request("POST", `/api/v1/tasks/${taskId}/assign`, { mode: "manual", agent_instance_id: instance, branch_backed: true }); assert.equal(assigned.status, 200);
      const persistedRun = (await assigned.json() as any).run;
      await until(() => proxy.records.some((row) => row.direction === "down" && row.frame.type === "run.start" && row.frame.payload.run_id === persistedRun.id), "actual NodeBinding run.start");
      const dispatched = proxy.records.find((row) => row.direction === "down" && row.frame.type === "run.start" && row.frame.payload.run_id === persistedRun.id)!;
      payload = RunStartPayloadSchema.parse(dispatched.frame.payload);
      const [run] = await receiver.server.db.db.select().from(runs).where(eq(runs.id, payload.run_id));
      const [pack] = await receiver.server.db.db.select().from(contextPacks).where(eq(contextPacks.runId, payload.run_id));
      assert.equal(payload.workspace.root, run!.workspaceRoot); assert.equal(payload.workspace.branch, run!.workspaceBranch);
      assert.deepEqual(payload.workspace_allocation, run!.workspaceAllocation); assert.deepEqual(payload.context_pack.payload, pack!.payload);
      return payload;
    },
    async writerReady() { await until(() => launches().some((record) => existsSync(join(record.rawRoot, "ready"))), "genuine child program entry", 45000); assert.equal(launches().length, 1); assert.equal(absent(launches()[0]!.pid), false); },
    release() { const record = launches()[0]; if (!record) throw new Error("No actual child program entry"); writeFileSync(join(record.rawRoot, "release"), "release actual child"); },
    async closed(): Promise<JournalRun> { await until(async () => (await activeJournal.lookupRun(query()))?.phase === "closed", "genuine physical journal closure", 45000); return (await activeJournal.lookupRun(query()))!; },
    async delivered() { await until(() => rows().length > 0 && rows().every((row) => row.committed === 1 || row.superseded === 1), "durable receipts", 45000); },
    async snapshot() { return { run: (await receiver.server.db.db.select().from(runs).where(eq(runs.id, query().runId)))[0],
      task: (await receiver.server.db.db.select().from(tasks).where(eq(tasks.id, taskId!)))[0],
      receipts: await receiver.server.db.db.select().from(runEventIngest).where(eq(runEventIngest.runId, query().runId)),
      events: await receiver.server.db.db.select().from(eventLog).where(eq(eventLog.runId, query().runId)) }; },
    async reopenClosed() {
      assert.equal((await journal.lookupRun(query()))?.phase, "closed"); await runner.stop(); await journal.close();
      journal = await openLocalJournal(journalOptions); activeJournal = journal; runner = makeRunner(journal); allRunners.push(runner); await runner.start();
      // Re-dispatch is the actual registered binding's DB-backed historical path.
      await receiver.server.nodeRegistry.get(receiver.nodeId)!.dispatchRunResume(query().runId);
    },
    async reopenUnknown() {
      // The caller already closed the actual worker while its writer was live.
      // Original Node still owns and must stop that captured writer. It cannot
      // manufacture a durable terminal after losing its storage worker.
      await runner.stop();
      journal = await openLocalJournal(journalOptions); activeJournal = journal;
      const stored = await journal.lookupRun(query());
      assert.equal(stored?.phase, "started"); assert.equal(stored.ownership, "unknown"); assert.equal(stored.finalOutcomeJson, null);
      runner = makeRunner(journal); allRunners.push(runner); await runner.start();
      await receiver.server.nodeRegistry.get(receiver.nodeId)!.dispatchRunResume(query().runId);
      return stored;
    },
    async close(remove: boolean) {
      const failures: unknown[] = [];
      proxy.setPolicy();
      for (const owned of allRunners) try { await owned.stop(); } catch (error) { failures.push(error); }
      try { await proxy.close(); } catch (error) { failures.push(error); }
      try { await journal.close(); } catch (error) { failures.push(error); }
      try { await receiver.close(); } catch (error) { failures.push(error); }
      try { await until(() => lifetimes.every((row) => { if (!row.pid) return true; if (!row.groupAbsentAt && absent(-row.pid)) row.groupAbsentAt = new Date().toISOString(); return Boolean(row.closedAt && row.groupAbsentAt && absent(row.pid)); }), "all owned CLI/guardian/Git groups absent", 10000); } catch (error) { failures.push(error); }
      assert.equal(git(source, "rev-parse", "HEAD"), sourceHead); assert.equal(git(source, "status", "--porcelain"), "");
      const finalStat = lstatSync(root, { bigint: true }); assert.equal(`${finalStat.dev}:${finalStat.ino}`, `${ownerStat.dev}:${ownerStat.ino}`); assert.equal(readFileSync(join(root, ".fixture-owner"), "utf8"), owner);
      writerObservations.push({ case: "writer-fixture-cleanup", root, removed: remove && failures.length === 0, lifetimes, launches: launches(), physical: physical(),
        routes: receiver.routes, wire: proxy.records, failures: failures.map(String), expectedWriters: 1, journalClosed: failures.length === 0, sourceUnchanged: true,
        fixtureScope: "Real HTTP/session/device/configuration/assignment, real qualified receiver and canonical process authority; local fake OIDC and explicitly injected network timing/upload only" });
      if (failures.length) throw new AggregateError(failures, "Managed fixture cleanup failed; artifacts preserved");
      assert.equal(lifetimes.filter((row) => row.role === "cli").length, 1); assert.equal(lifetimes.filter((row) => row.role === "guardian").length, 1); assert.equal(launches().length, 1);
      if (remove) { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
    } };
  } catch (error) {
    const cleanup = await closeSetupResources(setupResources);
    writerObservations.push({ case: "writer-fixture-setup-failure", root, removed: false, setupFailure: String(error),
      runnerStarted: false, acquiredResourceCleanup: cleanup,
      scope: "Fixture construction failed before begin/run dispatch. Owned files are retained; only acquired resource closures are reported." });
    throw new Error(`Managed writer fixture setup failed; retained ${root}; acquired-resource cleanup: ${JSON.stringify(cleanup)}`, { cause: error });
  }
}
