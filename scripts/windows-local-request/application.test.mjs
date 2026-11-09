// Configuration and retained-observation regressions. Real domain schemas are
// used; the records/tools below are controlled fixtures, never native evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as domain from '../../packages/domain/dist/index.js';
import { applicationInstallation, productConfiguration, reference, tree, sha, save, validateStoppedProductRecords } from './inputs.mjs';
import { preparedRequest, confirmApplicationPublication, confirmApplicationStopped, stopApplicationGoal, applicationWorkerLifecycle, localJsonRequest, reconcilePreparedSubmission, retainPreparedGoalRecord } from './application.mjs';

const limits = () => ({ root_lifetime_ms: 3_600_000, startup_timeout_ms: 10000, health_timeout_ms: 10000,
  normal_drain_reserve_ms: 50000, health_interval_ms: 10000, health_freshness_ms: 30000,
  maximum_service_generations: 2, maximum_requests_per_generation: 256, maximum_concurrent: 1, maximum_health_rounds: 128 });
const product = (delivery = 'publication') => ({ version: 1, kind: 'local-application', delivery,
  verification_profile_id: 'native-application', origin: 'http://127.0.0.1:4173',
  ...(delivery === 'publication' ? { publication_profile_id: 'native-application-publication', limits: limits() } : {}) });

test('omitted mode preserves the complete original static request', () => {
  assert.equal(productConfiguration(undefined), null);
  assert.deepEqual(preparedRequest(null), { execution_mode: 'agent_team', verification_profile_id: 'native-web',
    release_profile_id: 'native-publish', max_retries: 3,
    source_handoff: { version: 1, mode: 'automatic', research_revision: { version: 1, strategy: 'configured_pool' } } });
});
for (const delivery of ['publication', 'development']) test(`prepared ${delivery} request uses the actual mutually exclusive server contract`, () => {
  const configured = productConfiguration(product(delivery)), request = preparedRequest(configured);
  assert.deepEqual(domain.PreparedGoalRequestV1Schema.parse(request), request);
  assert.equal(request.verification_profile_id, configured.verification_profile_id);
  assert.equal(request.release_profile_id, undefined); assert.equal(request.source_handoff, undefined);
  assert.ok(Object.isFrozen(configured));
  if (delivery === 'publication') { assert.equal(request.app_delivery, undefined); assert.ok(request.app_publication); }
  else { assert.equal(request.app_publication, undefined); assert.ok(request.app_delivery); }
});
for (const [name, change] of [
  ['command override', value => { value.command = 'arbitrary.exe'; }],
  ['unknown mode', value => { value.kind = 'remote-application'; }],
  ['remote endpoint', value => { value.origin = 'http://192.168.1.1:4173'; }],
  ['path endpoint', value => { value.origin += '/product'; }],
  ['default port alias', value => { value.origin = 'http://127.0.0.1:80'; }],
  ['empty profile', value => { value.verification_profile_id = ''; }],
  ['wrong version', value => { value.version = '1'; }],
  ['reopen budget override', value => { value.limits.maximum_service_generations = 3; }],
  ['missing drain reserve', value => { value.limits.normal_drain_reserve_ms = 1000; }],
  ['impossible lease', value => { value.limits.root_lifetime_ms = 100000; }],
  ['unknown limit', value => { value.limits.executable = 'arbitrary.exe'; }],
]) test(`local application configuration rejects ${name}`, () => {
  const value = product(); change(value); assert.throws(() => productConfiguration(value));
});
test('development mode cannot silently gain publication configuration', () => {
  for (const extra of [{ publication_profile_id: 'publisher' }, { limits: limits() }])
    assert.throws(() => productConfiguration({ ...product('development'), ...extra }));
});

