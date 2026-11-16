// Actual production boundary + worker + SQLite. No provider, Git materialization,
// process launch, live scheduler consumer or elapsed rollout acceptance.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { allocateWorkspaceRoot } from "@artoo/protocol";
import {
  openLocalJournal,
  provisionLocalJournal,
  upgradeLocalJournalForOwnedResults,
  upgradeLocalJournalForSchedulerPreparation,
} from "../dist/managed/journal.js";

const native = { skip: process.platform !== "darwin", timeout: 60_000 };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const hasMessage = (error, pattern) =>
  pattern.test(error.message) ||
  (error instanceof AggregateError && error.errors.some((cause) => hasMessage(cause, pattern)));
function proposal(root, suffix = "one") {
  const runId = `run_${suffix}`,
    taskId = `task_${suffix}`,
    instanceId = `ai_${suffix}`,
    base = join(root, "never-materialized");
  const workspace = allocateWorkspaceRoot({
    workspaceRoot: null,
    branchBacked: true,
    targetComputerOs: process.platform,
    agentInstanceId: instanceId,
    runId,
    worktreeBase: { version: 1, strategy: "per-run", basePath: base },
  });
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    version: 1,
    prepared_start: {
      version: 1,
      request_id: `request_${suffix}`,
      request_snapshot_digest: digest,
      organization_id: "org_one",
      project_id: "project_one",
      task_id: taskId,
      actor_user_id: "user_one",
      run_id: runId,
      agent_instance_id: instanceId,
      computer_id: "computer_one",
      device_id: "device_one",
      session_id: "session_one",
      assigned: {
        task_input_version: 1,
        task_input_digest: digest,
        queue_revision: 1,
        policy_revisions: { project: 1, agent: 1, computers: { computer_one: 1 } },
        configuration_digest: digest,
      },
      prepared_run_digest: digest,
      execution_authorized: false,
    },
    run_start: {
      run_id: runId,
      task_id: taskId,
      agent_instance_id: instanceId,
      runtime: "codex",
      workspace: { root: workspace, branch: `fixture/${suffix}` },
      workspace_allocation: { version: 1, strategy: "per-run", base_path: base },
      workspace_retention_reporting: "typed-v1",
      context_pack: {
        id: `context_${suffix}`,
        payload: {
          task: {
            id: taskId,
            title: "Task",
            description: "Controlled preparation",
            acceptance_criteria: ["Checks pass"],
          },
          project: { id: "project_one", name: "Project", default_workspace: null },
          workspace: { root: workspace, file_scope: ["src"] },
          policy: { filesystem_write_scope: ["src"], requires_approval: [] },
          memory: { task_summary: null, project_notes: [] },
          artifacts: { expected: [] },
        },
      },
      policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] },
      artifact_rules: { paths: [] },
    },
  };
}
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}
async function fixture(t, body) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-scheduler-preparation-")));
  const options = {
    directory: join(root, "journal"),
    controllerScope: "scheduler-preparation-fixture",
    nodeId: "computer_one",
  };
  const journals = [];
  let closureUncertain = false;
  const inspect = (sql, ...args) => {
    const database = new DatabaseSync(join(options.directory, "journal.sqlite"), {
      readOnly: true,
      allowExtension: false,
    });
    try {
      return database
        .prepare(sql)
        .all(...args)
        .map((value) => ({ ...value }));
    } finally {
      database.close();
    }
  };
  const edit = (sql) => {
    const database = new DatabaseSync(join(options.directory, "journal.sqlite"), { allowExtension: false });
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
  };
  const open = async () => {
    const journal = await openLocalJournal(options);
    journals.push(journal);
    return journal;
  };
  try {
    const receipt = await provisionLocalJournal(options);
    options.expectedNamespace = receipt.namespace;
    await body({
      root,
      options,
      open,
      inspect,
      edit,
      request: (value) => ({
        expectedNamespace: options.expectedNamespace,
        runId: value.run_start.run_id,
        idempotencyKey: `${value.run_start.run_id}:scheduler-prepare:v1`,
        proposal: value,
      }),
      ordinary: (value) => ({
        expectedNamespace: options.expectedNamespace,
        runId: value.run_start.run_id,
        idempotencyKey: `${value.run_start.run_id}:start`,
        payload: value.run_start,
      }),
    });
  } finally {
    const closures = await Promise.allSettled(journals.map((journal) => journal.close()));
    closureUncertain = closures.some((result) => result.status === "rejected");
    // Every test only prepares metadata; none calls a materializer or producer.
    // Worker closure is still required before deleting its SQLite directory.
    if (closureUncertain) t.diagnostic(`Worker closure uncertain; retain ${root}`);
    assert.equal(closureUncertain, false, `Worker closure uncertain; retain ${root}`);
    const suffix = relative(realpathSync.native(tmpdir()), root);
    assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`));
    assert.equal(realpathSync.native(root), root);
    rmSync(root, { recursive: true, force: true });
  }
}

test("unsupported local platforms reject provisioning without creating the directory", {
  skip: process.platform === "darwin",
}, async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-scheduler-unsupported-"))),
    directory = join(root, "journal");
  try {
    await assert.rejects(
      provisionLocalJournal({ directory, controllerScope: "fixture", nodeId: "computer_one" }),
      /macOS/,
    );
    assert.equal(existsSync(directory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit v3/v4 to v5 migration preserves history, inode and verified closed-file backup", native, async (t) =>
  fixture(t, async (f) => {
    let journal = await f.open();
    assert.equal(journal.schedulerPreparationVersion, undefined);
    await assert.rejects(journal.prepareSchedulerStart(f.request(proposal(f.root))), /explicit offline/);
    const fence = await journal.requestStop({ expectedNamespace: journal.namespace, runId: "run_fenced" });
    await journal.close();
    const database = join(f.options.directory, "journal.sqlite"),
      backup = join(f.root, "v3.sqlite"),
      beforeInode = statSync(database).ino;
    copyFileSync(database, backup);
    assert.equal(hash(readFileSync(backup)), hash(readFileSync(database)));
    assert.equal((await upgradeLocalJournalForSchedulerPreparation(f.options)).schemaVersion, 5);
    assert.equal(statSync(database).ino, beforeInode);
    assert.equal(f.inspect("PRAGMA user_version")[0].user_version, 5);
    assert.equal(
      (await upgradeLocalJournalForOwnedResults(f.options)).schemaVersion,
      5,
      "old upgrade API must report the actual version, never downgrade",
    );
    journal = await f.open();
    assert.equal(journal.schedulerPreparationVersion, 1);
    assert.equal(journal.ownedResultFinalizationVersion, 1);
    assert.deepEqual(await journal.lookupRun({ expectedNamespace: journal.namespace, runId: "run_fenced" }), fence);
    assert.equal(f.inspect("SELECT count(*) AS count FROM scheduler_preparations")[0].count, 0);
    await journal.close();
    // No preparation/work has been admitted since the backup. Restore in place
    // only while closed; this checks old evidence, never resurrects an attempt.
    writeFileSync(database, readFileSync(backup));
    assert.equal(statSync(database).ino, beforeInode);
    journal = await f.open();
    assert.equal(journal.schedulerPreparationVersion, undefined);
    assert.deepEqual(await journal.lookupRun({ expectedNamespace: journal.namespace, runId: "run_fenced" }), fence);
    await journal.close();
    assert.equal((await upgradeLocalJournalForOwnedResults(f.options)).schemaVersion, 4);
    assert.equal((await upgradeLocalJournalForSchedulerPreparation(f.options)).schemaVersion, 5);
    assert.equal((await upgradeLocalJournalForSchedulerPreparation(f.options)).schemaVersion, 5);
  }),
);

test("preparation is atomic, immutable, bounded, and grants no ordinary or forged launch permit", native, async (t) =>
  fixture(t, async (f) => {
    await upgradeLocalJournalForSchedulerPreparation(f.options);
    const journal = await f.open(),
      value = proposal(f.root),
      request = f.request(value);
    const prepared = await journal.prepareSchedulerStart(request),
      identity = prepared.run.schedulerPreparation;
    assert.equal(prepared.kind, "prepared");
    assert.equal(prepared.permit, undefined);
    assert.equal(prepared.payload, undefined);
    assert.equal(prepared.run.ownership, "unknown");
    assert.equal(prepared.run.phase, "admitted");
    assert.equal(prepared.run.receipt, null);
    assert.equal(identity.executionAuthorized, false);
    assert.equal(identity.namespace, journal.namespace);
    assert.match(identity.nodeAttemptId, /^[a-f0-9-]{36}$/u);
    assert.match(identity.proposalDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(identity.nodeId, f.options.nodeId);
    assert.equal(identity.requestId, value.prepared_start.request_id);
    assert.equal(identity.sessionId, value.prepared_start.session_id);
    assert.equal(Object.isFrozen(identity), true);
    const rows = f.inspect("SELECT owner_nonce,owner_incarnation,phase FROM runs");
    assert.deepEqual(rows, [{ owner_nonce: null, owner_incarnation: null, phase: "admitted" }]);
    assert.equal(
      f.inspect("SELECT owner_incarnation FROM scheduler_preparations")[0].owner_incarnation,
      journal.incarnation,
    );
    assert.equal(JSON.stringify(prepared).includes("nonce"), false);
    assert.equal(existsSync(value.run_start.workspace_allocation.base_path), false);
    assert.deepEqual(f.inspect("SELECT * FROM outbox"), []);
    const duplicate = await journal.prepareSchedulerStart(f.request(reverseKeys(value)));
    assert.equal(duplicate.kind, "pending");
    assert.deepEqual(duplicate.run.schedulerPreparation, identity);
    for (const mutate of [
      (changed) => {
        changed.run_start.runtime = "claude-code";
      },
      (changed) => {
        changed.prepared_start.session_id = "new_session";
      },
      (changed) => {
        changed.prepared_start.assigned.task_input_version++;
      },
      (changed) => {
        changed.run_start.context_pack.payload.task.description = "changed content";
      },
    ]) {
      const changed = clone(value);
      mutate(changed);
      assert.equal((await journal.prepareSchedulerStart(f.request(changed))).kind, "conflict");
    }
    assert.equal((await journal.admitStart(f.ordinary(value))).kind, "conflict");
    const reusedRequest = proposal(f.root, "another_run");
    reusedRequest.prepared_start.request_id = value.prepared_start.request_id;
    assert.equal(
      (await journal.prepareSchedulerStart(f.request(reusedRequest))).kind,
      "conflict",
      "one execution request cannot prepare a second Run",
    );
    const legacy = f.ordinary(value);
    delete legacy.payload.workspace_allocation;
    delete legacy.payload.workspace_retention_reporting;
    assert.equal(
      (await journal.admitStart(legacy)).kind,
      "conflict",
      "removing per-run fields cannot downgrade this Run",
    );
    assert.throws(() => journal.advance(prepared, "preparing"), /fresh journal permit/);
    await assert.rejects(
      journal.startOwnedProcess(prepared, {}, {}, new AbortController().signal),
      /fresh journal permit/,
    );
    assert.equal(f.inspect("SELECT count(*) AS count FROM runs")[0].count, 1);
    assert.equal(f.inspect("SELECT count(*) AS count FROM scheduler_preparations")[0].count, 1);
    await journal.close();
    assert.throws(() => f.edit("UPDATE scheduler_preparations SET node_attempt_id='rewritten'"), /immutable/);
    assert.throws(() => f.edit("DELETE FROM scheduler_preparations"), /immutable/);
  }),
);

test(
  "only the freshly observed preparation can create one private ready window, never a launch permit",
  native,
  async (t) =>
    fixture(t, async (f) => {
      await upgradeLocalJournalForSchedulerPreparation(f.options);
      const journal = await f.open(),
        value = proposal(f.root),
        request = f.request(value);
      const result = await journal.prepareSchedulerStart(request);
      assert.equal(result.kind, "prepared");
      assert.equal(Object.isFrozen(result.preparation), true);
      const signal = new AbortController();
      assert.throws(
        () => journal.beginSchedulerReady(structuredClone(result.preparation), signal.signal),
        /fresh local/,
      );
      const ready = journal.beginSchedulerReady(result.preparation, signal.signal);
      assert.throws(() => journal.beginSchedulerReady(result.preparation, signal.signal), /fresh local/);
      assert.equal((await journal.prepareSchedulerStart(request)).preparation, undefined);
      const original = value.prepared_start,
        now = Date.now();
      const response = {
        version: 1,
        remaining_ms: 5000,
        grant: {
          ...ready.ready,
          scope: "scheduler-start.once.v1",
          grant_id: randomUUID(),
          organization_id: original.organization_id,
          project_id: original.project_id,
          task_id: original.task_id,
          actor_user_id: original.actor_user_id,
          agent_instance_id: original.agent_instance_id,
          computer_id: original.computer_id,
          device_id: original.device_id,
          session_id: original.session_id,
          issued_at: new Date(now).toISOString(),
          expires_at: new Date(now + 5000).toISOString(),
        },
      };
      const window = journal.acceptSchedulerStartGrant(ready.exchange, response);
      journal.assertSchedulerStartWindow(window);
      assert.throws(() => journal.advance(window, "preparing"), /fresh journal permit/);
      assert.throws(() => journal.acceptSchedulerStartGrant(ready.exchange, response), /original local/);
      assert.deepEqual(f.inspect("SELECT owner_nonce,owner_incarnation,phase FROM runs"), [
        { owner_nonce: null, owner_incarnation: null, phase: "admitted" },
      ]);
      assert.equal(existsSync(value.run_start.workspace_allocation.base_path), false);
      signal.abort(new Error("Original fixture channel ended"));
      assert.throws(() => journal.assertSchedulerStartWindow(window), /Original fixture channel ended/);
      await journal.close();
      const reopened = await f.open();
      assert.equal((await reopened.prepareSchedulerStart(request)).preparation, undefined);
      assert.throws(() => reopened.assertSchedulerStartWindow(window), /private/);
    }),
);

test(
  "independent workers contend once, and lost-response/restart replay never reacquires a fresh attempt",
  native,
  async (t) =>
    fixture(t, async (f) => {
      await upgradeLocalJournalForSchedulerPreparation(f.options);
      const first = await f.open(),
        second = await f.open(),
        value = proposal(f.root),
        request = f.request(value);
      const results = await Promise.all([first.prepareSchedulerStart(request), second.prepareSchedulerStart(request)]);
      assert.deepEqual(results.map((result) => result.kind).sort(), ["prepared", "unknown"]);
      assert.deepEqual(results[0].run.schedulerPreparation, results[1].run.schedulerPreparation);
      const identity = results[0].run.schedulerPreparation;
      await Promise.all([first.close(), second.close()]);
      const reopened = await f.open();
      // Treat the successful first response as lost: only persisted data is reused.
      const replay = await reopened.prepareSchedulerStart(request);
      assert.equal(replay.kind, "unknown");
      assert.deepEqual(replay.run.schedulerPreparation, identity);
      assert.equal(replay.permit, undefined);
      assert.equal((await reopened.admitStart(f.ordinary(value))).kind, "conflict");
      assert.equal(f.inspect("SELECT count(*) AS count FROM scheduler_preparations")[0].count, 1);
      const stopped = await reopened.requestStop({
        expectedNamespace: reopened.namespace,
        runId: value.run_start.run_id,
      });
      assert.equal(stopped.receipt.kind, "not_started_fenced");
      assert.equal(stopped.phase, "closed");
      assert.equal((await reopened.prepareSchedulerStart(request)).kind, "fenced");
      assert.equal((await reopened.admitStart(f.ordinary(value))).kind, "fenced");
      await reopened.close();
      const last = await f.open();
      assert.equal((await last.prepareSchedulerStart(request)).kind, "fenced");
      assert.deepEqual(
        (await last.lookupRun({ expectedNamespace: last.namespace, runId: value.run_start.run_id }))
          .schedulerPreparation,
        identity,
      );
    }),
);

test(
  "preparation conflicts with an ordinary claim or an earlier unbound stop; ordinary mode stays available",
  native,
  async (t) =>
    fixture(t, async (f) => {
      await upgradeLocalJournalForSchedulerPreparation(f.options);
      const journal = await f.open(),
        ordinary = proposal(f.root, "ordinary"),
        stopped = proposal(f.root, "stopped");
      const admitted = await journal.admitStart(f.ordinary(ordinary));
      assert.equal(admitted.kind, "fresh");
      assert.equal((await journal.prepareSchedulerStart(f.request(ordinary))).kind, "conflict");
      assert.equal((await journal.advance(admitted.permit, "preparing")).phase, "preparing");
      await journal.requestStop({ expectedNamespace: journal.namespace, runId: stopped.run_start.run_id });
      assert.equal((await journal.prepareSchedulerStart(f.request(stopped))).kind, "fenced");
      assert.equal(f.inspect("SELECT count(*) AS count FROM scheduler_preparations")[0].count, 0);
      await journal.close();
      const before = hash(readFileSync(join(f.options.directory, "journal.sqlite")));
      await assert.rejects(
        upgradeLocalJournalForOwnedResults(f.options),
        (error) =>
          /retained live\/unknown/.test(error.message) ||
          (error instanceof AggregateError &&
            error.errors.some((cause) => /retained live\/unknown/.test(cause.message))),
      );
      assert.equal(
        hash(readFileSync(join(f.options.directory, "journal.sqlite"))),
        before,
        "failed offline migration preserves durable bytes",
      );
    }),
);

test("a failed attempt insert rolls back the reserved Run as well", native, async (t) =>
  fixture(t, async (f) => {
    await upgradeLocalJournalForSchedulerPreparation(f.options);
    f.edit(
      "CREATE TRIGGER fixture_fail_preparation BEFORE INSERT ON scheduler_preparations BEGIN SELECT RAISE(ABORT,'fixture attempt failure'); END",
    );
    const journal = await f.open(),
      value = proposal(f.root);
    await assert.rejects(journal.prepareSchedulerStart(f.request(value)), /fixture attempt failure/);
    await journal.close();
    assert.deepEqual(f.inspect("SELECT * FROM runs"), []);
    assert.deepEqual(f.inspect("SELECT * FROM scheduler_preparations"), []);
    f.edit("DROP TRIGGER fixture_fail_preparation");
    const next = await f.open();
    assert.equal((await next.prepareSchedulerStart(f.request(value))).kind, "prepared");
  }),
);

test(
  "wrong namespace/run/node/key, legacy allocation and unknown fields reject before persistence",
  native,
  async (t) =>
    fixture(t, async (f) => {
      await upgradeLocalJournalForSchedulerPreparation(f.options);
      const journal = await f.open(),
        value = proposal(f.root);
      for (const mutate of [
        (request) => {
          request.expectedNamespace = "wrong";
        },
        (request) => {
          request.runId = "run_other";
          request.idempotencyKey = "run_other:scheduler-prepare:v1";
        },
        (request) => {
          request.idempotencyKey = `${request.runId}:start`;
        },
        (request) => {
          request.proposal.prepared_start.computer_id = "computer_other";
        },
        (request) => {
          delete request.proposal.run_start.workspace_allocation;
        },
        (request) => {
          request.proposal.run_start.workspace.root += "-different";
        },
        (request) => {
          request.proposal.run_start.context_pack.payload.task.approved = true;
        },
      ]) {
        const request = f.request(clone(value));
        mutate(request);
        await assert.rejects(journal.prepareSchedulerStart(request));
      }
      assert.deepEqual(f.inspect("SELECT * FROM runs"), []);
      assert.deepEqual(f.inspect("SELECT * FROM scheduler_preparations"), []);
      assert.equal(existsSync(value.run_start.workspace_allocation.base_path), false);
    }),
);

test("v3 migration rejects a retained unknown Run without changing any durable bytes", native, async (t) =>
  fixture(t, async (f) => {
    const journal = await f.open(),
      value = proposal(f.root);
    assert.equal((await journal.admitStart(f.ordinary(value))).kind, "fresh");
    await journal.close();
    const database = join(f.options.directory, "journal.sqlite"),
      before = hash(readFileSync(database));
    await assert.rejects(upgradeLocalJournalForSchedulerPreparation(f.options), (error) =>
      hasMessage(error, /retained live\/unknown/),
    );
    assert.equal(f.inspect("PRAGMA user_version")[0].user_version, 3);
    assert.equal(hash(readFileSync(database)), before);
    const reopened = await f.open();
    assert.equal(reopened.schedulerPreparationVersion, undefined);
    assert.equal((await reopened.admitStart(f.ordinary(value))).kind, "unknown");
  }),
);

test("incomplete extensions and future journal versions reject open without resetting history", native, async (t) =>
  fixture(t, async (f) => {
    await upgradeLocalJournalForSchedulerPreparation(f.options);
    const database = join(f.options.directory, "journal.sqlite");
    f.edit("PRAGMA user_version=6");
    let before = hash(readFileSync(database));
    await assert.rejects(openLocalJournal(f.options), (error) => hasMessage(error, /metadata continuity/));
    assert.equal(hash(readFileSync(database)), before);
    f.edit("PRAGMA user_version=5; DROP TRIGGER scheduler_preparations_immutable_update");
    before = hash(readFileSync(database));
    await assert.rejects(openLocalJournal(f.options), (error) => hasMessage(error, /extension is incomplete/));
    assert.equal(hash(readFileSync(database)), before);
    assert.equal(f.inspect("PRAGMA user_version")[0].user_version, 5);
  }),
);
