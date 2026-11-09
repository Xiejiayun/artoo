import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Every source, bootstrap probe and resolver decoy below is developer-authored fixture
// text. Emitted product code is never imported, evaluated or run by this harness.
const [packageArgument, outputArgument] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
for (const value of [packageArgument, outputArgument]) assert.ok(value && path.isAbsolute(value));
const packageDirectory = fs.realpathSync.native(packageArgument);
fs.mkdirSync(outputArgument); const output = fs.realpathSync.native(outputArgument);
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const pin = file => { const bytes = fs.readFileSync(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) }; };
const manifestPath = path.join(packageDirectory, 'build.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.qualified_for_product, false);
assert.equal(manifest.compiler_version, '5.9.3');
assert.equal(manifest.libraries.length, 99);
const host = path.join(output, 'isolated-working-directory'); fs.mkdirSync(host);
const entry = path.join(host, 'application-compiler.cjs'); fs.copyFileSync(manifest.entry.path, entry, fs.constants.COPYFILE_EXCL);
assert.equal(pin(entry).sha256, manifest.entry.sha256);
const decoys = [];
for (const name of ['typescript', 'zod', 'source-map-support']) {
  const directory = path.join(host, 'node_modules', name); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ main: 'index.cjs' }), { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'index.cjs'), 'throw Error("TRUSTED_RESOLVER_DECOY_MUST_NOT_LOAD");\n', { flag: 'wx' });
  decoys.push(pin(path.join(directory, 'package.json')), pin(path.join(directory, 'index.cjs')));
}
fs.writeFileSync(path.join(host, 'tsconfig.json'), '{"compilerOptions":{"plugins":[{"name":"source-map-support"}]}}', { flag: 'wx' });
fs.writeFileSync(path.join(host, 'lib.es2023.d.ts'), 'This declaration decoy must not be read.', { flag: 'wx' });
decoys.push(pin(path.join(host, 'tsconfig.json')), pin(path.join(host, 'lib.es2023.d.ts')));
const bootstrap = fs.readFileSync(manifest.bootstrap.path, 'utf8');
const probe = path.join(host, 'trusted-bootstrap-probe.cjs');
fs.writeFileSync(probe, bootstrap + `
const blocked = ["typescript", "zod", "source-map-support", "inspector", "node:inspector", "node:module", "./node_modules/typescript/index.cjs"];
for (const name of blocked) {
  let denied = false;
  try { require(name); } catch (error) { denied = error.message === "application_compiler_runtime_dependency_denied"; }
  if (!denied) throw Error("Fixed bootstrap failed to deny dependency");
}
if (require.resolve !== undefined || !Object.isFrozen(require) || typeof require("node:crypto").createHash !== "function") throw Error("Resolver alias exposed");
process.stdout.write(JSON.stringify({ trusted_bootstrap_fixture: true, blocked: blocked.length }) + "\\n");
`, { flag: 'wx' });
const runtimeNode = pin(process.execPath);
const measured = [...new Map([...manifest.inputs, runtimeNode, ...decoys, pin(manifestPath), pin(manifest.entry.path),
  pin(entry), pin(probe), pin(fileURLToPath(import.meta.url))].map(item => [item.path, item])).values()];
const recheck = () => { for (const before of measured) assert.deepEqual(pin(before.path), before); };
recheck();
fs.writeFileSync(path.join(output, 'INPUT-PINS.json'), JSON.stringify(measured, null, 2), { flag: 'wx' });
const baseEnvironment = {};
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key] !== undefined) baseEnvironment[key] = process.env[key];
const cases = [];