function installationFixture(t) {
  const parent = fs.realpathSync.native(os.tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'artoo-app-entry-input-')));
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root); assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^artoo-app-entry-input-[^\\/]+$/u); fs.rmSync(root, { recursive: true });
  });
  const code = path.join(root, 'tools'); fs.mkdirSync(code); const file = path.join(code, 'fixture-tool.txt'), node = path.join(root, 'fixture-node.exe');
  fs.writeFileSync(file, 'controlled non-executable tool inventory'); fs.writeFileSync(node, 'controlled Node inventory');
  const pin = reference(file), nodePin = reference(node);
  const manifest = { version: 1, tools: { compiler: { helper: pin, helperManifest: pin, node: nodePin, entry: pin, configuration: pin },
    runtime: { helper: pin, helperManifest: pin, entry: pin, vendorManifest: pin, guestBootstrap: pin }, broker: pin, hostManifest: pin },
    trees: [{ root: code, tree: tree(code) }] };
  return { root, code, file, manifest, programs: { node: nodePin } };
}
test('application installation binds every tool and the complete dependency tree', t => {
  const f = installationFixture(t); assert.deepEqual(applicationInstallation(f.manifest, f.programs), f.manifest);
  fs.writeFileSync(path.join(f.code, 'unlisted-dependency.txt'), 'new executable dependency');
  assert.throws(() => applicationInstallation(f.manifest, f.programs), /tool tree differs/u);
});
test('application inventory does not accept a missing scope, changed compiler Node or changed tool pin', t => {
  const f = installationFixture(t);
  for (const change of [value => { value.trees = []; }, value => { value.tools.compiler.node = value.tools.broker; },
    value => { value.tools.runtime.entry = { ...value.tools.runtime.entry, sha256: '0'.repeat(64) }; },
    value => { value.trees.push(structuredClone(value.trees[0])); }]) {
    const value = structuredClone(f.manifest); change(value); assert.throws(() => applicationInstallation(value, f.programs));
  }
});

