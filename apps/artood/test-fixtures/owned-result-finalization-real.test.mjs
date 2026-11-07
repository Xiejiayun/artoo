// Run only after integrating and building the admission/finalization draft:
// node --test apps/artood/test-fixtures/owned-result-finalization-real.test.mjs
// Real local POSIX author/capture/verifier evidence. No transport, durable
// journal finalization, provider, review, product-stage or publication acceptance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { observeOwnedVerifierSpawn } from "./observe-owned-verifier-spawn.mjs";
import { prepareVerificationProfiles, subjectManifest } from "../dist/verification.js";
import { canonicalOwnedResultAuthorContextV1, NodeOwnedResultVerificationEvidenceV1Schema } from "@artoo/domain";
import { allocateWorkspaceRoot } from "@artoo/protocol";
import { createOwnedRunAdmission, createProcessAdapter } from "../dist/process-adapter.js";
import { openOwnedWorktreeResults, WorktreeResultsProfileSchema, worktreeResultFailureIsUncertain } from "../dist/owned/worktree-results.js";
import { ownedVerificationDigest } from "../dist/owned/worktree-verification-contract.js";
import { authenticateOwnedResultFinalization, authenticateProjectedOwnedResultVerification, describeOwnedResultProfile,
  finalizeOwnedResultRun, materializeOwnedResultRun, prepareOwnedResultRun,
  prepareOwnedWorktreeVerificationTemplate } from "../dist/owned-worktree-verification.js";

