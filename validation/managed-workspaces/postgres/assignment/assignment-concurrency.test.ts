import { agentInstances, loadMigrationStatements, seed } from "../../../../packages/db/dist/index.js";
import { ContextPackSchema } from "../../../../packages/domain/dist/index.js";
import { allocateWorkspaceRoot, type NodeTransport } from "../../../../packages/protocol/dist/index.js";
import { eq } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../../../apps/server/dist/app.js";
import { createSession } from "../../../../apps/server/dist/auth/auth-service.js";
import { testAuthConfig } from "../../../../apps/server/dist/auth/auth-config.js";
import { testDeviceAuthConfig } from "../../../../apps/server/dist/config/device-auth.js";
import type { ServerContext } from "../../../../apps/server/dist/context.js";
import { attachNodeBinding, type NodeBinding } from "../../../../apps/server/dist/node-binding.js";
import { scheduleTask } from "../../../../apps/server/dist/services/scheduler.js";
import { createNodeRegistry } from "../../../../apps/server/dist/ws/node-registry.js";
import { ownedConnectionConfig } from "../owned-connection.js";
import { PgHarnessDbClient, type TransactionReceipt } from "../pg-db-client.js";

const ORG = "org_default", COMPUTER = "computer_local_mock", INSTANCE = "ai_assignment", ALTERNATIVE = "zz_assignment_other";
const NOW = "2026-10-03T00:00:00.000Z", KEY = 91342019;
const LEGACY = "/Legacy//Before-Cafe\u0301/", EXACT_LEGACY = "/Legacy//After-Cafe\u0301/草稿 /";
const BEFORE = { version: 1, strategy: "per-run", basePath: "/Before//Exact-Cafe\u0301/" };
const AFTER = { version: 1, strategy: "per-run", basePath: "/After//Exact-Cafe\u0301/草稿 /" };
const INITIAL = { concurrency_limit: 2, retained: { marker: "keep" }, worktree_workspace_base: BEFORE };
type Receipt = { name: string; state: "running" | "passed" | "failed"; evidence: Record<string, unknown>[] };

