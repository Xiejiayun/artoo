import { ownedConnectionConfig } from "../owned-connection.js";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import pg, { type ClientConfig } from "pg";
import { eq } from "drizzle-orm";
import { loadMigrationStatements, seed, users } from "../../../../packages/db/dist/index.js";
import type { NodeTransport } from "../../../../packages/protocol/dist/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PgHarnessDbClient, type TransactionReceipt } from "../pg-db-client.js";
// All product imports and aliases use the same compiled repository graph.
import { buildApp } from "../../../../apps/server/dist/app.js";
import { createSession, provisionUser } from "../../../../apps/server/dist/auth/auth-service.js";
import { testAuthConfig } from "../../../../apps/server/dist/auth/auth-config.js";
import { testDeviceAuthConfig } from "../../../../apps/server/dist/config/device-auth.js";
import type { ServerContext } from "../../../../apps/server/dist/context.js";
import { attachNodeBinding, type NodeBinding } from "../../../../apps/server/dist/node-binding.js";
import { createNodeRegistry } from "../../../../apps/server/dist/ws/node-registry.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const ORG = "org_default", INSTANCE = "instance_admin_lock_test", COMPUTER = "computer_local_mock";
const ENDPOINT = `/api/v1/agent-instances/${INSTANCE}/worktree-workspace-base`;
const ADVISORY_KEY = 91342017;
const NOW = "2026-10-03T00:00:00.000Z";
const BEFORE = { version: 1, strategy: "per-run", basePath: "C:/Before//MiXeD/草稿/" };
const AFTER = { version: 1, strategy: "per-run", basePath: "C:/After//MiXeD/草稿/" };
const RETAINED = { concurrency_limit: 3, provider_options: { mode: "keep", labels: ["A", "B"] } };
const INITIAL_CONFIG = { ...RETAINED, worktree_workspace_base: BEFORE };
type Method = "PATCH" | "DELETE";
type Receipt = { name: string; state: "running" | "passed" | "failed"; evidence: Record<string, unknown>[] };