const native = { skip: process.platform !== "linux" && process.platform !== "darwin", timeout: 600_000 };
const hex = value => createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, message, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-result-finalization-")));
  const repo = join(root, "repository"), state = join(root, "result-state"), authorBase = join(root, "authors"), verifierBase = join(root, "verifiers");
  const writers = [], operations = [];
  let nativeUncertain = false, unreturnedWriter = false, primaryFailure = false;
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
    const profile = WorktreeResultsProfileSchema.parse({ version: 1, id: "finalization_results", node_id: "node_finalization",
      project_id: "project_finalization", repository_root: repo, state_root: state, baseline_commit: baseline,
      content_paths: ["src"], allowed_roots: [root], git_executable: "/usr/bin/git" });
    const store = await observe(openOwnedWorktreeResults(profile, { mode: "create" }));

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
      const materializationController = new AbortController();
      const materializing = observe(materializeOwnedResultRun(token, materializationController.signal));
      assert.equal(observe(materializeOwnedResultRun(token, materializationController.signal)), materializing);
      const worktree = await materializing, start = token.request.run_start, marker = join(root, `${start.run_id}.json`);
      const script = join(root, `${start.run_id}.mjs`);
      writeFileSync(script, `import * as fs from "node:fs";\nimport assert from "node:assert/strict";\n`
        + `assert.ok(fs.readFileSync("context_pack.md", "utf8").includes(${JSON.stringify(start.context_pack.payload.task.description)}));\n${body}\n`
        + `fs.writeFileSync(${JSON.stringify(`${marker}.pending`)}, JSON.stringify({pid:process.pid,cwd:process.cwd()}), {flag:"wx"});\n`
        + `fs.renameSync(${JSON.stringify(`${marker}.pending`)}, ${JSON.stringify(marker)});\n`
        + (mode === "cancelled" ? "setInterval(() => {}, 1000);\n" : mode === "failed" ? "process.exitCode = 9;\n" : ""), { flag: "wx" });
      const admission = createOwnedRunAdmission({ launchKey: token.author_launch_digest.slice(7), runId: start.run_id, taskId: start.task_id,
        agentInstanceId: start.agent_instance_id, runtime: start.runtime, workspaceRoot: worktree.root, workspaceBranch: worktree.branch });
      const adapter = createProcessAdapter({ runtimeId: "fixture", command: [process.execPath, script], allowedRoots: [root] });
      let handle;
      try { handle = await observe(adapter.startOwnedRun({ runId: start.run_id, taskId: start.task_id, agentInstanceId: start.agent_instance_id,
        runtime: start.runtime, workspaceRoot: worktree.root, runStart: start }, worktree, admission, new AbortController().signal)); }
      catch (error) { unreturnedWriter = true; throw error; }
      const events = [], draining = observe((async () => { for await (const event of adapter.streamEvents(handle)) events.push(event); })());
      const writer = { token, worktree, admission, adapter, handle, events, draining, marker }; writers.push(writer);
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
    await body({ root, repo, state, baseline, profile, store, observe, git, verifier, request, author,
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
    const settled = await Promise.all(operations);
    try {
      assert.ok(!nativeUncertain && !unreturnedWriter && !cleanupErrors.length
        && !settled.some(result => result.status === "rejected" && worktreeResultFailureIsUncertain(result.reason)),
      `unknown writer/verifier/Git closure retains fixture: ${root}`);
      const suffix = relative(realpathSync.native(tmpdir()), root);
      assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`)); assert.equal(realpathSync.native(root), root);
      rmSync(root, { recursive: true, force: true });
    } catch (error) { if (primaryFailure) t.diagnostic(`Fixture retained at ${root}: ${error.message}`); else throw error; }
  }
}

test("fixed baseline and sealed-result continuation finalize once with the exact real author", native, async t => {
  await withFixture(t, async f => {
    const v = await f.verifier("happy", 'assert.equal(fs.readFileSync("src/first.txt", "utf8"), "first\\n");\n'
      + 'if (fs.existsSync("src/second.txt")) assert.equal(fs.readFileSync("src/second.txt", "utf8"), "second\\n");');
    const request = f.request(v, "first"), token = await f.observe(prepareOwnedResultRun(f.store, v.template, request));
    assert.equal(Object.isFrozen(token), true); assert.equal(Object.isFrozen(token.request.run_start.context_pack.payload), true);
    assert.equal(await f.observe(prepareOwnedResultRun(f.store, v.template, clone(request))), token);
    writeFileSync(join(f.repo, "src/common.txt"), "later repository HEAD\n"); writeFileSync(join(f.repo, "src/head-only.txt"), "later\n");
    f.git(["add", "--all"]); f.git(["commit", "--quiet", "--no-gpg-sign", "-m", "Advance HEAD after fixed result admission"]);
    const advancedHead = f.git(["rev-parse", "HEAD"]).trim(); assert.notEqual(advancedHead, f.baseline);
    const author = await f.author(token, 'assert.equal(fs.readFileSync("src/common.txt", "utf8"), "fixed baseline\\n");\n'
      + 'assert.equal(fs.existsSync("src/head-only.txt"), false); fs.writeFileSync("src/first.txt", "first\\n");');
    assert.equal(author.worktree.committedHead, f.baseline);
    await assert.rejects(f.observe(materializeOwnedResultRun(token, new AbortController().signal)), /original cancellation signal/i);
    const pending = f.observe(finalizeOwnedResultRun(token, author.finalizeInput));
    assert.equal(f.observe(finalizeOwnedResultRun(token, author.finalizeInput)), pending, "concurrent calls must share the original promise");
    const bundle = await pending, evidence = bundle.evidence_event.payload;
    assert.equal(f.observe(finalizeOwnedResultRun(token, author.finalizeInput)), pending, "historical replay must not rerun capture or verifier");
    assert.equal(await pending, bundle); assert.equal(v.executions().length, 1);
    assert.equal(bundle.terminal.payload.phase, "completed"); assert.equal(bundle.retentionOutcome, "completed");
    assert.equal(bundle.kind, "owned-result-finalization.v1"); assert.equal(bundle.evidence_event.type, "run.owned-result.verification");
    assert.equal(authenticateOwnedResultFinalization(bundle, request, { stopRequested: false }), bundle);
    assert.equal(authenticateProjectedOwnedResultVerification(evidence), evidence);
    assert.deepEqual(NodeOwnedResultVerificationEvidenceV1Schema.parse(evidence), evidence);
    assert.equal(evidence.result.base_commit, f.baseline); assert.equal(evidence.verification.payload.outcome, "passed");
    assert.equal(assertExited(v.marker(request.requirement.request_id)).cwd, evidence.verification.workspace.root);
    assert.notEqual(evidence.verification.workspace.root, author.worktree.root);
    assert.throws(() => authenticateOwnedResultFinalization(bundle, request, { stopRequested: true }), /Stop|completed/);
    await assert.rejects(f.observe(finalizeOwnedResultRun(token, { ...author.finalizeInput, signal: new AbortController().signal })), /signal|bound|cancel/i);

    const continuedRequest = f.request(v, "second", { kind: "result", reference: evidence.result.reference });
    const continued = await f.observe(prepareOwnedResultRun(f.store, v.template, continuedRequest));
    const secondAuthor = await f.author(continued, 'assert.equal(fs.readFileSync("src/first.txt", "utf8"), "first\\n");\n'
      + 'assert.equal(fs.existsSync("src/head-only.txt"), false); fs.writeFileSync("src/second.txt", "second\\n");');
    assert.equal(secondAuthor.worktree.committedHead, evidence.result.commit); assert.notEqual(secondAuthor.worktree.committedHead, advancedHead);
    const second = await f.observe(finalizeOwnedResultRun(continued, secondAuthor.finalizeInput));
    assert.equal(second.terminal.payload.phase, "completed"); assert.equal(v.executions().length, 2);
    assert.deepEqual(second.evidence_event.payload.result.inputs, [evidence.result.reference]);
    assert.equal(second.evidence_event.payload.result.base_commit, evidence.result.commit);
    assert.equal(authenticateOwnedResultFinalization(second, continuedRequest, { stopRequested: false }), second);
    assertExited(v.marker(continuedRequest.requirement.request_id));
    author.finalizationController.abort();
    assert.throws(() => authenticateOwnedResultFinalization(bundle, request, { stopRequested: false }), /original-signal cancellation|Stop|completed/i,
      "a late original-signal cancellation must fence settlement of an already-created completed bundle");
  });
});

test("failed verification remains a genuine failure while forged and non-completed authors cannot finalize", native, async t => {
  await withFixture(t, async f => {
    const v = await f.verifier("failure", 'assert.equal(fs.readFileSync("src/contribution.txt", "utf8"), "valid\\n"); process.exitCode = 9;');
    const request = f.request(v, "verified_failure"), token = await f.observe(prepareOwnedResultRun(f.store, v.template, request));
    await assert.rejects(f.observe(materializeOwnedResultRun(clone(token), new AbortController().signal)), /original prepared/i);
    const author = await f.author(token, 'fs.writeFileSync("src/contribution.txt", "valid\\n");');
    await assert.rejects(f.observe(finalizeOwnedResultRun(token, { ...author.finalizeInput, worktree: clone(author.worktree) })), /original materialized/i);
    await assert.rejects(f.observe(finalizeOwnedResultRun(token, { ...author.finalizeInput, closure: clone(author.closure) })), /actual closure|provenance/i);
    assert.equal(f.captureExists(request.requirement.capture_request_id), false); assert.equal(v.executions().length, 0);
    const bundle = await f.observe(finalizeOwnedResultRun(token, author.finalizeInput));
    assertExited(v.marker(request.requirement.request_id)); assert.equal(v.executions().length, 1);
    assert.equal(bundle.evidence_event.payload.verification.payload.checks[0].exit_code, 9);
    assert.equal(bundle.evidence_event.payload.verification.payload.outcome, "failed");
    assert.equal(bundle.terminal.payload.phase, "failed"); assert.equal(bundle.retentionOutcome, "failed");
    assert.equal(authenticateOwnedResultFinalization(bundle, request, { stopRequested: false }), bundle);
    assert.throws(() => authenticateOwnedResultFinalization(clone(bundle), request, { stopRequested: false }), /original/i);
    const forgedEvidence = { ...bundle, evidence_event: { ...bundle.evidence_event, payload: clone(bundle.evidence_event.payload) } };
    assert.throws(() => authenticateOwnedResultFinalization(forgedEvidence, request, { stopRequested: false }), /original/i);
    assert.throws(() => authenticateOwnedResultFinalization(bundle, f.request(v, "wrong_run"), { stopRequested: false }), /admission|differ/i);
    const changedRequirement = clone(request); changedRequirement.requirement.capture_request_id = "capture_changed";
    assert.throws(() => authenticateOwnedResultFinalization(bundle, changedRequirement, { stopRequested: false }), /admission|differ/i);
    await assert.rejects(f.observe(prepareOwnedResultRun(f.store, v.template, changedRequirement)), /different.*admission|binding/i);

    const passing = await f.verifier("noncompleted_author", 'assert.equal(fs.readFileSync("src/contribution.txt", "utf8"), "valid\\n");');
    for (const mode of ["failed", "cancelled"]) {
      const failedRequest = f.request(passing, `author_${mode}`);
      const failedToken = await f.observe(prepareOwnedResultRun(f.store, passing.template, failedRequest));
      const failedAuthor = await f.author(failedToken, 'fs.writeFileSync("src/contribution.txt", "valid\\n");', mode);
      assert.equal(failedAuthor.finalizeInput.signal.aborted, false, "a fresh signal cannot replace the actual producer outcome");
      await assert.rejects(f.observe(finalizeOwnedResultRun(failedToken, failedAuthor.finalizeInput)), /actually completed author/i);
      assert.equal(f.captureExists(failedRequest.requirement.capture_request_id), false);
      assert.equal(existsSync(passing.marker(failedRequest.requirement.request_id)), false);
      assert.equal(passing.executions().length, 0, "even a passing verifier must not run after failed or stopped authors");
    }

    const cancellable = await f.verifier("cancelled_verifier", 'assert.equal(fs.readFileSync("src/contribution.txt", "utf8"), "valid\\n"); setInterval(() => {}, 1000);');
    const cancelledRequest = f.request(cancellable, "cancelled_verifier");
    const cancelledToken = await f.observe(prepareOwnedResultRun(f.store, cancellable.template, cancelledRequest));
    const cancelledAuthor = await f.author(cancelledToken, 'fs.writeFileSync("src/contribution.txt", "valid\\n");');
    const verifierRoot = join(cancellable.config.allocation_base, cancelledRequest.requirement.verification_materialization_request_id);
    let expectedVerification;
    const observer = observeOwnedVerifierSpawn({ executable: cancellable.config.commands[0].argv[0],
      args: cancellable.config.commands[0].argv.slice(1), cwd: verifierRoot,
      requestId: cancelledRequest.requirement.request_id,
      validateContext(envelope) {
        assert.equal(expectedVerification, undefined, "the exact protected context is observed once");
        const profile = prepareVerificationProfiles([{ id: cancellable.config.id, project_id: cancellable.config.project_id,
          workspace_root: verifierRoot, commands: structuredClone(cancellable.config.commands),
          subject_paths: [...cancellable.config.subject_paths], required_files: [...cancellable.config.required_files] }])[0];
        const subject = subjectManifest(profile).digest;
        assert.deepEqual(envelope, { version: 1, request_id: cancelledRequest.requirement.request_id,
          profile_id: profile.id, profile_digest: profile.digest, subject_digest: subject, context: null });
        expectedVerification = Object.freeze({ profile_id: profile.id, profile_digest: profile.digest, subject_digest: subject });
      } });
    let pending, settled, observed, observationError, closureError, restorationError;
    try {
      pending = f.observe(finalizeOwnedResultRun(cancelledToken, cancelledAuthor.finalizeInput));
      // Capture and checkout preparation have their own bounded phase. The
      // original 15-second readiness clock begins at the real target spawn.
      await observer.waitForSpawn(pending, 120_000);
      await observer.waitForReadyMarker(cancellable.marker(cancelledRequest.requirement.request_id), pending);
      await assert.rejects(f.observe(describeOwnedResultProfile(f.store, cancellable.template)), /single-writer executor is busy/,
        "the real live verifier must keep its repository lease");
      observed = observer.snapshot();
    } catch (error) { observationError = error; }
    finally {
      observer.beginCancellation();
      cancelledAuthor.finalizationController.abort();
      if (pending) settled = await pending.then(value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }));
      try { observer.assertClosed(); } catch (error) { closureError = error; }
      try { observer.dispose(); } catch (error) { restorationError = error; }
    }
    const observationErrors = [observationError, closureError, restorationError].filter(Boolean);
    if (observationErrors.length) {
      if (settled?.status === "rejected") t.diagnostic(`Verifier completion also rejected: ${settled.error.message}`);
      if (observationErrors.length === 1) throw observationErrors[0];
      throw new AggregateError(observationErrors, "Actual verifier observation or cleanup failed");
    }
    assert.ok(settled && expectedVerification && observed);
    if (settled.status === "rejected") throw settled.error;
    const cancelled = settled.value;
    assert.equal(cancelled.evidence_event.payload.verification.workspace.root, verifierRoot);
    for (const [field, expected] of Object.entries(expectedVerification)) {
      assert.equal(cancelled.evidence_event.payload.verification.payload[field], expected, field);
    }
    assert.deepEqual(await f.observe(describeOwnedResultProfile(f.store, cancellable.template)), cancellable.descriptor,
      "authenticated cancellation and actual closure release the repository lease");
    t.diagnostic(JSON.stringify({ kind: "fixture-only-actual-verifier-spawn", preparation_budget_ms: 120_000,
      ready_budget_ms: 15_000, observation: observed }));
    assertExited(cancellable.marker(cancelledRequest.requirement.request_id));
    assert.equal(cancelled.evidence_event.payload.verification.payload.outcome, "cancelled");
    assert.equal(cancelled.terminal.payload.phase, "cancelled"); assert.equal(cancelled.retentionOutcome, "cancelled");
    assert.equal(authenticateOwnedResultFinalization(cancelled, cancelledRequest, { stopRequested: true }), cancelled);
    assert.equal(f.observe(finalizeOwnedResultRun(cancelledToken, cancelledAuthor.finalizeInput)), pending);
    assert.equal(await pending, cancelled); assert.equal(cancellable.executions().length, 1);
  });
});
