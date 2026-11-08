// Run only after integrating and building the projection and domain drafts:
// node --test apps/artood/test-fixtures/owned-result-projection-real.test.mjs
// Native POSIX writer/Git/verifier projection evidence only. These scenarios do
// not establish provider, product-stage, independent-review or publication acceptance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import {
  NodeOwnedResultProfileDescriptorV1Schema, NodeOwnedResultVerificationEvidenceV1Schema,
  OwnedResultRequirementV1Schema, OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST,
  canonicalOwnedResultAuthorContextV1, canonicalOwnedResultRequirementV1, canonicalOwnedResultVerificationIntentV1,
} from "@artoo/domain";
import { allocateWorkspaceRoot } from "@artoo/protocol";
import { allocationStartBinding } from "../dist/node-allocation-identity.js";
import { createOwnedRunAdmission, createProcessAdapter } from "../dist/process-adapter.js";
import { openOwnedWorktreeResults, worktreeResultFailureIsUncertain } from "../dist/owned/worktree-results.js";
import {
  authenticateProjectedOwnedResultVerification, describeOwnedResultProfile,
  prepareOwnedWorktreeVerificationTemplate, projectOwnedResultVerification, verifyOwnedWorktreeResultDurably,
} from "../dist/owned-worktree-verification.js";
import { materializeOwnedWorktree, prepareOwnedWorktree, reserveOwnedWorktree } from "../dist/owned/worktree-reservation.js";

const native = { skip: process.platform !== "linux" && process.platform !== "darwin", timeout: 600_000 };
const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const jsonCopy = value => JSON.parse(JSON.stringify(value));
const authorDigest = start => digest(canonicalOwnedResultAuthorContextV1(start.context_pack.payload));

