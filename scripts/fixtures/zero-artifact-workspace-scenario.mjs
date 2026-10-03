import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ZERO_ARTIFACT_FILES, zeroArtifactContextPath, zeroArtifactHash as hash, zeroArtifactWork } from "./zero-artifact-workspace.mjs";
import { gitWorktreePath, parseGitWorktreeRegistrations } from "./git-worktree-evidence.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
function git(directory, ...args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
}
const fileRecord = (path) => { const bytes = readFileSync(path); return { sha256: hash(bytes), size: bytes.length }; };
const jsonFiles = (directory, prefix) => readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
  .sort().map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));

/** Local disposable Git setup only: no server, node, instance or product mutation. */
export function createZeroArtifactWorkspaceSetup({ temporary, projectId, suffix, runtimeId = "ui-zero-artifact" }) {
  assert.ok(typeof suffix === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(suffix), "Use one safe disposable-fixture suffix");
  const directory = join(realpathSync(temporary), `zero-artifact-${suffix}`); mkdirSync(directory, { mode: 0o700 });
  const baseRepo = join(directory, "base"), workspaceRoot = join(directory, "worktree"), receipts = join(directory, "receipts");
  mkdirSync(baseRepo); mkdirSync(receipts, { mode: 0o700 });
  const baseline = "Original zero-artifact Git baseline.\n";
  writeFileSync(join(baseRepo, "implementation.txt"), baseline); writeFileSync(join(baseRepo, ".gitignore"), "ignored.bin\n");
  git(baseRepo, "init", "--initial-branch=fixture-base");
  const hooks = join(directory, "empty-hooks"); mkdirSync(hooks); git(baseRepo, "config", "core.hooksPath", hooks);
  git(baseRepo, "config", "core.autocrlf", "false"); git(baseRepo, "add", "implementation.txt", ".gitignore");
  git(baseRepo, "-c", "user.name=Artoo E2E", "-c", "user.email=e2e@artoo.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Disposable zero-artifact baseline");
  const baseHead = git(baseRepo, "rev-parse", "HEAD").trim(), baseIndex = hash(readFileSync(join(baseRepo, ".git/index")));
  const baseCommonDirectory = realpathSync(join(baseRepo, ".git"));
  const fields = { project_id: projectId, task_title: `Keep successful local work ${suffix}`,
    acceptance_criteria: ["Keep modified, new and ignored files after successful execution", "Complete without uploading any report artifact"],
    approval_summary: `Approve one zero-artifact execution ${suffix}`, computer_name: `Zero-artifact computer ${suffix}`,
    instance_name: `Zero-artifact executor ${suffix}`, workspace_root: workspaceRoot, runtime_id: runtimeId, base_repository: baseRepo, workspace_parent: directory };
  const configuration = { workspace_root: workspaceRoot, receipts_directory: receipts, project_id: projectId,
    task_title: fields.task_title, acceptance_criteria: fields.acceptance_criteria, baseline_sha256: hash(baseline) };
  const configurationPath = join(directory, "process.json"); writeFileSync(configurationPath, JSON.stringify(configuration), { mode: 0o600, flag: "wx" });
  return { fields, configuration, configurationPath, baseHead, baseIndex, baseRepo, baseCommonDirectory,
    directory, receipts, temporary: realpathSync(temporary) };
}

const waitUntil = async (predicate, message, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((done) => setTimeout(done, 75)); }
  throw new Error(message);
};

/** Passive server/filesystem observation for the caller's actual worker.
 * The caller provisions its disposable instance separately. No node or adapter
 * is constructed, paired, started or stopped through this interface. */
