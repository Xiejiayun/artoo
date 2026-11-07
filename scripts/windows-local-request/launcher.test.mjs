// Controlled launcher regression: real PowerShell/Node, deliberately fake entry.
// No Aerial, product runtime, native process host or product acceptance is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { StringDecoder } from 'node:string_decoder';

const directory = path.dirname(fileURLToPath(import.meta.url));
const runTest = (name, work) => test(name, { skip: process.platform !== 'win32' }, work);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => ({ path: file, bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) });
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const shutdown = '{"version":1,"kind":"shutdown"}\n';
const fixtureEnvironment = values => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !['ARTOO_CODEX_PROVIDER_KEY', 'NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase()))),
  ...values,
});
const entrySource = String.raw`
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const configuration = JSON.parse(fs.readFileSync(process.env.ARTOO_LAUNCHER_FIXTURE, 'utf8'));
const digest = value => value === undefined ? null : createHash('sha256').update(value).digest('hex');
const receipt = { argv: process.argv.slice(2), node: process.execPath, key_matches: digest(process.env.ARTOO_CODEX_PROVIDER_KEY) === configuration.key_sha256,
  node_options_absent: process.env.NODE_OPTIONS === undefined, node_path_absent: process.env.NODE_PATH === undefined };
fs.writeFileSync(configuration.started, JSON.stringify(receipt));
process.stdout.write('fixture-entry-ready\n');
process.stdout.write('fixture-unicode-中文\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (!input.includes('\n')) return;
  fs.writeFileSync(configuration.stdin, JSON.stringify({ exact_shutdown: input === '{"version":1,"kind":"shutdown"}\n' }));
  process.stdin.pause(); process.stdin.destroy(); process.exitCode = configuration.exit_code;
});
process.stdin.on('end', () => { if (!input.includes('\n')) process.exitCode = 91; });
`;
const driverSource = String.raw`
param([string]$Launcher, [string]$Configuration, [string]$Request, [string]$Mode, [string]$Receipt, [switch]$DefaultConfig)
$ErrorActionPreference = 'Stop'
$consoleInputEncoding = [Console]::InputEncoding; $consoleOutputEncoding = [Console]::OutputEncoding
$names = @('ARTOO_CODEX_PROVIDER_KEY', 'NODE_OPTIONS', 'NODE_PATH')
$before = @{}
foreach ($name in $names) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    $before[$name] = @{ present = $null -ne $value; value = $value }
}
$code = 1; $failure = $null
try {
    $arguments = @{}
    if (-not $DefaultConfig) { $arguments.Config = $Configuration }
    if ($Mode -like 'browser*') {
        $arguments.BrowserInput = $true
        if ($Mode -eq 'browser-objective') { $arguments.Objective = $Request }
        if ($Mode -eq 'browser-file') { $arguments.ObjectiveFile = $Request }
    }
    elseif ($Mode -eq 'file') { $arguments.ObjectiveFile = $Request } elseif ($Mode -ne 'prompt') { $arguments.Objective = $Request }
    & $Launcher @arguments
    $code = $LASTEXITCODE
}
catch { $failure = $_.Exception.Message; $code = 1 }
$restored = @{}; $environmentBefore = @{}
foreach ($name in $names) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    $restored[$name] = (($null -ne $value) -eq $before[$name].present -and $value -ceq $before[$name].value)
    $environmentBefore[$name] = @{ present = $before[$name].present; empty = $before[$name].value -ceq '' }
}
[IO.File]::WriteAllText($Receipt, (@{ exit_code = $code; failure = $failure; restored = $restored; environment_before = $environmentBefore
    console_restored = ([Console]::InputEncoding.Equals($consoleInputEncoding) -and [Console]::OutputEncoding.Equals($consoleOutputEncoding)) } | ConvertTo-Json -Depth 4))
exit $code
`;

