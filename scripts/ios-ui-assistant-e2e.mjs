#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createAssistantFixture } from "./ios-ui-assistant-fixture.mjs";
import { verifyAssistantConversationResults } from "./fixtures/assistant-conversation-results.mjs";
import { expectedNativeScreenshots, getE2EReportContext, readXCTestScreenshots, writeE2EReport } from "./e2e-report.mjs";
import { closeOwnedProcessGroup } from "./owned-process-group.mjs";
import { nativeUISuiteTimeouts } from "../apps/ios/scripts/ui-suite-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assistantTimeouts = nativeUISuiteTimeouts("assistant");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/ios-ui-assistant-e2e.mjs");
if (process.platform !== "darwin") throw new Error("The native assistant suite requires macOS and Xcode");
async function until(read, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await read()) return; await new Promise((done) => setTimeout(done, 150)); }
  throw new Error(message);
}

async function main() {
  const started = new Date().toISOString(), ios = join(root, "artifacts/ios");
  const output = resolve(process.env.ARTOO_IOS_UI_OUTPUT_DIR ?? join(ios, "attempts", `${started.replace(/[:.]/g, "-")}-assistant`));
  assert.ok(output.startsWith(`${ios}${sep}`), "Assistant evidence must remain inside artifacts/ios");
  mkdirSync(output, { recursive: true });
  const resultPath = join(output, "suite-result.json"), childResultPath = join(output, "xctest-result.json");
  assert.ok(!existsSync(resultPath) && !existsSync(childResultPath), "Each assistant attempt must retain a new immutable evidence directory");
  const htmlPath = join(output, `native-assistant-${started.replace(/[:.]/g, "-")}.html`);
  const report = { ...getE2EReportContext(), suite: "assistant", mode: "native-assistant-ui-subset",
    scope: "One native direct-agent scenario with a fixture-provisioned identity, production pairing/authentication, real node WebSocket and deterministic CLI subprocesses; no live provider claim",
    started_at: started, checks: [], passed: false,
    diagnostics_scope: "Raw xcresult diagnostics may contain disposable fixture credentials; this HTML contains only approved workflow screenshots." };
  const title = "Artoo iOS · direct agent assistant suite";
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  writeE2EReport({ outputPath: htmlPath, title, report });
  const temporary = mkdtempSync(join(tmpdir(), "artoo-ios-assistant-"));
  let server, fixture, child, childResult;
  const interrupted = new AbortController();
  const stopChild = (signal) => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } } };
  const interrupt = () => { interrupted.abort(new Error("Native assistant suite interrupted")); stopChild("SIGTERM"); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const check = (name) => { report.checks.push(name); console.log(`[ios-assistant] PASS ${name}`); };
  try {
    const { startServer } = await import(pathToFileURL(join(root, "apps/server/dist/main.js")).href);
    const { createSession } = await import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href);
    interrupted.signal.throwIfAborted();
    const workspace = join(temporary, "server-workspace"); mkdirSync(workspace);
    server = await startServer({ NODE_ENV: "production", ARTOO_AI_DATA_SHARING_POLICY: JSON.stringify({ mode: "local", providers: [] }), ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0",
      ARTOO_DATA_DIR: join(temporary, "server-data"), ARTOO_WORKSPACE_ROOT: workspace,
      ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"), ARTOO_WEB_DIST: join(root, "apps/web/dist"),
      GOOGLE_CLIENT_ID: "ios-assistant-fixture", GOOGLE_CLIENT_SECRET: "unused-local-fixture", GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback",
      AUTH_ALLOWED_EMAILS: "owner@ios-assistant.test", AUTH_OWNER_EMAILS: "owner@ios-assistant.test" });
    const address = server.app.server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://localhost:${address.port}`;
    assert.equal((await fetch(`${origin}/api/v1/bootstrap`, { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15_000)]) })).status, 401);
    assert.equal(server.persistent, true); assert.equal(server.ctx.deviceAuth.devControlEscape, false); assert.equal(server.ctx.deviceAuth.devNodeToken, null);
    const owner = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    const request = async (path, body, token = owner.raw) => {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15_000)]) });
      assert.ok(response.ok, `${body === undefined ? "GET" : "POST"} ${path} failed (${response.status})`);
      return response.json();
    };
    const code = await request("/api/v1/devices/pairings", { intended_platform: "ios" });
    const peer = await request("/api/v1/devices/claim", { code: code.code, platform: "ios", display_name: "Independent assistant API observer", app_version: "assistant-fixture" });
    const identity = await request("/auth/session", undefined, peer.control_token);
    assert.equal(identity.user.id, "user_owner");
    check("Persistent shared server requires production authentication; independent peer uses real pairing routes");
    const suffix = randomUUID().slice(0, 8), channelName = `native-assistant-${suffix}`;
    const { channel } = await request("/api/v1/channels", { project_id: "proj_artoo", name: channelName, description: "Isolated native direct-agent acceptance" });
    assert.equal((await request(`/api/v1/rooms/${channel.id}/messages`)).messages.length, 0);
    fixture = await createAssistantFixture({ root, temporary, origin, projectId: channel.project_id, channelId: channel.id,
      userId: identity.user.id, peerToken: peer.control_token, suffix, request, until });
    const fields = { ...fixture.fields, server_url: origin, peer_control_token: peer.control_token,
      project_id: channel.project_id, channel_id: channel.id, channel_name: channelName, user_id: identity.user.id };
    for (const authorization of [undefined, "Bearer incorrect-assistant-token"]) {
      const response = await fetch(`${fields.fixture_control_url}/node/stop`, { method: "POST", headers: authorization ? { Authorization: authorization } : {}, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 401);
    }
    check("Dedicated paired node uses the production process adapter; fixture control rejects missing and wrong credentials");
    const fixturePath = join(temporary, "fixture.json"); writeFileSync(fixturePath, JSON.stringify(fields), { mode: 0o600 });
    await new Promise((done, reject) => {
      interrupted.signal.throwIfAborted();
      child = spawn(process.execPath, [join(root, "apps/ios/scripts/test-macos.mjs"), "--ui", "--suite=assistant"], {
        cwd: root, env: { ...process.env, ARTOO_IOS_UI_FIXTURE: fixturePath, ARTOO_IOS_UI_OUTPUT_DIR: output, ARTOO_IOS_UI_RESULT_JSON: childResultPath },
        stdio: "inherit", windowsHide: true, detached: true });
      const timeout = setTimeout(() => { stopChild("SIGTERM"); reject(new Error(`Native assistant UI exceeded ${assistantTimeouts.parent / 60_000} minutes`)); }, assistantTimeouts.parent);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timeout); code === 0 ? done() : reject(new Error(`Native assistant UI failed (${code ?? signal})`)); });
    });
    childResult = JSON.parse(readFileSync(childResultPath, "utf8"));
    assert.equal(childResult.suite, "assistant"); assert.equal(childResult.passed, true); assert.equal(childResult.contract?.passed, true);
    assert.deepEqual(childResult.source, report.source, "Native assistant build/run must retain the parent's original source fingerprint");
    assert.ok(resolve(childResult.attachments_directory).startsWith(`${output}${sep}`), "Native screenshots must belong to this attempt");
    const captures = readXCTestScreenshots(childResult.attachments_directory);
    for (const caption of expectedNativeScreenshots("assistant")) {
      assert.ok(captures.some((capture) => capture.caption === caption || capture.caption.startsWith(`${caption}_`) || capture.caption.startsWith(`${caption}.`)), `Missing approved screenshot: ${caption}`);
    }
    report.xctest = childResult;
    check("The exact assistant XCTest subset passed with its retained xcresult and approved screenshots");
    check("XCUITest selected the original same-name agent by full identity, restored the waiting request and unsent draft after relaunch, and observed automatic recovery without Retry");
    check("XCUITest observed at least 3.1 seconds of unchanged failure before request-scoped Retry and read both actual answers");
    check("XCUITest inspected the exact linked execution, observed its live process, then used Cancel and verified process exit and at least 3.1 seconds without redispatch");
    const { turns } = await request(`/api/v1/rooms/${channel.id}/assistant-turns`);
    const { messages } = await request(`/api/v1/rooms/${channel.id}/messages?limit=100`);
    const snapshots = await Promise.all([...new Set(turns.map((turn) => turn.task_id))].map((id) => request(`/api/v1/tasks/${id}`)));
    const runs = snapshots.flatMap((snapshot) => snapshot.runs);
    const usages = await Promise.all(runs.map(async (run) => ({ run_id: run.id, usage: (await request(`/api/v1/runs/${run.id}/usage`)).usage })));
    const observations = fixture.readObservations();
    report.assistant = verifyAssistantConversationResults({ fixture: fixture.configuration, turns, messages, runs, usages,
      receipts: observations.receipts, failedOnceReceipts: observations.failed_once_receipts,
      contextHashes: observations.context_hashes, livePids: observations.live_pids });
    assert.equal(report.assistant.passed, true);
    report.node_transitions = fixture.transitions;
    check("Read-only server and independent process evidence confirms three logical turns, four launches, two exact answers and no live held process");
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    let nativeGroup = { closed: true, not_started: true };
    if (child?.pid) {
      try { nativeGroup = await closeOwnedProcessGroup(child.pid); }
      catch { nativeGroup = { closed: false, error: "Owned native process group cleanup failed" }; }
    }
    report.native_process_group = nativeGroup;
    const fixtureClosed = await Promise.allSettled([fixture?.close()]);
    const closed = [...fixtureClosed, ...await Promise.allSettled([server?.close()])];
    const failedClose = closed.find((result) => result.status === "rejected");
    let removalError;
    try {
      assert.ok(resolve(temporary).startsWith(`${resolve(tmpdir())}${sep}artoo-ios-assistant-`));
      rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) { removalError = error; }
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    report.cleanup = { resources_closed: !failedClose && nativeGroup.closed, temporary_directory_removed: !removalError, native_process_group_closed: nativeGroup.closed };
    if (failedClose || removalError || !nativeGroup.closed) { report.passed = false; report.error = "Native assistant fixture cleanup failed"; }
    report.finished_at = new Date().toISOString(); report.html_report = htmlPath;
    if (!childResult) { try { childResult = JSON.parse(readFileSync(childResultPath, "utf8")); report.xctest = childResult; } catch {} }
    // Preserve approved captures even if the child was interrupted before it
    // could write its final JSON; this directory belongs only to this attempt.
    const images = readXCTestScreenshots(join(output, "ui-attachments"));
    const expectedImages = expectedNativeScreenshots("assistant");
    const missing = expectedImages.filter((name) => !images.some(({ caption }) => caption === name || caption.startsWith(`${name}_`) || caption.startsWith(`${name}.`)));
    report.screenshots = { count: images.length, expected: expectedImages, missing };
    const missingRequiredImages = report.passed && missing.length > 0;
    report.source_at_finish = getE2EReportContext().source;
    report.source_stable = isDeepStrictEqual(report.source, report.source_at_finish);
    if (!report.source_stable || missingRequiredImages) {
      report.passed = false;
      report.error ??= !report.source_stable ? "Source changed during native assistant verification" : "Approved assistant screenshots are no longer complete";
    }
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
    writeE2EReport({ outputPath: htmlPath, title, report, screenshots: images });
    console.log(`[ios-assistant] HTML report: ${htmlPath}`);
    if (failedClose || removalError || !nativeGroup.closed) throw new Error("Native assistant fixture cleanup failed");
    if (!report.source_stable || missingRequiredImages) throw new Error(report.error);
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
