// Controlled native process fixture, not live-provider/product/publication acceptance.
// Root must run this inside its observed outer Job (normal-exit => terminate descendants).
// The fixture intentionally retains all files and guardian processes until that outer close.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url), digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixedHash = digest('controlled H9 native fixture configuration v1');
const pending = new Map(); let sequence = 0;
// Fixed native diagnostic vocabulary; raw stderr is consumed but never persisted.
const diagnosticPhases = new Set([
"guardian_bootstrap", "guardian_lifetime", "guardian_observe", "guardian_peer_open",
        "guardian_client_read", "guardian_request_handle", "guardian_client_reply",
        "guardian_relay_input", "guardian_relay_send", "guardian_relay_output",
        "guardian_connect", "guardian_server_identity", "guardian_request_write",
        "guardian_response_read", "guardian_response_binding", "supervisor_run",
        "supervisor_qualify", "supervisor_peer_open", "supervisor_query_read",
        "supervisor_query_qualify", "supervisor_query_reply",
    "unknown_phase"
]);
const diagnosticCodes = new Set([
"guardian_activation_binding", "guardian_attach_epoch", "guardian_attach_identity_changed",
        "guardian_attach_identity", "guardian_audit_bound", "guardian_bootstrap_parent",
        "guardian_bootstrap_supervisor", "guardian_bootstrap", "guardian_client_pid",
        "guardian_command_line_bound", "guardian_command_line_buffer", "guardian_command_line_missing",
        "guardian_command_line_parse", "guardian_command_line_query", "guardian_complete_transfer_frame_bound",
        "guardian_control_store_overlap", "guardian_directory_alias", "guardian_directory_final_path",
        "guardian_directory_handle", "guardian_directory_reparse", "guardian_endpoint", "guardian_enrollment",
        "guardian_exact_host", "guardian_exact_process_wait", "guardian_exact_server_identity",
        "guardian_exact_supervisor_required", "guardian_frame_limit", "guardian_image_query",
        "guardian_job_query", "guardian_local_directory_required", "guardian_lost", "guardian_parent_query",
        "guardian_peer_eof", "guardian_pipe_acl", "guardian_pipe_create", "guardian_process_open",
        "guardian_process_sid", "guardian_process_times", "guardian_process_token", "guardian_relay_image",
        "guardian_relay_parent", "guardian_relay_version", "guardian_request_rejected", "guardian_request",
        "guardian_reservation_binding", "guardian_root_epoch", "guardian_root_identity", "guardian_server_operation_binding",
        "guardian_server_pid", "guardian_slot_epoch", "guardian_terminal_ack_binding", "guardian_terminal_ack",
        "guardian_terminal_changed", "guardian_terminal_incomplete", "guardian_terminal_missing", "guardian_terminal_root",
        "guardian_terminal_unenrolled_root", "guardian_transfer_binding", "guardian_transfer_daemon_changed", "guardian_transfer_replay",
        "supervisor_attribute_size", "supervisor_attributes", "supervisor_client_pid", "supervisor_command_bound",
        "supervisor_control", "supervisor_created_handle_identity", "supervisor_daemon_create", "supervisor_daemon_resume",
        "supervisor_environment_duplicate", "supervisor_environment", "supervisor_exact_kernel_parent", "supervisor_file_acl_bound",
        "supervisor_file_acl_type", "supervisor_file_acl", "supervisor_file_alias", "supervisor_file_bytes_changed",
        "supervisor_file_external_writer", "supervisor_file_handle", "supervisor_file_identity_changed", "supervisor_file_owner",
        "supervisor_file_pin", "supervisor_file_reparse_or_links", "supervisor_fixed_launch", "supervisor_handle_list",
        "supervisor_input_bound", "supervisor_input_generation", "supervisor_input_queue", "supervisor_input_write",
        "supervisor_interrupt_generation", "supervisor_original_child_peer", "supervisor_original_current_daemon_handle",
        "supervisor_original_daemon_wait", "supervisor_original_launch_binding", "supervisor_pipe_acl", "supervisor_pipe_create",
        "supervisor_pipe_server_identity", "supervisor_pipe_server_pid", "supervisor_qualifier_mode", "supervisor_qualifier_parent",
        "supervisor_qualify_input", "supervisor_qualify_peer", "supervisor_restart_before_original_exit", "supervisor_stdio_create",
        "supervisor_stop_wait_unconfirmed", "supervisor_system_root", "supervisor_terminate_current", "empty_guardian_frame",
    "operation_cancelled", "timeout", "access_denied", "invalid_json", "win32_error", "io_error", "unexpected_error"
]);