describe("revision 2 administrator serialization on owned PostgreSQL", () => {
  let db: PgHarnessDbClient;
  let H: pg.Client, D: pg.Client, O: pg.Client;
  let app: ReturnType<typeof buildApp> | undefined;
  let binding: NodeBinding | undefined;
  let adminId: string, token: string, outputDir: string;
  let pids: { H: number; A: number; D: number; O: number };
  let environment: Record<string, unknown>;
  const receipts: Receipt[] = [];
  let current: Receipt | undefined;
  const pending: Promise<unknown>[] = [];

  function record(evidence: Record<string, unknown>) { current?.evidence.push(evidence); }
  async function save() {
    await writeFile(join(outputDir, "concurrency-receipts.json"), JSON.stringify({
      schemaVersion: 1, scope: "test adapter and real candidate routes; not production PostgreSQL support",
      environment, pids, cases: receipts, transactions: db?.transactions,
    }, null, 2) + "\n");
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    // Attach a rejection observer immediately; original promise retains failure.
    pending.push(promise.catch(() => undefined));
    return promise;
  }
  async function state(connection = O) {
    const config = (await connection.query<{ config: Record<string, unknown> }>(
      "SELECT config FROM agent_instances WHERE id=$1 AND organization_id=$2", [INSTANCE, ORG],
    )).rows[0]!.config;
    const role = (await connection.query<{ role: string }>(
      "SELECT role FROM users WHERE id=$1 AND organization_id=$2", [adminId, ORG],
    )).rows[0]!.role;
    const events = (await connection.query(
      "SELECT actor_type, actor_id, correlation_id, payload FROM event_log WHERE organization_id=$1 AND type='agent_instance.updated' AND correlation_id=$2 ORDER BY position",
      [ORG, INSTANCE],
    )).rows;
    return { config, role, events };
  }
  function assertMutation(actual: Awaited<ReturnType<typeof state>>, method: Method, role: "admin" | "member") {
    const after = method === "PATCH" ? AFTER : null;
    expect(actual).toEqual({
      config: method === "PATCH" ? { ...RETAINED, worktree_workspace_base: AFTER } : RETAINED,
      role,
      events: [{ actor_type: "user", actor_id: adminId, correlation_id: INSTANCE,
        payload: { agent_instance_id: INSTANCE, computer_id: COMPUTER,
          worktree_workspace_base: { before: BEFORE, after } } }],
    });
  }
  function request(method: Method) {
    return track(Promise.resolve(app!.inject({ method, url: ENDPOINT, headers: { authorization: `Bearer ${token}` },
      ...(method === "PATCH" ? { payload: AFTER } : {}),
    })));
  }
  async function blocked(blockedPid: number, blockerPid: number, label: string) {
    const deadline = performance.now() + 8000;
    let last: unknown;
    let transientStatsSamples = 0;
    while (performance.now() < deadline) {
      const row = (await O.query<{ pid: number; blockers: number[]; wait_event_type: string | null; wait_event: string | null; state: string }>(
        "SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, wait_event, state FROM pg_stat_activity WHERE pid=$1", [blockedPid],
      )).rows[0];
      last = row;
      if (row?.blockers.includes(blockerPid) && row.wait_event_type !== "Lock") {
        // Lock-manager blockers and backend activity stats can be observed at
        // different instants. Keep polling until BOTH required fields agree;
        // preserve initial transient samples instead of accepting one alone.
        transientStatsSamples++;
        if (transientStatsSamples <= 3) record({ barrier: label, transientStatsSample: row });
      }
      if (row?.blockers.includes(blockerPid) && row.wait_event_type === "Lock") {
        expect(row.wait_event_type).toBe("Lock");
        record({ barrier: label, observation: row, transientStatsSamples });
        return;
      }
      await setImmediate(); // Yield only. Success is the observed database blocker.
    }
    record({ barrier: label, timedOut: true, lastObservation: last, transientStatsSamples });
    throw new Error(`Expected observed database blocker ${blockerPid} for ${blockedPid}: ${label}`);
  }
  function routeTransaction(): TransactionReceipt {
    const receipt = db.transactions.at(-1)!;
    expect(receipt.state).toBe("active");
    expect(receipt.backendPid).toBe(pids.A);
    expect(receipt.isolation).toBe("read committed");
    return receipt;
  }
  async function demote() {
    const result = await D.query<{ role: string }>(
      "UPDATE users SET role='member' WHERE id=$1 AND organization_id=$2 RETURNING role", [adminId, ORG],
    );
    expect(result.rows).toEqual([{ role: "member" }]);
  }
  async function caseReceipt(name: string, body: () => Promise<void>) {
    current = { name, state: "running", evidence: [] };
    receipts.push(current);
    try { await body(); current.state = "passed"; }
    catch (error) {
      current.state = "failed";
      record({ failure: error instanceof Error ? error.message : "Non-Error failure" });
      throw error;
    } finally { await save(); }
  }

  beforeAll(async () => {
    const owned = await ownedConnectionConfig("admin");
    outputDir = owned.outputDir;
    db = await PgHarnessDbClient.create({ ...owned.config, application_name: "artoo_owned_A_route" });
    H = new pg.Client({ ...owned.config, application_name: "artoo_owned_H_barrier" });
    D = new pg.Client({ ...owned.config, application_name: "artoo_owned_D_demotion" });
    O = new pg.Client({ ...owned.config, application_name: "artoo_owned_O_observer" });
    await Promise.all([H.connect(), D.connect(), O.connect()]);
    const pid = async (client: pg.Client) => (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    pids = { H: await pid(H), A: db.backendPid, D: await pid(D), O: await pid(O) };
    expect(new Set(Object.values(pids)).size).toBe(4);
    environment = (await O.query("SELECT version(), current_database() AS database, current_user AS username, current_setting('listen_addresses') AS listen_addresses, current_setting('transaction_isolation') AS isolation")).rows[0]!;
    expect(environment.listen_addresses).toBe("");
    expect(environment.database).toBe("artoo_concurrency");
    expect(environment.username).toBe("artoo_harness");
    expect(environment.isolation).toBe("read committed");
    expect(String(environment.version)).toMatch(/^PostgreSQL 17\.11 /);
    await db.migrate(await loadMigrationStatements());
  });

  beforeEach(async () => {
    current = undefined;
    const tables = (await O.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    await O.query(`TRUNCATE TABLE ${tables.map((row) => `public.${quote(row.tablename)}`).join(", ")} RESTART IDENTITY CASCADE`);
    await seed(db, NOW, { workspaceRoot: "C:/Owned/Unused/Fixture" });
    await O.query("UPDATE agent_instances SET id=$1, config=$2 WHERE id='instance_mock_coder'", [INSTANCE, INITIAL_CONFIG]);
    let sequence = 0;
    const ctx: ServerContext = {
      db, clock: { now: () => new Date(NOW), nowIso: () => NOW },
      idGen: { generate: (prefix) => `${prefix}_pg_${++sequence}` },
      organizationId: ORG, actorUserId: "user_owner",
      authConfig: testAuthConfig({ enforceApiAuth: true, ownerEmails: ["owner@artoo.dev"],
        allowedEmails: ["owner@artoo.dev", "admin-concurrency@example.test"] }),
      deviceAuth: testDeviceAuthConfig({ devNodeToken: null, devControlEscape: false }),
      // This test uses real provision/session functions, never an OIDC exchange.
      // Fail if an unrelated route unexpectedly attempts an identity-provider call.
      oidcHttp: { async exchangeCode() { throw new Error("Unexpected OIDC transport call"); },
        async fetchJwks() { throw new Error("Unexpected OIDC transport call"); } },
    };
    const provisioned = await provisionUser(ctx, { subject: "admin-concurrency", email: "admin-concurrency@example.test", emailVerified: true, displayName: "Concurrency Admin" });
    adminId = provisioned.userId;
    await db.db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
    token = (await createSession(ctx, { ttlMs: 3_600_000 }, { userId: adminId })).raw;
    expect(ctx.authConfig.ownerEmails).not.toContain("admin-concurrency@example.test");
    const registry = createNodeRegistry();
    app = buildApp(ctx, { nodeRegistry: registry, assistantDispatcher: false,
      resetPresenceOnStart: false, budgetMonitorIntervalMs: false, enableDevRoutes: false });
    await app.ready();
    const transport: NodeTransport = {
      async send() { throw new Error("Configuration must not dispatch execution"); },
      subscribe() { return () => {}; }, async close() {},
    };
    // Qualified metadata fixture only; the separate WS gate owns session negotiation.
    const fixtureQualified = true;
    binding = attachNodeBinding(ctx, transport, COMPUTER, ["workspace-allocation.per-run-v1"],
      () => fixtureQualified && registry.get(COMPUTER) === binding);
    registry.register(COMPUTER, binding);
    expect(ctx.supportsExecutionFeature?.(COMPUTER, "workspace-allocation.per-run-v1")).toBe(true);
    expect(await state()).toEqual({ config: INITIAL_CONFIG, role: "admin", events: [] });
  });

  afterEach(async () => {
    // Release H before awaiting D, so the event-barrier chain can unwind.
    await H.query("ROLLBACK");
    await H.query("SELECT pg_advisory_unlock_all()");
    await D.query("ROLLBACK");
    await Promise.all(pending.splice(0));
    binding?.close(); binding = undefined;
    await app?.close(); app = undefined;
    await O.query("DROP TRIGGER IF EXISTS admin_candidate_event_barrier ON event_log; DROP FUNCTION IF EXISTS admin_candidate_event_barrier()");
    await save();
  });
  afterAll(async () => {
    if (outputDir) await save();
    const results = await Promise.allSettled([H?.end(), D?.end(), O?.end(), db?.close()]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new Error(`Failed to close ${failures.length} owned connection(s)`);
  });

  for (const method of ["PATCH", "DELETE"] as const) {
    for (const control of ["committed-before-release", "actor-wait-commit", "actor-wait-rollback"] as const) {
      it(`${method}: demotion while route waits for instance (${control})`, () => caseReceipt(`${method}/instance/${control}`, async () => {
        await H.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await H.query("SELECT id FROM agent_instances WHERE id=$1 AND organization_id=$2 FOR UPDATE", [INSTANCE, ORG]);
        const response = request(method);
        await blocked(pids.A, pids.H, "route reached instance FOR UPDATE after initial administrator checks");
        const routeTx = routeTransaction();
        await D.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await demote(); // Must finish while H still owns instance; otherwise fail.
        if (control === "committed-before-release") {
          await D.query("COMMIT");
          expect((await state()).role).toBe("member");
          await blocked(pids.A, pids.H, "demotion committed while instance barrier remained held");
          await H.query("COMMIT");
        } else {
          await H.query("COMMIT");
          await blocked(pids.A, pids.D, "administrator SHARE read waits for uncommitted role update");
          await D.query(control === "actor-wait-commit" ? "COMMIT" : "ROLLBACK");
        }
        const result = await response;
        const final = await state();
        const expectedSuccess = control === "actor-wait-rollback";
        expect(result.statusCode).toBe(expectedSuccess ? 200 : 403);
        if (expectedSuccess) assertMutation(final, method, "admin");
        else expect(final).toEqual({ config: INITIAL_CONFIG, role: "member", events: [] });
        const status = (await O.query<{ status: string }>("SELECT pg_xact_status($1::xid8) AS status", [routeTx.xid])).rows[0]!.status;
        expect(status).toBe(expectedSuccess ? "committed" : "aborted");
        record({ routeTransaction: routeTx, databaseTransactionStatus: status, responseStatus: result.statusCode, final });
      }));
    }

    for (const eventOutcome of ["commit", "forced-rollback"] as const) {
      it(`${method}: SHARE blocks demotion through event ${eventOutcome}`, () => caseReceipt(`${method}/event/${eventOutcome}`, async () => {
        await O.query(`CREATE FUNCTION admin_candidate_event_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.type = 'agent_instance.updated' AND NEW.correlation_id = 'instance_admin_lock_test' THEN
              PERFORM pg_advisory_xact_lock(91342017);
              IF TG_ARGV[0] = 'forced-rollback' THEN
                RAISE EXCEPTION 'owned harness deliberate event rejection' USING ERRCODE = 'P0001';
              END IF;
            END IF;
            RETURN NEW;
          END;
        $$;
        CREATE TRIGGER admin_candidate_event_barrier BEFORE INSERT ON event_log FOR EACH ROW
          EXECUTE FUNCTION admin_candidate_event_barrier('${eventOutcome}');`);
        await H.query("SELECT pg_advisory_lock($1)", [ADVISORY_KEY]);
        const response = request(method);
        await blocked(pids.A, pids.H, "real event INSERT reached owned advisory barrier");
        const routeTx = routeTransaction();
        expect(await state()).toEqual({ config: INITIAL_CONFIG, role: "admin", events: [] });
        await D.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const demotion = track((async () => {
          await demote();
          // This is a database boundary, deliberately before D COMMIT and
          // independent of whether JavaScript delivered A's HTTP response yet.
          const status = (await D.query<{ status: string }>("SELECT pg_xact_status($1::xid8) AS status", [routeTx.xid])).rows[0]!.status;
          const observed = await state(D);
          record({ boundary: "D UPDATE returned before D COMMIT", routeXid: routeTx.xid, databaseTransactionStatus: status, observed });
          expect(status).toBe(eventOutcome === "commit" ? "committed" : "aborted");
          if (eventOutcome === "commit") assertMutation(observed, method, "member");
          else expect(observed).toEqual({ config: INITIAL_CONFIG, role: "member", events: [] });
          await D.query("COMMIT");
        })());
        await blocked(pids.D, pids.A, "role-only UPDATE blocked by actor SHARE until route transaction ends");
        await blocked(pids.A, pids.H, "event barrier still holds route while role-only update waits");
        const unlocked = await H.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1) AS unlocked", [ADVISORY_KEY]);
        expect(unlocked.rows[0]!.unlocked).toBe(true);
        const result = await response;
        await demotion;
        expect(result.statusCode).toBe(eventOutcome === "commit" ? 200 : 500);
        if (eventOutcome === "forced-rollback") expect(routeTx.databaseErrorCode).toBe("P0001");
        const final = await state();
        if (eventOutcome === "commit") assertMutation(final, method, "member");
        else expect(final).toEqual({ config: INITIAL_CONFIG, role: "member", events: [] });
        record({ routeTransaction: routeTx, responseStatus: result.statusCode, final });
      }));
    }
  }
});
