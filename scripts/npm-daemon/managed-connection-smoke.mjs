// Actual installed CLI, HTTP enrollment, WebSocket hello and background processes.
// The loopback server uses fixture owner authentication; no model is invoked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPackage } from './verify.mjs';
import { safeError } from './cli.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(100); }
  throw Error(`Timed out waiting for ${label}`);
}
const absent = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };

export async function managedConnectionSmoke({ packageDirectory, evidenceDirectory }) {
  const verification = await verifyPackage(packageDirectory);
  mkdirSync(evidenceDirectory);
  const root = realpathSync(evidenceDirectory), workspace = join(root, 'workspace'), state = join(root, 'state');
  const ephemeral = join(root, 'ephemeral-package'), artifactDir = join(root, 'artifact-store');
  mkdirSync(workspace); mkdirSync(artifactDir);
  cpSync(packageDirectory, ephemeral, { recursive: true, errorOnExist: true, force: false });
  const { managedStatus, stopManaged } = await import(pathToFileURL(join(packageDirectory, 'bin/managed.mjs')).href);
  const { loadConnection } = await import(pathToFileURL(join(packageDirectory, 'bin/local-config.mjs')).href);
  const { buildTestServer } = await import('../../apps/server/dist/test-support.js');
  const { testDeviceAuthConfig } = await import('../../apps/server/dist/config/device-auth.js');
  const server = await buildTestServer({ workspaceRoot: workspace, artifactDir, enableDevRoutes: false,
    deviceAuth: testDeviceAuthConfig({ devNodeToken: null, devControlEscape: false }) });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^ARTOO_/i.test(key) && !/^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key) && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)));
  // Detect no real model CLI. Node and system PowerShell remain available through
  // fixed absolute paths; this test never signs in or runs a provider command.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = dirname(process.execPath); env.ARTOO_HOME = state;
  let connection, log = '', started = [], result;
  const commands = [];
  const command = async (label, entry, args, launcher = false) => {
    let executable = launcher ? entry : process.execPath;
    let argv = launcher ? args : [entry, ...args], verbatim = false;
    if (launcher && process.platform === 'win32') {
      assert.doesNotMatch(entry, /["%!&|<>^\r\n]/);
      assert.deepEqual(args, ['start']);
      executable = process.env.ComSpec ?? join(process.env.SystemRoot, 'System32/cmd.exe');
      argv = ['/d', '/v:off', '/s', '/c', `""${entry}" "start""`]; verbatim = true;
    }
    const child = spawn(executable, argv, { cwd: root, env, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
    try {
      const closure = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
      });
      log += `[${label}]\n${stdout}${stderr}`;
      commands.push({ label, ...closure, timedOut });
      assert.equal(timedOut, false, `${label} exceeded its deadline`);
      assert.deepEqual(closure, { code: 0, signal: null }, `${label} failed; see private local daemon log`);
      return stdout;
    } finally { clearTimeout(timer); }
  };
  try {
    const origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const request = async (path, body) => {
      const response = await fetch(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000) });
      assert.equal(response.ok, true, `Fixture ${path} failed with HTTP ${response.status}`);
      return response.json();
    };
    const baseline = (await request('/api/v1/devices')).devices.length;
    const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
    const pairing = await request('/api/v1/devices/pairings', { intended_platform: platform });
    const args = ['connect', '--server', origin, '--code', pairing.code, '--workspace', workspace];
    await command('connect', join(ephemeral, 'bin/artood.mjs'), args);
    connection = loadConnection(state);
    assert.ok(connection?.computerId); assert.equal(connection.controlToken, null);
    assert.equal(connection.origin, origin); assert.deepEqual(connection.roots, [workspace]);
    const first = await managedStatus(state); assert.equal(first.status, 'running'); started.push(first.pid);
    assert.equal(first.computerId, connection.computerId);
    await waitFor(() => server.nodeRegistry.get(connection.computerId)?.workspaceRoots, 'registered workspace-root hello');
    assert.deepEqual(server.nodeRegistry.get(connection.computerId).workspaceRoots, { version: 1, paths: [workspace] });
    const device = (await request('/api/v1/devices')).devices.find(item => item.id === connection.deviceId);
    assert.equal(device.computer_id, connection.computerId);
    assert.equal((await request('/api/v1/devices')).devices.length, baseline + 1);
    const running = JSON.parse(readFileSync(join(state, 'running.json'), 'utf8'));
    assert.notEqual(running.nonce, connection.nodeToken);
    const unauthorized = await fetch(`http://127.0.0.1:${running.port}/stop`, { method: 'POST' });
    assert.equal(unauthorized.status, 403);
    if (process.platform !== 'win32') {
      assert.equal(statSync(state).mode & 0o077, 0);
      assert.equal(statSync(join(state, 'connection.dat')).mode & 0o077, 0);
    } else assert.equal(readFileSync(join(state, 'connection.dat')).includes(Buffer.from(connection.nodeToken)), false);
    assert.match(await command('status', join(ephemeral, 'bin/artood.mjs'), ['status']), /Artoo: running/);
    await command('repeat-connect', join(ephemeral, 'bin/artood.mjs'), args);
    assert.equal((await managedStatus(state)).pid, first.pid);
    assert.equal(loadConnection(state).deviceId, connection.deviceId);
    assert.equal((await request('/api/v1/devices')).devices.length, baseline + 1);
    await command('stop', join(ephemeral, 'bin/artood.mjs'), ['stop']);
    await waitFor(() => absent(first.pid) && !server.nodeRegistry.get(connection.computerId), 'first process exit and WebSocket disconnect');
    assert.equal((await managedStatus(state)).status, 'stopped');
    assert.equal(loadConnection(state).deviceId, connection.deviceId);
    // Remove only this fixture's disposable copy, as npm may evict its npx cache.
    assert.equal(realpathSync(ephemeral), join(root, 'ephemeral-package'));
    assert.ok(ephemeral.startsWith(root + sep));
    rmSync(ephemeral, { recursive: true, force: false });
    const launcher = join(state, process.platform === 'win32' ? 'artood.cmd' : 'artood');
    assert.equal(existsSync(launcher), true);
    await command('retained-start', launcher, ['start'], true);
    const second = await managedStatus(state); assert.equal(second.status, 'running'); started.push(second.pid);
    assert.notEqual(second.pid, first.pid); assert.equal(second.computerId, connection.computerId);
    await waitFor(() => server.nodeRegistry.get(connection.computerId)?.workspaceRoots, 'same node reconnect');
    assert.deepEqual(server.nodeRegistry.get(connection.computerId).workspaceRoots, { version: 1, paths: [workspace] });
    assert.equal((await request('/api/v1/devices')).devices.length, baseline + 1);
    await stopManaged(state);
    await waitFor(() => absent(second.pid) && !server.nodeRegistry.get(connection.computerId), 'restarted process exit and disconnect');
    assert.equal(log.includes(connection.nodeToken), false, 'Node credential appeared in CLI output');
    if (existsSync(join(state, 'daemon.log'))) assert.equal(readFileSync(join(state, 'daemon.log'), 'utf8').includes(connection.nodeToken), false);
    result = { status: 'passed', version: 1, platform: process.platform, arch: process.arch, package: verification,
      fixture_owner_authentication: true, dev_node_token_enabled: false, model_invoked: false,
      connected: true, workspaceHello: true, sameIdentityOnRepeat: true, gracefulStop: true, restartWithoutSource: true,
      sameIdentityAfterRestart: true, protectedCredentials: true, unauthorizedStopRejected: true,
      processIds: started, allProcessesAbsent: started.every(absent), serverDisconnected: true, commands };
    writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
  } catch (error) {
    writeFileSync(join(root, 'failure.json'), JSON.stringify({ status: 'failed', platform: process.platform,
      error: safeError(error, connection ? { NODE_TOKEN: connection.nodeToken } : {}), commands }, null, 2) + '\n', { flag: 'wx' });
    throw error;
  } finally {
    try { if (existsSync(join(state, 'running.json'))) await stopManaged(state); }
    finally {
      writeFileSync(join(root, 'stdout.log'), safeError(Error(log), connection ? { NODE_TOKEN: connection.nodeToken } : {}), { flag: 'wx' });
      await server.close();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--package-directory' || args[2] !== '--evidence-directory') {
    console.error('Use --package-directory <installed package> --evidence-directory <new directory>'); process.exitCode = 1;
  } else managedConnectionSmoke({ packageDirectory: resolve(args[1]), evidenceDirectory: resolve(args[3]) })
    .then(result => console.log(JSON.stringify({ status: result.status, platform: result.platform })), error => {
      console.error(safeError(error)); process.exitCode = 1;
    });
}
