#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createRetentionFixture } from "./ios-ui-retention-fixture.mjs";
import { verifyNativeRetentionEvidence } from "./ios-ui-retention-evidence.mjs";
import { ZERO_ARTIFACT_FILES, zeroArtifactHash } from "./fixtures/zero-artifact-workspace.mjs";
import { expectedNativeScreenshots, getE2EReportContext, readXCTestScreenshots, writeE2EReport } from "./e2e-report.mjs";
import { nativeUISuiteTimeouts } from "../apps/ios/scripts/ui-suite-contract.mjs";
import { closeOwnedProcessGroup } from "./owned-process-group.mjs";
import { selectNativeFixtureSimulator } from "./ios-ui-simulator.mjs";
import { verifySimulatorClipboardEvidence } from "./ios-ui-clipboard-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/ios-ui-retention-e2e.mjs");
if (process.platform !== "darwin") throw new Error("The native retention suite requires macOS and Xcode");
async function until(read, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await read()) return; await new Promise((done) => setTimeout(done, 150)); }
  throw new Error(message);
}

async function main() {
  const started = new Date().toISOString(), ios = join(root, "artifacts/ios");
  const output = resolve(process.env.ARTOO_IOS_UI_OUTPUT_DIR ?? join(ios, "attempts", `${started.replace(/[:.]/g, "-")}-retention`));
  assert.ok(output.startsWith(`${ios}${sep}`), "Retention evidence must remain inside artifacts/ios");
  mkdirSync(output, { recursive: true });
  const resultPath = join(output, "suite-result.json"), childResultPath = join(output, "xctest-result.json");
  assert.ok(!existsSync(resultPath) && !existsSync(childResultPath), "Every retention attempt must retain fresh evidence");
  const htmlPath = join(output, `native-retention-${started.replace(/[:.]/g, "-")}.html`);
  const report = { ...getE2EReportContext(), suite: "retention", mode: "native-successful-zero-artifact-retention-ui-subset",
    scope: "Actual native pairing/task/approval/assignment/Copy/cold-relaunch UI with one deterministic real CLI and no uploaded artifact; no provider or physical-device claim",
    started_at: started, checks: [], passed: false,
    diagnostics_scope: "Raw xcresult diagnostics can contain disposable fixture credentials. HTML admits only named guarded workflow captures." };
  const title = "Artoo iOS · successful work without uploaded artifacts";
  writeFileSync(resultPath, JSON.stringify(report, null, 2) + "\n"); writeE2EReport({ outputPath: htmlPath, title, report });
  const temporary = mkdtempSync(join(tmpdir(), "artoo-ios-retention-"));
  let server, fixture, child, childResult, preCleanup;
  const interrupted = new AbortController();
  const stopChild = (signal) => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } } };
  const interrupt = () => { interrupted.abort(new Error("Native retention suite interrupted")); stopChild("SIGTERM"); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const check = (name) => { report.checks.push(name); console.log(`[ios-retention] PASS ${name}`); };
  try {
    const selection = selectNativeFixtureSimulator({ requestedUDID: process.env.ARTOO_IOS_SIMULATOR_UDID });
    const simulatorUDID = selection.device.udid;
    report.fixture_simulator = { udid: simulatorUDID, name: selection.device.name, sdk_version: selection.sdkVersion,
      runtime: selection.runtime.name, selection_mode: selection.mode, newer_than_sdk: selection.newerThanSdk };
    const { startServer } = await import(pathToFileURL(join(root, "apps/server/dist/main.js")).href);
    const { createSession } = await import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href);
    const workspace = join(temporary, "server-workspace"); mkdirSync(workspace);
    server = await startServer({ NODE_ENV: "production", ARTOO_AI_DATA_SHARING_POLICY: JSON.stringify({ mode: "local", providers: [] }), ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0",
      ARTOO_DATA_DIR: join(temporary, "server-data"), ARTOO_WORKSPACE_ROOT: workspace,
      ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"), ARTOO_WEB_DIST: join(root, "apps/web/dist"),
      GOOGLE_CLIENT_ID: "ios-retention-fixture", GOOGLE_CLIENT_SECRET: "unused-local-fixture", GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback",
      AUTH_ALLOWED_EMAILS: "owner@ios-retention.test", AUTH_OWNER_EMAILS: "owner@ios-retention.test" });
    const address = server.app.server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://localhost:${address.port}`;
    assert.equal((await fetch(`${origin}/api/v1/bootstrap`, { signal: AbortSignal.timeout(15_000) })).status, 401);
    assert.equal(server.persistent, true); assert.equal(server.ctx.deviceAuth.devControlEscape, false); assert.equal(server.ctx.deviceAuth.devNodeToken, null);
    const owner = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    const request = async (path, body, token = owner.raw) => {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15_000)]) });
      assert.ok(response.ok, `${body === undefined ? "GET" : "POST"} ${path} failed (${response.status})`); return response.json();
    };
    const pairing = await request("/api/v1/devices/pairings", { intended_platform: "ios" });
    const peer = await request("/api/v1/devices/claim", { code: pairing.code, platform: "ios", display_name: "Independent retention observer", app_version: "retention-fixture" });
    assert.equal((await request("/auth/session", undefined, peer.control_token)).user.id, "user_owner");
    fixture = await createRetentionFixture({ root, temporary, origin, projectId: "proj_artoo", peerToken: peer.control_token,
      suffix: randomUUID().slice(0, 8), request, until, simulatorUDID });
    report.fixture_temporary_directory = fixture.scenario.temporary;
    const fields = { ...fixture.fields, server_url: origin, peer_control_token: peer.control_token };
    for (const authorization of [undefined, "Bearer incorrect-retention-token"]) {
      const response = await fetch(`${fields.fixture_control_url}/observations`, { headers: authorization ? { Authorization: authorization } : {}, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 401);
    }
    assert.equal((await fixture.scenario.observe()).snapshot, null, "Fixture may not create the tested native task");
    check("Production authentication, paired worker and one unused Git workspace are ready; observer controls reject other credentials");
    const fixturePath = join(temporary, "fixture.json"); writeFileSync(fixturePath, JSON.stringify(fields), { mode: 0o600 });
    await new Promise((done, reject) => {
      interrupted.signal.throwIfAborted();
      child = spawn(process.execPath, [join(root, "apps/ios/scripts/test-macos.mjs"), "--ui", "--suite=retention"], {
        cwd: root, env: { ...process.env, ARTOO_IOS_SIMULATOR_UDID: simulatorUDID, ARTOO_IOS_UI_FIXTURE: fixturePath, ARTOO_IOS_UI_OUTPUT_DIR: output, ARTOO_IOS_UI_RESULT_JSON: childResultPath },
        stdio: "inherit", windowsHide: true, detached: true });
      const timeout = setTimeout(() => { stopChild("SIGTERM"); reject(new Error("Native retention build and UI exceeded 30 minutes")); }, nativeUISuiteTimeouts("retention").parent);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timeout); code === 0 ? done() : reject(new Error(`Native retention UI failed (${code ?? signal})`)); });
    });
    childResult = JSON.parse(readFileSync(childResultPath, "utf8"));
    assert.equal(childResult.suite, "retention"); assert.equal(childResult.passed, true); assert.equal(childResult.contract?.passed, true);
    assert.deepEqual(childResult.source, report.source, "Native retention must retain its original build/run source");
    report.xctest = childResult; report.retention = await fixture.verify();
    assert.equal(report.retention.passed, true);
    check("Exact native zero-artifact case passed through pairing, task creation, Ready, approval and manual worktree assignment");
    check("One completed process, one approval, zero artifacts/reviews and one retained workspace agree before and after real cold relaunch");
    report.clipboard_probe_integrity = verifySimulatorClipboardEvidence({ receipts: fixture.clipboardEvidence(), simulatorUDID, expectedProbes: 4 });
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : "Native retention verification failed"; process.exitCode = 1;
  } finally {
    const evidence = join(output, "retention-evidence");
    try {
      mkdirSync(evidence, { recursive: true });
      if (fixture) {
        writeFileSync(join(evidence, "checkpoints.json"), JSON.stringify(fixture.evidence(), null, 2));
        writeFileSync(join(evidence, "observer-errors.json"), JSON.stringify(fixture.errors.map((error) => ({ name: error.name, message: error.message, stack: error.stack })), null, 2));
        try { preCleanup = await fixture.scenario.observe(); writeFileSync(join(evidence, "final-pre-cleanup-observation.json"), JSON.stringify(preCleanup, null, 2)); }
        catch { report.observation_error = "Complete final pre-cleanup observation unavailable"; }
        if (preCleanup) {
          try { report.retained_workspace_export = fixture.scenario.exportEvidence(join(evidence, "retained-workspace"), preCleanup); }
          catch (error) { report.workspace_export_unavailable = error instanceof Error ? error.message : "Workspace export unavailable"; if (report.passed) throw error; }
        }
        if (report.passed) assert.ok(report.retained_workspace_export, "Successful UI must retain its complete original workspace export");
      }
    } catch (error) { report.evidence_retention_failed = true; report.passed = false; report.evidence_retention_error = error.message; process.exitCode = 1; }
    let nativeGroup = { closed: true, not_started: true };
    if (child?.pid) {
      try { nativeGroup = await closeOwnedProcessGroup(child.pid); }
      catch { nativeGroup = { closed: false, error: "Owned native process group cleanup failed" }; }
    }
    report.native_process_group = nativeGroup;
    const fixtureClosed = await Promise.allSettled([fixture?.close()]);
    try {
      if (fixture) {
        cpSync(fixture.scenario.receipts, join(evidence, "process-receipts"), { recursive: true });
        if (!report.retained_workspace_export && fixtureClosed.every((result) => result.status === "fulfilled") && nativeGroup.closed) {
          // Failure diagnostics are explicitly partial, copied only after owned
          // writers stop. They never satisfy successful retained-work evidence.
          const partial = join(evidence, "partial-workspace-after-cleanup"); mkdirSync(partial);
          report.partial_workspace_files = [];
          for (const name of [...ZERO_ARTIFACT_FILES, "context_pack.md"]) {
            const source = join(fixture.fields.workspace_root, name); if (!existsSync(source)) continue;
            const stat = lstatSync(source); assert.ok(stat.isFile() && !stat.isSymbolicLink());
            const bytes = readFileSync(source), copy = join(partial, name); writeFileSync(copy, bytes, { mode: 0o600, flag: "wx" });
            report.partial_workspace_files.push({ source, copy, size: bytes.length, sha256: zeroArtifactHash(bytes) });
          }
        }
      }
    } catch { report.evidence_retention_failed = true; report.passed = false; process.exitCode = 1; }
    const closed = [...fixtureClosed, ...await Promise.allSettled([server?.close()])];
    let removalFailed = false;
    try { assert.ok(resolve(temporary).startsWith(`${resolve(tmpdir())}${sep}artoo-ios-retention-`)); rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { removalFailed = true; }
    const failedClose = closed.some((value) => value.status === "rejected");
    report.cleanup = { resources_closed: !failedClose && nativeGroup.closed, temporary_directory_removed: !removalFailed, native_process_group_closed: nativeGroup.closed };
    if (failedClose || removalFailed || !nativeGroup.closed) { report.passed = false; report.error ??= "Native retention cleanup failed"; process.exitCode = 1; }
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    if (!childResult) { try { childResult = JSON.parse(readFileSync(childResultPath, "utf8")); report.xctest = childResult; } catch {} }
    const images = readXCTestScreenshots(join(output, "ui-attachments")), expected = expectedNativeScreenshots("retention");
    report.screenshots = { count: images.length, expected, missing: expected.filter((name) => !images.some(({ caption }) => caption === name || caption.startsWith(`${name}_`) || caption.startsWith(`${name}.`))) };
    report.source_at_finish = getE2EReportContext().source; report.source_stable = isDeepStrictEqual(report.source, report.source_at_finish);
    try {
      if (report.passed) {
        assert.equal(report.screenshots.missing.length, 0, "Every retention UI capture is required");
        report.native_retention_evidence = verifyNativeRetentionEvidence(report, output);
        check("Actual native Copy/cold-relaunch attachment and all four immutable workspace copies remain verified after cleanup");
      }
      assert.equal(report.source_stable, true, "Source changed during native retention verification");
    } catch (error) { report.passed = false; report.error ??= error.message; process.exitCode = 1; }
    if (interrupted.signal.aborted) { report.passed = false; report.error ??= "Native retention suite interrupted"; process.exitCode = 1; }
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
    writeFileSync(resultPath, JSON.stringify(report, null, 2) + "\n"); writeE2EReport({ outputPath: htmlPath, title, report, screenshots: images });
    // Database cleanup can reset Node's exit code; preserve the final failure.
    if (!report.passed) process.exitCode = 1;
    console.log(`[ios-retention] HTML report: ${htmlPath}`);
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Native retention failed"); process.exitCode = 1; });
