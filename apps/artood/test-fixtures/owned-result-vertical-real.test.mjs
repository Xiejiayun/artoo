// Controlled real author/verifier + actual NodeClient/managed WS/server ingest and ACK fixture.
import { createOwnedResultServerFixture } from "../../server/test-fixtures/owned-result-server-fixture.mjs";
import { createManagedNodeRunner } from "../dist/managed/managed-node-runner.js";
import { createAdapterRegistry } from "../dist/adapter-registry.js";
import { prepareOwnedResultProfiles } from "../dist/owned-worktree-verification.js";
// Requires the integrated, built domain/protocol/finalizer/journal-v4 drafts.
// node --test apps/artood/test-fixtures/owned-result-vertical-real.test.mjs
// Actual NodeClient command dispatch, author/verifier, SQLite, server persistence
// and real WebSocket ACKs. Controlled code author, not model/provider acceptance.
// Linux opt-in only selects these tests; it does not bypass the production
// macOS journal boundary. A separately reviewed Linux support overlay is required.
// No provider, GoalRunner, product-stage, independent review or publication run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalOwnedResultAuthorContextV1, NodeOwnedResultVerificationEvidenceV1Schema } from "@artoo/domain";
import { allocateWorkspaceRoot } from "@artoo/protocol";
import { createProcessAdapter } from "../dist/process-adapter.js";
import { provisionLocalJournal, upgradeLocalJournalForOwnedResults, openLocalJournal } from "../dist/managed/journal.js";
import { openOwnedWorktreeResults, WorktreeResultsProfileSchema, worktreeResultFailureIsUncertain } from "../dist/owned/worktree-results.js";
import { ownedVerificationDigest } from "../dist/owned/worktree-verification-contract.js";
import { authenticateOwnedResultFinalization, authenticateProjectedOwnedResultVerification, describeOwnedResultProfile,
  finalizeOwnedResultRun, materializeOwnedResultRun, prepareOwnedResultRun,
  prepareOwnedWorktreeVerificationTemplate } from "../dist/owned-worktree-verification.js";

const native = { skip: process.platform !== "darwin"
  && !(process.platform === "linux" && process.env.ARTOO_OWNED_RESULT_JOURNAL_LINUX_OVERLAY === "1"), timeout: 600_000 };
const hex = value => createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, message, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

