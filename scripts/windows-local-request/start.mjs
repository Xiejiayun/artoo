// Source-only draft. A reviewed installation and explicit local configuration are required before use.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { capture, recheck, check, copyTree, physical, reference, save, tree, sha } from './inputs.mjs';
import { researchRevisionFeature, requestSlotLayout, slotProfiles, slotSourceMappings,
  createSlotInstances, selectPublicationSlot } from './slots.mjs';
import { preparedRequest, prepareApplicationProfiles, confirmApplicationCapability, confirmApplicationPublication,
  stopApplicationGoal, applicationWorkerLifecycle, localJsonRequest, reconcilePreparedSubmission, retainPreparedGoalRecord } from './application.mjs';

const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  assert.ok(['--config', '--objective', '--objective-file', '--stdin-control', '--browser-input'].includes(name), 'Unknown startup option');
  assert.equal(Object.hasOwn(options, name), false, 'Duplicate startup option');
  if (name === '--stdin-control' || name === '--browser-input') { options[name] = true; continue; }
  assert.ok(index + 1 < args.length, 'Startup option needs a value'); options[name] = args[++index];
}
const submissionOwner = options['--browser-input'] ? 'browser' : 'console';
assert.equal(Number(Object.hasOwn(options, '--objective')) + Number(Object.hasOwn(options, '--objective-file')), submissionOwner === 'browser' ? 0 : 1,
  'Use only --browser-input, or one of --objective <text> / --objective-file <UTF-8 file>');
let objectiveSource;
const suppliedObjective = options['--objective-file'] === undefined ? options['--objective'] : (() => {
  const file = physical(path.resolve(options['--objective-file'])); objectiveSource = reference(file);
  assert.ok(objectiveSource.bytes <= 40000, 'Objective file exceeds 40,000 bytes');
  const value = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); check(objectiveSource); return value;
})();
if (submissionOwner === 'console') assert.equal(typeof suppliedObjective, 'string');
let objective = suppliedObjective?.trim();
if (objective !== undefined) assert.ok(objective.length >= 1 && objective.length <= 10000, 'Objective must contain 1–10,000 characters');
const inputs = await capture({ objective, submission_owner: submissionOwner, ...(options['--config'] ? { configuration_file: path.resolve(options['--config']) } : {}) }), output = inputs.output;
const applicationMode = inputs.product !== null, publishesApplication = inputs.product?.delivery === 'publication';
const entry = { version: 1, session_id: randomUUID(), request_key: randomUUID(), project_id: 'proj_artoo', actor_user_id: 'user_owner',
  submission_owner: submissionOwner, progress_updates: 'polling', request: preparedRequest(inputs.product),
  ...(submissionOwner === 'console' ? { objective } : {}) };
const providerKey = process.env[inputs.provider_key_env];
assert.ok(providerKey === undefined || typeof providerKey === 'string' && providerKey.length > 0 && providerKey.length <= 8192 && !/[\r\n\u0000]/u.test(providerKey),
  'The configured Aerial credential environment variable is invalid');
assert.equal(fs.existsSync(output), false, 'Every request needs a new private directory');
fs.mkdirSync(output); physical(output, true);
const make = (...parts) => { const dir = path.join(output, ...parts); fs.mkdirSync(dir); return physical(dir, true); };
const serverData = make('server-data'), temporary = make('temporary');
const privateBundle = path.join(output, 'bundle'); copyTree(inputs.bundle, privateBundle, inputs.bundle_tree);
const states = (applicationMode ? ['application'] : ['source', 'destination']).map(role => {
  make(role); const paths = Object.fromEntries(['workspace', 'source-store', 'recovery-control', 'research', 'evidence', 'release', 'config', 'codex-home', 'temporary']
    .map(name => [name, make(role, name)]));
  const slots = applicationMode ? [{ index: 0, workspace: paths.workspace, verification_profile_id: inputs.product.verification_profile_id }]
    : requestSlotLayout(output, role, entry.request.max_retries);
  if (slots.length > 1) make(role, 'slots');
  for (const slot of slots.slice(1)) {
    make(role, 'slots', String(slot.index));
    for (const name of ['workspace', 'release', 'evidence', 'config']) make(role, 'slots', String(slot.index), name);
  }
  return { role, paths, slots, discovery: null, child: null, closed: null, timer: null, stopWritten: false, emergencyRequested: false, pending: '', decoder: new StringDecoder('utf8'),
    totalBytes: 0, streams: { stdout: [], stderr: [] }, report: { role, discovery: { started: false, stopped: false, registry_disconnected: false },
      cli: { pid: null, spawned: false, exit: null, close: null, stdout_eof: false, stderr_eof: false, ready: null, stopped: null,
        shutdown_written: false, forced_root_kill: false }, registry_disconnected: false } };
});
const result = { version: 1, scope: 'windows-local-single-goal', configuration: inputs.configuration,
  product_mode: applicationMode ? 'application-' + inputs.product.delivery : 'static-web',
  installation_manifest: inputs.installation_manifest, output, objective_source: objectiveSource ?? null,
  started_at: new Date().toISOString(), nodes: states.map(state => state.report),
  authentication_scope: 'supported loopback development HTTP authorization; real API-issued device node tokens; dev node tokens disabled',
  transport_scope: applicationMode ? 'one native Windows daemon with its original IPC owner and paired WebSocket session, two independent agents on one physical computer'
    : 'two independent production Windows supervised CLIs and WebSocket sessions on one physical computer',
  publication_scope: applicationMode ? publishesApplication
    ? 'bounded original-session local application publication; one normal reopen, same URL and database, second owner held within configured lease and request limits'
    : 'verified application workspace only; no product publication'
    : 'configured local HTTP endpoint; held open after completion while healthy until user stop or a runtime limit; stops at CLI shutdown',
  provider: inputs.provider, submission_owner: submissionOwner, goal_posts: 0, logical_goals_created: 0,
  product_published: false, server_closed: false, errors: [], status: 'starting', retained: true,
  physical_multi_computer_verified: false, crash_recovery_verified: false, google_login_verified: false, public_deployment: false };
