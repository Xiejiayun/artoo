// Source only until separately scheduled. No provider, server authentication or
// publication claim. All evidence is retained; no retries, EA/timestamp setters,
// process-name killing, permissive ACL callback or production test hook is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const script = realpathSync.native(fileURLToPath(import.meta.url));
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const modules = ['windows-release-storage.js', 'windows-local-acl.js', 'windows-sealed-record-observer.js',
  'windows-process-installation.js', 'windows-supervisor-authority.js', 'source-command-diagnostics.js',
  'owned/windows-owned-process.js', 'owned/windows-runtime-guardian.js', 'owned/windows-guardian-scope.js',
  'owned/windows-process-diagnostic.js'];
const inside = (root, path) => { const tail = relative(root, path); return tail === '' || !isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep); };
const save = (root, name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function pin(path) {
  assert.equal(realpathSync.native(path), path);
  const before = lstatSync(path, { bigint: true }); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
  // Fixture inputs bind independent expected bytes and physical identity. They
  // are not protected product dispatches; kernel-cache ctime is not a new test
  // requirement. Product audits below use the original-writer semantic contract.
  for (const field of ['dev', 'ino', 'size', 'mtimeNs']) assert.equal(after[field], before[field], 'Input changed during its original read');
  return { path, bytes: bytes.length, sha256: sha(bytes) };
}
function configuration(path, expectedSha256) {
  const pinned = pin(path), config = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(/^sha256:[a-f0-9]{64}$/.test(expectedSha256)); assert.equal(pinned.sha256, expectedSha256, 'Configuration differs from independent launch binding');
  assert.deepEqual(Object.keys(config).sort(), ['bundleDirectory', 'evidenceRoot', 'manifestSha256', 'modulePins', 'version']);
  assert.equal(config.version, 1); assert.ok(/^sha256:[a-f0-9]{64}$/.test(config.manifestSha256));
  assert.equal(realpathSync.native(config.bundleDirectory), config.bundleDirectory);
  assert.ok(isAbsolute(config.evidenceRoot) && realpathSync.native(dirname(config.evidenceRoot)) === dirname(config.evidenceRoot));
  assert.equal(inside(config.bundleDirectory, config.evidenceRoot) || inside(config.evidenceRoot, config.bundleDirectory), false);
  assert.deepEqual(config.modulePins.map(value => value.relative).sort(), [...modules].sort());
  for (const expected of config.modulePins) {
    assert.deepEqual(Object.keys(expected).sort(), ['bytes', 'relative', 'sha256']);
    const observed = pin(realpathSync.native(fileURLToPath(new URL('../dist/' + expected.relative, import.meta.url))));
    assert.equal(observed.bytes, expected.bytes); assert.equal(observed.sha256, expected.sha256, 'Module differs from independent configuration pin');
  }
  const manifest = pin(join(config.bundleDirectory, 'manifest.json')); assert.equal(manifest.sha256, config.manifestSha256);
  assert.deepEqual(pin(path), pinned, 'Configuration changed across admission');
  return { config, pinned };
}
function extractRaw(source, declaration) {
  const marker = declaration + ' = String.raw', index = source.indexOf(marker);
  assert.ok(index >= 0 && source.indexOf(marker, index + marker.length) < 0, 'Exactly one fixed collector literal is required');
  const spacing = source.slice(index + marker.length).match(/^[ \t]*`/); assert.ok(spacing, 'Only fixed raw template syntax is permitted');
  const start = index + marker.length + spacing[0].length, end = source.indexOf('`;', start); assert.ok(end > start);
  const body = source.slice(start, end); assert.equal(body.includes('`') || body.includes('${'), false, 'No evaluation or interpolation is permitted');
  return body;
}
function failure(error) { return { name: error instanceof Error ? error.name : 'ThrownValue', message: String(error?.message ?? error).slice(0, 4000) }; }
async function bounded(work, label, timeout) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' exceeded its original deadline')), timeout); })]); }
  finally { clearTimeout(timer); }
}

