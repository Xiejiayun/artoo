// Run after building: node --test apps/artood/test-fixtures/owned-worktree-verification-real.test.mjs
// Native POSIX Git/process/verifier integration evidence only. No injected lifecycle,
// receipt, worktree handle, verifier exit, model provider, review or publication.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { createOwnedRunAdmission, createProcessAdapter } from "../dist/process-adapter.js";
import { openOwnedWorktreeResults, executeOwnedResultVerificationTarget, executeOwnedResultVerificationTargetDurably,
  authenticateSealedOwnedVerificationReceipt, worktreeResultFailureIsUncertain } from "../dist/owned/worktree-results.js";
import { prepareOwnedWorktreeVerificationTemplate, verifyOwnedWorktreeResult, verifyOwnedWorktreeResultDurably } from "../dist/owned-worktree-verification.js";
import { materializeOwnedWorktree, prepareOwnedWorktree, reserveOwnedWorktree } from "../dist/owned/worktree-reservation.js";

const supported = process.platform === "linux" || process.platform === "darwin";
const native = { skip: !supported, timeout: 600_000 };
const sha = (value) => createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(promise, message, milliseconds = 15_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(predicate, message, signal) {
  const deadline = Date.now() + 300_000;
  while (!predicate()) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(message);
    await delay(10);
  }
}
async function waitForVerifierMarker(pending, marker, message) {
  const controller = new AbortController();
  try {
    await Promise.race([waitFor(() => existsSync(marker), message, controller.signal),
      pending.then(() => { throw new Error("verifier ended before the requested live-process observation"); })]);
  } finally { controller.abort(); }
}

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

function git(root, args) {
  // This helper initializes or inspects the throwaway fixture only. Result
  // capture/merge/materialization must use the production owned executor.
  return execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: root, env: gitEnvironment(), encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
}

function request(source, requestId, input) {
  return { request_id: requestId, worktree: source.worktree, admission: source.admission,
    handle: source.handle, closure: source.closure, ...(input ? { input } : {}) };
}