test("real owned-result command crosses NodeClient, author, finalizer, server commit and replayed ACK", native, async t => {
  await withFixture(t, async f => {
    const verifier = await f.verifier("vertical", 'assert.equal(fs.readFileSync("src/authored.txt", "utf8"), "real vertical author\\n");');
    const profiles = await f.observe(prepareOwnedResultProfiles(f.profile.node_id, [{ store: f.store, template: verifier.template }]));
    const server = await createOwnedResultServerFixture({ workspaceRoot: f.repo, allocationBase: join(f.root, "authors"), runtime: "fixture" });
    let runner, runnerError;
    const marker = join(f.root, "actual-author.json"), script = join(f.root, "controlled-author.mjs");
    writeFileSync(script, `import * as fs from "node:fs";\nimport assert from "node:assert/strict";\n`
      + `assert.ok(fs.readFileSync("context_pack.md", "utf8").includes("Native owned-result vertical fixture"));\n`
      + `assert.equal(fs.readFileSync("src/common.txt", "utf8"), "fixed baseline\\n");\n`
      + `fs.writeFileSync("src/authored.txt", "real vertical author\\n");\n`
      + `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,cwd:process.cwd()}), {flag:"wx"});\n`, { flag: "wx" });
    try {
      const adapter = createProcessAdapter({ runtimeId: "fixture", command: [process.execPath, script], allowedRoots: [f.root] });
      const registry = createAdapterRegistry([{ runtime: "fixture", adapter, capabilities: ["code.read", "code.modify"] }]);
      runner = createManagedNodeRunner({ url: server.url, hello: { kind: "node.hello", node_id: f.profile.node_id,
        protocol_version: "2026-06-11", artood_version: "controlled-native-fixture", machine: { hostname: "native-vertical-fixture", os: process.platform, arch: process.arch } },
        journal: f.journal, ownedResultProfiles: profiles, registry, WebSocketImpl: server.WebSocketImpl,
        workspace: { worktreeBaseRepo: f.repo, allowedRoots: [f.root] }, heartbeatIntervalMs: 1000 });
      void runner.failed.then(error => { runnerError = error; });
      await f.observe(runner.start());
      const assigned = await server.assign({ profile: verifier.descriptor });
      await Promise.race([server.waitForCompleted(assigned.run.id), runner.failed.then(error => { throw error; })]);
      const proof = await server.assertReceiptChain(assigned.run.id), replay = await server.replayEvidence(assigned.run.id);
      const request = server.incoming.find(frame => frame.message.type === "run.start.owned-result.v1"
        && frame.message.payload.run_start.run_id === assigned.run.id).message.payload;
      const author = assertExited(marker); assert.equal(author.cwd, request.run_start.workspace.root);
      assert.equal(verifier.executions().length, 1); assertExited(verifier.marker(request.requirement.request_id));
      assert.equal(proof.verification.outcome, "passed"); assert.equal(proof.result.base_commit, f.baseline);
      const durable = await f.observe(f.journal.lookupRun({ expectedNamespace: f.journal.namespace, runId: assigned.run.id }));
      assert.equal(durable.phase, "closed"); assert.equal(durable.receipt.kind, "process_exit_confirmed");
      assert.equal(JSON.parse(durable.finalOutcomeJson).terminal.payload.phase, "completed");
      const delivered = await bounded((async () => {
        for (;;) { const current = await f.observe(f.journal.inspectClosedRunDelivery(f.scope(durable)));
          if (current.state === "delivered") return current; if (current.state === "blocked") throw new Error("Actual ACK persistence is blocked"); await pause(25); }
      })(), "Node did not persist the actual terminal ACK");
      assert.equal(delivered.state, "delivered"); assert.equal(delivered.revision, 0);
      const capture = { version: 1, passed: true, proof, replay, author, request,
        outgoing: server.outgoing.map(({ encoded, at }) => ({ encoded, at })),
        incoming: server.incoming.map(({ message, at }) => ({ message, at })),
        scope: "Actual NodeClient/new command, controlled real author/verifier, original journal, actual Fastify/PGlite ingestion and WebSocket ACK/replay; no model, independent review or publication" };
      assert.ok(process.env.ARTOO_NATIVE_EVIDENCE_DIRECTORY, "Native runner must own an evidence output directory");
      writeFileSync(join(process.env.ARTOO_NATIVE_EVIDENCE_DIRECTORY, "owned-result-vertical.json"), JSON.stringify(capture, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      assert.equal(runnerError, undefined); t.diagnostic(JSON.stringify({ proof, replay, author }));
    } finally {
      try { if (runner) await f.observe(runner.stop()); }
      finally { await server.close(); }
    }
  });
});

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}
function assertClosed(receipt) {
  assert.equal(receipt.kind, "confirmed_closed");
  for (const field of ["childSpawned", "childExitObserved", "childStdioClosed", "groupAbsent"]) assert.equal(receipt.facts?.[field], true, field);
}
function assertExited(marker) {
  assert.equal(existsSync(`${marker}.pending`), false);
  const actual = JSON.parse(readFileSync(marker, "utf8"));
  assert.ok(Number.isInteger(actual.pid) && actual.pid > 0);
  assert.throws(() => process.kill(actual.pid, 0), error => error.code === "ESRCH", "awaited actual process must have exited");
  return actual;
}
async function waitForRunningMarker(marker, pending, label) {
  const controller = new AbortController();
  const poll = async () => {
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker)) {
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error(`${label} did not publish its ready marker`);
      await pause(10);
    }
  };
  try { await Promise.race([poll(), pending.then(() => { throw new Error(`${label} ended before the requested live-process observation`); })]); }
  finally { controller.abort(); }
}