async function worker(config) {
  const storageApi = await import('../dist/windows-release-storage.js');
  const acl = await import('../dist/windows-local-acl.js');
  const observer = await import('../dist/windows-sealed-record-observer.js');
  const installation = await import('../dist/windows-process-installation.js');
  const supervisorApi = await import('../dist/windows-supervisor-authority.js');
  const guardianApi = await import('../dist/owned/windows-runtime-guardian.js');
  const scopeApi = await import('../dist/owned/windows-guardian-scope.js');
  const processes = await import('../dist/owned/windows-owned-process.js');
  const diagnosticsApi = await import('../dist/source-command-diagnostics.js');
  const diagnosticProjection = await import('../dist/owned/windows-process-diagnostic.js');
  const domain = await import('@artoo/domain');
  const root = config.evidenceRoot, workspace = join(root, 'workspace'), storeRoot = join(root, 'guardian-store'), controlRoot = join(root, 'guardian-control');
  const source = readFileSync(new URL('../dist/windows-local-acl.js', import.meta.url), 'utf8');
  const plainScript = extractRaw(source, 'const SCRIPT');
  const observerSource = readFileSync(new URL('../dist/windows-sealed-record-observer.js', import.meta.url), 'utf8');
  assert.equal(extractRaw(observerSource, 'export const WINDOWS_SEALED_RECORD_OBSERVER_SCRIPT'), observer.WINDOWS_SEALED_RECORD_OBSERVER_SCRIPT);
  const sealedScript = observer.WINDOWS_SEALED_RECORD_OBSERVER_SCRIPT + plainScript;
  const backend = installation.prepareWindowsProcessInstallation({ directory: config.bundleDirectory, manifestSha256: config.manifestSha256,
    writableWorkspaceRoots: [workspace] });
  const options = directory => ({ directory, writableWorkspaceRoots: [workspace] });
  const guardianStorage = storageApi.prepareWindowsReleaseStorage(options(storeRoot));
  const controlStorage = storageApi.prepareWindowsReleaseStorage(options(controlRoot));
  const supervisor = await supervisorApi.prepareWindowsDaemonSupervisorAuthority(backend);
  const lineage = supervisorApi.readWindowsDaemonSupervisorAuthority(supervisor, backend);
  assert.equal(lineage.lifetimeOwnership?.sharedJob, true); assert.equal(lineage.lifetimeOwnership?.atomicDaemonMembership, true);
  const sessionId = 'sealed-collector-' + randomUUID();
  const guardian = await guardianApi.bootstrapWindowsGuardian(backend, { nodeId: 'native-sealed-collector', deviceId: 'current-windows', sessionId,
    configurationDigest: sha(JSON.stringify(config)), storeDirectory: storeRoot, workspaceRoot: workspace, storage: guardianStorage,
    controlDirectory: controlRoot, controlStorage, supervisor, topology: 'supervisor-plain-daemon.v1' });
  const registration = guardianApi.createWindowsGuardianRegistration(guardian);
  // Explicit controlled ACK, like the existing native Guardian fixture. It only
  // activates this test epoch; this is not authenticated-server acceptance.
  await guardianApi.acceptWindowsGuardianRegistration(guardian, { kind: 'command', id: 'controlled-native-registration',
    idempotency_key: 'controlled-native-registration', type: 'product.source.recovery.registered.v1', payload: { version: 1,
      registration_id: registration.registration_id, session_id: sessionId, status: 'accepted',
      registration_digest: domain.productSourceRecoveryRegistrationDigestV1(registration, sha) } });
  const cases = [], closures = [], timings = [];
  const diagnostics = diagnosticsApi.createSourceCommandDiagnostics(value => { if (value.observer_timing) timings.push(value.observer_timing); });
  const descriptor = name => ({ operationId: name, bindingDigest: sha('native-sealed-collector.v1:' + name), serverOperation: null });
  function inScope(name, work) {
    return scopeApi.withWindowsGuardianOperation(guardian, descriptor(name), () =>
      diagnostics.run({ type: 'product.source.operation.v1', id: name }, work));
  }
  function originalReceipt(receipt) {
    assert.equal(processes.isWindowsOwnedClosureReceipt(receipt), true); assert.equal(processes.isWindowsOwnedClosureReceipt({ ...receipt }), false);
    const projected = { ...diagnosticProjection.windowsProcessDiagnostic(receipt), rootPid: receipt.rootPid, rootCreationTime: receipt.rootCreationTime,
      rootExitCode: receipt.rootExitCode, elapsedMs: receipt.elapsedMs };
    closures.push(projected);
    for (const key of ['rootCreated', 'rootStarted', 'atomicJobMember', 'rootWaitObserved', 'stdoutEof', 'stderrEof', 'jobEmptyObserved',
      'helperSpawnObserved', 'helperExitObserved', 'helperCloseObserved', 'cleanupConfirmed']) assert.equal(receipt[key], true, 'Missing original ' + key);
    assert.equal(receipt.helperExitCode, 0); assert.equal(receipt.helperSignal, null); assert.equal(receipt.failureCode, null);
    assert.equal(receipt.terminationReason, null); assert.equal(receipt.rootExitCode, 0);
    return projected;
  }
  function originalCollector(name, targets, scriptText) {
    const input = JSON.stringify({ version: 1, paths: targets }), systemRoot = process.env.SystemRoot;
    const bindingDigest = sha(JSON.stringify({ version: 1, operation: descriptor(name).bindingDigest,
      collector: 'windows-local-acl', script: scriptText, input }));
    const slot = guardianApi.reserveWindowsGuardianSlotSync(guardian, { ...descriptor(name), bindingDigest, operationKind: 'observer' });
    let result;
    try { result = processes.startWindowsGuardianObserverSync(backend, { executable: join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', scriptText], cwd: workspace, timeoutMs: 45000, cleanupTimeoutMs: 10000,
      maxOutputBytes: 4 * 1024 * 1024, normalExitPolicy: 'require-empty', normalExitGraceMs: 250, guardianSlot: slot,
      inputBytes: Buffer.from(input), env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32'),
        PSModulePath: join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });
    } catch (error) {
      if (processes.isWindowsOwnedClosureReceipt(error?.receipt)) closures.push(diagnosticProjection.windowsProcessDiagnostic(error.receipt));
      throw error;
    }
    const receipt = originalReceipt(result.receipt), report = JSON.parse(result.stdout.toString('utf8'));
    save(root, name + '.json', { version: 1, scriptSha256: sha(scriptText), inputSha256: sha(input), receipt,
      stderrBytes: result.stderr.length, stderrSha256: sha(result.stderr), report });
    return report;
  }
  async function one(name, work) {
    const count = closures.length, timingCount = timings.length;
    try { const evidence = await inScope(name, work); cases.push({ name, outcome: 'passed', evidence,
      observedClosureCount: closures.length - count, observerTimings: timings.slice(timingCount) }); }
    catch (error) { cases.push({ name, outcome: 'failed', error: failure(error), observedClosureCount: closures.length - count,
      observerTimings: timings.slice(timingCount) }); throw error; }
    finally { save(root, name + '-case.json', cases.at(-1)); }
  }
  const createStore = name => {
    const path = join(root, name); mkdirSync(path); mkdirSync(join(path, 'attestations'));
    return { path, authority: storageApi.prepareWindowsReleaseStorage(options(path)) };
  };
  const written = (target, operation) => {
    const payload = sha('native fixture payload:' + operation);
    storageApi.writeWindowsReleaseDispatch(target.authority, target.path, operation, payload, 'start');
    const path = join(target.path, 'attestations', 'dispatch-' + sha(operation).slice(7) + '.json');
    const expected = Buffer.from(JSON.stringify({ action: 'start', operation_id: operation, payload_digest: payload, version: 1 }));
    const stat = lstatSync(path, { bigint: true }); assert.equal(stat.size, BigInt(expected.length));
    return { path, expected, binding: { version: 1, dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(), sha256: sha(expected) } };
  };
  let failed;
  try {
    await one('ordinary-collector', () => {
      const target = createStore('ordinary-store'), targets = [{ path: target.path, directory: true, readAcl: true }];
      const report = originalCollector('ordinary-raw', targets, plainScript); assert.equal(report.nodes[0].sealed, undefined);
      const production = acl.collectWindowsAclFacts(targets); assert.equal(production.nodes[0].sealed, undefined);
      storageApi.auditWindowsReleaseStorage(target.authority, target.path);
      return { fixedScriptUsesAddType: plainScript.includes('Add-Type'), productionAuditPassed: true };
    });
    await one('sealed-collector', () => {
      const target = createStore('sealed-store'), record = written(target, 'sealed-positive');
      const before = lstatSync(record.path, { bigint: true });
      const report = originalCollector('sealed-raw', [{ path: record.path, directory: false, readAcl: true, sealed: record.binding }], sealedScript);
      const after = lstatSync(record.path, { bigint: true }), observation = report.nodes[0].sealed;
      assert.equal(observer.isWindowsSealedRecordAudit(observation, record.binding), true);
      for (const outer of [before, after]) for (const field of ['dev', 'ino', 'size', 'mtimeNs'])
        assert.equal(outer[field].toString(), record.binding[field], 'Outer inventory must retain the independent writer binding');
      assert.equal(observer.isWindowsSealedRecordIntegrity(observation, record.binding), true);
      return { fixedScriptSha256: sha(sealedScript), independentContentSha256: record.binding.sha256,
        sameHandleFacts: observation, outerCtimeNs: { before: before.ctimeNs.toString(), after: after.ctimeNs.toString() },
        ctimeOrEaChanged: before.ctimeNs !== after.ctimeNs || observation.before.ctimeNs !== observation.after.ctimeNs
          || !isDeepStrictEqual(observation.before.eas, observation.after.eas), cause: 'not-attributed' };
    });
    await one('fresh-sealed-production', () => {
      const fresh = createStore('sealed-fresh-store'), operation = 'sealed-first-production-audit', payload = sha(operation);
      storageApi.writeWindowsReleaseDispatch(fresh.authority, fresh.path, operation, payload, 'start');
      // No content read, independent hashing, syntax read or raw collector is
      // inserted between the actual writer and its first production audit.
      storageApi.auditWindowsReleaseStorage(fresh.authority, fresh.path);
      return { firstFreshProductionAuditPassed: true };
    });
    await one('sealed-byte-mutation', () => {
      const target = createStore('byte-mutation-store'), record = written(target, 'sealed-byte-mutation');
      assert.ok(inside(root, record.path)); writeFileSync(record.path, Buffer.concat([record.expected, Buffer.from('\n')]));
      assert.throws(() => storageApi.auditWindowsReleaseStorage(target.authority, target.path), /sealed dispatch identity changed/);
      return { intentionalFixtureMutation: 'append one byte to newly created fixture record', rejected: true };
    });
    await one('sealed-identity-substitution', () => {
      const target = createStore('identity-mutation-store'), record = written(target, 'sealed-identity-substitution');
      const retained = record.path + '.original'; assert.ok(inside(root, record.path) && inside(root, retained)); assert.equal(existsSync(retained), false);
      renameSync(record.path, retained); writeFileSync(record.path, record.expected, { flag: 'wx' });
      assert.throws(() => storageApi.auditWindowsReleaseStorage(target.authority, target.path), /sealed dispatch identity changed/);
      return { intentionalFixtureMutation: 'retain original and create replacement with identical bytes', rejected: true, originalRetained: true };
    });
  } catch (error) { failed = error; }
  const result = { version: 1, scope: 'controlled native collector and original process ownership only', controlledRegistrationAck: true,
    cases, closures, guardianObserverTimings: timings, kernelEaFabricated: false, nativeUnknownCtimeOnlyMutation: 'not-exercised; covered by separate controlled policy suite',
    ctimeOrEaChangeRequiredForQualification: false, ctimeOrEaChanged: cases.some(value => value.evidence?.ctimeOrEaChanged),
    failure: failed ? failure(failed) : null, supervisorLifetimeClosure: 'parent must verify the original supervisor terminal and actual close' };
  save(root, 'WORKER-RESULT.json', result);
  process.stdout.write(JSON.stringify({ version: 1, kind: 'fixture-complete', ok: !failed }) + '\n');
  // Remain in the original daemon until its supervisor receives the exact stop
  // command. Exiting early would exercise restart-budget behavior instead.
  setInterval(() => {}, 1000);
}