async function fixture(t, { mutateOpenOptions = false } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-worktree-results-")));
  const repo = join(root, "repository"), state = join(root, "result-state");
  const writers = [], ownedOperations = [];
  let unreturnedWriter = false, unreturnedReader = false;
  // Observe rejections immediately while returning the original promise, so
  // every test still receives its actual error. Setup/Git failures count too.
  const observeOwned = promise => {
    ownedOperations.push(promise.then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason })));
    return promise;
  };
  t.after(async () => {
    const ownedResults = await Promise.all(ownedOperations);
    // Never delete a writer's directory until its real adapter confirms stop.
    // A failed assertion retains the fixture if closure cannot be established.
    for (const writer of writers) {
      const closure = await writer.adapter.stopOwnedRun(writer.handle, writer.admission, "user_cancelled");
      assert.equal(closure.kind, "confirmed_closed", `cleanup closure for ${writer.identity.runId}`);
      await bounded(writer.draining, "writer event drain did not close during fixture cleanup");
    }
    assert.ok(!unreturnedWriter && !unreturnedReader && !ownedResults.some(result => result.status === "rejected" && worktreeResultFailureIsUncertain(result.reason)),
      `unknown verifier/Git closure retains fixture: ${root}`);
    const temporaryRoot = realpathSync.native(tmpdir()), suffix = relative(temporaryRoot, root);
    assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`));
    assert.equal(realpathSync.native(root), root);
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(repo); mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "common.txt"), "baseline\n");
  writeFileSync(join(repo, "README.md"), "outside scope baseline\n");
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Artoo fixture"]);
  git(repo, ["config", "user.email", "fixture@artoo.local"]);
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixed fixture baseline"]);
  const baseline = git(repo, ["rev-parse", "HEAD"]).trim();
  const profile = { version: 1, id: "fixture_results", node_id: "node_fixture", project_id: "project_fixture",
    repository_root: repo, state_root: state, baseline_commit: baseline, content_paths: ["src"], allowed_roots: [root], git_executable: "/usr/bin/git" };
  const openOptions = { mode: "create" };
  const opening = observeOwned(openOwnedWorktreeResults(profile, openOptions));
  if (mutateOpenOptions) openOptions.mode = "open";
  const rawStore = await opening;
  const store = Object.fromEntries(Object.entries(rawStore).map(([name, call]) => [name,
    name === "inspect" ? call : (...args) => observeOwned(call(...args))]));

  async function freshWorktree(name) {
    const prepared = await observeOwned(prepareOwnedWorktree({ root: join(root, `worktree-${name}`), branch: `fixture/${name}`,
      sourceRepo: repo, sourceCommit: baseline, allowedRoots: [root] }, { gitExecutable: "/usr/bin/git", guardParent: true }));
    return observeOwned(materializeOwnedWorktree(await observeOwned(reserveOwnedWorktree(prepared))));
  }

  async function startWriter(name, body, worktree) {
    worktree ??= await freshWorktree(name);
    const script = join(root, `writer-${name}.mjs`);
    writeFileSync(script, `import * as fs from "node:fs";\nimport assert from "node:assert/strict";\n${body}\n`);
    const identity = { launchKey: `launch_${name}`, runId: `run_${name}`, taskId: `task_${name}`, agentInstanceId: `ai_${name}`,
      runtime: "fixture", workspaceRoot: worktree.root, workspaceBranch: worktree.branch };
    const admission = createOwnedRunAdmission(identity);
    const config = { runId: identity.runId, taskId: identity.taskId, agentInstanceId: identity.agentInstanceId,
      runtime: identity.runtime, workspaceRoot: worktree.root, runStart: {
        run_id: identity.runId, task_id: identity.taskId, agent_instance_id: identity.agentInstanceId, runtime: identity.runtime,
        workspace: { root: worktree.root, branch: worktree.branch }, context_pack: { id: `ctx_${name}`, uri: "inline" },
        policy_snapshot: { filesystem_write_scope: [worktree.root], requires_approval: [] }, artifact_rules: { paths: [] },
      } };
    const adapter = createProcessAdapter({ runtimeId: "fixture", command: [process.execPath, script], allowedRoots: [root] });
    let handle;
    try { handle = await observeOwned(adapter.startOwnedRun(config, worktree, admission, new AbortController().signal)); }
    catch (error) { unreturnedWriter = true; throw error; }
    const events = [];
    const draining = (async () => { for await (const event of adapter.streamEvents(handle)) events.push(event); })();
    const writer = { worktree, admission, handle, identity, adapter, events, draining };
    writers.push(writer);
    return writer;
  }

  async function author(name, body, worktree) {
    const writer = await startWriter(name, body, worktree);
    await bounded(writer.draining, `writer ${name} did not complete`);
    assert.equal(writer.events.filter((event) => event.type === "run.lifecycle").at(-1)?.payload.phase, "completed",
      JSON.stringify(writer.events));
    writer.closure = await writer.adapter.stopOwnedRun(writer.handle, writer.admission, "user_cancelled");
    assert.equal(writer.closure.kind, "confirmed_closed");
    return writer;
  }

  const operationDirectory = (requestId) => join(state, "operations", sha(requestId));
  const privateRef = (requestId) => {
    const marker = JSON.parse(readFileSync(join(state, "marker.json"), "utf8")).data;
    return `refs/artoo/results/${marker.namespace.replaceAll("-", "")}/${sha(requestId)}`;
  };
  const executeTarget = (target, body) => observeOwned(executeOwnedResultVerificationTarget(target, body));
  const executeDurableTarget = (target, intent, body) => observeOwned(executeOwnedResultVerificationTargetDurably(target, intent, body));
  function readInFreshProcess(reference) {
    const script = join(root, `receipt-reader-${reference.verification_id}.mjs`);
    writeFileSync(script, `import { openOwnedWorktreeResults } from ${JSON.stringify(new URL("../dist/owned/worktree-results.js", import.meta.url).href)};\n`
      + `const store = await openOwnedWorktreeResults(${JSON.stringify(profile)}, {mode:"open"});\n`
      + `process.stdout.write(JSON.stringify(await store.readVerification(${JSON.stringify(reference)})));\n`, { flag: "wx" });
    // A genuinely new process has neither the original target nor the candidate
    // WeakMap. Any abnormal reader exit retains the fixture for inspection.
    unreturnedReader = true;
    const output = execFileSync(process.execPath, [script], { env: gitEnvironment(), encoding: "utf8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    unreturnedReader = false;
    return JSON.parse(output);
  }
  return { root, repo, state, baseline, profile, store, freshWorktree, startWriter, author, operationDirectory, privateRef,
    observeOwned, executeTarget, executeDurableTarget, readInFreshProcess };
}

function verifier(f, sealed, name, body, options = {}) {
  const allocation = join(f.root, "verification-worktrees");
  if (!existsSync(allocation)) mkdirSync(allocation, { mode: 0o700 });
  const script = join(f.root, `verifier-${name}.mjs`), marker = join(f.root, `verifier-${name}.json`);
  writeFileSync(script, `import * as fs from "node:fs";\nimport assert from "node:assert/strict";\n`
    + `const envelope = JSON.parse(fs.readFileSync(process.env.ARTOO_VERIFICATION_CONTEXT_FILE, "utf8"));\n`
    + `fs.writeFileSync(${JSON.stringify(`${marker}.pending`)}, JSON.stringify({pid:process.pid,cwd:process.cwd(),envelope}), {flag:"wx"});\n`
    + `fs.renameSync(${JSON.stringify(`${marker}.pending`)}, ${JSON.stringify(marker)});\n${body}\n`);
  const config = { version: 1, id: `verifier_${name}`, node_id: f.profile.node_id, project_id: f.profile.project_id,
    results_profile_id: f.profile.id, results_profile_digest: sealed.receipt.profile_digest,
    repository_root: f.repo, allocation_base: allocation,
    commands: [{ id: "acceptance", argv: [process.execPath, script], timeout_ms: options.timeout_ms ?? 30_000 }],
    subject_paths: ["src"], required_files: ["src/common.txt"], ...options.config };
  const template = prepareOwnedWorktreeVerificationTemplate(config);
  const input = { store: f.store, request_id: `verify_${name}`, materialization_request_id: `materialize_verify_${name}`,
    reference: sealed.reference, root: join(allocation, name), branch: `fixture/verify-${name}`, signal: new AbortController().signal };
  return { script, marker, config, template, input, run: () => f.observeOwned(verifyOwnedWorktreeResult(template, input)),
    runDurably: () => f.observeOwned(verifyOwnedWorktreeResultDurably(template, input)) };
}
function assertVerifierExited(marker) {
  const child = JSON.parse(readFileSync(marker, "utf8"));
  assert.throws(() => process.kill(child.pid, 0), error => error.code === "ESRCH", "actual verifier PID must be absent after receipt");
  return child;
}

test("real A/B merge is checked in a fresh private verification tree with immutable dual bindings", native, async t => {
  const f = await fixture(t);
  const a = await f.author("verify_a", 'fs.writeFileSync("src/alpha.txt", "from A\\n"); fs.mkdirSync("src/empty");');
  const b = await f.author("verify_b", 'fs.writeFileSync("src/beta.txt", "from B\\n");');
  const ar = await f.store.capture(request(a, "verify_result_a")), br = await f.store.capture(request(b, "verify_result_b"));
  const merged = await f.store.merge({ request_id: "verify_merge_ab", inputs: [ar.reference, br.reference] });
  assert.equal(merged.outcome, "candidate");
  const release = join(f.root, "release-verifier");
  const v = verifier(f, merged, "merged", `
assert.equal(fs.readFileSync("src/alpha.txt", "utf8"), "from A\\n");
assert.equal(fs.readFileSync("src/beta.txt", "utf8"), "from B\\n");
assert.deepEqual(fs.readdirSync("src/empty"), []);
while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
process.stdout.write("real protected checks completed\\n");`, { timeout_ms: 120_000 });
  const tokenInput = { request_id: "token_only", reference: merged.reference, root: join(v.config.allocation_base, "token"), branch: "fixture/verify-token" };
  const token = await f.store.materializeForVerification(tokenInput);
  assert.deepEqual(Object.keys(token).sort(), ["kind", "version"]);
  await assert.rejects(f.executeTarget(structuredClone(token), async () => "forged"), /fresh genuine/);
  const pending = v.run();
  let evidence;
  try {
    await waitForVerifierMarker(pending, v.marker, "real verifier did not start");
    // No writer handle is exposed by the verification API. Even the exact
    // public request cannot be adopted through the ordinary materialize API.
    await assert.rejects(f.store.materialize({ request_id: v.input.materialization_request_id, reference: merged.reference,
      root: v.input.root, branch: v.input.branch }), /busy|lease/i);
    await assert.rejects(f.store.read(merged.reference), /busy|lease/i);
    await assert.rejects(f.observeOwned(openOwnedWorktreeResults(f.profile, { mode: "open" })), /single-writer executor is busy/);
    let callbackCalled = false;
    await assert.rejects(f.executeTarget(token, async () => { callbackCalled = true; return "unexpected callback execution"; }),
      /single-writer executor is busy/);
    assert.equal(callbackCalled, false, "contention must reject before invoking the target callback");
  } finally { writeFileSync(release, "continue\n"); evidence = await pending; }
  const actual = assertVerifierExited(v.marker);
  assert.equal(actual.cwd, v.input.root); assert.notEqual(actual.cwd, a.worktree.root); assert.notEqual(actual.cwd, b.worktree.root);
  assert.equal(evidence.verification.outcome, "passed"); assert.equal(evidence.verification.checks.length, 1);
  assert.equal(evidence.verification.checks[0].exit_code, 0);
  assert.deepEqual(evidence.result.reference, merged.reference); assert.equal(evidence.result.commit, merged.receipt.commit);
  assert.equal(evidence.result.tree, merged.receipt.tree); assert.equal(evidence.result.manifest_digest, merged.receipt.manifest.digest);
  assert.equal(evidence.template.digest, v.template.digest); assert.equal(evidence.verification.request_id, v.input.request_id);
  assert.equal(evidence.verification.profile_digest, actual.envelope.profile_digest);
  assert.equal(evidence.verification.subject_digest, actual.envelope.subject_digest);
  assert.notEqual(evidence.verification.subject_digest, evidence.result.manifest_digest);
  assert.match(evidence.scope, /not independent review, integration acceptance or publication/);
  assert.equal(Object.isFrozen(evidence.verification.checks), true);
  await assert.rejects(f.store.materialize({ request_id: v.input.materialization_request_id, reference: merged.reference,
    root: v.input.root, branch: v.input.branch }), /already bound/);
  await assert.rejects(v.run(), /fresh genuine verification-only/);
  await assert.rejects(f.observeOwned(verifyOwnedWorktreeResult(structuredClone(v.template), v.input)), /genuine locally prepared template/);
  await assert.rejects(f.executeTarget({ version: 1, kind: "owned-result-verification-target" }, async () => "forged"), /fresh genuine/);
  await assert.rejects(f.store.materialize(tokenInput), /already bound/);
  // This callback checks only target lease semantics. It is not verifier evidence.
  assert.deepEqual(await f.executeTarget(token, async binding => binding.result.reference), merged.reference);
  await assert.rejects(f.executeTarget(token, async () => "twice"), /fresh genuine/);
});

test("real verifier failures and writes never produce a passed exact-result receipt", native, async t => {
  const f = await fixture(t), author = await f.author("failure_author", 'fs.writeFileSync("src/contribution.txt", "authored\\n");');
  const sealed = await f.store.capture(request(author, "failure_result"));
  const failing = verifier(f, sealed, "failed_command", 'process.stderr.write("actual rejected condition\\n"); process.exitCode = 9;');
  const failed = await failing.run();
  assertVerifierExited(failing.marker); assert.equal(failed.verification.outcome, "failed");
  assert.equal(failed.verification.checks[0].exit_code, 9); assert.deepEqual(failed.result.reference, sealed.reference);
  for (const [name, body] of [
    ["changed_mode", 'fs.chmodSync("src/common.txt", 0o755);'],
    ["changed_directory", 'fs.mkdirSync("src/new-empty");'],
    ["changed_bytes", 'fs.writeFileSync("src/common.txt", "changed by verifier\\n");'],
  ]) {
    const changed = verifier(f, sealed, name, body);
    await assert.rejects(changed.run(), /verification materialization differs from its sealed result/);
    assertVerifierExited(changed.marker);
  }
  assert.deepEqual(await f.store.read(sealed.reference), sealed);
});

test("template changes, wrong scope and cancellation fail closed using actual local processes", native, async t => {
  const f = await fixture(t), author = await f.author("binding_author", 'fs.writeFileSync("src/contribution.txt", "authored\\n");');
  const sealed = await f.store.capture(request(author, "binding_result"));
  const changed = verifier(f, sealed, "changed_program", 'process.stdout.write("original\\n");');
  writeFileSync(changed.script, 'process.stdout.write("replacement\\n");');
  await assert.rejects(changed.run(), /protected verifier changed/); assert.equal(existsSync(changed.input.root), false);
  const wrong = verifier(f, sealed, "wrong_profile", 'process.stdout.write("must not run\\n");', {
    config: { results_profile_digest: `sha256:${"f".repeat(64)}` },
  });
  await assert.rejects(wrong.run(), /does not match the protected template/); assert.equal(existsSync(wrong.marker), false);
  const controller = new AbortController();
  const cancelled = verifier(f, sealed, "cancelled", 'setInterval(() => {}, 1000);', { timeout_ms: 120_000 });
  cancelled.input.signal = controller.signal;
  const pending = cancelled.run();
  let evidence;
  try { await waitForVerifierMarker(pending, cancelled.marker, "real cancellable verifier did not start"); }
  finally { controller.abort(); evidence = await pending; }
  assertVerifierExited(cancelled.marker); assert.equal(evidence.verification.outcome, "cancelled");
  assert.equal(evidence.verification.checks.length, 1); assert.notEqual(evidence.verification.outcome, "passed");
  assert.deepEqual(await f.store.read(sealed.reference), sealed);
});

test("durable real verification survives a fresh process without restoring execution authority", native, async t => {
  const f = await fixture(t), author = await f.author("durable_author", 'fs.writeFileSync("src/contribution.txt", "durable authored\\n");');
  const result = await f.store.capture(request(author, "durable_result"));
  const v = verifier(f, result, "durable", 'assert.equal(fs.readFileSync("src/contribution.txt", "utf8"), "durable authored\\n");');
  const sealed = await v.runDurably(), marker = assertVerifierExited(v.marker);
  assert.equal(sealed.receipt.evidence.verification.outcome, "passed");
  assert.equal(sealed.receipt.execution.profile_digest, marker.envelope.profile_digest);
  assert.equal(sealed.receipt.execution.subject_digest, marker.envelope.subject_digest);
  assert.equal(sealed.receipt.execution.context_digest, sealed.receipt.intent.context_digest);
  assert.equal(f.store.inspect(v.input.request_id).phase, "sealed");
  assert.deepEqual(await v.runDurably(), sealed);
  assert.equal(JSON.parse(readFileSync(v.marker, "utf8")).pid, marker.pid, "exact replay must not launch another verifier");
  assert.deepEqual(f.readInFreshProcess(sealed.reference), sealed);
  const reopened = await f.observeOwned(openOwnedWorktreeResults(f.profile, { mode: "open" }));
  assert.deepEqual(await f.observeOwned(reopened.readVerification(sealed.reference)), sealed);
  await assert.rejects(f.observeOwned(reopened.materializeForVerification({ request_id: v.input.materialization_request_id,
    reference: result.reference, root: v.input.root, branch: v.input.branch })), /restart cannot manufacture/);
  await assert.rejects(f.store.lookupVerification({ ...sealed.receipt.intent, context_digest: `sha256:${"1".repeat(64)}` }), /already bound/);
  await assert.rejects(f.store.readVerification({ ...sealed.reference, receipt_digest: `sha256:${"2".repeat(64)}` }), /does not match/);
  assert.throws(() => authenticateSealedOwnedVerificationReceipt(structuredClone(sealed), sealed.receipt.intent), /original authenticated/);
  // The same protected template at another physical root must keep the actual
  // ordinary profile digest distinct; neither digest is substituted for the other.
  v.input.request_id = "verify_durable_second"; v.input.materialization_request_id = "materialize_durable_second";
  v.input.root = join(v.config.allocation_base, "durable-second"); v.input.branch = "fixture/verify-durable-second";
  const second = await v.runDurably(); assertVerifierExited(v.marker);
  assert.equal(second.receipt.intent.template.digest, sealed.receipt.intent.template.digest);
  assert.notEqual(second.receipt.execution.profile_digest, sealed.receipt.execution.profile_digest);
  assert.equal(second.receipt.execution.subject_digest, sealed.receipt.execution.subject_digest);
});

test("durable failures are historical failures, while changed content and copied candidates cannot seal", native, async t => {
  const f = await fixture(t), author = await f.author("durable_failure_author", 'fs.writeFileSync("src/contribution.txt", "authored\\n");');
  const result = await f.store.capture(request(author, "durable_failure_result"));
  const failing = verifier(f, result, "durable_failed_command", 'process.stderr.write("actual rejected condition\\n"); process.exitCode = 9;');
  const failed = await failing.runDurably(); assertVerifierExited(failing.marker);
  assert.equal(failed.receipt.evidence.verification.outcome, "failed");
  assert.equal(failed.receipt.evidence.verification.checks[0].exit_code, 9);
  assert.deepEqual(await failing.runDurably(), failed);
  assert.deepEqual(f.readInFreshProcess(failed.reference), failed);
  const changed = verifier(f, result, "durable_changed_bytes", 'fs.writeFileSync("src/common.txt", "changed\\n");');
  await assert.rejects(changed.runDurably(), /bindings differ|verification materialization differs/); assertVerifierExited(changed.marker);
  assert.equal(f.store.inspect(changed.input.request_id).phase, "failed");
  await assert.rejects(changed.runDurably(), /prior durable verification is failed/);
  await assert.rejects(f.store.readVerification({ verification_id: changed.input.request_id, receipt_digest: `sha256:${"0".repeat(64)}` }), /not durably sealed/);
  // This is a deliberate rejected-metadata attempt, not a verifier run.
  const tokenInput = { request_id: "forgery_allocation", reference: result.reference,
    root: join(failing.config.allocation_base, "forgery"), branch: "fixture/verification-forgery" };
  const token = await f.store.materializeForVerification(tokenInput);
  const intent = { ...failed.receipt.intent, request_id: "forged_verification", materialization_request_id: tokenInput.request_id,
    workspace: { root: tokenInput.root, branch: tokenInput.branch } };
  const execution = { ...failed.receipt.execution, request_id: intent.request_id, workspace_root: tokenInput.root };
  const fake = structuredClone(failed.receipt.evidence);
  fake.workspace = intent.workspace; fake.verification.request_id = intent.request_id;
  await assert.rejects(f.executeDurableTarget(token, intent, async (_binding, admit) => { admit(execution); return fake; }), /node-issued verification candidate/);
  assert.equal(f.store.inspect(intent.request_id).phase, "failed");
});

test("verification receipt bytes stay authenticated after actual completion", native, async t => {
  const f = await fixture(t), author = await f.author("receipt_tamper_author", 'fs.writeFileSync("src/contribution.txt", "authored\\n");');
  const result = await f.store.capture(request(author, "receipt_tamper_result"));
  const v = verifier(f, result, "receipt_tamper", 'assert.equal(fs.readFileSync("src/common.txt", "utf8"), "baseline\\n");');
  const sealed = await v.runDurably(); assertVerifierExited(v.marker);
  const record = join(f.operationDirectory(v.input.request_id), "state.json"), original = readFileSync(record);
  const changed = JSON.parse(original.toString("utf8")); changed.data.verification_receipt.evidence.verification.checks[0].exit_code = 9;
  try {
    writeFileSync(record, JSON.stringify(changed));
    await assert.rejects(f.store.readVerification(sealed.reference), /authentication failed/);
    await assert.rejects(f.observeOwned(openOwnedWorktreeResults(f.profile, { mode: "open" })), /authentication failed/);
  } finally { writeFileSync(record, original); }
  assert.deepEqual(await f.store.readVerification(sealed.reference), sealed);
});