export function createZeroArtifactWorkspaceObserver({ setup, request, computerId, instanceId,
  runtimeId = setup.fields.runtime_id, until = waitUntil }) {
  for (const id of [computerId, instanceId, runtimeId]) assert.ok(typeof id === "string" && id.length > 0);
  const { configuration, configurationPath, baseHead, baseIndex, baseRepo, baseCommonDirectory, directory, receipts, temporary } = setup;
  const fields = { ...setup.fields, computer_id: computerId, instance_id: instanceId, runtime_id: runtimeId };
  const projectId = fields.project_id, workspaceRoot = fields.workspace_root;
  let closed = false;
  const observe = async () => {
    assert.equal(closed, false, "Zero-artifact observer is closed");
    const tasks = (await request(`/api/v1/tasks?project_id=${encodeURIComponent(projectId)}`)).tasks.filter((task) => task.title === fields.task_title);
    assert.ok(tasks.length <= 1, "Zero-artifact scenario must create one separate task");
    const snapshot = tasks.length ? await request(`/api/v1/tasks/${tasks[0].id}`) : null;
    const bundle = snapshot ? (await request(`/api/v1/tasks/${snapshot.task.id}/audit-bundle`)).bundle : null;
    const runReads = snapshot ? await Promise.all(snapshot.runs.map(async (run) => (await request(`/api/v1/runs/${run.id}`)).run)) : [];
    const records = jsonFiles(receipts, "run-"), launches = jsonFiles(receipts, "launch-");
    const contexts = records.map((record) => {
      const source = readFileSync(zeroArtifactContextPath(receipts, record.run_id), "utf8"), marker = "## Raw Payload\n";
      return { run_id: record.run_id, source, sha256: hash(source), pack: JSON.parse(source.slice(source.indexOf(marker) + marker.length)) };
    });
    assert.equal(closed, false, "Zero-artifact observer is closed");
    return { observed_at: new Date().toISOString(), snapshot, bundle, run_reads: runReads, receipts: records, launches, contexts,
      live_pids: launches.filter((record) => alive(record.pid)).map((record) => record.pid),
      base: { head: git(baseRepo, "rev-parse", "HEAD").trim(), index_sha256: hash(readFileSync(join(baseRepo, ".git/index"))),
        branch: git(baseRepo, "branch", "--show-current").trim(),
        refs: git(baseRepo, "for-each-ref", "--format=%(refname)", "refs/heads").trim().split("\n").sort(),
        status: git(baseRepo, "status", "--porcelain", "--untracked-files=all", "--ignored"),
        baseline_sha256: hash(readFileSync(join(baseRepo, "implementation.txt"))), registrations: git(baseRepo, "-c", "core.quotePath=false", "worktree", "list", "--porcelain") },
      workspace: existsSync(workspaceRoot) ? { root: workspaceRoot, head: git(workspaceRoot, "rev-parse", "HEAD").trim(),
        branch: git(workspaceRoot, "branch", "--show-current").trim(),
        common_directory: realpathSync(resolve(workspaceRoot, git(workspaceRoot, "rev-parse", "--git-common-dir").trim())),
        status: git(workspaceRoot, "status", "--porcelain", "--untracked-files=all", "--ignored"),
        ignored: git(workspaceRoot, "check-ignore", "--", "ignored.bin").trim(),
        files: Object.fromEntries([...ZERO_ARTIFACT_FILES, "context_pack.md"].map((name) => [name, fileRecord(join(workspaceRoot, name))])),
        report_exists: existsSync(join(workspaceRoot, "changes.patch")) } : null };
  };
  const expected = { fields, configuration, baseHead, baseIndex, baseRepo, baseCommonDirectory };
  const exportEvidence = (destination, observation) => {
    verifyZeroArtifactWorkspace({ ...expected, observation });
    assert.ok(isAbsolute(destination), "Use an absolute immutable evidence destination");
    const target = resolve(destination), parent = realpathSync(dirname(target));
    assert.equal(parent, dirname(target), "Evidence parent must be canonical, without symlink aliases");
    const outside = relative(realpathSync(temporary), target);
    assert.ok(outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside), "Evidence must survive the entire disposable-fixture cleanup");
    assert.equal(existsSync(target), false);
    assert.ok(jsonFiles(receipts, "launch-").every((record) => !alive(record.pid)), "Do not copy a live writer's workspace");
    const originals = [...ZERO_ARTIFACT_FILES, "context_pack.md"].map((name) => {
      const source = join(workspaceRoot, name), copied = join(target, name), stat = lstatSync(source);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Only original regular workspace files can be exported");
      const bytes = readFileSync(source);
      const record = { sha256: hash(bytes), size: bytes.length }; assert.deepEqual(record, observation.workspace.files[name]);
      return { source, copied, bytes, ...record };
    });
    mkdirSync(target, { mode: 0o700 });
    const files = originals.map(({ bytes, ...record }) => {
      const { copied, sha256, size } = record;
      writeFileSync(copied, bytes, { mode: 0o600, flag: "wx" });
      assert.deepEqual(fileRecord(copied), { sha256, size });
      return record;
    });
    const manifest = { scope: "Disposable fixture evidence copies; these are not uploaded product artifacts", files };
    writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return manifest;
  };
  const verify = async () => verifyZeroArtifactWorkspace({ ...expected, observation: await observe() });
  const waitForVerified = async (timeoutMs = 60_000) => {
    let observation, lastError;
    try {
      await until(async () => {
        assert.equal(closed, false, "Zero-artifact observer is closed");
        try { observation = await observe(); verifyZeroArtifactWorkspace({ ...expected, observation }); return true; }
        catch (error) { if (closed) throw error; lastError = error; return false; }
      }, "Zero-artifact execution did not produce complete retained evidence", timeoutMs);
    } catch (error) { throw closed ? error : lastError ?? error; }
    return observation;
  };
  return { ...expected, directory, receipts, configurationPath, temporary, observe, verify, waitForVerified, exportEvidence,
    close() { closed = true; } };
}

