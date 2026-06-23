import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

import { _electron as electron } from "playwright";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const npmCli = process.env.npm_execpath;

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", ...options.env },
    stdio: "inherit",
    windowsHide: true,
    timeout: options.timeoutMs,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.signal !== null) {
    throw new Error(`${command} terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}`);
  }
}

function runNpm(args, options = {}) {
  if (npmCli !== undefined && npmCli !== "") {
    run(process.execPath, [npmCli, ...args], options);
    return;
  }
  run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/bootstrap`);
      if (response.ok) {
        return;
      }
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become ready: ${baseUrl}`);
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function stopChild(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeWithRetry(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.warn(`[smoke] cleanup left temp directory ${path}: ${String(lastError)}`);
}

function findFirst(dir, predicate) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && predicate(full, entry.name)) {
      return full;
    }
    if (entry.isDirectory()) {
      const found = findFirst(full, predicate);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function findInstaller() {
  const releaseDir = resolve(desktopDir, "release");
  const installer = findFirst(
    releaseDir,
    (_full, name) => /^Artoo Setup .*\.exe$/i.test(name),
  );
  if (installer === undefined) {
    throw new Error(`no NSIS installer found in ${releaseDir}`);
  }
  return installer;
}

async function createSmokeTask(baseUrl) {
  const title = `Windows desktop smoke ${Date.now()}`;
  const response = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `desktop-smoke-${Date.now()}`,
    },
    body: JSON.stringify({
      project_id: "proj_artoo",
      title,
      acceptance_criteria: ["desktop can read this task"],
      required_capabilities: ["code.modify"],
    }),
  });
  if (!response.ok) {
    throw new Error(`failed to create smoke task: ${response.status} ${await response.text()}`);
  }
  return title;
}

function startServer(port, root) {
  const dbDir = join(root, "db");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ARTOO_PORT: String(port),
      ARTOO_HOST: "127.0.0.1",
      ARTOO_DB_DIR: dbDir,
      ARTOO_WORKSPACE_ROOT: workspaceRoot,
      ARTOO_PAIRING_PEPPER: "desktop-smoke-pairing-pepper",
      ARTOO_ALLOW_DEV_NODE_TOKEN: "1",
      ARTOO_DESKTOP_CORS: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("windows-e2e-smoke must run on Windows");
  }

  runNpm(["run", "build", "--workspace", "@artoo/server"], { timeoutMs: 120_000 });
  runNpm(["run", "dist:win", "--workspace", "@artoo/desktop"], { timeoutMs: 300_000 });

  const tempRoot = mkdtempSync(join(tmpdir(), "artoo-desktop-smoke-"));
  const installDir = join(tempRoot, "install");
  const artifactDir = resolve(desktopDir, "release", "smoke-artifacts");
  mkdirSync(artifactDir, { recursive: true });

  const installer = findInstaller();
  run(installer, ["/S", `/D=${installDir}`], { timeoutMs: 180_000 });
  const appExe = findFirst(installDir, (_full, name) => /^Artoo\.exe$/i.test(name));
  if (appExe === undefined || !existsSync(appExe)) {
    throw new Error(`installed Artoo.exe not found under ${installDir}`);
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port, tempRoot);
  let electronApp;
  let page;
  try {
    await waitForServer(baseUrl);
    const taskTitle = await createSmokeTask(baseUrl);

    electronApp = await electron.launch({
      executablePath: appExe,
      env: {
        ...process.env,
        ARTOO_SERVER_URL: baseUrl,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });
    page = await electronApp.firstWindow({ timeout: 30_000 });
    attachPageDiagnostics(page);
    await page.waitForLoadState("domcontentloaded");
    const bridge = await page.evaluate(() => window.artooDesktop);
    if (bridge?.serverUrl !== baseUrl) {
      throw new Error(`desktop bridge serverUrl mismatch: ${JSON.stringify(bridge)}`);
    }
    await page.waitForSelector(`text=${taskTitle}`, { timeout: 45_000 });
    const rendererWrite = await page.evaluate(async () => {
      const serverUrl = window.artooDesktop?.serverUrl;
      if (serverUrl === undefined) {
        throw new Error("desktop bridge missing serverUrl");
      }
      const response = await fetch(`${serverUrl}/api/v1/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `desktop-renderer-write-${Date.now()}`,
        },
        body: JSON.stringify({
          project_id: "proj_artoo",
          title: `Windows desktop renderer write ${Date.now()}`,
          acceptance_criteria: ["desktop renderer can write through CORS"],
          required_capabilities: ["code.modify"],
        }),
      });
      if (!response.ok) {
        throw new Error(`renderer write failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    });
    if (typeof rendererWrite?.task?.id !== "string") {
      throw new Error(`renderer write returned unexpected payload: ${JSON.stringify(rendererWrite)}`);
    }
    await page.screenshot({ path: join(artifactDir, "windows-desktop-smoke.png"), fullPage: true });
    await electronApp.close();
    electronApp = undefined;

    const uninstaller = findFirst(installDir, (_full, name) => /^Uninstall .*\.exe$/i.test(name));
    if (uninstaller === undefined) {
      throw new Error(`uninstaller not found under ${installDir}`);
    }
    run(uninstaller, ["/S"], { timeoutMs: 120_000 });
    await waitUntil(() => !existsSync(appExe), 30_000, `uninstall left app executable behind: ${appExe}`);

    console.log(
      JSON.stringify(
        {
          installer,
          installDir,
          appExe,
          server: baseUrl,
          screenshot: join(artifactDir, "windows-desktop-smoke.png"),
          readTask: taskTitle,
          result: "pass",
        },
        null,
        2,
      ),
    );
  } catch (err) {
    if (page !== undefined && !page.isClosed()) {
      const failureScreenshot = join(artifactDir, "windows-desktop-smoke-failure.png");
      await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => {});
      console.error(`[smoke] failure screenshot: ${failureScreenshot}`);
      const bodyText = await page.locator("body").innerText({ timeout: 1_000 }).catch((bodyErr) => {
        return `body read failed: ${String(bodyErr)}`;
      });
      console.error(`[smoke] renderer body:\n${bodyText}`);
      const probe = await page.evaluate(async () => {
        const bridge = window.artooDesktop;
        const result = {
          href: window.location.href,
          bridge,
          bootstrap: null,
          tasks: null,
        };
        if (bridge?.serverUrl === undefined) {
          return result;
        }
        for (const [key, path] of [
          ["bootstrap", "/api/v1/bootstrap"],
          ["tasks", "/api/v1/tasks?project_id=proj_artoo"],
        ]) {
          try {
            const response = await fetch(`${bridge.serverUrl}${path}`);
            result[key] = { status: response.status, text: await response.text() };
          } catch (fetchErr) {
            result[key] = { error: String(fetchErr) };
          }
        }
        return result;
      }).catch((probeErr) => ({ error: String(probeErr) }));
      console.error(`[smoke] renderer probe:\n${JSON.stringify(probe, null, 2)}`);
    }
    throw err;
  } finally {
    if (electronApp !== undefined) {
      await electronApp.close().catch(() => {});
    }
    await stopChild(server);
    await removeWithRetry(tempRoot);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function attachPageDiagnostics(page) {
  page.on("console", (msg) => {
    console.log(`[renderer:${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    console.error(`[renderer:pageerror] ${String(err)}`);
  });
  page.on("requestfailed", (request) => {
    console.error(`[renderer:requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      console.error(`[renderer:response] ${response.status()} ${response.url()}`);
    }
  });
}