const nativeObservations = new WeakMap();
const boundedInteger = (value, maximum = 0xffffffff) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
function projectNativeDiagnostic(value) {
  if (!value || value.version !== 1 || !diagnosticPhases.has(value.phase) || !diagnosticCodes.has(value.code)
    || value.nativeError !== null && boundedInteger(value.nativeError, 65535) === null) return null;
  return { version: 1, phase: value.phase, code: value.code, nativeError: value.nativeError };
}
function projectNativeFailure(value) {
  if (!value || value.version !== 1) return null;
  const expected = new Set(['guardian_ready', 'guardian_result', 'supervisor_qualified', 'ready', 'started', 'complete', 'job_members']);
  return { version: 1, expectedKind: expected.has(value.expectedKind) ? value.expectedKind : null,
    spawnObserved: value.spawnObserved === true, exitObserved: value.exitObserved === true, closeObserved: value.closeObserved === true,
    code: Number.isSafeInteger(value.code) && value.code >= -0x80000000 && value.code <= 0xffffffff ? value.code : null,
    signal: value.signal === null || ['SIGKILL', 'SIGTERM', 'SIGINT'].includes(value.signal) ? value.signal : null,
    stdoutEof: value.stdoutEof === true, stderrEof: value.stderrEof === true,
    stderrBytes: boundedInteger(value.stderrBytes), invalidDiagnosticFrames: boundedInteger(value.invalidDiagnosticFrames),
    omittedDiagnosticFrames: boundedInteger(value.omittedDiagnosticFrames), stderrLimitExceeded: value.stderrLimitExceeded === true,
    diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics.slice(0, 32).map(projectNativeDiagnostic).filter(Boolean) : [] };
}
function observeNativeDiagnostics(child) {
  const facts = { version: 1, spawnObserved: false, exitObserved: false, closeObserved: false, code: null, signal: null,
    stdoutEof: false, stderrEof: false, stderrBytes: 0, invalidDiagnosticFrames: 0, omittedDiagnosticFrames: 0,
    stderrLimitExceeded: false, diagnostics: [] };
  nativeObservations.set(child, facts); let buffer = '';
  child.once('spawn', () => { facts.spawnObserved = true; });
  child.once('exit', (code, signal) => { facts.exitObserved = true; facts.code = code; facts.signal = signal; });
  child.once('close', () => { facts.closeObserved = true; });
  child.stdout.once('end', () => { facts.stdoutEof = true; });
  child.stderr.once('end', () => { facts.stderrEof = true; if (buffer) facts.invalidDiagnosticFrames++; buffer = ''; });
  child.stderr.on('data', data => {
    facts.stderrBytes += data.length;
    if (facts.stderrBytes > 65536) { facts.stderrLimitExceeded = true; buffer = ''; return; }
    buffer += data.toString('utf8');
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let projected;
      try { const frame = JSON.parse(line); projected = frame?.version === 1 && frame.kind === 'native_failure_diagnostic' ? projectNativeDiagnostic(frame.payload) : null; }
      catch { /* Never retain arbitrary stderr, exception text or malformed JSON. */ }
      if (!projected) facts.invalidDiagnosticFrames++;
      else if (facts.diagnostics.length >= 32) facts.omittedDiagnosticFrames++;
      else facts.diagnostics.push(projected);
    }
  });
}
function restoreNativeFailure(message) {
  const error = Error(message.error), diagnostic = projectNativeFailure(message.nativeFailure);
  if (diagnostic) error.nativeFailure = diagnostic;
  return error;
}
function observed(child) {
  let exit, spawnObserved = false; child.once('spawn', () => { spawnObserved = true; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => { exit = { code, signal }; });
    child.once('close', (code, signal) => {
      if (!spawnObserved || !exit || exit.code !== code || exit.signal !== signal) reject(Error('missing actual process closure'));
      else resolve({ spawnObserved, exitObserved: true, closeObserved: true, code, signal });
    });
  });
  void closed.catch(() => {}); return closed;
}
function frames(child, expectedKind) {
  let buffer = '', bytes = 0, last;
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', data => {
      try {
        bytes += data.length; assert.ok(bytes < 1024 * 1024, 'bounded fixture control'); buffer += data.toString('utf8');
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); last = frame;
          if (frame.kind === expectedKind) resolve(frame);
        }
      } catch (error) { reject(error); }
    });
    child.once('error', reject); child.once('close', () => { if (last?.kind !== expectedKind) {
      const error = Error(`native ${expectedKind} unavailable`);
      error.nativeFailure = projectNativeFailure({ ...nativeObservations.get(child), expectedKind });
      reject(error);
    } });
    child.stderr.on('data', () => {});
  });
  void ready.catch(() => {}); return ready;
}
async function bounded(work, name, milliseconds = 20000) {
  let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${name} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function native(executable, mode, enrollment) {
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot && isAbsolute(systemRoot));
  if (enrollment !== undefined) assert.ok(mode === '--stdio-v1' || mode === '--stdio-sync-v1');
  const child = spawn(executable, [mode], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    // Match production: Guardian and its original registered hosts survive the
    // daemon's private libuv Job; ordinary/nested hosts and relays stay unchanged.
    // Detached does not request breakaway from the enclosing native owner Job.
    detached: mode === '--guardian-v1' || enrollment !== undefined,
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32') } });
  observeNativeDiagnostics(child);
  child.stdin.on('error', () => {}); return child;
}

if (process.argv[2] === '--stdin-reader') {
  const chunks = []; process.stdin.on('data', bytes => chunks.push(Buffer.from(bytes)));
  process.stdin.on('end', () => { const input = Buffer.concat(chunks); process.stdout.write(JSON.stringify({ bytes: input.length, sha256: digest(input), eof: true })); });
} else if (process.argv[2] === '--stdin-nonreader') {
  setInterval(() => {}, 1000);
} else if (process.argv[2] === '--sync-interrupted-target') {
  const workspace = process.argv[3]; assert.ok(isAbsolute(workspace));
  writeFileSync(join(workspace, 'sync-target-started.json'), JSON.stringify({ pid: process.pid, parentPid: process.ppid }), { flag: 'wx' });
  setInterval(() => appendFileSync(join(workspace, 'sync-target-writes.txt'), 'active\n'), 20);
} else if (process.argv[2] === '--nested-target') {
  const executable = process.argv[3], workspace = process.argv[4], child = native(executable, '--stdio-v1'); observed(child);
  const ready = await bounded(frames(child, 'ready'), 'nested helper ready'), started = frames(child, 'started');
  assert.ok(ready.payload.hostIdentity, 'real nested helper identity is required');
  const token = randomUUID();
  child.stdin.write(JSON.stringify({ version: 1, kind: 'launch', token, executable: process.execPath,
    args: [script, '--target-child', workspace], cwd: workspace, env: { SystemRoot: process.env.SystemRoot, PATH: join(process.env.SystemRoot, 'System32') },
    timeoutMs: 30000, cleanupTimeoutMs: 5000, maxOutputBytes: 65536, normalExitPolicy: 'terminate-descendants', normalExitGraceMs: 250 }) + '\n');
  const root = (await bounded(started, 'nested writer start')).payload;
  assert.ok(root.creationTime, 'real nested target HANDLE creation time is required');
  writeFileSync(join(workspace, 'nested-identities.json'), JSON.stringify({ boundary: 'atomic-job-subtree.v1',
    host: ready.payload.hostIdentity, writer: { pid: root.pid, creationTime: root.creationTime }, independentlyRegisteredSlots: 0 }), { flag: 'wx' });
  setInterval(() => {}, 1000);
} else if (process.argv[2] === '--target' || process.argv[2] === '--target-child') {
  const root = process.argv[3]; assert.ok(isAbsolute(root));
  const targetChild = process.argv[2] === '--target-child';
  if (!targetChild) spawn(process.execPath, [script, '--target-child', root], { windowsHide: true, stdio: 'inherit' });
  const path = join(root, targetChild ? 'child-writes.txt' : 'root-writes.txt');
  setInterval(() => appendFileSync(path, 'observed-write\n'), 10);
} else if (process.argv[2] === '--daemon-worker') {
  let executable, endpoint, epoch, guardianChild;
  const hosts = new Map();
  const handle = async input => {
    if (input.kind === 'configure') { executable = input.executable; return { configured: true }; }
    if (input.kind === 'bootstrap') {
      const qualifier = native(executable, '--daemon-supervisor-qualify-v1'), qualified = frames(qualifier, 'supervisor_qualified'), qualificationClosed = observed(qualifier);
      qualifier.stdin.end(JSON.stringify({ version: 1, kind: 'qualify' }) + '\n');
      const [supervision, qualifierClosure] = await bounded(Promise.all([qualified, qualificationClosed]), 'actual supervisor qualification'); assert.equal(qualifierClosure.code, 0);
      guardianChild = native(executable, '--guardian-v1'); observed(guardianChild);
      const ready = frames(guardianChild, 'guardian_ready');
      guardianChild.stdin.end(JSON.stringify({ version: 1, kind: 'bootstrap', nodeId: 'fixture-node', deviceId: 'fixture-device',
        sessionId: input.sessionId, configurationDigest: fixedHash, storeDirectory: input.store, workspaceRoot: input.workspace,
        topology: 'supervisor-plain-daemon.v1', controlDirectory: input.control, supervisorLaunchIdentityDigest: supervision.payload.launchIdentityDigest }) + '\n');
      const result = (await bounded(ready, 'guardian bootstrap')).payload; endpoint = result.endpoint; epoch = result.epoch;
      return result;
    }
    if (input.kind === 'connect') { endpoint = input.endpoint; return { connected: true }; }
    if (input.kind === 'relay') {
      const child = native(executable, '--guardian-client-v1'), closed = observed(child), ready = frames(child, 'guardian_result');
      child.stdin.end(JSON.stringify({ version: 1, endpoint, request: { version: 1, nonce: randomUUID(), ...input.request } }) + '\n');
      const [result, closure] = await bounded(Promise.all([ready, closed]), 'native guardian relay');
      assert.equal(closure.code, 0); assert.equal(closure.signal, null); return result.payload;
    }
    if (input.kind === 'host') {
      const child = native(executable, '--stdio-v1', input.enrollment), closed = observed(child), ready = frames(child, 'ready');
      const terminal = frames(child, 'complete'), started = frames(child, 'started');
      await bounded(ready, 'native host ready');
      const token = randomUUID();
      child.stdin.write(JSON.stringify({ version: 1, kind: 'launch', token, executable: process.execPath,
        args: input.nested ? [script, '--nested-target', executable, input.workspace] : input.active ? [script, '--target', input.workspace] : ['-e', 'process.stdout.write("fixture normal completion")'],
        cwd: input.workspace, env: { SystemRoot: process.env.SystemRoot, PATH: join(process.env.SystemRoot, 'System32') },
        // The fixed echo has no descendants; retain the production collector's
        // empty-Job grace. Active/nested trees keep explicit descendant cleanup.
        timeoutMs: 20000, cleanupTimeoutMs: 5000, maxOutputBytes: 65536,
        normalExitPolicy: input.active || input.nested ? 'terminate-descendants' : 'require-empty',
        normalExitGraceMs: 250, guardian: input.enrollment }) + '\n');
      const start = await bounded(started, 'native target start');
      hosts.set(input.enrollment.slotId, { child, closed, terminal, token });
      if (input.active) return { hostPid: child.pid, rootPid: start.payload.pid, rootCreationTime: start.payload.creationTime, slotId: input.enrollment.slotId };
      const result = await bounded(terminal, 'native terminal'); child.stdin.end(); const closure = await bounded(closed, 'host closure');
      assert.equal(closure.code, 0); assert.equal(result.payload.cleanupConfirmed, true);
      assert.equal(result.payload.terminationReason, null, 'terminal ACK must not race with pulse into a false cancellation');
      return { closure, terminal: result.payload };
    }
    if (input.kind === 'observe-members') {
      const host = hosts.get(input.slotId); assert.ok(host); const requestId = randomUUID(), reply = frames(host.child, 'job_members');
      host.child.stdin.write(JSON.stringify({ version: 1, kind: 'observe_members', token: host.token, requestId, members: input.members }) + '\n');
      const frame = await bounded(reply, 'original parent Job membership observation');
      assert.equal(frame.payload.requestId, requestId); return frame.payload;
    }
    if (input.kind === 'sync-host') {
      const child = native(executable, '--stdio-sync-v1', input.enrollment), closed = observed(child), ready = frames(child, 'ready');
      const terminal = frames(child, 'complete'); await bounded(ready, 'native sync host ready');
      const outputs = []; let lineBuffer = '';
      child.stdout.on('data', data => {
        lineBuffer += data.toString('utf8');
        for (;;) { const end = lineBuffer.indexOf('\n'); if (end < 0) break;
          const frame = JSON.parse(lineBuffer.slice(0, end)); lineBuffer = lineBuffer.slice(end + 1);
          if (frame.kind === 'output' && frame.payload.stream === 'stdout') outputs.push(Buffer.from(frame.payload.data, 'base64'));
        }
      });
      const bytes = Buffer.from('中文🛠️-input-'.repeat(32768));
      child.stdin.end(JSON.stringify({ version: 1, kind: 'launch', token: randomUUID(), executable: process.execPath,
        args: [script, input.nonReading ? '--stdin-nonreader' : '--stdin-reader'], cwd: input.workspace,
        env: { SystemRoot: process.env.SystemRoot, PATH: join(process.env.SystemRoot, 'System32') },
        // Like the production fixed observer, this single-process stdin target
        // must empty its Job naturally; a real timeout remains a separate failure.
        timeoutMs: input.nonReading ? 1000 : 10000, cleanupTimeoutMs: 5000, maxOutputBytes: 65536, normalExitPolicy: 'require-empty',
        normalExitGraceMs: 250, guardian: input.enrollment, inputBase64: bytes.toString('base64') }) + '\n');
      const result = await bounded(terminal, 'sync target terminal'), closure = await bounded(closed, 'sync host actual closure');
      assert.equal(closure.code, 0); assert.equal(result.payload.cleanupConfirmed, true);
      assert.equal(result.payload.rootWaitObserved, true); assert.equal(result.payload.jobEmptyObserved, true);
      assert.equal(result.payload.stdoutEof, true); assert.equal(result.payload.stderrEof, true);
      if (input.nonReading) assert.equal(result.payload.terminationReason, 'timeout');
      else { assert.equal(result.payload.rootExitCode, 0); assert.equal(result.payload.terminationReason, null);
        assert.deepEqual(JSON.parse(Buffer.concat(outputs).toString('utf8')), { bytes: bytes.length, sha256: digest(bytes), eof: true }); }
      return { inputBytes: bytes.length, inputSha256: digest(bytes), closure, terminal: result.payload, utf8PipeEofVerified: !input.nonReading };
    }
    if (input.kind === 'sync-host-interruption') {
      assert.ok(input.enrollment && input.enrollment.epochId === epoch.epoch_id);
      const launch = JSON.stringify({ version: 1, kind: 'launch', token: randomUUID(), executable: process.execPath,
        args: [script, '--sync-interrupted-target', input.workspace], cwd: input.workspace,
        env: { SystemRoot: process.env.SystemRoot, PATH: join(process.env.SystemRoot, 'System32') },
        timeoutMs: 45000, cleanupTimeoutMs: 5000, maxOutputBytes: 65536, normalExitPolicy: 'require-empty',
        normalExitGraceMs: 250, guardian: input.enrollment, inputBase64: '' });
      // Reply before blocking this exact daemon in the real Node synchronous API.
      // The parent waits for native enrollment plus the actual target marker.
      setImmediate(() => {
        const result = spawnSync(executable, ['--stdio-sync-v1'], { windowsHide: true, shell: false,
          detached: input.enrollment !== undefined, input: launch + '\n', timeout: 60000, maxBuffer: 1024 * 1024,
          env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: join(process.env.SystemRoot, 'System32') } });
        writeFileSync(join(input.workspace, 'sync-returned.json'), JSON.stringify({ pid: result.pid ?? null,
          status: result.status, signal: result.signal, returnedBeforeInterruption: true }), { flag: 'wx' });
      });
      return { scheduled: true, daemonPid: process.pid };
    }
    if (input.kind === 'kill-host') {
      const host = hosts.get(input.slotId); assert.ok(host); host.child.kill('SIGKILL');
      return await bounded(host.closed, 'exact spawned host termination');
    }
    if (input.kind === 'kill-guardian') {
      assert.ok(guardianChild); const closed = new Promise(resolve => guardianChild.once('close', (code, signal) => resolve({ code, signal })));
      guardianChild.kill('SIGKILL'); return await bounded(closed, 'exact spawned guardian termination');
    }
    if (input.kind === 'unrelated-supervisor-relay') {
      const child = spawn(process.execPath, [script, '--daemon-worker'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume(); const closed = observed(child), lines = createInterface({ input: child.stdout }); let id = 0;
      const call = request => bounded(new Promise((resolve, reject) => {
        const requestId = ++id;
        const receive = line => { const message = JSON.parse(line); if (message.id !== requestId) return; lines.off('line', receive);
          if (message.ok) resolve(message.result); else reject(restoreNativeFailure(message)); };
        lines.on('line', receive); child.stdin.write(JSON.stringify({ id: requestId, input: request }) + '\n');
      }), 'unrelated supervisor child');
      try {
        await call({ kind: 'configure', executable }); await call({ kind: 'connect', endpoint });
        return await call({ kind: 'relay', request: { kind: 'status' } });
      } finally { child.kill('SIGKILL'); await bounded(closed, 'unrelated supervisor child closure'); }
    }
    throw Error('unknown controlled worker operation');
  };
  const respond = message => process.stdout.write(JSON.stringify(message) + '\n');
  createInterface({ input: process.stdin }).on('line', async line => {
    const message = JSON.parse(line);
    try { respond({ id: message.id, ok: true, result: await handle(message.input) }); }
    catch (error) { respond({ id: message.id, ok: false, error: error.message, nativeFailure: projectNativeFailure(error.nativeFailure) }); }
  });
} else {
  assert.equal(process.platform, 'win32', 'native Windows is mandatory; no skip/fallback');
  const [bundleArg, manifestSha, outputArg] = process.argv.slice(2);
  assert.ok(bundleArg && isAbsolute(bundleArg) && outputArg && isAbsolute(outputArg), 'arguments: <bundle> <manifest sha256> <new artifact directory>');
  const bundle = realpathSync.native(bundleArg), bytes = readFileSync(join(bundle, 'manifest.json'));
  assert.equal(digest(bytes), manifestSha, 'immutable input manifest');
  const manifest = JSON.parse(bytes); assert.equal(manifest.protocol, 'artoo.windows-job-process.v1');
  assert.ok(manifest.capabilities?.includes('artoo.windows-runtime-guardian.v1'));
  for (const file of manifest.files) {
    assert.ok(!isAbsolute(file.path) && !file.path.includes('..') && !file.path.includes('\\'));
    const path = join(bundle, file.path), stat = lstatSync(path), content = readFileSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1); assert.equal(stat.size, file.size); assert.equal(digest(content), file.sha256);
  }
  const executable = join(bundle, manifest.executable);
  assert.ok(manifest.files.some(file => file.path === manifest.executable));
  const relativeExecutable = relative(bundle, executable); assert.ok(relativeExecutable && !relativeExecutable.startsWith(`..${sep}`) && !isAbsolute(relativeExecutable));
  const output = resolve(outputArg); assert.ok(!existsSync(output), 'preserve earlier evidence'); mkdirSync(output);
  const workers = new Set(), evidence = [], additionalRegressions = [];
  const controlConfig = join(output, 'SUPERVISOR-CONFIG.json');
  writeFileSync(controlConfig, JSON.stringify({ version: 1, fixture: 'controlled-native-guardian', protocol: 'file-pinned-native-supervisor' }), { flag: 'wx' });
  const pin = path => { const bytes = readFileSync(path); return { path: realpathSync.native(path), bytes: bytes.length, sha256: digest(bytes) }; };
  async function worker() {
    const child = native(executable, '--daemon-supervisor-v1'), closed = observed(child);
    const events = [], outputBuffers = new Map(); let generation;
    const lifetime = { child, closed, events, stdoutEof: false, stderrEof: false }; workers.add(lifetime);
    child.stdout.once('end', () => { lifetime.stdoutEof = true; });
    child.stderr.once('end', () => { lifetime.stderrEof = true; });
    const eventWaiters = new Set();
    const publish = frame => { events.push(frame); for (const notify of eventWaiters) notify(); };
    let frameText = '';
    child.stdout.on('data', bytes => {
      frameText += bytes.toString('utf8');
      for (;;) {
        const end = frameText.indexOf('\n'); if (end < 0) break;
        const frame = JSON.parse(frameText.slice(0, end)); frameText = frameText.slice(end + 1);
        if (frame.kind === 'daemon_started') generation = frame.payload.generation;
        if (frame.kind === 'daemon_output' && frame.payload.stream === 'stdout') {
          const incarnation = frame.payload.generation, prior = outputBuffers.get(incarnation) ?? '';
          let text = prior + Buffer.from(frame.payload.data, 'base64').toString('utf8');
          for (;;) {
            const boundary = text.indexOf('\n'); if (boundary < 0) break;
            const message = JSON.parse(text.slice(0, boundary)); text = text.slice(boundary + 1);
            const promise = pending.get(message.id);
            if (promise) { pending.delete(message.id); if (message.ok) promise.resolve(message.result); else promise.reject(restoreNativeFailure(message)); }
          }
          outputBuffers.set(incarnation, text);
        }
        publish(frame);
      }
    });
    child.stderr.resume();
    const waitEvent = (kind, match = () => true) => bounded(new Promise((resolve, reject) => {
      const inspect = () => { const event = events.find(frame => frame.kind === kind && match(frame.payload)); if (event) { eventWaiters.delete(inspect); resolve(event.payload); } };
      eventWaiters.add(inspect); inspect();
      void closed.then(() => { eventWaiters.delete(inspect); reject(Error('supervisor closed before required event')); }, reject);
    }), 'supervisor ' + kind);
    const control = command => child.stdin.write(JSON.stringify({ version: 1, nonce: randomUUID(), ...command }) + '\n');
    child.stdin.write(JSON.stringify({ version: 1, kind: 'launch', node: pin(process.execPath), entry: pin(script), configuration: pin(controlConfig),
      cwd: output, args: ['--daemon-worker'], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: join(process.env.SystemRoot, 'System32') },
      maxRestarts: 8, restartBackoffMs: 50, lifetimeMs: 120000, outputLimitBytes: 8 * 1024 * 1024 }) + '\n');
    await waitEvent('supervisor_ready'); await waitEvent('daemon_started');
    const invoke = input => bounded(new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject });
      control({ kind: 'daemon-input', generation, data: Buffer.from(JSON.stringify({ id, input }) + '\n').toString('base64') });
    }), 'worker command');
    await invoke({ kind: 'configure', executable });
    return { child, invoke, relay: request => invoke({ kind: 'relay', request }), closed, events,
      stop: async () => {
        const oldGeneration = generation; control({ kind: 'interrupt-current', generation: oldGeneration });
        const facts = await waitEvent('daemon_exit', value => value.generation === oldGeneration);
        await waitEvent('daemon_started', value => value.generation > oldGeneration);
        await invoke({ kind: 'configure', executable }); return facts;
      } };
  }
  const errorSummary = error => {
    try { return { name: error instanceof Error ? error.name : 'ThrownValue',
      message: String(error instanceof Error ? error.message : error).slice(0, 4000), nativeFailure: projectNativeFailure(error?.nativeFailure) }; }
    catch { return { name: 'UnknownFailure', message: 'Failure could not be formatted' }; }
  };
  // Persist only fixed lifecycle facts. daemon_output contains guardian tickets
  // and application replies, so neither its payload nor arbitrary frames may escape.
  const lifecycleDiagnostics = (events, stopNonce) => {
    const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
    const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;
    const identity = value => ({ pid: integer(value?.pid), creationTime:
      typeof value?.creationTime === 'string' && /^\d{1,20}$/.test(value.creationTime) ? value.creationTime : null });
    const facts = value => value && typeof value === 'object' ? {
      launchIdentityDigest: hash(value.launchIdentityDigest),
      incarnationCount: Array.isArray(value.incarnations) ? value.incarnations.length : null,
      incarnations: Array.isArray(value.incarnations) ? value.incarnations.slice(0, 9).map(item => ({
        generation: integer(item?.generation), daemon: identity(item?.daemon), rootWaitObserved: item?.rootWaitObserved === true,
        exitCode: integer(item?.exitCode), stdoutEof: item?.stdoutEof === true, stderrEof: item?.stderrEof === true,
      })) : [],
    } : null;
    const reasons = new Set(['supervisor_admission_or_lifecycle_failed', 'stopped', 'output_failed', 'output_limit',
      'control_eof_or_invalid', 'lifetime_expired', 'restart_budget_exhausted']);
    const selected = [];
    for (const event of events) {
      const payload = event?.payload;
      if (!payload || typeof payload !== 'object') continue;
      let projected;
      if (event.kind === 'supervisor_ready') projected = {
        capability: payload.capability === 'artoo.windows-daemon-supervisor.v1' ? payload.capability : null,
        launchIdentityDigest: hash(payload.launchIdentityDigest), supervisor: identity(payload.supervisor),
      };
      else if (event.kind === 'supervisor_failed' || event.kind === 'supervisor_stopped') projected = {
        reason: reasons.has(payload.reason) ? payload.reason : 'unrecognized', facts: facts(payload.facts),
      };
      else if (event.kind === 'daemon_started' || event.kind === 'daemon_exit') projected = {
        generation: integer(payload.generation), daemon: identity(payload.daemon), rootWaitObserved: payload.rootWaitObserved === true,
        exitCode: integer(payload.exitCode), stdoutEof: payload.stdoutEof === true, stderrEof: payload.stderrEof === true,
      };
      else if (event.kind === 'command_ack' && payload.kind === 'stop' && payload.nonce === stopNonce) projected = {
        kind: 'stop', nonce: stopNonce, generation: integer(payload.generation),
      };
      else if (event.kind === 'native_failure_diagnostic') projected = projectNativeDiagnostic(payload);
      if (projected) selected.push({ kind: event.kind, sequence: integer(event.sequence), payload: projected });
    }
    return { version: 1, observedFrameCount: events.length, omittedLifecycleFrames: Math.max(0, selected.length - 24), frames: selected.slice(-24) };
  };
  async function stopSupervisor(lifetime) {
    const { child, closed, events } = lifetime, nonce = randomUUID();
    const report = { supervisorPid: child.pid ?? null, stopNonce: nonce, stopRequested: false, closure: null,
      stdoutEof: false, stderrEof: false, normalStopConfirmed: false };
    try {
      const alreadyTerminal = child.exitCode !== null || child.signalCode !== null
        || events.some(event => event.kind === 'supervisor_failed' || event.kind === 'supervisor_stopped');
      let written = Promise.resolve();
      if (!alreadyTerminal && !child.stdin.destroyed && !child.stdin.writableEnded) {
        report.stopRequested = true;
        written = new Promise((resolve, reject) => {
          child.stdin.write(JSON.stringify({ version: 1, kind: 'stop', nonce }) + '\n', error => error ? reject(error) : resolve());
        });
      }
      // Do not end stdin: an EOF is a different native stop reason. A write failure
      // also must not short-circuit observation of this original ChildProcess.
      const [ended, write] = await bounded(Promise.allSettled([closed, written]), 'original supervisor normal stop', 15000);
      if (ended.status === 'fulfilled') report.closure = ended.value;
      report.stdoutEof = lifetime.stdoutEof; report.stderrEof = lifetime.stderrEof;
      report.nativeLifecycle = lifecycleDiagnostics(events, nonce);
      report.nativeStderr = projectNativeFailure(nativeObservations.get(child));
      assert.equal(ended.status, 'fulfilled', 'original supervisor actual closure is required');
      assert.equal(write.status, 'fulfilled', 'normal stop must reach the original supervisor');
      assert.equal(alreadyTerminal, false, 'an earlier spontaneous supervisor exit is not normal fixture shutdown');
      assert.equal(report.stopRequested, true, 'normal stop was not requested');
      assert.equal(report.closure.code, 0, 'original supervisor normal stop exit code');
      assert.equal(report.closure.signal, null, 'original supervisor normal stop must not be signalled');
      assert.equal(report.stdoutEof, true, 'original supervisor stdout EOF');
      assert.equal(report.stderrEof, true, 'original supervisor stderr EOF');
      assert.equal(events.filter(event => event.kind === 'supervisor_failed').length, 0, 'native supervisor reported lifecycle failure');
      const acknowledgements = events.filter(event => event.kind === 'command_ack' && event.payload.nonce === nonce && event.payload.kind === 'stop');
      const stopped = events.filter(event => event.kind === 'supervisor_stopped');
      assert.equal(acknowledgements.length, 1, 'exact normal-stop command acknowledgement');
      assert.equal(stopped.length, 1, 'one native supervisor stop event');
      assert.equal(stopped[0].payload.reason, 'stopped', 'lifetime/budget/control failures are not normal stop');
      assert.ok(acknowledgements[0].sequence < stopped[0].sequence, 'stop event must follow its command acknowledgement');
      const generation = acknowledgements[0].payload.generation, facts = stopped[0].payload.facts;
      const ready = events.find(event => event.kind === 'supervisor_ready');
      assert.ok(ready && facts.launchIdentityDigest === ready.payload.launchIdentityDigest, 'stop remains bound to the original launch');
      assert.ok(Array.isArray(facts.incarnations) && facts.incarnations.length === generation + 1, 'complete original incarnation roster');
      for (const [index, incarnation] of facts.incarnations.entries()) {
        assert.equal(incarnation.generation, index); assert.equal(incarnation.rootWaitObserved, true, 'each original daemon HANDLE was waited');
      }
      const finalExit = events.find(event => event.kind === 'daemon_exit' && event.payload.generation === generation);
      assert.ok(finalExit && finalExit.payload.rootWaitObserved === true, 'last original daemon actually exited before supervisor shutdown');
      assert.deepEqual(finalExit.payload.daemon, facts.incarnations[generation].daemon);
      report.acknowledgement = acknowledgements[0]; report.stopped = stopped[0]; report.finalDaemonExit = finalExit;
      report.normalStopConfirmed = true; return { report };
    } catch (error) {
      report.stdoutEof = lifetime.stdoutEof; report.stderrEof = lifetime.stderrEof;
      report.nativeLifecycle = lifecycleDiagnostics(events, nonce);
      report.nativeStderr = projectNativeFailure(nativeObservations.get(child));
      report.error = errorSummary(error); return { report, error };
    }
  }
  const reserve = async (daemon, epoch, sessionId, operationId) => daemon.relay({ kind: 'reserve', epochId: epoch.epoch_id, sessionId,
    operationKind: 'author', operationId, bindingDigest: digest(operationId), serverOperation: { kind: 'validation', operationId,
      requestDigest: digest(`request:${operationId}`), runId: `run:${operationId}` } });
  async function setup(name) {
    const root = join(output, name), store = join(root, 'store'), workspace = join(root, 'workspace'), control = join(root, 'control'); mkdirSync(root); mkdirSync(store); mkdirSync(workspace); mkdirSync(control);
    const daemon = await worker(), sessionId = `old:${name}`;
    const initial = await daemon.invoke({ kind: 'bootstrap', sessionId, store, workspace, control });
    await daemon.relay({ kind: 'activate', epochId: initial.epoch.epoch_id, sessionId, registrationId: randomUUID(), registrationDigest: digest(`registration:${name}`) });
    return { daemon, initial, sessionId, store, workspace, control };
  }
  async function replacement(context) {
    const next = context.daemon; await next.invoke({ kind: 'connect', endpoint: context.initial.endpoint }); return next;
  }
  async function untilClosed(next) {
    const deadline = Date.now() + 12000;
    for (;;) {
      const status = await next.relay({ kind: 'status' });
      if (status.closed) return status;
      assert.ok(Date.now() < deadline, 'complete old roster must actually close'); await sleep(50);
    }
  }
  async function transfer(next, status, name) {
    const command = { kind: 'transfer', epochId: status.epoch.epoch_id, sessionId: `new:${name}`, challengeId: randomUUID(), requestDigest: digest(`recovery:${name}`),
      expectedRosterDigest: status.epoch.roster_digest, expectedRosterRevision: status.epoch.roster_revision,
      expectedNewDaemonIdentityDigest: status.newDaemonIdentityDigest };
    const result = await next.relay(command); assert.notEqual(result.newEpochId, result.oldEpochId); assert.equal(result.oldEpochId, status.epoch.epoch_id);
    assert.equal(result.rosterRevision, status.epoch.roster_revision); assert.equal(result.rosterDigest, status.epoch.roster_digest);
    assert.equal(result.closureSetDigest, digest(JSON.stringify(result.slots))); assert.ok(result.slots.every(slot => slot.terminal_digest));
    assert.deepEqual(await next.relay(command), result, 'lost reply replays only the exact current transfer');
    await assert.rejects(next.relay({ ...command, challengeId: randomUUID() }), /unavailable/);
    await assert.rejects(reserve(next, result.epoch, `new:${name}`, 'before-new-registration'), /unavailable/);
    await next.relay({ kind: 'activate', epochId: result.newEpochId, sessionId: `new:${name}`, registrationId: randomUUID(), registrationDigest: digest(`new-registration:${name}`) });
    const slot = await reserve(next, result.epoch, `new:${name}`, `new-operation:${name}`);
    return { result, slot };
  }
  let caseFailed = false, caseError, caseFailureBeforeCleanup, shutdown = [];
  try {
    for (const nonReading of [false, true]) {
      const name = nonReading ? 'sync-stdin-nonreader-deadline' : 'sync-utf8-large-stdin-and-eof', context = await setup(name);
      const slot = await context.daemon.relay({ kind: 'reserve', epochId: context.initial.epoch.epoch_id, sessionId: context.sessionId,
        operationKind: 'observer', operationId: name, bindingDigest: digest(name), serverOperation: null });
      const run = await context.daemon.invoke({ kind: 'sync-host', enrollment: slot, workspace: context.workspace, nonReading });
      const daemonClosure = await context.daemon.stop(), next = await replacement(context), status = await untilClosed(next);
      assert.equal(status.operations.length, 0, 'local collector never settles a Server operation');
      assert.equal(status.epoch.roster_revision, 1, 'local collector remains in the complete native roster');
      evidence.push({ name, run, daemonClosure, status, actualSyncHostClosed: true });
    }
    {
      const name = 'atomic-job-subtree-nested-host-and-grandchild-writer', context = await setup(name);
      const slot = await reserve(context.daemon, context.initial.epoch, context.sessionId, name);
      const host = await context.daemon.invoke({ kind: 'host', enrollment: slot, workspace: context.workspace, active: true, nested: true });
      const identitiesPath = join(context.workspace, 'nested-identities.json'), writerPath = join(context.workspace, 'child-writes.txt');
      const deadline = Date.now() + 10000;
      while (!existsSync(identitiesPath) || !existsSync(writerPath)) { assert.ok(Date.now() < deadline, 'nested writer actually starts'); await sleep(20); }
      const nested = JSON.parse(readFileSync(identitiesPath, 'utf8'));
      const members = [{ pid: host.rootPid, creationTime: host.rootCreationTime }, nested.host, nested.writer];
      const membership = await context.daemon.invoke({ kind: 'observe-members', slotId: slot.slotId, members });
      assert.equal(membership.members.length, members.length);
      for (const [index, member] of membership.members.entries()) {
        assert.equal(member.pid, members[index].pid); assert.equal(member.creationTime, members[index].creationTime);
        assert.equal(member.status, 'observed'); assert.equal(member.jobMember, true, 'original outer Job HANDLE contains every nested process');
      }
      const changedCreation = await context.daemon.invoke({ kind: 'observe-members', slotId: slot.slotId,
        members: [{ ...nested.writer, creationTime: (BigInt(nested.writer.creationTime) + 1n).toString() }] });
      assert.equal(changedCreation.members[0].status, 'unavailable', 'PID alone cannot stand in for the original process');
      const daemonClosure = await context.daemon.stop(), next = await replacement(context), status = await untilClosed(next);
      assert.equal(status.epoch.roster_revision, 1, 'the nested fixed tree is one independently registered slot');
      const retainedBytes = readFileSync(writerPath); await sleep(150); assert.deepEqual(readFileSync(writerPath), retainedBytes, 'writer stopped after real full Job closure');
      const result = await transfer(next, status, name);
      const freshHost = await next.invoke({ kind: 'host', enrollment: result.slot, workspace: context.workspace, active: false });
      evidence.push({ name, boundary: 'atomic-job-subtree.v1', nested, membership, changedCreation, daemonClosure, status,
        transfer: result.result, freshHost, independentNestedSlots: 0, writesStopped: true });
    }
    for (const active of [false, true]) {
      const name = active ? 'daemon-death-active' : 'terminal-retained-after-host-exit', context = await setup(name);
      const slot = await reserve(context.daemon, context.initial.epoch, context.sessionId, name);
      await assert.rejects(context.daemon.relay({ kind: 'attach', epochId: slot.epochId, slotId: slot.slotId, ticket: slot.ticket }), /unavailable/,
        'a generic native relay cannot impersonate the native Job host');
      const host = await context.daemon.invoke({ kind: 'host', enrollment: slot, workspace: context.workspace, active });
      if (active) {
        const deadline = Date.now() + 5000;
        while (!existsSync(join(context.workspace, 'child-writes.txt'))) { assert.ok(Date.now() < deadline); await sleep(20); }
      }
      const daemonClosure = await context.daemon.stop(), next = await replacement(context), status = await untilClosed(next);
      await assert.rejects(next.invoke({ kind: 'unrelated-supervisor-relay' }), /unavailable/,
        'same account and Node image do not replace the original supervisor HANDLE lineage');
      assert.equal(status.frozen, true); assert.equal(status.epoch.roster_revision, 1);
      const { result, slot: freshSlot } = await transfer(next, status, name);
      const freshHost = await next.invoke({ kind: 'host', enrollment: freshSlot, workspace: context.workspace, active: false });
      evidence.push({ name, daemonClosure, oldHost: host, oldStatus: status, transfer: result, freshHost,
        relayCannotForgeHost: true, unrelatedSupervisorRejected: true,
        retainedWorkspaceFiles: active ? ['root-writes.txt', 'child-writes.txt'] : [] }); await next.stop();
    }
    for (const lostHost of [false, true]) {
      const name = lostHost ? 'unsettled-host-lost' : 'pending-slot-gap', context = await setup(name);
      const slot = await reserve(context.daemon, context.initial.epoch, context.sessionId, name);
      if (lostHost) {
        await context.daemon.invoke({ kind: 'host', enrollment: slot, workspace: context.workspace, active: true });
        await context.daemon.invoke({ kind: 'kill-host', slotId: slot.slotId });
      }
      const daemonClosure = await context.daemon.stop(), next = await replacement(context), status = await next.relay({ kind: 'status' });
      assert.equal(status.frozen, true); assert.equal(status.closed, false);
      await assert.rejects(next.relay({ kind: 'transfer', epochId: status.epoch.epoch_id, sessionId: `new:${name}`, challengeId: randomUUID(),
        requestDigest: digest(name), expectedRosterDigest: status.epoch.roster_digest, expectedRosterRevision: status.epoch.roster_revision,
        expectedNewDaemonIdentityDigest: status.newDaemonIdentityDigest }), /unavailable/);
      evidence.push({ name, daemonClosure, status, unknownRetained: true }); await next.stop();
    }
    {
      const name = 'guardian-lost', context = await setup(name);
      await context.daemon.invoke({ kind: 'kill-guardian' }); await context.daemon.stop();
      const next = await replacement(context); await assert.rejects(next.relay({ kind: 'status' }), /unavailable/);
      assert.equal(JSON.parse(readFileSync(join(context.store, 'owner.lock'), 'utf8')).endpoint.guardianInstanceId, context.initial.endpoint.guardianInstanceId);
      evidence.push({ name, unknownRetained: true, ownerLockRetained: true }); await next.stop();
    }
    {
      const root = join(output, 'old-owner-lock'), store = join(root, 'store'), workspace = join(root, 'workspace'), control = join(root, 'control'); mkdirSync(root); mkdirSync(store); mkdirSync(workspace); mkdirSync(control);
      const old = '{"version":1,"owner":"old-H8-is-not-a-guardian"}'; writeFileSync(join(store, 'owner.lock'), old, { flag: 'wx' });
      const daemon = await worker(); await assert.rejects(daemon.invoke({ kind: 'bootstrap', sessionId: 'old-lock', store, workspace, control }), /unavailable/);
      assert.equal(readFileSync(join(store, 'owner.lock'), 'utf8'), old); evidence.push({ name: 'old-owner-lock', unchanged: true }); await daemon.stop();
    }
    {
      const root = join(output, 'old-actual-source-owner-lock'), store = join(root, 'store'), workspace = join(root, 'workspace'), control = join(root, 'control');
      mkdirSync(root); mkdirSync(store); mkdirSync(workspace); mkdirSync(control); mkdirSync(join(store, 'operations'));
      const ownerPath = join(store, 'operations', 'owner.lock'), old = '{"version":1,"pid":777,"owner":"real-H8-source-store-lock"}';
      writeFileSync(ownerPath, old, { flag: 'wx' }); const daemon = await worker();
      await assert.rejects(daemon.invoke({ kind: 'bootstrap', sessionId: 'old-actual-lock', store, workspace, control }), /unavailable/);
      assert.equal(readFileSync(ownerPath, 'utf8'), old); evidence.push({ name: 'old-actual-source-owner-lock', unchanged: true }); await daemon.stop();
    }
    assert.equal(evidence.length, 10, 'all native fixture cases completed');
    {
      const name = 'sync-host-daemon-death-while-blocking', context = await setup(name);
      const slot = await context.daemon.relay({ kind: 'reserve', epochId: context.initial.epoch.epoch_id, sessionId: context.sessionId,
        operationKind: 'observer', operationId: name, bindingDigest: digest(name), serverOperation: null });
      const scheduled = await context.daemon.invoke({ kind: 'sync-host-interruption', enrollment: slot, workspace: context.workspace });
      assert.equal(scheduled.scheduled, true);
      const markerPath = join(context.workspace, 'sync-target-started.json'), writesPath = join(context.workspace, 'sync-target-writes.txt');
      const returnPath = join(context.workspace, 'sync-returned.json'), auditPath = join(context.control, 'guardian-audit-v1.ndjson');
      const deadline = Date.now() + 10000;
      while (!existsSync(markerPath) || !existsSync(writesPath)) { assert.ok(Date.now() < deadline, 'actual synchronous target must start'); await sleep(20); }
      const target = JSON.parse(readFileSync(markerPath, 'utf8'));
      const audit = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const attached = audit.filter(value => value.kind === 'host_attached' && value.facts.slotId === slot.slotId);
      const enrolled = audit.filter(value => value.kind === 'root_enrolled' && value.facts.slotId === slot.slotId);
      assert.equal(attached.length, 1); assert.equal(enrolled.length, 1);
      assert.equal(target.parentPid, attached[0].facts.host.pid); assert.equal(target.pid, enrolled[0].facts.root.pid);
      assert.equal(audit.some(value => value.kind === 'terminal_observed'), false, 'registered sync host remains active before interruption');
      assert.equal(existsSync(returnPath), false, 'original daemon remains blocked in actual spawnSync');
      const daemonClosure = await context.daemon.stop();
      assert.equal(daemonClosure.daemon.pid, scheduled.daemonPid); assert.equal(daemonClosure.rootWaitObserved, true);
      const next = await replacement(context), status = await untilClosed(next);
      assert.equal(status.operations.length, 0); assert.equal(status.epoch.roster_revision, 1); assert.equal(status.frozen, true);
      assert.equal(existsSync(returnPath), false, 'interrupted daemon never resumed its synchronous caller');
      const stoppedWrites = readFileSync(writesPath); await sleep(150); assert.deepEqual(readFileSync(writesPath), stoppedWrites);
      const closureAudit = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const terminal = closureAudit.filter(value => value.kind === 'terminal_observed' && value.facts.slotId === slot.slotId);
      const acknowledged = closureAudit.filter(value => value.kind === 'terminal_ack_received' && value.facts.slotId === slot.slotId);
      assert.equal(terminal.length, 1); assert.equal(acknowledged.length, 1);
      assert.equal(terminal[0].facts.terminalDigest, acknowledged[0].facts.terminalDigest);
      const transferred = await transfer(next, status, name);
      const freshHost = await next.invoke({ kind: 'host', enrollment: transferred.slot, workspace: context.workspace, active: false });
      additionalRegressions.push({ name, scheduled, target, originalHost: attached[0].facts.host, originalRoot: enrolled[0].facts.root,
        daemonClosure, status, terminalDigest: terminal[0].facts.terminalDigest, actualSpawnSyncInterrupted: true,
        originalTerminalAckObserved: true, writesStopped: true, transfer: transferred.result, freshHost });
    }
    assert.equal(additionalRegressions.length, 1, 'required synchronous daemon-loss regression completed');
  } catch (error) {
    caseFailed = true; caseError = error; caseFailureBeforeCleanup = errorSummary(error);
    caseFailureBeforeCleanup.supervisorDiagnostics = [...workers].map(lifetime => ({
      supervisorPid: boundedInteger(lifetime.child.pid), nativeStderr: projectNativeFailure(nativeObservations.get(lifetime.child)),
    }));
  } finally {
    // Every spawn is retained before startup awaits, including failed startup.
    // Stop all original supervisors concurrently; no earlier rejection skips one.
    shutdown = await Promise.all([...workers].map(stopSupervisor));
  }
  const shutdownErrors = shutdown.filter(value => !value.report.normalStopConfirmed).map(value => value.error);
  const passed = !caseFailed && evidence.length === 10 && additionalRegressions.length === 1 && shutdownErrors.length === 0;
  try {
    writeFileSync(join(output, 'RESULT.json'), JSON.stringify({ version: 1, fixture: 'controlled-native-guardian', result: passed ? 'passed' : 'failed',
      cases: evidence.length, expectedCases: 10, manifestSha256: manifestSha, evidence,
      additionalRegressions, expectedAdditionalRegressions: 1,
      caseFailure: caseFailed ? caseFailureBeforeCleanup : null, caseFailureCapturedBeforeCleanup: caseFailed,
      supervisorShutdown: shutdown.map(value => value.report),
      normalSupervisorStopsConfirmed: shutdownErrors.length === 0, liveProviderAcceptance: false, productPublicationAcceptance: false,
      outerJobClosure: null, note: 'Supervisor stop is observed here. Root recorder must separately confirm outer Job zero and all pipes closed; retained guardians remain for that outer cleanup.' }, null, 2), { flag: 'wx' });
  } catch (error) {
    // Preserve the first case/closure failure even if its evidence cannot be saved.
    try { process.stderr.write(JSON.stringify({ fixture: 'controlled-native-guardian', resultWriteFailure: errorSummary(error) }) + '\n'); }
    catch { /* Reporting cannot replace the original case/closure failure below. */ }
    if (caseFailed) throw caseError;
    if (shutdownErrors.length) throw new AggregateError([...shutdownErrors, error], 'Supervisor shutdown failed and its result could not be saved');
    throw error;
  }
  if (caseFailed) throw caseError;
  if (shutdownErrors.length) throw new AggregateError(shutdownErrors, 'Original supervisor normal shutdown was not confirmed');
  process.stdout.write(JSON.stringify({ fixture: 'controlled-native-guardian', cases: evidence.length, output,
    additionalRegressions: additionalRegressions.length,
    result: 'passed', normalSupervisorStopsConfirmed: true, outerJobClosure: 'pending-root-observation' }) + '\n');
}
