// Diagnostic r4 source only until Root schedules the reviewed native run.
// Arguments: complete native bundle directory, independently recorded manifest
// sha256:..., NEW evidence directory. Requires the ordinary compiled TS module.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadApplicationRuntimeHelperManifest } from '../dist/application-runtime-installation.js';

const [bundleArgument, manifestHash, outputArgument, ...extra] = process.argv.slice(2);
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64'); assert.equal(extra.length, 0);
assert.ok(bundleArgument && outputArgument && path.isAbsolute(bundleArgument) && path.isAbsolute(outputArgument));
assert.match(manifestHash ?? '', /^sha256:[a-f0-9]{64}$/);
const pin = file => {
  const absolute = fs.realpathSync.native(file), bytes = fs.readFileSync(absolute);
  return { path: absolute, bytes: bytes.length, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
};
const bundle = fs.realpathSync.native(bundleArgument), helper = pin(path.join(bundle, 'artoo-quickjs-process-host.exe'));
const manifest = pin(path.join(bundle, 'quickjs-native-manifest.json')); assert.equal(manifest.sha256, manifestHash);
const packagePins = loadApplicationRuntimeHelperManifest(helper, manifest);
const recheckPackage = () => assert.deepEqual(loadApplicationRuntimeHelperManifest(helper, manifest), packagePins);
const node = pin(process.execPath);
const fixtureSource = fileURLToPath(new URL('./quickjs-process-host-target.mjs', import.meta.url));
const fixturePin = pin(fixtureSource);
fs.mkdirSync(outputArgument); const output = fs.realpathSync.native(outputArgument);
fs.writeFileSync(path.join(output, 'INPUTS.json'), JSON.stringify({ helper, packagePins, node, fixturePin,
  controlled_development_fixture: true, generated_code_executed: false, product_qualified: false }, null, 2), { flag: 'wx' });
const receipts = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function launch(name, mode, lifetimeMs = 15000) {
  recheckPackage(); assert.deepEqual(pin(process.execPath), node); assert.deepEqual(pin(fixtureSource), fixturePin);
  const directory = path.join(output, name); fs.mkdirSync(directory);
  const entryPath = path.join(directory, 'application-runtime.mjs'), configPath = path.join(directory, 'application-runtime.json');
  fs.copyFileSync(fixtureSource, entryPath, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(configPath, JSON.stringify({ mode }), { flag: 'wx' });
  const entry = pin(entryPath), configuration = pin(configPath);
  const request = { version: 1, kind: 'launch', node, entry, configuration, runtimeFiles: [], cwd: directory, lifetimeMs };
  fs.writeFileSync(path.join(directory, 'launch.json'), JSON.stringify(request, null, 2), { flag: 'wx' });
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(systemRoot);
  const child = spawn(helper.path, ['--application-quickjs-owner-v1'], { windowsHide: true, shell: false, detached: false,
    cwd: bundle, env: { SystemRoot: systemRoot, WINDIR: systemRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
  const observations = { spawned: false, exited: false, closed: false, stdoutEof: false, stderrEof: false,
    exitCode: null, closeCode: null, signal: null, closeSignal: null, forcedHelperKill: false };
  const frames = [], rawOutput = [], rawErrors = [], targetOutput = [], targetErrors = [], controls = [], rawControls = [];
  const targetBytes = { stdout: 0, stderr: 0 }, faultEvidence = {};
  const childCreateMarkers = [];
  let childCreateRetained = Buffer.alloc(0), childCreateBytes = 0, childCreateResult;
  const recordChildCreateOutput = bytes => {
    childCreateBytes += bytes.length;
    assert.ok(childCreateBytes <= 2048, 'Child creation diagnostic output bound');
    childCreateRetained = Buffer.concat([childCreateRetained, bytes]);
    for (let end; (end = childCreateRetained.indexOf(10)) >= 0;) {
      assert.ok(end > 0 && end + 1 <= 512, 'Child creation diagnostic line bound');
      const line = childCreateRetained.subarray(0, end); childCreateRetained = childCreateRetained.subarray(end + 1);
      const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      assert.ok(record && typeof record === 'object' && !Array.isArray(record));
      assert.equal(childCreateResult, undefined, 'Child creation output after final result');
      if (Object.hasOwn(record, 'fixture')) {
        assert.deepEqual(Object.keys(record).sort(), ['callElapsedMs', 'elapsedMs', 'fixture', 'phase', 'sequence', 'version']);
        assert.equal(record.version, 1); assert.equal(record.fixture, 'quickjs-process-host-child-create');
        const index = childCreateMarkers.length;
        assert.ok(index < 3); assert.equal(record.sequence, index);
        assert.equal(record.phase, ['admission-parsed', 'child-create-before', 'child-create-returned'][index]);
        assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= (childCreateMarkers.at(-1)?.elapsedMs ?? 0));
        if (index === 2) assert.ok(Number.isFinite(record.callElapsedMs) && record.callElapsedMs >= 0 && record.callElapsedMs <= record.elapsedMs);
        else assert.equal(record.callElapsedMs, null);
        childCreateMarkers.push(record);
      } else {
        assert.equal(childCreateMarkers.length, 3, 'Child result requires all original phase markers');
        assert.deepEqual(Object.keys(record).sort(), ['childStarted', 'errorCode', 'status']);
        assert.equal(typeof record.childStarted, 'boolean');
        assert.ok(record.errorCode === null || (typeof record.errorCode === 'string' && record.errorCode.length > 0 && record.errorCode.length <= 128));
        assert.ok(record.status === null || Number.isInteger(record.status));
        childCreateResult = record;
      }
    }
    assert.ok(childCreateRetained.length < 512, 'Partial child creation diagnostic line bound');
  };
  let retained = Buffer.alloc(0), sequence = 0, controlSequence = 0, outputBytes = 0, errorBytes = 0, protocolFailure;
  let terminal, failure, closedResolve, closedReject;
  const closed = new Promise((resolve, reject) => { closedResolve = resolve; closedReject = reject; }); void closed.catch(() => {});
  const outer = setTimeout(() => { observations.forcedHelperKill = true; child.kill(); }, lifetimeMs + 8000);
  const uncertain = setTimeout(() => closedReject(Error('Original helper close remains unobserved')), lifetimeMs + 11000);
  child.once('spawn', () => { observations.spawned = true; });
  child.once('exit', (code, signal) => { observations.exited = true; observations.exitCode = code; observations.signal = signal; });
  for (const stream of [child, child.stdin, child.stdout, child.stderr]) stream.on('error', () => { failure ??= 'original-stream-error'; });
  child.stdout.on('data', bytes => {
    outputBytes += bytes.length;
    if (outputBytes > 25165824) { failure ??= 'helper-output-bound'; return; }
    rawOutput.push(Buffer.from(bytes)); retained = Buffer.concat([retained, bytes]);
    for (let end; (end = retained.indexOf(10)) >= 0;) {
      const line = retained.subarray(0, end); retained = retained.subarray(end + 1);
      try {
        assert.ok(line.length + 1 <= 65536); const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        assert.deepEqual(Object.keys(frame).sort(), ['kind', 'payload', 'sequence', 'version']);
        assert.equal(frame.version, 1); assert.equal(frame.sequence, sequence++); assert.equal(terminal, undefined);
        assert.ok(['started', 'admitted', 'input-written', 'input-closed', 'output', 'terminal'].includes(frame.kind));
        if (frame.kind === 'terminal') terminal = frame.payload;
        if (frame.kind === 'output') {
          const value = Buffer.from(frame.payload.data, 'base64');
          assert.ok(value.length > 0 && value.length <= 8192); assert.equal(value.toString('base64'), frame.payload.data);
          assert.ok(['stdout', 'stderr'].includes(frame.payload.stream));
          targetBytes[frame.payload.stream] += value.length;
          if (frame.payload.stream === 'stdout') {
            targetOutput.push(value);
            if (mode === 'deny-child') recordChildCreateOutput(value);
          } else targetErrors.push(value);
        }
        frames.push(frame);
      } catch (error) { protocolFailure ??= String(error); }
    }
    if (retained.length >= 65536) protocolFailure ??= 'partial-native-line-bound';
  });
  child.stderr.on('data', bytes => { errorBytes += bytes.length; if (errorBytes <= 16384) rawErrors.push(Buffer.from(bytes)); else failure ??= 'helper-stderr-bound'; });
  child.stdout.once('end', () => {
    observations.stdoutEof = true;
    if (retained.length) protocolFailure ??= 'partial-native-line';
    if (childCreateRetained.length) protocolFailure ??= 'partial-child-create-line';
  });
  child.stderr.once('end', () => { observations.stderrEof = true; });
  child.once('close', (code, signal) => {
    clearTimeout(outer); clearTimeout(uncertain);
    observations.closed = true; observations.closeCode = code; observations.closeSignal = signal;
    let unchanged = false;
    try { recheckPackage(); for (const saved of [node, entry, configuration]) assert.deepEqual(pin(saved.path), saved); unchanged = true; }
    catch { failure ??= 'fixture-inputs-changed'; }
    const receipt = { name, observations, terminal, protocolFailure, failure, unchanged, controls, rawControls, frames, targetBytes, faultEvidence,
      helperStderr: Buffer.concat(rawErrors).toString('utf8'),
      ...(mode === 'deny-child' ? { childCreate: { markers: childCreateMarkers, result: childCreateResult ?? null,
        partialBytes: childCreateRetained.length, bytes: childCreateBytes } } : {}) };
    receipts.push(receipt);
    fs.writeFileSync(path.join(directory, 'helper-stdout.bin'), Buffer.concat(rawOutput), { flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'helper-stderr.bin'), Buffer.concat(rawErrors), { flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'closure.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    closedResolve(receipt);
  });
  const send = (kind, data, alteration = {}) => {
    assert.equal(observations.closed, false);
    const command = { version: 1, sequence: controlSequence++, kind, nonce: randomUUID(), ...(data ? { data: data.toString('base64') } : {}) };
    assert.ok(Object.keys(alteration).every(key => ['sequence', 'nonce'].includes(key)));
    if (alteration.sequence !== undefined) command.sequence = alteration.sequence;
    if (alteration.nonce !== undefined) command.nonce = alteration.nonce;
    controls.push({ sequence: command.sequence, kind, nonce: command.nonce, bytes: data?.length ?? 0 });
    child.stdin.write(JSON.stringify(command) + '\n'); return command;
  };
  const wait = async (predicate, milliseconds = 10000) => {
    const expiry = performance.now() + milliseconds;
    for (;;) {
      assert.equal(protocolFailure, undefined); assert.equal(failure, undefined);
      assert.ok(performance.now() < expiry, 'Original helper event deadline');
      const value = predicate(); if (value) return value;
      assert.equal(observations.closed, false, 'Original helper closed before expected event');
      await delay(10);
    }
  };
  child.stdin.write(JSON.stringify(request) + '\n');
  return { closed, child, entry, directory, frames, send, wait, faultEvidence,
    output: (stream = 'stdout') => Buffer.concat(stream === 'stdout' ? targetOutput : targetErrors),
    outputBytes: stream => targetBytes[stream],
    rawControl(bytes) {
      assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 512);
      assert.equal(observations.closed, false);
      rawControls.push({ bytes: bytes.length, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') });
      child.stdin.write(bytes);
    },
    childCreateResult: () => childCreateResult,
    acknowledged: command => frames.find(frame => frame.kind === 'input-written' && frame.payload.nonce === command.nonce),
    async ready() {
      const admitted = await wait(() => frames.find(frame => frame.kind === 'admitted'));
      const started = frames.find(frame => frame.kind === 'started'); assert.ok(started);
      assert.equal(started.payload.image.toLowerCase(), node.path.toLowerCase()); assert.notEqual(started.payload.pid, child.pid);
      assert.match(started.payload.creationTime, /^\d{1,20}$/);
      assert.equal(started.payload.jobAssigned, true); assert.equal(started.payload.jobLimitsReadBack, true);
      assert.equal(started.payload.activeProcessLimit, 1); assert.equal(started.payload.processCommitLimitBytes, 1610612736);
      assert.ok(admitted.payload.remainingMs > 0 && admitted.payload.remainingMs < lifetimeMs);
    },
    async cancel() { child.stdout.resume(); if (!observations.closed) send('cancel'); return await closed; },
  };
}
function assertClosure(receipt, normal) {
  assert.equal(receipt.protocolFailure, undefined); assert.equal(receipt.failure, undefined); assert.equal(receipt.unchanged, true);
  const actual = receipt.observations;
  for (const key of ['spawned', 'exited', 'closed', 'stdoutEof', 'stderrEof']) assert.equal(actual[key], true, key);
  assert.equal(actual.forcedHelperKill, false); assert.equal(actual.signal, null); assert.equal(actual.closeSignal, null);
  const terminal = receipt.terminal; assert.ok(terminal);
  for (const kind of ['started', 'admitted', 'terminal']) assert.equal(receipt.frames.filter(frame => frame.kind === kind).length, 1, kind);
  assert.equal(terminal.pid, receipt.frames.find(frame => frame.kind === 'started').payload.pid);
  const writes = receipt.frames.filter(frame => frame.kind === 'input-written');
  assert.equal(new Set(writes.map(frame => frame.payload.nonce)).size, writes.length);
  for (const frame of writes) {
    const command = receipt.controls.find(value => value.nonce === frame.payload.nonce);
    assert.ok(command); assert.equal(command.kind, 'write'); assert.equal(frame.payload.bytes, command.bytes);
  }
  for (const key of ['originalExitObserved', 'jobAssigned', 'jobLimitsReadBack', 'jobEmptyObserved', 'inputSettled', 'inputClosed',
    'stdoutEof', 'stderrEof', 'outputTasksSettled', 'inputsUnchanged']) assert.equal(terminal[key], true, key);
  assert.equal(terminal.terminationRequested, !normal);
  if (normal) {
    assert.equal(terminal.failure, null); assert.equal(terminal.exitCode, 0); assert.equal(actual.exitCode, 0); assert.equal(actual.closeCode, 0);
    assert.equal(receipt.helperStderr, ''); assert.equal(writes.length, receipt.controls.filter(value => value.kind === 'write').length);
    const closed = receipt.frames.filter(frame => frame.kind === 'input-closed'); assert.equal(closed.length, 1);
    assert.equal(closed[0].payload.nonce, receipt.controls.find(value => value.kind === 'close-input').nonce);
  } else {
    assert.equal(terminal.terminationSucceeded, true); assert.notEqual(terminal.failure, null); assert.notEqual(actual.exitCode, 0); assert.notEqual(actual.closeCode, 0);
    assert.equal(receipt.helperStderr.trimEnd(), 'artoo-quickjs-process-host-failed');
  }
}

async function blockedWrite(run) {
  await run.wait(() => run.output().includes(Buffer.from('fixtureReady')));
  for (let index = 0; index < 64; index++) {
    const command = run.send('write', Buffer.alloc(16384, index)), expiry = performance.now() + 200;
    while (!run.acknowledged(command) && performance.now() < expiry) await delay(10);
    if (!run.acknowledged(command)) return command;
  }
  assert.fail('Fixture did not establish an unacknowledged original target write');
}
async function failedClosure(run, code) {
  const receipt = await run.closed; assertClosure(receipt, false);
  assert.equal(receipt.terminal.failure, code); return receipt;
}

let current;
try {
  current = launch('echo-and-pin-locks', 'echo'); await current.ready();
  // Exact fresh fixture paths only. No overwrite/delete is attempted; a failed
  // exclusion check preserves the original and any unexpectedly renamed file.
  assert.equal(path.dirname(current.entry.path), current.directory);
  assert.equal(path.dirname(current.directory), output);
  assert.throws(() => { const handle = fs.openSync(current.entry.path, 'r+'); fs.closeSync(handle); }, error => ['EACCES', 'EPERM', 'EBUSY'].includes(error.code));
  assert.throws(() => fs.renameSync(current.entry.path, current.entry.path + '.renamed'), error => ['EACCES', 'EPERM', 'EBUSY'].includes(error.code));
  const chunks = [Buffer.from('original binary pipe\0\xff', 'latin1'), Buffer.alloc(16384, 0xa5), Buffer.alloc(5000, 0x5a)];
  for (const [index, bytes] of chunks.entries()) {
    const command = current.send('write', bytes);
    const ack = await current.wait(() => current.acknowledged(command)); assert.equal(ack.payload.bytes, bytes.length);
    // In particular, the first 22-byte message must leave the native buffer
    // before the following 16 KiB write or input closure could flush it.
    const expected = Buffer.concat(chunks.slice(0, index + 1));
    const echoDeadline = performance.now() + 10000;
    await current.wait(() => {
      assert.ok(performance.now() < echoDeadline, 'Original cumulative echo deadline');
      return current.output().length >= expected.length;
    });
    assert.deepEqual(current.output(), expected);
  }
  const closeInput = current.send('close-input');
  await current.wait(() => current.frames.find(frame => frame.kind === 'input-closed' && frame.payload.nonce === closeInput.nonce));
  assertClosure(await current.closed, true); assert.deepEqual(current.output(), Buffer.concat(chunks)); current = undefined;

  current = launch('active-process-limit', 'deny-child'); await current.ready();
  // One original 10-second event deadline includes every marker and the real
  // child result. A marker is diagnostic evidence, never a successful denial.
  const childCreateDeadline = performance.now() + 10000;
  const denied = await current.wait(() => {
    assert.ok(performance.now() < childCreateDeadline, 'Original child-creation event deadline');
    return current.childCreateResult();
  });
  assert.equal(denied.childStarted, false); assert.ok(denied.errorCode);
  current.send('close-input'); assertClosure(await current.closed, true); current = undefined;

  current = launch('cancel-blocked-original-write', 'hold'); await current.ready();
  const blocked = await blockedWrite(current);
  const cancelled = await current.cancel(); assertClosure(cancelled, false);
  assert.equal(cancelled.terminal.failure, 'control-cancel'); assert.equal(current.acknowledged(blocked), undefined); current = undefined;

  current = launch('actual-control-eof', 'hold'); await current.ready(); current.child.stdin.end();
  const eof = await current.closed; assertClosure(eof, false); assert.equal(eof.terminal.failure, 'control-eof'); current = undefined;

  current = launch('original-request-deadline', 'hold', 5000); await current.ready();
  const expired = await current.closed; assertClosure(expired, false); assert.equal(expired.terminal.failure, 'request-deadline'); current = undefined;

  current = launch('malformed-control-after-admission', 'hold'); await current.ready();
  await current.wait(() => current.output().includes(Buffer.from('fixtureReady')));
  current.rawControl(Buffer.from('{"version":1,\n'));
  await failedClosure(current, 'control-invalid'); assert.equal(current.frames.filter(frame => frame.kind === 'input-written').length, 0); current = undefined;

  current = launch('partial-control-and-eof', 'hold'); await current.ready();
  await current.wait(() => current.output().includes(Buffer.from('fixtureReady')));
  current.rawControl(Buffer.from(JSON.stringify({ version: 1, sequence: 0, kind: 'cancel', nonce: randomUUID() })));
  current.child.stdin.end(); await failedClosure(current, 'control-partial-line');
  assert.equal(current.frames.filter(frame => frame.kind === 'input-written').length, 0); current = undefined;

  current = launch('wrong-control-sequence', 'hold'); await current.ready();
  await current.wait(() => current.output().includes(Buffer.from('fixtureReady')));
  const wrongSequence = current.send('write', Buffer.from([1]), { sequence: 1 });
  await failedClosure(current, 'control-sequence'); assert.equal(current.acknowledged(wrongSequence), undefined); current = undefined;

  current = launch('reused-control-nonce', 'echo'); await current.ready();
  const originalNonce = current.send('write', Buffer.from([1])); await current.wait(() => current.acknowledged(originalNonce));
  await current.wait(() => current.outputBytes('stdout') >= 1); assert.deepEqual(current.output(), Buffer.from([1]));
  current.send('write', Buffer.from([2]), { nonce: originalNonce.nonce });
  await failedClosure(current, 'control-nonce-reused');
  assert.equal(current.frames.filter(frame => frame.kind === 'input-written').length, 1);
  assert.deepEqual(current.output(), Buffer.from([1])); current = undefined;

  current = launch('concurrent-original-write-rejected', 'hold'); await current.ready();
  const pendingWrite = await blockedWrite(current), concurrentWrite = current.send('write', Buffer.from([1]));
  await failedClosure(current, 'control-write-budget');
  assert.equal(current.acknowledged(pendingWrite), undefined); assert.equal(current.acknowledged(concurrentWrite), undefined); current = undefined;

  for (const stream of ['stdout', 'stderr']) {
    current = launch('target-' + stream + '-overflow', stream + '-overflow'); await current.ready();
    await current.wait(() => current.output(stream === 'stdout' ? 'stderr' : 'stdout').includes(Buffer.from('fixtureReady')));
    const chunk = stream === 'stdout' ? 65536 : 8192, maximum = stream === 'stdout' ? 16777216 : 16384;
    // Keep each real burst below the helper queue bound and observe it before
    // allowing another. This tests the target stream cap, not helper saturation.
    for (let expected = chunk; expected <= maximum; expected += chunk) {
      const command = current.send('write', Buffer.from([1])); await current.wait(() => current.acknowledged(command));
      await current.wait(() => current.outputBytes(stream) >= expected); assert.equal(current.outputBytes(stream), expected);
    }
    current.send('write', Buffer.from([1])); await failedClosure(current, 'target-' + stream + '-limit');
    assert.equal(current.outputBytes(stream), maximum); current = undefined;
  }

  current = launch('parent-output-backpressure', 'output-pressure'); await current.ready();
  await current.wait(() => current.output().includes(Buffer.from('fixtureReady')));
  const beforePressure = current.outputBytes('stdout'), pressureStarted = performance.now();
  const highWaterMark = current.child.stdout.readableHighWaterMark;
  assert.ok(Number.isInteger(highWaterMark) && highWaterMark > 0 && highWaterMark <= 65536);
  current.child.stdout.pause(); assert.equal(current.child.stdout.isPaused(), true);
  const pressureWrite = current.send('write', Buffer.from([1]));
  const checkpoint = path.join(current.directory, 'fixture-output-written.json');
  await current.wait(() => fs.existsSync(checkpoint) && current.child.stdout.readableLength >= highWaterMark);
  assert.deepEqual(JSON.parse(fs.readFileSync(checkpoint, 'utf8')), { version: 1, phase: 'stdout-writes-complete', bytes: 524288 });
  current.faultEvidence.backpressure = { checkpoint: pin(checkpoint), highWaterMark,
    readableLength: current.child.stdout.readableLength, paused: current.child.stdout.isPaused(),
    observedOutputBytes: current.outputBytes('stdout'), elapsedMs: performance.now() - pressureStarted,
    triggerNonce: pressureWrite.nonce, checkpoint_is_closure_evidence: false };
  assert.equal(current.outputBytes('stdout'), beforePressure);
  assert.equal(current.child.stdout.isPaused(), true);
  current.faultEvidence.backpressure.cancelAtMs = performance.now() - pressureStarted;
  current.send('cancel'); await delay(200); current.child.stdout.resume();
  current.faultEvidence.backpressure.resumedAtMs = performance.now() - pressureStarted;
  // Resume within the existing cleanup budget to collect the actual original
  // terminal/EOFs. Do not claim that target exit was observed while paused.
  await failedClosure(current, 'control-cancel');
  // Cancellation may suppress bytes not yet relayed, or an ACK not yet sent.
  // Any ACK is still checked against the actual original one-byte command.
  assert.ok(current.outputBytes('stdout') > beforePressure && current.outputBytes('stdout') <= beforePressure + 524288);
  current = undefined;

  assert.equal(receipts.length, 13);
  fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify({ passed: true, cases: 13, receipts,
    controlled_development_fixture: true, quickjs_executed: false, product_qualified: false }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: true, cases: 13, output }));
} catch (error) {
  let closureError;
  if (current) { try { await current.cancel(); } catch (closed) { closureError = String(closed); } }
  fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify({ passed: false, error: String(error), closureError, receipts,
    controlled_development_fixture: true, quickjs_executed: false, product_qualified: false }, null, 2), { flag: 'wx' });
  throw error;
}