/** Backward-compatible owned-node facade for native/protocol fixtures. Installed
 * Mac certification uses the separate setup/observer with the actual app worker. */
export async function createZeroArtifactWorkspaceScenario({ root, temporary, projectId, suffix, request, origin, until = waitUntil }) {
  const setup = createZeroArtifactWorkspaceSetup({ temporary, projectId, suffix });
  const { fields, directory, receipts, baseRepo, configurationPath } = setup;
  const workspaceRoot = fields.workspace_root;
  const { createAdapterRegistry, createArtoodNode, createProcessAdapter } = await import(pathToFileURL(join(root, "apps/artood/dist/index.js")).href);
  let node, observer, closing;
  const close = () => closing ??= (async () => {
    observer?.close();
    await node?.stop();
    await until(() => jsonFiles(receipts, "launch-").every((entry) => !alive(entry.pid)), "Zero-artifact cleanup left an owned child alive", 10_000);
  })();
  try {
    const platform = process.platform === "win32" ? "windows" : "macos";
    const pairing = await request("/api/v1/devices/pairings", { intended_platform: platform });
    const claimed = await request("/api/v1/devices/claim", { code: pairing.code, platform, app_version: "zero-artifact-fixture", display_name: fields.computer_name });
    const enrolled = await request(`/api/v1/devices/${claimed.device.id}/enroll`, { display_name: fields.computer_name, hostname: "isolated-zero-artifact", os: platform, arch: process.arch });
    fields.computer_id = enrolled.computer_id;
    const adapter = createProcessAdapter({ runtimeId: fields.runtime_id,
      command: [process.execPath, join(root, "scripts/fixtures/zero-artifact-workspace.mjs"), "{{context_pack_path}}", configurationPath],
      allowedRoots: [directory], artifacts: [], outputFormat: "codex-json" });
    const socketURL = new URL("/api/v1/node", origin); socketURL.protocol = socketURL.protocol === "https:" ? "wss:" : "ws:"; socketURL.searchParams.set("token", claimed.node_token);
    node = createArtoodNode({ url: socketURL.href, registry: createAdapterRegistry([{ runtime: fields.runtime_id, capabilities: ["code.modify"], adapter }]),
      workspace: { worktreeBaseRepo: baseRepo, allowedRoots: [directory] }, acknowledgeRunEvents: true, heartbeatIntervalMs: 500,
      hello: { kind: "node.hello", node_id: fields.computer_id, protocol_version: "0.1", artood_version: "zero-artifact-fixture",
        machine: { hostname: "isolated-zero-artifact", os: platform, arch: process.arch } } });
    await node.start();
    await until(async () => (await request("/api/v1/daemons")).daemons.some((daemon) => daemon.computer_id === fields.computer_id && daemon.status === "online" && daemon.connected
      && daemon.runtimes.some((runtime) => runtime.runtime === fields.runtime_id)), "Zero-artifact node did not publish its runtime", 30_000);
    const created = await request(`/api/v1/computers/${fields.computer_id}/instances`, { runtime: fields.runtime_id,
      workspace_root: workspaceRoot, display_name: fields.instance_name, capabilities: ["code.modify"] });
    fields.instance_id = created.agent_instance.id;
    observer = createZeroArtifactWorkspaceObserver({ setup, request, computerId: fields.computer_id,
      instanceId: fields.instance_id, until });
    return { ...observer, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Zero-artifact initialization and cleanup failed"); }
    throw error;
  }
}

/** Re-read the exact four immutable test copies after deliberate fixture cleanup. */
export function verifyZeroArtifactWorkspaceExport({ manifest, manifestPath, workspaceRoot, temporary, afterCleanup = false }) {
  assert.ok(isAbsolute(manifestPath) && isAbsolute(workspaceRoot) && isAbsolute(temporary));
  const target = dirname(manifestPath), outside = relative(temporary, target);
  assert.ok(outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside));
  assert.ok(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink());
  assert.ok(lstatSync(manifestPath).isFile() && !lstatSync(manifestPath).isSymbolicLink());
  assert.equal(manifestPath, join(target, "manifest.json"));
  if (afterCleanup) assert.equal(existsSync(temporary), false, "The owned temporary fixture must be removed before final copy verification");
  const manifestBytes = readFileSync(manifestPath);
  assert.deepEqual(JSON.parse(manifestBytes), manifest, "The original export manifest must remain unchanged");
  const names = [...ZERO_ARTIFACT_FILES, "context_pack.md"].sort();
  assert.equal(manifest.files.length, names.length);
  assert.deepEqual(readdirSync(target).sort(), [...names, "manifest.json"].sort());
  const seen = new Set(); let bytes = 0;
  for (const file of manifest.files) {
    const name = relative(target, file.copied); assert.ok(names.includes(name));
    assert.equal(seen.has(name), false); seen.add(name);
    assert.equal(file.copied, join(target, name)); assert.equal(file.source, join(workspaceRoot, name));
    assert.ok(lstatSync(file.copied).isFile() && !lstatSync(file.copied).isSymbolicLink());
    assert.deepEqual(fileRecord(file.copied), { sha256: file.sha256, size: file.size }); bytes += file.size;
  }
  return { passed: true, scope: "Four byte-verified disposable-fixture copies; zero uploaded product artifacts",
    files: names.length, bytes, manifest_path: manifestPath, manifest_sha256: hash(manifestBytes),
    verified_after_fixture_cleanup: afterCleanup };
}

