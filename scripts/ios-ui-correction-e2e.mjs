#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createCorrectionFixture } from "./ios-ui-correction-fixture.mjs";
import { exportCorrectionWorkspaceEvidence } from "./fixtures/execution-correction-scenario.mjs";
import { verifyNativeCorrectionWorkspaceEvidence } from "./ios-ui-correction-evidence.mjs";
import { expectedNativeScreenshots, getE2EReportContext, readXCTestScreenshots, writeE2EReport } from "./e2e-report.mjs";
import { nativeUISuiteTimeouts } from "../apps/ios/scripts/ui-suite-contract.mjs";
import { closeOwnedProcessGroup } from "./owned-process-group.mjs";
import { selectNativeFixtureSimulator } from "./ios-ui-simulator.mjs";
import { verifySimulatorClipboardEvidence } from "./ios-ui-clipboard-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/ios-ui-correction-e2e.mjs");
if (process.platform !== "darwin") throw new Error("The native correction suite requires macOS and Xcode");
async function until(read, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await read()) return; await new Promise((done) => setTimeout(done, 150)); }
  throw new Error(message);
}

async function main() {
  const started = new Date().toISOString(), ios = join(root, "artifacts/ios");
  const output = resolve(process.env.ARTOO_IOS_UI_OUTPUT_DIR ?? join(ios, "attempts", `${started.replace(/[:.]/g, "-")}-correction`));
  assert.ok(output.startsWith(`${ios}${sep}`), "Correction evidence must remain inside artifacts/ios");
  mkdirSync(output, { recursive: true });
  const resultPath = join(output, "suite-result.json"), childResultPath = join(output, "xctest-result.json");
  assert.ok(!existsSync(resultPath) && !existsSync(childResultPath), "Each correction attempt must retain new evidence");
  const htmlPath = join(output, `native-correction-${started.replace(/[:.]/g, "-")}.html`);
  const report = { ...getE2EReportContext(), suite: "correction", mode: "native-execution-correction-ui-subset",
    scope: "Native task correction through real pairing, production server, Git worktrees and deterministic CLI processes; no real-provider or physical-device claim",
    started_at: started, checks: [], passed: false,
    diagnostics_scope: "Raw xcresult diagnostics can contain disposable fixture credentials. This HTML admits only named guarded workflow screenshots." };
  const title = "Artoo iOS · execution correction and retained work";
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  writeE2EReport({ outputPath: htmlPath, title, report });
  const temporary = mkdtempSync(join(tmpdir(), "artoo-ios-correction-"));
  let server, fixture, child, childResult;
  const interrupted = new AbortController();
  const stopChild = (signal) => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } } };
  const interrupt = () => { interrupted.abort(new Error("Native correction suite interrupted")); stopChild("SIGTERM"); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const check = (name) => { report.checks.push(name); console.log(`[ios-correction] PASS ${name}`); };
  try {
    const selection = selectNativeFixtureSimulator({ requestedUDID: process.env.ARTOO_IOS_SIMULATOR_UDID });
    const simulatorUDID = selection.device.udid;
    report.fixture_simulator = { udid: simulatorUDID, name: selection.device.name, sdk_version: selection.sdkVersion,
      runtime: selection.runtime.name, selection_mode: selection.mode, newer_than_sdk: selection.newerThanSdk };
    const { startServer } = await import(pathToFileURL(join(root, "apps/server/dist/main.js")).href);
    const { createSession } = await import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href);
    const workspace = join(temporary, "server-workspace"); mkdirSync(workspace);
    server = await startServer({ NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0",
      ARTOO_DATA_DIR: join(temporary, "server-data"), ARTOO_WORKSPACE_ROOT: workspace,
      ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"), ARTOO_WEB_DIST: join(root, "apps/web/dist"),
      GOOGLE_CLIENT_ID: "ios-correction-fixture", GOOGLE_CLIENT_SECRET: "unused-local-fixture", GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback",
      AUTH_ALLOWED_EMAILS: "owner@ios-correction.test", AUTH_OWNER_EMAILS: "owner@ios-correction.test" });
    const address = server.app.server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://localhost:${address.port}`;
    assert.equal((await fetch(`${origin}/api/v1/bootstrap`, { signal: AbortSignal.timeout(15_000) })).status, 401);
    assert.equal(server.persistent, true); assert.equal(server.ctx.deviceAuth.devControlEscape, false);
    assert.equal(server.ctx.deviceAuth.devNodeToken, null);
    const owner = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    const request = async (path, body, token = owner.raw) => {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15_000)]) });
      assert.ok(response.ok, `${body === undefined ? "GET" : "POST"} ${path} failed (${response.status})`);
      return response.json();
    };
    const code = await request("/api/v1/devices/pairings", { intended_platform: "ios" });
    const peer = await request("/api/v1/devices/claim", { code: code.code, platform: "ios",
      display_name: "Independent correction observer", app_version: "correction-fixture" });
    const identity = await request("/auth/session", undefined, peer.control_token); assert.equal(identity.user.id, "user_owner");
    const suffix = randomUUID().slice(0, 8);
    fixture = await createCorrectionFixture({ root, temporary, origin, server, projectId: "proj_artoo",
      userId: identity.user.id, peerToken: peer.control_token, suffix, request, until, simulatorUDID });
    const fields = { ...fixture.fields, server_url: origin, peer_control_token: peer.control_token };
    for (const authorization of [undefined, "Bearer incorrect-correction-token"]) {
      const response = await fetch(`${fields.fixture_control_url}/observations`, {
        headers: authorization ? { Authorization: authorization } : {}, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 401);
    }
    assert.equal((await fixture.scenario.observe()).snapshot, null, "Fixture may not create the tested task");
    check("Production authentication, paired node and four unused Git workspaces are ready; fixture controls reject other credentials");
    const fixturePath = join(temporary, "fixture.json"); writeFileSync(fixturePath, JSON.stringify(fields), { mode: 0o600 });
    await new Promise((done, reject) => {
      interrupted.signal.throwIfAborted();
      child = spawn(process.execPath, [join(root, "apps/ios/scripts/test-macos.mjs"), "--ui", "--suite=correction"], {
        cwd: root, env: { ...process.env, ARTOO_IOS_SIMULATOR_UDID: simulatorUDID, ARTOO_IOS_UI_FIXTURE: fixturePath, ARTOO_IOS_UI_OUTPUT_DIR: output, ARTOO_IOS_UI_RESULT_JSON: childResultPath },
        stdio: "inherit", windowsHide: true, detached: true });
      const limit = nativeUISuiteTimeouts("correction").parent;
      const timeout = setTimeout(() => { stopChild("SIGTERM"); reject(new Error(`Native correction build and UI exceeded ${limit / 60_000} minutes`)); }, limit);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timeout); code === 0 ? done() : reject(new Error(`Native correction UI failed (${code ?? signal})`)); });
    });
    childResult = JSON.parse(readFileSync(childResultPath, "utf8"));
    assert.equal(childResult.suite, "correction"); assert.equal(childResult.passed, true); assert.equal(childResult.contract?.passed, true);
    assert.deepEqual(childResult.source, report.source, "Native correction build/run must retain the original source");
    report.xctest = childResult;
    report.correction = await fixture.scenario.verify();
    assert.equal(report.correction.passed, true);
    assert.deepEqual(report.correction.counts, { runs: 4, launches: 4, approvals: 4, reviews: 2, artifacts: 2,
      retained_worktrees: 4, live_owned_processes: 0 });
    check("Exact correction XCTest passed: four real assignments, two durable reviews, all four retained workspaces and two original artifact versions");
    check("Keep running made zero cancel requests; one confirmed request left the captured PID absent at cancellation HTTP completion");
    check("Independent context, launch, approval, artifact, PID and 3.1-second stability checks passed");
    report.clipboard_probe_integrity = verifySimulatorClipboardEvidence({ receipts: fixture.clipboardEvidence(), simulatorUDID, expectedProbes: 4 });
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : "Native correction verification failed";
    process.exitCode = 1;
  } finally {
    // Retain immutable process/context evidence and last pre-cleanup state even
    // when XCTest fails. This copy contains no pairing/node credentials.
    try {
      if (fixture) {
        const evidence = join(output, "correction-evidence"); mkdirSync(evidence);
        writeFileSync(join(evidence, "checkpoints.json"), JSON.stringify(fixture.scenario.evidence(), null, 2));
        writeFileSync(join(evidence, "observer-errors.json"), JSON.stringify((fixture.errors ?? []).map((error) =>
          ({ name: error.name, message: error.message, stack: error.stack })), null, 2));
        try { writeFileSync(join(evidence, "final-observation.json"), JSON.stringify(await fixture.scenario.observe(), null, 2)); }
        catch { report.observation_error = "Could not obtain a complete final pre-cleanup observation"; }
        report.process_evidence_directory = evidence;
      }
    } catch { report.evidence_retention_failed = true; report.passed = false; process.exitCode = 1; }
    let nativeGroup = { closed: true, not_started: true };
    if (child?.pid) {
      try { nativeGroup = await closeOwnedProcessGroup(child.pid); }
      catch { nativeGroup = { closed: false, error: "Owned native process group cleanup failed" }; }
    }
    report.native_process_group = nativeGroup;
    const fixtureClosed = await Promise.allSettled([fixture?.close()]);
    // Capture the unmodified pre-cleanup state above, then stop owned writers
    // before copying every tracked, untracked, ignored and context/report file.
    // On failures this is explicitly post-writer-cleanup evidence, not a new
    // successful lifecycle observation or an additional user Stop command.
    try {
      if (fixture && report.process_evidence_directory) {
        const evidence = report.process_evidence_directory;
        cpSync(fixture.setup.receiptsDirectory, join(evidence, "process-receipts"), { recursive: true });
        const destination = join(evidence, "retained-workspaces");
        report.retained_workspace_export = exportCorrectionWorkspaceEvidence({ setup: fixture.setup, destination });
        report.workspace_export_timing = "After owned fixture writers close, before disposable directory removal; pre-cleanup lifecycle observation is retained separately";
        if (report.passed) {
          verifyNativeCorrectionWorkspaceEvidence(report.correction, report.retained_workspace_export, destination);
          check("All eighteen workspace files, including four ignored files and both successful implementations, are preserved with exact hashes");
        }
      }
    } catch (error) {
      report.evidence_retention_failed = true; report.passed = false; process.exitCode = 1;
      report.evidence_retention_error = error instanceof Error ? error.message : "Workspace evidence export failed";
    }
    const closed = [...fixtureClosed, ...await Promise.allSettled([server?.close()])];
    const failedClose = closed.some((result) => result.status === "rejected");
    let removalFailed = false;
    try {
      assert.ok(resolve(temporary).startsWith(`${resolve(tmpdir())}${sep}artoo-ios-correction-`));
      rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch { removalFailed = true; }
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    report.cleanup = { resources_closed: !failedClose && nativeGroup.closed,
      temporary_directory_removed: !removalFailed, native_process_group_closed: nativeGroup.closed };
    if (failedClose || removalFailed || !nativeGroup.closed) {
      report.passed = false; report.error ??= "Native correction fixture cleanup failed"; process.exitCode = 1;
    }
    if (fixture) {
      try {
        report.clipboard_observer = { simulator_udid: fixture.fields.simulator_udid,
          scope: "Actual native Copy taps; exact UTF-8 pasteboard bytes observed with simulator infrastructure, not a physical-device paste-consent test",
          receipts: fixture.clipboardEvidence() };
        writeFileSync(join(output, "clipboard-observer.json"), JSON.stringify(report.clipboard_observer, null, 2));
        if (report.passed) report.clipboard_probe_integrity = verifySimulatorClipboardEvidence({
          receipts: report.clipboard_observer.receipts, simulatorUDID: fixture.fields.simulator_udid, expectedProbes: 4 });
      } catch (error) {
        report.passed = false; report.error ??= error instanceof Error ? error.message : "Clipboard evidence retention failed";
        process.exitCode = 1;
      }
    }
    report.finished_at = new Date().toISOString(); report.html_report = htmlPath;
    if (!childResult) { try { childResult = JSON.parse(readFileSync(childResultPath, "utf8")); report.xctest = childResult; } catch {} }
    const images = readXCTestScreenshots(join(output, "ui-attachments")), expected = expectedNativeScreenshots("correction");
    const missing = expected.filter((name) => !images.some(({ caption }) => caption === name || caption.startsWith(`${name}_`) || caption.startsWith(`${name}.`)));
    report.screenshots = { count: images.length, expected, missing };
    report.source_at_finish = getE2EReportContext().source;
    report.source_stable = isDeepStrictEqual(report.source, report.source_at_finish);
    if (!report.source_stable || (report.passed && missing.length)) {
      report.passed = false; report.error ??= !report.source_stable ? "Source changed during native correction verification" : "Required correction screenshots missing";
      process.exitCode = 1;
    }
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
    writeE2EReport({ outputPath: htmlPath, title, report, screenshots: images });
    // Database cleanup can reset Node's exit code; preserve the final failure.
    if (!report.passed) process.exitCode = 1;
    console.log(`[ios-correction] HTML report: ${htmlPath}`);
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Native correction failed"); process.exitCode = 1; });