async function parent(configPath, config, configPin) {
  const root = config.evidenceRoot; assert.equal(existsSync(root), false, 'A fresh evidence directory is required'); mkdirSync(root);
  for (const name of ['workspace', 'guardian-store', 'guardian-control']) mkdirSync(join(root, name));
  const manifest = JSON.parse(readFileSync(join(config.bundleDirectory, 'manifest.json'), 'utf8'));
  const executable = join(config.bundleDirectory, manifest.executable); assert.ok(inside(config.bundleDirectory, executable));
  save(root, 'INPUTS.json', { version: 1, configuration: configPin, fixture: pin(script), node: pin(realpathSync.native(process.execPath)), config,
    scope: 'source-scheduled native fixture; never product or authenticated-server acceptance' });
  const systemRoot = process.env.SystemRoot, events = []; let stdout = '', daemonText = '', parseError, bytes = 0, workerDone;
  let spawned = false, exit, stdoutEof = false, stderrEof = false, stderrBytes = 0;
  const child = spawn(executable, ['--daemon-supervisor-v1'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32') } });
  child.stdin.on('error', () => {});
  const changed = new Set(); const notify = () => { for (const callback of changed) callback(); };
  const closed = new Promise((resolve, reject) => {
    child.once('spawn', () => { spawned = true; }); child.once('error', reject);
    child.once('exit', (code, signal) => { exit = { code, signal }; });
    child.once('close', (code, signal) => { if (!spawned || !exit || code !== exit.code || signal !== exit.signal) reject(Error('Original supervisor close is incomplete'));
      else resolve({ spawnObserved: true, exitObserved: true, closeObserved: true, code, signal, stdoutEof, stderrEof }); notify(); });
  }); void closed.catch(() => {});
  child.stdout.on('end', () => { stdoutEof = true; notify(); }); child.stderr.on('end', () => { stderrEof = true; notify(); });
  child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 65536) parseError ??= Error('Supervisor stderr bound exceeded'); notify(); });
  child.stdout.on('data', data => {
    try {
      bytes += data.length; assert.ok(bytes <= 4 * 1024 * 1024); stdout += data.toString('utf8');
      for (;;) {
        const boundary = stdout.indexOf('\n'); if (boundary < 0) break;
        const frame = JSON.parse(stdout.slice(0, boundary)); stdout = stdout.slice(boundary + 1);
        assert.equal(frame.version, 1);
        if (frame.kind === 'daemon_output') {
          if (frame.payload.stream === 'stdout') {
            daemonText += Buffer.from(frame.payload.data, 'base64').toString('utf8');
            for (;;) { const end = daemonText.indexOf('\n'); if (end < 0) break;
              const message = JSON.parse(daemonText.slice(0, end)); daemonText = daemonText.slice(end + 1);
              assert.equal(message.version, 1); assert.equal(message.kind, 'fixture-complete'); assert.equal(workerDone, undefined); workerDone = message;
            }
          }
        } else events.push(frame);
      }
    } catch (error) { parseError ??= error; }
    notify();
  });
  const wait = (predicate, label, timeout) => bounded(new Promise((resolve, reject) => {
    const check = () => { if (parseError) { changed.delete(check); reject(parseError); }
      else if (predicate()) { changed.delete(check); resolve(); } else if (exit) { changed.delete(check); reject(Error('Supervisor ended before ' + label)); } };
    changed.add(check); check();
  }), label, timeout);
  let failureValue, closure, stopNonce;
  try {
    child.stdin.write(JSON.stringify({ version: 1, kind: 'launch', node: pin(realpathSync.native(process.execPath)), entry: pin(script), configuration: configPin,
      cwd: root, args: ['--supervised-worker', configPath, configPin.sha256], env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32'),
        ARTOO_WINDOWS_SEALED_COLLECTOR_NATIVE_WINDOW: '1' }, maxRestarts: 0, restartBackoffMs: 0, lifetimeMs: 240000,
      outputLimitBytes: 4 * 1024 * 1024, lifetimeOwnership: { version: 1, cleanupTimeoutMs: 15000, gracefulStopMs: 1000 } }) + '\n');
    await wait(() => !!workerDone, 'original fixture worker', 220000);
    assert.equal(workerDone.ok, true, 'Worker qualification failed; retain its original evidence');
  } catch (error) { failureValue = failure(error); }
  finally {
    try {
      assert.equal(child.exitCode, null, 'Spontaneous supervisor exit is not normal stop');
      stopNonce = randomUUID();
      await new Promise((resolve, reject) => child.stdin.write(JSON.stringify({ version: 1, kind: 'stop', nonce: stopNonce }) + '\n', error => error ? reject(error) : resolve()));
      closure = await bounded(closed, 'original supervisor and lifetime Job closure', 25000);
      assert.equal(closure.code, 0); assert.equal(closure.signal, null); assert.equal(closure.stdoutEof, true); assert.equal(closure.stderrEof, true);
      const ack = events.filter(frame => frame.kind === 'command_ack' && frame.payload.kind === 'stop' && frame.payload.nonce === stopNonce);
      const stopped = events.filter(frame => frame.kind === 'supervisor_stopped');
      assert.equal(ack.length, 1); assert.equal(stopped.length, 1); assert.equal(stopped[0].payload.reason, 'stopped');
      assert.ok(ack[0].sequence < stopped[0].sequence); assert.equal(events.some(frame => frame.kind === 'supervisor_failed'), false);
      const lifetime = stopped[0].payload.facts.lifetimeClosure;
      for (const field of ['jobCreated', 'allRootsWaitObserved', 'jobEmptyObserved', 'allStdoutEof', 'allStderrEof', 'cleanupConfirmed']) assert.equal(lifetime[field], true, field);
      assert.equal(stdout, ''); assert.equal(daemonText, '');
    } catch (error) { failureValue ??= failure(error); }
    save(root, 'WINDOW-RESULT.json', { version: 1, workerCompleted: workerDone ?? null, originalSupervisorClosure: closure ?? null,
      stopNonce: stopNonce ?? null, lifecycleEvents: events, stderrBytes, failure: failureValue ?? null,
      evidenceRetained: true, noProcessNameKill: true, scope: 'native collector and complete original supervisor Job only; product acceptance remains separate' });
  }
  if (failureValue) throw Error(failureValue.message);
  process.stdout.write(JSON.stringify({ version: 1, evidenceRoot: root, status: 'native-fixture-complete', productQualified: false }) + '\n');
}

