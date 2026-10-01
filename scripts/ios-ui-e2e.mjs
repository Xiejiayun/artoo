#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createWorkflowFixture, verifyWorkflowResults } from "./ios-ui-workflows-fixture.mjs";
import { createMemberRevocationFixture, findMemberMessage, selectMemberDevice, verifyMemberRevocationResults } from "./ios-ui-member-revocation.mjs";
import { observeMemberClaim } from "./ios-ui-member-claim-observer.mjs";
import { getE2EReportContext, readXCTestScreenshots, writeE2EReport } from "./e2e-report.mjs";
import { closeOwnedProcessGroup } from "./owned-process-group.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selfCheck = process.argv.includes("--self-check");
if (process.argv.slice(2).some((arg) => arg !== "--self-check")) throw new Error("Usage: node scripts/ios-ui-e2e.mjs [--self-check]");
if (!selfCheck && process.platform !== "darwin") throw new Error("Native UI verification requires macOS and Xcode; --self-check validates only the server/browser harness.");
const baseOutput = resolve(root, "artifacts/ios");
const output = selfCheck ? baseOutput : resolve(process.env.ARTOO_IOS_UI_OUTPUT_DIR
  ?? join(baseOutput, "attempts", `${new Date().toISOString().replace(/[:.]/g, "-")}-core`));
if (!selfCheck && !output.startsWith(`${baseOutput}${sep}`)) throw new Error("Core UI evidence requires its own artifacts/ios attempt directory");
const childResultPath = join(output, "xctest-result.json");
mkdirSync(output, { recursive: true });

async function until(read, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(message);
}