const digest = 'sha256:' + 'a'.repeat(64), at = seconds => new Date(Date.UTC(2026, 10, 9) + seconds * 1000).toISOString();
function publicationFixture() {
  const candidate = { version: 1, subject_digest: digest, source_digest: digest, artifact_digest: digest, toolchain_digest: digest,
    package_digest: digest, schema_digest: digest, qualified_for_product: false };
  const grant = { version: 1, kind: 'same-computer-local-application-publication', publication_profile_id: 'publication' };
  const capabilities = { version: 1, binding: { version: 1, publication_profile_id: 'publication', publication_profile_digest: digest,
    publication_contract_digest: digest, project_id: 'project', computer_id: 'computer', workspace_root_digest: digest,
    verification_profile_id: 'verifier', verification_profile_digest: digest, application_config_digest: digest,
    application_contract_digest: digest, application_toolchain_digest: digest },
    contract: { version: 1, kind: grant.kind, claim: 'bounded-local-application-publication', origin: 'profile-fixed-loopback',
      lifecycle: 'original-paired-session', normal_reopen: 'once-same-version-url-database', failure_recovery: 'unsupported', automatic_rotation: 'unsupported', limits: limits() } };
  const request = { version: 1, publication_id: 'publication-1', goal_id: 'goal', project_id: 'project', computer_id: 'computer', publisher_session_id: 'session',
    subject_digest: digest, application_definition_digest: digest,
    authorization: { version: 1, event_id: 'user-event', actor_user_id: 'user', consent_id: 'consent', policy_version: 'policy', grant }, capabilities,
    author: { run_id: 'author', request_id: 'author-request', evidence_id: 'author-evidence', agent_id: 'author-agent', agent_instance_id: 'author-instance',
      stage: 'validation', origin_run_id: 'author', origin_request_id: 'author-request', test_store_id: '00000000-0000-4000-8000-000000000001', candidate },
    reviewer: { run_id: 'reviewer', request_id: 'review-request', evidence_id: 'review-evidence', agent_id: 'reviewer-agent', agent_instance_id: 'reviewer-instance',
      stage: 'validation', origin_run_id: 'author', origin_request_id: 'author-request', test_store_id: '00000000-0000-4000-8000-000000000002', candidate },
    acceptance: { version: 1, plan: { id: 'plan', version: 1 }, research_digest: digest, design_digest: digest, measurement_plan_digest: digest,
      accepted_review_event_id: 'review-event', development_criteria: [{ requirement_id: 'business', criterion_index: 0, criterion_digest: digest, case_ids: ['save'] }],
      publication_criteria: [{ requirement_id: 'publish', criterion_index: 0, criterion_digest: digest, claim: 'bounded-local-application-publication' }], unmet_criteria: [] } };
  const requestDigest = 'sha256:' + sha(domain.canonicalApplicationPublicationRequest(request));
  const lease = { version: 1, lease_id: 'lease', publication_id: request.publication_id, request_digest: requestDigest, publisher_session_id: 'session',
    admitted_at: at(0), deadline_at: at(3600), root_lifetime_ms: limits().root_lifetime_ms };
  const deployment = { version: 1, deployment_generation: 'deployment', store_id: '00000000-0000-4000-8000-000000000003', plan_digest: digest,
    relocation_proof_digest: digest, reopen_pin_digest: digest, database_identity: { device: '3', inode: '4' }, schema_digest: digest, scope_digest: digest,
    data_generation: 'data-generation', origin: 'http://127.0.0.1:4173', client_entry_digest: digest };
  const service = generation => ({ publication_id: request.publication_id, lease_id: 'lease', owner_id: 'service-' + generation, generation,
    deployment_generation: deployment.deployment_generation, reopen_pin_digest: digest, database_identity: deployment.database_identity,
    schema_digest: digest, scope_digest: digest, artifact_digest: digest, origin: deployment.origin });
  const health = generation => ({ version: 1, scope: 'application-readiness-point-in-time', service: service(generation), checked_at: at(generation === 1 ? 2 : 4),
    broker_preflight: { existing_database: true, process_exit_confirmed: true }, client: { status_code: 200, body_digest: digest },
    persistence_read: { path: '/api/note', status_code: 200, body_digest: digest } });
  const closure = (owner, seconds) => ({ owner_id: owner, closed_at: at(seconds), process_exit_confirmed: true, exit_code: 0, job_empty: true,
    stdout_eof: true, stderr_eof: true, helper_exit_code: 0, helper_closed: true });
  const drain = (generation, seconds) => ({ ...closure('service-' + generation, seconds), kind: 'normal-drain', service: service(generation), reason: 'stdin-drain',
    input_ack_digest: digest, listener_closed: true, audit_complete: true, session_released: true,
    counters: { accepted_transports: 2, closed_transports: 2, runtime_invocations: 1, runtime_closed: 1, broker_invocations: 1, broker_closed: 1 } });
  const live = { service: service(2), counters_observed_at: at(5), observed_at: at(5), closed: false,
    native: { root_pid: 123, root_creation_time: '133000000000000001', observed: true, job_member: true }, requests_used: 2, in_flight: 0 };
  const receipt = { version: 1, scope: 'bounded-local-application-publication', outcome: 'published', request, request_digest: requestDigest, lease, deployment,
    initialization: { ...closure('initializer', 1), broker_invocations: 1, broker_closed: 1 }, first_service: { health: health(1), closure: drain(1, 3) },
    second_service: { health: health(2), live }, settled_publication_criteria: request.acceptance.publication_criteria, recorded_at: at(6) };
  const observation = { version: 1, event_id: 'observation', sequence: 1, generation: 2, request, request_digest: requestDigest, lease, deployment,
    state: 'healthy', observed_at: at(7), reason: null, health: health(2), live, closure: null };
  const publication = { id: request.publication_id, goal_id: 'goal', status: 'published', scope: receipt.scope, request, receipt,
    latest_observation: observation, current_state: 'healthy', endpoint: deployment.origin };
  const expected = { goal_id: 'goal', project_id: 'project', computer_id: 'computer', session_id: 'session', capabilities, grant,
    actor_user_id: 'user', consent_id: 'consent', policy_version: 'policy', origin: deployment.origin,
    agents: [request.author, request.reviewer].map(source => ({ agent_id: source.agent_id, instance_id: source.agent_instance_id })) };
  const closed = () => { const value = structuredClone(publication); Object.assign(value.latest_observation, {
    event_id: 'normal-stop', sequence: 2, state: 'closed-normal', observed_at: at(10), reason: 'stdin-drain', health: null, live: null, closure: drain(2, 9) });
    value.current_state = 'closed-normal'; return value; };
  return { publication, expected, closed, automation: { status: 'completed', delivery: 'published_product' }, domain, now: Date.parse(at(8)) };
}
test('published URL requires the exact reviewed candidate, fresh node health and original live owner', () => {
  const f = publicationFixture(), result = confirmApplicationPublication(f);
  assert.equal(result.available, true); assert.equal(result.url, f.expected.origin); assert.equal(result.requests_remaining, 254);
  assert.equal(confirmApplicationPublication({ ...f, original: result }).publication_id, result.publication_id);
});
for (const [name, change] of [
  ['stale health', f => { f.now = Date.parse(at(40)); }],
  ['expired lease', f => { f.now = Date.parse(at(3600)); }],
  ['historical URL after loss of session', f => { f.publication.current_state = 'unknown'; }],
  ['different node session', f => { f.expected.session_id = 'replacement'; }],
  ['different user grant', f => { f.expected.actor_user_id = 'other'; }],
  ['different profile', f => { f.expected.capabilities = { ...f.expected.capabilities, binding: { ...f.expected.capabilities.binding, publication_profile_digest: 'sha256:' + 'b'.repeat(64) } }; }],
  ['unregistered reviewer', f => { f.expected.agents = f.expected.agents.slice(0, 1); }],
  ['changed URL', f => { f.publication.endpoint = 'http://127.0.0.1:4174'; }],
  ['forged request hash', f => { f.publication.receipt.request_digest = 'sha256:' + 'b'.repeat(64); }],
]) test(`publication observation rejects ${name}`, () => { const f = publicationFixture(); change(f); assert.throws(() => confirmApplicationPublication(f)); });
test('normal original closure clears availability while preserving publication identity', () => {
  const f = publicationFixture(), original = confirmApplicationPublication(f), publication = f.closed();
  const closed = confirmApplicationPublication({ ...f, publication, original, now: Date.parse(at(11)) });
  assert.equal(closed.available, false); assert.equal(closed.state, 'closed-normal');
  assert.equal(confirmApplicationStopped(publication, domain).normal, true);
  assert.throws(() => confirmApplicationStopped(f.publication, domain), /original normal closure/u);
  assert.throws(() => validateStoppedProductRecords({ version: 1, scope: 'windows-local-single-goal', product_mode: 'application-publication' }), /static publisher reopening/u);
});
test('stop fences an unfinished workflow before stopping its original application', async () => {
  const f = publicationFixture(), calls = [];
  const request = async (route, body, key, options) => {
    assert.equal(body, undefined); assert.equal(options.cleanup, true); calls.push(route);
    if (route.endsWith('/automation')) return { automation: { status: 'executing' } };
    assert.equal(options.method, 'POST'); return route.endsWith('/stop') ? { publication: f.closed() } : {};
  };
  const result = await stopApplicationGoal({ request, goalId: 'goal', publishesApplication: true, domain });
  assert.equal(result.normal, true);
  assert.deepEqual(calls, ['/api/v1/goals/goal/automation', '/api/v1/goals/goal/cancel', '/api/v1/goals/goal/application-publication/stop']);
});
test('completed product stop preserves goal completion and unconfirmed stop remains an error', async () => {
  const f = publicationFixture(), calls = [];
  await assert.rejects(() => stopApplicationGoal({ goalId: 'goal', publishesApplication: true, domain,
    request: async route => { calls.push(route); return route.endsWith('/automation')
      ? { automation: { status: 'completed' } } : { publication: f.publication }; } }), /original normal closure/u);
  assert.deepEqual(calls, ['/api/v1/goals/goal/automation', '/api/v1/goals/goal/application-publication/stop']);
});
test('completed publication cannot silently become not-published when Stop precedes the first publication observation', async () => {
  await assert.rejects(() => stopApplicationGoal({ goalId: 'goal', publishesApplication: true, domain,
    request: async route => route.endsWith('/automation') ? { automation: { status: 'completed' } } : { publication: null } }),
  /Completed application has no original publication/u);
});
test('normal draining remains unavailable until actual closure, without turning Stop into failure', () => {
  const f = publicationFixture(); Object.assign(f.publication.latest_observation, { state: 'draining', health: null, reason: 'stdin-drain' });
  f.publication.current_state = 'draining';
  const result = confirmApplicationPublication(f); assert.equal(result.available, false); assert.equal(result.state, 'draining');
  assert.throws(() => confirmApplicationStopped(f.publication, domain));
});
test('fresh live-owner observations do not republish a historical health measurement as current', () => {
  const f = publicationFixture(); f.now = Date.parse(at(61)); f.publication.current_state = 'live';
  Object.assign(f.publication.latest_observation, { state: 'live', health: null, observed_at: at(60),
    live: { ...f.publication.latest_observation.live, observed_at: at(60), counters_observed_at: at(60) } });
  const result = confirmApplicationPublication(f); assert.equal(result.available, true); assert.equal(result.state, 'live');
  assert.equal(result.health_checked_at, null);
});
test('stop cannot report success from a missing replacement publication after a published result', () => {
  const f = publicationFixture(), original = confirmApplicationPublication(f);
  assert.throws(() => confirmApplicationStopped(null, domain, original), /differs from the original publication/u);
});

