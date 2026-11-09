// Developer diagnostic child only. Root must supply a pinned plan and run it under its reviewed native owner.
// It never spawns a process, registers a guest host callback, or executes emitted product JavaScript.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const textSha = text => 'sha256:' + sha(Buffer.from(text, 'utf8'));
const filePins = files => [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  .map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text, 'utf8'), sha256: textSha(file.text) }));
let stage = 'startup', runtime, vm, namespace, compile, report;
const started = performance.now();
async function main() {
  if (process.argv.length !== 5 || process.argv[2] !== '--shared-kernel-parity-v1' || process.platform !== 'win32'
    || !isAbsolute(process.argv[3]) || !/^[a-f0-9]{64}$/u.test(process.argv[4])
    || process.execArgv.join(' ') !== '--max-old-space-size=256'
    || Object.keys(process.env).some(key => /^(NODE_OPTIONS|NODE_PATH|TSC_.*|NODE_INSPECTOR_IPC|VSCODE_INSPECTOR_OPTIONS)$/iu.test(key))) throw Error('startup');
  let token = '';
  for await (const chunk of process.stdin) { if (token.length + chunk.length > 32) throw Error('gate'); token += chunk.toString('ascii'); }
  if (token !== 'shared-kernel-parity-v1\n') throw Error('gate');
  const planBytes = readFileSync(process.argv[3]);
  if (planBytes.length > 512 * 1024 || sha(planBytes) !== process.argv[4]) throw Error('plan-pin');
  const plan = JSON.parse(planBytes.toString('utf8'));
  if (plan.version !== 1 || plan.qualified_for_product !== false || !Array.isArray(plan.files)) throw Error('plan');
  for (const key of ['guest_package', 'quickjs_root', 'expected_snapshot', 'fixture_cases', 'baseline_directory'])
    if (typeof plan[key] !== 'string' || !isAbsolute(plan[key])) throw Error('plan-path');
  const measured = new Map();
  for (const pin of plan.files) {
    if (!isAbsolute(pin.path) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 0 || !/^[a-f0-9]{64}$/u.test(pin.sha256)
      || measured.has(resolve(pin.path))) throw Error('pin-shape');
    measured.set(resolve(pin.path), pin);
  }
  const readPinned = path => {
    const pin = measured.get(resolve(path)); if (!pin) throw Error('unmeasured-input');
    const bytes = readFileSync(pin.path); if (bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) throw Error('input-pin'); return bytes;
  };
  const checkPins = () => { for (const pin of measured.values()) readPinned(pin.path); };
  const json = path => JSON.parse(readPinned(path).toString('utf8'));
  checkPins(); readPinned(process.execPath); readPinned(fileURLToPath(import.meta.url));
  const guestPackage = json(resolve(plan.guest_package, 'build.json'));
  assert.equal(guestPackage.format, 'artoo.application-compiler-guest-package.v1');
  assert.equal(guestPackage.qualified_for_product, false); assert.equal(guestPackage.compiler_version, '5.9.3');
  const compilerBytes = readPinned(guestPackage.typescript.path), bundle = readPinned(guestPackage.entry.path);
  assert.equal(compilerBytes.length, guestPackage.typescript.bytes); assert.equal(bundle.length, guestPackage.entry.bytes);
  assert.equal('sha256:' + sha(compilerBytes), guestPackage.typescript.sha256);
  assert.equal('sha256:' + sha(bundle), guestPackage.entry.sha256);
  assert.equal('sha256:' + sha(compilerBytes), 'sha256:3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675');
  const snapshot = json(plan.expected_snapshot), fixture = json(plan.fixture_cases);
  assert.equal(snapshot.version, 1); assert.equal(snapshot.libraries.length, 99); assert.equal(typeof snapshot.sdk, 'string');
  assert.equal(fixture.version, 1);
  assert.deepEqual(fixture.cases.map(item => item.id), ['positive-unicode', 'bad-type', 'bad-handler', 'invalid-surrogate']);
  const libraryPins = filePins(snapshot.libraries);
  assert.deepEqual(guestPackage.libraries.map(pin => ({ path: pin.logical_path, bytes: pin.bytes, sha256: pin.sha256 })), libraryPins);
  const cases = fixture.cases.map(item => {
    const replacements = new Map(item.replace.map(file => [file.path, file]));
    assert.equal(replacements.size, item.replace.length);
    assert.ok([...replacements.keys()].every(path => fixture.base_source.some(file => file.path === path)));
    const request = { version: 1, kind: 'compile', request_id: item.id,
      source: fixture.base_source.map(file => replacements.get(file.path) ?? file) };
    const stdin = json(resolve(plan.baseline_directory, 'baseline-' + item.id + '.stdin.bin'));
    const response = json(resolve(plan.baseline_directory, 'baseline-' + item.id + '.stdout.bin'));
    const closure = json(resolve(plan.baseline_directory, 'baseline-' + item.id + '.closure.json'));
    assert.deepEqual(stdin, request);
    for (const key of ['job_assigned', 'job_limits_read_back', 'input_settled', 'input_closed', 'original_exit_observed',
      'job_empty_observed', 'io_tasks_settled', 'stdout_eof', 'stderr_eof']) assert.equal(closure[key], true);
    assert.equal(closure.exit_code, 0); assert.equal(closure.stderr_bytes, 0);
    for (const key of ['stdout_overflow', 'stderr_overflow', 'termination_requested']) assert.equal(closure[key], false);
    for (const key of ['stdout_error', 'stderr_error', 'failure']) assert.equal(closure[key], null);
    assert.equal(response.version, 1); assert.equal(response.kind, 'compile-result');
    assert.equal(response.request_id, item.id); assert.equal(response.qualified_for_product, false);
    return { id: item.id, request, response };
  });
  const quickjs = resolve(plan.quickjs_root), vendor = path => resolve(quickjs, path);
  const fixedFiles = ['vendor/core/dist/index.mjs', 'vendor/core/dist/chunk-TAV5CUKK.mjs', 'vendor/core/dist/chunk-V2S4ZYJR.mjs',
    'vendor/core/dist/module-ES6BEMUI.mjs', 'vendor/release-sync/dist/index.mjs', 'vendor/release-sync/dist/ffi.mjs',
    'vendor/release-sync/dist/emscripten-module.mjs', 'vendor/ffi-types/dist/index.mjs'];
  for (const path of fixedFiles) readPinned(vendor(path));
  const allowed = new Set(fixedFiles.map(path => pathToFileURL(vendor(path)).href));
  const ffiUrl = pathToFileURL(vendor('vendor/ffi-types/dist/index.mjs')).href;
  const glueUrl = pathToFileURL(vendor('vendor/release-sync/dist/emscripten-module.mjs')).href;
  const builtins = new Set(['node:module', 'node:fs', 'node:path', 'node:url']);
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@jitl/quickjs-ffi-types' && context.parentURL && allowed.has(context.parentURL)) return { url: ffiUrl, shortCircuit: true };
    if (specifier === '@jitl/quickjs-wasmfile-release-sync/emscripten-module'
      && context.parentURL === pathToFileURL(vendor('vendor/release-sync/dist/index.mjs')).href) return { url: glueUrl, shortCircuit: true };
    if (builtins.has(specifier)) return next(specifier, context);
    const url = new URL(specifier, context.parentURL ?? import.meta.url).href;
    if (!allowed.has(url)) throw Error('module-not-in-fixed-closure');
    return { url, shortCircuit: true };
  } });
  stage = 'distribution-load';
  const core = await import(pathToFileURL(vendor('vendor/core/dist/index.mjs')).href);
  const baseVariant = (await import(pathToFileURL(vendor('vendor/release-sync/dist/index.mjs')).href)).default;
  stage = 'wasm-startup';
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 8192 });
  const variant = core.newVariant(baseVariant, { wasmBinary: readPinned(vendor('vendor/release-sync/dist/emscripten-module.wasm')), wasmMemory: memory,
    locateFile(name) { if (name !== 'emscripten-module.wasm') throw Error('unexpected-file-resolution'); return vendor('vendor/release-sync/dist/emscripten-module.wasm'); }, log() {},
    emscriptenModule: { thisProgram: 'shared-kernel-parity', arguments: [], print() { throw Error('unexpected-native-output'); }, printErr() { throw Error('unexpected-native-error-output'); } } });
  const module = await core.newQuickJSWASMModuleFromVariant(variant);
  runtime = module.newRuntime(); runtime.setMemoryLimit(384 * 1024 * 1024); runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(() => performance.now() - started > 110000);
  vm = runtime.newContext();
  const evaluateTrusted = (text, name) => {
    const result = vm.evalCode(text, name, { type: 'global' });
    if (result.error) { result.error.dispose(); throw Error('trusted-guest-evaluation-failed'); } return result.value;
  };
  stage = 'typescript-load'; evaluateTrusted(compilerBytes.toString('utf8'), 'fixed-typescript-5.9.3.js').dispose();
  stage = 'shared-kernel-load'; evaluateTrusted(bundle.toString('utf8'), 'application-compiler-guest.js').dispose();
  namespace = vm.getProp(vm.global, '__artooApplicationCompilerV1');
  compile = vm.getProp(namespace, 'compileApplicationGuestRequestJson');
  assert.equal(vm.typeof(compile), 'function');
  const comparisons = [];
  for (const item of cases) {
    stage = item.id;
    const input = vm.newString(JSON.stringify(item.request));
    let response;
    try { response = vm.callFunction(compile, vm.undefined, input); } finally { input.dispose(); }
    if (response.error) { response.error.dispose(); throw Error('guest-compile-failed'); }
    let result;
    try {
      assert.equal(vm.typeof(response.value), 'string');
      const text = vm.getString(response.value); if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw Error('fixed-fixture-output-limit');
      result = JSON.parse(text);
    } finally { response.value.dispose(); }
    // Compare the entire response, including every manifest field; no result normalization is allowed.
    assert.deepEqual(result, item.response);
    if (item.id === 'positive-unicode') {
      assert.equal(result.result.status, 'compiled');
      const sourcePins = filePins(item.request.source), artifactPins = filePins(result.result.files);
      assert.deepEqual(result.result.manifest, { version: 1, format: 'artoo.application-build-draft.v1', compiler_version: '5.9.3',
        compiler_lib_digest: textSha(JSON.stringify(libraryPins)), sdk_digest: textSha(snapshot.sdk),
        source_digest: textSha(JSON.stringify(sourcePins)), artifact_digest: textSha(JSON.stringify(artifactPins)),
        source_files: sourcePins, compiler_lib_files: libraryPins, artifact_files: artifactPins,
        execution: 'unavailable: native profile, isolated compiler process, protected staging and closure are not integrated' });
    } else { assert.equal(result.result.status, 'rejected'); assert.equal(Object.hasOwn(result.result, 'files'), false); }
    comparisons.push({ id: item.id, exact_complete_response_match: true, manifest_independently_recomputed: item.id === 'positive-unicode', response: result });
  }
  stage = 'final-pins'; checkPins();
  report = { version: 1, qualified_for_product: false, kind: 'shared-kernel complete-manifest development diagnostic', passed: true,
    comparisons, elapsed_ms: Math.round(performance.now() - started), wasm_memory_bytes: memory.buffer.byteLength };
}
try { await main(); }
catch { report = { version: 1, qualified_for_product: false, passed: false, stage }; process.exitCode = 1; }
finally {
  try { if (compile?.alive) compile.dispose(); if (namespace?.alive) namespace.dispose(); if (vm?.alive) vm.dispose(); if (runtime?.alive) runtime.dispose(); }
  catch { report = { version: 1, qualified_for_product: false, passed: false, stage: 'dispose' }; process.exitCode = 1; }
}
const output = JSON.stringify(report) + '\n';
if (Buffer.byteLength(output, 'utf8') > 1024 * 1024) { process.exitCode = 1; process.stdout.write('{"version":1,"qualified_for_product":false,"passed":false,"stage":"output-limit"}\n'); }
else process.stdout.write(output);
