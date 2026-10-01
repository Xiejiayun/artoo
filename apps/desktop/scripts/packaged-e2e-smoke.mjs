import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { _electron as electron, chromium } from "playwright";
import { expect } from "@playwright/test";
import { getE2EReportContext, writeE2EReport } from "../../../scripts/e2e-report.mjs";
import { closeOwnedBrowser } from "../../../scripts/owned-browser.mjs";
import { buildMacDistribution } from "./mac-distribution.mjs";
import { mountPreviewDmg } from "./mac-dmg-install.mjs";
import { finalizeInstalledLiveProviderEvidence, installedLiveProviderEvidence, runOptionalInstalledLiveProvider } from "./installed-live-provider-gate.mjs";
import { macPlanningImageNames, runInstalledMacPlanning } from "./installed-mac-planning.mjs";
import { macAssistantImageNames, runInstalledMacAssistant } from "./installed-mac-assistant.mjs";
import { macMentionsImageNames, runInstalledMacMentions } from "./installed-mac-mentions.mjs";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDir, "..", "..");
const fixturePatch = "diff --git a/preview.txt b/preview.txt\nnew file mode 100644\n--- /dev/null\n+++ b/preview.txt\n@@ -0,0 +1 @@\n+Packaged authenticated execution verified\n";

// Return an error instead of throwing so the caller still writes its final
// JSON, self-contained HTML and immutable history on a failed source boundary.
export function finalizePackagedSmokeSource(report, sourceAtFinish) {
  report.source_at_finish = sourceAtFinish;
  const complete = (source) => source && typeof source.commit === "string" && source.commit.length > 0
    && /^[a-f0-9]{64}$/.test(source.tracked_diff_sha256 ?? "")
    && /^[a-f0-9]{64}$/.test(source.untracked_source_sha256 ?? "") && source.untracked_source_complete === true;
  report.source_stable = !!complete(report.source) && !!complete(sourceAtFinish) && isDeepStrictEqual(report.source, sourceAtFinish);
  if (report.source_stable) return;
  const error = new Error("Packaged smoke source changed or could not be fully verified during this invocation");
  report.result = "fail"; report.passed = false; report.error ??= error.message;
  return error;
}

