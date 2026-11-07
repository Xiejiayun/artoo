// Run after building: node --test apps/artood/test-fixtures/worktree-results-real.test.mjs
// Native POSIX Git/process integration evidence only. No injected lifecycle,
// receipt, worktree handle, model provider, verification, review or publication.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { createOwnedRunAdmission, createProcessAdapter } from "../dist/process-adapter.js";
import { openOwnedWorktreeResults } from "../dist/owned/worktree-results.js";
import { materializeOwnedWorktree, prepareOwnedWorktree, reserveOwnedWorktree } from "../dist/owned/worktree-reservation.js";

const supported = process.platform === "linux" || process.platform === "darwin";
const native = { skip: !supported, timeout: 240_000 };
const sha = (value) => createHash("sha256").update(value).digest("hex");
const checksum = (value) => `sha256:${sha(value)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(promise, message, milliseconds = 15_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(10);
  }
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

function assertClosedGit(receipt) {
  assert.ok(receipt.git.length > 0);
  assert.ok(receipt.git.every((command) => command.child_exit_observed && command.child_close_observed
    && command.group_absent && command.cleanup_confirmed && command.parent_guard_confirmed));
  assert.match(receipt.scope, /not verification, review, integration acceptance or publication/);
}

async function assertClosedWorkspaceReplayIdentity(f, source, sealed, relativeFile, replay) {
  const file = join(source.worktree.root, relativeFile), bytes = readFileSync(file), mode = lstatSync(file).mode & 0o777;
  const existingEmpty = join(source.worktree.root, "src/replay-existing-empty");
  const addedEmpty = join(source.worktree.root, "src/replay-added-empty");
  const directoryMode = lstatSync(existingEmpty).mode & 0o777;
  assert.deepEqual(readdirSync(existingEmpty), []); assert.equal(existsSync(addedEmpty), false);
  assert.ok(sealed.receipt.manifest.directories.includes("src/replay-existing-empty"));
  const commitBytes = git(f.repo, ["cat-file", "commit", sealed.receipt.commit]);
  assert.deepEqual(await replay(), sealed);
  // These are deliberate external changes to an already closed writer's
  // workspace. They test replay identity, not a new genuine writer result.
  const mutations = [
    { name: "changed bytes", change: () => writeFileSync(file, Buffer.concat([bytes, Buffer.from("external replay mutation\n")])),
      restore: () => writeFileSync(file, bytes) },
    { name: "added empty directory", change: () => mkdirSync(addedEmpty), restore: () => rmdirSync(addedEmpty) },
    { name: "deleted empty directory", change: () => rmdirSync(existingEmpty),
      restore: () => mkdirSync(existingEmpty, { mode: directoryMode }) },
    { name: "changed executable mode", change: () => chmodSync(file, mode & 0o111 ? mode & ~0o111 : mode | 0o100),
      restore: () => chmodSync(file, mode) },
  ];
  for (const mutation of mutations) {
    mutation.change();
    try { await assert.rejects(replay(), /already bound/, mutation.name); }
    finally { mutation.restore(); }
    assert.deepEqual(await replay(), sealed, `exact replay after restoring ${mutation.name}`);
  }
  assert.deepEqual(await f.store.read(sealed.reference), sealed);
  assert.equal(git(f.repo, ["rev-parse", "--verify", f.privateRef(sealed.reference.result_id)]).trim(), sealed.receipt.commit);
  assert.equal(git(f.repo, ["cat-file", "commit", sealed.receipt.commit]), commitBytes);
}

async function fixture(t, { mutateOpenOptions = false } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-worktree-results-")));
  const repo = join(root, "repository"), state = join(root, "result-state");
  const writers = [];
  t.after(async () => {
    // Never delete a writer's directory until its real adapter confirms stop.
    // A failed assertion retains the fixture if closure cannot be established.
    for (const writer of writers) {
      const closure = await writer.adapter.stopOwnedRun(writer.handle, writer.admission, "user_cancelled");
      assert.equal(closure.kind, "confirmed_closed", `cleanup closure for ${writer.identity.runId}`);
      await bounded(writer.draining, "writer event drain did not close during fixture cleanup");
    }
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
  const opening = openOwnedWorktreeResults(profile, openOptions);
  if (mutateOpenOptions) openOptions.mode = "open";
  const store = await opening;

  async function freshWorktree(name) {
    const prepared = await prepareOwnedWorktree({ root: join(root, `worktree-${name}`), branch: `fixture/${name}`,
      sourceRepo: repo, sourceCommit: baseline, allowedRoots: [root] }, { gitExecutable: "/usr/bin/git", guardParent: true });
    return materializeOwnedWorktree(await reserveOwnedWorktree(prepared));
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
    const handle = await adapter.startOwnedRun(config, worktree, admission, new AbortController().signal);
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
  return { root, repo, state, baseline, profile, store, freshWorktree, startWriter, author, operationDirectory, privateRef };
}

test("fixed-baseline A/B results merge in real Git and C consumes their exact immutable result", native, async (t) => {
  const f = await fixture(t);
  // Advance the source checkout after profile creation: author allocation must
  // still use the configured immutable baseline, not its new HEAD.
  writeFileSync(join(f.repo, "README.md"), "later source HEAD\n");
  git(f.repo, ["add", "README.md"]); git(f.repo, ["commit", "--quiet", "--no-gpg-sign", "-m", "Advance source HEAD"]);
  assert.notEqual(git(f.repo, ["rev-parse", "HEAD"]).trim(), f.baseline);
  const a = await f.author("a", 'fs.writeFileSync("src/alpha.txt", "from A\\n"); fs.writeFileSync("README.md", "unscoped writer change\\n"); fs.mkdirSync("src/replay-existing-empty");');
  const b = await f.author("b", 'fs.writeFileSync("src/beta.txt", "from B\\n");');
  assert.equal(a.worktree.committedHead, f.baseline); assert.equal(b.worktree.committedHead, f.baseline);
  const ar = await f.store.capture(request(a, "result_a"));
  const br = await f.store.capture(request(b, "result_b"));
  for (const result of [ar, br]) {
    assertClosedGit(result.receipt); assert.deepEqual(result.receipt.parents, [f.baseline]);
    assert.equal(result.receipt.base_commit, f.baseline);
    assert.equal(git(f.repo, ["show", `${result.receipt.commit}:README.md`]), "outside scope baseline\n");
  }
  assert.equal(git(a.worktree.root, ["rev-parse", "HEAD"]).trim(), f.baseline);
  await assertClosedWorkspaceReplayIdentity(f, a, ar, "src/alpha.txt", () => f.store.capture(request(a, "result_a")));
  await assert.rejects(f.store.capture(request(b, "result_a")), /already bound/);

  const merged = await f.store.merge({ request_id: "merge_ab", inputs: [ar.reference, br.reference] });
  assert.equal(merged.outcome, "candidate"); assertClosedGit(merged.receipt);
  assert.deepEqual(merged.receipt.parents, [ar.receipt.commit, br.receipt.commit]);
  assert.equal(merged.receipt.base_commit, f.baseline);
  assert.equal(git(f.repo, ["show", `${merged.receipt.commit}:src/alpha.txt`]), "from A\n");
  assert.equal(git(f.repo, ["show", `${merged.receipt.commit}:src/beta.txt`]), "from B\n");
  assert.deepEqual((await f.store.merge({ request_id: "merge_ab", inputs: [ar.reference, br.reference] })).reference, merged.reference);
  const cInput = { request_id: "consume_ab", reference: merged.reference, root: join(f.root, "worktree-c"), branch: "fixture/c" };
  const cWorktree = await f.store.materialize(cInput);
  assert.equal(cWorktree.committedHead, merged.receipt.commit);
  const c = await f.author("c", 'assert.equal(fs.readFileSync("src/alpha.txt", "utf8"), "from A\\n"); assert.equal(fs.readFileSync("src/beta.txt", "utf8"), "from B\\n"); fs.writeFileSync("src/final.txt", fs.readFileSync("src/alpha.txt", "utf8") + fs.readFileSync("src/beta.txt", "utf8") + "from C\\n");', cWorktree);
  await assert.rejects(f.store.capture(request(c, "c_without_input")), /fixed repository\/baseline|exact input/);
  const cr = await f.store.capture(request(c, "result_c", merged.reference));
  assert.deepEqual(cr.receipt.inputs, [merged.reference]); assert.deepEqual(cr.receipt.parents, [merged.receipt.commit]);
  assert.equal(git(f.repo, ["show", `${cr.receipt.commit}:src/final.txt`]), "from A\nfrom B\nfrom C\n");

  // A new Node process has no access to the private in-memory writer objects.
  // It can authenticate immutable content and historical status from the store.
  const moduleUrl = new URL("../dist/owned/worktree-results.js", import.meta.url).href;
  const reopenScript = `import { openOwnedWorktreeResults } from ${JSON.stringify(moduleUrl)};
