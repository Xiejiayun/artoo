import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { atomicPrivateFile, loadConnection, protectDirectory, readPrivateFile } from "./local-config.mjs";
import { readRelease, verifyPackage } from "./verify.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
const statePath = directory => join(directory, "running.json");

function readRunning(directory) {
  try {
    const value = JSON.parse(readPrivateFile(statePath(directory)));
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1
      || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce)
      || typeof value.id !== "string") throw Error();
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw Error("The local daemon status file is invalid. No process was changed.");
  }
}

export async function managedStatus(directory) {
  const record = readRunning(directory);
  if (!record) return { status: "stopped" };
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/status`, {
      headers: { authorization: `Bearer ${record.nonce}` }, redirect: "error", signal: AbortSignal.timeout(1500),
    });
    const status = await response.json();
    if (response.status !== 200 || status.id !== record.id || status.pid !== record.pid) throw Error();
    return { status: status.ready ? "running" : "starting", pid: record.pid, computerId: status.computerId, origin: status.origin };
  } catch {
    return { status: alive(record.pid) ? "unreachable" : "stopped", pid: record.pid };
  }
}

export async function stopManaged(directory, output = () => {}) {
  const record = readRunning(directory);
  const status = await managedStatus(directory);
  if (status.status === "stopped") { output("Artoo is already stopped.\n"); return status; }
  if (status.status === "unreachable") throw Error("The saved daemon is not responding. No process was killed; inspect the local daemon log.");
  const response = await fetch(`http://127.0.0.1:${record.port}/stop`, {
    method: "POST", headers: { authorization: `Bearer ${record.nonce}` }, redirect: "error", signal: AbortSignal.timeout(3000),
  });
  if (response.status !== 202) throw Error("The daemon did not accept a stop request.");
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!alive(record.pid)) { output("Artoo stopped. Saved connection retained.\n"); return { status: "stopped" }; }
    await sleep(200);
  }
  throw Error("Artoo is still stopping its active tasks. Wait, then run artood status; no process was force-killed.");
}

/** Preserve the verified installation independently of npm's evictable npx cache. */
export async function retainInstallation(packageDirectory, directory) {
  const release = readRelease(packageDirectory);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(release.metadata.version)) throw Error("The installed package version is invalid.");
  const releases = join(directory, "releases");
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const name = `${release.metadata.version}-${release.metadata.artoo.runtimeManifestSha256.slice(7, 23)}`;
  const destination = join(releases, name);
  if (resolve(packageDirectory) === resolve(destination)) return destination;
  if (existsSync(destination)) { await verifyPackage(destination, { importRuntime: false }); return destination; }
  await verifyPackage(packageDirectory, { importRuntime: false });
  const staging = join(releases, `.copy-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  for (const member of ["bin", "runtime", "package.json", "README.md", "LICENSE"])
    if (existsSync(join(packageDirectory, member))) cpSync(join(packageDirectory, member), join(staging, member), { recursive: true, errorOnExist: true, force: false });
  await verifyPackage(staging, { importRuntime: false });
  // Staging stays inside the owned installation root; failed copies are kept for diagnosis.
  try { renameSync(staging, destination); }
  catch (error) { if (!existsSync(destination)) throw error; await verifyPackage(destination, { importRuntime: false }); }
  return destination;
}

export async function startManaged({ directory, packageDirectory, env = process.env, output = () => {} }) {
  protectDirectory(directory);
  const previous = await managedStatus(directory);
  if (previous.status === "running") { output(`Artoo is already running on this computer (PID ${previous.pid}).\n`); return previous; }
  if (previous.status === "unreachable") throw Error("An existing daemon is unresponsive. Use artood status before starting another copy.");
  if (previous.status === "starting") throw Error("Artoo is already starting. Run artood status in a moment.");
  const installation = await retainInstallation(packageDirectory, directory);
  const launcher = writeManagementLauncher(directory, installation);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^ARTOO_/i.test(key) && !/^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key)));
  childEnv.ARTOO_HOME = directory;
  const log = openSync(join(directory, "daemon.log"), "a", 0o600);
  const child = spawn(process.execPath, [join(installation, "bin", "artood.mjs"), "--serve"], {
    cwd: directory, env: childEnv, detached: true, windowsHide: true, stdio: ["ignore", log, log],
  });
  closeSync(log);
  let failure;
  child.once("error", error => { failure = error; });
  child.unref();
  for (let attempt = 0; attempt < 150; attempt++) {
    if (failure) throw Error("The background daemon could not be launched. Run artood start --foreground for details.");
    const status = await managedStatus(directory);
    if (status.status === "running") {
      output(`Artoo is running on this computer (PID ${status.pid}).\nOpen ${status.origin}/computers to choose an agent and create an instance.\n`);
      output(`Check status: ${launcher} status\nReplace status with stop or start to stop or restart. The connection is saved.\n`);
      return status;
    }
    if (child.exitCode !== null) throw Error("The daemon exited during startup. Run artood start --foreground to see the connection error.");
    await sleep(200);
  }
  throw Error("Artoo is still connecting. Run artood status or inspect the local daemon log; do not pair again.");
}

export function writeManagementLauncher(directory, installation) {
  const entry = join(installation, "bin", "artood.mjs");
  if (process.platform === "win32") {
    // Neither path is user task text. Batch metacharacters still must not expand.
    if (/[\r\n%!"]/u.test(process.execPath + entry + directory)) throw Error("The local installation path cannot be represented safely by a Windows launcher.");
    const path = join(directory, "artood.cmd");
    atomicPrivateFile(path, `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ARTOO_HOME=${directory}"\r\n"${process.execPath}" "${entry}" %*\r\nexit /b %errorlevel%\r\n`);
    return `& "${path}"`;
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const path = join(directory, "artood");
  atomicPrivateFile(path, `#!/bin/sh\nARTOO_HOME=${quote(directory)} exec ${quote(process.execPath)} ${quote(entry)} "$@"\n`);
  chmodSync(path, 0o700);
  return quote(path);
}

