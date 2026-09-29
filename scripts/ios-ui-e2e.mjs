#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selfCheck = process.argv.includes("--self-check");
if (process.argv.slice(2).some((arg) => arg !== "--self-check")) throw new Error("Usage: node scripts/ios-ui-e2e.mjs [--self-check]");
if (!selfCheck && process.platform !== "darwin") throw new Error("Native UI verification requires macOS and Xcode; --self-check validates only the server/browser harness.");
const output = resolve(root, "artifacts/ios");
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
  const report = { mode: selfCheck ? "server-browser-harness-only" : "native-and-browser-ui", checks: [], passed: false };
  const check = (name) => { report.checks.push(name); console.log(`[ios-ui] PASS ${name}`); };
  let server, browser, child;
  const interrupted = new AbortController();
  const stopNative = (signal) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const interrupt = (signal) => {
    interrupted.abort(new Error(`Native UI verification interrupted by ${signal}`));
    stopNative("SIGTERM");
    // Closing the browser releases outstanding UI waits; the normal finally
    // path then closes the server and removes the fixture and runner secrets.
    void browser?.close().catch(() => {});
  };
  const onInterrupt = () => interrupt("SIGINT"), onTerminate = () => interrupt("SIGTERM");
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate);
  try {
    const { startServer } = await import(pathToFileURL(join(root, "apps/server/dist/main.js")).href);
    const { createSession } = await import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href);
    interrupted.signal.throwIfAborted();
    server = await startServer({
      NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0",
      ARTOO_DATA_DIR: join(temporary, "server-data"), ARTOO_WORKSPACE_ROOT: workspace,
      ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"), ARTOO_WEB_DIST: join(root, "apps/web/dist"),
      GOOGLE_CLIENT_ID: "ios-ui-fixture", GOOGLE_CLIENT_SECRET: "unused-local-fixture",
      GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback",
      AUTH_ALLOWED_EMAILS: "owner@ios-ui.test", AUTH_OWNER_EMAILS: "owner@ios-ui.test",
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

    // Only the fixture owner's web session is provisioned in-process. The app
    // receives a one-use code and claims its own credential through its real UI.
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
    const channelName = `native-sync-${suffix}`;
    const { channel } = await request("/api/v1/channels", { project_id: "proj_artoo", name: channelName, description: "Native and browser synchronization acceptance" });
    const fixture = {
      server_url: origin, pairing_code: nativeCode.code, project_id: channel.project_id,
      channel_id: channel.id, channel_name: channelName, peer_control_token: peer.control_token,
      native_message: `Native root ${suffix}`, native_reply: `Native thread reply ${suffix}`,
      browser_reply: `Browser thread reply ${suffix}`,
    };
    const fixturePath = join(temporary, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    browser = await chromium.launch({ headless: true });
    interrupted.signal.throwIfAborted();
    const context = await browser.newContext();
    await context.addCookies([{ name: "artoo_session", value: owner.raw, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`${origin}/channels?room=${encodeURIComponent(channel.id)}`);
    await expect(page.getByRole("heading", { name: `# ${channelName}`, exact: true })).toBeVisible();
    await expect(page.getByText("Live updates connected", { exact: true })).toBeVisible();
    check("Authenticated production Web UI connects to the same server and channel");

    const browserFlow = async () => {
      const channelView = page.getByRole("region", { name: "Channel conversation", exact: true });
      const message = channelView.getByRole("listitem").filter({ hasText: fixture.native_message });
      await expect(message).toBeVisible({ timeout: 600_000 });
      await message.getByRole("button", { name: /Reply in thread|\d+ replies/ }).click();
      const thread = page.getByRole("complementary", { name: "Thread", exact: true });
      await expect(thread.getByRole("list", { name: "Messages" })).toContainText(fixture.native_reply, { timeout: 120_000 });
      await thread.getByLabel("Message", { exact: true }).fill(fixture.browser_reply);
      await thread.getByRole("button", { name: "Send message", exact: true }).click();
      await expect(thread.getByRole("list", { name: "Messages" })).toContainText(fixture.browser_reply);
      check("Web UI receives the native root and thread reply, then sends a reply through the real composer");
      await page.screenshot({ path: join(output, selfCheck ? "harness-browser.png" : "native-browser-sync.png"), fullPage: true });
    };
    const roomPath = `/api/v1/rooms/${channel.id}/messages`;
    const emulatedNative = async () => {
      const native = await request("/api/v1/devices/claim", { code: fixture.pairing_code, platform: "ios", app_version: "harness-self-check", display_name: "Harness API client (not native UI)" });
      const send = (body, threadRootId) => request(roomPath, { body, kind: "text", ...(threadRootId ? { thread_root_id: threadRootId } : {}), client_request_id: randomUUID() }, native.control_token);
      const { message } = await send(fixture.native_message);
      await send(fixture.native_reply, message.id);
      await until(async () => (await request(`${roomPath}?thread_root_id=${encodeURIComponent(message.id)}`, undefined, native.control_token)).messages.some((item) => item.body === fixture.browser_reply), "Browser did not deliver its thread reply");
    };
    const nativeFlow = () => new Promise((resolveTest, rejectTest) => {
      interrupted.signal.throwIfAborted();
      // Asynchronous child execution keeps this parent server and the browser
      // responsive while the child's xcodebuild process runs synchronously.
      child = spawn(process.execPath, [join(root, "apps/ios/scripts/test-macos.mjs"), "--ui"], {
        cwd: root, env: { ...process.env, ARTOO_IOS_UI_FIXTURE: fixturePath }, stdio: "inherit", windowsHide: true, detached: true,
      });
      const timeout = setTimeout(() => { stopNative("SIGTERM"); rejectTest(new Error("Native UI test exceeded 20 minutes")); }, 1_200_000);
      child.once("error", (error) => { clearTimeout(timeout); rejectTest(error); });
      child.once("exit", (code, signal) => { clearTimeout(timeout); code === 0 ? resolveTest() : rejectTest(new Error(`Native UI test failed (${code ?? signal})`)); });
    });
    await Promise.all([browserFlow(), selfCheck ? emulatedNative() : nativeFlow()]);
    const roots = await request(roomPath);
    const nativeRoots = roots.messages.filter((message) => message.body === fixture.native_message);
    assert.equal(nativeRoots.length, 1, "Native root must be persisted exactly once");
    const replies = await request(`${roomPath}?thread_root_id=${encodeURIComponent(nativeRoots[0].id)}`);
    for (const text of [fixture.native_reply, fixture.browser_reply]) assert.equal(replies.messages.filter((message) => message.body === text).length, 1);
    assert.ok(replies.messages.every((message) => message.thread_root_id === nativeRoots[0].id));
    check("Shared database retains one root and exactly one copy of each scoped thread reply");
    if (!selfCheck) check("XCUITest passed real pairing, foreground sync, background catch-up and app relaunch");
    report.passed = true;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((done) => child.once("exit", done));
      stopNative("SIGTERM");
      await Promise.race([stopped, new Promise((done) => setTimeout(done, 5_000))]);
      stopNative("SIGKILL");
    }
    const closed = await Promise.allSettled([browser?.close(), server?.close()]);
    writeFileSync(join(output, selfCheck ? "ui-harness-self-check.json" : "native-ui-sync.json"), `${JSON.stringify(report, null, 2)}\n`);
    const canonical = resolve(temporary);
    assert.ok(canonical.startsWith(`${resolve(tmpdir())}${sep}artoo-ios-ui-`), "Refusing cleanup outside the fixture directory");
    rmSync(canonical, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
    const failedClose = closed.find((result) => result.status === "rejected");
    if (failedClose) throw new Error("Native UI fixture cleanup failed", { cause: failedClose.reason });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
