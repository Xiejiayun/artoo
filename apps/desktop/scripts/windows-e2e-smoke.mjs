import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, chromium } from "playwright";
import { expect } from "@playwright/test";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDir, "..", "..");
const artifactDir = join(desktopDir, "release", "smoke-artifacts");
const fixturePatch = "diff --git a/preview.txt b/preview.txt\nnew file mode 100644\n--- /dev/null\n+++ b/preview.txt\n@@ -0,0 +1 @@\n+Packaged authenticated execution verified\n";

function run(command, args, timeout = 300_000) {
  console.log(`[smoke] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: repoRoot, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" }, stdio: "inherit", windowsHide: true, timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}
function runNpm(args) {
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")].find((path) => path && existsSync(path));
  if (!cli) throw new Error("Run through npm run smoke:win --workspace @artoo/desktop to supply npm's CLI path");
  run(process.execPath, [cli, ...args]);
}
function findFirst(directory, predicate) {
  if (!existsSync(directory)) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isFile() && predicate(entry.name)) return full;
    if (entry.isDirectory()) { const found = findFirst(full, predicate); if (found) return found; }
  }
  return undefined;
}
async function until(predicate, message, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(message);
}
async function bounded(promise, label, timeout = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not respond within ${timeout}ms`)), timeout); })]);
  } finally { clearTimeout(timer); }
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function removeTemp(directory) {
  const canonical = resolve(directory);
  assert.ok(canonical.startsWith(`${resolve(tmpdir())}${sep}artoo-desktop-smoke-`), "Refusing cleanup outside the smoke temporary directory");
  await until(() => { try { rmSync(canonical, { recursive: true, force: true }); return !existsSync(canonical); } catch { return false; } }, "Smoke temporary files remained locked", 15_000);
}

