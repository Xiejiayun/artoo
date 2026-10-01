import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { correctionHash, correctionModes, correctionContextPath, correctionReportPath } from "./execution-correction.mjs";
import { verifyCorrectionResults, verifyCorrectionCheckpoint } from "./execution-correction-results.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15_000 }).trim();
const fileHash = (path) => existsSync(path) ? correctionHash(readFileSync(path)) : null;
export const correctionProcessAlive = (pid) => {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
};

/** Only disposable, task-owned Git infrastructure and fixture instructions are
 * created here. Tasks, approvals, reviews, assignment and cancellation belong
 * exclusively to the real client driver. Feedback text never enters CLI config. */
export function createCorrectionWorkspaces({ temporary, projectId, platform, suffix = randomUUID().slice(0, 8) }) {
  assert.ok(["macos", "ios"].includes(platform));
  const directory = join(realpathSync(temporary), "execution-correction");
  mkdirSync(directory); const baseRepo = join(directory, "base"); mkdirSync(baseRepo);
  const receiptsDirectory = join(directory, "receipts"); mkdirSync(receiptsDirectory, { mode: 0o700 });
  const workspaceRoots = correctionModes.map((mode) => join(directory, `work-${mode}`));
  const baseline = "Original implementation before human review.\n";
  writeFileSync(join(baseRepo, "implementation.txt"), baseline);
  git(baseRepo, "init", "--initial-branch=fixture-base");
  const hooks = join(directory, "empty-hooks"); mkdirSync(hooks);
  git(baseRepo, "config", "core.hooksPath", hooks);
  git(baseRepo, "config", "core.autocrlf", "false");
  git(baseRepo, "add", "implementation.txt");
  git(baseRepo, "-c", "user.name=Artoo E2E", "-c", "user.email=e2e@artoo.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Disposable execution correction base");
  const fields = {
    project_id: projectId, task_title: `${platform === "ios" ? "Native" : "Mac"} execution correction ${suffix}`,
    criterion_1: "Retain failed work and use the exact persisted review feedback on a new attempt",
    criterion_2: "Keep original reports available and stop only the explicitly confirmed execution",
    review_comment_1: `First review ${suffix}: preserve the original report.\nCorrect the implementation using this exact feedback — including 中文 and punctuation.`,
    review_comment_2: `Second review ${suffix}: retain both report versions.\nLeave recoverable work while the next execution waits for my Stop decision.`,
    approval_summaries: correctionModes.map((mode, index) => `Approve correction attempt ${index + 1} (${mode}) ${suffix}`),
    instance_names: correctionModes.map((mode, index) => `Correction ${index + 1} ${mode} ${suffix}`),
    artifact_filename: "changes.patch", base_repository: baseRepo, workspace_parent: directory,
    workspace_roots: workspaceRoots,
    ...(platform === "ios" ? { native_device_name: `Native correction iPhone ${suffix}` } : {}),
  };
  const configuration = {
    project_id: projectId, task_title: fields.task_title, acceptance_criteria: [fields.criterion_1, fields.criterion_2],
    receipts_directory: receiptsDirectory, workspaces: workspaceRoots.map((root, index) => ({ root, mode: correctionModes[index] })),
    artifact_filename: fields.artifact_filename, baseline_sha256: correctionHash(baseline), hold_timeout_ms: 600_000,
  };
  const configurationPath = join(directory, "process.json");
  writeFileSync(configurationPath, JSON.stringify(configuration), { mode: 0o600, flag: "wx" });
  return { fields, configuration, configurationPath, baseRepo, workspaceRoots, receiptsDirectory,
    baseHead: git(baseRepo, "rev-parse", "HEAD"), directory };
}

/** Passive observation, without replacing/pausing the production dispatcher or
 * touching request bodies. Authentication uses the same request's credential
 * through the production session endpoint; credentials are never retained. */