describe("four assignment lock cases on owned PostgreSQL", () => {
  let A: PgHarnessDbClient, B: PgHarnessDbClient, D: PgHarnessDbClient;
  let H: pg.Client, O: pg.Client, outputDir: string, token: string;
  let appA: ReturnType<typeof buildApp>, appB: ReturnType<typeof buildApp>, appD: ReturnType<typeof buildApp>;
  let ctxD: ServerContext;
  let pids: Record<"H" | "A" | "B" | "D" | "O", number>;
  let environment: Record<string, unknown>;
  const bindings: NodeBinding[] = [], pending: Promise<unknown>[] = [], cases: Receipt[] = [];
  const notices = new Map<string, Record<string, unknown>>();
  let current: Receipt | undefined;

  function record(value: Record<string, unknown>) { current?.evidence.push(structuredClone(value)); }
  async function save() {
    if (outputDir) await writeFile(join(outputDir, "concurrency-receipts.json"), JSON.stringify({
      schemaVersion: 1, scope: "four assignment serialization cases; test adapter only", environment, pids, cases,
      transactions: { A: A?.transactions, B: B?.transactions, D: D?.transactions },
    }, null, 2) + "\n");
  }
  function track<T>(promise: Promise<T>): Promise<T> { pending.push(promise.catch(() => undefined)); return promise; }
  async function runCase(name: string, body: () => Promise<void>) {
    current = { name, state: "running", evidence: [] }; cases.push(current);
    try { await body(); current.state = "passed"; }
    catch (error) { current.state = "failed"; record({ failure: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { await save(); }
  }
  async function blocked(waiter: number, holder: number, label: string, queryContains: string) {
    const deadline = performance.now() + 8000;
    let last: unknown, transients = 0;
    while (performance.now() < deadline) {
      const row = (await O.query<{ pid: number; blockers: number[]; wait_event_type: string | null; wait_event: string | null; state: string; query: string }>(
        "SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type,wait_event,state,query FROM pg_stat_activity WHERE pid=$1", [waiter],
      )).rows[0];
      last = row;
      if (row?.blockers.includes(holder) && row.wait_event_type !== "Lock") {
        transients++; if (transients <= 3) record({ barrier: label, transient: row });
      }
      if (row?.blockers.includes(holder) && row.wait_event_type === "Lock") {
        expect(row.query.toLowerCase()).toContain(queryContains);
        record({ barrier: label, observation: row, transients }); return;
      }
      await setImmediate();
    }
    record({ barrier: label, timedOut: true, last, transients });
    throw new Error(`No observed Lock + expected blocker ${holder} for ${waiter}: ${label}`);
  }
  function active(db: PgHarnessDbClient, pid: number) {
    const tx = db.transactions.at(-1)!;
    expect(tx).toMatchObject({ backendPid: pid, isolation: "read committed", state: "active" });
    return tx;
  }
  async function transactionStatus(tx: TransactionReceipt, expected: "committed" | "aborted") {
    const status = (await O.query("SELECT pg_xact_status($1::xid8) AS status", [tx.xid])).rows[0]!.status;
    expect(status).toBe(expected); expect(tx.state).toBe(expected);
    record({ transaction: tx, databaseTransactionStatus: status });
  }
  async function snapshot(taskId: string) {
    const tables = ["tasks", "runs", "scheduler_decisions", "context_packs", "approvals", "file_leases", "event_log"] as const;
    const result: Record<string, pg.QueryResultRow[]> = {};
    for (const table of tables) result[table] = (await O.query(
      `SELECT * FROM ${table} WHERE organization_id=$1 AND ${table === "tasks" ? "id" : "task_id"}=$2 ORDER BY ${table === "event_log" ? "position" : "id"}`, [ORG, taskId],
    )).rows;
    return result;
  }
  async function configState() {
    return { instance: (await O.query("SELECT * FROM agent_instances WHERE id=$1", [INSTANCE])).rows[0],
      configEvents: (await O.query("SELECT * FROM event_log WHERE type='agent_instance.updated' AND correlation_id=$1 ORDER BY position", [INSTANCE])).rows };
  }
  function assign(app: ReturnType<typeof buildApp>, taskId: string, path: string) {
    return track(Promise.resolve(app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${token}` }, payload: { mode: "auto", branch_backed: true, write_paths: [path] } })));
  }
  async function ready(label: string) {
    const headers = { authorization: `Bearer ${token}` };
    const created = await appA.inject({ method: "POST", url: "/api/v1/tasks", headers,
      payload: { project_id: "proj_artoo", title: label, acceptance_criteria: ["Preserve transactional identity"], required_capabilities: ["code.modify"] } });
    expect(created.statusCode).toBe(201); const id = created.json().task.id as string;
    expect((await appA.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready`, headers })).statusCode).toBe(200);
    const approval = await appA.inject({ method: "POST", url: `/api/v1/tasks/${id}/execution-approval`, headers,
      payload: { summary: "Stable approved fixture", risk: "high" } });
    expect(approval.statusCode).toBe(201);
    expect((await appA.inject({ method: "POST", url: `/api/v1/approvals/${approval.json().approval.id}/resolve`, headers,
      payload: { decision: "approved" } })).statusCode).toBe(200);
    return id;
  }
  async function assertAssigned(taskId: string, base: typeof BEFORE | null, legacy = LEGACY) {
    const state = await snapshot(taskId);
    expect(state.tasks).toHaveLength(1); expect(state.tasks![0]!.status).toBe("assigned");
    for (const table of ["runs", "scheduler_decisions", "context_packs", "approvals", "file_leases"]) expect(state[table]).toHaveLength(1);
    const run = state.runs![0]!, pack = state.context_packs![0]!;
    const root = allocateWorkspaceRoot({ workspaceRoot: legacy, branchBacked: true, targetComputerOs: "linux",
      agentInstanceId: INSTANCE, runId: run.id, worktreeBase: base ?? undefined });
    expect(run).toMatchObject({ agent_instance_id: INSTANCE, status: "queued", workspace_root: root,
      workspace_branch: `artoo/run-${run.id}`, workspace_allocation: base ? { version: 1, strategy: "per-run", base_path: base.basePath } : null });
    expect(pack.id).toBe(run.context_pack_id); expect(pack.run_id).toBe(run.id);
    expect(ContextPackSchema.parse(pack.payload).workspace.root).toBe(root);
    expect(state.approvals![0]).toMatchObject({ status: "approved", run_id: run.id });
    expect(state.file_leases![0]).toMatchObject({ run_id: run.id, status: "held" });
    expect(state.scheduler_decisions![0]).toMatchObject({ selected_agent_instance_id: INSTANCE });
    expect(state.event_log!.filter(event => event.type === "task.assigned")).toHaveLength(1);
    return state;
  }
  async function installEventBarrier(taskId: string) {
    await O.query(`CREATE FUNCTION assignment_event_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type='task.assigned' AND NEW.task_id=TG_ARGV[0] THEN
          RAISE NOTICE 'ARTOO_ASSIGNMENT_BARRIER:%', json_build_object(
            'taskId', NEW.task_id, 'pid', pg_backend_pid(), 'xid', pg_current_xact_id()::text,
            'runs', (SELECT count(*) FROM runs WHERE task_id=NEW.task_id),
            'decisions', (SELECT count(*) FROM scheduler_decisions WHERE task_id=NEW.task_id),
            'packs', (SELECT count(*) FROM context_packs WHERE task_id=NEW.task_id),
            'leases', (SELECT count(*) FROM file_leases WHERE task_id=NEW.task_id),
            'boundApprovals', (SELECT count(*) FROM approvals WHERE task_id=NEW.task_id AND run_id=NEW.run_id),
            'taskStatus', (SELECT status FROM tasks WHERE id=NEW.task_id));
          PERFORM pg_advisory_xact_lock(91342019);
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER assignment_event_barrier BEFORE INSERT ON event_log FOR EACH ROW
        EXECUTE FUNCTION assignment_event_barrier('${taskId}');`);
    await H.query("SELECT pg_advisory_lock($1)", [KEY]);
  }
  async function barrierWrites(taskId: string, tx: TransactionReceipt) {
    const deadline = performance.now() + 8000;
    while (!notices.has(taskId) && performance.now() < deadline) await setImmediate();
    expect(notices.get(taskId)).toEqual({ taskId, pid: pids.A, xid: tx.xid, runs: 1, decisions: 1, packs: 1, leases: 1, boundApprovals: 1, taskStatus: "assigned" });
    record({ beforeCommitActualTriggerState: notices.get(taskId) });
  }
  async function releaseBarrier() {
    expect((await H.query("SELECT pg_advisory_unlock($1) AS unlocked", [KEY])).rows[0]!.unlocked).toBe(true);
  }

  beforeAll(async () => {
    const owned = await ownedConnectionConfig("assignment"); outputDir = owned.outputDir;
    A = await PgHarnessDbClient.create({ ...owned.config, application_name: "artoo_assignment_A" });
    B = await PgHarnessDbClient.create({ ...owned.config, application_name: "artoo_assignment_B" });
    D = await PgHarnessDbClient.create({ ...owned.config, application_name: "artoo_assignment_D" });
    H = new pg.Client({ ...owned.config, application_name: "artoo_assignment_H" });
    O = new pg.Client({ ...owned.config, application_name: "artoo_assignment_O" });
    await Promise.all([H.connect(), O.connect()]);
    pids = { A: A.backendPid, B: B.backendPid, D: D.backendPid,
      H: (await H.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid,
      O: (await O.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid };
    expect(new Set(Object.values(pids)).size).toBe(5);
    environment = (await O.query("SELECT version(), current_database() AS database, current_user AS username, current_setting('listen_addresses') AS listen_addresses, current_setting('transaction_isolation') AS isolation")).rows[0]!;
    expect(environment).toMatchObject({ database: "artoo_concurrency", username: "artoo_harness", listen_addresses: "", isolation: "read committed" });
    expect(String(environment.version)).toMatch(/^PostgreSQL 17\.11 /);
    A.connection.on("notice", notice => {
      const prefix = "ARTOO_ASSIGNMENT_BARRIER:";
      if (notice.message?.startsWith(prefix)) {
        const state = JSON.parse(notice.message.slice(prefix.length)); notices.set(state.taskId, state);
      }
    });
    await A.migrate(await loadMigrationStatements());
  });
  beforeEach(async () => {
    current = undefined; notices.clear();
    const tables = (await O.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    await O.query(`TRUNCATE TABLE ${tables.map(row => `public."${String(row.tablename).replaceAll('"', '""')}"`).join(",")} RESTART IDENTITY CASCADE`);
    await seed(A, NOW, { workspaceRoot: LEGACY });
    const original = (await A.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder")))[0]!;
    await A.db.update(agentInstances).set({ status: "disabled" }).where(eq(agentInstances.id, original.id));
    await A.db.insert(agentInstances).values([
      { ...original, id: INSTANCE, config: INITIAL },
      { ...original, id: ALTERNATIVE, config: { concurrency_limit: 2 }, workspaceRoot: "/Alternative/Unused" },
    ]);
    await O.query("UPDATE computers SET os='linux' WHERE id=$1", [COMPUTER]);
    let sequence = 0;
    const idGen = { generate: (prefix: string) => `${prefix}_assignment_pg_${++sequence}` };
    function create(db: PgHarnessDbClient) {
      const ctx: ServerContext = { db, idGen, clock: { now: () => new Date(NOW), nowIso: () => NOW },
        organizationId: ORG, actorUserId: "user_owner", authConfig: testAuthConfig({ enforceApiAuth: true }),
        deviceAuth: testDeviceAuthConfig({ devNodeToken: null, devControlEscape: false }),
        oidcHttp: { async exchangeCode() { throw new Error("No provider access in assignment harness"); }, async fetchJwks() { throw new Error("No provider access in assignment harness"); } } };
      const registry = createNodeRegistry();
      const app = buildApp(ctx, { nodeRegistry: registry, assistantDispatcher: false, resetPresenceOnStart: false, budgetMonitorIntervalMs: false, enableDevRoutes: false });
      const transport: NodeTransport = { async send() { throw new Error("Assignment harness must not dispatch node commands"); }, subscribe() { return () => {}; }, async close() {} };
      // Qualified metadata fixture only; no real WS or execution is claimed.
      const fixtureQualified = true;
      const binding: NodeBinding = attachNodeBinding(ctx, transport, COMPUTER, ["workspace-allocation.per-run-v1"],
        () => fixtureQualified && registry.get(COMPUTER) === binding);
      bindings.push(binding); registry.register(COMPUTER, binding); ctx.onRunQueued = async () => {};
      return { app, ctx };
    }
    const first = create(A), second = create(B), admin = create(D);
    appA = first.app; appB = second.app; appD = admin.app; ctxD = admin.ctx;
    token = (await createSession(first.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" })).raw;
    await Promise.all([appA.ready(), appB.ready(), appD.ready()]);
  });
  afterEach(async () => {
    await H?.query("ROLLBACK"); await H?.query("SELECT pg_advisory_unlock_all()");
    await Promise.all(pending.splice(0));
    for (const db of [A, B, D]) await db?.connection.query("ROLLBACK");
    for (const binding of bindings.splice(0)) binding.close();
    await Promise.all([appA?.close(), appB?.close(), appD?.close()]);
    await O?.query("DROP TRIGGER IF EXISTS assignment_event_barrier ON event_log; DROP FUNCTION IF EXISTS assignment_event_barrier()");
    await save();
  });
  afterAll(async () => {
    await save();
    const closed = await Promise.allSettled([H?.end(), O?.end(), A?.close(), B?.close(), D?.close()]);
    expect(closed.filter(result => result.status === "rejected")).toEqual([]);
  });

  for (const variant of ["new-base", "delete-to-exact-legacy"] as const) {
    it(`config commits first: ${variant}`, () => runCase(`config-first/${variant}`, async () => {
      const taskId = await ready(variant), before = await snapshot(taskId);
      await H.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const holder = (await H.query("SELECT pg_current_xact_id()::text AS xid,current_setting('transaction_isolation') AS isolation")).rows[0]!;
      expect(holder.isolation).toBe("read committed");
      await H.query("SELECT id FROM agent_instances WHERE id=$1 FOR UPDATE", [INSTANCE]);
      const response = assign(appA, taskId, "src/config-first");
      await blocked(pids.A, pids.H, "assignment selected instance FOR UPDATE waits for config holder", '"agent_instances"');
      const tx = active(A, pids.A);
      expect(await snapshot(taskId)).toEqual(before);
      if (variant === "new-base") await H.query("UPDATE agent_instances SET config=jsonb_set(config,'{worktree_workspace_base}',$1::jsonb) WHERE id=$2", [JSON.stringify(AFTER), INSTANCE]);
      else await H.query("UPDATE agent_instances SET config=config-'worktree_workspace_base',workspace_root=$1 WHERE id=$2", [EXACT_LEGACY, INSTANCE]);
      await H.query("COMMIT");
      expect((await O.query("SELECT pg_xact_status($1::xid8) AS status", [holder.xid])).rows[0]!.status).toBe("committed");
      const result = await response; expect(result.statusCode).toBe(200);
      await transactionStatus(tx, "committed");
      const final = await assertAssigned(taskId, variant === "new-base" ? AFTER : null, variant === "new-base" ? LEGACY : EXACT_LEGACY);
      expect((await configState()).instance.config).toEqual(variant === "new-base" ? { ...INITIAL, worktree_workspace_base: AFTER } : { concurrency_limit: 2, retained: INITIAL.retained });
      record({ holderTransaction: holder, holderStatus: "committed", responseStatus: result.statusCode, before, final });
    }));
  }
  it("assignment commits first: real administrator configuration is rejected after its wait", () => runCase("assignment-first/admin-conflict", async () => {
    const taskId = await ready("assignment first"), before = await snapshot(taskId), configBefore = await configState();
    await installEventBarrier(taskId);
    const responseA = assign(appA, taskId, "src/assignment-first");
    await blocked(pids.A, pids.H, "assignment event INSERT waits after its writes", 'insert into "event_log"');
    const txA = active(A, pids.A); await barrierWrites(taskId, txA);
    expect(await snapshot(taskId)).toEqual(before);
    const responseD = track(Promise.resolve(appD.inject({ method: "PATCH", url: `/api/v1/agent-instances/${INSTANCE}/worktree-workspace-base`,
      headers: { authorization: `Bearer ${token}` }, payload: AFTER })));
    await blocked(pids.D, pids.A, "real admin route waits on assignment instance fence", '"agent_instances"');
    const txD = active(D, pids.D);
    await releaseBarrier();
    const [assigned, configured] = await Promise.all([responseA, responseD]);
    expect(assigned.statusCode).toBe(200); expect(configured.statusCode).toBe(409);
    await transactionStatus(txA, "committed"); await transactionStatus(txD, "aborted");
    expect(await configState()).toEqual(configBefore);
    const final = await assertAssigned(taskId, BEFORE);
    record({ assignmentStatus: assigned.statusCode, adminStatus: configured.statusCode, adminError: configured.json(), configBefore, configAfter: await configState(), final });
  }));
  it("capacity one: waiting second assignment aborts without reselection or orphan writes", () => runCase("capacity-one/no-reselection", async () => {
    await O.query("UPDATE agent_instances SET config=jsonb_set(config,'{concurrency_limit}','1'::jsonb) WHERE id=$1", [INSTANCE]);
    const first = await ready("capacity first"), second = await ready("capacity second"), secondBefore = await snapshot(second);
    const alternativeBefore = (await O.query("SELECT * FROM agent_instances WHERE id=$1", [ALTERNATIVE])).rows[0];
    await installEventBarrier(first);
    const responseA = assign(appA, first, "src/first");
    await blocked(pids.A, pids.H, "first assignment has writes but remains uncommitted", 'insert into "event_log"');
    const txA = active(A, pids.A); await barrierWrites(first, txA);
    const responseB = assign(appB, second, "src/second");
    await blocked(pids.B, pids.A, "second assignment passed initial scheduling then waits on selected instance", '"agent_instances"');
    const txB = active(B, pids.B); expect(await snapshot(second)).toEqual(secondBefore);
    await releaseBarrier();
    const [assigned, rejected] = await Promise.all([responseA, responseB]);
    expect(assigned.statusCode).toBe(200); expect(rejected.statusCode).toBe(409);
    await transactionStatus(txA, "committed"); await transactionStatus(txB, "aborted");
    const finalFirst = await assertAssigned(first, BEFORE);
    const secondAfter = await snapshot(second); expect(secondAfter).toEqual(secondBefore);
    expect(secondAfter.tasks![0]!.status).toBe("ready"); expect(secondAfter.approvals![0]).toMatchObject({ status: "approved", run_id: null });
    for (const table of ["runs", "scheduler_decisions", "context_packs", "file_leases"]) expect(secondAfter[table]).toEqual([]);
    expect(secondAfter.event_log!.filter(event => event.type === "task.assigned")).toEqual([]);
    expect((await O.query("SELECT * FROM agent_instances WHERE id=$1", [ALTERNATIVE])).rows[0]).toEqual(alternativeBefore);
    expect((await O.query("SELECT * FROM runs WHERE agent_instance_id=$1", [ALTERNATIVE])).rows).toEqual([]);
    const stillEligible = await scheduleTask(D.db, ctxD, ["code.modify"], { mode: "auto", projectId: "proj_artoo", branchBacked: true });
    expect(stillEligible.selected.agent_instance_id).toBe(ALTERNATIVE);
    record({ firstStatus: assigned.statusCode, secondStatus: rejected.statusCode, secondError: rejected.json(), secondBefore, secondAfter, finalFirst, eligibleAlternative: stillEligible });
  }));
});
