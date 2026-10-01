#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "@playwright/test";
import { createMentionsScenario } from "./fixtures/mentions-scenario.mjs";
import { closeNativeMentionsResources, createNativeMentionsFixture } from "./ios-ui-mentions-fixture.mjs";
import { expectedNativeScreenshots, getE2EReportContext, readXCTestScreenshots, writeE2EReport } from "./e2e-report.mjs";
import { closeOwnedProcessGroup } from "./owned-process-group.mjs";
import { closeOwnedBrowser } from "./owned-browser.mjs";
import { hasCompletePNGPixelStream, MAX_PNG_BYTES } from "./png-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/ios-ui-mentions-e2e.mjs");
if (process.platform !== "darwin") throw new Error("The native mentions suite requires macOS and Xcode");

async function main() {
  const started = new Date().toISOString(), ios = join(root, "artifacts/ios");
  const output = resolve(process.env.ARTOO_IOS_UI_OUTPUT_DIR ?? join(ios, "attempts", `${started.replace(/[:.]/g, "-")}-mentions`));
  assert.ok(output.startsWith(`${ios}${sep}`), "Mentions evidence must remain inside artifacts/ios");
  mkdirSync(output, { recursive: true });
  const resultPath = join(output, "suite-result.json"), childResultPath = join(output, "xctest-result.json");
  assert.ok(!existsSync(resultPath) && !existsSync(childResultPath), "Each mentions attempt needs a new immutable evidence directory");
  const htmlPath = join(output, `native-mentions-${started.replace(/[:.]/g, "-")}.html`);
  const title = "Artoo iOS · cross-project historical mentions";
  const report = { ...getE2EReportContext(), suite: "mentions", mode: "native-mentions-ui-subset",
    scope: "Release native recipient and independent Web UI sender over persistent production authentication; historical messages, exact-device pre-handler read failure, explicit retry and isolated unsent drafts; no physical-device or deployed OAuth claim",
    started_at: started, checks: [], passed: false, peer_screenshots: [],
    diagnostics_scope: "Raw xcresult diagnostics may contain disposable fixture credentials; this HTML contains approved workflow screenshots only." };
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  writeE2EReport({ outputPath: htmlPath, title, report });
  const temporary = mkdtempSync(join(tmpdir(), "artoo-ios-mentions-"));
  const peerImages = [], peerNames = ["mentions-peer-first.png", "mentions-peer-second.png"];
  const completePeerImage = ({ path }) => {
    try {
      const stat = lstatSync(path);
      return peerNames.some((name) => path === join(output, name)) && stat.isFile() && !stat.isSymbolicLink()
        && stat.size <= MAX_PNG_BYTES && realpathSync(path).startsWith(`${realpathSync(output)}${sep}`)
        && hasCompletePNGPixelStream(readFileSync(path));
    } catch { return false; }
  };
  let server, browserServer, browser, scenario, scenarioClosing, fixture, child, childResult;
  const closeScenario = () => scenario ? (scenarioClosing ??= Promise.resolve().then(() => scenario.close())) : Promise.resolve();
  const interrupted = new AbortController();
  const stopChild = (signal) => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } } };
  const interrupt = () => {
    interrupted.abort(new Error("Native mentions suite interrupted")); stopChild("SIGTERM");
    void closeScenario().catch(() => {});
  };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const check = (name) => { report.checks.push(name); console.log(`[ios-mentions] PASS ${name}`); };
  try {
    const { startServer } = await import(pathToFileURL(join(root, "apps/server/dist/main.js")).href);
    const { createSession } = await import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href);
    interrupted.signal.throwIfAborted();
    const workspace = join(temporary, "server-workspace"); mkdirSync(workspace);
    server = await startServer({ NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0",
      ARTOO_DATA_DIR: join(temporary, "server-data"), ARTOO_WORKSPACE_ROOT: workspace,
      ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"), ARTOO_WEB_DIST: join(root, "apps/web/dist"),
      GOOGLE_CLIENT_ID: "ios-mentions-fixture", GOOGLE_CLIENT_SECRET: "unused-local-fixture", GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback",
      AUTH_ALLOWED_EMAILS: "owner@ios-mentions.test,sender@mentions-ui.test", AUTH_OWNER_EMAILS: "owner@ios-mentions.test" });
    const address = server.app.server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://localhost:${address.port}`;
    assert.equal((await fetch(`${origin}/api/v1/bootstrap`, { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15_000)]) })).status, 401);
    assert.equal(server.persistent, true); assert.equal(server.ctx.deviceAuth.devControlEscape, false); assert.equal(server.ctx.deviceAuth.devNodeToken, null);
    const owner = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    const ownerHeaders = { Authorization: `Bearer ${owner.raw}` };
    const request = async (path, body, token = owner.raw) => {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15_000)]) });
      assert.ok(response.ok, `${body === undefined ? "GET" : "POST"} ${path} failed (${response.status})`);
      return response.json();
    };
    const code = await request("/api/v1/devices/pairings", { intended_platform: "ios" });
    const peer = await request("/api/v1/devices/claim", { code: code.code, platform: "ios", display_name: "Independent mentions API observer", app_version: "mentions-fixture" });
    const identity = await request("/auth/session", undefined, peer.control_token);
    assert.equal(identity.user.id, "user_owner");
    check("Persistent server uses production authentication; the independent recipient observer claims its real device credential");
    const suffix = randomUUID().slice(0, 8);
    interrupted.signal.throwIfAborted();
    const browserChannel = process.env.ARTOO_CHROMIUM_CHANNEL?.trim() || undefined;
    browserServer = await chromium.launchServer({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) });
    browser = await chromium.connect(browserServer.wsEndpoint());
    report.environment.browser_channel = browserChannel ?? "playwright-bundled-chromium";
    report.environment.browser_version = browser.version();
    interrupted.signal.throwIfAborted();
    scenario = await createMentionsScenario({ root, server, origin, browser, ownerHeaders,
      recipientUserId: identity.user.id, platform: "ios", deviceName: `Native mentions iPhone ${suffix}`, suffix,
      onScreenshot: async ({ locator, name, caption }) => {
        assert.ok(peerNames.includes(name), "Only the two reviewed sender message screenshots are allowed");
        assert.ok(typeof caption === "string" && caption.startsWith("Independent sender browser"));
        const page = locator.page();
        for (const selector of ['input[type="password"]', 'input[name="token"]', 'input[name="code"]', '[data-testid="pairing-code"]']) {
          assert.equal(await page.locator(selector).count(), 0, "Approved peer screenshots must exclude credential inputs");
        }
        const path = join(output, name);
        assert.ok(!existsSync(path), "Peer screenshot identities must be unique within an attempt");
        await locator.screenshot({ path });
        const image = { path, caption };
        assert.ok(completePeerImage(image), "The captured sender article must retain a complete PNG pixel stream");
        peerImages.push(image); report.peer_screenshots = [...peerImages];
        writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
        writeE2EReport({ outputPath: htmlPath, title, report, screenshots: peerImages });
      } });
    interrupted.signal.throwIfAborted();
    fixture = await createNativeMentionsFixture({ scenario });
    const fields = { ...scenario.fields, ...fixture.fields, server_url: origin, peer_control_token: peer.control_token };
    for (const authorization of [undefined, "Bearer incorrect-mentions-token"]) {
      const response = await fetch(`${fields.fixture_control_url}/publish`, { method: "POST", body: "{}",
        headers: authorization ? { Authorization: authorization } : {}, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 401);
    }
    check("Native fixture control rejects unauthorized publication; project B remains deferred until real recipient readiness");
    const fixturePath = join(temporary, "fixture.json"); writeFileSync(fixturePath, JSON.stringify(fields), { mode: 0o600 });
    await new Promise((done, reject) => {
      interrupted.signal.throwIfAborted();
      child = spawn(process.execPath, [join(root, "apps/ios/scripts/test-macos.mjs"), "--ui", "--suite=mentions"], {
        cwd: root, env: { ...process.env, ARTOO_IOS_UI_FIXTURE: fixturePath, ARTOO_IOS_UI_OUTPUT_DIR: output, ARTOO_IOS_UI_RESULT_JSON: childResultPath },
        stdio: "inherit", windowsHide: true, detached: true });
      const timeout = setTimeout(() => { stopChild("SIGTERM"); reject(new Error("Native mentions UI exceeded 30 minutes")); }, 1_800_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timeout); code === 0 ? done() : reject(new Error(`Native mentions UI failed (${code ?? signal})`)); });
    });
    childResult = JSON.parse(readFileSync(childResultPath, "utf8"));
    assert.equal(childResult.suite, "mentions"); assert.equal(childResult.passed, true); assert.equal(childResult.contract?.passed, true);
    assert.deepEqual(childResult.source, report.source, "Native mentions build/run must retain the parent's original source fingerprint");
    assert.equal(childResult.attachments_directory, join(output, "ui-attachments"));
    const captures = readXCTestScreenshots(childResult.attachments_directory);
    for (const caption of expectedNativeScreenshots("mentions")) {
      assert.ok(captures.some((capture) => capture.caption === caption || capture.caption.startsWith(`${caption}_`) || capture.caption.startsWith(`${caption}.`)), `Missing approved screenshot: ${caption}`);
    }
    report.xctest = childResult;
    check(`Exact historical mention XCTest passed with its retained xcresult and ${expectedNativeScreenshots("mentions").length} required native screenshots`);
    check("Native UI paired before project B publication, opened both exact historical targets, used explicit read Retry and retained separate A/B thread drafts across project changes and relaunch");
    report.mentions = await scenario.verify();
    assert.equal(report.mentions.passed, true);
    check("Independent read-only verifier confirmed production Web sender messages, one pre-handler 503, exact read identities, unchanged sentinel and unsent drafts");
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.publication_stage = scenario?.publicationStage;
    throw error;
  } finally {
    // Begin cancellation immediately; awaiting the control publication first
    // would otherwise leave Playwright and fetch waits active during cleanup.
    void closeScenario().catch(() => {});
    let nativeGroup = { closed: true, not_started: true };
    if (child?.pid) {
      try { nativeGroup = await closeOwnedProcessGroup(child.pid, { termTimeoutMs: 2000, killTimeoutMs: 2000 }); }
      catch { nativeGroup = { closed: false, error: "Owned native process group cleanup failed" }; }
    }
    report.native_process_group = nativeGroup;
    let browserCleanup = browserServer ? { closed: false, pending: true } : { closed: true, not_started: true };
    const resources = await closeNativeMentionsResources({ scenario: closeScenario,
      fixture: fixture ? () => fixture.close() : undefined,
      browser: browserServer ? async () => {
        browserCleanup = await closeOwnedBrowser(browserServer, { gracefulTimeoutMs: 1500, forceTimeoutMs: 1500 });
        assert.equal(browserCleanup.closed, true, "Owned sender browser exit and profile cleanup must complete");
      } : undefined,
      server: server ? () => server.close() : undefined });
    report.resource_cleanup = resources; report.browser_process_cleanup = browserCleanup;
    const failedClose = !resources.closed;
    let removalError;
    try {
      assert.ok(resolve(temporary).startsWith(`${resolve(tmpdir())}${sep}artoo-ios-mentions-`));
      rmSync(temporary, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (error) { removalError = error; }
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    report.cleanup = { resources_closed: !failedClose && nativeGroup.closed, temporary_directory_removed: !removalError,
      native_process_group_closed: nativeGroup.closed, browser_process_closed: browserCleanup.closed };
    if (failedClose || removalError || !nativeGroup.closed) {
      report.passed = false; report.cleanup_error = "Native mentions fixture cleanup failed";
      report.error ??= report.cleanup_error;
    }
    report.finished_at = new Date().toISOString(); report.html_report = htmlPath;
    if (!childResult) { try { childResult = JSON.parse(readFileSync(childResultPath, "utf8")); report.xctest = childResult; } catch {} }
    const images = readXCTestScreenshots(join(output, "ui-attachments"));
    const expected = expectedNativeScreenshots("mentions");
    const missing = expected.filter((name) => !images.some(({ caption }) => caption === name || caption.startsWith(`${name}_`) || caption.startsWith(`${name}.`)));
    const retainedPeers = peerImages.filter(completePeerImage);
    report.peer_screenshots = retainedPeers;
    const missingPeers = peerNames.filter((name) => !retainedPeers.some(({ path }) => path === join(output, name)));
    report.screenshots = { count: images.length, expected, missing, missing_peer_images: missingPeers };
    const missingRequiredImages = report.passed && (missing.length > 0 || missingPeers.length > 0);
    report.source_at_finish = getE2EReportContext().source;
    report.source_stable = isDeepStrictEqual(report.source, report.source_at_finish);
    if (!report.source_stable || missingRequiredImages) {
      report.passed = false;
      report.error ??= !report.source_stable ? "Source changed during native mentions verification" : "Approved mentions screenshots are incomplete";
    }
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
    writeE2EReport({ outputPath: htmlPath, title, report, screenshots: [...images, ...retainedPeers] });
    console.log(`[ios-mentions] HTML report: ${htmlPath}`);
    if (failedClose || removalError || !nativeGroup.closed) throw new Error(report.error ?? report.cleanup_error);
    if (!report.source_stable || missingRequiredImages) throw new Error(report.error);
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
