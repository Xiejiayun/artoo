// node --test apps/artood/test-fixtures/product-release-real.test.mjs (built POSIX worker)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareVerificationProfiles, runVerification, verificationSupported } from "../dist/verification.js";
import { createProductReleaseExecutor, prepareReleaseProfiles } from "../dist/product-release.js";

async function fixture({ proxyHealth = false, monitoring } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "artoo-release-real-")));
  const workspace = join(root, "workspace"), storage = join(root, "storage");
  mkdirSync(workspace); mkdirSync(storage); mkdirSync(join(workspace, "web"));
  writeFileSync(join(workspace, "web/index.html"), "<h1>Healthy v1</h1>");
  const script = join(root, "accept.mjs");
  writeFileSync(script, "import{readFileSync}from'node:fs';if(!readFileSync('web/index.html','utf8').startsWith('<h1>'))process.exit(7);");
  const rawVerifier = { id: "verify", project_id: "project", workspace_root: workspace,
    commands: [{ id: "html", argv: [process.execPath, script], timeout_ms: 5000 }], subject_paths: ["web"], required_files: ["web/index.html"] };
  const [verifier] = prepareVerificationProfiles([rawVerifier]);
  const listener = createServer(); await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  let endpoint = `http://127.0.0.1:${port}`, proxy, pauseCountdown = 0, notifyPaused, resumePaused;
  const observedBodies = [], children = new Set(), failedReleases = new Set(), reports = [], errors = [];
  let reportDeliveryFails = false;
  if (proxyHealth) {
    proxy = createHttpServer(async (request, response) => {
      try {
        const upstream = await fetch(`http://127.0.0.1:${port}${request.url}`);
        const bytes = Buffer.from(await upstream.arrayBuffer()); observedBodies.push(bytes.toString("utf8"));
        const status = failedReleases.has(upstream.headers.get("x-artoo-release-id")) ? 503 : upstream.status;
        const respond = () => { if (!response.destroyed) {
          response.writeHead(status, Object.fromEntries(upstream.headers)); response.end(bytes);
        } };
        if (pauseCountdown > 0 && --pauseCountdown === 0) {
          resumePaused = respond; notifyPaused?.(bytes.toString("utf8")); return;
        }
        respond();
      } catch { response.writeHead(502).end(); }
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${proxy.address().port}`;
  }
  const rawProfile = { id: "site", project_id: "project", verification_profile_id: "verify", storage_root: storage,
    output_path: "web", public_url: endpoint, listen_host: "127.0.0.1", listen_port: port,
    health_checks: [{ path: "/", expect_text: "Healthy" }], health_timeout_ms: proxyHealth ? 10000 : 2000,
    ...(monitoring ? { monitoring } : {}) };
  const [profile] = prepareReleaseProfiles([rawProfile], [verifier]);
  const executorOptions = { onHealthReport(report) {
    reports.push(report); if (reportDeliveryFails) throw new Error("fixture control server unavailable");
  }, onError(error) { errors.push(error); } };
  let executor = createProductReleaseExecutor([profile], executorOptions);
  async function verifiedRequest(runId) {
    const evidence = await runVerification(verifier, `verification-${runId}`, new AbortController().signal);
    assert.equal(evidence.outcome, "passed", evidence.reason); assert.equal(evidence.checks[0].exit_code, 0);
    executor.recordVerification(runId, "project", workspace, evidence);
    return { version: 1, release_id: `release-${runId}`, goal_id: "goal", project_id: "project", run_id: runId,
      release_profile_id: "site", verification_request_id: evidence.request_id, verification_profile_id: "verify",
      verification_profile_digest: evidence.profile_digest, subject_digest: evidence.subject_digest };
  }
  const operationPath = (request) => join(storage, "operations", `${createHash("sha256").update(request.release_id).digest("hex")}.json`);
  return { workspace, storage, profile, verifiedRequest, observedBodies, reports, errors, get executor() { return executor; },
    failHealth(releaseId) { failedReleases.add(releaseId); },
    restoreHealth(releaseId) { failedReleases.delete(releaseId); },
    failReportDelivery(value) { reportDeliveryFails = value; },
    monitorState(request) { return JSON.parse(readFileSync(join(storage, "health", `${createHash("sha256").update(request.release_id).digest("hex")}.json`), "utf8")); },
    operation(request) { return JSON.parse(readFileSync(operationPath(request), "utf8")); },
    hasOperation(request) { return existsSync(operationPath(request)); },
    seedOperation(operation) { writeFileSync(operationPath(operation.request), JSON.stringify(operation)); },
    isCancelled(request) { return existsSync(`${operationPath(request)}.cancelled`); },
    pauseNextHealth(count = 1) { pauseCountdown = count; return new Promise((resolve) => { notifyPaused = resolve; }); },
    resumePausedHealth() { resumePaused?.(); resumePaused = undefined; },
    async launchReleaseChild(request, { killAfterMonitoringPhase, killAfterPublicationPhase } = {}) {
      await executor.stop();
      const config = join(root, "release-child.json"); writeFileSync(config, JSON.stringify({ rawVerifier, rawProfile, request, killAfterMonitoringPhase, killAfterPublicationPhase }));
      const child = spawn(process.execPath, [fileURLToPath(new URL("./product-release-worker.mjs", import.meta.url)), config], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (data) => { output = (output + data).slice(-16000); });
      child.stderr.on("data", (data) => { output = (output + data).slice(-16000); });
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const worker = { async kill() {
        child.kill("SIGKILL"); const result = await exited; children.delete(worker);
        assert.equal(result.signal, "SIGKILL", output);
      }, async waitForKill() {
        const result = await exited; children.delete(worker); assert.equal(result.signal, "SIGKILL", output);
      }, async waitUntilPaused(paused) {
        return Promise.race([paused, exited.then((result) => { throw new Error(`release child exited early: ${JSON.stringify(result)} ${output}`); })]);
      } };
      children.add(worker); return worker;
    },
    async restart() { await executor.stop(); executor = createProductReleaseExecutor([profile], executorOptions); await executor.start(); },
    async close() {
      for (const child of children) await child.kill();
      await executor.stop();
      if (proxy) await new Promise((resolve) => { proxy.close(resolve); proxy.closeAllConnections(); });
      const makeWritable = (path) => { chmodSync(path, 0o700); for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name); if (entry.isDirectory()) makeWritable(child); else chmodSync(child, 0o600);
      } };
      assert.equal(realpathSync(root), root); assert.ok(root.startsWith(join(realpathSync(tmpdir()), "artoo-release-real-")));
      makeWritable(root); rmSync(root, { recursive: true, force: true });
    },
  };
}

test("real verification, immutable snapshot, HTTP publication, health rollback and durable replay", { skip: !verificationSupported() }, async () => {
  const f = await fixture();
  try {
    const first = await f.verifiedRequest("first");
    const receipt = await f.executor.release(first);
    assert.equal(receipt.outcome, "published", receipt.reason);
    assert.equal(receipt.artifact_digest, first.subject_digest);
    assert.equal(receipt.health_checks[0].passed, true);
    assert.match(await (await fetch(receipt.endpoint)).text(), /Healthy v1/);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Broken v2</h1>");
    const second = await f.verifiedRequest("second");
    const rejected = await f.executor.release(second);
    assert.equal(rejected.outcome, "rolled_back"); assert.equal(rejected.previous_release_id, first.release_id);
    assert.match(await (await fetch(receipt.endpoint)).text(), /Healthy v1/);
    await f.restart();
    assert.deepEqual(await f.executor.release(first), receipt);
    assert.deepEqual(await f.executor.release(second), rejected);
    await assert.rejects(f.executor.release({ ...first, goal_id: "different" }), /different immutable request/);
  } finally { await f.close(); }
});

test("source mutation and absent node attestation cannot activate a product", { skip: !verificationSupported() }, async () => {
  const f = await fixture();
  try {
    const request = await f.verifiedRequest("changed"); writeFileSync(join(f.workspace, "web/index.html"), "<h1>changed</h1>");
    const receipt = await f.executor.release(request);
    assert.equal(receipt.outcome, "failed"); assert.match(receipt.reason, /changed since verified/);
    const forged = await f.executor.release({ ...request, release_id: "forged", run_id: "absent" });
    assert.equal(forged.outcome, "failed"); assert.match(forged.reason, /no matching local/);
    await f.restart();
    assert.deepEqual(await f.executor.release(request), receipt, "ordinary terminal failures must not block worker startup");
    assert.equal((await fetch(f.profile.public_url)).status, 503);
  } finally { await f.close(); }
});

test("a durable cancellation tombstone prevents delayed publication after restart", { skip: !verificationSupported() }, async () => {
  const f = await fixture();
  try {
    const request = await f.verifiedRequest("cancel");
    const receipt = await f.executor.cancel(request);
    assert.equal(receipt.outcome, "failed"); assert.match(receipt.reason, /cancelled/);
    await f.restart(); assert.deepEqual(await f.executor.release(request), receipt);
    assert.equal((await fetch(f.profile.public_url)).status, 503);
  } finally { await f.close(); }
});

test("cancelling an active HTTP health request rolls back before stop is confirmed", { skip: !verificationSupported() }, async () => {
  const f = await fixture({ proxyHealth: true });
  try {
    const first = await f.verifiedRequest("first"); assert.equal((await f.executor.release(first)).outcome, "published");
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Healthy v2</h1>");
    const next = await f.verifiedRequest("cancel-active"), paused = f.pauseNextHealth();
    const pending = f.executor.release(next); await paused;
    const cancelled = await f.executor.cancel(next);
    assert.equal(cancelled.outcome, "rolled_back"); assert.equal(cancelled.previous_release_id, first.release_id);
    assert.equal(cancelled.recovery_checks[0].passed, true);
    assert.deepEqual(await pending, cancelled);
    assert.match(await (await fetch(f.profile.public_url)).text(), /Healthy v1/);
  } finally { await f.close(); }
});

test("mismatched cancellation cannot abort or tombstone an active immutable request", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true });
  try {
    const request = await f.verifiedRequest("valid"), paused = f.pauseNextHealth();
    const pending = f.executor.release(request); assert.match(await paused, /Healthy v1/);
    for (const patch of [{ goal_id: "different" }, { subject_digest: `sha256:${"a".repeat(64)}` }]) {
      await assert.rejects(f.executor.cancel({ ...request, ...patch }), /different immutable request/);
      assert.equal(f.isCancelled(request), false);
    }
    f.resumePausedHealth();
    assert.equal((await pending).outcome, "published");
    await f.restart();
    await assert.rejects(f.executor.cancel({ ...request, goal_id: "different-after-restart" }), /different immutable request/);
    assert.equal(f.isCancelled(request), false);
    assert.match(await (await fetch(f.profile.public_url)).text(), /Healthy v1/);
  } finally { f.resumePausedHealth(); await f.close(); }
});

test("SIGKILL during candidate health recovers before readiness without command replay", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true });
  try {
    const first = await f.verifiedRequest("first"); assert.equal((await f.executor.release(first)).outcome, "published");
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Healthy v2</h1>");
    const candidate = await f.verifiedRequest("crashed-candidate"), paused = f.pauseNextHealth();
    const child = await f.launchReleaseChild(candidate);
    assert.match(await child.waitUntilPaused(paused), /Healthy v2/);
    assert.equal(f.operation(candidate).phase, "activated"); await child.kill();
    // Recovery must use the sealed previous snapshot even when no verification can run against the mutable workspace.
    writeFileSync(join(f.workspace, "web/index.html"), "unverified working copy");
    f.observedBodies.length = 0;
    const recoveryPaused = f.pauseNextHealth(); let ready = false;
    const starting = f.restart().then(() => { ready = true; });
    assert.match(await recoveryPaused, /Healthy v1/);
    assert.equal(ready, false, "start must wait for actual recovery measurements");
    assert.equal(f.operation(candidate).phase, "rolling_back");
    f.resumePausedHealth(); await starting;
    const recovered = f.operation(candidate);
    assert.equal(recovered.phase, "terminal"); assert.equal(recovered.receipt.outcome, "rolled_back");
    assert.equal(recovered.receipt.recovery_checks[0].passed, true);
    assert.match(await (await fetch(f.profile.public_url)).text(), /Healthy v1/);
    assert.ok(f.observedBodies.every((body) => body.includes("Healthy v1")), "startup must never expose the unconfirmed candidate");
    assert.deepEqual(await f.executor.release(candidate), recovered.receipt);
  } finally { f.resumePausedHealth(); await f.close(); }
});

test("SIGKILL during rollback health preserves failure intent and never reactivates the failed version", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true });
  try {
    const first = await f.verifiedRequest("first"); assert.equal((await f.executor.release(first)).outcome, "published");
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Broken v2</h1>");
    const candidate = await f.verifiedRequest("crashed-rollback"), paused = f.pauseNextHealth(2);
    const child = await f.launchReleaseChild(candidate);
    assert.match(await child.waitUntilPaused(paused), /Healthy v1/);
    const interrupted = f.operation(candidate);
    assert.equal(interrupted.phase, "rolling_back");
    assert.equal(interrupted.rollback_receipt.health_checks[0].passed, false);
    assert.match(interrupted.rollback_receipt.reason, /failed configured health/);
    await child.kill(); f.observedBodies.length = 0;
    await f.restart();
    const recovered = f.operation(candidate);
    assert.equal(recovered.phase, "terminal"); assert.equal(recovered.receipt.outcome, "rolled_back");
    assert.deepEqual(recovered.receipt.health_checks, interrupted.rollback_receipt.health_checks);
    assert.match(recovered.receipt.reason, /failed configured health/);
    assert.match(await (await fetch(f.profile.public_url)).text(), /Healthy v1/);
    assert.ok(f.observedBodies.every((body) => body.includes("Healthy v1")), "known failed candidate must never be activated again");
    assert.deepEqual(await f.executor.release(candidate), recovered.receipt);
  } finally { f.resumePausedHealth(); await f.close(); }
});

test("SIGKILL during the first publication restores no active version and serves 503", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true });
  try {
    const request = await f.verifiedRequest("first-crash"), paused = f.pauseNextHealth();
    const child = await f.launchReleaseChild(request);
    assert.match(await child.waitUntilPaused(paused), /Healthy v1/); await child.kill();
    f.observedBodies.length = 0;
    await f.restart();
    const operation = f.operation(request);
    assert.equal(operation.phase, "terminal"); assert.equal(operation.receipt.outcome, "rolled_back");
    assert.equal(operation.receipt.previous_release_id, null); assert.deepEqual(operation.receipt.recovery_checks, []);
    assert.equal((await fetch(f.profile.public_url)).status, 503);
    assert.ok(f.observedBodies.every((body) => !body.includes("Healthy")));
    assert.deepEqual(await f.executor.release(request), operation.receipt);
  } finally { f.resumePausedHealth(); await f.close(); }
});

test("startup refuses a pointer whose operation has no successful publication receipt", { skip: !verificationSupported() }, async () => {
  const f = await fixture();
  try {
    const request = await f.verifiedRequest("unhealthy"); writeFileSync(join(f.workspace, "web/index.html"), "<h1>changed</h1>");
    assert.equal((await f.executor.release(request)).outcome, "failed");
    await f.executor.stop();
    // Simulate inconsistent protected storage: matching IDs/digests alone must never authorize serving.
    writeFileSync(join(f.storage, "current.json"), JSON.stringify({ release_id: request.release_id,
      artifact_digest: request.subject_digest, release_profile_digest: f.profile.digest }));
    await assert.rejects(f.restart(), /not bound to a confirmed published version/);
    await assert.rejects(fetch(f.profile.public_url));
  } finally { await f.close(); }
});

test("incorrect profile routing cannot persist state or prevent later startup", { skip: !verificationSupported() }, async () => {
  const f = await fixture();
  try {
    const request = await f.verifiedRequest("valid");
    for (const patch of [{ project_id: "different" }, { verification_profile_id: "different" },
      { verification_profile_digest: `sha256:${"a".repeat(64)}` }]) {
      const invalid = { ...request, ...patch };
      await assert.rejects(f.executor.release(invalid), /does not match local profile/);
      await assert.rejects(f.executor.cancel(invalid), /does not match local profile/);
      assert.equal(f.hasOperation(invalid), false); assert.equal(f.isCancelled(invalid), false);
    }
    // Compatible with old workers that wrote a terminal failed receipt for an incorrect project.
    const oldRequest = { ...request, release_id: "old-invalid-request", project_id: "different" };
    f.seedOperation({ request: oldRequest, previous: null, phase: "terminal", receipt: {
      request: oldRequest, release_profile_digest: f.profile.digest, artifact_digest: null, outcome: "failed",
      endpoint: null, previous_release_id: null, health_checks: [], reason: "release request does not match local profile",
    } });
    await f.restart();
    assert.equal((await f.executor.release(request)).outcome, "published");
    assert.match(await (await fetch(f.profile.public_url)).text(), /Healthy v1/);
  } finally { await f.close(); }
});

const manualMonitoring = { interval_ms: 3600000, failure_threshold: 2 };

test("continuous observations reset transient failures and retain the failure count across restart", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: manualMonitoring });
  try {
    const request = await f.verifiedRequest("monitored"), receipt = await f.executor.release(request);
    await f.executor.checkHealth();
    assert.equal(f.reports.at(-1).state, "healthy");
    f.failHealth(request.release_id); await f.executor.checkHealth();
    assert.equal(f.reports.at(-1).state, "degraded"); assert.equal(f.reports.at(-1).consecutive_failures, 1);
    f.restoreHealth(request.release_id); await f.executor.checkHealth();
    assert.equal(f.reports.at(-1).state, "healthy"); assert.equal(f.reports.at(-1).consecutive_failures, 0);
    f.failHealth(request.release_id); await f.executor.checkHealth();
    const before = f.reports.at(-1); assert.equal(before.consecutive_failures, 1);
    await f.restart();
    const after = f.reports.at(-1);
    assert.equal(after.state, "unavailable"); assert.equal(after.consecutive_failures, 2);
    assert.ok(after.sequence > before.sequence); assert.equal(after.active_release_id, null);
    assert.equal((await fetch(f.profile.public_url)).status, 503);
    assert.deepEqual(await f.executor.release(request), receipt, "later health does not rewrite the immutable publication receipt");
    assert.deepEqual(f.executor.getPublicationReceipts(), [receipt]);
    assert.deepEqual(f.executor.getHealthReports(), [after]); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("continuous failure restores and measures the previous immutable version", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: { ...manualMonitoring, failure_threshold: 1 } });
  try {
    const first = await f.verifiedRequest("monitor-first"); await f.executor.release(first);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Healthy v2</h1>");
    const next = await f.verifiedRequest("monitor-next"), receipt = await f.executor.release(next);
    f.failHealth(next.release_id); await f.executor.checkHealth();
    const report = f.reports.at(-1);
    assert.equal(report.state, "rolled_back"); assert.equal(report.active_release_id, first.release_id);
    assert.equal(report.active_artifact_digest, first.subject_digest);
    assert.equal(report.health_checks[0].passed, false); assert.equal(report.recovery_checks[0].passed, true);
    assert.match(await (await fetch(f.profile.public_url)).text(), /Healthy v1/);
    assert.deepEqual(await f.executor.release(next), receipt);
    await f.restart();
    assert.match(await (await fetch(f.profile.public_url)).text(), /Healthy v1/);
    assert.equal(f.executor.getHealthReports().find((item) => item.request.release_id === next.release_id).state, "rolled_back");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("unhealthy recovery disables the listener's active version instead of claiming rollback success", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: { ...manualMonitoring, failure_threshold: 1 } });
  try {
    const first = await f.verifiedRequest("unhealthy-first"); await f.executor.release(first);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Healthy v2</h1>");
    const next = await f.verifiedRequest("unhealthy-next"); await f.executor.release(next);
    f.failHealth(first.release_id); f.failHealth(next.release_id); await f.executor.checkHealth();
    const report = f.reports.at(-1);
    assert.equal(report.state, "unavailable"); assert.equal(report.active_release_id, null);
    assert.equal(report.recovery_checks[0].passed, false); assert.match(report.reason, /could not be recovered/);
    assert.equal((await fetch(f.profile.public_url)).status, 503);
    await f.restart(); assert.equal((await fetch(f.profile.public_url)).status, 503);
    assert.deepEqual(f.executor.getHealthReports(), [report]);
  } finally { await f.close(); }
});

test("periodic monitoring actually runs without another server command", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: { interval_ms: 1000, failure_threshold: 1 } });
  try {
    const request = await f.verifiedRequest("timer"); await f.executor.release(request); f.failHealth(request.release_id);
    const deadline = Date.now() + 15000;
    while (!f.reports.some((report) => report.state === "unavailable") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(f.reports.some((report) => report.state === "unavailable"), "the configured timer must measure and recover without a check command");
    assert.equal((await fetch(f.profile.public_url)).status, 503); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("monitor recovery is serialized with the next publication and cannot overwrite its pointer", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: { ...manualMonitoring, failure_threshold: 1 } });
  try {
    const first = await f.verifiedRequest("queue-first"); await f.executor.release(first);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Healthy v2</h1>");
    const second = await f.verifiedRequest("queue-second"); await f.executor.release(second);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Healthy v3</h1>");
    const third = await f.verifiedRequest("queue-third"), paused = f.pauseNextHealth();
    f.failHealth(second.release_id);
    const observation = f.executor.checkHealth(); assert.match(await paused, /Healthy v2/);
    const publication = f.executor.release(third);
    assert.equal(f.hasOperation(third), false, "the next release must wait for monitoring's durable recovery");
    f.resumePausedHealth(); await observation;
    assert.equal((await publication).outcome, "published");
    assert.equal(f.reports.at(-1).state, "rolled_back");
    const response = await fetch(f.profile.public_url); assert.equal(response.headers.get("x-artoo-release-id"), third.release_id);
    assert.match(await response.text(), /Healthy v3/); assert.deepEqual(f.errors, []);
  } finally { f.resumePausedHealth(); await f.close(); }
});

test("stopping an in-flight observation does not fabricate a product failure", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: manualMonitoring });
  try {
    const request = await f.verifiedRequest("stop-monitor"); await f.executor.release(request); await f.executor.checkHealth();
    const before = f.executor.getHealthReports(), paused = f.pauseNextHealth();
    const observation = f.executor.checkHealth(); await paused; f.executor.requestStop();
    await observation; assert.deepEqual(f.executor.getHealthReports(), before);
    f.resumePausedHealth(); await f.restart();
    assert.equal(f.executor.getHealthReports()[0].state, "healthy"); assert.deepEqual(f.errors, []);
  } finally { f.resumePausedHealth(); await f.close(); }
});

test("SIGKILL during post-publication recovery resumes the prior version before readiness", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: { ...manualMonitoring, failure_threshold: 1 } });
  try {
    const first = await f.verifiedRequest("monitor-crash-first"); await f.executor.release(first);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Healthy v2</h1>");
    const second = await f.verifiedRequest("monitor-crash-second"); await f.executor.release(second);
    f.failHealth(second.release_id); const paused = f.pauseNextHealth(2);
    const child = await f.launchReleaseChild(undefined);
    assert.match(await child.waitUntilPaused(paused), /Healthy v1/);
    assert.equal(f.monitorState(second).phase, "recovering"); await child.kill();
    f.observedBodies.length = 0;
    const recoveryPaused = f.pauseNextHealth(); let ready = false;
    const starting = f.restart().then(() => { ready = true; });
    assert.match(await recoveryPaused, /Healthy v1/); assert.equal(ready, false);
    f.resumePausedHealth(); await starting;
    assert.equal(f.monitorState(second).phase, "terminal"); assert.equal(f.monitorState(second).report.state, "rolled_back");
    assert.ok(f.observedBodies.every((body) => body.includes("Healthy v1")));
    assert.deepEqual(f.errors, []);
  } finally { f.resumePausedHealth(); await f.close(); }
});

test("SIGKILL after rejecting post-publication recovery never reactivates either rejected version", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: { ...manualMonitoring, failure_threshold: 1 } });
  try {
    const first = await f.verifiedRequest("monitor-disable-first"); await f.executor.release(first);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Healthy v2</h1>");
    const second = await f.verifiedRequest("monitor-disable-second"); await f.executor.release(second);
    f.failHealth(first.release_id); f.failHealth(second.release_id);
    const child = await f.launchReleaseChild(undefined, { killAfterMonitoringPhase: "disabling" }); await child.waitForKill();
    const interrupted = f.monitorState(second); assert.equal(interrupted.phase, "disabling");
    assert.equal(interrupted.recovery.checks[0].passed, false);
    f.observedBodies.length = 0; await f.restart();
    assert.equal((await fetch(f.profile.public_url)).status, 503);
    assert.ok(f.observedBodies.every((body) => !body.includes("Healthy")));
    const report = f.monitorState(second).report; assert.equal(report.state, "unavailable");
    assert.deepEqual(report.recovery_checks, interrupted.recovery.checks); assert.equal(report.active_release_id, null);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("failed control-server delivery cannot prevent local recovery or erase replayable evidence", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: { ...manualMonitoring, failure_threshold: 1 } });
  try {
    const first = await f.verifiedRequest("offline-first"); await f.executor.release(first);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Healthy v2</h1>");
    const second = await f.verifiedRequest("offline-second"), receipt = await f.executor.release(second);
    f.failReportDelivery(true); f.failHealth(second.release_id); await f.executor.checkHealth();
    assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /control server unavailable/);
    const report = f.executor.getHealthReports()[0]; assert.equal(report.state, "rolled_back");
    assert.match(await (await fetch(f.profile.public_url)).text(), /Healthy v1/);
    f.failReportDelivery(false); await f.restart();
    assert.deepEqual(f.executor.getHealthReports().find((item) => item.request.release_id === second.release_id), report);
    assert.deepEqual(f.executor.getPublicationReceipts().find((item) => item.request.release_id === second.release_id), receipt);
  } finally { await f.close(); }
});

test("an inconsistent monitoring journal stops serving and cannot authorize startup", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true, monitoring: manualMonitoring });
  try {
    const request = await f.verifiedRequest("bad-journal"); await f.executor.release(request); await f.executor.checkHealth();
    const record = f.monitorState(request); record.report.request.goal_id = "different-goal";
    const path = join(f.storage, "health", `${createHash("sha256").update(request.release_id).digest("hex")}.json`);
    writeFileSync(path, JSON.stringify(record));
    await assert.rejects(f.executor.checkHealth(), /invalid monitoring journal identity/);
    assert.match(f.executor.getHealthFaults()[0].reason, /Release profile site: monitoring halted/);
    await assert.rejects(fetch(`http://${f.profile.listen_host}:${f.profile.listen_port}`));
    await assert.rejects(f.restart(), /invalid monitoring journal identity/);
    await assert.rejects(fetch(`http://${f.profile.listen_host}:${f.profile.listen_port}`));
  } finally { await f.close(); }
});

