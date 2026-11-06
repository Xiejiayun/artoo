import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Only this parent may pass. The child must retain five genuine test/hook failures.
test('settled fixture drains real Vitest body/setup timeouts without closing an active PGlite', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repository = process.env.ARTOO_SETTLED_FIXTURE_REPOSITORY ? resolve(process.env.ARTOO_SETTLED_FIXTURE_REPOSITORY) : resolve(here, '../../..');
  const output = process.env.ARTOO_SETTLED_FIXTURE_EVIDENCE ? resolve(process.env.ARTOO_SETTLED_FIXTURE_EVIDENCE) : mkdtempSync(join(tmpdir(), 'artoo-settled-evidence-'));
  if (process.env.ARTOO_SETTLED_FIXTURE_EVIDENCE) mkdirSync(output);
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const inputs = ['settled-server-timeout-child.ts', 'settled-server-timeout.config.mjs', 'settled-server-timeout-reporter.mjs',
    'settled-server-timeout.test.mjs', '../src/test-fixtures/settled-server-fixture.ts'].map(relative => {
    const path = resolve(here, relative); return { path, sha256: hash(path) };
  });
  const args = [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(here, 'settled-server-timeout.config.mjs'), '--configLoader', 'runner'];
  const record = { version: 1, scope: 'Real Vitest timeout regression using an actual in-memory PGlite; no native Windows Job evidence',
    inputs, command: [process.execPath, ...args], node_version: process.version, stdout_eof: false, stderr_eof: false, errors: [] };
  const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  save('inputs.json', record);
  const logs = ['stdout', 'stderr'].map(name => join(output, name + '.log'));
  for (const log of logs) writeFileSync(log, '', { flag: 'wx' });
  // All child execution is inside this one Node process and its Vitest worker threads.
  const child = spawn(process.execPath, args, { cwd: repository, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ARTOO_SETTLED_FIXTURE_OUTPUT: output, FORCE_COLOR: '0' } });
  record.pid = child.pid;
  child.stdout.on('data', bytes => appendFileSync(logs[0], bytes)); child.stderr.on('data', bytes => appendFileSync(logs[1], bytes));
  child.stdout.on('end', () => { record.stdout_eof = true; }); child.stderr.on('end', () => { record.stderr_eof = true; });
  child.on('error', error => { record.errors.push(String(error)); });
  child.on('exit', (code, signal) => { record.exit = { code, signal }; });
  const watchdog = setTimeout(() => { record.watchdog_expired = true; child.kill(); }, 60_000);
  try { await new Promise(done => child.on('close', (code, signal) => { record.close = { code, signal }; done(); })); }
  finally { clearTimeout(watchdog); save('process.json', record); }
  assert.equal(record.watchdog_expired, undefined); assert.deepEqual(record.errors, []);
  assert.deepEqual(record.exit, { code: 1, signal: null }); assert.deepEqual(record.close, { code: 1, signal: null });
  assert.equal(record.stdout_eof, true); assert.equal(record.stderr_eof, true);
  const report = JSON.parse(readFileSync(join(output, 'vitest-report.json'), 'utf8'));
  const end = JSON.parse(readFileSync(join(output, 'run-end.json'), 'utf8'));
  const names = ['body timeout drains original database query', 'ordinary assertion remains failed after safe close', 'native parameter case first',
    'native parameter case second', 'native explicit timeout is preserved', 'setup timeout drains late acquisition',
    'drain expiry retains late resource', 'next body is refused after uncertain closure'];
  const states = ['failed', 'failed', 'passed', 'passed', 'passed', 'failed', 'failed', 'failed'];
  assert.equal(report.numTotalTests, names.length); assert.equal(report.numFailedTests, 5); assert.equal(report.numPassedTests, 3);
  assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0); assert.equal(end.reason, 'failed'); assert.deepEqual(end.unhandledErrors, []);
  assert.deepEqual(end.cases.map(item => item.name), names); assert.deepEqual(end.cases.map(item => item.state), states);
  assert.deepEqual(report.testResults.flatMap(file => file.assertionResults.map(item => item.title)), names);
  assert.deepEqual(report.testResults.flatMap(file => file.assertionResults.map(item => item.status)), states);
  const messages = end.cases.map(item => item.errors.map(error => error.message).join('\n'));
  assert.match(messages[0], /Test timed out in 100ms/); assert.match(messages[1], /original fixture assertion/);
  assert.match(messages[5], /Hook timed out in 100ms/); assert.match(messages[6], /Test timed out in 100ms/);
  assert.match(messages[6], /Original fixture work did not settle/); assert.match(messages[7], /earlier fixture did not settle safely/);
  const events = readFileSync(join(output, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const event = (name, phase) => { const values = events.filter(item => item.name === name && item.event === phase); assert.equal(values.length, 1, name + ': ' + phase); return values[0]; };
  const order = (name, phases) => { const times = phases.map(phase => event(name, phase).at); for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], name + ': ' + phases.join(' -> ')); };
  order(names[0], ['drain-started', 'late-query-confirmed', 'body-settled', 'database-close-started', 'database-closed', 'cleanup-context-same', 'root-removed']);
  order(names[5], ['drain-started', 'resource-acquired', 'late-setup-query-confirmed', 'setup-settled', 'database-close-started', 'database-closed', 'cleanup-context-same', 'root-removed']);
  for (const name of names.slice(0, 6)) {
    assert.equal(existsSync(event(name, 'root-created').root), false); event(name, 'database-closed'); event(name, 'cleanup-context-same');
  }
  order(names[6], ['drain-started', 'retained', 'late-body-root-retained', 'body-settled', 'late-owned-close', 'close-confirmed']);
  const retained = event(names[6], 'root-created').root; assert.equal(existsSync(retained), true);
  assert.equal(readFileSync(join(retained, 'retained.txt'), 'utf8'), 'original timed-out case');
  assert.equal(events.some(item => item.event === 'unexpected-body-entered' || item.event === 'unexpected-global-cleanup'), false);
  event(names[2], 'parameter-context-confirmed'); event(names[3], 'parameter-context-confirmed');
  assert.equal(event(names[4], 'explicit-timeout-confirmed').timeout, 120000);
  for (const input of inputs) assert.equal(hash(input.path), input.sha256);
  save('result.json', { version: 1, passed: true, scope: 'Parent accepted five intentional child failures and three passes; child suite did not pass.',
    output, retained, inputs_unchanged: true, actual_child_exit: record.exit, actual_child_close: record.close, native_job_evidence: false });
  process.stdout.write(JSON.stringify({ passed: true, output, child_passed: false, expected_child_failures: 5, expected_child_passes: 3, retained }) + '\n');
});
