// Developer-authored native-owner fault fixture. No QuickJS, Wasm, generated
// product, database or production sandbox qualification occurs in this target.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform, 'win32');
assert.deepEqual(process.execArgv, ['--max-old-space-size=256']);
assert.equal(process.argv.length, 5);
assert.equal(process.argv[2], '--application-runtime-v1');

async function reportChildCreation() {
  const started = process.hrtime.bigint();
  let sequence = 0;
  const writeLine = async value => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    assert.ok(bytes.length <= 512);
    // The following phase cannot begin until this original stdout write has
    // completed. Merely enqueueing a marker before spawnSync would not prove it.
    await new Promise((resolve, reject) => {
      process.stdout.write(bytes, error => { if (error) reject(error); else resolve(); });
    });
  };
  const marker = (phase, callElapsedMs = null) => writeLine({ version: 1,
    fixture: 'quickjs-process-host-child-create', sequence: sequence++, phase,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, callElapsedMs });
  // Mode selection has also completed by this point. If this first marker is
  // absent, entry loading/admission/configuration remain indistinguishable.
  await marker('admission-parsed');
  await marker('child-create-before');
  const callStarted = process.hrtime.bigint();
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore', timeout: 1000 });
  const callElapsedMs = Number(process.hrtime.bigint() - callStarted) / 1e6;
  await marker('child-create-returned', callElapsedMs);
  await writeLine({ childStarted: typeof child.pid === 'number' && child.pid > 0,
    errorCode: child.error?.code ?? null, status: child.status });
}

let first = Buffer.alloc(0), admitted = false, mode, outputCalls = 0, outputWork = Promise.resolve();
function outputTokens(bytes) {
  for (const token of bytes) {
    assert.equal(token, 1);
    const index = outputCalls++, standardError = mode === 'stderr-overflow';
    const fullCalls = standardError ? 2 : 256;
    assert.ok(index <= (mode === 'output-pressure' ? 0 : fullCalls));
    const count = mode === 'output-pressure' ? 524288 : index === fullCalls ? 1 : standardError ? 8192 : 65536;
    outputWork = outputWork.then(async () => {
      const stream = standardError ? process.stderr : process.stdout;
      await new Promise((resolve, reject) => {
        stream.write(Buffer.alloc(count, 0x71), error => { if (error) reject(error); else resolve(); });
      });
      if (mode === 'output-pressure') {
        // Fixed files in this newly created case only. The atomic checkpoint
        // proves this target write completed; it is not process/Job ownership.
        const pending = new URL('./fixture-output-written.pending.json', import.meta.url);
        const complete = new URL('./fixture-output-written.json', import.meta.url);
        assert.equal(existsSync(complete), false);
        writeFileSync(pending, JSON.stringify({ version: 1, phase: 'stdout-writes-complete', bytes: count }), { flag: 'wx' });
        renameSync(pending, complete);
      }
    });
    void outputWork.catch(error => { process.nextTick(() => { throw error; }); });
  }
}
process.stdin.on('data', bytes => {
  if (!admitted) {
    first = Buffer.concat([first, bytes]);
    const end = first.indexOf(10);
    if (end < 0) { assert.ok(first.length < 256); return; }
    assert.ok(end < 256);
    const admission = JSON.parse(first.subarray(0, end).toString('utf8'));
    assert.deepEqual(Object.keys(admission).sort(), ['kind', 'protocol', 'remainingMs', 'version']);
    assert.equal(admission.version, 1); assert.equal(admission.kind, 'admit');
    assert.equal(admission.protocol, 'artoo.application-runtime.v1');
    assert.ok(Number.isInteger(admission.remainingMs) && admission.remainingMs > 0 && admission.remainingMs <= 30000);
    // Nothing mode-specific, including child creation or config loading, occurs
    // before the actual native-generated admission bytes have been received.
    mode = JSON.parse(readFileSync(process.argv[3], 'utf8')).mode;
    assert.ok(['echo', 'hold', 'deny-child', 'stdout-overflow', 'stderr-overflow', 'output-pressure'].includes(mode)); admitted = true;
    bytes = first.subarray(end + 1); first = Buffer.alloc(0);
    if (mode === 'hold') {
      assert.equal(bytes.length, 0); process.stdin.pause();
      process.stdout.write('{"fixtureReady":true}\n');
      setInterval(() => {}, 1000); return;
    }
    if (mode === 'deny-child') {
      void reportChildCreation().catch(error => { process.nextTick(() => { throw error; }); });
    }
    if (['stdout-overflow', 'stderr-overflow', 'output-pressure'].includes(mode)) {
      // Readiness uses the other stream in overflow cases, so the tested stream
      // starts at zero and the exact native byte ceiling remains the trigger.
      (mode === 'stdout-overflow' ? process.stderr : process.stdout).write('{"fixtureReady":true}\n');
    }
  }
  if (mode === 'echo' && bytes.length) process.stdout.write(bytes);
  if (['stdout-overflow', 'stderr-overflow', 'output-pressure'].includes(mode) && bytes.length) outputTokens(bytes);
});
process.stdin.on('end', () => { assert.equal(admitted, true); });
