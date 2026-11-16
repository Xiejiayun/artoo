import { PgliteDbClient } from "@artoo/storage";
import {
  SchedulerExecutionLeaseBindingV1Schema,
  SchedulerPreparedStartSnapshotV1Schema,
  SchedulerStartGrantV1Schema,
} from "@artoo/domain";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("adds prepared-start history without inventing snapshots for consumed requests and restores immutable bindings", async () => {
  const before = await loadMigrationStatements("0071_scheduler_execution_consumption.sql");
  const after = await loadMigrationStatements("0072_scheduler_prepared_starts.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(3);
  const db = await PgliteDbClient.create();
  let restored: PgliteDbClient | undefined;
  const now = "2026-06-13T00:00:00.000123Z",
    digest = `sha256:${"a".repeat(64)}`;
  try {
    await db.migrate(before);
    await seed(db, now);
    await db.db.execute(sql`INSERT INTO tasks (id,organization_id,project_id,title,status,assignee_type,assignee_id,created_by_type,created_by_id,created_at,updated_at)
      VALUES ('prepared-task','org_default','proj_artoo','Prepared','assigned','agent','agent_mock_coder','user','user_owner',${now},${now})`);
    await db.db.execute(sql`INSERT INTO devices (id,organization_id,display_name,platform,app_version,computer_id,enrolled_by_user_id,trust,created_at)
      VALUES ('prepared-device','org_default','fixture','linux','fixture','computer_local_mock','user_owner','active',${now})`);
    await db.db.execute(sql`INSERT INTO runs (id,organization_id,task_id,computer_id,agent_instance_id,runtime_id,status,created_at,requested_by_user_id,
      ai_data_sharing_policy_version,workspace_root,workspace_branch,workspace_allocation)
      VALUES ('prepared-run','org_default','prepared-task','computer_local_mock','instance_mock_coder','codex','queued',${now},'user_owner','fixture-policy',
      '/fixture/claim','artoo/run-prepared-run','{"version":1,"strategy":"per-run","base_path":"/fixture"}'::jsonb)`);
    await db.db.execute(sql`INSERT INTO scheduler_execution_requests
      (id,organization_id,project_id,task_id,agent_id,actor_user_id,request_key,snapshot,snapshot_digest,created_at)
      VALUES ('prepared-request','org_default','proj_artoo','prepared-task','agent_mock_coder','user_owner','one',
      ${JSON.stringify({
        version: 2,
        organization_id: "org_default",
        project_id: "proj_artoo",
        task_id: "prepared-task",
        actor_user_id: "user_owner",
        request: { version: 2, permission: "execute_once", agent_id: "agent_mock_coder", request_key: "one" },
        ai_sharing: { consent_id: null, policy_version: "fixture-policy" },
      })}::jsonb,${digest},${now})`);
    await db.db.execute(sql`UPDATE scheduler_execution_requests SET state='consumed',consumed_run_id='prepared-run',consumed_device_id='prepared-device',
      consumed_session_id='prepared-session',consumed_at=${now}`);
    const historical = (await db.db.execute(sql`SELECT * FROM scheduler_execution_requests`)).rows;
    await expect(db.migrate([...after, "SELECT 1/0"])).rejects.toThrow();
    expect((await db.db.execute(sql`SELECT to_regclass('public.scheduler_prepared_starts') AS name`)).rows).toEqual([
      { name: null },
    ]);
    await db.migrate(after);
    await db.migrate(after);
    expect((await db.db.execute(sql`SELECT * FROM scheduler_execution_requests`)).rows).toEqual(historical);
    expect((await db.db.execute(sql`SELECT * FROM scheduler_prepared_starts`)).rows).toEqual([]);
    const snapshot = {
      version: 1,
      request_id: "prepared-request",
      request_snapshot_digest: digest,
      organization_id: "org_default",
      project_id: "proj_artoo",
      task_id: "prepared-task",
      actor_user_id: "user_owner",
      run_id: "prepared-run",
      agent_instance_id: "instance_mock_coder",
      computer_id: "computer_local_mock",
      device_id: "prepared-device",
      session_id: "prepared-session",
      execution_authorized: false,
      assigned: {
        task_input_version: 1,
        task_input_digest: digest,
        queue_revision: null,
        policy_revisions: { project: 1, agent: 1, computers: { computer_local_mock: 1 } },
        configuration_digest: digest,
      },
      prepared_run_digest: digest,
    };
    expect(SchedulerPreparedStartSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    for (const invalid of [
      { ...snapshot, execution_authorized: true },
      { ...snapshot, permission: "execute_once" },
      { ...snapshot, version: 2 },
      { ...snapshot, assigned: {} },
      { ...snapshot, prepared_run_digest: "invalid" },
    ])
      expect(SchedulerPreparedStartSnapshotV1Schema.safeParse(invalid).success).toBe(false);
    const insert = (value: object) =>
      db.db.execute(sql`INSERT INTO scheduler_prepared_starts (request_id,run_id,snapshot,snapshot_digest,created_at)
      VALUES ('prepared-request','prepared-run',${JSON.stringify(value)}::jsonb,${digest},${now})`);
    for (const [key, value] of Object.entries({
      version: 2,
      request_id: "different",
      request_snapshot_digest: `sha256:${"b".repeat(64)}`,
      organization_id: "other",
      project_id: "other",
      task_id: "other",
      actor_user_id: "other",
      run_id: "other",
      agent_instance_id: "other",
      computer_id: "other",
      device_id: "other",
      session_id: "other",
      execution_authorized: true,
    }))
      await expect(insert({ ...snapshot, [key]: value })).rejects.toThrow();
    await db.db.execute(sql`UPDATE runs SET status='starting' WHERE id='prepared-run'`);
    await expect(insert(snapshot)).rejects.toMatchObject({
      cause: { code: "P0001", message: "Prepared scheduling start requires its exact consumed assignment" },
    });
    await db.db.execute(sql`UPDATE runs SET status='queued' WHERE id='prepared-run'`);
    await insert(snapshot);
    const saved = (await db.db.execute(sql`SELECT * FROM scheduler_prepared_starts`)).rows;
    restored = await PgliteDbClient.create({ archive: await db.backup() });
    await restored.migrate(after);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_prepared_starts`)).rows).toEqual(saved);
    await expect(restored.db.execute(sql`DELETE FROM scheduler_prepared_starts`)).rejects.toMatchObject({
      cause: { code: "P0001", message: "Prepared scheduling start history is immutable" },
    });
    await expect(restored.db.execute(sql`UPDATE scheduler_prepared_starts SET created_at=now()`)).rejects.toMatchObject(
      {
        cause: { code: "P0001", message: "Prepared scheduling start history is immutable" },
      },
    );
    const grants = await loadMigrationStatements("0073_scheduler_start_grants.sql");
    expect(grants.slice(0, after.length)).toEqual(after);
    expect(grants.length - after.length).toBe(3);
    await expect(restored.migrate([...grants, "SELECT 1/0"])).rejects.toThrow();
    expect((await restored.db.execute(sql`SELECT to_regclass('public.scheduler_start_grants') AS name`)).rows).toEqual([
      { name: null },
    ]);
    await restored.migrate(grants);
    await restored.migrate(grants);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_prepared_starts`)).rows).toEqual(saved);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_start_grants`)).rows).toEqual([]);
    const {
      request_snapshot_digest: _requestDigest,
      assigned: _assigned,
      prepared_run_digest: _runDigest,
      execution_authorized: _authority,
      ...binding
    } = snapshot;
    const grant = SchedulerStartGrantV1Schema.parse({
      ...binding,
      scope: "scheduler-start.once.v1",
      journal_namespace: randomUUID(),
      node_attempt_id: randomUUID(),
      ready_id: randomUUID(),
      grant_id: randomUUID(),
      proposal_digest: digest,
      issued_at: "2026-06-13T00:00:01.000Z",
      expires_at: "2026-06-13T00:00:06.000Z",
    });
    const insertGrant = (value: typeof grant) =>
      restored!.db.execute(sql`INSERT INTO scheduler_start_grants
      (request_id,run_id,organization_id,journal_namespace,node_attempt_id,grant_id,snapshot,snapshot_digest,issued_at,expires_at)
      VALUES ('prepared-request','prepared-run',${value.organization_id},${value.journal_namespace},${value.node_attempt_id},${value.grant_id},
      ${JSON.stringify(value)}::jsonb,${digest},${value.issued_at},${value.expires_at})`);
    for (const [key, value] of Object.entries({
      version: 2,
      scope: "other",
      request_id: "other",
      run_id: "other",
      organization_id: "other",
      project_id: "other",
      task_id: "other",
      actor_user_id: "other",
      agent_instance_id: "other",
      computer_id: "other",
      device_id: "other",
      session_id: "other",
      issued_at: "2026-06-12T00:00:00.000Z",
      expires_at: "2026-06-13T00:00:06.001Z",
    }))
      await expect(insertGrant({ ...grant, [key]: value })).rejects.toThrow();
    await restored.db.execute(sql`UPDATE runs SET status='starting' WHERE id='prepared-run'`);
    await expect(insertGrant(grant)).rejects.toThrow();
    await restored.db.execute(sql`UPDATE runs SET status='queued' WHERE id='prepared-run'`);
    await insertGrant(grant);
    await expect(insertGrant({ ...grant, node_attempt_id: randomUUID(), grant_id: randomUUID() })).rejects.toThrow();
    const savedGrants = (await restored.db.execute(sql`SELECT * FROM scheduler_start_grants`)).rows;
    const grantArchive = await restored.backup();
    await restored.close();
    restored = await PgliteDbClient.create({ archive: grantArchive });
    await restored.migrate(grants);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_start_grants`)).rows).toEqual(savedGrants);
    for (const edit of [
      sql`UPDATE scheduler_start_grants SET expires_at=now()`,
      sql`DELETE FROM scheduler_start_grants`,
    ])
      await expect(restored.db.execute(edit)).rejects.toMatchObject({
        cause: { code: "P0001", message: "Scheduler start grant history is immutable" },
      });
    const leases = await loadMigrationStatements("0074_scheduler_execution_leases.sql");
    expect(leases.slice(0, grants.length)).toEqual(grants);
    expect(leases.length - grants.length).toBe(5);
    await expect(restored.migrate([...leases, "SELECT 1/0"])).rejects.toThrow();
    expect(
      (await restored.db.execute(sql`SELECT to_regclass('public.scheduler_execution_leases') AS name`)).rows,
    ).toEqual([{ name: null }]);
    await restored.migrate(leases);
    await restored.migrate(leases);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_start_grants`)).rows).toEqual(savedGrants);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_execution_leases`)).rows).toEqual([]);
    const {
      ready_id: _ready,
      proposal_digest: _proposal,
      issued_at: _issued,
      expires_at: _expires,
      ...grantIdentity
    } = grant;
    const leaseBinding = SchedulerExecutionLeaseBindingV1Schema.parse({
      ...grantIdentity,
      scope: "scheduler.execution-lease.v1",
      lease_id: randomUUID(),
      epoch: 1,
    });
    const claimed = "2026-06-13T00:00:02.000123Z",
      expires = "2026-06-13T00:00:32.000123Z";
    const insertLease = (value: typeof leaseBinding, claimTime = claimed, expiresTime = expires) =>
      restored!.db.execute(sql`
      INSERT INTO scheduler_execution_leases (id,request_id,organization_id,project_id,task_id,epoch,binding,state,claimed_at,observed_at,expires_at)
      VALUES (${value.lease_id},${value.request_id},${value.organization_id},${value.project_id},${value.task_id},${value.epoch},${JSON.stringify(value)}::jsonb,
      'active',${claimTime},${claimTime},${expiresTime})`);
    for (const key of Object.keys(leaseBinding)) {
      const changed = key === "version" ? 2 : key === "epoch" ? 2 : key === "lease_id" ? null : "other";
      // The independent lease UUID has no corresponding field in its grant.
      if (key === "lease_id") continue;
      await expect(insertLease({ ...leaseBinding, [key]: changed })).rejects.toThrow();
    }
    await expect(insertLease(leaseBinding, grant.expires_at)).rejects.toThrow();
    await expect(insertLease(leaseBinding, claimed, "infinity")).rejects.toThrow();
    await insertLease(leaseBinding);
    await expect(insertLease({ ...leaseBinding, lease_id: randomUUID(), epoch: 2 })).rejects.toThrow();
    for (const edit of [
      sql`DELETE FROM scheduler_execution_leases`,
      sql`UPDATE scheduler_execution_leases SET binding = binding || '{"session_id":"new"}'::jsonb`,
      sql`UPDATE scheduler_execution_leases SET epoch = 2`,
      sql`UPDATE scheduler_execution_leases SET expires_at = ${claimed}::timestamptz + interval '1 second'`,
      sql`UPDATE scheduler_execution_leases SET observed_at = ${claimed}::timestamptz - interval '1 microsecond'`,
      sql`UPDATE scheduler_execution_leases SET observed_at = expires_at`,
      sql`UPDATE scheduler_execution_leases SET state='expired',closed_at=observed_at`,
      sql`UPDATE scheduler_execution_leases SET state='revoked'`,
      sql`UPDATE scheduler_execution_leases SET state='unknown',closed_at=observed_at`,
    ])
      await expect(restored.db.execute(edit)).rejects.toThrow();
    const leaseSaved = (await restored.db.execute(sql`SELECT * FROM scheduler_execution_leases`)).rows;
    const leaseArchive = await restored.backup();
    await restored.close();
    restored = await PgliteDbClient.create({ archive: leaseArchive });
    await restored.migrate(leases);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_execution_leases`)).rows).toEqual(leaseSaved);
    expect(
      (
        await restored.db.execute(
          sql`SELECT to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed FROM scheduler_execution_leases`,
        )
      ).rows,
    ).toEqual([{ observed: claimed }]);
    await restored.db.execute(
      sql`UPDATE scheduler_execution_leases SET state='expired',observed_at=expires_at,closed_at=expires_at`,
    );
    for (const edit of [
      sql`UPDATE scheduler_execution_leases SET state='active',closed_at=NULL,expires_at=expires_at + interval '30 seconds'`,
      sql`UPDATE scheduler_execution_leases SET state='revoked'`,
      sql`DELETE FROM scheduler_execution_leases`,
    ])
      await expect(restored.db.execute(edit)).rejects.toThrow();
  } finally {
    await restored?.close();
    await db.close();
  }
});