const launchId = '00000000-0000-4000-8000-000000000001';
test('application worker retains one original IPC launch through ready and requested shutdown', () => {
  const lifecycle = applicationWorkerLifecycle(launchId);
  assert.deepEqual(lifecycle.receive({ type: 'worker.ready', launchId }), { type: 'worker.ready', launchId });
  assert.deepEqual(lifecycle.stopMessage(), { type: 'shutdown', launchId });
  assert.deepEqual(lifecycle.receive({ type: 'worker.stopped', launchId }), { type: 'worker.stopped', launchId });
  assert.throws(() => lifecycle.stopMessage()); assert.throws(() => lifecycle.receive({ type: 'worker.stopped', launchId }));
});
test('worker lifecycle rejects stale identities, unsolicited stops, extra data and restarted readiness', () => {
  for (const value of [{ type: 'worker.ready', launchId: '00000000-0000-4000-8000-000000000002' },
    { type: 'worker.stopped', launchId }, { type: 'worker.ready', launchId, cleanupConfirmed: true }, { type: 'shutdown', launchId }])
    assert.throws(() => applicationWorkerLifecycle(launchId).receive(value));
  const ready = applicationWorkerLifecycle(launchId); ready.receive({ type: 'worker.ready', launchId });
  assert.throws(() => ready.receive({ type: 'worker.ready', launchId }));
  const stopped = applicationWorkerLifecycle(launchId); stopped.stopMessage(); stopped.receive({ type: 'worker.stopped', launchId });
  assert.throws(() => stopped.receive({ type: 'worker.ready', launchId }));
});
test('one in-flight original ready may cross shutdown before the original stopped acknowledgement', () => {
  const lifecycle = applicationWorkerLifecycle(launchId);
  assert.deepEqual(lifecycle.stopMessage(), { type: 'shutdown', launchId });
  assert.deepEqual(lifecycle.receive({ type: 'worker.ready', launchId }), { type: 'worker.ready', launchId });
  assert.throws(() => lifecycle.receive({ type: 'worker.ready', launchId }));
  assert.deepEqual(lifecycle.receive({ type: 'worker.stopped', launchId }), { type: 'worker.stopped', launchId });
  assert.throws(() => lifecycle.receive({ type: 'worker.ready', launchId }));
  assert.throws(() => lifecycle.stopMessage());
});