async function main() {
  assert.equal(process.platform, "win32", "The packaged smoke must run on Windows");
  mkdirSync(artifactDir, { recursive: true });
  for (const filename of ["windows-desktop-smoke.json", "windows-desktop-smoke.png", "windows-desktop-smoke-failure.png", "windows-artifact.patch", "windows-artifact-after-restart.patch", "windows-live-copilot.json", "windows-live-copilot-plan.png"]) {
    rmSync(join(artifactDir, filename), { force: true });
  }
  runNpm(["run", "build", "--workspace", "@artoo/server"]);
  if (process.env.ARTOO_SMOKE_SKIP_BUILD !== "1") runNpm(["run", "dist:win", "--workspace", "@artoo/desktop"]);
  const installer = findFirst(join(desktopDir, "release"), (name) => /^Artoo Setup .*\.exe$/i.test(name));
  assert.ok(installer, "Build an NSIS installer before using ARTOO_SMOKE_SKIP_BUILD=1");
  const tempRoot = mkdtempSync(join(tmpdir(), "artoo-desktop-smoke-"));
  const installDir = join(tempRoot, "install"), userData = join(tempRoot, "desktop-data");
  const workspace = join(tempRoot, "workspace"), fixtureBin = join(tempRoot, "fixture-bin");
  const fixtureKey = randomBytes(24).toString("hex");
  const fixtureProgram = join(fixtureBin, "codex.cmd");
  mkdirSync(artifactDir, { recursive: true }); mkdirSync(workspace); mkdirSync(fixtureBin);
  // npm-shaped fixture exercises ordinary Codex resolution and the real bundled
  // worker. No model/network subscription, mock adapter, or dev route is used.
  writeFileSync(fixtureProgram, '@ECHO off\r\n"%_prog%" "%dp0%\\fixture-codex.mjs" %*\r\n');
  writeFileSync(join(fixtureBin, "fixture-codex.mjs"), `import {writeFileSync} from 'node:fs';
if (process.env.ARTOO_CODEX_PROVIDER_KEY !== ${JSON.stringify(fixtureKey)}) throw new Error('Configured fixture key did not reach CLI');
writeFileSync('changes.patch', ${JSON.stringify(fixturePatch)});
writeFileSync('fixture-execution.json', JSON.stringify({argv:process.argv.slice(2), executable:process.execPath, cwd:process.cwd(), apiKeyConfigured:true}));
console.error('Diagnostic key: ' + process.env.ARTOO_CODEX_PROVIDER_KEY);
console.log('Packaged Codex adapter fixture completed');
`);
  const port = await freePort(), baseUrl = `http://127.0.0.1:${port}`;
  const serverEnv = {
    NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", ARTOO_PORT: String(port),
    ARTOO_DATA_DIR: join(tempRoot, "server-data"), ARTOO_WORKSPACE_ROOT: workspace,
    ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"), ARTOO_DESKTOP_CORS: "1",
    ARTOO_WEB_DIST: join(repoRoot, "apps/web/dist"),
    GOOGLE_CLIENT_ID: "smoke-oidc-client", GOOGLE_CLIENT_SECRET: "smoke-unused-secret",
    GOOGLE_REDIRECT_URI: `${baseUrl}/auth/google/callback`,
    AUTH_ALLOWED_EMAILS: "owner@preview.test", AUTH_OWNER_EMAILS: "owner@preview.test",
  };
  const appEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$|^electron_run_as_node$/i.test(key)));
  // Only the absolute program selected through Settings may execute. Empty PATH
  // prevents a regression from accidentally invoking an installed live model CLI.
  Object.assign(appEnv, { PATH: "", ARTOO_DESKTOP_DATA_DIR: userData, ARTOO_SERVER_URL: baseUrl,
    ARTOO_CODEX_PROVIDER_KEY: "inherited-fixture-key-must-not-win" });
  const { startServer } = await import(pathToFileURL(join(repoRoot, "apps/server/dist/main.js")).href);
  const { createSession } = await import(pathToFileURL(join(repoRoot, "apps/server/dist/auth/auth-service.js")).href);
  let server, browser, electronApp, page, appExe, ownerCookie;
  let liveReportPath, executionError;
  let liveActive = false;
  let uninstalled = false;
  const checks = [];
  const captures = [];
  const report = { result: "fail", checkedAt: new Date().toISOString(), installer,
    installerSha256: createHash("sha256").update(readFileSync(installer)).digest("hex"), checks, captures,
    cleanup_complete: false,
    modelExecution: "Temporary CLI fixture through production Codex adapter; no real model quality claim",
    ownerAuthentication: "Test-provisioned owner cookie; native pairing and authorization use production endpoints" };
  let rendererCrashed = false;
  const check = (description) => { checks.push(description); console.log(`[smoke] PASS ${description}`); };
  const ownerApi = async (route) => {
    const response = await fetch(`${baseUrl}${route}`, { headers: { Cookie: ownerCookie } });
    assert.equal(response.ok, true, `Owner read ${route}: ${response.status}`);
    return response.json();
  };
  async function launchApp() {
    electronApp = await electron.launch({ executablePath: appExe, env: appEnv, timeout: 45_000 });
    page = await electronApp.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(30_000);
    rendererCrashed = false;
    page.on("crash", () => { rendererCrashed = true; console.error("[renderer] Renderer process crashed"); });
    page.on("pageerror", (error) => console.error(liveActive ? "[renderer] Renderer failure during live verification" : `[renderer] ${error.message}`));
    page.on("requestfailed", (request) => console.error(`[renderer] ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
    await page.waitForLoadState("domcontentloaded");
  }
  async function captureEvidence(filename, taskId) {
    const screenshotPath = join(artifactDir, filename);
    // Workspace panes scroll independently. Capture the actual native viewport;
    // fullPage does not reveal their offscreen content and adds layout work.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const record = { attempt, method: "playwright-viewport", filename, startedAt: new Date().toISOString() };
      captures.push(record);
      try {
        assert.equal(rendererCrashed, false, "Renderer crashed before evidence capture");
        assert.equal(page.isClosed(), false, "App window closed before evidence capture");
        record.window = await bounded(electronApp.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error("Native app window is unavailable");
          const before = { visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused() };
          if (window.isMinimized()) window.restore();
          window.show(); window.focus();
          return { before, visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused() };
        }), "Native window activation");
        await bounded(page.bringToFront(), "Renderer activation");
        const health = await bounded(page.evaluate(async () => {
          const [connection, worker] = await Promise.all([window.artooDesktop.getConnection(), window.artooDesktop.daemonStatus()]);
          return { paired: connection.paired, worker: worker.state, taskStatus: document.querySelector(".task-detail__header .ui-badge--status")?.textContent?.trim() };
        }), "Renderer and native IPC health probe");
        assert.equal(health.paired, true, "App lost its native connection during evidence capture");
        assert.equal(health.worker, "running", "Worker stopped during evidence capture");
        assert.equal(health.taskStatus, "done", "Renderer lost the reviewed task state");
        assert.equal((await bounded(ownerApi(`/api/v1/tasks/${taskId}`), "Server task health probe")).task.status, "done");
        await expect(page.getByText("Live updates connected", { exact: true })).toBeVisible({ timeout: 10_000 });
        record.health = health;
        const png = await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled", timeout: 30_000 });
        assert.ok(png.length > 0, "Screenshot was empty");
        record.result = "pass";
        console.log(`[smoke] Evidence capture ${attempt}/2 passed (${record.method})`);
        return screenshotPath;
      } catch (error) {
        record.result = "fail"; record.error = error instanceof Error ? error.message : String(error);
        console.error(`[smoke] Evidence capture ${attempt}/2 failed (${record.method}): ${record.error}`);
        // A real functional failure is never retried. A transient Chromium
        // screenshot timeout gets one attempt after all health probes pass again.
        if (error?.name !== "TimeoutError" || !record.health || attempt === 2) throw error;
      } finally { record.finishedAt = new Date().toISOString(); }
    }
    throw new Error("Evidence capture did not complete");
  }
  async function workerState(expected) {
    await until(async () => (await page.evaluate(() => window.artooDesktop.daemonStatus())).state === expected, `Worker did not reach ${expected}`);
  }
  async function downloadPatch(filename) {
    const path = join(artifactDir, filename);
    // Electron's native Save dialog is outside a Playwright Page. Select the
    // destination through the actual session download event, then verify disk
    // bytes; the renderer still initiates its authenticated Blob download.
    await electronApp.evaluate(({ session }, downloadPath) => {
      globalThis.__artooSmokeDownload = "waiting";
      session.defaultSession.once("will-download", (_event, item) => {
        globalThis.__artooSmokeDownload = "started";
        item.setSavePath(downloadPath);
        item.once("done", (_doneEvent, state) => { globalThis.__artooSmokeDownload = state; });
      });
    }, path);
    await page.getByRole("button", { name: "Download artifact", exact: true }).click();
    await until(async () => {
      const state = await electronApp.evaluate(() => globalThis.__artooSmokeDownload);
      if (["cancelled", "interrupted"].includes(state)) throw new Error(`Native artifact download ${state}`);
      return state === "completed";
    }, "Native artifact download did not complete");
    assert.equal(readFileSync(path, "utf8"), fixturePatch); return path;
  }
  function uninstall() {
    if (!appExe || !existsSync(appExe)) return;
    const uninstaller = findFirst(installDir, (name) => /^Uninstall .*\.exe$/i.test(name));
    assert.ok(uninstaller, "Installed app has no uninstaller"); run(uninstaller, ["/S"], 120_000);
  }
  try {
    server = await startServer(serverEnv);
    assert.equal(server.persistent, true);
    assert.equal((await fetch(`${baseUrl}/api/v1/bootstrap`)).status, 401);
    assert.equal(server.ctx.deviceAuth.devControlEscape, false); assert.equal(server.ctx.deviceAuth.devNodeToken, null);
    // Only the Web owner cookie is provisioned directly. Native credentials,
    // enrollment, task writes, and worker management all go through actual UI.
    const session = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    ownerCookie = `artoo_session=${session.raw}`;
    browser = await chromium.launch({ headless: true });
    const owner = await browser.newContext();
    await owner.addCookies([{ name: "artoo_session", value: session.raw, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
    const ownerPage = await owner.newPage(); await ownerPage.goto(`${baseUrl}/settings`);
    await ownerPage.getByRole("button", { name: "Generate pairing code" }).click();
    const pairingRegion = ownerPage.getByRole("region", { name: "Device pairing" });
    await expect(pairingRegion.locator("strong")).toBeVisible();
    const pairingCode = await pairingRegion.locator("strong").textContent();
    check("Production auth required; owner creates a real one-use pairing code");

    run(installer, ["/S", `/D=${installDir}`], 180_000);
    appExe = findFirst(installDir, (name) => /^Artoo\.exe$/i.test(name));
    assert.ok(appExe, "NSIS did not install Artoo.exe");
    assert.ok(existsSync(join(installDir, "resources/app.asar.unpacked/daemon/artood.mjs")), "Bundled daemon missing");
    await launchApp();
    await expect(page.getByRole("heading", { name: "Connect this computer" })).toBeVisible();
    await page.getByLabel("Server address").fill(baseUrl);
    await page.getByLabel("Device name").fill("Packaged Windows smoke");
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByRole("button", { name: "Pair this computer" }).click();
    await expect(page.getByRole("link", { name: "Workspace", exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Live updates connected", { exact: true })).toBeVisible();
    const connection = await page.evaluate(() => window.artooDesktop.getConnection());
    assert.equal(connection.paired, true); assert.ok(connection.computerId);
    const nativeToken = await page.evaluate(() => window.artooDesktop.getToken());
    assert.equal(readFileSync(join(userData, "connection.json"), "utf8").includes(nativeToken), false, "Native credential persisted in plaintext");
    assert.equal(await page.evaluate((token) => Object.values(localStorage).some((value) => value.includes(token)), nativeToken), false);
    check("NSIS app pairs and enrolls through UI; native REST/realtime authenticate; credential encrypted at rest");

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByLabel("Allowed workspace folders").fill(workspace);
    await page.getByLabel("Codex program (optional)").fill(fixtureProgram);
    await page.getByLabel("Model connection", { exact: true }).selectOption("responses");
    await page.getByLabel("Model name", { exact: true }).fill("smoke-model");
    await page.getByLabel("Model API address", { exact: true }).fill("http://127.0.0.1:1/v1");
    await page.getByLabel("Model API key", { exact: true }).fill(fixtureKey);
    await page.getByRole("checkbox", { name: "Allow execution of trusted team tasks on this computer" }).check();
    await page.getByRole("button", { name: "Save worker configuration" }).click();
    await until(async () => (await page.evaluate(() => window.artooDesktop.daemonStatus())).config.allowedRoots.includes(workspace), "Worker configuration was not saved");
    const savedCodex = (await page.evaluate(() => window.artooDesktop.daemonStatus())).config.codex;
    assert.deepEqual(savedCodex, { mode: "responses", binaryPath: fixtureProgram, model: "smoke-model", authMode: "api-key", baseUrl: "http://127.0.0.1:1/v1", hasKey: true });
    assert.equal(readFileSync(join(userData, "connection.json"), "utf8").includes(fixtureKey), false, "Provider key persisted in plaintext");
    assert.equal(JSON.stringify(savedCodex).includes(fixtureKey), false, "Provider key exposed in native status");
    await expect(page.getByLabel("Model API key", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Start worker", exact: true }).click(); await workerState("running");
    const firstPid = (await page.evaluate(() => window.artooDesktop.daemonStatus())).pid;
    const duplicate = spawnSync(appExe, [], { cwd: repoRoot, env: appEnv, windowsHide: true, stdio: "ignore", timeout: 20_000 });
    assert.equal(duplicate.error, undefined, "Second launch did not exit through the single-instance guard");
    assert.equal(duplicate.status, 0);
    assert.equal((await page.evaluate(() => window.artooDesktop.daemonStatus())).pid, firstPid, "Second app launch changed the active worker");
    check("A second app launch exits without creating another execution worker");
    await page.getByRole("button", { name: "Restart worker", exact: true }).click();
    await until(async () => { const status = await page.evaluate(() => window.artooDesktop.daemonStatus()); return status.state === "running" && status.pid !== firstPid; }, "Worker restart did not replace the process");
    await page.getByRole("button", { name: "Stop worker", exact: true }).click(); await workerState("stopped");
    await page.getByRole("button", { name: "Start worker", exact: true }).click(); await workerState("running");
    check("Settings configures the bundled worker; start, stop, and restart verified");

    await page.getByRole("link", { name: "Computers", exact: true }).click();
    await page.getByText("Register an agent workspace", { exact: true }).click();
    await page.getByLabel("Agent runtime").selectOption("codex");
    await page.getByLabel("Agent display name").fill("Packaged fixture Codex");
    await page.getByLabel("Agent workspace path").fill(workspace);
    await page.getByRole("button", { name: "Register agent", exact: true }).click();
    await expect(page.getByText("Agent workspace registered. It is available on the Agents page.")).toBeVisible();
    await page.getByRole("link", { name: "Workspace", exact: true }).click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create task" }), taskTitle = `Packaged authenticated run ${Date.now()}`;
    await dialog.getByLabel("Title", { exact: true }).fill(taskTitle);
    await dialog.getByLabel("Description", { exact: true }).fill("Exercise the ordinary Codex adapter using a temporary model-free CLI fixture.");
    await dialog.getByLabel("Acceptance criteria (one per line)").fill("Download and verify the uploaded patch from the desktop");
    await dialog.getByText("Required capabilities", { exact: true }).click();
    await dialog.getByRole("checkbox", { name: "code.modify", exact: true }).check();
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/tasks" && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    const createResponse = await created; assert.equal(createResponse.ok(), true);
    const taskId = (await createResponse.json()).task.id;
    await page.getByRole("button", { name: "Mark ready", exact: true }).click();
    await page.getByText("Require approval before execution", { exact: true }).click();
    await page.getByLabel("Execution approval summary").fill("Run the packaged fixture in its isolated smoke workspace");
    await page.getByRole("button", { name: "Request execution approval", exact: true }).click();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    await until(async () => {
      const snapshot = await ownerApi(`/api/v1/tasks/${taskId}`);
      if (snapshot.task.status === "blocked") throw new Error(`Fixture run blocked: ${JSON.stringify(snapshot.runs.map((run) => ({ status: run.status, summary: run.summary })))}`);
      return snapshot.task.status === "review";
    }, "The packaged worker did not deliver a reviewable task", 60_000);
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
    assert.equal(await page.locator(".pane").evaluateAll((panes) => panes.every((pane) => pane.scrollWidth <= pane.clientWidth + 1)), true, "A workspace pane overflows horizontally with real generated identifiers");
    const execution = JSON.parse(readFileSync(join(workspace, "fixture-execution.json"), "utf8"));
    assert.equal(execution.executable.toLowerCase(), appExe.toLowerCase(), "CLI did not run through packaged Electron");
    assert.equal(execution.argv[0], "exec", "Ordinary Codex command arguments were not used");
    assert.equal(execution.apiKeyConfigured, true);
    assert.ok(execution.argv.includes('model="smoke-model"'));
    assert.ok(execution.argv.includes('model_provider="artoo_desktop"'));
    assert.ok(execution.argv.includes('model_providers.artoo_desktop.env_key="ARTOO_CODEX_PROVIDER_KEY"'));
    assert.equal(JSON.stringify(execution).includes(fixtureKey), false, "Provider key exposed in CLI arguments");
    await expect(page.locator(".run-output")).toContainText("Diagnostic key: [redacted]");
    assert.equal((await page.locator(".run-output").textContent()).includes(fixtureKey), false, "Provider key exposed in runtime output");
    check("Local Responses settings select an absolute CLI with empty PATH; key encrypted, private in argv/status and redacted from runtime output");
    const downloaded = await downloadPatch("windows-artifact.patch");
    await page.getByLabel("Review comment", { exact: true }).fill("Downloaded patch bytes verified by packaged authenticated smoke");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.locator(".task-detail__header .ui-badge--status")).toHaveText("done");
    await captureEvidence("windows-desktop-smoke.png", taskId);
    check("Native UI creates and approves task; bundled daemon runs Codex fixture; artifact downloads and review completes");

    await electronApp.close(); electronApp = undefined; page = undefined;
    await server.close(); server = undefined; server = await startServer(serverEnv);
    assert.equal((await ownerApi(`/api/v1/tasks/${taskId}`)).task.status, "done");
    await launchApp();
    await page.getByRole("button", { name: new RegExp(taskTitle) }).click();
    await expect(page.locator(".task-detail__header .ui-badge--status")).toHaveText("done");
    assert.deepEqual(await page.evaluate(() => window.artooDesktop.getConnection()), connection);
    assert.ok((await page.evaluate(() => window.artooDesktop.daemonStatus())).config.allowedRoots.includes(workspace));
    assert.deepEqual((await page.evaluate(() => window.artooDesktop.daemonStatus())).config.codex, savedCodex);
    await downloadPatch("windows-artifact-after-restart.patch");
    check("App/server restart preserve device identity, worker settings, reviewed task, and downloadable artifact");
    if (process.env.ARTOO_DESKTOP_LIVE_CODEX === "1") {
      liveActive = true;
      liveReportPath = join(artifactDir, "windows-live-copilot.json");
      report.liveEvidence = liveReportPath;
      report.modelExecution = "Deterministic CLI fixture plus opt-in real Codex turns through the installed Windows worker; see live evidence for completed turns and results";
      const { runWindowsLiveCopilot } = await import("./windows-live-copilot.mjs");
      const live = await runWindowsLiveCopilot({ page, workspace, userData, baseUrl, ownerCookie, artifactDir, server,
        restartApp: async () => {
          await electronApp.close(); electronApp = undefined; page = undefined;
          // The fixture must use an empty PATH, while real Codex may require
          // ordinary system tools. This only changes this isolated child app.
          appEnv.PATH = Object.entries(process.env).find(([key]) => /^path$/i.test(key))?.[1] ?? "";
          await launchApp();
          return page;
        },
      });
      page = live.page;
      liveReportPath = live.reportPath;
      check("Opt-in real provider chat, discussion, plan review and acceptance verified through the installed worker");
    }
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connect this computer" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.artooDesktop.getToken()), null);
    assert.equal((await page.evaluate(() => window.artooDesktop.daemonStatus())).config.codex.hasKey, false);
    assert.equal(JSON.parse(readFileSync(join(userData, "connection.json"), "utf8")).encryptedCodexApiKey, null);
    assert.equal((await fetch(`${baseUrl}/auth/session`, { headers: { Authorization: `Bearer ${nativeToken}` } })).status, 401);
    await electronApp.close(); electronApp = undefined; page = undefined;
    uninstall(); await until(() => !existsSync(appExe), "NSIS uninstall left the app executable", 30_000); uninstalled = true;
    check("Sign out clears credentials and revokes access; NSIS uninstall removes the app");
    Object.assign(report, { result: "pass", screenshot: join(artifactDir, "windows-desktop-smoke.png"), downloaded });
  } catch (error) {
    executionError = liveActive ? new Error("Installed live verification or its logout/uninstall failed; consult the sanitized live report for the last completed stage") : error;
    report.error = executionError instanceof Error ? executionError.message : String(executionError);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifactDir, "windows-desktop-smoke-failure.png"), fullPage: false, timeout: 5000 }).catch(() => console.error("[smoke] Failure screenshot unavailable"));
      if (!liveActive) console.error(`[smoke] Visible app state:\n${await page.locator("body").innerText().catch(() => "unavailable")}`);
    }
  } finally {
    const cleanup = { app_closed: !electronApp, browser_closed: !browser, server_closed: !server, uninstalled, temporary_directory_removed: false };
    for (const [key, resource] of [["app_closed", electronApp], ["browser_closed", browser], ["server_closed", server]]) {
      if (!resource) continue;
      try { await bounded(resource.close(), key, 30_000); cleanup[key] = true; }
      catch { console.warn(`[smoke] Cleanup failed: ${key}`); }
    }
    if (!uninstalled) {
      try { uninstall(); if (appExe) await until(() => !existsSync(appExe), "Cleanup uninstall did not finish", 30_000); cleanup.uninstalled = true; }
      catch { console.warn("[smoke] Cleanup uninstall failed"); }
    }
    try { await removeTemp(tempRoot); cleanup.temporary_directory_removed = !existsSync(tempRoot); }
    catch { console.warn("[smoke] Smoke temporary directory cleanup failed"); }
    report.cleanup = cleanup;
    report.cleanup_complete = Object.values(cleanup).every(Boolean);
    if (!report.cleanup_complete) {
      report.result = "fail";
      report.error ??= "Installed smoke cleanup did not complete";
      executionError ??= new Error(report.error);
    }
    if (liveReportPath && existsSync(liveReportPath)) {
      try {
        const liveReport = JSON.parse(readFileSync(liveReportPath, "utf8"));
        liveReport.cleanup_complete = report.cleanup_complete;
        liveReport.cleanup = cleanup;
        if (report.result !== "pass") { liveReport.result = "fail"; liveReport.error ??= report.error; }
        writeFileSync(liveReportPath, `${JSON.stringify(liveReport, null, 2)}\n`);
      } catch {
        report.result = "fail";
        report.error = "Could not finalize installed live verification cleanup evidence";
        executionError ??= new Error(report.error);
      }
    }
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(artifactDir, "windows-desktop-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  }
  if (executionError) throw executionError;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