function run(command, args, timeout = 300_000) {
  console.log(`[smoke] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: repoRoot, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" }, stdio: "inherit", windowsHide: true, timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}
function runNpm(args) {
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")].find((path) => path && existsSync(path));
  if (!cli) throw new Error("Run through the desktop npm smoke command to supply npm's CLI path");
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
  assert.ok(canonical.startsWith(`${realpathSync(tmpdir())}${sep}artoo-desktop-smoke-`), "Refusing cleanup outside the smoke temporary directory");
  await until(() => { try { rmSync(canonical, { recursive: true, force: true }); return !existsSync(canonical); } catch { return false; } }, "Smoke temporary files remained locked", 15_000);
}

export async function runPackagedSmoke(platform, { macDistribution } = {}) {
  const isMac = platform === "darwin";
  const fromDmg = macDistribution === "dmg";
  const label = isMac ? (fromDmg ? "macos-dmg" : "macos") : "windows";
  const platformName = isMac ? "macOS" : "Windows";
  const artifactDir = process.env.ARTOO_DESKTOP_REPORT_DIR
    ? resolve(process.env.ARTOO_DESKTOP_REPORT_DIR)
    : join(desktopDir, "release", isMac ? (fromDmg ? "mac-dmg-smoke-artifacts" : "mac-smoke-artifacts") : "smoke-artifacts");
  const jsonPath = join(artifactDir, `${label}-desktop-smoke.json`);
  const htmlPath = join(artifactDir, `${label}-desktop-smoke.html`);
  const liveEvidence = installedLiveProviderEvidence(platform, artifactDir);
  const screenshots = [];
  const checks = [];
  const captures = [];
  const startedAt = new Date().toISOString();
  const runId = startedAt.replaceAll(/[:.]/g, "-");
  const report = { ...getE2EReportContext(), result: "fail", passed: false, platform, architecture: process.arch,
    checkedAt: startedAt, started_at: startedAt, run_id: runId, checks, captures, screenshots,
    package_reused: !fromDmg && process.env.ARTOO_SMOKE_SKIP_BUILD === "1",
    package_provenance: fromDmg ? "DMG and ZIP built during this invocation; the app is installed from that verified, read-only mounted DMG" : process.env.ARTOO_SMOKE_SKIP_BUILD === "1" ? "Existing package; recorded source identifies the test harness and does not prove the package was built from this revision" : "Package built from the working tree during this invocation",
    scope: `${platformName} packaged app: pairing, authenticated realtime, worker lifecycle, task execution, artifact download, review and restart recovery${isMac ? ", process-backed planning, coordinator instruction disclosure, human plan acceptance, direct-assistant waiting/retry/cancellation, and cross-project historical mentions with read recovery and draft persistence" : ""}`,
    cleanup_complete: false,
    distribution: isMac ? (fromDmg ? "Unsigned preview DMG installed in an isolated directory; no Developer ID, notarization or Gatekeeper trust claim" : "Unsigned packaged .app copied to an isolated installation; signing, notarization and updates are separate release gates") : "NSIS installed package",
    modelExecution: "Temporary CLI fixture through production Codex adapter; no real model quality claim",
    ownerAuthentication: "Test-provisioned owner cookie; native pairing and authorization use production endpoints" };
  mkdirSync(artifactDir, { recursive: true });
  for (const filename of [`${label}-desktop-smoke.json`, `${label}-desktop-smoke.html`, `${label}-desktop-smoke.png`, `${label}-desktop-smoke-failure.png`, `${label}-artifact.patch`, `${label}-artifact-after-restart.patch`, `${label}-desktop-connect.png`, `${label}-desktop-worker.png`, `${label}-desktop-restored.png`, `${label}-desktop-approval-needs-info.png`, `${label}-desktop-approval-replaced.png`, ...(!isMac ? ["windows-live-copilot.json", "windows-live-copilot-plan.png"] : [])]) {
    rmSync(join(artifactDir, filename), { force: true });
  }
  for (const path of [liveEvidence.reportPath, liveEvidence.planScreenshotPath, liveEvidence.chatScreenshotPath]) rmSync(path, { force: true });
  if (isMac) for (const filename of [...macPlanningImageNames, ...macAssistantImageNames, ...macMentionsImageNames]) rmSync(join(artifactDir, filename), { force: true });
  // Record build/preflight failures too; every invocation owns an HTML report.
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeE2EReport({ outputPath: htmlPath, title: `Artoo ${platformName} packaged E2E`, report, screenshots });
  let tempRoot, installDir, userData, workspace, fixtureBin, fixtureProgram, fixtureKey, installer, packagedApp, planningConfigurationPath, assistantConfigurationPath;
  let server, browser, browserServer, electronApp, page, appExe, ownerCookie;
  let liveReportPath, executionError, observeAssistantCleanup;
  let dmgMount;
  let liveActive = false;
  let uninstalled = false;
  let rendererCrashed = false;
  let baseUrl, serverEnv, appEnv, startServer, createSession;
  const check = (description) => { checks.push(description); console.log(`[smoke] PASS ${description}`); };
  function uninstall() {
    if (!appExe || !existsSync(appExe)) return;
    if (isMac) { rmSync(join(installDir, "Artoo.app"), { recursive: true, force: true }); return; }
    const uninstaller = findFirst(installDir, (name) => /^Uninstall .*\.exe$/i.test(name));
    assert.ok(uninstaller, "Installed app has no uninstaller"); run(uninstaller, ["/S"], 120_000);
  }
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
  async function captureScene(filename, caption) {
    const path = join(artifactDir, filename);
    await page.screenshot({ path, fullPage: false, animations: "disabled", timeout: 30_000 });
    screenshots.push({ path, caption });
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
        screenshots.push({ path: screenshotPath, caption: "Completed task with approved execution, downloaded artifact and accepted review" });
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
  try {
    assert.equal(process.platform, platform, `The packaged smoke must run on ${platformName}`);
    assert.ok(["darwin", "win32"].includes(platform), "Unsupported desktop platform");
    assert.ok(macDistribution === undefined || (isMac && fromDmg), "DMG installation is available only in the Mac DMG smoke");
    if (fromDmg) assert.notEqual(process.env.ARTOO_SMOKE_SKIP_BUILD, "1", "DMG smoke must build a fresh distribution; ARTOO_SMOKE_SKIP_BUILD is not permitted");
    runNpm(["run", "build", "--workspace", "@artoo/server"]);
    if (!fromDmg && process.env.ARTOO_SMOKE_SKIP_BUILD !== "1") runNpm(["run", isMac ? "pack:mac" : "dist:win", "--workspace", "@artoo/desktop"]);
    if (isMac) {
      if (fromDmg) {
        const distribution = buildMacDistribution({ mode: "preview" });
        const artifact = distribution.files.find((file) => file.kind === "dmg");
        report.distribution_artifacts = distribution.files;
        report.distribution_manifest = distribution.manifestPath;
        dmgMount = mountPreviewDmg(artifact, { onCreated: (mount) => {
          dmgMount = mount;
          report.dmg_installation = { artifact_sha256: artifact.sha256, mounted_read_only: false, mountpoint: mount.mountpoint };
        } });
        packagedApp = dmgMount.app;
        report.dmg_installation = { artifact_sha256: artifact.sha256, mounted_read_only: true, mountpoint: dmgMount.mountpoint };
        check("This invocation built DMG/ZIP; the exact DMG hash is verified and mounted read-only");
      } else {
        const candidates = [join(desktopDir, "release", process.arch === "arm64" ? "mac-arm64" : "mac", "Artoo.app")];
        packagedApp = candidates.find((candidate) => existsSync(join(candidate, "Contents", "MacOS", "Artoo")));
        assert.ok(packagedApp, "Build pack:mac for this architecture before using ARTOO_SMOKE_SKIP_BUILD=1");
      }
      report.package = packagedApp;
      report.packageAsarSha256 = createHash("sha256").update(readFileSync(join(packagedApp, "Contents", "Resources", "app.asar"))).digest("hex");
      report.packageDaemonSha256 = createHash("sha256").update(readFileSync(join(packagedApp, "Contents", "Resources", "app.asar.unpacked", "daemon", "artood.mjs"))).digest("hex");
    } else {
      const { version } = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
      installer = join(desktopDir, "release", `Artoo Setup ${version}.exe`);
      assert.ok(existsSync(installer), "Build the current version's NSIS installer before using ARTOO_SMOKE_SKIP_BUILD=1");
      report.installer = installer;
      report.installerSha256 = createHash("sha256").update(readFileSync(installer)).digest("hex");
    }
    // macOS /var is a symlink to /private/var; use the same canonical roots as
    // the controller so saved workspace verification compares actual paths.
    tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "artoo-desktop-smoke-")));
    installDir = join(tempRoot, "install"); userData = join(tempRoot, "desktop-data");
    workspace = join(tempRoot, "workspace"); fixtureBin = join(tempRoot, "fixture-bin");
    fixtureKey = randomBytes(24).toString("hex");
    fixtureProgram = join(fixtureBin, isMac ? "codex" : "codex.cmd");
    if (isMac) {
      planningConfigurationPath = join(tempRoot, "mac-planning-process.json");
      assistantConfigurationPath = join(tempRoot, "mac-assistant-process.json");
    }
    mkdirSync(workspace); mkdirSync(fixtureBin);
    // Only this absolute CLI fixture is selected. On macOS the shell launcher
    // uses the installed Electron in Node mode; no Node or model CLI needs PATH.
    const fixtureEntry = join(fixtureBin, "fixture-codex.mjs");
    if (isMac) {
      const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
      writeFileSync(fixtureProgram, `#!/bin/sh\nexec "$ARTOO_SMOKE_EXECUTABLE" ${quote(fixtureEntry)} "$@"\n`);
      chmodSync(fixtureProgram, 0o755);
    } else writeFileSync(fixtureProgram, '@ECHO off\r\n"%_prog%" "%dp0%\\fixture-codex.mjs" %*\r\n');
    writeFileSync(fixtureEntry, `import {readFileSync,writeFileSync} from 'node:fs';
if (process.env.ARTOO_CODEX_PROVIDER_KEY !== ${JSON.stringify(fixtureKey)}) throw new Error('Configured fixture key did not reach CLI');
${isMac ? `const source = readFileSync('context_pack.md', 'utf8'), marker = '## Raw Payload\\n';
if (!source.includes(marker)) throw new Error('Installed fixture is missing its actual context pack');
const pack = JSON.parse(source.slice(source.indexOf(marker) + marker.length));
if (pack.conversation) {
  if (pack.policy.execution_mode === 'discussion') {
    const {runMacPlanningFixture} = await import(${JSON.stringify(pathToFileURL(join(desktopDir, "scripts/mac-planning-fixture.mjs")).href)});
    runMacPlanningFixture({contextPath:'context_pack.md',configurationPath:${JSON.stringify(planningConfigurationPath)}});
  } else {
    const {runAssistantConversationFixture} = await import(${JSON.stringify(pathToFileURL(join(desktopDir, "../../scripts/fixtures/assistant-conversation.mjs")).href)});
    await runAssistantConversationFixture({contextPath:'context_pack.md',configurationPath:${JSON.stringify(assistantConfigurationPath)}});
  }
} else {` : ""}
writeFileSync('changes.patch', ${JSON.stringify(fixturePatch)});
writeFileSync('fixture-execution.json', JSON.stringify({argv:process.argv.slice(2), executable:process.execPath, cwd:process.cwd(), apiKeyConfigured:true}));
console.error('Diagnostic key: ' + process.env.ARTOO_CODEX_PROVIDER_KEY);
console.log('Packaged Codex adapter fixture completed');
${isMac ? "}" : ""}
`);
    const port = await freePort(); baseUrl = `http://127.0.0.1:${port}`;
    serverEnv = {
      NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", ARTOO_PORT: String(port),
      ARTOO_DATA_DIR: join(tempRoot, "server-data"), ARTOO_WORKSPACE_ROOT: workspace,
      ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"), ARTOO_DESKTOP_CORS: "1",
      ARTOO_WEB_DIST: join(repoRoot, "apps/web/dist"),
      GOOGLE_CLIENT_ID: "smoke-oidc-client", GOOGLE_CLIENT_SECRET: "smoke-unused-secret",
      GOOGLE_REDIRECT_URI: `${baseUrl}/auth/google/callback`,
      AUTH_ALLOWED_EMAILS: isMac ? "owner@preview.test,sender@mentions-ui.test" : "owner@preview.test", AUTH_OWNER_EMAILS: "owner@preview.test",
    };
    appEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$|^electron_run_as_node$/i.test(key)));
    // Only the absolute program selected through Settings may execute. Empty PATH
    // prevents a regression from accidentally invoking an installed live model CLI.
    Object.assign(appEnv, { PATH: "", ARTOO_DESKTOP_DATA_DIR: userData, ARTOO_SERVER_URL: baseUrl,
      ARTOO_CODEX_PROVIDER_KEY: "inherited-fixture-key-must-not-win" });
    ({ startServer } = await import(pathToFileURL(join(repoRoot, "apps/server/dist/main.js")).href));
    ({ createSession } = await import(pathToFileURL(join(repoRoot, "apps/server/dist/auth/auth-service.js")).href));
    server = await startServer(serverEnv);
    assert.equal(server.persistent, true);
    assert.equal((await fetch(`${baseUrl}/api/v1/bootstrap`)).status, 401);
    assert.equal(server.ctx.deviceAuth.devControlEscape, false); assert.equal(server.ctx.deviceAuth.devNodeToken, null);
    // Only the Web owner cookie is provisioned directly. Native credentials,
    // enrollment, task writes, and worker management all go through actual UI.
    const session = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    ownerCookie = `artoo_session=${session.raw}`;
    const chromiumChannel = process.env.ARTOO_CHROMIUM_CHANNEL?.trim() || undefined;
    browserServer = await chromium.launchServer({ headless: true, host: "127.0.0.1", ...(chromiumChannel ? { channel: chromiumChannel } : {}) });
    browser = await chromium.connect(browserServer.wsEndpoint());
    report.browser = { channel: chromiumChannel ?? "playwright-chromium", version: browser.version() };
    const owner = await browser.newContext();
    await owner.addCookies([{ name: "artoo_session", value: session.raw, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
    const ownerPage = await owner.newPage(); await ownerPage.goto(`${baseUrl}/settings`);
    await ownerPage.getByLabel("Device platform").selectOption(isMac ? "macos" : "windows");
    await ownerPage.getByRole("button", { name: "Generate pairing code" }).click();
    const pairingRegion = ownerPage.getByRole("region", { name: "Device pairing" });
    await expect(pairingRegion.locator("strong")).toBeVisible();
    const pairingCode = await pairingRegion.locator("strong").textContent();
    check("Production auth required; owner creates a real one-use pairing code");

    if (isMac) {
      mkdirSync(installDir);
      cpSync(packagedApp, join(installDir, "Artoo.app"), { recursive: true, verbatimSymlinks: true });
      appExe = join(installDir, "Artoo.app", "Contents", "MacOS", "Artoo");
      appEnv.ARTOO_SMOKE_EXECUTABLE = appExe;
      if (dmgMount) {
        for (const [path, hash] of [["app.asar", report.packageAsarSha256], ["app.asar.unpacked/daemon/artood.mjs", report.packageDaemonSha256]]) {
          assert.equal(createHash("sha256").update(readFileSync(join(installDir, "Artoo.app", "Contents", "Resources", path))).digest("hex"), hash, "Installed app bytes differ from the mounted DMG");
        }
        dmgMount.detach();
        report.dmg_installation.detached_before_launch = true;
        check("Installed app and daemon match the DMG; its volume is detached before the complete business workflow starts");
      }
    } else {
      run(installer, ["/S", `/D=${installDir}`], 180_000);
      appExe = findFirst(installDir, (name) => /^Artoo\.exe$/i.test(name));
      assert.ok(appExe, "NSIS did not install Artoo.exe");
    }
    const resources = isMac ? join(installDir, "Artoo.app", "Contents", "Resources") : join(installDir, "resources");
    assert.ok(existsSync(join(resources, "app.asar.unpacked/daemon/artood.mjs")), "Bundled daemon missing");
    await launchApp();
    await expect(page.getByRole("heading", { name: "Connect this computer" })).toBeVisible();
    const packagedRenderer = await page.evaluate(() => ({
      url: window.location.href, platform: window.artooDesktop.platform,
      electronVersion: window.artooDesktop.electronVersion,
      serverUrl: window.artooDesktop.serverUrl,
      css: Array.from(document.styleSheets).filter((sheet) => sheet.href).map((sheet) => ({ href: sheet.href, rules: sheet.cssRules.length })),
      nodeIntegration: typeof window.require !== "undefined" || typeof window.process !== "undefined",
    }));
    assert.equal(packagedRenderer.platform, platform);
    assert.equal(packagedRenderer.serverUrl, baseUrl);
    assert.match(packagedRenderer.electronVersion, /^\d+\./);
    assert.match(packagedRenderer.url, /^file:.*app\.asar\/renderer\/index\.html/);
    assert.ok(packagedRenderer.css.some((sheet) => sheet.href.includes("app.asar/renderer/") && sheet.rules > 0), "Packaged renderer CSS did not load");
    assert.equal(packagedRenderer.nodeIntegration, false, "Renderer exposes Node.js");
    report.renderer = packagedRenderer;
    check("Renderer and styles load from app.asar; native platform bridge works with renderer Node integration disabled");
    await captureScene(`${label}-desktop-connect.png`, "Packaged native app ready for secure device pairing");
    await page.getByLabel("Server address").fill(baseUrl);
    await page.getByLabel("Device name").fill(`Packaged ${platformName} smoke`);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByRole("button", { name: "Pair this computer" }).click();
    await expect(page.getByRole("link", { name: "Workspace", exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Live updates connected", { exact: true })).toBeVisible();
    const connection = await page.evaluate(() => window.artooDesktop.getConnection());
    assert.equal(connection.paired, true); assert.ok(connection.computerId);
    const nativeToken = await page.evaluate(() => window.artooDesktop.getToken());
    assert.equal(readFileSync(join(userData, "connection.json"), "utf8").includes(nativeToken), false, "Native credential persisted in plaintext");
    assert.equal(await page.evaluate((token) => Object.values(localStorage).some((value) => value.includes(token)), nativeToken), false);
    check(`${platformName} packaged app pairs and enrolls through UI; native REST/realtime authenticate; credential encrypted at rest`);

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
    await captureScene(`${label}-desktop-worker.png`, "Paired computer with saved worker settings after start, restart and stop verification");

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
    const assignButton = page.getByRole("button", { name: "Assign", exact: true });
    const assertApprovalHold = async (status, reason) => {
      await expect(assignButton).toBeDisabled();
      await expect(assignButton).toHaveAccessibleDescription(reason);
      const snapshot = await ownerApi(`/api/v1/tasks/${taskId}`);
      assert.equal(snapshot.task.status, "ready");
      assert.equal(snapshot.runs.length, 0, "An approval decision must not start execution");
      const gates = snapshot.approvals.filter((approval) => approval.action === "execution.start" && approval.payload_ref === "execution-gate/current");
      assert.equal(gates.length, 1); assert.equal(gates[0].status, status); assert.equal(gates[0].run_id, null);
      return gates[0];
    };
    const initialApproval = await assertApprovalHold("pending", /Execution approval is pending/);
    await page.getByRole("button", { name: "Need info", exact: true }).click();
    assert.equal((await assertApprovalHold("needs_more_info", /Execution approval needs more information/)).id, initialApproval.id);
    await assignButton.scrollIntoViewIfNeeded();
    await captureScene(`${label}-desktop-approval-needs-info.png`, "Assignment remains disabled while the current execution review needs more information");
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    assert.equal((await assertApprovalHold("rejected", /Execution approval was rejected/)).id, initialApproval.id);
    await page.getByLabel("Execution approval summary").fill("Scope clarified: execute only the fixture and upload its patch for review");
    await page.getByRole("button", { name: "Request execution approval", exact: true }).click();
    const replacement = await assertApprovalHold("pending", /Execution approval is pending/);
    assert.notEqual(replacement.id, initialApproval.id);
    const replaced = await ownerApi(`/api/v1/tasks/${taskId}`);
    assert.equal(replaced.approvals.length, 2);
    assert.equal(replaced.approvals.find((approval) => approval.id === initialApproval.id).payload_ref, "execution-gate/superseded");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expect(assignButton).toBeEnabled();
    const approved = await ownerApi(`/api/v1/tasks/${taskId}`);
    assert.equal(approved.task.status, "ready"); assert.equal(approved.runs.length, 0);
    assert.equal(approved.approvals.find((approval) => approval.id === replacement.id).status, "approved");
    assert.equal(approved.approvals.find((approval) => approval.id === replacement.id).run_id, null);
    report.execution_approval = { original_id: initialApproval.id, current_id: replacement.id, verified_states: ["pending", "needs_more_info", "rejected", "replacement_pending", "approved"], runs_before_assignment: 0 };
    await assignButton.scrollIntoViewIfNeeded();
    await captureScene(`${label}-desktop-approval-replaced.png`, "A new approved execution review enables assignment; the earlier rejected request remains history");
    check("Execution approval states disable assignment with a reason; only the approved replacement enables a user-initiated execution");
    await assignButton.click();
    await until(async () => {
      const snapshot = await ownerApi(`/api/v1/tasks/${taskId}`);
      if (snapshot.task.status === "blocked") throw new Error(`Fixture run blocked: ${JSON.stringify(snapshot.runs.map((run) => ({ status: run.status, summary: run.summary })))}`);
      return snapshot.task.status === "review";
    }, "The packaged worker did not deliver a reviewable task", 60_000);
    const executed = await ownerApi(`/api/v1/tasks/${taskId}`);
    assert.equal(executed.runs.length, 1);
    assert.equal(executed.approvals.find((approval) => approval.id === replacement.id).run_id, executed.runs[0].id);
    assert.equal(executed.approvals.find((approval) => approval.id === initialApproval.id).run_id, null);
    report.execution_approval.run_id = executed.runs[0].id;
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
    assert.equal(await page.locator(".pane").evaluateAll((panes) => panes.every((pane) => pane.scrollWidth <= pane.clientWidth + 1)), true, "A workspace pane overflows horizontally with real generated identifiers");
    const execution = JSON.parse(readFileSync(join(workspace, "fixture-execution.json"), "utf8"));
    assert.equal(realpathSync(execution.executable).toLowerCase(), realpathSync(appExe).toLowerCase(), "CLI did not run through packaged Electron");
    assert.equal(execution.argv[0], "exec", "Ordinary Codex command arguments were not used");
    assert.equal(execution.apiKeyConfigured, true);
    assert.ok(execution.argv.includes('model="smoke-model"'));
    assert.ok(execution.argv.includes('model_provider="artoo_desktop"'));
    assert.ok(execution.argv.includes('model_providers.artoo_desktop.env_key="ARTOO_CODEX_PROVIDER_KEY"'));
    assert.equal(JSON.stringify(execution).includes(fixtureKey), false, "Provider key exposed in CLI arguments");
    await expect(page.locator(".run-output")).toContainText("Diagnostic key: [redacted]");
    assert.equal((await page.locator(".run-output").textContent()).includes(fixtureKey), false, "Provider key exposed in runtime output");
    check("Local Responses settings select an absolute CLI with empty PATH; key encrypted, private in argv/status and redacted from runtime output");
    const downloaded = await downloadPatch(`${label}-artifact.patch`);
    await page.getByLabel("Review comment", { exact: true }).fill("Downloaded patch bytes verified by packaged authenticated smoke");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.locator(".task-detail__header .ui-badge--status")).toHaveText("done");
    await captureEvidence(`${label}-desktop-smoke.png`, taskId);
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
    await downloadPatch(`${label}-artifact-after-restart.patch`);
    check("App/server restart preserve device identity, worker settings, reviewed task, and downloadable artifact");
    await captureScene(`${label}-desktop-restored.png`, "Completed task and downloadable artifact restored after app and server restart");
    if (isMac) {
      await runInstalledMacPlanning({ page, workspace, configurationPath: planningConfigurationPath, baseUrl, ownerCookie, artifactDir,
        onEvidence: (evidence) => { report.macPlanning = evidence; },
        onScreenshot: (screenshot) => screenshots.push(screenshot),
      });
      check("Installed Mac UI verifies three worker planning contributions, summarized/exact coordinator instructions, and human acceptance of two dependent tasks");
      await runInstalledMacAssistant({ page, workspace, configurationPath: assistantConfigurationPath, baseUrl, ownerCookie, artifactDir,
        onEvidence: (evidence) => { report.macAssistant = evidence; },
        onScreenshot: (screenshot) => screenshots.push(screenshot),
        onCleanupObserver: (observe) => { observeAssistantCleanup = observe; },
      });
      check("Installed Mac direct requests verify automatic worker recovery, explicit failed-turn Retry, two context-linked answers, and running-process cancellation");
      await runInstalledMacMentions({ page, root: repoRoot, server, browser, baseUrl, ownerCookie, artifactDir,
        onEvidence: (evidence) => { report.macMentions = evidence; },
        onScreenshot: (screenshot) => screenshots.push(screenshot),
      });
      check("Installed Mac opens late-created project mentions, retries one failed read through UI, preserves both drafts and leaves an unrelated notification unread");
    }
    const live = await runOptionalInstalledLiveProvider({ platform, page, workspace, userData, baseUrl, ownerCookie, artifactDir, server,
      onStart: (plan) => {
        liveActive = true;
        liveReportPath = plan.reportPath;
        report.liveEvidence = liveReportPath;
        report.liveScope = plan.scope;
        report.liveVerified = false;
        report.modelExecution = `Deterministic CLI fixture completed; real Codex ${plan.scope} verification requested through the installed ${platformName} worker. See liveVerified and the live evidence for its outcome.`;
      },
      onScreenshot: (screenshot) => screenshots.push(screenshot),
      restartApp: async () => {
        await electronApp.close(); electronApp = undefined; page = undefined;
        // The fixture must use an empty PATH, while real Codex may require
        // ordinary system tools. This only changes this isolated child app.
        appEnv.PATH = Object.entries(process.env).find(([key]) => /^path$/i.test(key))?.[1] ?? "";
        await launchApp();
        return page;
      },
    });
    if (live) {
      page = live.page;
      liveReportPath = live.reportPath;
      report.liveVerified = true;
      report.modelExecution = report.liveScope === "discussion"
        ? `Deterministic CLI fixture plus a completed real Codex planning discussion through the installed ${platformName} worker; conversational chat turns are excluded from this run`
        : `Deterministic CLI fixture plus completed real Codex chat and planning discussion through the installed ${platformName} worker; see live evidence for completed turns and results`;
      check(report.liveScope === "discussion"
        ? "Targeted real provider discussion, plan review and acceptance verified through the installed worker; chat turns excluded from this run"
        : "Opt-in real provider chat, discussion, plan review and acceptance verified through the installed worker");
    }
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connect this computer" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.artooDesktop.getToken()), null);
    assert.equal((await page.evaluate(() => window.artooDesktop.daemonStatus())).config.codex.hasKey, false);
    assert.equal(JSON.parse(readFileSync(join(userData, "connection.json"), "utf8")).encryptedCodexApiKey, null);
    assert.equal((await fetch(`${baseUrl}/auth/session`, { headers: { Authorization: `Bearer ${nativeToken}` } })).status, 401);
    await electronApp.close(); electronApp = undefined; page = undefined;
    uninstall(); await until(() => !existsSync(appExe), "Package removal left the app executable", 30_000); uninstalled = true;
    check(`Sign out clears credentials and revokes access; ${isMac ? "isolated .app removal" : "NSIS uninstall"} removes the app`);
    Object.assign(report, { result: "pass", screenshot: join(artifactDir, `${label}-desktop-smoke.png`), downloaded });
  } catch (error) {
    executionError = liveActive ? new Error("Installed live verification or its logout/uninstall failed; consult the sanitized live report for the last completed stage") : error;
    report.error = executionError instanceof Error ? executionError.message : String(executionError);
    if (page && !page.isClosed()) {
      const failurePath = join(artifactDir, `${label}-desktop-smoke-failure.png`);
      await page.screenshot({ path: failurePath, fullPage: false, timeout: 5000,
        mask: [page.getByLabel("Pairing code", { exact: true }), page.getByLabel("Model API key", { exact: true })] })
        .then(() => screenshots.push({ path: failurePath, caption: "App state at the failing E2E step" }))
        .catch(() => console.error("[smoke] Failure screenshot unavailable"));
      if (!liveActive) console.error(`[smoke] Visible app state:\n${await page.locator("body").innerText().catch(() => "unavailable")}`);
    }
  } finally {
    const cleanup = { app_closed: !electronApp, browser_closed: !browserServer, server_closed: !server, uninstalled: uninstalled || !appExe, temporary_directory_removed: !tempRoot };
    if (fromDmg) {
      try { dmgMount?.detach(); cleanup.dmg_detached = !dmgMount || dmgMount.detached; }
      catch { cleanup.dmg_detached = false; console.warn("[smoke] Owned DMG detach failed"); }
    }
    for (const [key, resource] of [["app_closed", electronApp], ["server_closed", server]]) {
      if (!resource) continue;
      try { await bounded(resource.close(), key, 30_000); cleanup[key] = true; }
      catch { console.warn(`[smoke] Cleanup failed: ${key}`); }
    }
    if (observeAssistantCleanup) {
      try { report.mac_assistant_cleanup = await observeAssistantCleanup(); }
      catch { report.mac_assistant_cleanup = { closed: false, error: "Assistant PID observation failed" }; }
      cleanup.assistant_processes_closed = report.mac_assistant_cleanup.closed === true;
    }
    if (browserServer) {
      report.browser_cleanup = await closeOwnedBrowser(browserServer);
      cleanup.browser_closed = report.browser_cleanup.closed;
      console.log(`[smoke] Browser cleanup: ${report.browser_cleanup.method}, exit confirmed: ${cleanup.browser_closed}`);
    }
    if (appExe && !uninstalled) {
      try { uninstall(); if (appExe) await until(() => !existsSync(appExe), "Cleanup uninstall did not finish", 30_000); cleanup.uninstalled = true; }
      catch { console.warn("[smoke] Cleanup uninstall failed"); }
    }
    try { if (tempRoot) await removeTemp(tempRoot); cleanup.temporary_directory_removed = !tempRoot || !existsSync(tempRoot); }
    catch { console.warn("[smoke] Smoke temporary directory cleanup failed"); }
    report.cleanup = cleanup;
    report.cleanup_complete = Object.values(cleanup).every(Boolean);
    if (!report.cleanup_complete) {
      report.result = "fail";
      report.error ??= "Installed smoke cleanup did not complete";
      executionError ??= new Error(report.error);
    }
    const sourceError = finalizePackagedSmokeSource(report, getE2EReportContext().source);
    executionError ??= sourceError;
    if (liveReportPath) {
      try {
        report.liveEvidenceSnapshot = finalizeInstalledLiveProviderEvidence(liveReportPath, report);
      } catch {
        report.result = "fail";
        report.live_evidence_finalization_error = "Could not finalize installed live verification cleanup evidence";
        report.error ??= report.live_evidence_finalization_error;
        executionError ??= new Error(report.error);
      }
    }
    report.finishedAt = new Date().toISOString();
    report.finished_at = report.finishedAt;
    report.passed = report.result === "pass";
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    writeE2EReport({ outputPath: htmlPath, title: `Artoo ${platformName} packaged E2E`, report, screenshots });
    const history = join(artifactDir, "history");
    mkdirSync(history, { recursive: true });
    cpSync(htmlPath, join(history, `${label}-${runId}.html`));
    cpSync(jsonPath, join(history, `${label}-${runId}.json`));
    console.log(`[smoke] HTML report: ${htmlPath}`);
    console.log(JSON.stringify(report, null, 2));
  }
  if (executionError) throw executionError;
}
