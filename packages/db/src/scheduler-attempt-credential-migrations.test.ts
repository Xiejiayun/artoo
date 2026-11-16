import { PgliteDbClient } from "@artoo/storage";
import { SchedulerExecutionLeaseBindingV1Schema, SchedulerStartGrantV1Schema } from "@artoo/domain";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("adds attempt credentials without backfill and preserves bounded immutable secrets through rollback and restore", async () => {
  const leases = await loadMigrationStatements("0074_scheduler_execution_leases.sql");
  let db = await PgliteDbClient.create();
  const now = "2026-06-13T00:00:00.000123Z",
    digest = `sha256:${"a".repeat(64)}`;
  try {
    await db.migrate(leases);
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
    await db.db.execute(sql`INSERT INTO scheduler_prepared_starts (request_id,run_id,snapshot,snapshot_digest,created_at)
      VALUES ('prepared-request','prepared-run',${JSON.stringify(snapshot)}::jsonb,${digest},${now})`);
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
      db.db.execute(sql`INSERT INTO scheduler_start_grants
      (request_id,run_id,organization_id,journal_namespace,node_attempt_id,grant_id,snapshot,snapshot_digest,issued_at,expires_at)
      VALUES ('prepared-request','prepared-run',${value.organization_id},${value.journal_namespace},${value.node_attempt_id},${value.grant_id},
      ${JSON.stringify(value)}::jsonb,${digest},${value.issued_at},${value.expires_at})`);
    await insertGrant(grant);
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
      db.db.execute(sql`
      INSERT INTO scheduler_execution_leases (id,request_id,organization_id,project_id,task_id,epoch,binding,state,claimed_at,observed_at,expires_at)
      VALUES (${value.lease_id},${value.request_id},${value.organization_id},${value.project_id},${value.task_id},${value.epoch},${JSON.stringify(value)}::jsonb,
      'active',${claimTime},${claimTime},${expiresTime})`);
    await insertLease(leaseBinding);
    const baseline = (await db.db.execute(sql`SELECT * FROM scheduler_execution_leases`)).rows;
    const credentials = await loadMigrationStatements("0075_scheduler_attempt_credentials.sql");
    expect(credentials.slice(0, leases.length)).toEqual(leases);
    await expect(db.migrate([...credentials, "SELECT 1/0"])).rejects.toThrow();
    expect((await db.db.execute(sql`SELECT to_regclass('public.scheduler_attempt_credentials') AS name`)).rows).toEqual(
      [{ name: null }],
    );
    await db.migrate(credentials);
    await db.migrate(credentials);
    expect((await db.db.execute(sql`SELECT * FROM scheduler_execution_leases`)).rows).toEqual(baseline);
    expect((await db.db.execute(sql`SELECT * FROM scheduler_attempt_credentials`)).rows).toEqual([]);
    const insertCredential = (hash = "a".repeat(64), expiresAt = expires) =>
      db.db.execute(sql`
      INSERT INTO scheduler_attempt_credentials (id,lease_id,secret_hash,created_at,observed_at,expires_at)
      VALUES ('credential',${leaseBinding.lease_id},${hash},${claimed},${claimed},${expiresAt})`);
    await expect(insertCredential("plain-secret")).rejects.toThrow();
    await expect(insertCredential("a".repeat(64), "infinity")).rejects.toThrow();
    await expect(insertCredential("a".repeat(64), "2026-06-13T00:00:32.000124Z")).rejects.toThrow();
    await insertCredential();
    for (const edit of [
      sql`DELETE FROM scheduler_attempt_credentials`,
      sql`UPDATE scheduler_attempt_credentials SET id='rewritten'`,
      sql`UPDATE scheduler_attempt_credentials SET secret_hash=repeat('b',64)`,
      sql`UPDATE scheduler_attempt_credentials SET observed_at=observed_at - interval '1 microsecond'`,
      sql`UPDATE scheduler_attempt_credentials SET expires_at=expires_at - interval '1 microsecond'`,
      sql`UPDATE scheduler_attempt_credentials SET observed_at=expires_at`,
      sql`UPDATE scheduler_attempt_credentials SET expires_at=expires_at + interval '1 microsecond'`,
      sql`UPDATE scheduler_attempt_credentials SET revoked_at=observed_at + interval '1 microsecond'`,
    ])
      await expect(db.db.execute(edit)).rejects.toThrow();
    const saved = (await db.db.execute(sql`SELECT * FROM scheduler_attempt_credentials`)).rows;
    const archive = await db.backup();
    await db.close();
    db = await PgliteDbClient.create({ archive });
    await db.migrate(credentials);
    expect((await db.db.execute(sql`SELECT * FROM scheduler_attempt_credentials`)).rows).toEqual(saved);
    expect(
      (
        await db.db.execute(
          sql`SELECT to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed FROM scheduler_attempt_credentials`,
        )
      ).rows,
    ).toEqual([{ observed: claimed }]);
    // Logical lease expiry revokes the associated secret without changing Run or file reservations.
    await db.db.execute(
      sql`UPDATE scheduler_execution_leases SET state='expired',observed_at=expires_at,closed_at=expires_at`,
    );
    expect(
      (await db.db.execute(sql`SELECT revoked_at=observed_at AS closed FROM scheduler_attempt_credentials`)).rows,
    ).toEqual([{ closed: true }]);
    await expect(
      db.db.execute(
        sql`UPDATE scheduler_attempt_credentials SET revoked_at=NULL,expires_at=expires_at + interval '1 second'`,
      ),
    ).rejects.toThrow();
    expect((await db.db.execute(sql`SELECT status FROM runs WHERE id='prepared-run'`)).rows).toEqual([
      { status: "queued" },
    ]);
  } finally {
    await db.close();
  }
});