function fixture() {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'artoo-daily-launcher-')));
  const local = path.join(root, 'local'), roaming = path.join(root, 'roaming'), installation = path.join(local, 'Artoo', 'windows-local-request');
  fs.mkdirSync(installation, { recursive: true }); fs.mkdirSync(path.join(roaming, 'aerial'), { recursive: true });
  const launcher = path.join(root, 'Start-ArtooDaily.ps1'), entry = path.join(root, 'start.mjs');
  fs.copyFileSync(path.join(directory, 'Start-ArtooDaily.ps1'), launcher); fs.writeFileSync(entry, entrySource);
  const driver = path.join(root, 'driver.ps1'); fs.writeFileSync(driver, driverSource);
  const manifestFile = path.join(installation, 'INSTALLATION.json'), configFile = path.join(installation, 'LOCAL-INSTALLATION.json');
  const nodePin = pin(fs.realpathSync.native(process.execPath));
  const manifest = { format: 'artoo.windows-single-goal-installation.v1', daemon: { root, manifest: pin(entry), tree: {} },
    server: { root, package_files: [], trees: [], dependencies: {} },
    programs: { node: nodePin, codex: nodePin, git: nodePin, browser: nodePin } };
  save(manifestFile, manifest);
  const configuration = { version: 1, installation: pin(manifestFile), runtime: { private_parent: root,
    provider_key_env: 'ARTOO_CODEX_PROVIDER_KEY', timeout_minutes: 90 },
    authorization: { scope: 'github-copilot-via-aerial', policy_version: 'sha256:' + 'a'.repeat(64) } };
  save(configFile, configuration);
  const started = path.join(root, 'STARTED.json'), stdin = path.join(root, 'STDIN.json'), receipt = path.join(root, 'DRIVER.json');
  const fixtureConfig = path.join(root, 'FIXTURE.json'), preload = path.join(root, 'preload.cjs'), injected = path.join(root, 'INJECTED');
  fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(injected)}, 'unexpected preload');`);
  let closed = false;
  return { root, roaming, manifest, configuration, nodePin,
    refreshManifest() { save(manifestFile, manifest); configuration.installation = pin(manifestFile); save(configFile, configuration); },
    refreshConfig() { save(configFile, configuration); },
    wrapConfig() { save(configFile, [configuration]); },
    wrapManifest() { save(manifestFile, [manifest]); configuration.installation = pin(manifestFile); save(configFile, configuration); },
    corruptConfig() { fs.writeFileSync(configFile, '{bad-json fixture-secret-must-not-leak'); },
    keyFile(value) { fs.writeFileSync(path.join(roaming, 'aerial', 'api_key'), value); },
    run({ key = 'fixture-process-key', expectedKey = key, keyName = 'ARTOO_CODEX_PROVIDER_KEY', emptyNodeEnvironment = false,
      objective = '建立 "便笺"；保留 `literal` 与 $characters', file = false, browserInput = false, browserConflict = null, defaultConfig = false, exitCode = 0 } = {}) {
      save(fixtureConfig, { started, stdin, key_sha256: expectedKey === null ? null : hash(expectedKey), exit_code: exitCode });
      const env = fixtureEnvironment({ APPDATA: roaming, LOCALAPPDATA: local, ARTOO_LAUNCHER_FIXTURE: fixtureConfig,
        NODE_OPTIONS: '--require ' + JSON.stringify(preload), NODE_PATH: path.join(root, 'untrusted-modules') });
      if (key !== null) env[keyName] = key;
      if (emptyNodeEnvironment) { env.NODE_OPTIONS = ''; env.NODE_PATH = ''; }
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', driver, '-Launcher', launcher, '-Configuration', configFile,
        '-Request', objective, '-Mode', browserInput ? (browserConflict ? 'browser-' + browserConflict : 'browser') : (file ? 'file' : 'objective'),
        '-Receipt', receipt, ...(defaultConfig ? ['-DefaultConfig'] : [])];
      const result = spawnSync('pwsh.exe', args, { env, input: shutdown, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      closed = !result.error && result.status !== null && result.signal === null;
      assert.equal(result.error, undefined, 'PowerShell must complete; uncertain fixtures are retained');
      assert.equal(result.signal, null); assert.equal(fs.existsSync(injected), false, 'Root Node preloads must be disabled');
      const report = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null;
      assert.ok(report, 'Original PowerShell driver must return after the launcher');
      assert.deepEqual(report.restored, { ARTOO_CODEX_PROVIDER_KEY: true, NODE_OPTIONS: true, NODE_PATH: true });
      assert.equal(report.console_restored, true, 'Caller Console encodings must be restored');
      if (fs.existsSync(started)) assert.ok(result.stdout.includes('fixture-unicode-中文'), 'Original Node Unicode output must remain intact');
      for (const secret of ['fixture-process-key', 'fixture-file-key', 'fixture-secret-must-not-leak'])
        assert.ok(!(result.stdout + result.stderr).includes(secret), 'Credentials must not enter output');
      return { result, report, started: fs.existsSync(started) ? JSON.parse(fs.readFileSync(started, 'utf8')) : null,
        stdin: fs.existsSync(stdin) ? JSON.parse(fs.readFileSync(stdin, 'utf8')) : null, objective };
    },
    async prompt() {
      const objective = '只输入一次 "原始需求"';
      save(fixtureConfig, { started, stdin, key_sha256: hash('fixture-process-key'), exit_code: 0 });
      const env = fixtureEnvironment({ APPDATA: roaming, LOCALAPPDATA: local, ARTOO_LAUNCHER_FIXTURE: fixtureConfig,
        ARTOO_CODEX_PROVIDER_KEY: 'fixture-process-key', NODE_OPTIONS: '--require ' + JSON.stringify(preload), NODE_PATH: path.join(root, 'untrusted-modules') });
      const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', driver, '-Launcher', launcher, '-Configuration', configFile,
        '-Request', 'unused', '-Mode', 'prompt', '-Receipt', receipt], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
      const stdoutRaw = [], stderrRaw = [], events = [], startedAt = Date.now();
      const event = (kind, fields = {}) => events.push({ elapsed_ms: Date.now() - startedAt, kind, ...fields });
      let output = '', errors = '', prompted = false, delivered = false, timedOut = false, actualExit, stdoutEof = false, stderrEof = false;
      const completion = new Promise((resolve, reject) => {
        child.once('error', error => { event('process-error', { code: error.code }); reject(error); });
        child.once('exit', (code, signal) => { actualExit = { code, signal }; event('exit', actualExit); });
        child.stdout.once('end', () => { stdoutEof = true; output += stdoutDecoder.end(); event('stdout-eof'); });
        child.stderr.once('end', () => { stderrEof = true; errors += stderrDecoder.end(); event('stderr-eof'); });
        child.stdin.on('error', reject);
        child.stdout.on('data', chunk => {
          stdoutRaw.push(Buffer.from(chunk)); output += stdoutDecoder.write(chunk); event('stdout', { bytes: chunk.length });
          if (!prompted && output.includes('请输入产品需求')) { prompted = true; event('objective-write'); child.stdin.write(objective + '\n'); }
          if (!delivered && output.includes('fixture-entry-ready')) { delivered = true; event('shutdown-write'); child.stdin.write(shutdown); }
        });
        child.stderr.on('data', chunk => { stderrRaw.push(Buffer.from(chunk)); errors += stderrDecoder.write(chunk); event('stderr', { bytes: chunk.length }); });
        child.once('close', (code, signal) => { event('close', { code, signal }); resolve({ code, signal }); });
      });
      // EOF here is failure cleanup only. It can never satisfy the successful
      // prompt/shutdown assertions, and timed-out evidence is never deleted.
      const timeout = setTimeout(() => { timedOut = true; event('timeout-eof'); child.stdin.end(); }, 15000);
      const hardFailure = setTimeout(() => {
        timedOut = true; event('hard-failure-detachment'); child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }, 20000);
      let actualClose;
      try { actualClose = await completion; }
      finally {
        clearTimeout(timeout); clearTimeout(hardFailure);
        save(path.join(root, 'PROMPT-OBSERVATIONS.json'), { fixture_only: true, pid: child.pid, events, prompted, delivered, timed_out: timedOut,
          exit: actualExit ?? null, close: actualClose ?? null, stdout_eof: stdoutEof, stderr_eof: stderrEof,
          stderr_prompt_seen: errors.includes('请输入产品需求'), stdout: output, stderr: errors,
          stdout_base64: Buffer.concat(stdoutRaw).toString('base64'), stderr_base64: Buffer.concat(stderrRaw).toString('base64') });
      }
      closed = !timedOut && actualExit?.signal === null && actualClose.signal === null && stdoutEof && stderrEof;
      assert.equal(timedOut, false, 'Interactive fixture timed out; retain evidence at ' + path.join(root, 'PROMPT-OBSERVATIONS.json'));
      assert.deepEqual(actualExit, { code: 0, signal: null }); assert.deepEqual(actualClose, actualExit);
      assert.equal(stdoutEof, true); assert.equal(stderrEof, true); assert.equal(prompted, true); assert.equal(delivered, true);
      assert.equal(output.split('请输入产品需求').length - 1, 1, 'Only one requirement prompt is allowed');
      assert.ok(!(output + errors).includes('fixture-process-key')); assert.equal(fs.existsSync(injected), false);
      const report = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      assert.deepEqual(report.restored, { ARTOO_CODEX_PROVIDER_KEY: true, NODE_OPTIONS: true, NODE_PATH: true });
      assert.equal(report.console_restored, true, 'Caller Console encodings must be restored');
      assert.ok(output.includes('fixture-unicode-中文'), 'Original Node Unicode output must remain intact');
      assert.deepEqual(JSON.parse(fs.readFileSync(started, 'utf8')).argv.slice(-2), ['--objective', objective]);
      assert.deepEqual(JSON.parse(fs.readFileSync(stdin, 'utf8')), { exact_shutdown: true });
    },
    cleanup() {
      if (!closed) return; // Do not delete files while any process closure is uncertain.
      const resolved = fs.realpathSync.native(root), relative = path.relative(parent, resolved);
      assert.equal(path.dirname(resolved), parent); assert.match(relative, /^artoo-daily-launcher-[^\\/]+$/u);
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

runTest('preserves one quoted objective, original stdin, selected Node and caller environment', () => {
  const f = fixture(); try {
    const r = f.run(); assert.equal(r.result.status, 0); assert.equal(r.report.exit_code, 0);
    assert.equal(r.started.node.toLowerCase(), f.nodePin.path.toLowerCase());
    assert.deepEqual(r.started.argv.slice(-2), ['--objective', r.objective]);
    assert.equal(r.started.argv.filter(arg => arg === '--stdin-control').length, 1);
    assert.equal(r.started.key_matches, true); assert.equal(r.started.node_options_absent, true); assert.equal(r.started.node_path_absent, true);
    assert.deepEqual(r.stdin, { exact_shutdown: true });
  } finally { f.cleanup(); }
});
runTest('existing process credential takes precedence and objective-file is one unchanged argument', () => {
  const f = fixture(); try {
    f.keyFile('fixture-file-key\r\n'); const objective = path.join(f.root, 'request with spaces.txt'); fs.writeFileSync(objective, '一次需求');
    const r = f.run({ file: true, objective }); assert.equal(r.result.status, 0);
    assert.deepEqual(r.started.argv.slice(-2), ['--objective-file', objective]); assert.equal(r.started.key_matches, true);
  } finally { f.cleanup(); }
});
runTest('local Aerial fallback restores absence and preserves the actual nonzero Node exit', () => {
  const f = fixture(); try {
    f.keyFile('fixture-file-key\r\n'); const r = f.run({ key: null, expectedKey: 'fixture-file-key', exitCode: 17 });
    assert.equal(r.result.status, 17); assert.equal(r.report.exit_code, 17); assert.equal(r.started.key_matches, true);
  } finally { f.cleanup(); }
});
runTest('preserves present empty Node environment values after temporarily removing them', () => {
  const f = fixture(); try {
    const r = f.run({ emptyNodeEnvironment: true }); assert.equal(r.result.status, 0);
    assert.deepEqual(r.report.environment_before.NODE_OPTIONS, { present: true, empty: true });
    assert.deepEqual(r.report.environment_before.NODE_PATH, { present: true, empty: true });
    assert.equal(r.started.node_options_absent, true); assert.equal(r.started.node_path_absent, true);
  } finally { f.cleanup(); }
});
runTest('Windows process credential name lookup is case insensitive and does not fall back', () => {
  const f = fixture(); try {
    f.keyFile('fixture-file-key'); const r = f.run({ keyName: 'artoo_codex_provider_key' });
    assert.equal(r.result.status, 0); assert.equal(r.started.key_matches, true);
    assert.deepEqual(r.report.environment_before.ARTOO_CODEX_PROVIDER_KEY, { present: true, empty: false });
  } finally { f.cleanup(); }
});
runTest('browser input delegates the only requirement to the browser without a Console prompt', () => {
  const f = fixture(); try {
    const r = f.run({ browserInput: true }); assert.equal(r.result.status, 0);
    assert.equal(r.started.argv.filter(arg => arg === '--browser-input').length, 1);
    assert.equal(r.started.argv.includes('--objective'), false); assert.equal(r.started.argv.includes('--objective-file'), false);
    assert.equal(r.result.stdout.includes('请输入产品需求'), false); assert.deepEqual(r.stdin, { exact_shutdown: true });
  } finally { f.cleanup(); }
});
for (const browserConflict of ['objective', 'file']) runTest(`rejects browser input with ${browserConflict} before entry execution`, () => {
  const f = fixture(); try {
    const r = f.run({ browserInput: true, browserConflict }); assert.equal(r.result.status, 1); assert.equal(r.started, null);
  } finally { f.cleanup(); }
});
runTest('uses the documented local config convention without inventing a missing credential', () => {
  const f = fixture(); try {
    const r = f.run({ key: null, expectedKey: null, defaultConfig: true });
    assert.equal(r.result.status, 0); assert.equal(r.started.key_matches, true);
  } finally { f.cleanup(); }
});
runTest('one interactive requirement prompt leaves the same stdin available for shutdown', async () => {
  const f = fixture(); try { await f.prompt(); } finally { f.cleanup(); }
});
for (const variant of ['empty-key', 'multiline-key', 'config-extra-field', 'manifest-extra-field', 'config-array', 'manifest-array', 'manifest-pin', 'node-hash',
  'node-size', 'relative-node', 'linked-node-parent', 'string-version', 'bool-version', 'malformed-json']) runTest(`rejects ${variant} before entry execution`, () => {
  const f = fixture(); try {
    let key = 'fixture-process-key';
    if (variant === 'empty-key') { key = ''; f.keyFile('fixture-file-key'); }
    if (variant === 'multiline-key') { key = 'fixture-process-key\nother'; f.keyFile('fixture-file-key'); }
    if (variant === 'config-extra-field') { f.configuration.extra = true; f.refreshConfig(); }
    if (variant === 'manifest-extra-field') { f.manifest.extra = true; f.refreshManifest(); }
    if (variant === 'config-array') f.wrapConfig();
    if (variant === 'manifest-array') f.wrapManifest();
    if (variant === 'manifest-pin') { f.configuration.installation.sha256 = '0'.repeat(64); f.refreshConfig(); }
    if (variant === 'node-hash') { f.manifest.programs.node.sha256 = '0'.repeat(64); f.refreshManifest(); }
    if (variant === 'node-size') { f.manifest.programs.node.bytes++; f.refreshManifest(); }
    if (variant === 'relative-node') { f.manifest.programs.node.path = 'node.exe'; f.refreshManifest(); }
    if (variant === 'linked-node-parent') {
      const alias = path.join(f.root, 'node-alias'); fs.symlinkSync(path.dirname(f.nodePin.path), alias, 'junction');
      f.manifest.programs.node.path = path.join(alias, path.basename(f.nodePin.path)); f.refreshManifest();
    }
    if (variant === 'string-version') { f.configuration.version = '1'; f.refreshConfig(); }
    if (variant === 'bool-version') { f.configuration.version = true; f.refreshConfig(); }
    if (variant === 'malformed-json') f.corruptConfig();
    const r = f.run({ key }); assert.equal(r.result.status, 1); assert.equal(r.started, null);
  } finally { f.cleanup(); }
});
