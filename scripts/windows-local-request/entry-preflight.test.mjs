// Actual entry preflight only. The deliberately missing config prevents any application/model startup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'start.mjs');
const missing = path.join(os.tmpdir(), 'artoo-entry-no-config-' + randomUUID(), 'LOCAL-INSTALLATION.json');
assert.equal(fs.existsSync(missing), false);
async function rejected(args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(key.toUpperCase())));
  const child = spawn(process.execPath, [entry, '--config', missing, ...args], { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { exit: null, close: null, stdout_eof: false, stderr_eof: false, timed_out: false, output: '', stream_error: null };
  const timer = setTimeout(() => { result.timed_out = true; child.kill(); }, 10000);
  for (const stream of ['stdout', 'stderr']) {
    child[stream].once('end', () => { result[stream + '_eof'] = true; });
    child[stream].on('error', error => { result.stream_error = error; });
    child[stream].on('data', bytes => {
      result.output += bytes.toString('utf8');
      if (Buffer.byteLength(result.output) > 32768) { result.stream_error = Error('Preflight output exceeded bound'); child.kill(); }
    });
  }
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { result.exit = { code, signal }; });
      child.once('close', (code, signal) => { result.close = { code, signal }; resolve(); });
    });
  } finally { clearTimeout(timer); }
  assert.equal(result.timed_out, false); assert.equal(result.stream_error, null);
  assert.deepEqual(result.exit, { code: 1, signal: null }); assert.deepEqual(result.close, result.exit);
  assert.equal(result.stdout_eof, true); assert.equal(result.stderr_eof, true);
  return result.output;
}
test('browser and console objectives cannot both enter the real startup path', async () => {
  for (const args of [['--browser-input', '--objective', 'product'], ['--browser-input', '--objective-file', missing],
    ['--objective', 'product', '--objective-file', missing]]) {
    assert.match(await rejected(args), /Use only --browser-input, or one of/u);
  }
});
test('missing, duplicate and unknown input modes fail before metadata or application startup', async () => {
  assert.match(await rejected([]), /Use only --browser-input, or one of/u);
  assert.match(await rejected(['--browser-input', '--browser-input']), /Duplicate startup option/u);
  assert.match(await rejected(['--browser', '--objective', 'product']), /Unknown startup option/u);
});
test('browser-only input reaches the actual metadata boundary without requiring a fake objective', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  assert.match(await rejected(['--browser-input']), /ENOENT/u);
});