const preparedFixture = owner => {
  const entry = { session_id: 'session', request_key: 'original-key', project_id: 'project', actor_user_id: 'user', submission_owner: owner,
    ...(owner === 'console' ? { objective: 'Build a task tracker' } : {}) };
  const closure = { version: 1, session_id: entry.session_id, request_key: entry.request_key, project_id: entry.project_id,
    actor_user_id: entry.actor_user_id, goal_id: 'committed-goal' };
  const goal = { id: closure.goal_id, project_id: entry.project_id, owner_user_id: entry.actor_user_id,
    objective: 'Build a task tracker', created_at: '2026-11-09T00:00:00.000Z' };
  return { entry, closure, goal };
};
for (const owner of ['browser', 'console']) test(`${owner} response-loss cleanup recovers the original committed goal without any POST`, async () => {
  const f = preparedFixture(owner), calls = [];
  const request = async (route, body, key, options) => {
    calls.push(route); assert.equal(body, undefined); assert.equal(options.cleanup, true); assert.equal(options.method, undefined);
    return { goal: f.goal };
  };
  const recovered = await reconcilePreparedSubmission({ ...f, request });
  assert.deepEqual(recovered, { closure: f.closure, goal: f.goal });
  assert.deepEqual(calls, ['/api/v1/goals/committed-goal']);
});
test('closed admission with no committed goal needs no request and cannot hide a previously observed goal', async () => {
  const f = preparedFixture('browser'); f.closure.goal_id = null;
  assert.deepEqual(await reconcilePreparedSubmission(f), { closure: f.closure, goal: null });
  await assert.rejects(() => reconcilePreparedSubmission({ ...f, goalId: 'committed-goal' }), /lost or replaced/u);
});
for (const field of ['session_id', 'request_key', 'project_id', 'actor_user_id']) test(`shutdown reconciliation rejects replacement ${field} before requesting a goal`, async () => {
  const f = preparedFixture('browser'); f.closure[field] = 'replacement';
  await assert.rejects(() => reconcilePreparedSubmission({ ...f, request: () => { assert.fail('No request is authorized for a different closure'); } }), /closure differs/u);
});
test('shutdown reconciliation rejects another goal, owner, project or console objective', async () => {
  for (const field of ['id', 'owner_user_id', 'project_id', 'objective']) {
    const f = preparedFixture('console'); f.goal[field] = 'replacement';
    await assert.rejects(() => reconcilePreparedSubmission({ ...f, request: async () => ({ goal: f.goal }) }));
  }
});
function goalRecordFixture(t) {
  const parent = fs.realpathSync.native(os.tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'artoo-goal-record-')));
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root); assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^artoo-goal-record-[^\\/]+$/u); fs.rmSync(root, { recursive: true });
  });
  return path.join(root, 'GOAL.json');
}
const goalRecord = posts => ({ objective: 'Build a task tracker', goal_id: 'committed-goal', launcher_goal_posts: posts, logical_goals_created: 1 });
test('normal Stop retains the existing exclusive GOAL record on repeated reconciliation without rewriting it', t => {
  const file = goalRecordFixture(t), record = goalRecord(1); save(file, record);
  const before = reference(file), stat = fs.statSync(file, { bigint: true });
  assert.equal(retainPreparedGoalRecord(file, record), 'retained');
  assert.equal(retainPreparedGoalRecord(file, record), 'retained');
  assert.deepEqual(reference(file), before);
  const after = fs.statSync(file, { bigint: true }); assert.equal(after.ino, stat.ino); assert.equal(after.mtimeNs, stat.mtimeNs);
});
for (const observed of [false, true]) test(`Stop writes a missing original GOAL record when its committed ID was ${observed ? 'already observed' : 'lost with the response'}`, async t => {
  const file = goalRecordFixture(t), f = preparedFixture('browser');
  const recovered = await reconcilePreparedSubmission({ ...f, goalId: observed ? f.goal.id : undefined, request: async () => ({ goal: f.goal }) });
  const record = { objective: recovered.goal.objective, goal_id: recovered.goal.id, launcher_goal_posts: 0, logical_goals_created: 1 };
  assert.equal(retainPreparedGoalRecord(file, record), 'created');
  assert.equal(retainPreparedGoalRecord(file, record), 'retained');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), goalRecord(0));
});
test('Stop refuses conflicting GOAL content and preserves its original bytes', t => {
  const file = goalRecordFixture(t), record = goalRecord(1); save(file, record); const before = reference(file);
  for (const change of [{ goal_id: 'another-goal' }, { objective: 'Changed requirement' }, { launcher_goal_posts: 0 }, { unexpected: true }]) {
    assert.throws(() => retainPreparedGoalRecord(file, { ...record, ...change }), /Existing GOAL record conflicts/u);
    assert.deepEqual(reference(file), before);
  }
});
test('bodyless cleanup reaches the real Fastify JSON boundary without an empty JSON error', async () => {
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url)), app = require('fastify')();
  const calls = [];
  for (const route of ['/cancel', '/application-publication/stop']) app.post(route, async request => {
    calls.push({ route, body: request.body, key: request.headers['idempotency-key'] }); return { stopped: true };
  });
  try {
    for (const route of ['/cancel', '/application-publication/stop']) {
      const request = localJsonRequest(undefined, 'original-key', 'POST');
      const response = await app.inject({ method: request.method, url: route, headers: request.headers });
      assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { stopped: true });
    }
    assert.deepEqual(calls, ['/cancel', '/application-publication/stop'].map(route => ({ route, body: undefined, key: 'original-key' })));
  } finally { await app.close(); }
});