async function run(name, input, { env = {}, args = ['--application-compiler-v1'], execArgs = [], selectedEntry = entry,
  closeStdout = false, closeStderr = false } = {}) {
  recheck();
  const inputPath = path.join(output, name + '.stdin'); fs.writeFileSync(inputPath, input, { flag: 'wx' });
  const inputPin = pin(inputPath), beforeEntry = pin(selectedEntry);
  const started = Date.now();
  const child = spawn(process.execPath, [...execArgs, selectedEntry, ...args], { cwd: host,
    env: { ...baseEnvironment, ...env }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const receipt = { name, pid: child.pid, input: inputPin, entry: beforeEntry, trusted_fixture_only: true,
    qualified_for_product: false, exitObserved: false, closeObserved: false, stdoutEof: false, stderrEof: false,
    stdoutObserverClosed: closeStdout, stderrObserverClosed: closeStderr,
    stdoutClosed: false, stderrClosed: false, timedOut: false, inputWritten: false, stdoutBytes: 0, stderrBytes: 0 };
  const stdout = [], stderr = []; let failure;
  const timer = setTimeout(() => { receipt.timedOut = true; child.kill(); }, 90000);
  child.on('error', error => { failure = error; });
  child.stdin.on('error', error => { receipt.stdinError = error.code; });
  child.stdout.on('data', chunk => { receipt.stdoutBytes += chunk.length; if (receipt.stdoutBytes > 100 * 1024 * 1024) { failure = Error('output-limit'); child.kill(); } else stdout.push(chunk); });
  child.stderr.on('data', chunk => { receipt.stderrBytes += chunk.length; if (receipt.stderrBytes > 4096) { failure = Error('stderr-limit'); child.kill(); } else stderr.push(chunk); });
  child.stdout.on('end', () => { receipt.stdoutEof = true; }); child.stderr.on('end', () => { receipt.stderrEof = true; });
  child.stdout.on('close', () => { receipt.stdoutClosed = true; }); child.stderr.on('close', () => { receipt.stderrClosed = true; });
  child.on('exit', (code, signal) => { receipt.exitObserved = true; receipt.exitCode = code; receipt.exitSignal = signal; });
  const closed = new Promise(resolve => child.on('close', (code, signal) => {
    receipt.closeObserved = true; receipt.closeCode = code; receipt.closeSignal = signal; resolve();
  }));
  // Close the observer's actual handle before sending input, so broken-pipe injection
  // is deterministic. This is intentionally NOT recorded as an observed child EOF.
  for (const [stream, requested] of [[child.stdout, closeStdout], [child.stderr, closeStderr]]) if (requested) {
    await new Promise(resolve => { stream.once('close', resolve); stream.destroy(); });
  }
  child.stdin.end(input, error => { if (!error) receipt.inputWritten = true; });
  await closed; clearTimeout(timer); receipt.elapsedMs = Date.now() - started;
  cases.push(receipt);
  fs.writeFileSync(path.join(output, name + '-closure.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  const outputBytes = Buffer.concat(stdout), errorBytes = Buffer.concat(stderr);
  fs.writeFileSync(path.join(output, name + '.stdout'), outputBytes, { flag: 'wx' });
  fs.writeFileSync(path.join(output, name + '.stderr'), errorBytes, { flag: 'wx' });
  recheck(); assert.deepEqual(pin(inputPath), inputPin); assert.deepEqual(pin(selectedEntry), beforeEntry);
  if (failure) throw failure;
  assert.equal(receipt.timedOut, false);
  for (const key of ['exitObserved', 'closeObserved', 'stdoutClosed', 'stderrClosed']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.stdoutEof, !closeStdout); assert.equal(receipt.stderrEof, !closeStderr);
  assert.equal(receipt.exitCode, receipt.closeCode); assert.equal(receipt.exitSignal, null); assert.equal(receipt.closeSignal, null);
  return { receipt, stdout: outputBytes, stderr: errorBytes.toString('utf8') };
}
const source = [
  { path: 'product/client/index.html', text: '<!doctype html><title>Trusted compiler fixture</title><script type="module" src="./main.js"></script>' },
  { path: 'product/client/main.ts', text: 'document.title = "Trusted fixture"; export {};' },
  { path: 'product/server/handler.ts', text: 'import type { ApplicationHandler } from "@artoo/application"; throw new Error("GENERATED_OUTPUT_MUST_NEVER_EXECUTE"); export const handle: ApplicationHandler = async () => ({ status: 200, body: { fixture: true } });' },
];
const request = files => ({ version: 1, kind: 'compile', request_id: 'trusted-fixture', source: files });
const encode = value => Buffer.from(JSON.stringify(value));
const successful = result => { assert.equal(result.receipt.exitCode, 0); assert.equal(result.stderr, ''); return JSON.parse(result.stdout.toString('utf8')); };
const failed = result => { assert.equal(result.receipt.exitCode, 1); assert.equal(result.stdout.length, 0); assert.equal(result.stderr, 'application_compiler_failed\n'); };
function compiled(result, files) {
  const reply = successful(result);
  assert.equal(reply.qualified_for_product, false); assert.equal(reply.result.status, 'compiled');
  assert.match(reply.result.manifest.execution, /^unavailable:/u);
  assert.equal(reply.result.manifest.compiler_version, '5.9.3');
  const pins = files => files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text), sha256: sha(Buffer.from(file.text)) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.equal(reply.result.manifest.source_digest, sha(Buffer.from(JSON.stringify(pins(files)))));
  assert.equal(reply.result.manifest.artifact_digest, sha(Buffer.from(JSON.stringify(pins(reply.result.files)))));
  return reply;
}

try {
  const ordinary = compiled(await run('compiled', encode(request(source))), source);
  assert.ok(ordinary.result.files.find(file => file.path === 'server/handler.js').text.includes('GENERATED_OUTPUT_MUST_NEVER_EXECUTE'));
  assert.ok(!ordinary.result.files.find(file => file.path === 'server/handler.js').text.includes('@artoo/application'));
  const invalidType = source.map(file => file.path.endsWith('main.ts') ? { ...file, text: 'export const value: number = "wrong";' } : file);
  const rejected = successful(await run('type-error', encode(request(invalidType))));
  assert.equal(rejected.result.status, 'rejected'); assert.equal(rejected.qualified_for_product, false);
  assert.ok(rejected.result.diagnostics.some(item => /^TS\d+$/u.test(item.code)));
  const runtimeSdk = source.map(file => file.path.endsWith('handler.ts') ? { ...file, text: 'import { ApplicationHandler } from "@artoo/application"; export {};' } : file);
  assert.equal(successful(await run('sdk-runtime-rejected', encode(request(runtimeSdk)))).result.diagnostics[0].code, 'sdk-runtime-import');
  for (const [name, value] of [
    ['caller-libraries', { ...request(source), libraries: [] }], ['caller-options', { ...request(source), compilerOptions: { plugins: [] } }],
    ['missing-request-id', { version: 1, kind: 'compile', source }],
  ]) failed(await run(name, encode(value)));
  failed(await run('multiple-requests', Buffer.concat([encode(request(source)), encode(request(source))])));
  failed(await run('invalid-utf8', Buffer.from([0xc3, 0x28])));
  failed(await run('wrong-argv', encode(request(source)), { args: ['--application-compiler-v2'] }));
  failed(await run('extra-node-argv', encode(request(source)), { execArgs: ['--no-warnings'] }));
  for (const [name, env] of [['node-options', { NODE_OPTIONS: '' }], ['node-path', { NODE_PATH: host }], ['tsc-env', { TSC_WATCHFILE: 'UseFsEvents' }]]) {
    failed(await run(name, encode(request(source)), { env }));
  }
  failed(await run('encoded-input-over-limit', Buffer.alloc(52 * 1024 * 1024 + 1, 32)));
  const maximumInput = Buffer.alloc(52 * 1024 * 1024, 32); encode(request(source)).copy(maximumInput);
  compiled(await run('encoded-input-at-limit', maximumInput), source);
  const handler = source[2], expanded = [{ path: 'product/client/index.html', text: '\0'.repeat(128 * 1024) }];
  for (let index = 0; index < 62; index++) expanded.push({ path: `product/client/asset-${index}.css`, text: '\0'.repeat(128 * 1024) });
  expanded.push({ path: 'product/client/final.css', text: '\0'.repeat(128 * 1024 - Buffer.byteLength(handler.text)) }, handler);
  const expandedBytes = encode(request(expanded)); assert.ok(expandedBytes.length > 48 * 1024 * 1024);
  assert.ok(expandedBytes.length < 52 * 1024 * 1024);
  const expandedResult = await run('json-expansion', expandedBytes);
  assert.ok(expandedResult.stdout.length > 48 * 1024 * 1024);
  compiled(expandedResult, expanded);
  const bootstrapReply = successful(await run('bootstrap-denial', Buffer.alloc(0), { selectedEntry: probe, args: [] }));
  assert.deepEqual(bootstrapReply, { trusted_bootstrap_fixture: true, blocked: 7 });
  const closedStdout = await run('broken-stdout', encode(request(source)), { closeStdout: true });
  failed(closedStdout);
  const closedStderr = await run('broken-stderr', Buffer.from('{}'), { closeStderr: true });
  assert.equal(closedStderr.receipt.exitCode, 1); assert.equal(closedStderr.stdout.length, 0); assert.equal(closedStderr.stderr, '');
  recheck();
  fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify({ passed: true, cases: cases.length, receipts: cases,
    qualified_for_product: false, native_isolation_qualified: false, generated_code_executed: false,
    packaging_inputs_unchanged: true, measured_inputs: measured.length, runtime_node: runtimeNode, resolver_decoys: decoys }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: true, cases: cases.length, output, qualified_for_product: false }));
} catch (error) {
  fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify({ passed: false, error: String(error), receipts: cases,
    qualified_for_product: false, native_isolation_qualified: false, generated_code_executed: false }, null, 2), { flag: 'wx' });
  throw error;
}
