import { ownedConnectionConfig } from "../owned-connection.js";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import pg, { type ClientConfig } from "pg";
import { appendEvent, loadMigrationStatements, seed } from "../../../../packages/db/dist/index.js";
import { CreateTaskRequestSchema, ID_PREFIXES, type Run } from "../../../../packages/domain/dist/index.js";
import type { NodeRunEvent, NodeTransport, RunEventMessage } from "../../../../packages/protocol/dist/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgHarnessDbClient } from "../pg-db-client.js";
import { attachNodeBinding, type NodeBinding } from "../../../../apps/server/dist/node-binding.js";
import type { ServerContext } from "../../../../apps/server/dist/context.js";
import { testAuthConfig } from "../../../../apps/server/dist/auth/auth-config.js";
import { testDeviceAuthConfig } from "../../../../apps/server/dist/config/device-auth.js";
import { createTask } from "../../../../apps/server/dist/services/task-service.js";
import { enqueueAssistantTurn } from "../../../../apps/server/dist/services/assistant-service.js";
import { markReady, assignTask } from "../../../../apps/server/dist/services/lifecycle-service.js";
import { ingestWireRunEvent } from "../../../../apps/server/dist/services/run-service.js";
import { qualifyRunEventMessage } from "../../../../apps/server/dist/services/run-event-receipt.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const ORG = "org_default", NODE = "computer_local_mock", WORKSPACE = "/owned/receipt-postgres";
const NOW = "2026-10-03T00:00:00.000Z", ADVISORY_KEY = 91342026;
type Kind = "started" | "output" | "answer" | "usage" | "artifact" | "retention" | "terminal";
const kinds: Kind[] = ["started", "output", "answer", "usage", "artifact", "retention", "terminal"];
const frame = (run: Run, sequence: number, event: NodeRunEvent): RunEventMessage =>
  ({ kind: "run.event", node_id: NODE, run_id: run.id, sequence, event });
function body(kind: Kind, run: Run): NodeRunEvent {
  switch (kind) {
    case "started": return { type: "run.lifecycle", payload: { phase: "started", reason: "provider-started" } };
    case "output": return { type: "run.output", payload: { stream: "stdout", text: "one" } };
    case "answer": return { type: "run.answer", payload: { text: "answer one" } };
    case "usage": return { type: "run.usage", payload: { input_tokens: 1, cost_usd: 0, currency: "USD", provider_session_id: "p1" } };
    case "artifact": return { type: "artifact.created", payload: { type: "report", uri: "report.txt", metadata: { nested: { a: 1, b: 2 } }, checksum: null } };
    case "retention": return { type: "run.workspace.retained", payload: { version: 1, workspace_root: run.workspace_root!, workspace_branch: run.workspace_branch!, outcome: "completed" } };
    case "terminal": return { type: "run.lifecycle", payload: { phase: "completed", reason: null } };
  }
}
function context(db: PgHarnessDbClient, tag: string): ServerContext {
  let counter = 0;
  return { db, clock: { now: () => new Date(NOW), nowIso: () => NOW },
    idGen: { generate: (prefix) => `${prefix}_${tag}_${db.backendPid}_${++counter}` },
    organizationId: ORG, actorUserId: "user_owner", authConfig: testAuthConfig(), deviceAuth: testDeviceAuthConfig(),
    oidcHttp: { async exchangeCode() { throw new Error("No OIDC runtime is allowed by this fixture"); },
      async fetchJwks() { throw new Error("No OIDC runtime is allowed by this fixture"); } } };
}
async function prepareRun(ctx: ServerContext) {
  const { task } = await createTask(ctx, CreateTaskRequestSchema.parse({ project_id: "proj_artoo", title: "receipt fixture",
    acceptance_criteria: ["exact receipt"], required_capabilities: ["code.modify"] }));
  const { turn } = await enqueueAssistantTurn(ctx, task.room_id!, { body: "receipt answer", client_request_id: `request:${task.id}` });
  await markReady(ctx, task.id);
  const { run } = await assignTask(ctx, task.id, { mode: "auto", branch_backed: true, write_paths: ["Src/Work.ts"] }, turn.id);
  return { run, turnId: turn.id };
}