async function startup(config, configPin) {
  const root = config.evidenceRoot; assert.equal(existsSync(root), false); mkdirSync(root);
  const workspace = join(root, 'workspace'), store = join(root, 'store');
  mkdirSync(workspace); mkdirSync(store); mkdirSync(join(store, 'attestations'));
  save(root, 'INPUTS.json', { version: 1, configuration: configPin, fixture: pin(script), config,
    scope: 'startup Add-Type and fixed collector only; no Guardian, descendant Job or product qualification' });
  const storageApi = await import('../dist/windows-release-storage.js'), observer = await import('../dist/windows-sealed-record-observer.js');
  const plainScript = extractRaw(readFileSync(new URL('../dist/windows-local-acl.js', import.meta.url), 'utf8'), 'const SCRIPT');
  const scriptText = observer.WINDOWS_SEALED_RECORD_OBSERVER_SCRIPT + plainScript;
  let result, failureValue;
  try {
    const authority = storageApi.prepareWindowsReleaseStorage({ directory: store, writableWorkspaceRoots: [workspace] });
    const operationId = 'startup-native-sealed', payload = sha(operationId);
    storageApi.writeWindowsReleaseDispatch(authority, store, operationId, payload, 'start');
    const path = join(store, 'attestations', 'dispatch-' + sha(operationId).slice(7) + '.json');
    const expected = Buffer.from(JSON.stringify({ action: 'start', operation_id: operationId, payload_digest: payload, version: 1 }));
    const stat = lstatSync(path, { bigint: true });
    const binding = { version: 1, dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), sha256: sha(expected) };
    const input = JSON.stringify({ version: 1, paths: [{ path, directory: false, readAcl: true, sealed: binding }] });
    const systemRoot = process.env.SystemRoot, executable = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    let spawned = false, exited, stdoutEof = false, stderrEof = false, byteCount = 0, timedOut = false;
    const stdout = [], stderr = [];
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', scriptText], {
      cwd: systemRoot, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: systemRoot, WINDIR: systemRoot,
        PATH: join(systemRoot, 'System32'), PSModulePath: join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45000);
    const closure = await new Promise((resolve, reject) => {
      child.once('spawn', () => { spawned = true; }); child.once('error', reject);
      child.once('exit', (code, signal) => { exited = { code, signal }; });
      child.stdout.once('end', () => { stdoutEof = true; }); child.stderr.once('end', () => { stderrEof = true; });
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', bytes => {
        byteCount += bytes.length; if (byteCount > 4 * 1024 * 1024) { timedOut = true; child.kill('SIGKILL'); } else chunks.push(Buffer.from(bytes));
      });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ spawnObserved: spawned, exitObserved: !!exited,
        closeObserved: true, code, signal, exit: exited ?? null, stdoutEof, stderrEof, timedOut }); });
      child.stdin.end(input);
    }).finally(() => clearTimeout(timer));
    const output = Buffer.concat(stdout), errorOutput = Buffer.concat(stderr);
    writeFileSync(join(root, 'collector.stdout.txt'), output, { flag: 'wx' }); writeFileSync(join(root, 'collector.stderr.txt'), errorOutput, { flag: 'wx' });
    save(root, 'COLLECTOR-CLOSURE.json', { version: 1, ...closure, originalPid: child.pid ?? null, scriptSha256: sha(scriptText), inputSha256: sha(input),
      jobEmptyObserved: null, compilerDescendantClosure: 'not established by startup process closure; Guardian fixture required' });
    assert.equal(closure.spawnObserved, true); assert.equal(closure.exitObserved, true); assert.equal(closure.code, 0); assert.equal(closure.signal, null);
    assert.equal(closure.stdoutEof, true); assert.equal(closure.stderrEof, true); assert.equal(closure.timedOut, false);
    const report = JSON.parse(output.toString('utf8')), facts = report.nodes[0].sealed;
    assert.equal(observer.isWindowsSealedRecordAudit(facts, binding), true);
    assert.equal(observer.isWindowsSealedRecordIntegrity(facts, binding), true);
    result = { actualWriter: true, actualFixedPowerShellCollector: true, firstFreshProductionAuditPassed: false, sameHandleFacts: facts,
      ctimeOrEaChanged: facts.before.ctimeNs !== facts.after.ctimeNs || !isDeepStrictEqual(facts.before.eas, facts.after.eas),
      cause: 'not-attributed', guardianQualified: false };
    // Compilation/same-handle facts above are a separate case. The production
    // case writes a fresh dispatch and immediately audits it without pre-reading.
    const freshStore = join(root, 'fresh-store'); mkdirSync(freshStore); mkdirSync(join(freshStore, 'attestations'));
    const freshAuthority = storageApi.prepareWindowsReleaseStorage({ directory: freshStore, writableWorkspaceRoots: [workspace] });
    const freshOperation = 'startup-first-production-audit';
    storageApi.writeWindowsReleaseDispatch(freshAuthority, freshStore, freshOperation, sha(freshOperation), 'start');
    storageApi.auditWindowsReleaseStorage(freshAuthority, freshStore);
    result.firstFreshProductionAuditPassed = true;
  } catch (error) { failureValue = failure(error); }
  save(root, 'STARTUP-RESULT.json', { version: 1, result: result ?? null, failure: failureValue ?? null,
    scope: 'startup smoke only; no Guardian/Job/descendant-closure or metadata-cause claim' });
  if (failureValue) throw Error(failureValue.message);
  process.stdout.write(JSON.stringify({ version: 1, evidenceRoot: root, status: 'startup-smoke-complete', guardianQualified: false }) + '\n');
}

assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
assert.equal(process.env.ARTOO_WINDOWS_SEALED_COLLECTOR_NATIVE_WINDOW, '1', 'Root must schedule this native qualification');
const isWorker = process.argv[2] === '--supervised-worker';
const isStartup = process.argv[2] === '--startup';
const configPath = realpathSync.native(process.argv[isWorker || isStartup ? 3 : 2]);
const { config, pinned } = configuration(configPath, process.argv[isWorker || isStartup ? 4 : 3]);
if (isWorker) await worker(config);
else if (isStartup) await startup(config, pinned);
else await parent(configPath, config, pinned);