/** Loopback control requests carry an independent local secret, never the node token. */
export async function serveManaged({ directory, launch }) {
  protectDirectory(directory);
  const lockPath = join(directory, "daemon.lock");
  if (existsSync(lockPath)) {
    let lock;
    try { lock = JSON.parse(readPrivateFile(lockPath)); } catch { throw Error("The daemon lock needs inspection."); }
    if (!Number.isSafeInteger(lock.pid) || lock.pid < 1 || alive(lock.pid)) throw Error("Another daemon owns this local connection.");
    // Only the exact stale lock in the protected state directory is removed.
    unlinkSync(lockPath);
  }
  const lock = openSync(lockPath, "wx", 0o600);
  const id = randomUUID(), nonce = randomBytes(32).toString("hex");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, id })); closeSync(lock);
  let server, ready = false;
  const removeOwnedFiles = () => {
    for (const path of [lockPath, statePath(directory)]) {
      try { if (JSON.parse(readPrivateFile(path)).id === id) unlinkSync(path); } catch { /* A missing/replaced file is not ours to delete. */ }
    }
  };
  process.once("exit", removeOwnedFiles);
  const connection = loadConnection(directory);
  if (!connection?.computerId) { removeOwnedFiles(); throw Error("This computer has not completed enrollment. Run artood connect first."); }
  try {
    server = createServer((request, response) => {
      const presented = Buffer.from(request.headers.authorization || ""), expected = Buffer.from(`Bearer ${nonce}`);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) { response.writeHead(403).end(); return; }
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ id, pid: process.pid, ready, computerId: connection.computerId, origin: connection.origin }));
      } else if (request.method === "POST" && request.url === "/stop" && ready) {
        response.writeHead(202).end();
        setImmediate(() => process.emit("SIGTERM"));
      } else response.writeHead(404).end();
    });
    server.requestTimeout = 3000; server.headersTimeout = 3000;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    atomicPrivateFile(statePath(directory), JSON.stringify({ version: 1, id, pid: process.pid, port: server.address().port, nonce }));
    await launch(connection);
    // This is local daemon readiness (socket open + hello sent), not evidence
    // that the server accepted the computer or a model CLI can execute tasks.
    ready = true;
  } catch (error) {
    server?.close(); removeOwnedFiles(); throw error;
  }
}