async function main() {
  const temporary = mkdtempSync(join(tmpdir(), "artoo-ios-ui-"));
  const workspace = join(temporary, "workspace");
  mkdirSync(workspace);
  const report = { ...getE2EReportContext(), ...(selfCheck ? {} : { suite: "core" }), mode: selfCheck ? "server-browser-harness-only" : "native-and-browser-ui", model: "deterministic subprocess fixture; no provider session", started_at: new Date().toISOString(), checks: [], passed: false };
  if (!selfCheck) report.diagnostics_scope = "Raw xcresult bundles and exported attachments are unredacted local or CI diagnostics and inherit their repository artifact access rules; they can contain disposable fixture credentials and are intended for trusted recipients. This HTML includes only approved workflow screenshots.";
  const reportPath = join(output, selfCheck ? "ui-harness-self-check.json" : "suite-result.json");
  const htmlPath = join(output, `${selfCheck ? "ui-harness" : "native-ui"}-${report.started_at.replace(/[:.]/g, "-")}.html`);
  const title = selfCheck ? "iOS workflow harness · browser evidence only" : "Artoo iOS · core native and browser E2E subset";
  // An interrupted attempt must never leave a prior successful result in place.
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeE2EReport({ outputPath: htmlPath, title, report });
  if (!selfCheck) rmSync(join(output, "ui-attachments"), { recursive: true, force: true });
  for (const name of selfCheck ? ["harness-browser.png", "harness-daemon.png", "harness-reviewed-plan.png", "harness-failure.png"] : ["native-browser-sync.png", "native-owner-revoked-member-device.png", "native-browser-failure.png"]) {
    rmSync(join(output, name), { force: true });
  }
  const check = (name) => { report.checks.push(name); console.log(`[ios-ui] PASS ${name}`); };
  let server, browser, child, workflows, page, memberClaimObserver;
  const interrupted = new AbortController();
  const stopNative = (signal) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const interrupt = (signal) => {
    interrupted.abort(new Error(`Native UI verification interrupted by ${signal}`));
    memberClaimObserver?.stop();
    stopNative("SIGTERM");
    // Closing the browser releases outstanding UI waits; the normal finally
    // path then closes the server and removes the fixture and runner secrets.
    void browser?.close().catch(() => {});
  };
  const onInterrupt = () => interrupt("SIGINT"), onTerminate = () => interrupt("SIGTERM");
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate);
  try {
    const { startServer } = await import(pathToFileURL(join(root, "apps/server/dist/main.js")).href);
    const { createSession, provisionUser } = await import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href);
    interrupted.signal.throwIfAborted();
    server = await startServer({
      NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0",
      ARTOO_DATA_DIR: join(temporary, "server-data"), ARTOO_WORKSPACE_ROOT: workspace,
      ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"), ARTOO_WEB_DIST: join(root, "apps/web/dist"),
      GOOGLE_CLIENT_ID: "ios-ui-fixture", GOOGLE_CLIENT_SECRET: "unused-local-fixture",
      GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback",
      AUTH_ALLOWED_EMAILS: "owner@ios-ui.test,member@ios-ui.test", AUTH_OWNER_EMAILS: "owner@ios-ui.test",
    });
    interrupted.signal.throwIfAborted();
    const address = server.app.server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://localhost:${address.port}`;
    assert.equal((await fetch(`${origin}/api/v1/bootstrap`, { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15_000)]) })).status, 401);
    assert.equal(server.ctx.deviceAuth.devControlEscape, false);
    assert.equal(server.ctx.deviceAuth.devNodeToken, null);
    assert.equal(server.persistent, true);
    check("Persistent shared server requires production authentication and disables dev credentials");

    // Fixture Web identities are provisioned in-process; no completed Google
    // login is claimed. Native credentials are claimed through the real UI.
    const owner = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    const request = async (path, body, token = owner.raw) => {
      const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15_000)]),
      });
      assert.ok(response.ok, `${body === undefined ? "GET" : "POST"} ${path} failed (${response.status})`);
      return response.json();
    };
    const pairing = () => request("/api/v1/devices/pairings", { intended_platform: "ios" });
    const peerCode = await pairing();
    const peer = await request("/api/v1/devices/claim", { code: peerCode.code, platform: "ios", app_version: "ui-fixture", display_name: "Independent API peer" });
    const nativeCode = await pairing();
    const suffix = randomUUID().slice(0, 8);
    let memberRevocation;
    if (!selfCheck) {
      const member = await provisionUser(server.ctx, { subject: `ios-ui-member-${suffix}`, email: "member@ios-ui.test", emailVerified: true, displayName: `Native member ${suffix}` });
      const memberSession = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: member.userId });
      memberRevocation = await createMemberRevocationFixture({ request, memberSession: memberSession.raw, memberUserId: member.userId, ownerDeviceId: peer.device.id, suffix });
      memberClaimObserver = observeMemberClaim(server.app.server, { origin,
        displayName: memberRevocation.fields.member_native_device_name, memberUserId: member.userId });
      check("Disposable member session and member-owned unregistered Mac use production pairing routes without administrator privileges");
    }
    const channelName = `native-sync-${suffix}`;
    const { channel } = await request("/api/v1/channels", { project_id: "proj_artoo", name: channelName, description: "Native and browser synchronization acceptance" });
    workflows = await createWorkflowFixture({ root, temporary, origin, projectId: channel.project_id, peerToken: peer.control_token, suffix, request, until });
    const fixture = {
      ...workflows.fields,
      ...memberRevocation?.fields,
      server_url: origin, pairing_code: nativeCode.code, project_id: channel.project_id,
      channel_id: channel.id, channel_name: channelName, peer_control_token: peer.control_token,
      native_message: `Native root ${suffix}`, native_reply: `Native thread reply ${suffix}`,
      browser_reply: `Browser thread reply ${suffix}`,
    };
    const control = async (action) => {
      const response = await fetch(`${fixture.fixture_control_url}/node/${action}`, { method: "POST",
        headers: { Authorization: `Bearer ${fixture.fixture_control_token}` }, signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(70_000)]) });
      assert.equal(response.status, 200, `Fixture node ${action} failed`);
      return response.json();
    };
    for (const authorization of [undefined, "Bearer incorrect-fixture-token"]) {
      const response = await fetch(`${fixture.fixture_control_url}/node/stop`, { method: "POST", headers: authorization ? { Authorization: authorization } : {}, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 401, "Test control must reject missing or incorrect credentials");
    }
    assert.equal((await workflows.readDaemon()).status, "online");
    check("Loopback fixture control rejects missing/wrong credentials; real paired WS node advertises two discussion runtimes and one executor");
    const fixturePath = join(temporary, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    const browserChannel = process.env.ARTOO_CHROMIUM_CHANNEL?.trim() || undefined;
    browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) });
    report.environment.browser_channel = browserChannel ?? "playwright-bundled-chromium";
    report.environment.browser_version = browser.version();
    interrupted.signal.throwIfAborted();
    const context = await browser.newContext();
    await context.addCookies([{ name: "artoo_session", value: owner.raw, url: origin, httpOnly: true, sameSite: "Lax" }]);
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`${origin}/channels?room=${encodeURIComponent(channel.id)}`);
    await expect(page.getByRole("heading", { name: `# ${channelName}`, exact: true })).toBeVisible();
    await expect(page.getByText("Live updates connected", { exact: true })).toBeVisible();
    check("Authenticated production Web UI connects to the same server and channel");

    // Connect a separate owner channel before the native build/boot starts.
    // Its UI receives the readiness message over the existing WebSocket, so
    // waiting for native progress does not depend on repeated 15-second GETs.
    let ownerPage;
    if (!selfCheck) {
      ownerPage = await context.newPage();
      ownerPage.setDefaultTimeout(30_000);
      await ownerPage.goto(`${origin}/channels?room=${encodeURIComponent(channel.id)}`);
      await expect(ownerPage.getByRole("heading", { name: `# ${channelName}`, exact: true })).toBeVisible();
      await expect(ownerPage.getByText("Live updates connected", { exact: true })).toBeVisible();
      check("Independent owner Web UI is connected before native build and boot");
    }

    const browserFlow = async () => {
      const channelView = page.getByRole("region", { name: "Channel conversation", exact: true });
      const message = channelView.getByRole("listitem").filter({ hasText: fixture.native_message });
      await expect(message).toBeVisible({ timeout: 1_200_000 });
      await message.hover();
      await message.getByRole("button", { name: "Reply in thread", exact: true }).click();
      const thread = page.getByRole("complementary", { name: "Thread", exact: true });
      await expect(thread.getByRole("list", { name: "Messages" })).toContainText(fixture.native_reply, { timeout: 120_000 });
      await thread.getByLabel("Message", { exact: true }).fill(fixture.browser_reply);
      await thread.getByRole("button", { name: "Send message", exact: true }).click();
      await expect(thread.getByRole("list", { name: "Messages" })).toContainText(fixture.browser_reply);
      check("Web UI receives the native root and thread reply, then sends a reply through the real composer");
      await page.screenshot({ path: join(output, selfCheck ? "harness-browser.png" : "native-browser-sync.png"), fullPage: true });
    };
    const roomPath = `/api/v1/rooms/${channel.id}/messages`;
    const ownerRevocationFlow = async () => {
      try {
        // Wait for the real native message, then verify its unique member
        // attribution through the API before identifying or revoking a phone.
        const readyMessage = ownerPage.getByRole("region", { name: "Channel conversation", exact: true })
          .getByText(fixture.member_revocation_ready_message, { exact: true });
        await expect(readyMessage, "Native member did not reach the revocation boundary").toBeVisible({ timeout: 1_500_000 });
        const { messages } = await request(`${roomPath}?limit=100`);
        assert.ok(findMemberMessage(messages, fixture.member_revocation_ready_message, fixture.member_user_id),
          "Native member readiness message is missing from the shared server");
        const { devices } = await request("/api/v1/devices");
        const target = selectMemberDevice(devices, fixture, fixture.member_native_device_name);
        assert.equal(target.trust, "active");
        const activeSession = await memberClaimObserver.verifyActive(target.id);
        await ownerPage.goto(`${origin}/settings`);
        const card = ownerPage.getByRole("region", { name: "Devices", exact: true }).locator("article")
          .filter({ has: ownerPage.getByRole("heading", { name: fixture.member_native_device_name, exact: true }) });
        await expect(card).toHaveCount(1);
        await card.getByRole("button", { name: "Revoke device", exact: true }).click();
        const [response] = await Promise.all([
          ownerPage.waitForResponse((response) => response.url() === `${origin}/api/v1/devices/${target.id}/revoke` && response.request().method() === "POST"),
          card.getByRole("button", { name: "Confirm revoke", exact: true }).click(),
        ]);
        assert.equal(response.status(), 200, "Owner Settings must accept the revocation");
        const result = await response.json();
        assert.equal(result.device_id, target.id); assert.equal(result.revoked, true);
        assert.ok(result.connections_closed >= 1, "Revocation must close the native phone's live connection");
        // Use the same raw credential observed only in the matching native
        // claim response. The observer releases its private memory in finally.
        const revokedSession = await memberClaimObserver.verifyRevoked(target.id);
        await expect(card.getByText("revoked", { exact: true })).toBeVisible();
        // This card contains device metadata only; pairing controls are outside
        // the captured element and this page never generates a pairing code.
        await expect(ownerPage.getByRole("region", { name: "Device pairing", exact: true }).locator("strong")).toHaveCount(0);
        await card.screenshot({ path: join(output, "native-owner-revoked-member-device.png") });
        report.member_revocation_owner = { device_id: target.id, connections_closed: result.connections_closed,
          active_session_status: activeSession.status, revoked_session_status: revokedSession.status, action: "Owner Settings UI confirmed revoke" };
        check("Independent owner Settings UI revoked the active member iPhone, closed its live connection and caused the same native credential to receive HTTP 401");
      } finally { await ownerPage.close(); }
    };
    const emulatedNative = async () => {
      const freshCode = await request("/api/v1/devices/pairings", { intended_platform: "ios" }, peer.control_token);
      const native = await request("/api/v1/devices/claim", { code: freshCode.code, platform: "ios", app_version: "harness-self-check", display_name: "Harness API client (not native UI)" });
      const send = (body, threadRootId) => request(roomPath, { body, kind: "text", ...(threadRootId ? { thread_root_id: threadRootId } : {}), client_request_id: randomUUID() }, native.control_token);
      const { message } = await send(fixture.native_message);
      await send(fixture.native_reply, message.id);
      await until(async () => (await request(`${roomPath}?thread_root_id=${encodeURIComponent(message.id)}`, undefined, native.control_token)).messages.some((item) => item.body === fixture.browser_reply), "Browser did not deliver its thread reply");
    };
    const nativeFlow = () => new Promise((resolveTest, rejectTest) => {
      interrupted.signal.throwIfAborted();
      // Asynchronous child execution keeps this parent server and the browser
      // responsive while the child's xcodebuild process runs synchronously.
      child = spawn(process.execPath, [join(root, "apps/ios/scripts/test-macos.mjs"), "--ui", "--suite=core"], {
        cwd: root, env: { ...process.env, ARTOO_IOS_UI_FIXTURE: fixturePath, ARTOO_IOS_UI_OUTPUT_DIR: output, ARTOO_IOS_UI_RESULT_JSON: childResultPath }, stdio: "inherit", windowsHide: true, detached: true,
      });
      const timeout = setTimeout(() => { stopNative("SIGTERM"); rejectTest(new Error("Native core build and UI exceeded 40 minutes")); }, 2_400_000);
      child.once("error", (error) => { clearTimeout(timeout); rejectTest(error); });
      child.once("exit", (code, signal) => { clearTimeout(timeout); code === 0 ? resolveTest() : rejectTest(new Error(`Native UI test failed (${code ?? signal})`)); });
    });
    await Promise.all([browserFlow(), selfCheck ? emulatedNative() : nativeFlow(), ...(selfCheck ? [] : [ownerRevocationFlow()])]);
    if (!selfCheck) {
      const native = JSON.parse(readFileSync(childResultPath, "utf8"));
      assert.equal(native.suite, "core"); assert.equal(native.passed, true); assert.equal(native.contract?.passed, true);
      assert.deepEqual(native.source, report.source, "Native build source changed after the parent started");
      report.native = native;
      check("Exact seven-case native core contract passed with the original matching source fingerprint");
    }
    if (selfCheck) {
      // This drives the real Web UI and test controls only. It is deliberately
      // reported as harness evidence, never as an XCUITest or native result.
      await page.goto(`${origin}/computers`);
      const computer = page.getByRole("article", { name: fixture.computer_name, exact: true });
      await expect(computer.getByText("Daemon: online", { exact: true })).toBeVisible({ timeout: 30_000 });
      const stopped = await control("stop");
      assert.equal(stopped.daemon.status, "offline");
      await expect(computer.getByText("Daemon: offline", { exact: true })).toBeVisible({ timeout: 60_000 });
      await control("start");
      await expect(computer.getByText("Daemon: online", { exact: true })).toBeVisible({ timeout: 30_000 });
      check("Browser observes authenticated artood WS online, actual stop/offline, and resumed heartbeat online");
      await page.screenshot({ path: join(output, "harness-daemon.png"), fullPage: true });

      await page.goto(`${origin}/goals`);
      await page.getByRole("navigation", { name: "Goal list" }).getByRole("button", { name: new RegExp(fixture.goal_title) }).click();
      const planning = page.getByRole("region", { name: "Agent planning", exact: true });
      await planning.getByRole("checkbox", { name: new RegExp(fixture.planner_name) }).check();
      await planning.getByRole("checkbox", { name: new RegExp(fixture.reviewer_name) }).check();
      await planning.getByLabel("Discussion rounds", { exact: true }).fill("1");
      await planning.getByLabel("Discussion time limit (minutes)", { exact: true }).fill("5");
      const audit = async () => (await request(`/api/v1/goals/${fixture.goal_id}/audit-bundle`, undefined, peer.control_token)).bundle;
      assert.equal((await audit()).tasks.length, 0);
      await planning.getByRole("button", { name: "Start planning discussion", exact: true }).click();
      await expect(planning.getByText("3 of 3 contributions completed", { exact: false })).toBeVisible({ timeout: 120_000 });
      assert.equal((await audit()).tasks.length, 0, "Finished discussion must not create executable goal tasks");
      await planning.getByRole("button", { name: "Create plan proposal", exact: true }).click();
      const plans = page.getByRole("region", { name: "Plans", exact: true });
      await expect(plans.getByText(fixture.task_1_title, { exact: true })).toBeVisible();
      await expect(plans.getByText(fixture.task_2_title, { exact: true })).toBeVisible();
      await expect(plans.getByText(fixture.task_1_criterion, { exact: true })).toBeVisible();
      await expect(plans.getByText(fixture.task_2_criterion, { exact: true })).toBeVisible();
      await expect(plans.getByText(`Depends on: ${fixture.task_1_title}`, { exact: true })).toBeVisible();
      const proposed = await audit();
      assert.equal(proposed.tasks.length, 0, "A proposal must still have zero materialized tasks before human acceptance");
      assert.equal(proposed.plans[0].status, "proposed");
      report.before_acceptance = { goal_id: fixture.goal_id, task_count: proposed.tasks.length, plan_status: proposed.plans[0].status };
      await plans.getByRole("button", { name: "Accept plan and create tasks", exact: true }).click();
      await expect(plans.getByText("accepted", { exact: true })).toBeVisible();
      check("Browser starts two process-backed agents, reviews their three contributions and dependent proposal, then accepts it with zero goal tasks before acceptance");
      // The product uses an inner scrolling pane. Capture the plan itself so
      // its accepted state, criteria and dependency are not hidden by the shell.
      await plans.screenshot({ path: join(output, "harness-reviewed-plan.png") });
    }
    const roots = await request(roomPath);
    const nativeRoots = roots.messages.filter((message) => message.body === fixture.native_message);
    assert.equal(nativeRoots.length, 1, "Native root must be persisted exactly once");
    const replies = await request(`${roomPath}?thread_root_id=${encodeURIComponent(nativeRoots[0].id)}`);
    for (const text of [fixture.native_reply, fixture.browser_reply]) assert.equal(replies.messages.filter((message) => message.body === text).length, 1);
    assert.ok(replies.messages.every((message) => message.thread_root_id === nativeRoots[0].id));
    check("Shared database retains one root and exactly one copy of each scoped thread reply");
    report.workflows = await verifyWorkflowResults({ fixture, request, transitions: workflows.transitions, verifyNativeActions: !selfCheck });
    check("Production APIs confirm three subprocess turns with exact thread-scoped context, attributed answers, and two accepted tasks with criteria and a blocks dependency");
    if (!selfCheck) check("XCUITest passed real pairing, foreground sync, background catch-up and app relaunch");
    if (!selfCheck) check("XCUITest passed native daemon stop/resume and discussion/proposal/acceptance workflows");
    if (!selfCheck) check("XCUITest restored a needs-information approval after relaunch and verified explicit goal cancellation confirmation");
    if (!selfCheck) check("XCUITest created a task, requested and granted execution approval, manually assigned a real subprocess, previewed its uploaded report in Quick Look and accepted the task");
    if (!selfCheck) {
      report.member_revocation = await verifyMemberRevocationResults({ fixture, unchangedDevices: memberRevocation.unchangedDevices, request });
      check("XCUITest verified member device permissions, owner revocation, disconnected relaunch and fresh member pairing with unchanged device ownership");
    } else {
      report.member_revocation = { status: "not_run", reason: "Member revocation/recovery requires the native UI and is not emulated by the harness self-check" };
    }
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    await page?.screenshot({ path: join(output, selfCheck ? "harness-failure.png" : "native-browser-failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    memberClaimObserver?.stop();
    // A detached group's descendants can outlive its Node leader. Verify the
    // original owned group even when child.exitCode already indicates exit.
    const nativeCleanup = child?.pid ? await closeOwnedProcessGroup(child.pid) : { closed: true, not_started: true };
    report.native_process_cleanup = nativeCleanup;
    if (!nativeCleanup.closed) { report.passed = false; report.error = "Native test process-group cleanup failed"; }
    const workersClosed = await Promise.allSettled([workflows?.close()]);
    const closed = [...workersClosed, ...await Promise.allSettled([browser?.close(), server?.close()])];
    const failedClose = closed.find((result) => result.status === "rejected");
    if (failedClose) { report.passed = false; report.error = "Native UI fixture cleanup failed"; }
    let removalError;
    try {
      const canonical = resolve(temporary);
      assert.ok(canonical.startsWith(`${resolve(tmpdir())}${sep}artoo-ios-ui-`), "Refusing cleanup outside the fixture directory");
      rmSync(canonical, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      removalError = error; report.passed = false; report.error = "Native UI temporary fixture cleanup failed";
    } finally {
      process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
    }
    // Never retain a passing report while private fixture credentials remain
    // because directory cleanup failed after otherwise successful assertions.
    report.cleanup = { resources_closed: !failedClose, temporary_directory_removed: !removalError,
      native_process_group_closed: nativeCleanup.closed };
    report.source_at_finish = getE2EReportContext().source;
    report.source_stable = JSON.stringify(report.source_at_finish) === JSON.stringify(report.source);
    if (!report.source_stable) { report.passed = false; report.error ??= "Core source changed during verification"; }
    report.finished_at = new Date().toISOString();
    report.html_report = htmlPath;
    report.native_result_json = childResultPath;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const browserImages = (selfCheck ? ["harness-browser.png", "harness-daemon.png", "harness-reviewed-plan.png", "harness-failure.png"] : ["native-browser-sync.png", "native-owner-revoked-member-device.png", "native-browser-failure.png"])
      .map((name) => ({ path: join(output, name), caption: `Authenticated browser · ${name.replace(/\.png$/, "").replaceAll("-", " ")}` }))
      .filter(({ path }) => existsSync(path));
    writeE2EReport({ outputPath: htmlPath, title, report, screenshots: [...browserImages, ...(selfCheck ? [] : readXCTestScreenshots(join(output, "ui-attachments")))] });
    console.log(`[ios-ui] HTML report: ${htmlPath}`);
    if (removalError) throw new Error("Native UI temporary fixture cleanup failed", { cause: removalError });
    if (failedClose) throw new Error("Native UI fixture cleanup failed", { cause: failedClose.reason });
    if (!nativeCleanup.closed) throw new Error("Native test process-group cleanup failed");
    if (!report.source_stable) throw new Error("Core source changed during verification");
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