export function observeCorrectionCancellation(server, origin, onFinished = () => ({})) {
  const url = new URL(origin), address = server.address();
  assert.ok(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    && address && Number(url.port) === address.port);
  const attempts = [], pending = new Set(), errors = [];
  function observer(req, res) {
    const match = /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/cancel$/.exec(req.url?.split("?")[0] ?? "");
    if (req.method !== "POST" || !match) return;
    const entry = { run_id: match[1], method: "POST", path: req.url.split("?")[0],
      observed_at: new Date().toISOString(), observed_ms: performance.now(), status: null,
      response_finished: false, user_id: null, device_id: null };
    attempts.push(entry);
    res.once("finish", () => {
      entry.status = res.statusCode; entry.response_finished = true;
      try { Object.assign(entry, onFinished(entry.run_id)); }
      catch { errors.push("Cancellation response process observation failed"); }
    });
    const headers = {};
    for (const key of ["authorization", "cookie"]) if (typeof req.headers[key] === "string") headers[key] = req.headers[key];
    const operation = (async () => {
      const response = await fetch(new URL("/auth/session", origin), { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200); const session = await response.json();
      assert.ok(session.user?.id && session.device_id);
      entry.user_id = session.user.id; entry.device_id = session.device_id;
    })().catch(() => { errors.push("Could not independently authenticate cancellation request"); });
    pending.add(operation); void operation.finally(() => pending.delete(operation));
  }
  server.prependListener("request", observer);
  return {
    async read() { await Promise.all([...pending]); return { attempts: structuredClone(attempts), errors: [...errors] }; },
    async close() { server.removeListener("request", observer); await Promise.all([...pending]); },
  };
}

/** Shared production reads + raw filesystem evidence. request receives full
 * /api/v1 paths. Its only permitted write here is disposable instance setup.
 * readArtifact must fetch the supplied same-origin artifact with authentication. */
export async function createCorrectionObserver({ root, setup, server, origin, request, readArtifact,
  userId, computerId, runtimeId, recipientDeviceId }) {
  let closed = false;
  const { fileLeases } = await import(pathToFileURL(join(root, "packages/db/dist/index.js")).href);
  const cancellation = observeCorrectionCancellation(server.app.server, origin, (runId) => {
    const names = readdirSync(setup.receiptsDirectory).filter((name) => name.startsWith("run-") && name.endsWith(".json"));
    const receipt = names.map((name) => JSON.parse(readFileSync(join(setup.receiptsDirectory, name), "utf8")))
      .find((item) => item.run_id === runId);
    return { process_alive_on_response: receipt ? correctionProcessAlive(receipt.pid) : null,
      exit_receipt_on_response: existsSync(join(setup.receiptsDirectory, `exit-${correctionHash(runId)}.json`)) };
  }), checkpoints = [];
  const fields = { ...setup.fields, user_id: userId, computer_id: computerId, runtime_id: runtimeId,
    recipient_device_id: recipientDeviceId ?? null, instances: [] };
  const registerInstances = async () => {
    assert.equal(fields.instances.length, 0, "Instance fixture can only be provisioned once");
    for (let index = 0; index < 4; index++) {
      const created = await request(`/api/v1/computers/${computerId}/instances`, { runtime: runtimeId,
        workspace_root: setup.workspaceRoots[index], display_name: fields.instance_names[index], capabilities: ["code.modify"] });
      assert.equal(created.agent_instance.computer_id, computerId);
      fields.instances.push({ id: created.agent_instance.id, name: fields.instance_names[index], root: setup.workspaceRoots[index] });
    }
    return fields.instances;
  };
  const observe = async () => {
    assert.ok(!closed, "Correction observer is closed");
    const start = performance.now();
    const matches = (await request(`/api/v1/tasks?project_id=${encodeURIComponent(fields.project_id)}`)).tasks
      .filter((task) => task.title === fields.task_title);
    assert.ok(matches.length <= 1, "Client must create exactly one correction task");
    const snapshot = matches.length ? await request(`/api/v1/tasks/${matches[0].id}`) : null;
    const bundle = snapshot ? (await request(`/api/v1/tasks/${snapshot.task.id}/audit-bundle`)).bundle : null;
    const filenames = readdirSync(setup.receiptsDirectory);
    const readJSON = (prefix) => filenames.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .sort().map((name) => JSON.parse(readFileSync(join(setup.receiptsDirectory, name), "utf8")));
    const receipts = readJSON("run-"), launches = readJSON("launch-"), exits = readJSON("exit-");
    const contexts = receipts.map((receipt) => {
      const path = correctionContextPath(setup.receiptsDirectory, receipt.run_id), bytes = readFileSync(path), text = bytes.toString("utf8");
      const marker = "## Raw Payload\n"; assert.ok(text.includes(marker));
      return { run_id: receipt.run_id, sha256: correctionHash(bytes), header: text.split("\n\n", 1)[0],
        pack: JSON.parse(text.slice(text.indexOf(marker) + marker.length)) };
    });
    const workspaces = setup.workspaceRoots.map((root, index) => ({ root, slot: index + 1, exists: existsSync(root),
      branch: existsSync(root) ? git(root, "branch", "--show-current") : null,
      implementation_sha256: fileHash(join(root, "implementation.txt")), unsaved_sha256: fileHash(join(root, "unsaved.txt")),
      report_sha256: fileHash(join(root, fields.artifact_filename)) }));
    const artifactBytes = [];
    for (const artifact of snapshot?.artifacts ?? []) {
      assert.equal(artifact.uri, `/api/v1/artifacts/${artifact.id}/content`);
      const bytes = Buffer.from(await readArtifact(artifact));
      artifactBytes.push({ artifact_id: artifact.id, run_id: artifact.run_id, sha256: correctionHash(bytes), size: bytes.length,
        text: bytes.toString("utf8"), source_report_sha256: fileHash(correctionReportPath(setup.receiptsDirectory, artifact.run_id)) });
    }
    // This query cannot expire/release a lease as the REST list endpoint can.
    const leases = (await server.ctx.db.db.select().from(fileLeases)).filter((row) =>
      row.organizationId === server.ctx.organizationId && row.taskId === snapshot?.task.id)
      .map((row) => ({ id: row.id, run_id: row.runId, status: row.status, path: row.path }));
    const usages = snapshot ? await Promise.all(snapshot.runs.map(async (run) => ({ run_id: run.id,
      usage: (await request(`/api/v1/runs/${run.id}/usage`)).usage }))) : [];
    const devices = (await request("/api/v1/devices")).devices;
    const candidates = fields.recipient_device_id ? devices.filter((device) => device.id === fields.recipient_device_id)
      : devices.filter((device) => device.display_name === fields.native_device_name && device.platform === "ios");
    assert.ok(candidates.length <= 1, "Correction must bind exactly one paired recipient");
    const recipient = candidates[0];
    if (recipient) {
      assert.equal(recipient.enrolled_by_user_id, userId); assert.equal(recipient.revoked_at, null);
      fields.recipient_device_id = recipient.id;
    }
    return { observed_at: new Date().toISOString(), started_ms: start, finished_ms: performance.now(),
      snapshot, bundle, receipts, launches, exits, contexts, workspaces, artifact_bytes: artifactBytes, leases, usages,
      live_pids: receipts.filter((receipt) => correctionProcessAlive(receipt.pid)).map((receipt) => receipt.pid),
      cancellation: await cancellation.read(),
      base: { head: git(setup.baseRepo, "rev-parse", "HEAD"), status: git(setup.baseRepo, "status", "--porcelain"),
        implementation_sha256: fileHash(join(setup.baseRepo, "implementation.txt")) } };
  };
  const checkpoint = async (name) => {
    const observation = await observe();
    verifyCorrectionCheckpoint({ name, observation, fields, previous: checkpoints });
    const saved = { name, observation }; checkpoints.push(saved); return structuredClone(saved);
  };
  const waitForCheckpoint = async (name, timeoutMs = 60_000) => {
    let lastError;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      assert.ok(!closed, "Correction observer was closed while waiting");
      try { return await checkpoint(name); } catch (error) { lastError = error; }
      await new Promise((done) => setTimeout(done, 150));
    }
    throw lastError ?? new Error("Correction checkpoint timed out");
  };
  return { fields, registerInstances, observe, checkpoint, waitForCheckpoint,
    evidence() { return structuredClone(checkpoints); },
    async verify() { return verifyCorrectionResults({ fields, configuration: setup.configuration,
      baseHead: setup.baseHead, checkpoints, final: await observe() }); },
    async close() { closed = true; await cancellation.close(); },
  };
}
