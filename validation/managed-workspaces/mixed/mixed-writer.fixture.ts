import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { agentRuntimes, contextPacks, eventLog, runEventIngest, runs } from "../../../packages/db/dist/index.js";
import { RunStartPayloadSchema, type RunStartPayload } from "../../../packages/domain/dist/index.js";
import { allocateWorkspaceRoot, type CommandAck, type NodeHeartbeat, type RunStartCommand } from "../../../packages/protocol/dist/index.js";
import { createManagedNodeRunner, type ManagedNodeRunner } from "../../../apps/artood/dist/managed/managed-node-runner.js";
import { openLocalJournal, provisionLocalJournal, type Journal } from "../../../apps/artood/dist/managed/journal.js";
import { createProcessAdapter } from "../../../apps/artood/dist/process-adapter.js";
import { allocationStartBinding } from "../../../apps/artood/dist/node-allocation-identity.js";
import { createAssistantDispatcher } from "../../../apps/server/dist/services/assistant-service.js";
import { createDiscussionDispatcher } from "../../../apps/server/dist/services/discussion-service.js";
import { absent, git, originalBytes, modifiedBytes, type Lifetime, type SpawnObservation } from "../managed/live.fixture.js";
import { authenticatedReceiver, closeSetupResources, hello, privateProxy, until } from "../managed/ws-network.fixture.js";

export const mixedObservations: Record<string, unknown>[] = [];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
interface Entry { runId: string; pid: number; cwd: string; rawRoot: string; contextPath: string; contextSha256: string; discussionCommand: boolean }
export interface MixedRun { kind: "assistant" | "discussion-contribution" | "allocated-task" | "ordinary-task"; command: RunStartCommand; originalWireText: string; originalWireSha256: string; turnId?: string; roomId?: string; discussionId?: string; threadRootId?: string }
interface ReceiptRow { run_id: string; kind: string; content_json: string }
interface OutboxRow { run_id: string; sequence: number; committed: number; superseded: number; content_json: string; content_sha256: string; role: string }

/** One real authenticated receiver and one genuine mixed NodeClient per runner
 * incarnation. Only OIDC and provider text are local fixtures. */