const store = await openOwnedWorktreeResults(JSON.parse(process.argv[1]), { mode: "open" });
const result = await store.read(JSON.parse(process.argv[2]));
process.stdout.write(JSON.stringify({ commit: result.receipt.commit, phase: store.inspect(result.reference.result_id).phase }));`;
  const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", reopenScript, JSON.stringify(f.profile), JSON.stringify(cr.reference)], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
  }));
  assert.deepEqual(restarted, { commit: cr.receipt.commit, phase: "sealed" });
  const reopened = await openOwnedWorktreeResults(f.profile, { mode: "open" });
  await assert.rejects(reopened.materialize(cInput), /restart cannot manufacture/);
  const fresh = await reopened.materialize({ request_id: "consume_c_after_restart", reference: cr.reference,
    root: join(f.root, "worktree-after-restart"), branch: "fixture/after-restart" });
  assert.equal(readFileSync(join(fresh.root, "src/final.txt"), "utf8"), "from A\nfrom B\nfrom C\n");
});

test("real text conflicts are retained and only a new owned writer can supply a repaired candidate", native, async (t) => {
  const f = await fixture(t);
  const a = await f.author("conflict_a", 'fs.writeFileSync("src/common.txt", "left choice\\n");');
  const b = await f.author("conflict_b", 'fs.writeFileSync("src/common.txt", "right choice\\n");');
  const ar = await f.store.capture(request(a, "conflict_left")), br = await f.store.capture(request(b, "conflict_right"));
  const merged = await f.store.merge({ request_id: "real_conflict", inputs: [ar.reference, br.reference] });
  assert.equal(merged.outcome, "conflicted"); assert.deepEqual(merged.conflict.paths, ["src/common.txt"]);
  assert.equal(merged.conflict.base_commit, f.baseline);
  assert.equal(merged.conflict.ours, ar.receipt.commit); assert.equal(merged.conflict.theirs, br.receipt.commit);
  assert.ok(merged.conflict.git.some((command) => command.args.includes("merge-tree") && command.status === 1));
  assert.match(git(f.repo, ["show", `${merged.conflict.candidate_commit}:src/common.txt`]), /^<<<<<<< /m);
  assert.equal(f.store.inspect("real_conflict").phase, "conflicted");
  assert.deepEqual(await f.store.conflict(merged.reference), merged.conflict);
  assert.deepEqual((await f.store.merge({ request_id: "real_conflict", inputs: [ar.reference, br.reference] })).reference, merged.reference);
  await assert.rejects(f.store.resolve({ ...request(a, "foreign_repair"), conflict_ref: merged.reference }), /fixed repository\/baseline|exact input/);

  const unchangedWorktree = await f.store.materialize({ request_id: "consume_conflict_unchanged", reference: merged.reference,
    root: join(f.root, "worktree-unchanged"), branch: "fixture/unchanged" });
  const unchanged = await f.author("unchanged", 'assert.match(fs.readFileSync("src/common.txt", "utf8"), /^<<<<<<< /m);', unchangedWorktree);
  await assert.rejects(f.store.resolve({ ...request(unchanged, "unresolved_repair"), conflict_ref: merged.reference }), /unresolved/);
  assert.equal(f.store.inspect("unresolved_repair").phase, "failed");
  await assert.rejects(f.store.resolve({ ...request(unchanged, "unresolved_repair"), conflict_ref: merged.reference }), /prior operation is failed/);

  const repairWorktree = await f.store.materialize({ request_id: "consume_conflict_repair", reference: merged.reference,
    root: join(f.root, "worktree-repair"), branch: "fixture/repair" });
  const repair = await f.author("repair", 'assert.match(fs.readFileSync("src/common.txt", "utf8"), /^<<<<<<< /m); fs.writeFileSync("src/common.txt", "combined left and right choices\\n"); fs.mkdirSync("src/replay-existing-empty");', repairWorktree);
  await assert.rejects(f.store.resolve({ ...request(repair, "forged_repair"), closure: structuredClone(repair.closure), conflict_ref: merged.reference }), /genuine closed writer/);
  const resolved = await f.store.resolve({ ...request(repair, "resolved_conflict"), conflict_ref: merged.reference });
  assert.equal(resolved.receipt.kind, "resolution"); assert.deepEqual(resolved.receipt.conflict, merged.reference);
  assert.deepEqual(resolved.receipt.parents, [ar.receipt.commit, br.receipt.commit]); assertClosedGit(resolved.receipt);
  assert.equal(git(f.repo, ["show", `${resolved.receipt.commit}:src/common.txt`]), "combined left and right choices\n");
  await assertClosedWorkspaceReplayIdentity(f, repair, resolved, "src/common.txt",
    () => f.store.resolve({ ...request(repair, "resolved_conflict"), conflict_ref: merged.reference }));
  assert.equal(f.store.inspect("real_conflict").phase, "conflicted");
});

test("serialized, substituted and running writer receipts never authorize capture", native, async (t) => {
  const f = await fixture(t);
  const a = await f.author("genuine_a", 'fs.writeFileSync("src/common.txt", "genuine A\\n");');
  const b = await f.author("genuine_b", 'fs.writeFileSync("src/common.txt", "genuine B\\n");');
  const variants = [
    { closure: structuredClone(a.closure) },
    { closure: { kind: "confirmed_closed", observedAt: new Date().toISOString(), facts: a.closure.facts } },
    { admission: createOwnedRunAdmission(a.identity) },
    { handle: { ...a.handle } },
    { worktree: { ...a.worktree } },
    { closure: b.closure },
  ];
  for (const [index, substitute] of variants.entries()) {
    const requestId = `forgery_${index}`;
    await assert.rejects(f.store.capture({ ...request(a, requestId), ...substitute }), /genuine closed writer/);
    assert.equal(existsSync(f.operationDirectory(requestId)), false);
  }
  const running = await f.startWriter("live", 'fs.writeFileSync("src/live.txt", "live writer bytes\\n"); console.log("writer-ready"); setInterval(() => {}, 1000);');
  await waitFor(() => running.events.some((event) => event.type === "run.output" && event.payload.text.includes("writer-ready")), "live writer never became ready");
  running.closure = await running.adapter.inspectOwnedRun(running.handle, running.admission);
  assert.equal(running.closure.kind, "running");
  await assert.rejects(f.store.capture(request(running, "while_running")), /genuine closed writer/);
  assert.equal(existsSync(f.operationDirectory("while_running")), false);
  running.closure = await running.adapter.stopOwnedRun(running.handle, running.admission, "user_cancelled");
  assert.equal(running.closure.kind, "confirmed_closed"); await bounded(running.draining, "stopped writer did not drain");
  const sealed = await f.store.capture(request(running, "after_closed"));
  assert.equal(sealed.receipt.manifest.files.find((file) => file.path === "src/live.txt").checksum, checksum("live writer bytes\n"));
  assert.match(sealed.receipt.source.closure_scope, /not business success or verification/);
});

test("capture snapshots caller identities before asynchronous Git observations", native, async (t) => {
  // Store create/open mode must also be copied before its first Git await.
  const f = await fixture(t, { mutateOpenOptions: true });
  const a = await f.author("snapshot_a", 'fs.writeFileSync("src/common.txt", "snapshot A\\n");');
  const b = await f.author("snapshot_b", 'fs.writeFileSync("src/common.txt", "snapshot B\\n");');
  const mutable = request(a, "snapshot_original");
  const capturing = f.store.capture(mutable);
  Object.assign(mutable, request(b, "snapshot_substituted"));
  const result = await capturing;
  assert.equal(result.reference.result_id, "snapshot_original");
  assert.equal(result.receipt.source.run_id, a.identity.runId);
  assert.equal(result.receipt.source.workspace_root, a.worktree.root);
  assert.equal(result.receipt.manifest.files.find((file) => file.path === "src/common.txt").checksum, checksum("snapshot A\n"));
  assert.equal(git(f.repo, ["show", `${result.receipt.commit}:src/common.txt`]), "snapshot A\n");
  assert.equal(existsSync(f.operationDirectory("snapshot_substituted")), false);
});

test("deleting an empty parent while adding its empty child cannot seal an unreproducible merge", native, async (t) => {
  const f = await fixture(t);
  const upstream = await f.author("empty_upstream", 'fs.mkdirSync("src/group");');
  const input = await f.store.capture(request(upstream, "empty_input"));
  assert.ok(input.receipt.manifest.directories.includes("src/group"));
  const aWorktree = await f.store.materialize({ request_id: "consume_empty_a", reference: input.reference,
    root: join(f.root, "worktree-empty-a"), branch: "fixture/empty-a" });
  const bWorktree = await f.store.materialize({ request_id: "consume_empty_b", reference: input.reference,
    root: join(f.root, "worktree-empty-b"), branch: "fixture/empty-b" });
  for (const worktree of [aWorktree, bWorktree]) {
    assert.equal(worktree.committedHead, input.receipt.commit);
    assert.ok(lstatSync(join(worktree.root, "src/group")).isDirectory());
  }
  const a = await f.author("empty_delete", 'assert.deepEqual(fs.readdirSync("src/group"), []); fs.rmdirSync("src/group");', aWorktree);
  const b = await f.author("empty_child", 'assert.deepEqual(fs.readdirSync("src/group"), []); fs.mkdirSync("src/group/new");', bWorktree);
  const ar = await f.store.capture(request(a, "empty_deleted", input.reference));
  const br = await f.store.capture(request(b, "empty_added", input.reference));
  assert.ok(!ar.receipt.manifest.directories.includes("src/group"));
  assert.ok(br.receipt.manifest.directories.includes("src/group/new"));
  await assert.rejects(f.store.merge({ request_id: "empty_conflict", inputs: [ar.reference, br.reference] }));
  assert.equal(f.store.inspect("empty_conflict").phase, "failed");
  assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", f.privateRef("empty_conflict")]), "");
  await assert.rejects(f.store.merge({ request_id: "empty_conflict", inputs: [ar.reference, br.reference] }), /prior operation is failed/);
});

test("concurrent arrivals cannot overlap the repository executor and the rejected request can retry", native, async (t) => {
  const f = await fixture(t);
  const a = await f.author("parallel_a", 'fs.writeFileSync("src/common.txt", "parallel A\\n");');
  const b = await f.author("parallel_b", 'fs.writeFileSync("src/common.txt", "parallel B\\n");');
  const other = await openOwnedWorktreeResults(f.profile, { mode: "open" });
  const busy = /another.*operation|single.writer|already.*active|executor.*busy/i;
  async function finishArrival(pending, rejections) {
    // Drain every real operation before propagating a failed assertion, so
    // fixture cleanup cannot remove a still-active Git executor's workspace.
    const settled = await Promise.allSettled([...rejections, pending]);
    for (const result of settled) if (result.status === "rejected") throw result.reason;
    return settled.at(-1).value;
  }
  const first = f.store.capture(request(a, "parallel_result_a"));
  const second = f.store.capture(request(b, "parallel_result_b"));
  const ar = await finishArrival(first, [assert.rejects(second, busy)]);
  assert.equal(existsSync(f.operationDirectory("parallel_result_b")), false);

  // The same exact B request remains admissible after A releases the lease.
  // A separately opened store and a new open must honor that shared lease.
  const retry = f.store.capture(request(b, "parallel_result_b"));
  const br = await finishArrival(retry, [
    assert.rejects(other.read(ar.reference), busy),
    assert.rejects(other.capture(request(a, "parallel_cross_store")), busy),
    assert.rejects(openOwnedWorktreeResults(f.profile, { mode: "open" }), busy),
  ]);
  assert.equal(existsSync(f.operationDirectory("parallel_cross_store")), false);
  for (const [result, source, expected] of [[ar, a, "parallel A\n"], [br, b, "parallel B\n"]]) {
    assert.equal(result.receipt.source.run_id, source.identity.runId);
    assert.equal(result.receipt.source.workspace_root, source.worktree.root);
    assert.equal(result.receipt.manifest.files.find((file) => file.path === "src/common.txt").checksum, checksum(expected));
    assert.equal(git(f.repo, ["show", `${result.receipt.commit}:src/common.txt`]), expected);
    assert.deepEqual((await other.read(result.reference)).reference, result.reference);
  }
});

test("private state permissions, authenticated bytes, private refs and Git metadata are checked on consumption", native, async (t) => {
  const f = await fixture(t);
  const a = await f.author("tamper", 'fs.writeFileSync("src/common.txt", "protected content\\n");');
  const sealed = await f.store.capture(request(a, "protected_result"));
  const operation = f.operationDirectory("protected_result"), stateFile = join(operation, "state.json");
  for (const path of [f.state, join(f.state, "operations"), join(f.state, "commits"), operation,
    join(f.state, "key"), join(f.state, "marker.json"), stateFile]) {
    const reader = await openOwnedWorktreeResults(f.profile, { mode: "open" });
    const originalMode = lstatSync(path).mode & 0o777;
    try {
      chmodSync(path, lstatSync(path).isDirectory() ? 0o777 : 0o666);
      await assert.rejects(reader.read(sealed.reference), undefined, `read with exposed ${path}`);
      await assert.rejects(openOwnedWorktreeResults(f.profile, { mode: "open" }), undefined, `reopen with exposed ${path}`);
    } finally { chmodSync(path, originalMode); }
  }
  const reader = await openOwnedWorktreeResults(f.profile, { mode: "open" });
  const original = readFileSync(stateFile), forged = JSON.parse(original.toString("utf8"));
  forged.data.receipt.manifest.files[0].checksum = checksum("fabricated content");
  try {
    writeFileSync(stateFile, JSON.stringify(forged));
    await assert.rejects(reader.read(sealed.reference), /authentication|changed|continuity/);
  } finally { writeFileSync(stateFile, original); }

  const freshReader = await openOwnedWorktreeResults(f.profile, { mode: "open" });
  const ref = f.privateRef("protected_result");
  try {
    git(f.repo, ["update-ref", ref, f.baseline, sealed.receipt.commit]);
    await assert.rejects(freshReader.read(sealed.reference), /private result ref changed/);
  } finally { git(f.repo, ["update-ref", ref, sealed.receipt.commit, f.baseline]); }

  const metadataReader = await openOwnedWorktreeResults(f.profile, { mode: "open" });
  const refs = join(f.repo, ".git", "refs", "artoo"), retained = join(f.root, "retained-artoo-refs");
  const originalRefs = lstatSync(refs);
  assert.ok(originalRefs.isDirectory() && !originalRefs.isSymbolicLink());
  renameSync(refs, retained);
  let linkIdentity, mutationFailure;
  try {
    assert.equal(lstatSync(refs, { throwIfNoEntry: false }), undefined, "rename must vacate the original refs entry");
    symlinkSync(retained, refs, "dir");
    const link = lstatSync(refs);
    assert.ok(link.isSymbolicLink(), "metadata tamper fixture must install an actual symbolic link");
    assert.equal(readlinkSync(refs), retained);
    linkIdentity = { dev: link.dev, ino: link.ino };
    await assert.rejects(metadataReader.read(sealed.reference));
    await assert.rejects(openOwnedWorktreeResults(f.profile, { mode: "open" }));
  } catch (error) { mutationFailure = error; }
  try {
    // Remove only the exact link installed above, never its target or an
    // unexpected directory. Keep a setup/assertion error if cleanup also fails.
    if (linkIdentity) {
      const link = lstatSync(refs);
      assert.ok(link.isSymbolicLink(), "metadata operation must not replace the fixture link");
      assert.deepEqual({ dev: link.dev, ino: link.ino }, linkIdentity);
      assert.equal(readlinkSync(refs), retained);
      unlinkSync(refs);
    } else {
      assert.equal(lstatSync(refs, { throwIfNoEntry: false }), undefined, "refusing cleanup of an unowned refs entry");
    }
    const retainedRefs = lstatSync(retained);
    assert.ok(retainedRefs.isDirectory() && !retainedRefs.isSymbolicLink());
    assert.deepEqual({ dev: retainedRefs.dev, ino: retainedRefs.ino }, { dev: originalRefs.dev, ino: originalRefs.ino });
    renameSync(retained, refs);
  } catch (cleanupFailure) {
    if (mutationFailure) throw new AggregateError([mutationFailure, cleanupFailure], "Metadata tamper assertion/setup and cleanup both failed");
    throw cleanupFailure;
  }
  if (mutationFailure) throw mutationFailure;
  assert.equal((await (await openOwnedWorktreeResults(f.profile, { mode: "open" })).read(sealed.reference)).receipt.commit, sealed.receipt.commit);
});