describe("qualified full-body receipts on owned PostgreSQL", () => {
  let A: PgHarnessDbClient, B: PgHarnessDbClient, H: pg.Client, O: pg.Client;
  let ctxA: ServerContext, ctxB: ServerContext, config: ClientConfig, outputDir: string;
  let fixture: Awaited<ReturnType<typeof prepareRun>>;
  let pids: { A: number; B: number; H: number; O: number };
  let environment: Record<string, unknown>;
  type Receipt = { name: string; state: "running" | "passed" | "failed"; evidence: Record<string, unknown>[]; transactions?: unknown };
  type Ack = { side: "A" | "B"; runId: string; sequence: number; status: "accepted" | "rejected"; dropped: boolean };
  const cases: Receipt[] = [], pending: Promise<unknown>[] = [], bindings: NodeBinding[] = [], acknowledgements: Ack[] = [];
  let current: Receipt | undefined;
  function record(value: Record<string, unknown>) { current?.evidence.push(value); }
  async function save() {
    await writeFile(join(outputDir, "concurrency-receipts.json"), JSON.stringify({
      schemaVersion: 1, scope: "Candidate binding/service and test-only PostgreSQL adapter; no production backend/native/provider claim",
      environment, pids, cases,
    }, null, 2) + "\n");
  }
  function track<T>(promise: Promise<T>): Promise<T> { pending.push(promise.catch(() => undefined)); return promise; }
  async function testCase(name: string, work: () => Promise<void>) {
    current = { name, state: "running", evidence: [] }; cases.push(current);
    try { await work(); current.state = "passed"; }
    catch (error) { current.state = "failed"; record({ failure: error instanceof Error ? error.message : "Non-Error failure" }); throw error; }
    finally { current.transactions = { A: [...A.transactions], B: [...B.transactions] }; await save(); }
  }
  async function blocked(blockedPid: number, blockerPid: number, label: string) {
    const deadline = performance.now() + 8000; let last: unknown; let transient = 0;
    while (performance.now() < deadline) {
      const row = (await O.query<{ pid: number; blockers: number[]; wait_event_type: string | null }>(
        "SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type FROM pg_stat_activity WHERE pid=$1", [blockedPid],
      )).rows[0]; last = row;
      if (row?.blockers.includes(blockerPid) && row.wait_event_type === "Lock") { record({ barrier: label, observation: row, transient }); return; }
      if (row?.blockers.includes(blockerPid) && transient++ < 3) record({ barrier: label, transientObservation: row });
      await setImmediate();
    }
    record({ barrier: label, timedOut: true, last }); throw new Error(`Missing observed blocker ${blockerPid} for ${blockedPid}`);
  }
  function receiver(side: "A" | "B", dropAck = false) {
    const db = side === "A" ? A : B, ctx = side === "A" ? ctxA : ctxB;
    const transport: NodeTransport = { subscribe: () => () => {}, close: async () => {}, async send(message) {
      if (message.type !== "run.event.ack") throw new Error("Fixture must not dispatch execution");
      const receipt = message.payload;
      const transaction = db.transactions.at(-1)!;
      const observed = (await O.query<{ state: string }>("SELECT pg_xact_status($1::xid8) AS state", [transaction.xid])).rows[0]!;
      const stored = (await O.query("SELECT node_id,run_id,sequence,event_id,body_identity FROM run_event_ingest WHERE node_id=$1 AND run_id=$2 AND sequence=$3", [NODE, receipt.run_id, receipt.sequence])).rows;
      if (receipt.status === "accepted") {
        expect(observed.state).toBe("committed"); expect(transaction.state).toBe("committed");
        expect(stored).toHaveLength(1); expect(stored[0].body_identity).toMatch(/^run-event-body-v1:sha256:[0-9a-f]{64}$/);
      }
      acknowledgements.push({ side, runId: receipt.run_id, sequence: receipt.sequence, status: receipt.status, dropped: dropAck });
      record({ ack: { side, ...receipt, dropped: dropAck }, transaction: { ...transaction }, observedTransactionState: observed.state, committedReceipt: stored });
      if (dropAck) throw new Error("Deliberate post-commit ACK loss");
    } };
    const binding = attachNodeBinding(ctx, transport, NODE); bindings.push(binding);
    return binding;
  }
  function send(binding: NodeBinding, message: RunEventMessage) { binding.receive(message); return track(binding.drain()); }
  function statuses(sequence: number) {
    // Compare each sender's outcome; ACK callback scheduling is not commit-order evidence.
    return acknowledgements.filter((a) => a.sequence === sequence).map((a) => [a.side, a.status])
      .sort((a, b) => a[0]!.localeCompare(b[0]!));
  }
  async function installBarrier(message: RunEventMessage, abortA = false) {
    await H.query("SELECT pg_advisory_lock($1)", [ADVISORY_KEY]);
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    await O.query(`CREATE FUNCTION receipt_candidate_barrier() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF current_setting('application_name')='receipt_A' AND NEW.run_id=${literal(message.run_id)} AND NEW.sequence=${message.sequence} THEN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          ${abortA ? "RAISE EXCEPTION 'deliberate receipt abort' USING ERRCODE='P0001';" : ""}
        END IF;
        RETURN NEW;
      END; $body$;
      CREATE TRIGGER receipt_candidate_barrier BEFORE INSERT ON run_event_ingest FOR EACH ROW EXECUTE FUNCTION receipt_candidate_barrier()`);
  }
  async function race(first: RunEventMessage, second = structuredClone(first), abortA = false) {
    await installBarrier(first, abortA);
    const a = send(receiver("A"), first);
    await blocked(pids.A, pids.H, "A waits before real receipt INSERT");
    const b = send(receiver("B"), second);
    await blocked(pids.B, pids.A, "B waits on A's run row");
    await H.query("SELECT pg_advisory_unlock($1)", [ADVISORY_KEY]);
    await Promise.all([a, b]);
    expect([...A.transactions, ...B.transactions].some((t) => t.databaseErrorCode === "23505")).toBe(false);
  }
  async function started(run: Run) { await ingestWireRunEvent(ctxA, frame(run, 0, body("started", run))); }
  async function oneEffect(message: RunEventMessage) {
    const receipts = (await O.query("SELECT event_id,body_identity FROM run_event_ingest WHERE node_id=$1 AND run_id=$2 AND sequence=$3", [NODE, message.run_id, message.sequence])).rows;
    expect(receipts).toHaveLength(1); expect(receipts[0].body_identity).toBe(qualifyRunEventMessage(message).bodyIdentity);
    const event = message.event;
    const type = event.type === "run.lifecycle" ? `run.${event.payload.phase}` : event.type === "run.answer" ? "message.created" : event.type;
    const events = (await O.query("SELECT id,type,payload FROM event_log WHERE run_id=$1 AND sequence=$2 AND type=$3", [message.run_id, message.sequence, type])).rows;
    expect(events).toHaveLength(1); expect(events[0].id).toBe(receipts[0].event_id);
    if (event.type === "run.answer") {
      const answers = (await O.query("SELECT id,body FROM messages WHERE run_id=$1 AND kind='text'", [message.run_id])).rows;
      expect(answers).toHaveLength(1); expect(answers[0].body).toBe(event.payload.text);
      expect((await O.query("SELECT response_message_id FROM assistant_turns WHERE id=$1", [fixture.turnId])).rows[0].response_message_id).toBe(answers[0].id);
    }
    if (event.type === "run.usage") {
      expect((await O.query("SELECT input_tokens::int,cost_usd,provider_session_id FROM run_usage WHERE run_id=$1", [message.run_id])).rows)
        .toEqual([{ input_tokens: 1, cost_usd: 0, provider_session_id: "p1" }]);
    }
    if (event.type === "artifact.created") expect((await O.query("SELECT uri FROM artifacts WHERE run_id=$1", [message.run_id])).rows).toEqual([{ uri: event.payload.uri }]);
    record({ exactlyOneEffect: { tuple: [NODE, message.run_id, message.sequence], receipts, events } });
  }

  beforeAll(async () => {
    const owned = await ownedConnectionConfig("receipt"); config = owned.config; outputDir = owned.outputDir;
    A = await PgHarnessDbClient.create({ ...config, application_name: "receipt_A" });
    B = await PgHarnessDbClient.create({ ...config, application_name: "receipt_B" });
    H = new pg.Client({ ...config, application_name: "receipt_H" }); O = new pg.Client({ ...config, application_name: "receipt_O" });
    await Promise.all([H.connect(), O.connect()]);
    const pid = async (client: pg.Client) => (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    pids = { A: A.backendPid, B: B.backendPid, H: await pid(H), O: await pid(O) }; expect(new Set(Object.values(pids)).size).toBe(4);
    environment = (await O.query("SELECT version(),current_database() AS database,current_user AS username,current_setting('listen_addresses') AS listen_addresses,current_setting('transaction_isolation') AS isolation")).rows[0]!;
    expect(environment.listen_addresses).toBe(""); expect(environment.database).toBe("artoo_concurrency"); expect(environment.isolation).toBe("read committed");
    expect(String(environment.version)).toMatch(/^PostgreSQL 17\.11 /);
    await A.migrate(await loadMigrationStatements());
  });
  beforeEach(async () => {
    current = undefined; acknowledgements.length = 0;
    const tables = (await O.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
    await O.query(`TRUNCATE TABLE ${tables.map((r) => `public.${quote(r.tablename)}`).join(",")} RESTART IDENTITY CASCADE`);
    await seed(A, NOW, { workspaceRoot: WORKSPACE }); ctxA = context(A, "A"); ctxB = context(B, "B");
    fixture = await prepareRun(ctxA); A.transactions.length = 0; B.transactions.length = 0;
  });
  afterEach(async () => {
    await H.query("ROLLBACK"); await H.query("SELECT pg_advisory_unlock_all()");
    await Promise.all(pending.splice(0));
    for (const binding of bindings.splice(0)) binding.close();
    await O.query("DROP TRIGGER IF EXISTS receipt_candidate_barrier ON run_event_ingest; DROP FUNCTION IF EXISTS receipt_candidate_barrier()");
    if (current) current.transactions = { A: [...A.transactions], B: [...B.transactions] };
    await save();
  });
  afterAll(async () => {
    if (outputDir) await save();
    const closed = await Promise.allSettled([A?.close(), B?.close(), H?.end(), O?.end()]);
    expect(closed.filter((r) => r.status === "rejected")).toEqual([]);
  });

  for (const [index, kind] of kinds.entries()) {
    const name = `PG${String(index + 1).padStart(2, "0")} concurrent identical ${kind}`;
    it(name, () => testCase(name, async () => {
      const run = fixture.run; if (kind !== "started") await started(run);
      const message = frame(run, kind === "started" ? 0 : 1, body(kind, run));
      await race(message); expect(statuses(message.sequence)).toEqual([["A", "accepted"], ["B", "accepted"]]); await oneEffect(message);
    }));
  }
  it("PG08 concurrent changed output", () => testCase("PG08 concurrent changed output", async () => {
    const message = frame(fixture.run, 1, body("output", fixture.run));
    await race(message, { ...message, event: { type: "run.output", payload: { stream: "stdout", text: "two" } } });
    expect(statuses(1)).toEqual([["A", "accepted"], ["B", "rejected"]]); await oneEffect(message);
  }));
  it("PG09 concurrent metadata-only artifact change", () => testCase("PG09 concurrent metadata-only artifact change", async () => {
    const message = frame(fixture.run, 1, body("artifact", fixture.run));
    if (message.event.type !== "artifact.created") throw new Error("Expected artifact");
    const changed: RunEventMessage = { ...message, event: { ...message.event, payload: { ...message.event.payload, metadata: { nested: { a: 1, b: 3 } } } } };
    await race(message, changed); expect(statuses(1)).toEqual([["A", "accepted"], ["B", "rejected"]]); await oneEffect(message);
  }));
  it("PG10 retention tuple cannot be replayed as output", () => testCase("PG10 retention tuple cannot be replayed as output", async () => {
    const message = frame(fixture.run, 1, body("retention", fixture.run));
    await race(message, frame(fixture.run, 1, body("output", fixture.run)));
    expect(statuses(1)).toEqual([["A", "accepted"], ["B", "rejected"]]); await oneEffect(message);
  }));
  it("PG11 aborted first insert rolls back effects and lets identical B commit", () => testCase("PG11 aborted first insert rolls back effects and lets identical B commit", async () => {
    const message = frame(fixture.run, 1, body("output", fixture.run));
    await race(message, structuredClone(message), true);
    expect(statuses(1)).toEqual([["A", "rejected"], ["B", "accepted"]]); await oneEffect(message);
    expect(A.transactions.some((t) => t.state === "aborted" && t.databaseErrorCode === "P0001")).toBe(true);
    expect((await O.query("SELECT id FROM event_log WHERE run_id=$1 AND sequence=1 AND id LIKE $2", [message.run_id, `${ID_PREFIXES.event}_A_${pids.A}_%`])).rows).toEqual([]);
  }));
  it("PG12 committed answer survives ACK loss and fresh binding replay", () => testCase("PG12 committed answer survives ACK loss and fresh binding replay", async () => {
    await started(fixture.run); const message = frame(fixture.run, 1, body("answer", fixture.run));
    const lost = receiver("A", true); await send(lost, message); lost.close();
    await send(receiver("B"), message);
    expect(statuses(1)).toEqual([["A", "accepted"], ["B", "accepted"]]);
    expect(acknowledgements.find((a) => a.side === "A" && a.sequence === 1)?.dropped).toBe(true); await oneEffect(message);
  }));
  it("PG13 additive SQL preserves NULL legacy history without qualification", () => testCase("PG13 additive SQL preserves NULL legacy history without qualification", async () => {
    // A second fixed-name database belongs to this same fresh, no-TCP owned cluster.
    // It preserves the exact baseline/suffix SQL without modifying the main fixture's schema.
    await O.query("CREATE DATABASE artoo_receipt_legacy");
    const legacy = await PgHarnessDbClient.create({ ...config, database: "artoo_receipt_legacy", application_name: "receipt_legacy" });
    try {
      const baseline = await loadMigrationStatements("0021_workspace_retention.sql"), all = await loadMigrationStatements();
      await legacy.migrate(baseline); await seed(legacy, NOW, { workspaceRoot: WORKSPACE });
      // Explicit pre-0022/0023 historical database fixture, not an accepted local
      // journal history or a physical execution receipt. Current assignTask writes
      // workspace_allocation, so it cannot prepare a real 0021 schema.
      const legacyCtx = context(legacy, "legacy"), run = fixture.run;
      await legacy.transaction(async () => {
        await legacy.connection.query(`INSERT INTO tasks
          (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
          VALUES ($1,$2,'proj_artoo','Historical receipt fixture','assigned','user','user_owner',$3,$3)`,
        [run.task_id, ORG, NOW]);
        await legacy.connection.query(`INSERT INTO runs
          (id,organization_id,task_id,computer_id,agent_instance_id,runtime_id,status,workspace_root,workspace_branch,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [run.id, ORG, run.task_id, run.computer_id, run.agent_instance_id, run.runtime_id, run.status,
          run.workspace_root, run.workspace_branch, NOW]);
      });
      await appendEvent(legacy.db, { id: "event_receipt_legacy", organizationId: ORG, type: "run.output", schemaVersion: "1",
        actorType: "agent", actorId: run.agent_instance_id, correlationId: run.task_id, taskId: run.task_id,
        runId: run.id, sequence: 1, payload: { stream: "stdout", text: "one" }, occurredAt: NOW });
      await legacy.connection.query("INSERT INTO run_event_ingest(node_id,run_id,sequence,event_id,created_at) VALUES($1,$2,1,'event_receipt_legacy',$3)", [NODE, run.id, NOW]);
      const oldEvent = (await legacy.connection.query("SELECT * FROM event_log WHERE id='event_receipt_legacy'")).rows;
      const oldState = (await legacy.connection.query("SELECT r.status AS run_status,t.status AS task_status FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1", [run.id])).rows;
      await legacy.transaction(async () => {
        for (let i = baseline.length; i < all.length; i++) {
          await legacy.connection.query(all[i]!);
          await legacy.connection.query("INSERT INTO artoo_harness_meta.migrations(position,sha256) VALUES($1,$2)", [i, createHash("sha256").update(all[i]!.replace(/\r\n/g, "\n").trim()).digest("hex")]);
        }
      });
      const message = frame(run, 1, body("output", run));
      await expect(ingestWireRunEvent(legacyCtx, message)).rejects.toThrow("legacy run event receipt has no qualified body identity");
      expect((await legacy.connection.query("SELECT event_id,body_identity FROM run_event_ingest WHERE run_id=$1", [run.id])).rows).toEqual([{ event_id: "event_receipt_legacy", body_identity: null }]);
      expect((await legacy.connection.query("SELECT * FROM event_log WHERE id='event_receipt_legacy'")).rows).toEqual(oldEvent);
      expect((await legacy.connection.query("SELECT r.status AS run_status,t.status AS task_status FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1", [run.id])).rows).toEqual(oldState);
      expect(await ingestWireRunEvent(legacyCtx, { ...message, sequence: 2 })).toHaveProperty("receiptBodyIdentity");
      record({ legacyMigration: { backendPid: legacy.backendPid, database: "artoo_receipt_legacy", baselineStatements: baseline.length, suffixStatements: all.length - baseline.length,
        oldEvent, oldState, receipts: (await legacy.connection.query("SELECT sequence,event_id,body_identity FROM run_event_ingest WHERE run_id=$1 ORDER BY sequence", [run.id])).rows,
        transactions: legacy.transactions, adapterUpgradeClaim: false } });
    } finally { await legacy.close(); }
  }));
  for (const order of ["completed-first", "correction-first"] as const) {
    const name = `${order === "completed-first" ? "PG14" : "PG15"} terminal ordering ${order}`;
    it(name, () => testCase(name, async () => {
      const run = fixture.run; await started(run);
      await ingestWireRunEvent(ctxA, frame(run, 1, body("retention", run)));
      const completed = frame(run, 2, body("terminal", run)), retention = body("retention", run);
      if (retention.type !== "run.workspace.retained") throw new Error("Expected retention");
      const correction = frame(run, 3, { ...retention, payload: { ...retention.payload, outcome: "incomplete_delivery" } });
      const failed = frame(run, 4, { type: "run.lifecycle", payload: { phase: "failed", reason: "incomplete_delivery" } });
      const target = receiver("A");
      for (const message of order === "completed-first" ? [completed, correction, failed] : [correction, failed, completed]) await send(target, message);
      expect(acknowledgements.every((a) => a.status === "accepted")).toBe(true);
      const final = (await O.query("SELECT r.status AS run_status,t.status AS task_status FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1", [run.id])).rows[0];
      expect(final).toEqual(order === "completed-first" ? { run_status: "completed", task_status: "review" } : { run_status: "failed", task_status: "blocked" });
      const latest = (await O.query("SELECT sequence,payload FROM event_log WHERE run_id=$1 AND type='run.workspace.retained' ORDER BY position DESC LIMIT 1", [run.id])).rows[0];
      expect(latest.sequence).toBe(3); expect(latest.payload.outcome).toBe("incomplete_delivery");
      expect((await O.query("SELECT id FROM event_log WHERE run_id=$1 AND type='run.reconciled'", [run.id])).rows).toHaveLength(1);
      record({ terminalOrder: order, final, latestRetention: latest });
    }));
  }
});