export async function mixedWriterFixture(expectedWriters: number) {
  if (!tmpdir().startsWith("/private/tmp/artoo-ws-journal-validation-") || !existsSync(join(tmpdir(), ".validation-owner")) || !process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR) throw new Error("Use the reviewed owned mixed harness");
  assert.equal(process.platform, "darwin"); assert.equal(process.version, "v24.19.0");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-mixed-writer-")));
  const owner = randomUUID(), ownerStat = lstatSync(root, { bigint: true });
  writeFileSync(join(root, ".fixture-owner"), owner);
  const setupResources: Array<{ name: string; close(): Promise<void> }> = [];
  try {
    const source = join(root, "source"), base = join(root, "base"), ordinary = join(root, "ordinary"), controls = join(root, "controls");
    const childPath = join(root, "provider-fixture.cjs"), launchPath = join(root, "launches.jsonl");
    for (const path of [source, base, ordinary, controls]) mkdirSync(path);
    git(source, "init", "--initial-branch=main"); git(source, "config", "user.name", "Mixed writer fixture");
    git(source, "config", "user.email", "mixed-fixture@example.invalid"); git(source, "config", "commit.gpgsign", "false");
    writeFileSync(join(source, "tracked.bin"), originalBytes); git(source, "add", "tracked.bin"); git(source, "commit", "-m", "Owned mixed source");
    const sourceHead = git(source, "rev-parse", "HEAD");
    // Explicit local provider: deterministic answers are not live model evidence.
    // Discussion writes only task-owned evidence outside its workspace.
    writeFileSync(childPath, `
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const [rawRoot,contextPath,mode]=process.argv.slice(2),context=fs.readFileSync(contextPath);
const runId=/^run: (.+)$/m.exec(context.toString())?.[1];if(!/^run_[A-Za-z0-9_-]+$/.test(runId||''))process.exit(43);
fs.appendFileSync(${JSON.stringify(launchPath)},JSON.stringify({runId,pid:process.pid,cwd:process.cwd(),rawRoot,contextPath,contextSha256:crypto.createHash('sha256').update(context).digest('hex'),discussionCommand:mode==='discussion'})+'\\n');
fs.writeFileSync(path.join(${JSON.stringify(controls)},runId+'.context'),context);
if(rawRoot.startsWith(${JSON.stringify(base + "/")})){
  if(!fs.readFileSync('tracked.bin').equals(Buffer.from('${originalBytes.toString("base64")}','base64')))process.exit(44);
  fs.writeFileSync('tracked.bin',Buffer.from('${modifiedBytes.toString("base64")}','base64'));
}
console.log(JSON.stringify({type:'run.answer',payload:{text:'Local provider fixture answer for '+runId}}));
console.log(JSON.stringify({type:'run.usage',payload:{input_tokens:3,output_tokens:5,provider_session_id:'local-fixture-'+runId}}));
fs.writeFileSync(path.join(${JSON.stringify(controls)},runId+'.ready'),'actual entry');
setInterval(()=>{if(fs.existsSync(path.join(${JSON.stringify(controls)},runId+'.release')))process.exit(0)},10);
setTimeout(()=>process.exit(91),120000);
`);
    const receiver = await authenticatedReceiver(source);
    setupResources.push({ name: "authenticated-receiver", close: () => receiver.close() });
    const proxy = await privateProxy(receiver.nodeUrl);
    setupResources.push({ name: "private-proxy", close: () => proxy.close() });
    const location = { directory: join(root, "journal"), controllerScope: "mixed-writer-fixture", nodeId: receiver.nodeId };
    const provisioned = await provisionLocalJournal(location), journalOptions = { ...location, expectedNamespace: provisioned.namespace };
    let journal = await openLocalJournal(journalOptions);
    setupResources.push({ name: "journal-worker", close: () => journal.close() });
    const command = [process.execPath, childPath, "{{workspace_root}}", "{{context_pack_path}}"];
    const adapter = createProcessAdapter({ runtimeId: "process", command: [...command, "ordinary"], discussionCommand: [...command, "discussion"], allowedRoots: [source, base, ordinary] });
    let heartbeatSequence = 0;
    const heartbeat = (): NodeHeartbeat => ({ kind: "node.heartbeat", node_id: receiver.nodeId, sequence: heartbeatSequence++,
      resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 20 }, runtimes: [{ runtime: "process", status: "available", capabilities: ["code.modify", "code.read"] }], running_instances: [] });
    const makeRunner = (value: Journal) => createManagedNodeRunner({ url: proxy.url, hello: hello(receiver.nodeId), journal: value, adapter,
      mixed: { allowNewAllocations: true }, workspace: { worktreeBaseRepo: source, allowedRoots: [source, base, ordinary] },
      ownedGit: { gitExecutable: "/usr/bin/git", readTimeoutMs: 10000, materializeTimeoutMs: 60000, terminationTimeoutMs: 5000, environment: { ...process.env } },
      heartbeat, heartbeatIntervalMs: 10000, reconnectDelayMs: 50 });
    let runner = makeRunner(journal);
    const allRunners: ManagedNodeRunner[] = [runner], incarnations = [journal.incarnation];
    setupResources.push({ name: "unstarted-mixed-runner", close: () => runner.stop() });
    const dispatchErrors: unknown[] = [];
    const assistant = createAssistantDispatcher(receiver.server.ctx, (error) => { dispatchErrors.push(error); });
    const discussion = createDiscussionDispatcher(receiver.server.ctx, (_ctx, runId) => receiver.server.nodeRegistry.get(receiver.nodeId)!.dispatchRunStop(runId), (error) => { dispatchErrors.push(error); });
    setupResources.push({ name: "manual-assistant-dispatcher", close: () => assistant.stop() }, { name: "manual-discussion-dispatcher", close: () => discussion.stop() });
    const lifetimes: Lifetime[] = [], runtimePids = new Set<number>(), selectedRuns: MixedRun[] = [], injections: Record<string, unknown>[] = [];
    const launches = (): Entry[] => existsSync(launchPath) ? readFileSync(launchPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];
    const physical = () => lifetimes.filter((row) => row.pid !== undefined).map((row) => {
      const cliPid = row.role === "guardian" ? Number(row.args[2]) : row.pid;
      return { role: row.role, pid: row.pid!, runId: launches().find((entry) => entry.pid === cliPid)?.runId,
        exitObserved: Boolean(row.exitedAt), stdioCloseObserved: Boolean(row.closedAt), childAbsent: absent(row.pid!), groupAbsent: absent(-row.pid!) };
    });
    proxy.observePhysical(physical);
    const observe: SpawnObservation = (executable, args, options, child) => {
      const cwd = typeof options?.cwd === "string" ? options.cwd : undefined;
      const role = executable === "/usr/bin/git" && cwd?.startsWith(root + "/") ? "git" : executable === process.execPath && args[0] === childPath ? "cli"
        : executable === process.execPath && args[0] === "-e" && args[1]?.includes("let disarmed=false") && runtimePids.has(Number(args[2])) ? "guardian" : undefined;
      if (!role) return; if (role === "cli" && child.pid) runtimePids.add(child.pid);
      const row: Lifetime = { role, pid: child.pid, args: [...args], cwd }; lifetimes.push(row);
      child.once("spawn", () => { row.spawnedAt = new Date().toISOString(); }); child.once("exit", () => { row.exitedAt = new Date().toISOString(); });
      child.once("close", (status, signal) => { row.closedAt = new Date().toISOString(); row.status = status; row.signal = signal;
        if (row.pid && absent(-row.pid)) row.groupAbsentAt = new Date().toISOString(); });
    };
    const query = (runId: string) => ({ expectedNamespace: journal.namespace, runId });
    const storage = () => {
      const db = new DatabaseSync(join(location.directory, "journal.sqlite"), { readOnly: true, allowExtension: false });
      try { db.exec("PRAGMA busy_timeout=500"); return {
        receipts: db.prepare("SELECT run_id,kind,content_json FROM receipts WHERE namespace=? ORDER BY run_id,id").all(journal.namespace) as unknown as ReceiptRow[],
        outbox: db.prepare("SELECT run_id,sequence,committed,superseded,content_json,content_sha256,role FROM outbox WHERE namespace=? ORDER BY run_id,sequence").all(journal.namespace) as unknown as OutboxRow[],
      }; } finally { db.close(); }
    };
    const workspaceInventory = () => {
      const values: Record<string, unknown> = {};
      const visit = (path: string) => { const value = lstatSync(path); const name = path.slice(root.length + 1);
        if (value.isSymbolicLink()) values[name] = { type: "link", target: readlinkSync(path) };
        else if (value.isDirectory()) { values[name] = { type: "directory", mode: value.mode }; for (const child of readdirSync(path).sort()) visit(join(path, child)); }
        else { assert.equal(value.isFile(), true); values[name] = { type: "file", mode: value.mode, sha256: hash(readFileSync(path)) }; }
      };
      for (const path of [source, ordinary, base]) visit(path); return values;
    };
    async function request(method: string, path: string, body?: unknown, status = 200): Promise<any> {
      const response = await receiver.request(method, path, body), result = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`); return result;
    }
    let ordinaryInstance = "", secondInstance = "", allocatedInstance = "";
    async function capture(runId: string, extra: Omit<MixedRun, "command" | "originalWireText" | "originalWireSha256">) {
      await until(() => proxy.records.some((row) => row.direction === "down" && row.frame.type === "run.start" && row.frame.payload.run_id === runId), "real mixed route dispatch", 45000);
      const wire = proxy.records.find((row) => row.direction === "down" && row.frame.type === "run.start" && row.frame.payload.run_id === runId)!;
      const command = { ...wire.frame, payload: RunStartPayloadSchema.parse(wire.frame.payload) } as RunStartCommand;
      const [saved] = await receiver.server.db.db.select().from(runs).where(eq(runs.id, runId));
      const [pack] = await receiver.server.db.db.select().from(contextPacks).where(eq(contextPacks.runId, runId));
      assert.equal(saved!.computerId, receiver.nodeId); assert.deepEqual(command.payload.context_pack.payload, pack!.payload);
      assert.deepEqual(command.payload.workspace_allocation ?? null, saved!.workspaceAllocation);
      const record = { ...extra, command, originalWireText: wire.text, originalWireSha256: hash(wire.text) }; selectedRuns.push(record); return record;
    }
    async function task(title: string) { return request("POST", "/api/v1/tasks", { project_id: "proj_artoo", title, description: "One genuine local provider fixture process", acceptance_criteria: ["exactly one producer"], required_capabilities: ["code.modify"] }, 201); }
    async function turn(roomId: string, turnId: string, threadRootId?: string) {
      const suffix = threadRootId ? `?thread_root_id=${encodeURIComponent(threadRootId)}` : "";
      const body = await request("GET", `/api/v1/rooms/${roomId}/assistant-turns${suffix}`);
      const value = body.turns.find((item: { id: string }) => item.id === turnId); assert.ok(value); return value;
    }
    async function snapshot(runId: string) { return {
      journal: await journal.lookupRun(query(runId)),
      run: (await receiver.server.db.db.select().from(runs).where(eq(runs.id, runId)))[0],
      receipts: await receiver.server.db.db.select().from(runEventIngest).where(eq(runEventIngest.runId, runId)),
      events: await receiver.server.db.db.select().from(eventLog).where(eq(eventLog.runId, runId)),
    }; }
    return { root, source, ordinary, base, receiver, proxy, observe, lifetimes, launches, physical, storage, query, snapshot, selectedRuns, injections, incarnations, workspaceInventory,
      get runner() { return runner; }, get journal() { return journal; },
      async begin() {
        await runner.start();
        await until(async () => (await receiver.server.db.db.select().from(agentRuntimes).where(eq(agentRuntimes.computerId, receiver.nodeId))).some((row) => row.runtime === "process" && row.status === "available"), "advertised mixed process runtime");
        const instance = async (workspace: string, name: string) => (await request("POST", `/api/v1/computers/${receiver.nodeId}/instances`, { runtime: "process", workspace_root: workspace, display_name: name, capabilities: ["code.modify", "code.read"] }, 201)).agent_instance.id as string;
        ordinaryInstance = await instance(ordinary, "Mixed ordinary"); secondInstance = await instance(ordinary, "Discussion second participant"); allocatedInstance = await instance(source, "Mixed allocated");
        await request("PATCH", `/api/v1/agent-instances/${allocatedInstance}/worktree-workspace-base`, { version: 1, strategy: "per-run", basePath: base });
      },
      async assistantRun() {
        const created = await task("Mixed assistant fixture"), roomId = created.room.id as string;
        const queued = await request("POST", `/api/v1/rooms/${roomId}/assistant-turns`, { body: "Give one concise response", client_request_id: randomUUID(), agent_instance_id: ordinaryInstance }, 201);
        await assistant.pump(); const current = await turn(roomId, queued.turn.id); assert.ok(current.run_id);
        return capture(current.run_id, { kind: "assistant", roomId, turnId: current.id });
      },
      async discussionRun() {
        const goal = await request("POST", "/api/v1/goals", { project_id: "proj_artoo", title: "Mixed discussion fixture", objective: "Discuss one validation step", acceptance_criteria: ["A real contribution runs in discussion mode"] }, 201);
        const value = (await request("POST", `/api/v1/goals/${goal.goal.id}/discussions`, { participants: [{ agent_instance_id: ordinaryInstance, role: "Plan validation" }, { agent_instance_id: secondInstance, role: "Review validation" }], rounds: 1, max_minutes: 2 }, 201)).discussion;
        await discussion.pump(); await assistant.pump();
        const current = (await request("GET", `/api/v1/discussions/${value.id}`)).discussion;
        const contribution = await turn(value.room_id, current.active_turn_id, value.thread_root_id); assert.ok(contribution.run_id);
        return capture(contribution.run_id, { kind: "discussion-contribution", discussionId: value.id, roomId: value.room_id, turnId: contribution.id, threadRootId: value.thread_root_id });
      },
      async taskRun(allocated: boolean) {
        const created = await task(allocated ? "Mixed allocated task" : "Mixed ordinary task");
        await request("POST", `/api/v1/tasks/${created.task.id}/ready`);
        const assigned = await request("POST", `/api/v1/tasks/${created.task.id}/assign`, { mode: "manual", agent_instance_id: allocated ? allocatedInstance : ordinaryInstance, branch_backed: allocated });
        return capture(assigned.run.id, { kind: allocated ? "allocated-task" : "ordinary-task" });
      },
      async ready(record: MixedRun) {
        const runId = record.command.payload.run_id;
        await until(() => launches().some((entry) => entry.runId === runId) && existsSync(join(controls, runId + ".ready")), "actual mixed child program entry", 45000);
        await until(() => proxy.records.some((row) => row.direction === "up" && row.frame.kind === "command.ack" && row.frame.command_id === record.command.id), "actual mixed startup ACK", 45000);
        assert.equal(proxy.records.find((row) => row.direction === "up" && row.frame.kind === "command.ack" && row.frame.command_id === record.command.id)!.frame.status, "accepted");
        const entries = launches().filter((entry) => entry.runId === runId); assert.equal(entries.length, 1); assert.equal(absent(entries[0]!.pid), false);
        assert.equal(entries[0]!.contextSha256, hash(readFileSync(join(controls, runId + ".context"))));
        return entries[0]!;
      },
      async finish(record: MixedRun) {
        const runId = record.command.payload.run_id; writeFileSync(join(controls, runId + ".release"), "release actual provider fixture");
        await until(async () => (await snapshot(runId)).run?.status === "completed", "receiver completed actual run", 45000);
        await until(() => physical().filter((row) => row.runId === runId).length === 2 && physical().filter((row) => row.runId === runId).every((row) => row.exitObserved && row.stdioCloseObserved && row.childAbsent && row.groupAbsent), "per-run actual CLI/guardian closure");
        if (record.turnId) { await assistant.pump(); const completed = await turn(record.roomId!, record.turnId, record.threadRootId); assert.equal(completed.status, "completed"); assert.ok(completed.response_message_id); }
        if (record.discussionId) {
          const cancelled = await request("POST", `/api/v1/discussions/${record.discussionId}/cancel`); assert.equal(cancelled.discussion.status, "cancelled");
        }
        if (record.kind === "allocated-task") await until(() => { const rows = storage().outbox.filter((row) => row.run_id === runId); return rows.length > 0 && rows.every((row) => row.committed === 1); }, "managed exact receipts committed");
        const result = await snapshot(runId); mixedObservations.push({ case: "mixed-run", fixtureRoot: root, kind: record.kind, command: record.command, originalWireText: record.originalWireText, originalWireSha256: record.originalWireSha256, entry: launches().find((entry) => entry.runId === runId), physical: physical().filter((row) => row.runId === runId), snapshot: result });
        return result;
      },
      async reopen() { await runner.stop(); await journal.close(); journal = await openLocalJournal(journalOptions); incarnations.push(journal.incarnation); runner = makeRunner(journal); allRunners.push(runner); await runner.start(); },
      async resume(record: MixedRun) {
        const start = proxy.records.length, runId = record.command.payload.run_id;
        await receiver.server.nodeRegistry.get(receiver.nodeId)!.dispatchRunResume(runId);
        await until(() => proxy.records.slice(start).some((row) => row.direction === "down" && row.frame.type === "run.resume" && row.frame.payload.run_id === runId), "DB-owned binding resume dispatch");
        const command = proxy.records.slice(start).find((row) => row.direction === "down" && row.frame.type === "run.resume" && row.frame.payload.run_id === runId)!.frame;
        await until(() => proxy.records.some((row) => row.direction === "up" && row.frame.kind === "command.ack" && row.frame.command_id === command.id), "actual resume ACK");
        return proxy.records.find((row) => row.direction === "up" && row.frame.kind === "command.ack" && row.frame.command_id === command.id)!.frame as CommandAck;
      },
      async injectStart(record: MixedRun, payload: RunStartPayload, label: string) {
        const original = record.command, injected: RunStartCommand = { ...structuredClone(original), id: "mixed_injection_" + randomUUID(), payload: RunStartPayloadSchema.parse(payload) };
        const before = { entries: launches().length, cliSpawns: lifetimes.filter((row) => row.role === "cli").length, workspace: workspaceInventory() };
        const text = JSON.stringify(injected), connection = proxy.connections.at(-1)!; assert.equal(runner.link.connected, true);
        // Explicit hostile/repeated command fixture on an already authenticated
        // connection. This is not a route-authorized new run or a fake receipt.
        connection.client.send(text);
        await until(() => proxy.records.some((row) => row.direction === "up" && row.frame.kind === "command.ack" && row.frame.command_id === injected.id), "actual rejection/duplicate ACK", 45000);
        const ack = proxy.records.find((row) => row.direction === "up" && row.frame.kind === "command.ack" && row.frame.command_id === injected.id)!.frame as CommandAck;
        const after = { entries: launches().length, cliSpawns: lifetimes.filter((row) => row.role === "cli").length, workspace: workspaceInventory() };
        const observation = { label, scope: "Proxy-side command fault injection; auth, current socket and receipt receiver remain real", generation: connection.generation, original, injected, originalWireText: record.originalWireText, injectedWireText: text, originalSha256: record.originalWireSha256, injectedSha256: hash(text), ack, before, after };
        injections.push(observation); assert.deepEqual(after, before, "Duplicate/fault command changed filesystem or spawned another producer"); return ack;
      },
      toManaged(record: MixedRun): RunStartPayload {
        const payload = structuredClone(record.command.payload); const allocated = allocateWorkspaceRoot({ workspaceRoot: payload.workspace.root, branchBacked: true, targetComputerOs: process.platform, agentInstanceId: payload.agent_instance_id, runId: payload.run_id, worktreeBase: { version: 1, strategy: "per-run", basePath: base } });
        assert.ok(allocated); payload.workspace = { root: allocated, branch: `mixed/${payload.run_id}` };
        payload.workspace_allocation = { version: 1, strategy: "per-run", base_path: base }; payload.workspace_retention_reporting = "typed-v1";
        payload.policy_snapshot.filesystem_write_scope = [allocated]; payload.context_pack.payload!.workspace.root = allocated;
        assert.ok(allocationStartBinding(payload, process.platform, true)); return payload;
      },
      async close(remove: boolean) {
        const failures: unknown[] = []; const close = async (work: () => unknown | Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
        await close(() => discussion.stop()); await close(() => assistant.stop()); proxy.setPolicy();
        for (const owned of allRunners) await close(() => owned.stop());
        let finalStorage: ReturnType<typeof storage> | undefined; await close(() => { finalStorage = storage(); });
        await close(() => proxy.close()); let journalClosed = false; await close(async () => { await journal.close(); journalClosed = true; }); await close(() => receiver.close());
        await close(() => until(() => lifetimes.every((row) => { if (!row.pid) return false; if (!row.groupAbsentAt && absent(-row.pid)) row.groupAbsentAt = new Date().toISOString(); return Boolean(row.closedAt && row.groupAbsentAt && absent(row.pid)); }), "all mixed owned processes closed", 10000));
        let sourceUnchanged = false;
        await close(() => { assert.equal(git(source, "rev-parse", "HEAD"), sourceHead); assert.equal(git(source, "status", "--porcelain"), ""); assert.deepEqual(readFileSync(join(source, "tracked.bin")), originalBytes); sourceUnchanged = true; });
        await close(() => { const now = lstatSync(root, { bigint: true }); assert.equal(`${now.dev}:${now.ino}`, `${ownerStat.dev}:${ownerStat.ino}`); assert.equal(readFileSync(join(root, ".fixture-owner"), "utf8"), owner); });
        await close(() => { assert.equal(dispatchErrors.length, 0); assert.equal(launches().length, expectedWriters); assert.equal(lifetimes.filter((row) => row.role === "cli").length, expectedWriters); assert.equal(lifetimes.filter((row) => row.role === "guardian").length, expectedWriters); });
        const evidence = { case: "mixed-fixture-cleanup", root, expectedWriters, removed: false, journalClosed, sourceUnchanged, lifetimes, launches: launches(), physical: physical(), selectedRuns, incarnations, runnerCount: allRunners.length, connectionCount: proxy.connections.length, routes: receiver.routes, wire: proxy.records, injections, finalStorage, failures: failures.map(String), dispatchErrors: dispatchErrors.map(String), photos: [], scope: "Real HTTP authentication/device/admin/assistant/discussion/task routes and receipt receiver over PGlite; actual canonical CLI/guardian and SQLite worker. Local OIDC/provider fixtures; one contribution only, no completed plan, GUI or production PostgreSQL claim." };
        mixedObservations.push(evidence);
        if (failures.length) throw new AggregateError(failures, "Mixed cleanup failed; fixture retained");
        if (remove) { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); evidence.removed = true; }
      },
    };
  } catch (error) {
    const cleanup = await closeSetupResources(setupResources);
    mixedObservations.push({ case: "mixed-fixture-setup-failure", root, removed: false, error: String(error), cleanup });
    throw new Error(`Mixed fixture setup failed; retained ${root}`, { cause: error });
  }
}
