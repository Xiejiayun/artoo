import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
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
  try { await until(() => { try { rmSync(canonical, { recursive: true, force: true }); return true; } catch { return false; } }, "Temp files remained locked", 15_000); }
  catch { console.warn(`[smoke] Temporary files remain at ${canonical}`); }
}

async function main() {
  assert.equal(process.platform, "win32", "The packaged smoke must run on Windows");
  mkdirSync(artifactDir, { recursive: true });
  for (const filename of ["windows-desktop-smoke.json", "windows-desktop-smoke.png", "windows-desktop-smoke-failure.png", "windows-artifact.patch", "windows-artifact-after-restart.patch"]) {
    rmSync(join(artifactDir, filename), { force: true });
  }
  runNpm(["run", "build", "--workspace", "@artoo/server"]);
  if (process.env.ARTOO_SMOKE_SKIP_BUILD !== "1") runNpm(["run", "dist:win", "--workspace", "@artoo/desktop"]);
  const installer = findFirst(join(desktopDir, "release"), (name) => /^Artoo Setup .*\.exe$/i.test(name));
  assert.ok(installer, "Build an NSIS installer before using ARTOO_SMOKE_SKIP_BUILD=1");
  const tempRoot = mkdtempSync(join(tmpdir(), "artoo-desktop-smoke-"));
  const installDir = join(tempRoot, "install"), userData = join(tempRoot, "desktop-data");
  const workspace = join(tempRoot, "workspace"), fixtureBin = join(tempRoot, "fixture-bin");
  mkdirSync(artifactDir, { recursive: true }); mkdirSync(workspace); mkdirSync(fixtureBin);
  // npm-shaped fixture exercises ordinary Codex resolution and the real bundled
  // worker. No model/network subscription, mock adapter, or dev route is used.
  writeFileSync(join(fixtureBin, "codex.cmd"), '@ECHO off\r\n"%_prog%" "%dp0%\\fixture-codex.mjs" %*\r\n');
  writeFileSync(join(fixtureBin, "fixture-codex.mjs"), `import {writeFileSync} from 'node:fs';
writeFileSync('changes.patch', ${JSON.stringify(fixturePatch)});
writeFileSync('fixture-execution.json', JSON.stringify({argv:process.argv.slice(2), executable:process.execPath, cwd:process.cwd()}));
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
  Object.assign(appEnv, { PATH: `${fixtureBin}${delimiter}${process.env.PATH ?? ""}`, ARTOO_DESKTOP_DATA_DIR: userData, ARTOO_SERVER_URL: baseUrl });
  const { startServer } = await import(pathToFileURL(join(repoRoot, "apps/server/dist/main.js")).href);
  const { createSession } = await import(pathToFileURL(join(repoRoot, "apps/server/dist/auth/auth-service.js")).href);
  let server, browser, electronApp, page, appExe, ownerCookie;
  let uninstalled = false;
  const checks = [];
  const check = (description) => { checks.push(description); console.log(`[smoke] PASS ${description}`); };
  const ownerApi = async (route) => {
    const response = await fetch(`${baseUrl}${route}`, { headers: { Cookie: ownerCookie } });
    assert.equal(response.ok, true, `Owner read ${route}: ${response.status}`);
    return response.json();
  };
  async function launchApp() {
    electronApp = await electron.launch({ executablePath: appExe, env: appEnv, timeout: 45_000 });
    page = await electronApp.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => console.error(`[renderer] ${error.message}`));
    page.on("requestfailed", (request) => console.error(`[renderer] ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
    await page.waitForLoadState("domcontentloaded");
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
    await page.getByRole("checkbox", { name: "Allow execution of trusted team tasks on this computer" }).check();
    await page.getByRole("button", { name: "Save worker configuration" }).click();
    await until(async () => (await page.evaluate(() => window.artooDesktop.daemonStatus())).config.allowedRoots.includes(workspace), "Worker configuration was not saved");
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
    const downloaded = await downloadPatch("windows-artifact.patch");
    await page.getByLabel("Review comment", { exact: true }).fill("Downloaded patch bytes verified by packaged authenticated smoke");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.locator(".task-detail__header .ui-badge--status")).toHaveText("done");
    await page.screenshot({ path: join(artifactDir, "windows-desktop-smoke.png"), fullPage: true });
    check("Native UI creates and approves task; bundled daemon runs Codex fixture; artifact downloads and review completes");

    await electronApp.close(); electronApp = undefined; page = undefined;
    await server.close(); server = undefined; server = await startServer(serverEnv);
    assert.equal((await ownerApi(`/api/v1/tasks/${taskId}`)).task.status, "done");
    await launchApp();
    await page.getByRole("button", { name: new RegExp(taskTitle) }).click();
    await expect(page.locator(".task-detail__header .ui-badge--status")).toHaveText("done");
    assert.deepEqual(await page.evaluate(() => window.artooDesktop.getConnection()), connection);
    assert.ok((await page.evaluate(() => window.artooDesktop.daemonStatus())).config.allowedRoots.includes(workspace));
    await downloadPatch("windows-artifact-after-restart.patch");
    check("App/server restart preserve device identity, worker settings, reviewed task, and downloadable artifact");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connect this computer" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.artooDesktop.getToken()), null);
    assert.equal((await fetch(`${baseUrl}/auth/session`, { headers: { Authorization: `Bearer ${nativeToken}` } })).status, 401);
    await electronApp.close(); electronApp = undefined; page = undefined;
    uninstall(); await until(() => !existsSync(appExe), "NSIS uninstall left the app executable", 30_000); uninstalled = true;
    check("Sign out clears credentials and revokes access; NSIS uninstall removes the app");
    const report = { result: "pass", checkedAt: new Date().toISOString(), installer, installerSha256: createHash("sha256").update(readFileSync(installer)).digest("hex"), checks, screenshot: join(artifactDir, "windows-desktop-smoke.png"), downloaded, modelExecution: "Temporary CLI fixture through production Codex adapter; no real model quality claim", ownerAuthentication: "Test-provisioned owner cookie; native pairing and authorization use production endpoints" };
    writeFileSync(join(artifactDir, "windows-desktop-smoke.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    writeFileSync(join(artifactDir, "windows-desktop-smoke.json"), JSON.stringify({ result: "fail", checkedAt: new Date().toISOString(), installer, installerSha256: createHash("sha256").update(readFileSync(installer)).digest("hex"), checks, error: error instanceof Error ? error.message : String(error) }, null, 2));
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifactDir, "windows-desktop-smoke-failure.png"), fullPage: true }).catch(() => {});
      console.error(`[smoke] Visible app state:\n${await page.locator("body").innerText().catch(() => "unavailable")}`);
    }
    throw error;
  } finally {
    await electronApp?.close().catch(() => {}); await browser?.close().catch(() => {}); await server?.close().catch(() => {});
    if (!uninstalled) { try { uninstall(); if (appExe) await until(() => !existsSync(appExe), "Cleanup uninstall did not finish", 30_000); } catch (error) { console.warn(`[smoke] ${error.message}`); } }
    await removeTemp(tempRoot);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