test("failed publication recovery disables an unhealthy previous version even without monitoring", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true });
  try {
    const first = await f.verifiedRequest("recovery-disable-first"); await f.executor.release(first);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Broken v2</h1>");
    const next = await f.verifiedRequest("recovery-disable-next"); f.failHealth(first.release_id);
    const receipt = await f.executor.release(next);
    assert.equal(receipt.outcome, "failed"); assert.equal(receipt.recovery_checks[0].passed, false);
    assert.match(receipt.reason, /publication disabled/);
    assert.equal((await fetch(f.profile.public_url)).status, 503);
    f.observedBodies.length = 0; await f.restart();
    assert.equal((await fetch(f.profile.public_url)).status, 503);
    assert.ok(f.observedBodies.every((body) => !body.includes("Healthy")));
    assert.deepEqual(await f.executor.release(next), receipt);
  } finally { await f.close(); }
});

test("SIGKILL after failed publication recovery cannot reactivate the rejected previous version", { skip: !verificationSupported(), timeout: 90000 }, async () => {
  const f = await fixture({ proxyHealth: true });
  try {
    const first = await f.verifiedRequest("release-disable-crash-first"); await f.executor.release(first);
    writeFileSync(join(f.workspace, "web/index.html"), "<h1>Broken v2</h1>");
    const next = await f.verifiedRequest("release-disable-crash-next"); f.failHealth(first.release_id);
    const child = await f.launchReleaseChild(next, { killAfterPublicationPhase: "disabling" }); await child.waitForKill();
    const interrupted = f.operation(next); assert.equal(interrupted.phase, "disabling");
    assert.equal(interrupted.rollback_receipt.recovery_checks[0].passed, false);
    f.observedBodies.length = 0; await f.restart();
    assert.equal((await fetch(f.profile.public_url)).status, 503);
    assert.ok(f.observedBodies.every((body) => !body.includes("Healthy")));
    const receipt = f.operation(next).receipt; assert.equal(receipt.outcome, "failed");
    assert.deepEqual(receipt.recovery_checks, interrupted.rollback_receipt.recovery_checks);
    assert.deepEqual(await f.executor.release(next), receipt);
  } finally { await f.close(); }
});
