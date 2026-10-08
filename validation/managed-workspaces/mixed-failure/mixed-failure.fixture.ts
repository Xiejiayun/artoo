import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { agentRuntimes, contextPacks, runs } from "../../../packages/db/dist/index.js";
import { RunStartPayloadSchema } from "../../../packages/domain/dist/index.js";
import type { NodeHeartbeat, RunStartCommand } from "../../../packages/protocol/dist/index.js";
import { createManagedBootstrap } from "../../../apps/artood/dist/managed/managed-bootstrap.js";
import { provisionLocalJournal } from "../../../apps/artood/dist/managed/journal.js";
import { createProcessAdapter } from "../../../apps/artood/dist/process-adapter.js";
import { absent, git, originalBytes, modifiedBytes, type Lifetime, type SpawnObservation } from "../managed/live.fixture.js";
import { authenticatedReceiver, closeSetupResources, hello, privateProxy, until } from "../managed/ws-network.fixture.js";

export const failureObservations: Record<string, unknown>[] = [];
export const stamp = () => ({ at: new Date().toISOString(), tick: performance.now() });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function causes(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(causes)] : [error];
}
export function errorEvidence(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  return { name: error.name, message: error.message, ...(error instanceof AggregateError ? { errors: error.errors.map(errorEvidence) } : {}) };
}
interface Entry { runId: string; pid: number; cwd: string; rawRoot: string; contextSha256: string }
export interface SelectedRun { allocated: boolean; command: RunStartCommand; wireText: string; wireSha256: string }

/** Real bootstrap owns the only opened journal, runner and socket. The fixture
 * never obtains a Journal handle or substitutes a product lifecycle owner. */
