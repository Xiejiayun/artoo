// Only test orchestration. The linked C# production functions own all authority and closure decisions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

assert.equal(process.platform, 'win32');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(config.version, 1);
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: join(process.env.SystemRoot, 'System32') };
let guardian, host, heldRelay;
const children = new Set();

function native(mode, detached = false, rawWire = false) {
  assert.ok(!rawWire || mode === '--guardian-client-v1');
  const child = spawn(config.executable, [mode], { shell: false, windowsHide: true, detached, stdio: ['pipe', 'pipe', 'pipe'],
    env: rawWire ? { ...env, ARTOO_GUARDIAN_REGRESSION_RAW_WIRE: 'v1' } : env });
  children.add(child); child.stdin.on('error', () => {});
  const frames = [], diagnostics = [], wireFailures = [], listeners = new Set();
  let wireFailureFrames = 0, wireFailureRejected = false;
  let text = '', stderrText = '', output = 0, spawnSeen = false, exit, stdoutEof = false, stderrEof = false;
  const diagnostic = line => {
    if (line.length > 2048) { if (rawWire) wireFailureRejected = true; return; }
    let frame; try { frame = JSON.parse(line); } catch { if (rawWire) wireFailureRejected = true; return; }
    // Supplemental stderr is never process authority. A malformed/oversized raw
    // probe diagnostic cannot disappear behind the one-frame evidence bound.
    const value = frame?.payload;
    if (frame?.kind === 'fixture_wire_failure') {
      wireFailureFrames++;
      if (frame.version !== 1 || wireFailureFrames !== 1 || !value
        || !['unknown', 'legacy-success', 'legacy-timeout', 'expired', 'unknown-version', 'negative', 'distant-future'].includes(value.scenario)
        || value.nonceDigest !== null && (typeof value.nonceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.nonceDigest))
        || typeof value.resultEmitted !== 'boolean'
        || !['input', 'connect', 'inspect_connection', 'write_request', 'read_response', 'emit_result', 'connection_dispose'].includes(value.phase)
        || typeof value.exceptionType !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.exceptionType)
        || typeof value.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.code)
        || value.nativeError !== null && (!Number.isInteger(value.nativeError) || value.nativeError < 0 || value.nativeError > 65535)) {
        wireFailureRejected = true; return;
      }
      const handles = value.originalHandles;
      const originalHandles = value.phase === 'connection_dispose' && handles?.observedBeforeExit === true
        && typeof handles.pipeClosed === 'boolean' && typeof handles.guardianClosed === 'boolean'
        ? { pipeClosed: handles.pipeClosed, guardianClosed: handles.guardianClosed, observedBeforeExit: true } : null;
      wireFailures.push({ scenario: value.scenario, nonceDigest: value.nonceDigest, resultEmitted: value.resultEmitted,
        phase: value.phase, exceptionType: value.exceptionType,
        code: value.code, nativeError: value.nativeError, originalHandles }); return;
    }
    if (diagnostics.length >= 3) return;
    if (frame?.version !== 1 || frame.kind !== 'native_failure_diagnostic' || value?.version !== 1
      || typeof value.phase !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.phase)
      || typeof value.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.code)
      || value.nativeError !== null && (!Number.isInteger(value.nativeError) || value.nativeError < 0 || value.nativeError > 65535)) return;
    diagnostics.push({ phase: value.phase, code: value.code, nativeError: value.nativeError });
  };
  child.once('spawn', () => { spawnSeen = true; });
  child.stdout.on('data', bytes => {
    output += bytes.length;
    if (output > 1024 * 1024) { child.kill(); return; }
    text += bytes.toString('utf8');
    for (;;) {
      const end = text.indexOf('\n'); if (end < 0) break;
      const line = text.slice(0, end); text = text.slice(end + 1);
      try { frames.push(JSON.parse(line)); } catch { child.kill(); return; }
      for (const listener of listeners) listener();
    }
  });
  child.stderr.on('data', bytes => {
    output += bytes.length; if (output > 1024 * 1024) { child.kill(); return; }
    stderrText += bytes.toString('utf8');
    for (;;) {
      const end = stderrText.indexOf('\n'); if (end < 0) break;
      diagnostic(stderrText.slice(0, end)); stderrText = stderrText.slice(end + 1);
    }
  });
  child.stdout.once('end', () => { stdoutEof = true; });
  child.stderr.once('end', () => { stderrEof = true; if (stderrText) diagnostic(stderrText); stderrText = ''; });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      children.delete(child);
      if (!spawnSeen || !exit || code !== exit.code || signal !== exit.signal || !stdoutEof || !stderrEof || text !== '' || output > 1024 * 1024)
        reject(Error('Actual child closure/output boundary failed'));
      else resolve({ code, signal, spawnObserved: true, exitObserved: true, closeObserved: true, stdoutEof, stderrEof });
      for (const listener of listeners) listener();
    });
  });
  void closed.catch(() => {});
  const wait = kind => new Promise((resolve, reject) => {
    const inspect = () => { const matches = frames.filter(frame => frame.kind === kind);
      if (matches.length) { listeners.delete(inspect); matches.length === 1 ? resolve(matches[0].payload) : reject(Error('Duplicate native frame')); } };
    listeners.add(inspect); inspect();
    void closed.then(() => { inspect(); if (listeners.delete(inspect)) reject(Error('Native frame missing: ' + kind
      + (wireFailures.length ? '; fixture_wire_failure=' + JSON.stringify(wireFailures) : '')
      + (diagnostics.length ? '; native_failure_diagnostic=' + JSON.stringify(diagnostics) : ''))); }, reject);
  });
  return { child, closed, wait, frameCount: () => frames.length,
    failureFacts: () => ({ wire: wireFailures, native: diagnostics.slice(0, 1), wireFailureFrames, wireFailureRejected }) };
}
async function relay(request) {
  const helper = native('--guardian-client-v1');
  const result = helper.wait('guardian_result');
  helper.child.stdin.end(JSON.stringify({ version: 1, endpoint: guardian.endpoint,
    request: { version: 1, nonce: randomUUID(), ...request } }) + '\n');
  const [payload, closure] = await Promise.all([result, helper.closed]); assert.equal(closure.code, 0); assert.equal(closure.signal, null); return payload;
}
async function command(input) {
  if (input.kind === 'bootstrap') {
    assert.equal(guardian, undefined);
    const qualifier = native('--daemon-supervisor-qualify-v1'), qualified = qualifier.wait('supervisor_qualified');
    qualifier.child.stdin.end(JSON.stringify({ version: 1, kind: 'qualify' }) + '\n');
    const [qualification, closed] = await Promise.all([qualified, qualifier.closed]); assert.equal(closed.code, 0);
    const child = native('--guardian-v1', true), ready = child.wait('guardian_ready');
    child.child.stdin.end(JSON.stringify({ version: 1, kind: 'bootstrap', nodeId: 'regression-node', deviceId: 'regression-device',
      sessionId: config.sessionId, configurationDigest: hash('fixed-native-regression'), storeDirectory: config.store,
      workspaceRoot: config.workspace, topology: 'supervisor-plain-daemon.v1', controlDirectory: config.control,
      supervisorLaunchIdentityDigest: qualification.launchIdentityDigest }) + '\n');
    guardian = await ready; return { ready: true, guardianPid: child.child.pid };
  }
  if (input.kind === 'activate') return relay({ kind: 'activate', epochId: guardian.epoch.epoch_id,
    sessionId: config.sessionId, registrationId: randomUUID(), registrationDigest: hash('regression-registration') });
  if (input.kind === 'start-host') {
    assert.equal(host, undefined);
    const enrollment = await relay({ kind: 'reserve', epochId: guardian.epoch.epoch_id, sessionId: config.sessionId,
      operationKind: 'author', operationId: 'fixture-host', bindingDigest: hash('fixture-host') });
    const child = native('--stdio-v1', true); await child.wait('ready');
    host = { ...child, terminal: child.wait('complete') };
    child.child.stdin.write(JSON.stringify({ version: 1, kind: 'launch', token: randomUUID(), executable: config.executable,
      args: ['--fixture-target', config.targetEvent], cwd: config.workspace, env, timeoutMs: 20000, cleanupTimeoutMs: 5000,
      maxOutputBytes: 65536, normalExitPolicy: 'require-empty', normalExitGraceMs: 250, guardian: enrollment }) + '\n');
    const started = await child.wait('started'); return { pid: started.pid, creationTime: started.creationTime };
  }
  if (input.kind === 'finish-host') {
    const terminal = await host.terminal; host.child.stdin.end(); const closed = await host.closed;
    assert.equal(closed.code, 0); assert.equal(closed.signal, null);
    for (const field of ['cleanupConfirmed', 'rootWaitObserved', 'jobEmptyObserved', 'stdoutEof', 'stderrEof']) assert.equal(terminal[field], true);
    assert.equal(terminal.rootExitCode, 0); assert.equal(terminal.terminationReason, null);
    return { terminal, closed };
  }
  if (input.kind === 'held-relay') {
    assert.equal(heldRelay, undefined); heldRelay = native('--guardian-client-v1');
    await new Promise((resolve, reject) => { heldRelay.child.once('spawn', resolve); heldRelay.child.once('error', reject); });
    return { pid: heldRelay.child.pid };
  }
  if (input.kind === 'close-held-relay') {
    heldRelay.child.stdin.end(); const closed = await heldRelay.closed; heldRelay = undefined;
    assert.notEqual(closed.code, 0); assert.equal(closed.signal, null); return closed;
  }
  if (input.kind === 'wire-case') {
    assert.ok(['legacy-success', 'legacy-timeout', 'expired', 'unknown-version', 'negative', 'distant-future'].includes(input.scenario));
    const helper = native('--guardian-client-v1', false, true), result = helper.wait('fixture_wire_result');
    helper.child.stdin.end(JSON.stringify({ fixtureWireCase: input.scenario, endpoint: guardian.endpoint,
      epochId: guardian.epoch.epoch_id, sessionId: config.sessionId }) + '\n');
    const [wire, closed] = await Promise.all([result, helper.closed]);
    const failures = helper.failureFacts();
    const failure = 'Wire helper closure failed: ' + JSON.stringify({ scenario: input.scenario, failures,
      wire: {
        nonceDigest: typeof wire?.nonceDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(wire.nonceDigest) ? wire.nonceDigest : null,
        elapsedMs: Number.isSafeInteger(wire?.elapsedMs) && wire.elapsedMs >= 0 && wire.elapsedMs <= 60000 ? wire.elapsedMs : null,
        replyKind: ['ok', 'error', null].includes(wire?.replyKind) ? wire.replyKind : 'invalid',
        nonceBound: wire?.nonceBound === true, peerClosed: wire?.peerClosed === true, clientTimeout: wire?.clientTimeout === true,
        deadlineIncluded: wire?.deadlineIncluded === true,
        transport: wire?.transportError === null ? null : wire?.transportError === 'guardian_peer_eof' ? 'guardian_peer_eof' : 'other',
      }, closed });
    // A fixed negative raw probe may expose the server's rejection as peer EOF
    // followed by the original Dispose error. It remains exit 2: neither this
    // local shape check nor managed IsClosed establishes the scenario's pass.
    // The C# caller must still check same-nonce server rejection, no mutation,
    // post-barrier roster equality and the original Supervisor closure.
    assert.equal(helper.frameCount(), 1, failure);
    assert.deepEqual(Object.keys(wire).sort(), ['clientTimeout', 'deadlineIncluded', 'elapsedMs', 'nonceBound',
      'nonceDigest', 'peerClosed', 'replyKind', 'scenario', 'transportError'], failure);
    assert.equal(wire.scenario, input.scenario, failure);
    assert.match(wire.nonceDigest, /^sha256:[a-f0-9]{64}$/, failure);
    assert.ok(Number.isSafeInteger(wire.elapsedMs) && wire.elapsedMs >= 0 && wire.elapsedMs <= 60000, failure);
    assert.equal(wire.deadlineIncluded, !['legacy-success', 'legacy-timeout'].includes(input.scenario), failure);
    assert.equal(wire.clientTimeout, false, failure);
    assert.equal(typeof wire.nonceBound, 'boolean', failure); assert.equal(typeof wire.peerClosed, 'boolean', failure);
    const replied = ['ok', 'error'].includes(wire.replyKind) && wire.nonceBound && !wire.peerClosed && wire.transportError === null;
    const peerEof = wire.replyKind === null && !wire.nonceBound && wire.peerClosed && wire.transportError === 'guardian_peer_eof';
    const negative = ['legacy-timeout', 'expired', 'unknown-version', 'negative', 'distant-future'].includes(input.scenario);
    assert.ok(negative ? replied && wire.replyKind === 'error' || peerEof : replied && wire.replyKind === 'ok', failure);
    assert.equal(closed.signal, null, failure);
    for (const field of ['spawnObserved', 'exitObserved', 'closeObserved', 'stdoutEof', 'stderrEof']) assert.equal(closed[field], true, failure);
    assert.equal(failures.wireFailureRejected, false, failure); assert.deepEqual(failures.native, [], failure);
    if (closed.code === 0) {
      assert.equal(failures.wireFailureFrames, 0, failure); assert.deepEqual(failures.wire, [], failure);
    } else {
      assert.ok(negative && closed.code === 2 && peerEof, failure);
      assert.equal(failures.wireFailureFrames, 1, failure); assert.equal(failures.wire.length, 1, failure);
      assert.deepEqual(failures.wire[0], { scenario: input.scenario, nonceDigest: wire.nonceDigest, resultEmitted: true,
        phase: 'connection_dispose', exceptionType: 'IOException', code: 'io_error', nativeError: null,
        originalHandles: { pipeClosed: true, guardianClosed: true, observedBeforeExit: true } }, failure);
    }
    return { ...wire, closed, failures };
  }
  throw Error('Unknown fixed daemon fixture operation');
}
const server = net.createServer(socket => {
  let text = '', handled = false;
  socket.on('error', () => {});
  socket.on('data', bytes => {
    if (handled) return; text += bytes.toString('utf8');
    if (text.length > 65536) { socket.destroy(); return; }
    const end = text.indexOf('\n'); if (end < 0) return; handled = true;
    let id;
    void (async () => {
      try { const request = JSON.parse(text.slice(0, end)); id = request.id;
        assert.match(id, /^[a-f0-9-]{36}$/); const result = await command(request.command); socket.end(JSON.stringify({ id, ok: true, result }) + '\n'); }
      catch (error) { socket.end(JSON.stringify({ id, ok: false, error: String(error.message).slice(0, 1000) }) + '\n'); }
    })();
  });
});
server.listen('\\\\.\\pipe\\' + config.daemonPipe);
// Supervisor's original shared Job supplies all descendant cleanup. No fixture
// restart loop or PID-based process sweep duplicates its lifecycle decisions.