async function withFixture(t, body) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-result-vertical-")));
  const repo = join(root, "repository"), state = join(root, "result-state"), authorBase = join(root, "authors"), verifierBase = join(root, "verifiers");
  const writers = [], operations = [], journals = [];
  let nativeUncertain = false, unreturnedWriter = false, journalUncertain = false, primaryFailure = false, journal;
  const observe = promise => {
    operations.push(promise.then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason })));
    return promise;
  };
  // Only source setup and read-only inspection use this helper. Production
  // materialization/capture/verifier calls below never use an injected executor.
  const git = (args, cwd = repo) => {
    nativeUncertain = true;
    const output = execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      { cwd, env: gitEnvironment(), encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    nativeUncertain = false; return output;
  };
  try {
    for (const path of [repo, authorBase, verifierBase]) mkdirSync(path, { mode: 0o700 });
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/common.txt"), "fixed baseline\n");
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["config", "user.name", "Artoo fixture"]); git(["config", "user.email", "fixture@artoo.local"]);
    git(["add", "--all"]); git(["commit", "--quiet", "--no-gpg-sign", "-m", "Fixed finalization baseline"]);
    const baseline = git(["rev-parse", "HEAD"]).trim();
    const profile = WorktreeResultsProfileSchema.parse({ version: 1, id: "finalization_results", node_id: "computer_local_mock",
      project_id: "proj_artoo", repository_root: repo, state_root: state, baseline_commit: baseline,
      content_paths: ["src"], allowed_roots: [root], git_executable: "/usr/bin/git" });
    const store = await observe(openOwnedWorktreeResults(profile, { mode: "create" }));
    const journalOptions = { directory: join(root, "journal"), controllerScope: "native-result-journal", nodeId: profile.node_id };
    const provisioned = await observe(provisionLocalJournal(journalOptions));
    journalOptions.expectedNamespace = provisioned.namespace;
    const inspect = (sql, ...args) => {
      const database = new DatabaseSync(join(journalOptions.directory, "journal.sqlite"), { readOnly: true, allowExtension: false });
      try { return database.prepare(sql).all(...args).map(row => ({ ...row })); } finally { database.close(); }
    };
    assert.equal(inspect("PRAGMA user_version")[0].user_version, 3);
    // The freshly provisioned database has no runs. Take a verified closed-file
    // backup before the explicit additive migration, never during startup/open.
    const databasePath = join(journalOptions.directory, "journal.sqlite"), backup = join(root, "journal-v3-backup.sqlite");
    copyFileSync(databasePath, backup); assert.equal(hex(readFileSync(backup)), hex(readFileSync(databasePath)));
    const upgraded = await observe(upgradeLocalJournalForOwnedResults(journalOptions));
    assert.equal(upgraded.schemaVersion, 4); assert.equal(upgraded.namespace, provisioned.namespace);
    assert.equal(inspect("PRAGMA user_version")[0].user_version, 4);
    const open = async () => {
      const value = await observe(openLocalJournal(journalOptions)); journals.push(value);
      void value.failed.then(() => { journalUncertain = true; });
      assert.equal(value.ownedResultFinalizationVersion, 1); return value;
    };
    journal = await open();
    const query = token => ({ expectedNamespace: journal.namespace, runId: token.request.run_start.run_id });
    const scope = run => ({ expectedNamespace: journal.namespace, runId: run.runId, launchKey: run.launchKey, physicalReceiptId: run.receipt.id });
    const rows = runId => inspect("SELECT sequence,event_id,content_json,content_sha256,role,committed,superseded FROM outbox WHERE run_id=? ORDER BY sequence", runId);

    async function verifier(name, body) {
      const markers = join(root, `markers-${name}`); mkdirSync(markers, { mode: 0o700 });
      const script = join(root, `verifier-${name}.mjs`), ledger = join(markers, "executions.jsonl");
      writeFileSync(script, `import * as fs from "node:fs";\nimport assert from "node:assert/strict";\nimport {join} from "node:path";\n`
        + `const envelope = JSON.parse(fs.readFileSync(process.env.ARTOO_VERIFICATION_CONTEXT_FILE, "utf8"));\n`
        + `assert.match(envelope.request_id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u);\n`
        + `const marker = join(${JSON.stringify(markers)}, envelope.request_id + ".json");\n`
        + `const observed = {pid:process.pid,cwd:process.cwd(),envelope};\n`
        + `fs.writeFileSync(marker + ".pending", JSON.stringify(observed), {flag:"wx"});\n`
        + `fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify(observed) + "\\n");\n`
        + `fs.renameSync(marker + ".pending", marker);\n`
        + `assert.equal(fs.readFileSync("src/common.txt", "utf8"), "fixed baseline\\n");\n${body}\n`, { flag: "wx" });
      // This digest is only the expected normalized local config hash. The
      // original store/template descriptor below is the authority check.
      const expectedProfileDigest = ownedVerificationDigest(profile);
      const config = { version: 1, id: `verifier_${name}`, node_id: profile.node_id, project_id: profile.project_id,
        results_profile_id: profile.id, results_profile_digest: expectedProfileDigest, repository_root: repo, allocation_base: verifierBase,
        commands: [{ id: "acceptance", argv: [process.execPath, script], timeout_ms: 30_000 }],
        subject_paths: ["src"], required_files: ["src/common.txt"] };
      const template = prepareOwnedWorktreeVerificationTemplate(config);
      const descriptor = await observe(describeOwnedResultProfile(store, template));
      assert.equal(descriptor.result_profile.digest, expectedProfileDigest);
      return { template, descriptor, config, marker: requestId => join(markers, `${requestId}.json`),
        executions: () => existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [] };
    }

    function request(v, name, input = { kind: "baseline" }) {
      const runId = `run_${name}`, taskId = `task_${name}`, instanceId = `ai_${name}`;
      const workspaceRoot = allocateWorkspaceRoot({ workspaceRoot: null, branchBacked: true, targetComputerOs: process.platform,
        agentInstanceId: instanceId, runId, worktreeBase: { version: 1, strategy: "per-run", basePath: authorBase } });
      const context = { task: { id: taskId, title: "Author a fixed result", description: `actual author ${name}`, acceptance_criteria: ["Keep the fixed source"] },
        project: { id: profile.project_id, name: "Finalization fixture", default_workspace: repo },
        workspace: { root: workspaceRoot, file_scope: ["src"] }, policy: { filesystem_write_scope: ["src"], requires_approval: [] },
        memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } };
      const runStart = { run_id: runId, task_id: taskId, agent_instance_id: instanceId, runtime: "fixture",
        workspace: { root: workspaceRoot, branch: `fixture/${name}` },
        workspace_allocation: { version: 1, strategy: "per-run", base_path: authorBase }, workspace_retention_reporting: "typed-v1",
        context_pack: { id: `ctx_${name}`, payload: context }, policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: [] },
        artifact_rules: { paths: [] } };
      return { version: 1, run_start: runStart, requirement: { version: 1, request_id: `verify_${name}`, capture_request_id: `capture_${name}`,
        verification_materialization_request_id: `verify_tree_${name}`, profile: v.descriptor,
        author_context_digest: `sha256:${hex(canonicalOwnedResultAuthorContextV1(context))}`, input } };
    }

    async function author(token, body, mode = "completed") {
      const start = token.request.run_start;
      const admitted = await observe(journal.admitOwnedResultStart({ ...query(token), idempotencyKey: `${start.run_id}:start`, admission: token }));
      assert.equal(admitted.kind, "fresh"); const permit = admitted.permit;
      await observe(journal.advance(permit, "preparing"));
      const materializationController = new AbortController();
      const materializing = observe(materializeOwnedResultRun(token, materializationController.signal));
      assert.equal(observe(materializeOwnedResultRun(token, materializationController.signal)), materializing);
      const worktree = await materializing, marker = join(root, `${start.run_id}.json`);
      const script = join(root, `${start.run_id}.mjs`);
      writeFileSync(script, `import * as fs from "node:fs";\nimport assert from "node:assert/strict";\n`
        + `assert.ok(fs.readFileSync("context_pack.md", "utf8").includes(${JSON.stringify(start.context_pack.payload.task.description)}));\n${body}\n`
        + `fs.writeFileSync(${JSON.stringify(`${marker}.pending`)}, JSON.stringify({pid:process.pid,cwd:process.cwd()}), {flag:"wx"});\n`
        + `fs.renameSync(${JSON.stringify(`${marker}.pending`)}, ${JSON.stringify(marker)});\n`
        + (mode === "cancelled" ? "setInterval(() => {}, 1000);\n" : mode === "failed" ? "process.exitCode = 9;\n" : ""), { flag: "wx" });
      const adapter = createProcessAdapter({ runtimeId: "fixture", command: [process.execPath, script], allowedRoots: [root] });
      await observe(journal.advance(permit, "launch_intent"));
      let handle, admission;
      try { ({ handle, admission } = await observe(journal.startOwnedProcess(permit, adapter, worktree, new AbortController().signal))); }
      catch (error) { unreturnedWriter = true; throw error; }
      const events = [], draining = observe((async () => { for await (const event of adapter.streamEvents(handle)) events.push(event); })());
      const writer = { token, permit, worktree, admission, adapter, handle, events, draining, marker }; writers.push(writer);
      const recorded = await observe(journal.recordStarted(permit, adapter, handle));
      assert.equal(recorded.phase, "started"); assert.equal(recorded.ownedResultAdmissionDigest, token.admission_digest);
      if (mode === "cancelled") {
        await waitForRunningMarker(writer.marker, writer.draining, "writer"); // Never await natural exit of the held writer.
        writer.closure = await observe(adapter.stopOwnedRun(handle, admission, "user_cancelled"));
        await bounded(draining, "cancelled author did not drain after actual Stop");
      } else {
        await bounded(draining, "author did not finish");
        writer.closure = await observe(adapter.stopOwnedRun(handle, admission, "user_cancelled"));
      }
      assert.equal(events.filter(event => event.type === "run.lifecycle").at(-1)?.payload.phase, mode, JSON.stringify(events));
      assertClosed(writer.closure); assert.equal(assertExited(marker).cwd, worktree.root);
      // A new signal must not conceal the producer's actual failed/cancelled
      // outcome. Replays below always reuse this one original finalizer signal.
      writer.finalizationController = new AbortController();
      writer.finalizeInput = { worktree, admission, handle, closure: writer.closure, signal: writer.finalizationController.signal };
      return writer;
    }
    await body({ root, repo, state, baseline, profile, store, observe, git, verifier, request, author, journalOptions, inspect, rows, query, scope,
      get journal() { return journal; }, async reopen() { await observe(journal.close()); journal = await open(); return journal; },
      captureExists: requestId => existsSync(join(state, "operations", hex(requestId))) });
  } catch (error) { primaryFailure = true; throw error; }
  finally {
    const cleanupErrors = [];
    for (const writer of writers) {
      try {
        assertClosed(await observe(writer.adapter.stopOwnedRun(writer.handle, writer.admission, "user_cancelled")));
        await bounded(writer.draining, "author event drain did not close during cleanup");
      } catch (error) { cleanupErrors.push(error); }
    }
    for (const opened of journals) try { await observe(opened.close()); } catch (error) { journalUncertain = true; cleanupErrors.push(error); }
    const settled = await Promise.all(operations);
    try {
      assert.ok(!primaryFailure && !nativeUncertain && !unreturnedWriter && !journalUncertain && !cleanupErrors.length
        && !settled.some(result => result.status === "rejected" && worktreeResultFailureIsUncertain(result.reason)),
      `failed assertion or unknown writer/verifier/Git/journal closure retains fixture: ${root}`);
      const suffix = relative(realpathSync.native(tmpdir()), root);
      assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`)); assert.equal(realpathSync.native(root), root);
      rmSync(root, { recursive: true, force: true });
    } catch (error) { if (primaryFailure) t.diagnostic(`Fixture retained at ${root}: ${error.message}`); else throw error; }
  }
}