export async function mixedFailureFixture(id: "F01" | "F02") {
  if (!tmpdir().startsWith("/private/tmp/artoo-ws-journal-validation-") || !existsSync(join(tmpdir(), ".validation-owner"))
    || !process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR) throw new Error("Use the reviewed owned mixed-failure harness");
  assert.equal(process.platform, "darwin"); assert.equal(process.version, "v24.19.0");
  const active = id === "F02", expectedWriters = active ? 2 : 0;
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-mixed-failure-")));
  const owner = randomUUID(), ownerStat = lstatSync(root, { bigint: true });
  writeFileSync(join(root, ".fixture-owner"), owner);
  const acquired: Array<{ name: string; close(): Promise<void> }> = [];
  try {
    const source = join(root, "source"), ordinary = join(root, "ordinary"), base = join(root, "base"), controls = join(root, "controls");
    const program = join(root, "held-provider.cjs"), entriesPath = join(root, "entries.jsonl");
    for (const path of [source, ordinary, base, controls]) mkdirSync(path);
    git(source, "init", "--initial-branch=main"); git(source, "config", "user.name", "Mixed failure fixture");
    git(source, "config", "user.email", "mixed-failure@example.invalid"); git(source, "config", "commit.gpgsign", "false");
    writeFileSync(join(source, "tracked.bin"), originalBytes); git(source, "add", "tracked.bin"); git(source, "commit", "-m", "Owned failure source");
    const sourceHead = git(source, "rev-parse", "HEAD");
    // An explicit held local provider, not a live model. Tests never create its
    // release files. Its safety exit is later than the unchanged 90s case bound.
    writeFileSync(program, `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [rawRoot,contextPath]=process.argv.slice(2),context=fs.readFileSync(contextPath);
const runId=/^run: (.+)$/m.exec(context.toString())?.[1];if(!/^run_[A-Za-z0-9_-]+$/.test(runId||''))process.exit(43);
fs.appendFileSync(${JSON.stringify(entriesPath)},JSON.stringify({runId,pid:process.pid,cwd:process.cwd(),rawRoot,contextSha256:crypto.createHash('sha256').update(context).digest('hex')})+'\\n');
fs.writeFileSync(path.join(${JSON.stringify(controls)},runId+'.context'),context);
if(rawRoot.startsWith(${JSON.stringify(base + "/")})){
  if(!fs.readFileSync('tracked.bin').equals(Buffer.from('${originalBytes.toString("base64")}','base64')))process.exit(44);
  fs.writeFileSync('tracked.bin',Buffer.from('${modifiedBytes.toString("base64")}','base64'));
}
console.log('actual held provider '+runId);
fs.writeFileSync(path.join(${JSON.stringify(controls)},runId+'.ready'),'actual entry');
setInterval(()=>{if(fs.existsSync(path.join(${JSON.stringify(controls)},runId+'.release')))process.exit(0)},10);
setTimeout(()=>process.exit(91),120000);
`);
    const receiver = await authenticatedReceiver(source); acquired.push({ name: "receiver", close: () => receiver.close() });
    const proxy = await privateProxy(receiver.nodeUrl); acquired.push({ name: "proxy", close: () => proxy.close() });
    const location = { directory: join(root, "journal"), controllerScope: "mixed-failure-fixture", nodeId: receiver.nodeId };
    const provisioned = await provisionLocalJournal(location);
    // Bootstrap validates this explicit transparent loopback endpoint/profile.
    const endpoint = new URL("/api/v1/node", proxy.url), origin = new URL(endpoint); origin.protocol = "http:";
    const binding = { version: 1 as const, ...location, serverOrigin: origin.origin, expectedNamespace: provisioned.namespace };
    const adapter = createProcessAdapter({ runtimeId: "process", command: [process.execPath, program, "{{workspace_root}}", "{{context_pack_path}}"], allowedRoots: [source, ordinary, base] });
    let sequence = 0;
    const heartbeat = (): NodeHeartbeat => ({ kind: "node.heartbeat", node_id: receiver.nodeId, sequence: sequence++,
      resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 20 }, runtimes: [{ runtime: "process", status: "available", capabilities: ["code.modify", "code.read"] }], running_instances: [] });
    const workspace = { allowedRoots: [source, ordinary, base], ...(active ? { worktreeBaseRepo: source } : {}) };
    const node = createManagedBootstrap({ url: endpoint.href, hello: hello(receiver.nodeId), binding, allowNewAllocations: active,
      adapter, workspace, heartbeat, heartbeatIntervalMs: 10000, reconnectDelayMs: 50,
      ownedGit: { gitExecutable: "/usr/bin/git", readTimeoutMs: 10000, materializeTimeoutMs: 60000, terminationTimeoutMs: 5000, environment: { ...process.env } } });
    acquired.push({ name: "unstarted-bootstrap", close: () => node.stop() });
    const evidence: Record<string, unknown> = { case: "mixed-failure-cleanup", id, root, expectedWriters, allowNewAllocations: active,
      hasBaseRepository: "worktreeBaseRepo" in workspace, namespace: provisioned.namespace, photos: [], removed: false };
    let failure: Error | undefined, joinedFailure: unknown;
    void node.failed.then((error) => { failure = error; evidence.failureObserved = { ...stamp(), error: errorEvidence(error) }; });
    const lifetimes: Lifetime[] = [], runtimePids = new Set<number>(), selected: SelectedRun[] = [];
    const entries = (): Entry[] => existsSync(entriesPath) ? readFileSync(entriesPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];
    const physical = () => lifetimes.filter((row) => row.pid !== undefined).map((row) => {
      const cliPid = row.role === "guardian" ? Number(row.args[2]) : row.pid;
      const childAbsent = absent(row.pid!), groupAbsent = absent(-row.pid!);
      if (row.closedAt && groupAbsent) row.groupAbsentAt ??= new Date().toISOString();
      return { role: row.role, pid: row.pid!, runId: entries().find((entry) => entry.pid === cliPid)?.runId,
        exitObserved: Boolean(row.exitedAt), stdioCloseObserved: Boolean(row.closedAt), childAbsent, groupAbsent };
    });
    const observe: SpawnObservation = (executable, args, options, child) => {
      const cwd = typeof options?.cwd === "string" ? options.cwd : undefined;
      const role = executable === "/usr/bin/git" && cwd?.startsWith(root + "/") ? "git" : executable === process.execPath && args[0] === program ? "cli"
        : executable === process.execPath && args[0] === "-e" && args[1]?.includes("let disarmed=false") && runtimePids.has(Number(args[2])) ? "guardian" : undefined;
      if (!role) return; if (role === "cli" && child.pid) runtimePids.add(child.pid);
      const row: Lifetime = { role, pid: child.pid, args: [...args], cwd }; lifetimes.push(row);
      child.once("spawn", () => { row.spawnedAt = new Date().toISOString(); }); child.once("exit", () => { row.exitedAt = new Date().toISOString(); });
      child.once("close", (status, signal) => { row.closedAt = new Date().toISOString(); row.status = status; row.signal = signal; });
    };
    proxy.observePhysical(physical);
    const storage = () => {
      const db = new DatabaseSync(join(location.directory, "journal.sqlite"), { readOnly: true, allowExtension: false });
      try { db.exec("PRAGMA busy_timeout=500"); return {
        runs: db.prepare("SELECT run_id,mode,phase,owner_incarnation,receipt_id,final_outcome_json FROM runs WHERE namespace=? ORDER BY run_id").all(provisioned.namespace),
        receipts: db.prepare("SELECT run_id,kind,content_json FROM receipts WHERE namespace=? ORDER BY run_id,id").all(provisioned.namespace),
        outbox: db.prepare("SELECT run_id,sequence,committed,role,content_json,content_sha256 FROM outbox WHERE namespace=? ORDER BY run_id,sequence").all(provisioned.namespace),
      }; } finally { db.close(); }
    };
    async function request(method: string, path: string, body?: unknown, status = 200): Promise<any> {
      const response = await receiver.request(method, path, body), result = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`); return result;
    }
    let ordinaryInstance = "", allocatedInstance = "";
    return { root, source, base, location, binding, node, proxy, receiver, workspace, evidence, observe, lifetimes, selected, entries, physical, storage,
      get failure() { return failure; },
      releasesAbsent() { return selected.every((run) => !existsSync(join(controls, run.command.payload.run_id + ".release"))); },
      async begin() {
        await node.start(); evidence.ready = stamp();
        await until(async () => (await receiver.server.db.db.select().from(agentRuntimes).where(eq(agentRuntimes.computerId, receiver.nodeId))).some((row) => row.runtime === "process" && row.status === "available"), "real bootstrap runtime heartbeat");
        if (active) {
          const instance = async (root: string, name: string) => (await request("POST", `/api/v1/computers/${receiver.nodeId}/instances`, { runtime: "process", workspace_root: root, display_name: name, capabilities: ["code.modify", "code.read"] }, 201)).agent_instance.id as string;
          ordinaryInstance = await instance(ordinary, "Failure ordinary"); allocatedInstance = await instance(source, "Failure allocated");
          await request("PATCH", `/api/v1/agent-instances/${allocatedInstance}/worktree-workspace-base`, { version: 1, strategy: "per-run", basePath: base });
        }
      },
      async taskRun(allocated: boolean): Promise<SelectedRun> {
        assert.equal(active, true);
        const task = await request("POST", "/api/v1/tasks", { project_id: "proj_artoo", title: allocated ? "Failure allocated" : "Failure ordinary",
          description: "A real held local provider", acceptance_criteria: ["one producer"], required_capabilities: ["code.modify"] }, 201);
        await request("POST", `/api/v1/tasks/${task.task.id}/ready`);
        const assigned = await request("POST", `/api/v1/tasks/${task.task.id}/assign`, { mode: "manual", agent_instance_id: allocated ? allocatedInstance : ordinaryInstance, branch_backed: allocated });
        const runId = assigned.run.id as string;
        await until(() => proxy.records.some((row) => row.direction === "down" && row.frame.type === "run.start" && row.frame.payload.run_id === runId), "real failure-fixture assignment", 45000);
        const wire = proxy.records.find((row) => row.direction === "down" && row.frame.type === "run.start" && row.frame.payload.run_id === runId)!;
        const command = { ...wire.frame, payload: RunStartPayloadSchema.parse(wire.frame.payload) } as RunStartCommand;
        const [saved] = await receiver.server.db.db.select().from(runs).where(eq(runs.id, runId));
        const [pack] = await receiver.server.db.db.select().from(contextPacks).where(eq(contextPacks.runId, runId));
        assert.equal(saved!.computerId, receiver.nodeId); assert.deepEqual(command.payload.workspace_allocation ?? null, saved!.workspaceAllocation);
        assert.deepEqual(command.payload.context_pack.payload, pack!.payload);
        const result = { allocated, command, wireText: wire.text, wireSha256: hash(wire.text) }; selected.push(result); return result;
      },
      async ready(run: SelectedRun) {
        const runId = run.command.payload.run_id;
        await until(() => entries().some((row) => row.runId === runId) && existsSync(join(controls, runId + ".ready")), "held provider program entry", 45000);
        await until(() => proxy.records.some((row) => row.direction === "up" && row.frame.kind === "command.ack" && row.frame.command_id === run.command.id), "real held provider startup ACK", 45000);
        assert.equal(proxy.records.find((row) => row.direction === "up" && row.frame.kind === "command.ack" && row.frame.command_id === run.command.id)!.frame.status, "accepted");
        const launched = entries().filter((row) => row.runId === runId); assert.equal(launched.length, 1);
        assert.equal(launched[0]!.contextSha256, hash(readFileSync(join(controls, runId + ".context"))));
        await until(() => physical().filter((row) => row.runId === runId).length === 2, "actual CLI and guardian observations");
      },
      async observeAutomaticClosure() {
        // No Stop call, release file, server Stop or receiver/proxy teardown has
        // happened: only the product's failed watcher may close these owners.
        await until(() => failure !== undefined && proxy.connections.length === 1
          && proxy.connections.every((row) => row.client.readyState === 3 && row.upstream.readyState === 3)
          && physical().every((row) => row.exitObserved && row.stdioCloseObserved && row.childAbsent && row.groupAbsent), "product automatic failure cleanup", 15000);
        evidence.automaticClosure = { ...stamp(), physical: physical(), connections: proxy.connections.length,
          sockets: proxy.connections.map((row) => ({ generation: row.generation, clientState: row.client.readyState, upstreamState: row.upstream.readyState })) };
      },
      async joinStop() {
        assert.ok(evidence.automaticClosure, "Observe automatic closure before explicitly joining Stop");
        assert.ok(failure); evidence.explicitStopJoin = stamp();
        try { await node.stop(); assert.fail("Fatal journal failure cannot become a successful Stop"); }
        catch (error) {
          assert.ok(causes(error).includes(failure), "Stop must preserve the original failed promise cause");
          const leaves = causes(error).filter((cause) => !(cause instanceof AggregateError));
          assert.ok(leaves.every((cause) => cause === failure || cause instanceof Error && [
            "Journal unavailable; no execution authority is granted", "Journal worker closed with code 1",
          ].includes(cause.message)), "An additional unrelated cleanup failure must not be accepted");
          joinedFailure = error; evidence.expectedStopFailure = errorEvidence(error);
        }
      },
      async close(remove: boolean) {
        const failures: unknown[] = []; const close = async (action: () => unknown | Promise<unknown>) => { try { await action(); } catch (error) { failures.push(error); } };
        await close(async () => { try { await node.stop(); } catch (error) { if (error !== joinedFailure || joinedFailure === undefined) throw error; } });
        await close(() => proxy.close()); await close(() => receiver.close());
        await close(() => until(() => physical().every((row) => row.exitObserved && row.stdioCloseObserved && row.childAbsent && row.groupAbsent), "all owned fixture processes closed", 10000));
        let sourceUnchanged = false;
        await close(() => { assert.equal(git(source, "rev-parse", "HEAD"), sourceHead); assert.equal(git(source, "status", "--porcelain"), ""); assert.deepEqual(readFileSync(join(source, "tracked.bin")), originalBytes); sourceUnchanged = true; });
        await close(() => { const now = lstatSync(root, { bigint: true }); assert.equal(`${now.dev}:${now.ino}`, `${ownerStat.dev}:${ownerStat.ino}`); assert.equal(readFileSync(join(root, ".fixture-owner"), "utf8"), owner); });
        await close(() => { assert.equal(entries().length, expectedWriters); assert.equal(lifetimes.filter((row) => row.role === "cli").length, expectedWriters); assert.equal(lifetimes.filter((row) => row.role === "guardian").length, expectedWriters); });
        Object.assign(evidence, { sourceUnchanged, entries: entries(), lifetimes, physical: physical(), selectedRuns: selected,
          routes: receiver.routes, wire: proxy.records, connectionCount: proxy.connections.length, cleanupFailures: failures.map(errorEvidence), photos: [] });
        failureObservations.push(evidence);
        if (failures.length) throw new AggregateError(failures, "Failure fixture cleanup is uncertain; files retained");
        if (remove) { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); evidence.removed = true; }
      },
    };
  } catch (error) {
    const cleanup = await closeSetupResources(acquired);
    failureObservations.push({ case: "mixed-failure-setup-failure", id, root, removed: false, error: errorEvidence(error), cleanup, photos: [] });
    throw new Error(`Mixed-failure setup failed; retained ${root}`, { cause: error });
  }
}
