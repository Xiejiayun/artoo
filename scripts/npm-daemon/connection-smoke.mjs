// Real HTTP pairing/enrollment, database and WebSocket transport with a local
// fixture owner identity. No model is invoked and this is not production OAuth
// or autonomous/native-supervisor qualification.
import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackage } from "./verify.mjs";
import { safeError } from "./cli.mjs";
import { controlledRuntimes, devicePlatform, prepareControlledCli, runControlledCliTasks } from "./controlled-cli-smoke.mjs";

async function waitFor(predicate, label, timeout = 20_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`Timed out waiting for ${label}`);
}

export async function connectionSmoke({ packageDirectory, evidenceDirectory }) {
  const platform = devicePlatform();
  const shutdownMethod = process.platform === "win32" ? "ipc" : "sigint";
  const verification = await verifyPackage(packageDirectory);
  mkdirSync(evidenceDirectory);
  // Exercise the installed CLI in a fresh process before any ws import, with
  // both flags absent. A returned env object alone cannot guard module loading.
  const isolationProbe = String.raw`
    import assert from 'node:assert/strict';
    import Module from 'node:module';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    delete process.env.WS_NO_BUFFER_UTIL; delete process.env.WS_NO_UTF_8_VALIDATE;
    const attempted = [], original = Module._load;
    Module._load = function(request, ...args) {
      if (['bufferutil', 'utf-8-validate'].includes(request)) attempted.push(request);
      return original.call(this, request, ...args);
    };
    const { runCli } = await import(pathToFileURL(join(process.argv[1], 'bin/artood.mjs')).href);
    await assert.rejects(runCli({ args: [], env: {} }), /ARTOO_NODE_URL/);
    assert.deepEqual(attempted, []);
    console.log(JSON.stringify({ optionalAddonResolutionAttempts: attempted.length, emptyConfigRejected: true }));
  `;
  const isolation = spawnSync(process.execPath, ["--input-type=module", "-e", isolationProbe, packageDirectory],
    { cwd: evidenceDirectory, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  assert.equal(isolation.status, 0, `installed runtime dependency isolation failed: ${isolation.stderr}`);
  const dependencyIsolation = JSON.parse(isolation.stdout);
  const workspace = join(evidenceDirectory, "workspace"); mkdirSync(workspace);
  const artifactDir = join(evidenceDirectory, "artifact-store"); mkdirSync(artifactDir);
  const { buildTestServer } = await import("../../apps/server/dist/test-support.js");
  const { testDeviceAuthConfig } = await import("../../apps/server/dist/config/device-auth.js");
  const server = await buildTestServer({ workspaceRoot: workspace, artifactDir, enableDevRoutes: false,
    deviceAuth: testDeviceAuthConfig({ devNodeToken: null, devControlEscape: false }) });
  let child, closed, closedResult, stdout = "", stderr = "", childEnvironment;
  try {
    const origin = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const request = async (path, body) => {
      const response = await fetch(new URL(path, origin), { method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000) });
      assert.equal(response.ok, true, `HTTP ${path} failed with ${response.status}`); return response.json();
    };
    const pairing = await request("/api/v1/devices/pairings", { intended_platform: platform });
    const claim = await request("/api/v1/devices/claim", { code: pairing.code, platform, app_version: verification.version,
      display_name: "npm installed daemon loopback smoke" });
    assert.equal(typeof claim.node_token, "string");
    const enrollment = await request(`/api/v1/devices/${claim.device.id}/enroll`, { hostname: "npm-package-smoke", os: platform, arch: process.arch });
    assert.equal(typeof enrollment.computer_id, "string");
    childEnvironment = { ...process.env };
    for (const key of Object.keys(childEnvironment)) if (key.startsWith("ARTOO_")) delete childEnvironment[key];
    childEnvironment = prepareControlledCli({ evidenceDirectory, workspace, env: childEnvironment });
    childEnvironment.ARTOO_NODE_URL = `${origin.replace(/^http/, "ws")}/api/v1/node?token=${encodeURIComponent(claim.node_token)}`;
    childEnvironment.ARTOO_NODE_ID = enrollment.computer_id;
    childEnvironment.ARTOO_ALLOWED_ROOTS = workspace;
    childEnvironment.ARTOO_RUNTIMES = controlledRuntimes.join(",");
    childEnvironment.ARTOO_HEARTBEAT_INTERVAL_MS = "100";
    const launch = Date.now();
    child = shutdownMethod === "ipc" ? fork(join(packageDirectory, "bin/artood.mjs"), ["start"], {
      cwd: evidenceDirectory, env: childEnvironment, execArgv: [], windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }) : spawn(process.execPath, [join(packageDirectory, "bin/artood.mjs"), "start"], {
      cwd: evidenceDirectory, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"],
    });
    if (shutdownMethod === "sigint") assert.equal(child.send, undefined, "POSIX CLI smoke must have no IPC owner");
    let stdoutEof = false, stderrEof = false, exitResult, processError;
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.stdout.once("end", () => { stdoutEof = true; }); child.stderr.once("end", () => { stderrEof = true; });
    child.once("error", error => { processError = error; });
    child.once("exit", (code, signal) => { exitResult = { code, signal }; });
    closed = new Promise(resolve => child.once("close", (code, signal) => { closedResult = { code, signal }; resolve(closedResult); }));
    await waitFor(() => {
      if (processError || closedResult) throw Error(`Installed daemon exited before registration: ${safeError(Error(stderr), childEnvironment)}`);
      return !!server.nodeRegistry.get(enrollment.computer_id);
    }, "paired installed daemon registration");
    await waitFor(async () => {
      const result = await fetch(new URL(`/api/v1/computers/${enrollment.computer_id}/runtimes`, origin), { signal: AbortSignal.timeout(10_000) });
      const runtimes = (await result.json()).runtimes;
      return controlledRuntimes.every(name => runtimes.some(runtime => runtime.runtime === name && runtime.status === "available"));
    }, "persisted real runtime heartbeat");
    const readyMs = Date.now() - launch;
    const controlledCliTasks = await runControlledCliTasks({ request, computerId: enrollment.computer_id, workspace,
      env: childEnvironment, waitFor });
    // POSIX exercises an ordinary terminal launch without IPC and the actual
    // Ctrl+C signal handler. Windows kill(SIGINT) forcibly terminates, so keep
    // its original IPC-owner path and independently observe settled closure.
    if (shutdownMethod === "ipc")
      await new Promise((resolve, reject) => child.send({ type: "shutdown" }, error => error ? reject(error) : resolve()));
    else assert.equal(child.kill("SIGINT"), true, "Could not deliver SIGINT to the original POSIX daemon");
    await waitFor(() => !!closedResult, "normal daemon exit/close");
    await closed;
    assert.deepEqual(exitResult, { code: 0, signal: null }); assert.deepEqual(closedResult, { code: 0, signal: null });
    assert.equal(stdoutEof, true); assert.equal(stderrEof, true); assert.equal(processError, undefined);
    await waitFor(() => !server.nodeRegistry.get(enrollment.computer_id), "server node disconnect");
    assert.equal(stdout.includes(claim.node_token) || stderr.includes(claim.node_token), false, "node token appeared in output");
    const result = { version: 2, scope: "installed-npm-daemon-pair-enroll-websocket-controlled-cli-tasks-and-normal-stop",
      fixture_owner_authentication: true, dev_node_token_enabled: false, model_invoked: false, native_supervisor_qualified: false,
      platform: process.platform, devicePlatform: platform, arch: process.arch, shutdownMethod, controlledCliTasks,
      package: verification, paired: true, enrolled: true, registered: true, heartbeatPersisted: true, readyMs,
      dependencyIsolation, exit: exitResult, close: closedResult, stdoutEof, stderrEof, serverDisconnected: true };
    writeFileSync(join(evidenceDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    return result;
  } catch (error) {
    writeFileSync(join(evidenceDirectory, "failure.json"), `${JSON.stringify({ version: 1, status: "failed",
      platform: process.platform, arch: process.arch, package: verification,
      error: safeError(error, childEnvironment ?? {}) }, null, 2)}\n`, { flag: "wx" });
    throw error;
  } finally {
    try {
      if (child && !closedResult) {
        if (shutdownMethod === "ipc" && child.connected) child.send({ type: "shutdown" }, () => {});
        else if (shutdownMethod === "sigint") child.kill("SIGINT");
        try { await waitFor(() => !!closedResult, "failure cleanup", 5_000); }
        catch {
          child.kill("SIGKILL");
          await waitFor(() => !!closedResult, "forced failure cleanup", 5_000);
          await closed; // Failure cleanup only; never counted as a passing stop.
        }
      }
    } finally {
      writeFileSync(join(evidenceDirectory, "stdout.log"), safeError(Error(stdout), childEnvironment ?? {}), { flag: "wx" });
      writeFileSync(join(evidenceDirectory, "stderr.log"), safeError(Error(stderr), childEnvironment ?? {}), { flag: "wx" });
      await server.close();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--package-directory" || args[2] !== "--evidence-directory") {
    console.error("Usage: node connection-smoke.mjs --package-directory <installed package> --evidence-directory <new directory>"); process.exitCode = 1;
  } else connectionSmoke({ packageDirectory: resolve(args[1]), evidenceDirectory: resolve(args[3]) })
    .then(result => console.log(JSON.stringify(result)), error => { console.error(safeError(error)); process.exitCode = 1; });
}