export function verifyZeroArtifactWorkspace({ fields, configuration, baseHead, baseIndex, baseRepo, baseCommonDirectory, observation: value }) {
  const snapshot = value.snapshot;
  assert.equal(snapshot.task.title, fields.task_title); assert.equal(snapshot.task.project_id, fields.project_id); assert.equal(snapshot.task.status, "review");
  assert.deepEqual(snapshot.task.acceptance_criteria, fields.acceptance_criteria); assert.deepEqual(snapshot.task.required_capabilities, ["code.modify"]);
  assert.equal(snapshot.runs.length, 1); assert.equal(value.run_reads.length, 1); assert.equal(snapshot.reviews.length, 0); assert.equal(snapshot.artifacts.length, 0);
  assert.equal(value.receipts.length, 1); assert.equal(value.launches.length, 1); assert.equal(value.contexts.length, 1); assert.deepEqual(value.live_pids, []);
  const run = snapshot.runs[0], receipt = value.receipts[0], launch = value.launches[0], context = value.contexts[0];
  assert.deepEqual(value.run_reads, snapshot.runs); assert.deepEqual(value.bundle.runs, snapshot.runs); assert.deepEqual(value.bundle.artifacts, []);
  assert.equal(run.status, "completed"); assert.equal(run.task_id, snapshot.task.id); assert.equal(run.computer_id, fields.computer_id);
  assert.equal(run.agent_instance_id, fields.instance_id); assert.equal(run.runtime_id, fields.runtime_id);
  assert.equal(run.workspace_root, fields.workspace_root); assert.equal(run.workspace_branch, `artoo/run-${run.id}`);
  assert.equal(receipt.run_id, run.id); assert.equal(receipt.task_id, run.task_id); assert.equal(receipt.project_id, fields.project_id); assert.equal(receipt.mode, "zero-artifact-success");
  assert.equal(receipt.workspace_root, fields.workspace_root); assert.deepEqual(receipt.artifact_filenames, []);
  assert.equal(launch.pid, receipt.pid); assert.equal(launch.run_id, run.id); assert.equal(launch.task_id, run.task_id); assert.equal(launch.workspace_root, fields.workspace_root);
  assert.equal(context.run_id, run.id); assert.equal(context.sha256, hash(context.source)); assert.equal(context.sha256, receipt.context_sha256);
  assert.equal(context.source.split("\n\n", 1)[0], `# Context Pack ${run.context_pack_id}\ntask: ${run.task_id}\nrun: ${run.id}`);
  assert.equal(context.pack.task.id, run.task_id); assert.equal(context.pack.project.id, fields.project_id); assert.equal(context.pack.workspace.root, run.workspace_root);
  assert.deepEqual(context.pack.policy.filesystem_write_scope, [run.workspace_root]); assert.equal(context.pack.review_feedback, undefined);
  assert.equal(snapshot.approvals.length, 1); const approval = snapshot.approvals[0];
  assert.equal(approval.action, "execution.start"); assert.equal(approval.status, "approved"); assert.equal(approval.run_id, run.id); assert.equal(approval.summary, fields.approval_summary);
  const retained = value.bundle.events.filter((event) => event.type === "run.workspace.retained");
  const completed = value.bundle.events.filter((event) => event.type === "run.completed");
  const started = value.bundle.events.filter((event) => event.type === "run.started");
  assert.equal(retained.length, 1); assert.equal(completed.length, 1); assert.equal(started.length, 1);
  assert.equal(value.bundle.events.filter((event) => ["run.started", "run.completed", "run.failed", "run.cancelled", "run.reconciled"].includes(event.type)).length, 2);
  assert.equal(value.bundle.events.filter((event) => event.type === "artifact.created").length, 0);
  const event = retained[0];
  for (const item of [started[0], event, completed[0]]) {
    assert.equal(item.run_id, run.id); assert.equal(item.task_id, run.task_id); assert.equal(item.organization_id, snapshot.task.organization_id);
    assert.equal(item.project_id, fields.project_id); assert.equal(item.correlation_id, run.task_id);
    assert.ok(typeof item.id === "string" && item.id.length > 0 && Number.isSafeInteger(item.position) && item.position > 0);
    assert.ok(Number.isSafeInteger(item.sequence) && item.sequence >= 0 && Number.isFinite(Date.parse(item.occurred_at)));
  }
  assert.deepEqual(event.actor, { type: "system", id: fields.computer_id });
  assert.deepEqual(event.payload, { version: 1, workspace_root: run.workspace_root, workspace_branch: run.workspace_branch, outcome: "completed", reporter_computer_id: run.computer_id });
  assert.ok(event.position > started[0].position && event.sequence > started[0].sequence && event.position < completed[0].position && event.sequence < completed[0].sequence);
  assert.deepEqual(run.workspace_retention, { ...event.payload, event_id: event.id, position: event.position, sequence: event.sequence, reported_at: new Date(event.occurred_at).toISOString() });
  assert.equal(value.base.head, baseHead); assert.equal(value.base.index_sha256, baseIndex); assert.equal(value.base.status, ""); assert.equal(value.base.baseline_sha256, configuration.baseline_sha256);
  assert.equal(value.base.branch, "fixture-base"); assert.deepEqual(value.base.refs, ["refs/heads/fixture-base", `refs/heads/${run.workspace_branch}`].sort());
  assert.deepEqual(parseGitWorktreeRegistrations(value.base.registrations), [
    { root: gitWorktreePath(baseRepo), head: baseHead, branch: "refs/heads/fixture-base" },
    { root: gitWorktreePath(fields.workspace_root), head: baseHead, branch: `refs/heads/${run.workspace_branch}` },
  ].sort((a, b) => a.root.localeCompare(b.root)));
  assert.equal(value.workspace.root, run.workspace_root); assert.equal(value.workspace.head, baseHead); assert.equal(value.workspace.branch, run.workspace_branch);
  assert.equal(value.workspace.common_directory, baseCommonDirectory); assert.equal(value.workspace.ignored, "ignored.bin"); assert.equal(value.workspace.report_exists, false);
  assert.deepEqual(value.workspace.status.split("\n").filter(Boolean).sort(), [" M implementation.txt", "?? context_pack.md", "?? unuploaded.txt", "!! ignored.bin"].sort());
  assert.deepEqual(Object.keys(receipt.files).sort(), [...ZERO_ARTIFACT_FILES].sort());
  assert.deepEqual(Object.keys(value.workspace.files).sort(), [...ZERO_ARTIFACT_FILES, "context_pack.md"].sort());
  for (const [name, bytes] of Object.entries(zeroArtifactWork(context.pack, run.id, context.sha256))) {
    const expected = { sha256: hash(bytes), size: bytes.length }; assert.deepEqual(receipt.files[name], expected); assert.deepEqual(value.workspace.files[name], expected);
  }
  assert.deepEqual(value.workspace.files["context_pack.md"], { sha256: context.sha256, size: Buffer.byteLength(context.source) });
  return { passed: true, counts: { tasks: 1, runs: 1, launches: 1, approvals: 1, reviews: 0, artifacts: 0, retained_worktrees: 1, live_owned_processes: 0 },
    task_id: run.task_id, run_id: run.id, retention_event_id: event.id, workspace_root: run.workspace_root, workspace_branch: run.workspace_branch };
}