save(path.join(output, 'STARTED.json'), result);
const secrets = [providerKey];
const redact = value => secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value))
  .replace(/([?&]token=)[^\s&"']+/giu, '$1[REDACTED]');
const note = error => result.errors.push(redact(error?.stack ?? error).slice(0, 8000));
const userStop = Error('User requested normal shutdown');
let server, schema, domain, request, projectId, baselineGoals, publisherOwnership, diagnostics = 0;
let stopping = false, stopRequestedAt, preparedSubmissionClosing;
function closeApplicationSubmission() {
  if (!applicationMode || !server) return;
  if (!preparedSubmissionClosing) {
    // Call before yielding: the local Server closes admission synchronously.
    // Retain the same promise for finally, including any synchronous failure.
    try { preparedSubmissionClosing = Promise.resolve(server.closePreparedGoalSubmission({ session_id: entry.session_id, request_key: entry.request_key })); }
    catch (error) { preparedSubmissionClosing = Promise.reject(error); }
    void preparedSubmissionClosing.catch(() => {}); // Awaited and reported by finally.
  }
  return preparedSubmissionClosing;
}
const requestUserStop = () => {
  if (!stopping) stopRequestedAt = new Date().toISOString(); stopping = true;
  closeApplicationSubmission();
};
process.on('SIGINT', requestUserStop); process.on('SIGTERM', requestUserStop);
let controlPending = '', controlCommands = 0;
const controlData = bytes => {
  try {
    controlPending += bytes.toString('utf8'); assert.ok(Buffer.byteLength(controlPending) <= 4096, 'Shutdown control exceeded its bound');
    for (let end; (end = controlPending.indexOf('\n')) >= 0;) {
      const line = controlPending.slice(0, end); controlPending = controlPending.slice(end + 1);
      assert.equal(++controlCommands, 1, 'Only one shutdown command is permitted');
      let command;
      try { command = JSON.parse(line); } catch { throw Error('Invalid shutdown command'); }
      assert.ok(command && !Array.isArray(command) && command.version === 1 && command.kind === 'shutdown'
        && Object.keys(command).length === 2, 'Invalid shutdown command'); requestUserStop();
    }
  } catch (error) { note(error); requestUserStop(); }
};
const controlEnd = () => {
  if (controlPending.length || controlCommands !== 1) note(Error('Shutdown control closed without one complete shutdown command'));
  requestUserStop();
};
const controlError = error => { note(error); requestUserStop(); };
if (options['--stdin-control']) {
  process.stdin.on('data', controlData); process.stdin.once('end', controlEnd); process.stdin.once('error', controlError);
}
const checkpoint = () => { if (stopping) throw userStop; };
const knownConfig = [];
async function waitFor(predicate, label, timeout = 30000, observeStop = true, pollIntervalMs = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (observeStop) checkpoint(); if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, pollIntervalMs)); }
  throw Error('Timed out waiting for ' + label);
}
async function rows(name) {
  const found = await server.ctx.db.db.select().from(schema[name]).limit(10001);
  assert.ok(found.length <= 10000, 'Local record limit exceeded'); return found;
}
async function diagnosticSnapshot() {
  const tasks = (await rows('tasks')).filter(row => row.goalId === result.goal_id), ids = new Set(tasks.map(row => row.id));
  const runs = (await rows('runs')).filter(row => ids.has(row.taskId));
  const operations = {};
  for (const name of ['goalProductHandoffs', 'goalImportedProductReviews', 'goalImportedDesignContinuations', 'goalImportedDesignReviews',
    'goalImportedExecutions', 'goalImportedExecutionReviews', 'goalImportedExecutionRepairs', 'goalImportedValidations', 'goalImportedValidationReviews']) {
    operations[name] = (await rows(name)).filter(row => row.goalId === result.goal_id).map(row => ({ id: row.id,
      outcome: row.result?.outcome ?? null, closed: row.result?.closed ?? null, verdict: row.result?.verdict?.outcome ?? null,
      accepted_at: row.acceptedAt ?? null, qualified_receipt: row.qualifiedReceipt ?? null }));
  }
  return { tasks: tasks.map(row => ({ id: row.id, status: row.status })),
    runs: runs.map(row => ({ id: row.id, task_id: row.taskId, status: row.status, computer_id: row.computerId,
      failure: row.failureReason ? redact(row.failureReason).slice(0, 2000) : null })), operations };
}
async function confirmPublication(automation, original) {
  if (publishesApplication) {
    const state = states[0], session = server.ctx.getPairedNodeSession(state.report.identity.computer_id);
    assert.equal(session?.sessionId, state.report.registration.session_id, 'Application lost its original paired session');
    const { publication } = await request('/api/v1/goals/' + encodeURIComponent(result.goal_id) + '/application-publication');
    return confirmApplicationPublication({ publication, automation, domain, original,
      expected: { goal_id: result.goal_id, project_id: projectId, computer_id: state.report.identity.computer_id,
        session_id: state.report.registration.session_id, capabilities: state.applicationCapabilities,
        grant: entry.request.app_publication, actor_user_id: entry.actor_user_id,
        consent_id: result.sharing.consent_id, policy_version: result.sharing.policy_version,
        agents: state.report.agents, origin: inputs.product.origin } });
  }
  assert.equal(automation.status, 'completed'); assert.equal(automation.delivery, 'published_product');
  const { release } = await request('/api/v1/goals/' + encodeURIComponent(result.goal_id) + '/release');
  const destination = states[1];
  assert.ok(release, 'Published release is missing');
  assert.equal(release.goal_id, result.goal_id); assert.equal(release.project_id, projectId);
  assert.equal(release.status, 'published'); assert.equal(release.computer_id, destination.report.identity.computer_id);
  assert.equal(release.request.goal_id, result.goal_id); assert.equal(release.request.project_id, projectId);
  assert.equal(release.request.release_id, release.id); assert.equal(release.request.run_id, release.run_id);
  const slot = selectPublicationSlot(destination.slots, release.request);
  assert.equal(release.receipt.outcome, 'published'); assert.equal(release.receipt.endpoint, slot.endpoint);
  assert.equal(release.receipt.release_profile_digest, slot.release.binding.release_profile_digest);
  assert.deepEqual(release.receipt.request, release.request);
  assert.equal(release.receipt.artifact_digest, release.request.subject_digest);
  assert.ok(release.request.acceptance_binding?.criteria?.length > 0 && release.receipt.acceptance,
    'Publication is missing its configured acceptance contract');
  assert.deepEqual(release.request.acceptance_binding?.release_binding, slot.release.binding);
  assert.deepEqual(release.receipt.acceptance?.settled_criteria, release.request.acceptance_binding?.criteria);
  assert.ok(release.receipt.health_checks.length > 0 && release.receipt.health_checks.every(item => item.passed === true),
    'Publication has no passing node-owned endpoint measurements');
  if (release.health) {
    assert.equal(release.health.state, 'healthy', 'Published endpoint is no longer healthy');
    assert.deepEqual(release.health.request, release.request);
    assert.equal(release.health.active_release_id, release.id);
    assert.equal(release.health.active_artifact_digest, release.request.subject_digest);
  }
  if (original) {
    assert.equal(release.id, original.release_id); assert.equal(release.run_id, original.run_id);
    assert.equal(release.evidence_id, original.evidence_id); assert.equal(release.request.subject_digest, original.artifact_digest);
    assert.equal(sha(JSON.stringify(release.request)), original.request_sha256);
    assert.equal(sha(JSON.stringify(release.receipt)), original.receipt_sha256);
  } else {
    // Read the Server's accepted final source. These observations cannot create
    // verification evidence, accept a review, or advance the GoalRunner.
    const publication = (await rows('goalImportedValidationPublications')).find(row => row.releaseId === release.id);
    assert.ok(publication, 'Missing accepted final publication source');
    assert.equal(publication.goalId, result.goal_id); assert.equal(publication.runId, release.run_id);
    assert.equal(publication.evidenceId, release.evidence_id); assert.equal(publication.computerId, release.computer_id);
    const completion = (await rows('goalImportedValidationCompletions')).find(row => row.validationId === publication.validationId);
    assert.ok(completion, 'Missing final validation completion'); assert.equal(completion.outcome, 'verified');
    assert.equal(completion.runId, release.run_id); assert.equal(completion.evidenceId, release.evidence_id);
    assert.equal(completion.sessionId, destination.report.registration.session_id);
    const review = (await rows('goalImportedValidationReviews')).find(row => row.id === publication.reviewId);
    assert.ok(review?.acceptedAt && review.acceptanceEventId, 'Missing accepted final validation review');
    assert.equal(review.goalId, result.goal_id); assert.equal(review.validationId, publication.validationId);
    assert.equal(review.computerId, release.computer_id); assert.equal(review.resultSessionId, completion.sessionId);
    assert.equal(review.workspaceRoot, slot.workspace);
    const participants = destination.report.agents.filter(instance => instance.slot_index === slot.index);
    for (const [agentId, instanceId] of [[review.authorAgentId, review.authorInstanceId], [review.reviewerAgentId, review.reviewerInstanceId]])
      assert.ok(participants.some(instance => instance.agent_id === agentId && instance.instance_id === instanceId),
        'Final validation contributor is outside the published slot');
    assert.equal(review.result?.outcome, 'reviewed'); assert.equal(review.result?.closed, true);
    assert.equal(review.result?.verdict?.outcome, 'accepted');
    assert.notEqual(review.authorAgentId, review.reviewerAgentId); assert.notEqual(review.authorInstanceId, review.reviewerInstanceId);
  }
  const response = await fetch(slot.endpoint, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  try {
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-artoo-release-id'), release.id);
    assert.equal(response.headers.get('x-artoo-artifact-digest'), release.request.subject_digest);
  } finally { await response.body?.cancel(); }
  return { release_id: release.id, run_id: release.run_id, evidence_id: release.evidence_id,
    artifact_digest: release.request.subject_digest, url: slot.endpoint, observed_at: new Date().toISOString(),
    request_sha256: sha(JSON.stringify(release.request)), receipt_sha256: sha(JSON.stringify(release.receipt)),
    // Keep the accepted values as well as their wire-order digests. A later
    // publisher-only open compares their meaning with the protected journal.
    request: release.request, receipt: release.receipt,
    health_event_id: release.health?.event_id ?? null,
    scope: 'accepted final source, published API receipt, and point-in-time local HTTP identity; product verification remains node-owned' };
}
const allocatedPorts = new Set();
async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    checkpoint();
    const socket = createServer(); await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = socket.address().port; await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    if (!allocatedPorts.has(port)) { allocatedPorts.add(port); return port; }
  }
  throw Error('Could not select distinct local publication ports');
}
function requestStop(state) {
  if (!state.child || state.stopWritten || state.report.cli.close) return;
  state.stopWritten = true;
  try {
    if (applicationMode) {
      assert.equal(state.child.connected, true, 'Original application worker IPC disconnected before shutdown');
      state.child.send(state.applicationLifecycle.stopMessage(), error => {
        if (error) note(error); else state.report.cli.shutdown_written = true;
      });
      state.child.stdin.end(); return;
    }
    state.child.stdin.write('{"version":1,"kind":"shutdown"}\n', error => {
      if (error) note(error); else state.report.cli.shutdown_written = true;
    });
    state.child.stdin.end();
  } catch (error) { note(error); }
}
function armStopTimeout(state) {
  if (!state.timer) state.timer = setTimeout(() => {
    if (state.report.cli.close) return;
    state.report.cli.forced_root_kill = true;
    note(Error(state.role + ': graceful stop exceeded 75 seconds; original root kill requested, descendant closure unproven'));
    try { save(path.join(output, state.role + '-CLEANUP-PENDING.json'), { version: 1, cli: state.report.cli, errors: result.errors, retained: true }); }
    catch (error) { note(error); }
    try { state.child.kill(); } catch (error) { note(error); }
    // Continue awaiting this original ChildProcess. No PID search, fake Ctrl+C or cleanup inference.
  }, 75000);
}
function emergencyStop(state, reason) {
  if (state.emergencyRequested) return; state.emergencyRequested = true;
  note(Error(state.role + ': ' + reason)); requestStop(state); armStopTimeout(state);
}
async function startCli(state, environment) {
  checkpoint();
  const { computer_id: computerId, device_id: deviceId } = state.report.identity;
  const cli = state.report.cli;
  if (applicationMode) {
    state.launchId = randomUUID(); state.applicationLifecycle = applicationWorkerLifecycle(state.launchId);
    cli.launch_id = state.launchId;
  }
  state.child = spawn(inputs.programs.node.path, [path.join(privateBundle, 'artood.mjs'), ...(applicationMode ? [] : ['--windows-supervised'])],
    { cwd: output, env: applicationMode ? { ...environment, ARTOO_WORKER_LAUNCH_ID: state.launchId } : environment,
      // Separate the application's console group so parent Ctrl+C cannot skip
      // API drain and race the child's formal IPC shutdown. Keep original pipes
      // and IPC referenced; disconnection still invokes the existing node.stop.
      detached: applicationMode, windowsHide: true, shell: false,
      stdio: applicationMode ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] });
  cli.pid = state.child.pid ?? null;
  state.closed = new Promise(resolve => {
    state.child.once('spawn', () => { cli.spawned = true; }); state.child.once('error', note);
    state.child.once('exit', (code, signal) => { cli.exit = { code, signal }; });
    state.child.once('close', (code, signal) => { cli.close = { code, signal }; resolve(); });
  });
  state.child.stdin.on('error', note);
  if (applicationMode) {
    cli.ipc_disconnected = false;
    state.child.once('disconnect', () => { cli.ipc_disconnected = true;
      if (!state.stopWritten) emergencyStop(state, 'Application worker lost its original IPC owner before normal shutdown'); });
    state.child.on('message', value => {
      try {
        const message = state.applicationLifecycle.receive(value);
        if (message.type === 'worker.ready') {
          cli.ready = message; cli.ready_received_while_stopping = state.stopWritten;
        }
        else { assert.equal(state.stopWritten, true); cli.stopped = message; }
      } catch (error) { note(error); emergencyStop(state, 'Invalid application worker lifecycle message'); }
    });
  }
  for (const name of ['stdout', 'stderr']) {
    state.child[name].once('end', () => { cli[name + '_eof'] = true; });
    state.child[name].on('error', error => { note(error); emergencyStop(state, 'CLI output error'); });
    state.child[name].on('data', chunk => {
      const bytes = Buffer.from(chunk), count = Math.min(bytes.length, Math.max(0, 8 * 1024 * 1024 - state.totalBytes));
      state.totalBytes += bytes.length; if (count) state.streams[name].push(bytes.subarray(0, count));
      if (state.totalBytes > 8 * 1024 * 1024) { emergencyStop(state, 'CLI output exceeded 8 MiB'); return; }
      if (name !== 'stdout' || applicationMode) return;
      try {
        state.pending += state.decoder.write(bytes); assert.ok(Buffer.byteLength(state.pending) <= 65536, 'CLI line bound exceeded');
        for (let end; (end = state.pending.indexOf('\n')) >= 0;) {
          const line = state.pending.slice(0, end); state.pending = state.pending.slice(end + 1);
          if (!line.startsWith('{')) continue;
          const value = JSON.parse(line);
          if (value.kind === 'artoo.supervised.ready') {
            assert.equal(cli.ready, null, 'Unexpected daemon restart in this request session');
            assert.deepEqual(value, { kind: 'artoo.supervised.ready', generation: 0, node_id: computerId }); cli.ready = value;
          } else if (value.kind === 'artoo.supervised.stopped') {
            assert.equal(cli.stopped, null); assert.equal(state.stopWritten, true);
            assert.deepEqual(value, { kind: 'artoo.supervised.stopped', cleanupConfirmed: true }); cli.stopped = value;
          }
        }
      } catch (error) { note(error); emergencyStop(state, 'Invalid CLI lifecycle output'); }
    });
  }
  await waitFor(() => { assert.equal(cli.close, null, 'CLI exited before readiness'); return cli.ready !== null; }, state.role + ' CLI readiness', 420000);
  await waitFor(() => server.ctx.getPairedNodeSession(computerId)?.deviceId === deviceId, state.role + ' original paired session');
  const session = server.ctx.getPairedNodeSession(computerId); assert.ok(session); assert.equal(session.deviceId, deviceId);
  assert.notEqual(session.sessionId, state.report.discovery.session_id);
  if (!applicationMode) {
    let registration;
    await waitFor(async () => {
      registration = (await server.ctx.db.db.select().from(schema.nodeRecoveryRegistrations))
        .find(row => row.computerId === computerId && row.sessionId === session.sessionId);
      return !!registration;
    }, state.role + ' current-session registration');
    assert.equal(registration.deviceId, deviceId);
    assert.ok(registration.tokenLookup === session.tokenLookup, 'Registration does not match the current paired credential');
    assert.equal(registration.workspaceRoot, state.paths.workspace); assert.equal(registration.generation, 0);
    assert.equal(server.ctx.supportsExecutionFeature(computerId, 'product.source.recovery.v1'), true);
    state.report.registration = { id: registration.id, computer_id: computerId, device_id: deviceId, session_id: session.sessionId,
      epoch_id: registration.epochId, generation: registration.generation, workspace: registration.workspaceRoot,
      registration_digest: registration.registrationDigest, configuration_digest: registration.configurationDigest,
      workspace_identity_digest: registration.workspaceIdentityDigest, store_identity_digest: registration.storeIdentityDigest };
  } else {
    state.report.registration = { kind: 'ordinary-paired-session', computer_id: computerId, device_id: deviceId, session_id: session.sessionId };
    await waitFor(() => {
      assert.equal(server.ctx.getPairedNodeSession(computerId)?.sessionId, session.sessionId, 'Application worker lost its original paired session during readiness');
      return server.ctx.supportsExecutionFeature(computerId, 'application-verification.v1')
        && state.slots.every(slot => server.ctx.getVerificationCapabilities(computerId, slot.verification_profile_id, projectId, slot.workspace))
        && (!publishesApplication || server.ctx.getApplicationPublicationCapabilities(computerId, inputs.product.publication_profile_id, projectId));
    }, state.role + ' original-session application capabilities');
  }
  for (const slot of state.slots) {
    assert.deepEqual(server.ctx.getVerificationCapabilities(computerId, slot.verification_profile_id, projectId, slot.workspace), slot.verifier);
    if (!applicationMode) assert.deepEqual(server.ctx.getReleaseCapabilities(computerId, slot.release_profile_id, projectId, slot.workspace, slot.verification_profile_id), slot.release);
  }
  if (applicationMode) {
    assert.equal(server.ctx.supportsExecutionFeature(computerId, 'application-verification.v1'), true);
    if (publishesApplication) {
      assert.equal(server.ctx.supportsExecutionFeature(computerId, 'application-publication.v1'), true);
      assert.deepEqual(server.ctx.getApplicationPublicationCapabilities(computerId, inputs.product.publication_profile_id, projectId), state.applicationCapabilities);
    }
  }
  await waitFor(async () => (await server.ctx.db.db.select().from(schema.agentRuntimes))
    .some(row => row.computerId === computerId && row.runtime === 'codex' && row.status === 'available'), state.role + ' real heartbeat runtime');
  state.report.agents = await createSlotInstances({ role: state.role, computerId, slots: state.slots,
    createInstance: body => request('/api/v1/computers/' + encodeURIComponent(computerId) + '/instances', body) });
}
try {
  checkpoint(); await recheck(inputs); checkpoint();
  process.env.WS_NO_BUFFER_UTIL = '1'; process.env.WS_NO_UTF_8_VALIDATE = '1';
  // Windows may spell this trusted OS variable as C:\\WINDOWS; normalize its
  // physical spelling before using the strict installation-path checker.
  const systemRoot = physical(fs.realpathSync.native(process.env.SystemRoot ?? process.env.SYSTEMROOT), true);
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: temporary, TMP: temporary,
    PATH: [path.dirname(inputs.programs.node.path), path.dirname(inputs.programs.git.path), path.join(systemRoot, 'System32')].join(';'),
    WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1' };
  for (const key of ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'TZ'])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  const serverEntry = path.join(inputs.candidate.snapshot, 'apps/server/dist/main.js'), require = createRequire(serverEntry);
  const dependencyRoots = new Set(inputs.dependencies.packages.map(item => item.directory.toLowerCase()));
  for (const name of ['fastify', '@fastify/static', '@fastify/websocket', 'drizzle-orm', '@electric-sql/pglite', 'zod', 'ulid', 'ws']) {
    let entry = fs.realpathSync.native(require.resolve(name));
    while (!fs.existsSync(path.join(entry, 'package.json'))) { const parent = path.dirname(entry); assert.notEqual(parent, entry); entry = parent; }
    assert.ok(dependencyRoots.has(entry.toLowerCase()), 'Unpinned runtime dependency: ' + name);
  }
  const { startServer } = await import(pathToFileURL(serverEntry).href);
  schema = await import(pathToFileURL(path.join(inputs.candidate.snapshot, 'packages/db/dist/schema.js')).href);
  if (applicationMode) {
    domain = await import(pathToFileURL(path.join(inputs.candidate.snapshot, 'packages/domain/dist/index.js')).href);
    domain.PreparedGoalRequestV1Schema.parse(entry.request);
    if (publishesApplication) domain.ApplicationPublicationLimitsV1Schema.parse(inputs.product.limits);
  }
  const pepper = randomBytes(32).toString('hex'); secrets.push(pepper);
  server = await startServer({ ...environment, NODE_ENV: 'development', AUTH_ENFORCE_API: '0', ARTOO_HOST: '127.0.0.1', ARTOO_PORT: '0',
    ARTOO_PAIRING_PEPPER: pepper, ARTOO_ALLOW_DEV_NODE_TOKEN: '0', ARTOO_ENABLE_DEV_ROUTES: '0',
    ARTOO_AI_DATA_SHARING_POLICY: JSON.stringify(inputs.provider.disclosure), ARTOO_DATA_DIR: serverData,
    ARTOO_DB_DIR: path.join(serverData, 'db'), ARTOO_ARTIFACT_DIR: path.join(serverData, 'artifacts'), ARTOO_WORKSPACE_ROOT: path.join(serverData, 'workspaces'),
    ARTOO_GOAL_ENTRY: JSON.stringify(entry),
    ...(inputs.web_dist ? { ARTOO_WEB_DIST: inputs.web_dist } : {}) });
  if (applicationMode) {
    assert.equal(typeof server.closePreparedGoalSubmission, 'function', 'Installed Server lacks prepared submission shutdown');
    if (stopping) closeApplicationSubmission();
  }
  assert.equal(server.ctx.deviceAuth.devNodeToken, null); assert.equal(server.ctx.deviceAuth.devControlEscape, false);
  assert.equal(server.ctx.authConfig.enforceApiAuth, false);
  const address = server.app.server.address(); assert.equal(address.address, '127.0.0.1'); assert.ok(address.port > 0);
  const origin = 'http://127.0.0.1:' + address.port; result.server_origin = origin;
  if (inputs.web_dist) result.web_url = origin + '/goals';
  request = async (route, body, requestKey = randomUUID(), options = {}) => {
    if (!options.cleanup) checkpoint();
    const response = await fetch(origin + route, { ...localJsonRequest(body, requestKey, options.method),
      signal: AbortSignal.timeout(options.timeout_ms ?? 15000) });
    assert.ok(response.ok, 'HTTP ' + response.status + ' for ' + route); return response.json();
  };
  const bootstrap = await request('/api/v1/bootstrap');
  // The prepared identity matches startServer's fresh development bootstrap; never guess a different account.
  assert.equal(bootstrap.user.id, entry.actor_user_id);
  assert.ok(bootstrap.projects.some(project => project.id === entry.project_id)); projectId = entry.project_id;
  assert.equal(bootstrap.goal_entry?.session_id, entry.session_id); assert.equal(bootstrap.goal_entry.submission_owner, submissionOwner);
  const disclosure = await request('/api/v1/privacy/ai-sharing'); assert.equal(disclosure.configured, true);
  assert.equal(disclosure.policy.mode, 'external'); assert.deepEqual(disclosure.policy.providers, inputs.provider.disclosure.providers);
  assert.equal(disclosure.policy.version, inputs.authorization_policy_version,
    'Aerial privacy policy differs from the explicitly authorized local configuration');
  const consent = await request('/api/v1/privacy/ai-sharing/consent', { policy_version: disclosure.policy.version, expected_user_id: disclosure.user_id });
  assert.equal(consent.user_id, disclosure.user_id); assert.equal(consent.consent?.policy_version, disclosure.policy.version);
  assert.equal(typeof consent.consent.id, 'string');
  result.sharing = { user_id: disclosure.user_id, policy_version: disclosure.policy.version, mode: disclosure.policy.mode,
    consent_id: consent.consent.id, authorization_basis: 'explicit existing Aerial authorization in local configuration', api_grant: true };
  baselineGoals = (await server.ctx.db.db.select().from(schema.goals)).length;
  const daemon = await import(pathToFileURL(path.join(privateBundle, 'artood.mjs')).href);
  // Share the same branded ownership boundary with publisher-only reopening.
  // Even discovery/config preparation can touch a release journal, so acquire
  // this before any node/profile/storage initialization and retain it on error.
  publisherOwnership = daemon.acquirePublishedProductOwnership({ sessionRoot: output, mode: 'daily' });
  result.publisher_ownership = publisherOwnership.descriptor;
  const nativeManifest = reference(path.join(privateBundle, 'native/windows-process/manifest.json'));
  // Discover both real profile descriptors without creating a source/recovery owner.
  for (const state of states) {
    const pairing = await request('/api/v1/devices/pairings', {}); secrets.push(pairing.code);
    const claimed = await request('/api/v1/devices/claim', { code: pairing.code, platform: 'windows', app_version: '0.1.0', display_name: 'Local request ' + state.role });
    assert.equal(typeof claimed.node_token, 'string'); assert.ok(claimed.node_token.length > 16); secrets.push(claimed.node_token, claimed.control_token);
    const deviceId = claimed.device.id, enrolled = await request('/api/v1/devices/' + encodeURIComponent(deviceId) + '/enroll', {});
    const computerId = enrolled.computer_id; assert.equal(typeof computerId, 'string');
    state.report.identity = { project_id: projectId, computer_id: computerId, device_id: deviceId, workspace: state.paths.workspace };
    state.nodeEnv = { ...environment, TEMP: state.paths.temporary, TMP: state.paths.temporary, CODEX_HOME: state.paths['codex-home'],
      ARTOO_NODE_URL: origin.replace(/^http/u, 'ws') + '/api/v1/node?token=' + encodeURIComponent(claimed.node_token),
      ARTOO_NODE_ID: computerId, ARTOO_RUNTIMES: 'codex', ARTOO_CODEX_BINARY: inputs.programs.codex.path,
      ARTOO_CODEX_MODEL: inputs.provider.model, ARTOO_CODEX_PROVIDER_URL: inputs.provider.url,
      ...(providerKey === undefined ? {} : { ARTOO_CODEX_PROVIDER_KEY: providerKey }),
      ARTOO_ALLOWED_ROOTS: state.slots.map(slot => slot.workspace).join(';'), ARTOO_HEARTBEAT_INTERVAL_MS: '1000', ARTOO_REPORT_ARTIFACTS: 'none',
      ARTOO_INITIALIZE_REPOSITORY: '1', ARTOO_RESEARCH_ENABLED: '1', ARTOO_RESEARCH_RECEIPTS_DIR: state.paths.research,
      ARTOO_WINDOWS_PROCESS_BUNDLE: path.join(privateBundle, 'native/windows-process'), ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: 'sha256:' + nativeManifest.sha256 };
    if (applicationMode) {
      state.application = prepareApplicationProfiles({ inputs, state, projectId, computerId, privateBundle, nativeManifest,
        daemon, nodeEnvironment: state.nodeEnv });
      state.nodeEnv = state.application.environment; knownConfig.push(...state.application.pins);
      state.report.application_configuration = { version: 1, delivery: inputs.product.delivery, origin: inputs.product.origin,
        verification_profile_id: inputs.product.verification_profile_id,
        publication_profile_id: inputs.product.publication_profile_id ?? null, files: state.application.pins };
    } else {
      const verifierFile = path.join(state.paths.config, 'verifiers.json'), releaseFile = path.join(state.paths.config, 'releases.json');
      const verifiers = [], releases = [];
      for (const slot of state.slots) {
        slot.endpoint = 'http://127.0.0.1:' + await freePort();
        const prepared = slotProfiles({ slot, projectId, nodeExecutable: inputs.programs.node.path,
          browserExecutable: inputs.programs.browser.path, acceptanceCli: path.join(privateBundle, 'web-acceptance-cli.js') });
        save(slot.browser_config, prepared.browser); knownConfig.push(reference(slot.browser_config));
        verifiers.push(prepared.verifier); releases.push(prepared.release);
      }
      save(verifierFile, verifiers); save(releaseFile, releases); knownConfig.push(...[verifierFile, releaseFile].map(reference));
      state.report.workspace_slots = { version: 1, max_retries: state.role === 'source' ? 0 : entry.request.max_retries,
        members: structuredClone(state.slots) };
      Object.assign(state.nodeEnv, { ARTOO_VERIFICATION_PROFILES_FILE: verifierFile, ARTOO_RELEASE_PROFILES_FILE: releaseFile });
    }
    const config = daemon.loadConfigFromEnv(state.nodeEnv); assert.equal(config.productSourceConfigFile, undefined); assert.equal(config.requireSupervisorLifetime, undefined);
    state.discovery = daemon.createNodeFromConfig(config); await state.discovery.start(); state.report.discovery.started = true;
    await waitFor(() => server.ctx.getPairedNodeSession(computerId)?.deviceId === deviceId, state.role + ' paired discovery');
    state.report.discovery.session_id = server.ctx.getPairedNodeSession(computerId).sessionId;
    await waitFor(() => {
      for (const slot of state.slots) {
        slot.verifier = server.ctx.getVerificationCapabilities(computerId, slot.verification_profile_id, projectId, slot.workspace);
        if (!applicationMode) slot.release = server.ctx.getReleaseCapabilities(computerId, slot.release_profile_id, projectId, slot.workspace, slot.verification_profile_id);
      }
      if (publishesApplication) state.applicationCapabilities = server.ctx.getApplicationPublicationCapabilities(computerId, inputs.product.publication_profile_id, projectId);
      return state.slots.every(slot => slot.verifier && (applicationMode || slot.release))
        && (!publishesApplication || state.applicationCapabilities);
    }, state.role + ' advertised profiles');
    for (const slot of state.slots) {
      if (applicationMode) {
        assert.deepEqual(slot.verifier, state.application.facts.verification_capabilities);
        assert.equal(server.ctx.supportsExecutionFeature(computerId, 'application-verification.v1'), true);
      } else assert.equal(slot.verifier.measurement_plan_policy.version, 2);
      assert.equal(slot.verifier.checks[0].contract.version, 3);
    }
    if (publishesApplication) state.applicationCapabilities = confirmApplicationCapability(state.applicationCapabilities,
      state.application, state.report.identity, state.paths.workspace, domain);
    assert.equal((await server.ctx.db.db.select().from(schema.nodeRecoveryRegistrations)).length, 0);
    const capabilities = path.join(state.paths.config, 'discovered-capabilities.json');
    save(capabilities, { session_id: state.report.discovery.session_id, verifier: state.slots[0].verifier, release: state.slots[0].release,
      slots: state.slots.map(slot => ({ index: slot.index, verifier: slot.verifier, release: slot.release })),
      ...(publishesApplication ? { application_publication: state.applicationCapabilities } : {}) });
    knownConfig.push(reference(capabilities));
    await state.discovery.stop(); state.report.discovery.stopped = true;
    await waitFor(() => server.ctx.getPairedNodeSession(computerId) === undefined, state.role + ' discovery disconnect');
    state.report.discovery.registry_disconnected = true; state.discovery = null;
  }
  if (!applicationMode) assert.notEqual(states[0].report.identity.computer_id, states[1].report.identity.computer_id);
  for (const state of states) {
    if (applicationMode) { await startCli(state, state.nodeEnv); continue; }
    const sourceFile = path.join(state.paths.config, 'source.json'), source = states[0];
    save(sourceFile, { version: 1, storeRoot: state.paths['source-store'], gitExecutable: inputs.programs.git.path, sourceResearch: state.role === 'source',
      measurementV2: slotSourceMappings(source.slots[0], state.slots),
      operations: { version: 1, importedReview: true, importedDesign: true, importedDesignReview: true, importedExecution: true, importedExecutionReview: true, importedValidation: true },
      recovery: { version: 1, deviceId: state.report.identity.device_id, workspaceRoot: state.paths.workspace, controlDirectory: state.paths['recovery-control'] } });
    knownConfig.push(reference(sourceFile));
    await startCli(state, { ...state.nodeEnv, ARTOO_PRODUCT_SOURCE_CONFIG_FILE: sourceFile,
      ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256: 'sha256:' + inputs.bundle_manifest.sha256, ARTOO_SUPERVISED_STDIN_CONTROL: '1' });
  }
  save(path.join(output, 'CONFIG-BINDING.json'), { version: 1, files: knownConfig, programs: inputs.programs,
    bundle_manifest: reference(path.join(privateBundle, 'bundle-manifest.json')), native_manifest: nativeManifest, nodes: result.nodes });
  for (const state of states) for (const slot of state.slots)
    assert.deepEqual(fs.readdirSync(slot.workspace), [], 'Every configured product workspace must start empty');
  // Schema support alone cannot qualify baseline preservation on the real source.
  // Keep the main-root recovery registration unchanged; it does not cover other slots.
  if (!applicationMode) assert.equal(server.ctx.supportsExecutionFeature(states[0].report.identity.computer_id, researchRevisionFeature), true,
    'The source node has no prepared research-revision capability; no product request was submitted');
  checkpoint(); await recheck(inputs); checkpoint();
  result.status = 'ready';
  save(path.join(output, 'READY.json'), { version: 1, server_origin: origin, web_url: result.web_url ?? null,
    session_root: output, product_mode: result.product_mode, nodes: states.map(state => state.report.identity) });
  console.log(JSON.stringify({ kind: 'local-request.ready', server_origin: origin, web_url: result.web_url ?? null,
    product_mode: result.product_mode, session_root: output }));
  if (submissionOwner === 'console') {
    assert.equal(result.goal_posts, 0); result.goal_posts++;
    const created = await request('/api/v1/autonomous-goals', { project_id: projectId, objective, ...entry.request }, entry.request_key);
    result.goal_id = created.goal.id; result.goal_submitted_at = new Date().toISOString();
  } else {
    // Browser alone submits the objective. The launcher observes the committed identity, never POSTs a placeholder goal.
    await waitFor(async () => {
      const current = (await request('/api/v1/bootstrap')).goal_entry;
      assert.equal(current?.session_id, entry.session_id); assert.equal(current?.request_key, entry.request_key);
      if (!current.goal_id) return false;
      const { goal } = await request('/api/v1/goals/' + encodeURIComponent(current.goal_id));
      assert.equal(goal.project_id, projectId); assert.equal(goal.owner_user_id, entry.actor_user_id);
      objective = goal.objective; result.goal_id = goal.id; result.goal_submitted_at = goal.created_at; return true;
    }, 'one browser product request', inputs.timeout_minutes * 60000, true, 1000);
    assert.equal(result.goal_posts, 0, 'Browser mode must not submit through the launcher');
  }
  assert.equal((await rows('goals')).length, baselineGoals + 1); result.logical_goals_created = 1;
  save(path.join(output, 'GOAL.json'), { objective, goal_id: result.goal_id, launcher_goal_posts: result.goal_posts, logical_goals_created: result.logical_goals_created });
  const deadline = Date.now() + inputs.timeout_minutes * 60000; let previous = '', completed = false;
  while (Date.now() < deadline) {
    for (const state of states) assert.equal(state.report.cli.close, null, state.role + ' CLI unexpectedly exited');
    assert.equal(result.errors.length, 0, 'CLI failure observed');
    const { automation } = await request('/api/v1/goals/' + encodeURIComponent(result.goal_id) + '/automation');
    const progress = await diagnosticSnapshot(); progress.automation = { status: automation.status, last_error: automation.last_error && redact(automation.last_error) };
    if (publishesApplication) {
      const { publication } = await request('/api/v1/goals/' + encodeURIComponent(result.goal_id) + '/application-publication');
      progress.application_publication = publication ? { id: publication.id, status: publication.status,
        state: publication.current_state, deadline_at: publication.receipt?.lease?.deadline_at ?? null } : null;
    }
    const signature = JSON.stringify(progress);
    if (signature !== previous) {
      assert.ok(diagnostics < 2000, 'Diagnostic record bound exceeded'); previous = signature;
      save(path.join(output, 'progress-' + String(++diagnostics).padStart(4, '0') + '.json'), { at: new Date().toISOString(), ...progress });
      console.log(JSON.stringify({ kind: 'local-request.progress', goal_id: result.goal_id, status: automation.status, tasks: progress.tasks,
        operations: progress.operations, ...(publishesApplication ? { application_publication: progress.application_publication } : {}) }));
    }
    if (automation.status === 'completed') {
      if (applicationMode && !publishesApplication) {
        assert.equal(automation.delivery, 'verified_workspace'); assert.deepEqual(automation.app_delivery, entry.request.app_delivery);
        result.delivery_verified = true;
      } else {
        result.publication = await confirmPublication(automation);
        if (publishesApplication) assert.equal(result.publication.available, true, 'Application closed before the first usable publication observation');
      }
      completed = true; break;
    }
    if (['failed', 'cancelled'].includes(automation.status)) throw Error('Goal ended: ' + redact(automation.last_error ?? automation.status));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(completed, true, 'Request pipeline deadline exceeded');
  assert.equal((await server.ctx.db.db.select().from(schema.goals)).length, baselineGoals + 1);
  await recheck(inputs); assert.deepEqual(tree(privateBundle), inputs.bundle_tree);
  for (const pin of knownConfig) check(pin);
  if (applicationMode && !publishesApplication) {
    result.status = 'delivered';
    save(path.join(output, 'DELIVERED.json'), { version: 1, goal_id: result.goal_id, delivery: 'verified_workspace',
      workspace: states[0].paths.workspace, retained: true, product_published: false });
    console.log(JSON.stringify({ kind: 'local-request.delivered', goal_id: result.goal_id, delivery: 'verified_workspace',
      workspace: states[0].paths.workspace, session_root: output, product_url: null,
      message: 'Configured application development is complete. The verified workspace is retained; this mode does not publish a service.' }));
    requestUserStop();
  } else {
    result.product_published = true; result.status = 'serving';
    save(path.join(output, 'PUBLISHED.json'), { version: 1, goal_id: result.goal_id, publication: result.publication,
      web_url: result.web_url ?? null, session_root: output, retained: true });
    console.log(JSON.stringify({ kind: 'local-request.published', goal_id: result.goal_id, product_url: result.publication.url,
      web_url: result.web_url ?? null, session_root: output, product_mode: result.product_mode,
      ...(publishesApplication ? { state: result.publication.state, health_checked_at: result.publication.health_checked_at,
        deadline_at: result.publication.deadline_at, requests_remaining: result.publication.requests_remaining } : {}),
      message: 'Keep this process running. With --stdin-control, send one shutdown JSON line to stop.' }));
    let nextHealthCheck = 0;
    while (!stopping) {
      for (const state of states) assert.equal(state.report.cli.close, null, state.role + ' CLI closed while serving');
      assert.equal(result.errors.length, 0, 'Node failure while serving');
      if (Date.now() >= nextHealthCheck) {
        const { automation } = await request('/api/v1/goals/' + encodeURIComponent(result.goal_id) + '/automation');
        const previousState = result.last_publication_observation?.state ?? result.publication.state;
        result.last_publication_observation = await confirmPublication(automation, result.last_publication_observation ?? result.publication);
        if (publishesApplication && previousState !== result.last_publication_observation.state) console.log(JSON.stringify({
          kind: 'local-request.application-status', goal_id: result.goal_id, state: result.last_publication_observation.state,
          product_url: result.last_publication_observation.available ? result.last_publication_observation.url : null,
          health_checked_at: result.last_publication_observation.health_checked_at ?? null, session_root: output }));
        if (publishesApplication && result.last_publication_observation.state === 'closed-normal') {
          result.stop_reason = 'application-original-owner-closed-normal'; requestUserStop();
          console.log(JSON.stringify({ kind: 'local-request.application-closed', goal_id: result.goal_id,
            state: 'closed-normal', product_url: null, session_root: output }));
        }
        nextHealthCheck = Date.now() + 5000;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
} catch (error) {
  if (error !== userStop) note(error);
  if (server && result.goal_id) try {
    save(path.join(output, result.errors.length ? 'FAILURE-DIAGNOSTICS.json' : 'STOP-DIAGNOSTICS.json'), await diagnosticSnapshot());
  } catch (diagnosticError) { note(diagnosticError); }
} finally {
  // Stop may arrive after an original POST is admitted but before its response
  // or bootstrap observation. Close admission, join that transaction, then use
  // its stored original identity. A bootstrap read alone still races its commit.
  if (applicationMode && server) try {
    const recovered = await reconcilePreparedSubmission({ closure: await closeApplicationSubmission(), entry, request, goalId: result.goal_id });
    result.prepared_submission_closure = recovered.closure;
    if (recovered.goal) {
      objective = recovered.goal.objective; result.goal_id = recovered.goal.id; result.goal_submitted_at = recovered.goal.created_at;
      result.logical_goals_created = 1;
      if (baselineGoals !== undefined) assert.equal((await rows('goals')).length, baselineGoals + 1);
      retainPreparedGoalRecord(path.join(output, 'GOAL.json'), { objective, goal_id: result.goal_id, launcher_goal_posts: result.goal_posts, logical_goals_created: result.logical_goals_created });
    }
  } catch (error) { note(error); }
  // Keep the original paired CLI available while the Server stops the durable
  // workflow and waits for the application's actual original owner closure.
  // Cleanup requests deliberately do not call the user's stop checkpoint.
  if (applicationMode && server && request && result.goal_id) try {
    result.application_stop = await stopApplicationGoal({ request, goalId: result.goal_id, publishesApplication, domain, original: result.publication });
  } catch (error) { note(error); }
  for (const state of states) if (state.child && !state.report.cli.close) {
    requestStop(state); armStopTimeout(state);
  }
  // Await the actual original CLI closures. Failed attempts retain all data and never claim cleanup from a PID observation.
  for (const state of states) {
    if (state.closed) await state.closed;
    clearTimeout(state.timer); state.timer = null;
    if (state.discovery) try {
      await state.discovery.stop(); state.report.discovery.stopped = true;
      await waitFor(() => server.ctx.getPairedNodeSession(state.report.identity.computer_id) === undefined,
        state.role + ' discovery cleanup disconnect', 30000, false);
      state.report.discovery.registry_disconnected = true; state.discovery = null;
    } catch (error) { note(error); }
    if (state.child) try {
      const cli = state.report.cli;
      for (const event of [cli.exit, cli.close]) { assert.equal(event?.code, 0); assert.equal(event?.signal, null); }
      assert.ok(cli.stopped && cli.spawned && cli.shutdown_written && !cli.forced_root_kill);
      if (applicationMode) assert.equal(cli.ipc_disconnected, true, 'Original application worker did not close its IPC connection');
      assert.equal(cli.stdout_eof, true); assert.equal(cli.stderr_eof, true);
      state.pending += state.decoder.end(); assert.equal(state.pending, '');
      await waitFor(() => server.ctx.getPairedNodeSession(state.report.identity.computer_id) === undefined, state.role + ' final registry disconnect', 30000, false);
      state.report.registry_disconnected = true;
    } catch (error) { note(error); }
    for (const name of ['stdout', 'stderr']) try {
      const file = path.join(output, state.role + '-cli-' + name + '.log'), fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, redact(Buffer.concat(state.streams[name]).toString('utf8'))); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      state.report.cli[name + '_log'] = { ...reference(file), redacted: true };
    } catch (error) { note(error); }
  }
  if (server) try { await server.close(); result.server_closed = true; } catch (error) { note(error); }
  try {
    await recheck(inputs); assert.deepEqual(tree(privateBundle), inputs.bundle_tree);
    for (const pin of knownConfig) check(pin); result.inputs_unchanged = true;
  } catch (error) { note(error); }
  if (publisherOwnership && !result.errors.length && result.server_closed && result.inputs_unchanged === true) {
    try { result.publisher_ownership = publisherOwnership.release(); }
    catch (error) { note(error); }
  }
  result.finished_at = new Date().toISOString();
  result.stop_requested_at = stopRequestedAt ?? null;
  result.shutdown_control = { version: 1, mode: options['--stdin-control'] ? 'stdin' : 'signal',
    commands: controlCommands, complete: controlCommands === 1 && controlPending.length === 0 };
  result.shutdown_confirmed = !result.errors.length && result.server_closed && result.inputs_unchanged === true;
  result.status = !result.shutdown_confirmed ? 'failed' : result.product_published ? 'stopped-after-publication'
    : result.delivery_verified ? 'stopped-after-development' : 'stopped-before-completion';
  process.off('SIGINT', requestUserStop); process.off('SIGTERM', requestUserStop);
  if (options['--stdin-control']) {
    process.stdin.off('data', controlData); process.stdin.off('end', controlEnd); process.stdin.off('error', controlError); process.stdin.pause();
  }
  save(path.join(output, 'RESULT.json'), result);
  console.log(JSON.stringify({ kind: 'local-request.stopped', status: result.status, output, goal_id: result.goal_id,
    product_published: result.product_published, shutdown_confirmed: result.shutdown_confirmed, errors: result.errors,
    open_product: !applicationMode && result.status === 'stopped-after-publication' && result.publisher_ownership?.lock_removed === true
      && result.shutdown_control.complete ? output : null,
    message: applicationMode ? 'Application history and data are retained. This bounded session cannot be reopened through -OpenProduct. New requests create fresh environments.'
      : 'History retained. Use -OpenProduct with this session path to serve a qualified stopped product. New requests create fresh environments.' }));
  process.exitCode = result.shutdown_confirmed ? 0 : 1;
}