async function bounded(promise, message, milliseconds = 15_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

function assertExited(marker) {
  assert.equal(existsSync(`${marker}.pending`), false, "only the atomically published marker is evidence");
  const actual = JSON.parse(readFileSync(marker, "utf8"));
  assert.ok(Number.isInteger(actual.pid) && actual.pid > 0);
  assert.throws(() => process.kill(actual.pid, 0), error => error.code === "ESRCH",
    "the actual process PID must be absent after awaited production closure");
  return actual;
}

function assertClosed(receipt) {
  assert.equal(receipt.kind, "confirmed_closed");
  assert.equal(receipt.facts?.childSpawned, true);
  assert.equal(receipt.facts?.childExitObserved, true);
  assert.equal(receipt.facts?.childStdioClosed, true);
  assert.equal(receipt.facts?.groupAbsent, true);
}

async function withFixture(t, body) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-result-projection-")));
  const repo = join(root, "repository"), state = join(root, "result-state"), allocationBase = join(root, "author-worktrees");
  const writers = [], ownedOperations = [];
  let unreturnedWriter = false, nativeCallUncertain = false, primaryFailure = false;
  // Keep the genuine objects. Observe every operation immediately, including
  // setup, capture and reopen; a structural wrapper is not a store authority.
  const observeOwned = promise => {
    ownedOperations.push(promise.then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason })));
    return promise;
  };
  const nativeCall = (executable, args, options) => {
    nativeCallUncertain = true;
    const result = execFileSync(executable, args, options);
    nativeCallUncertain = false;
    return result;
  };
  const git = args => nativeCall("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: repo, env: gitEnvironment(), encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  try {
    mkdirSync(repo, { mode: 0o700 }); mkdirSync(join(repo, "src")); mkdirSync(allocationBase, { mode: 0o700 });
    writeFileSync(join(repo, "src", "common.txt"), "baseline\n");
    writeFileSync(join(repo, "README.md"), "outside the result content scope\n");
    // Native Git here only initializes the throwaway source repository.
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["config", "user.name", "Artoo fixture"]); git(["config", "user.email", "fixture@artoo.local"]);
    git(["add", "--all"]); git(["commit", "--quiet", "--no-gpg-sign", "-m", "Fixed projection fixture baseline"]);
    const baseline = git(["rev-parse", "HEAD"]).trim();
    const profile = { version: 1, id: "projection_results", node_id: "node_projection", project_id: "project_projection",
      repository_root: repo, state_root: state, baseline_commit: baseline, content_paths: ["src"],
      allowed_roots: [root], git_executable: "/usr/bin/git" };
    const store = await observeOwned(openOwnedWorktreeResults(profile, { mode: "create" }));

    async function prepareAuthor(name, description, { legacy = false } = {}) {
      const runId = `run_${name}`, taskId = `task_${name}`, instanceId = `ai_${name}`;
      const workspaceRoot = allocateWorkspaceRoot({ workspaceRoot: null, branchBacked: true,
        targetComputerOs: process.platform, agentInstanceId: instanceId, runId,
        worktreeBase: { version: 1, strategy: "per-run", basePath: allocationBase } });
      assert.equal(typeof workspaceRoot, "string");
      mkdirSync(dirname(workspaceRoot), { recursive: true, mode: 0o700 });
      const prepared = await observeOwned(prepareOwnedWorktree({ root: workspaceRoot, branch: `fixture/${name}`,
        sourceRepo: repo, sourceCommit: baseline, allowedRoots: [root] }, { gitExecutable: "/usr/bin/git", guardParent: true }));
      const reserved = await observeOwned(reserveOwnedWorktree(prepared));
      const worktree = await observeOwned(materializeOwnedWorktree(reserved));
      const runStart = { run_id: runId, task_id: taskId, agent_instance_id: instanceId, runtime: "fixture",
        workspace: { root: workspaceRoot, branch: worktree.branch },
        ...(!legacy ? { workspace_allocation: { version: 1, strategy: "per-run", base_path: allocationBase },
          workspace_retention_reporting: "typed-v1" } : {}),
        context_pack: { id: `ctx_${name}`, payload: {
          task: { id: taskId, title: "Author the scoped result", description, acceptance_criteria: ["Write the requested contribution"] },
          project: { id: profile.project_id, name: "Projection fixture", default_workspace: repo },
          workspace: { root: workspaceRoot, file_scope: ["src"] },
          policy: { filesystem_write_scope: ["src"], requires_approval: [] },
          memory: { task_summary: null, project_notes: [] }, artifacts: { expected: ["src/contribution.txt"] },
        } },
        policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: [] }, artifact_rules: { paths: [] } };
      if (!legacy) assert.ok(allocationStartBinding(runStart, process.platform, true));
      return { name, worktree, runStart };
    }

    async function author(plan, { runStart = plan.runStart, admissionKey, content = "authored contribution\n",
      mutateAfterStart = false, rewriteRenderedContext = false } = {}) {
      const key = admissionKey ?? allocationStartBinding(runStart, process.platform, true)?.key;
      assert.equal(typeof key, "string");
      const script = join(root, `author-${plan.name}.mjs`), marker = join(root, `author-${plan.name}.json`);
      writeFileSync(script, `import * as fs from "node:fs";\nimport assert from "node:assert/strict";\nimport {createHash} from "node:crypto";\n`
        + `const rendered = fs.readFileSync("context_pack.md");\n`
        + `assert.ok(rendered.toString("utf8").includes(${JSON.stringify(runStart.context_pack.payload.task.description)}));\n`
        + `const initial_rendered_context = {digest:"sha256:" + createHash("sha256").update(rendered).digest("hex"),size:rendered.length};\n`
        + `fs.writeFileSync(${JSON.stringify(`${marker}.pending`)}, JSON.stringify({pid:process.pid,cwd:process.cwd(),initial_rendered_context}), {flag:"wx"});\n`
        + `fs.renameSync(${JSON.stringify(`${marker}.pending`)}, ${JSON.stringify(marker)});\n`
        + `if (${JSON.stringify(rewriteRenderedContext)}) fs.writeFileSync("context_pack.md", "writer replaced context after its initial read\\n");\n`
        + `fs.writeFileSync("src/contribution.txt", ${JSON.stringify(content)});\n`, { flag: "wx" });
      const identity = { launchKey: key, runId: runStart.run_id, taskId: runStart.task_id,
        agentInstanceId: runStart.agent_instance_id, runtime: runStart.runtime,
        workspaceRoot: plan.worktree.root, workspaceBranch: plan.worktree.branch };
      const admission = createOwnedRunAdmission(identity);
      const adapter = createProcessAdapter({ runtimeId: "fixture", command: [process.execPath, script], allowedRoots: [root] });
      const config = { runId: identity.runId, taskId: identity.taskId, agentInstanceId: identity.agentInstanceId,
        runtime: identity.runtime, workspaceRoot: plan.worktree.root, runStart: jsonCopy(runStart) };
      let handle;
      try {
        const starting = observeOwned(adapter.startOwnedRun(config, plan.worktree, admission, new AbortController().signal));
        if (mutateAfterStart) {
          // Mutate caller-owned input before the first asynchronous preparation
          // returns. The invocation must already own its original snapshot.
          config.runStart.context_pack.id = "ctx_caller_changed_after_start";
          config.runStart.context_pack.payload.task.description = "caller changed the context after invoking start";
          config.runStart.artifact_rules.paths = ["caller-changed-artifact.txt"];
        }
        handle = await starting;
      }
      catch (error) { unreturnedWriter = true; throw error; }
      const events = [];
      const draining = observeOwned((async () => { for await (const event of adapter.streamEvents(handle)) events.push(event); })());
      const writer = { ...plan, runStart, identity, admission, adapter, handle, events, draining, script, marker };
      writers.push(writer);
      await bounded(draining, `writer ${plan.name} did not finish`);
      assert.equal(events.filter(event => event.type === "run.lifecycle").at(-1)?.payload.phase, "completed", JSON.stringify(events));
      writer.closure = await observeOwned(adapter.stopOwnedRun(handle, admission, "user_cancelled"));
      assertClosed(writer.closure); writer.observation = assertExited(marker);
      assert.equal(writer.observation.cwd, plan.worktree.root);
      return writer;
    }

    function capture(writer, requestId) {
      return observeOwned(store.capture({ request_id: requestId, worktree: writer.worktree,
        admission: writer.admission, handle: writer.handle, closure: writer.closure }));
    }

    function readProjectionInFreshProcess(v, requirement, runStart, reference) {
      const script = join(root, `reopened-projector-${reference.verification_id}.mjs`);
      writeFileSync(script,
        `import assert from "node:assert/strict";\n`
        + `import {openOwnedWorktreeResults} from ${JSON.stringify(new URL("../dist/owned/worktree-results.js", import.meta.url).href)};\n`
        + `import {prepareOwnedWorktreeVerificationTemplate, describeOwnedResultProfile, projectOwnedResultVerification, authenticateProjectedOwnedResultVerification} from ${JSON.stringify(new URL("../dist/owned-worktree-verification.js", import.meta.url).href)};\n`
        + `const settled = [];\nconst observe = p => {settled.push(p.then(() => null, error => error)); return p;};\n`
        + `const store = await observe(openOwnedWorktreeResults(${JSON.stringify(profile)}, {mode:"open"}));\n`
        + `const template = prepareOwnedWorktreeVerificationTemplate(${JSON.stringify(v.config)});\n`
        + `assert.deepEqual(await observe(describeOwnedResultProfile(store, template)), ${JSON.stringify(requirement.profile)});\n`
        + `const verification = await observe(store.readVerification(${JSON.stringify(reference)}));\n`
        + `const evidence = await observe(projectOwnedResultVerification(template, {store, requirement:${JSON.stringify(requirement)}, run_start:${JSON.stringify(runStart)}, verification}));\n`
        + `assert.equal(authenticateProjectedOwnedResultVerification(evidence), evidence);\n`
        + `assert.throws(() => authenticateProjectedOwnedResultVerification(JSON.parse(JSON.stringify(evidence))));\n`
        + `assert.ok((await Promise.all(settled)).every(error => error === null));\nprocess.stdout.write(JSON.stringify(evidence));\n`, { flag: "wx" });
      // The new process has no writer admission/closure/proof WeakMap from this
      // process. Any abnormal reader completion retains the entire fixture.
      return JSON.parse(nativeCall(process.execPath, [script], { env: gitEnvironment(), encoding: "utf8",
        timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }));
    }

    await body({ root, repo, state, allocationBase, profile, baseline, store, observeOwned, prepareAuthor, author, capture,
      readProjectionInFreshProcess });
  } catch (error) { primaryFailure = true; throw error; }
  finally {
    const cleanupErrors = [];
    for (const writer of writers) {
      try {
        assertClosed(await observeOwned(writer.adapter.stopOwnedRun(writer.handle, writer.admission, "user_cancelled")));
        await bounded(writer.draining, "writer event drain did not close during fixture cleanup");
      } catch (error) { cleanupErrors.push(error); }
    }
    const settled = await Promise.all(ownedOperations);
    const uncertain = unreturnedWriter || nativeCallUncertain || cleanupErrors.length > 0
      || settled.some(result => result.status === "rejected" && worktreeResultFailureIsUncertain(result.reason));
    try {
      assert.equal(uncertain, false, `unknown writer/verifier/Git closure retains fixture: ${root}`);
      const suffix = relative(realpathSync.native(tmpdir()), root);
      assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`), "cleanup must stay inside the temporary root");
      assert.equal(realpathSync.native(root), root);
      rmSync(root, { recursive: true, force: true });
    } catch (cleanupError) {
      // Keep the assertion/execution failure primary; still make retained state
      // and cleanup failure visible instead of hiding them in an empty catch.
      if (primaryFailure) t.diagnostic(`Fixture retained at ${root}: ${cleanupError.message}`);
      else throw cleanupError;
    }
  }
}

function verifier(f, result, name, content = "authored contribution\n") {
  const allocation = join(f.root, "verification-worktrees");
  if (!existsSync(allocation)) mkdirSync(allocation, { mode: 0o700 });
  const script = join(f.root, `verifier-${name}.mjs`), marker = join(f.root, `verifier-${name}.json`);
  writeFileSync(script, `import * as fs from "node:fs";\nimport assert from "node:assert/strict";\n`
    + `const envelope = JSON.parse(fs.readFileSync(process.env.ARTOO_VERIFICATION_CONTEXT_FILE, "utf8"));\n`
    + `fs.writeFileSync(${JSON.stringify(`${marker}.pending`)}, JSON.stringify({pid:process.pid,cwd:process.cwd(),envelope}), {flag:"wx"});\n`
    + `fs.renameSync(${JSON.stringify(`${marker}.pending`)}, ${JSON.stringify(marker)});\n`
    + `assert.equal(fs.readFileSync("src/common.txt", "utf8"), "baseline\\n");\n`
    + `assert.equal(fs.readFileSync("src/contribution.txt", "utf8"), ${JSON.stringify(content)});\n`
    + `process.stdout.write("protected verifier completed\\n");\n`, { flag: "wx" });
  const config = { version: 1, id: `verifier_${name}`, node_id: f.profile.node_id, project_id: f.profile.project_id,
    results_profile_id: f.profile.id, results_profile_digest: result.receipt.profile_digest,
    repository_root: f.repo, allocation_base: allocation,
    commands: [{ id: "acceptance", argv: [process.execPath, script], timeout_ms: 30_000 }],
    subject_paths: ["src"], required_files: ["src/common.txt", "src/contribution.txt"] };
  const template = prepareOwnedWorktreeVerificationTemplate(config);
  const input = { store: f.store, request_id: `verify_${name}`, materialization_request_id: `verification_tree_${name}`,
    reference: result.reference, root: join(allocation, name), branch: `fixture/verify-${name}`, signal: new AbortController().signal };
  return { config, template, input, script, marker,
    run: () => f.observeOwned(verifyOwnedWorktreeResultDurably(template, input)) };
}

async function requirementFor(f, v, result, runStart) {
  const descriptor = await f.observeOwned(describeOwnedResultProfile(f.store, v.template));
  assert.deepEqual(NodeOwnedResultProfileDescriptorV1Schema.parse(descriptor), descriptor);
  return OwnedResultRequirementV1Schema.parse({ version: 1, request_id: v.input.request_id,
    capture_request_id: result.reference.result_id, verification_materialization_request_id: v.input.materialization_request_id,
    profile: descriptor, author_context_digest: authorDigest(runStart), input: { kind: "baseline" } });
}

function assertPublicOnly(value, forbiddenValues) {
  const forbiddenKeys = new Set(["argv", "commands", "repository_root", "state_root", "allowed_roots", "git_executable",
    "source", "git", "handle", "admission", "closure", "config", "trustedFiles", "launch_key", "launch_proof",
    "stdout", "stderr", "reason", "context", "context_pack", "observation", "measurement_plan"]);
  const visit = current => {
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) { assert.equal(forbiddenKeys.has(key), false, `private field ${key}`); visit(child); }
  };
  visit(value);
  const encoded = JSON.stringify(value);
  for (const privateValue of forbiddenValues) assert.equal(encoded.includes(privateValue), false, `private value leaked: ${privateValue}`);
}

test("real per-run author proof projects durable evidence and survives an independent store reopen", native, async t => {
  await withFixture(t, async f => {
    const plan = await f.prepareAuthor("happy", "projection original inline context marker");
    const author = await f.author(plan, { mutateAfterStart: true, rewriteRenderedContext: true });
    const finalRenderedBytes = readFileSync(join(author.worktree.root, "context_pack.md"));
    assert.equal(finalRenderedBytes.toString("utf8"), "writer replaced context after its initial read\n");
    const initialRendered = author.observation.initial_rendered_context;
    assert.match(initialRendered.digest, /^sha256:[a-f0-9]{64}$/u); assert.ok(initialRendered.size > 0);
    assert.notEqual(initialRendered.digest, digest(finalRenderedBytes));
    assert.notEqual(initialRendered.size, finalRenderedBytes.length);
    const result = await f.capture(author, "capture_happy");
    assert.equal(result.receipt.source.launch_key, allocationStartBinding(plan.runStart, process.platform, true).key);
    // The writer intentionally changed the context file after its initial read.
    // Capture must use the node's pre-spawn bytes, never a post-execution rehash.
    assert.deepEqual(result.receipt.source.launch_proof, { version: 1,
      launch_binding_digest: `sha256:${author.identity.launchKey}`, author_context_digest: authorDigest(plan.runStart),
      context_pack_id: plan.runStart.context_pack.id, rendered_context: initialRendered });
    assert.notEqual(initialRendered.digest, authorDigest(plan.runStart), "rendered bytes are not the original ContextPack canonical digest");
    assert.ok(result.receipt.git.length > 0);
    for (const execution of result.receipt.git) {
      assert.equal(execution.child_exit_observed, true); assert.equal(execution.child_close_observed, true);
      assert.equal(execution.group_absent, true); assert.equal(execution.cleanup_confirmed, true);
    }
    const v = verifier(f, result, "happy"), requirement = await requirementFor(f, v, result, plan.runStart);
    const sealed = await v.run(), actual = assertExited(v.marker);
    assert.equal(actual.cwd, v.input.root); assert.notEqual(actual.cwd, author.worktree.root);
    assert.equal(sealed.receipt.evidence.verification.outcome, "passed");
    assert.equal(sealed.receipt.evidence.verification.checks[0].exit_code, 0);
    const evidence = await f.observeOwned(projectOwnedResultVerification(v.template,
      { store: f.store, requirement, run_start: plan.runStart, verification: sealed }));
    assert.deepEqual(NodeOwnedResultVerificationEvidenceV1Schema.parse(evidence), evidence);
    assert.equal(authenticateProjectedOwnedResultVerification(evidence), evidence);
    assert.equal(Object.isFrozen(evidence), true); assert.equal(Object.isFrozen(evidence.verification.payload.checks), true);
    assert.throws(() => authenticateProjectedOwnedResultVerification(jsonCopy(evidence)), /original|authenticated|genuine/i);
    assert.equal(NodeOwnedResultVerificationEvidenceV1Schema.safeParse(jsonCopy(evidence)).success, true,
      "public schema validation alone cannot authenticate copied metadata");
    assert.deepEqual(evidence.result.reference, result.reference);
    assert.equal(evidence.author.author_context_digest, authorDigest(plan.runStart));
    assert.equal(evidence.author.launch_binding_digest, `sha256:${author.identity.launchKey}`);
    assert.equal(evidence.requirement_digest, digest(canonicalOwnedResultRequirementV1(requirement)));
    assert.equal(evidence.verification.intent_digest, digest(canonicalOwnedResultVerificationIntentV1(evidence)));
    assert.equal(evidence.verification.execution.context_digest, OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST);
    assert.equal(evidence.verification.execution.profile_digest, actual.envelope.profile_digest);
    assert.notEqual(evidence.verification.execution.profile_digest, evidence.template.digest);
    assert.notEqual(evidence.verification.execution.subject_digest, evidence.result.manifest_digest);
    assertPublicOnly(evidence, [f.state, f.repo, v.script, author.script, plan.runStart.context_pack.payload.task.description]);
    assertPublicOnly(requirement.profile, [f.state, f.repo, v.script, author.script]);

    const reopened = await f.observeOwned(openOwnedWorktreeResults(f.profile, { mode: "open" }));
    const historical = await f.observeOwned(reopened.readVerification(sealed.reference));
    assert.notEqual(historical, sealed); assert.deepEqual(historical, sealed);
    const replay = await f.observeOwned(projectOwnedResultVerification(v.template,
      { store: reopened, requirement, run_start: jsonCopy(plan.runStart), verification: historical }));
    assert.deepEqual(replay, evidence); assert.equal(authenticateProjectedOwnedResultVerification(replay), replay);
    // No original author object or old process-local WeakMap exists in this child.
    const restarted = f.readProjectionInFreshProcess(v, requirement, plan.runStart, sealed.reference);
    assert.deepEqual(NodeOwnedResultVerificationEvidenceV1Schema.parse(restarted), evidence);
    assert.throws(() => authenticateProjectedOwnedResultVerification(restarted), /original|authenticated|genuine/i);
  });
});

test("original receipts reject copied authorities and altered run, task, context and launch bindings", native, async t => {
  await withFixture(t, async f => {
    const plan = await f.prepareAuthor("binding", "binding fixture original context");
    const author = await f.author(plan), result = await f.capture(author, "capture_binding");
    const v = verifier(f, result, "binding"), requirement = await requirementFor(f, v, result, plan.runStart);
    const sealed = await v.run(); assertExited(v.marker);
    const input = { store: f.store, requirement, run_start: plan.runStart, verification: sealed };
    const copiedStore = { ...f.store }, fakeStore = {};
    for (const store of [copiedStore, fakeStore]) {
      await assert.rejects(f.observeOwned(describeOwnedResultProfile(store, v.template)), /genuine|authenticated|original/i);
      await assert.rejects(f.observeOwned(projectOwnedResultVerification(v.template, { ...input, store })), /genuine|authenticated|original/i);
    }
    await assert.rejects(f.observeOwned(describeOwnedResultProfile(f.store, jsonCopy(v.template))), /genuine|authenticated|original/i);
    await assert.rejects(f.observeOwned(projectOwnedResultVerification(jsonCopy(v.template), input)), /genuine|authenticated|original/i);
    await assert.rejects(f.observeOwned(projectOwnedResultVerification(v.template, { ...input, verification: jsonCopy(sealed) })),
      /genuine|authenticated|original/i);
    for (const [label, change] of [
      ["run", start => { start.run_id = "run_other"; }],
      ["task", start => { start.task_id = "task_other"; start.context_pack.payload.task.id = "task_other"; }],
      ["instance", start => { start.agent_instance_id = "ai_other"; }],
      ["context", start => { start.context_pack.payload.task.description = "replacement author context"; }],
      ["launch", start => { start.artifact_rules.paths = ["different-artifact.txt"]; }],
    ]) {
      const runStart = jsonCopy(plan.runStart); change(runStart);
      // Update the public digest too: internally self-consistent caller metadata
      // still cannot replace the actual launch recorded in the signed capture.
      const changedRequirement = { ...requirement, author_context_digest: authorDigest(runStart) };
      await assert.rejects(f.observeOwned(projectOwnedResultVerification(v.template,
        { ...input, requirement: changedRequirement, run_start: runStart })), /differ|match|binding|launch|author|per-run|allocated|context/i, label);
    }
    const tampered = jsonCopy(sealed); tampered.receipt.execution.subject_digest = `sha256:${"f".repeat(64)}`;
    await assert.rejects(f.observeOwned(projectOwnedResultVerification(v.template, { ...input, verification: tampered })),
      /genuine|authenticated|original/i);
    const valid = await f.observeOwned(projectOwnedResultVerification(v.template, input));
    assert.equal(valid.verification.payload.outcome, "passed", "rejected projections must not invalidate the actual historical receipt");
    const savedReaders = { read: f.store.read, readVerification: f.store.readVerification, lookupVerification: f.store.lookupVerification,
      materialize: f.store.materialize, materializeForVerification: f.store.materializeForVerification };
    let replacedReaderCalls = 0;
    try {
      for (const name of Object.keys(savedReaders)) f.store[name] = () => {
        replacedReaderCalls++;
        throw new Error(`public ${name} replacement must not supply projection facts`);
      };
      assert.deepEqual(await f.observeOwned(describeOwnedResultProfile(f.store, v.template)), requirement.profile);
      const protectedRead = await f.observeOwned(projectOwnedResultVerification(v.template, input));
      assert.deepEqual(protectedRead, valid);
      assert.equal(authenticateProjectedOwnedResultVerification(protectedRead), protectedRead);
      assert.equal(replacedReaderCalls, 0, "projection must use private reader closures without public execution entry points");
    } finally { Object.assign(f.store, savedReaders); }
  });
});

test("legacy and schema-stripped starts remain readable but cannot acquire retrospective launch proofs", native, async t => {
  await withFixture(t, async f => {
    const plan = await f.prepareAuthor("legacy", "legacy inline context remains executable", { legacy: true });
    const author = await f.author(plan, { admissionKey: "legacy_arbitrary_launch_key" });
    const result = await f.capture(author, "capture_legacy");
    assert.equal(result.receipt.source.launch_key, "legacy_arbitrary_launch_key");
    assert.equal(result.receipt.source.launch_proof, undefined);
    assert.deepEqual(await f.observeOwned(f.store.read(result.reference)), result);
    const v = verifier(f, result, "legacy"), requirement = await requirementFor(f, v, result, plan.runStart);
    const sealed = await v.run(); assertExited(v.marker);
    assert.equal(sealed.receipt.evidence.verification.outcome, "passed");
    await assert.rejects(f.observeOwned(projectOwnedResultVerification(v.template,
      { store: f.store, requirement, run_start: plan.runStart, verification: sealed })), /proof|per-run|allocation|launch/i);
    const claimed = { ...jsonCopy(plan.runStart), workspace_allocation: { version: 1, strategy: "per-run", base_path: f.allocationBase },
      workspace_retention_reporting: "typed-v1" };
    assert.ok(allocationStartBinding(claimed, process.platform, true));
    await assert.rejects(f.observeOwned(projectOwnedResultVerification(v.template,
      { store: f.store, requirement, run_start: claimed, verification: sealed })), /proof|launch/i);

    const unknownPlan = await f.prepareAuthor("unknown_context", "actual raw context carries an unsupported field");
    unknownPlan.runStart.context_pack.payload.unrecognized_fixture_field = "must not be silently removed from actual launch provenance";
    const parsedBinding = allocationStartBinding(unknownPlan.runStart, process.platform, true);
    assert.equal(parsedBinding.payload.context_pack.payload.unrecognized_fixture_field, undefined);
    assert.equal(authorDigest(unknownPlan.runStart), authorDigest(parsedBinding.payload),
      "the parsed ContextPack digest alone cannot prove that the actual raw input had no unknown fields");
    const unknownAuthor = await f.author(unknownPlan), unknownResult = await f.capture(unknownAuthor, "capture_unknown_context");
    assert.equal(unknownResult.receipt.source.launch_key, parsedBinding.key);
    assert.equal(unknownResult.receipt.source.launch_proof, undefined);
    assert.deepEqual(await f.observeOwned(f.store.read(unknownResult.reference)), unknownResult);
    const unknownVerifier = verifier(f, unknownResult, "unknown_context");
    const unknownRequirement = await requirementFor(f, unknownVerifier, unknownResult, unknownPlan.runStart);
    const unknownSealed = await unknownVerifier.run(); assertExited(unknownVerifier.marker);
    assert.equal(unknownSealed.receipt.evidence.verification.outcome, "passed");
    for (const runStart of [unknownPlan.runStart, parsedBinding.payload]) {
      await assert.rejects(f.observeOwned(projectOwnedResultVerification(unknownVerifier.template,
        { store: f.store, requirement: unknownRequirement, run_start: runStart, verification: unknownSealed })), /proof|per-run|launch/i);
    }
  });
});

test("an A-context admission key with an actual B-context writer cannot project either claimed launch", native, async t => {
  await withFixture(t, async f => {
    const plan = await f.prepareAuthor("cross_context", "context A was only supplied to admission");
    const startA = jsonCopy(plan.runStart), startB = jsonCopy(plan.runStart);
    startB.context_pack.payload.task.description = "context B actually reached the writer";
    const bindingA = allocationStartBinding(startA, process.platform, true), bindingB = allocationStartBinding(startB, process.platform, true);
    assert.notEqual(bindingA.key, bindingB.key); assert.deepEqual(startA.workspace, startB.workspace);
    const author = await f.author(plan, { runStart: startB, admissionKey: bindingA.key, content: "actual context B contribution\n" });
    const rendered = readFileSync(join(author.worktree.root, "context_pack.md"), "utf8");
    assert.ok(rendered.includes(startB.context_pack.payload.task.description));
    assert.equal(rendered.includes(startA.context_pack.payload.task.description), false);
    const result = await f.capture(author, "capture_cross_context");
    assert.equal(result.receipt.source.launch_key, bindingA.key);
    assert.equal(result.receipt.source.launch_proof, undefined,
      "a genuine writer closure does not prove that the admission key described the actual ContextPack");
    const v = verifier(f, result, "cross_context", "actual context B contribution\n");
    const sealed = await v.run(); assertExited(v.marker);
    assert.equal(sealed.receipt.evidence.verification.outcome, "passed");
    for (const runStart of [startA, startB]) {
      const requirement = await requirementFor(f, v, result, runStart);
      await assert.rejects(f.observeOwned(projectOwnedResultVerification(v.template,
        { store: f.store, requirement, run_start: runStart, verification: sealed })), /proof|launch/i);
    }
  });
});
