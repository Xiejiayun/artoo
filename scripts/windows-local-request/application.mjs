// Product entry plumbing. No diagnostic runner, synthetic acceptance or remote
// command can select executables or create application verification authority.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check, physical, reference, save, sha } from './inputs.mjs';
import { initialMaxRetries } from './slots.mjs';

export function preparedRequest(product) {
  if (!product) return { execution_mode: 'agent_team', verification_profile_id: 'native-web',
    release_profile_id: 'native-publish', max_retries: initialMaxRetries,
    source_handoff: { version: 1, mode: 'automatic', research_revision: { version: 1, strategy: 'configured_pool' } } };
  const request = { execution_mode: 'agent_team', verification_profile_id: product.verification_profile_id, max_retries: initialMaxRetries };
  return product.delivery === 'publication' ? { ...request, app_publication: {
    version: 1, kind: 'same-computer-local-application-publication', publication_profile_id: product.publication_profile_id } }
    : { ...request, app_delivery: { version: 1, kind: 'local-application-development' } };
}

export function localJsonRequest(body, requestKey, method) {
  return { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'Idempotency-Key': requestKey },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

/** Use the existing daemon IPC contract. Only the exact original ChildProcess
 * owns this channel; serialized messages do not prove process closure. */
export function applicationWorkerLifecycle(launchId) {
  assert.ok(typeof launchId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(launchId), 'Expected original worker launch UUID');
  let ready = false, requested = false, stopped = false;
  return Object.freeze({
    stopMessage() {
      assert.equal(requested, false, 'Only one original worker shutdown is allowed'); requested = true;
      return { type: 'shutdown', launchId };
    },
    receive(value) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === 'launchId,type'
        && value.launchId === launchId && ['worker.ready', 'worker.stopped'].includes(value.type), 'Invalid original worker lifecycle message');
      // The child's original ready can already be in flight when its owner
      // requests shutdown. Record it, but never admit another ready after stop.
      if (value.type === 'worker.ready') { assert.equal(ready, false); assert.equal(stopped, false); ready = true; }
      else { assert.equal(stopped, false); assert.equal(requested, true); stopped = true; }
      return Object.freeze({ type: value.type, launchId });
    },
  });
}

/** Recover only the original local submission after admission has closed and
 * all admitted creation transactions have settled. Never resubmit a lost POST. */
export async function reconcilePreparedSubmission({ closure, entry, request, goalId }) {
  assert.ok(closure && typeof closure === 'object' && !Array.isArray(closure));
  assert.deepEqual(Object.keys(closure).sort(), ['actor_user_id', 'goal_id', 'project_id', 'request_key', 'session_id', 'version']);
  assert.equal(closure.version, 1);
  for (const field of ['session_id', 'request_key', 'project_id', 'actor_user_id']) assert.equal(closure[field], entry[field], 'Prepared submission closure differs: ' + field);
  assert.ok(closure.goal_id === null || typeof closure.goal_id === 'string' && closure.goal_id.length > 0);
  if (goalId !== undefined && goalId !== null) assert.equal(closure.goal_id, goalId, 'Prepared closure lost or replaced the observed goal');
  if (closure.goal_id === null) return { closure, goal: null };
  assert.equal(typeof request, 'function', 'Original submission committed before the cleanup API became available');
  const { goal } = await request('/api/v1/goals/' + encodeURIComponent(closure.goal_id), undefined, undefined, { cleanup: true });
  assert.equal(goal?.id, closure.goal_id); assert.equal(goal.project_id, entry.project_id); assert.equal(goal.owner_user_id, entry.actor_user_id);
  assert.ok(typeof goal.objective === 'string' && goal.objective.trim().length > 0);
  assert.ok(typeof goal.created_at === 'string' && Number.isFinite(Date.parse(goal.created_at)));
  if (entry.submission_owner === 'console') assert.equal(goal.objective, entry.objective);
  return { closure, goal };
}

/** Normal delivery may already have written this exclusive record. Reuse only
 * its exact original bytes; Stop never replaces a conflicting saved identity. */
export function retainPreparedGoalRecord(file, record) {
  try { save(file, record); return 'created'; }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const before = reference(file), bytes = fs.readFileSync(file); check(before);
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(record, null, 2) + '\n'), 'Existing GOAL record conflicts with the original prepared submission');
  return 'retained';
}
const applicationPin = pin => ({ ...check(pin), sha256: 'sha256:' + pin.sha256 });
const configurationPin = file => applicationPin(reference(file));

/** Prepare only node-local configuration for this fresh paired computer. The
 * narrow bundled reader runs the ordinary complete native/profile checks and
 * returns a data projection; discovery and the CLI independently admit it again. */
export function prepareApplicationProfiles({ inputs, state, projectId, computerId, privateBundle, nativeManifest, daemon, nodeEnvironment }) {
  assert.ok(inputs.product && inputs.application, 'An installed application mode is required');
  assert.equal(typeof daemon.describeWindowsApplicationEntryVerifier, 'function', 'Installed daemon lacks the application entry configuration API');
  assert.equal(typeof daemon.loadPreparedConfigFromEnv, 'function', 'Installed daemon lacks the prepared configuration API');
  const make = (parent, name) => { const dir = path.join(parent, name); fs.mkdirSync(dir); return physical(dir, true); };
  const configRoot = state.paths.config, root = path.dirname(state.paths.workspace);
  const appConfig = make(configRoot, 'application'), prototypeConfig = make(configRoot, 'prototype'), verifierConfig = make(configRoot, 'verifier');
  const verificationRoot = make(root, 'verification');
  const candidates = make(verificationRoot, 'candidates'), installations = make(verificationRoot, 'installations'), selections = make(verificationRoot, 'selections');
  const sourceTools = inputs.application.tools;
  const tools = { compiler: Object.fromEntries(Object.entries(sourceTools.compiler).map(([name, pin]) => [name, applicationPin(pin)])),
    runtime: Object.fromEntries(Object.entries(sourceTools.runtime).map(([name, pin]) => [name, applicationPin(pin)])),
    broker: applicationPin(sourceTools.broker), hostManifest: applicationPin(sourceTools.hostManifest) };
  const applicationFile = path.join(appConfig, 'application.json');
  save(applicationFile, { version: 1, format: 'artoo.application-verification-profile.v1', node: applicationPin(inputs.programs.node), ...tools,
    browser: applicationPin(inputs.programs.browser), candidate_parent: candidates, installation_parent: installations,
    selection_parent: selections, origin: inputs.product.origin, timeout_ms: 600000, operation_timeout_ms: 30000, action_timeout_ms: 5000 });
  const browserFile = path.join(prototypeConfig, 'browser.json');
  save(browserFile, { evidence_root: state.paths.evidence, browser_executable: inputs.programs.browser.path,
    windows_browser_process: { version: 1 }, browser_program: { version: 3, viewports: [{ id: 'wide', width: 1280, height: 900 }] },
    design_capture_cases: true, action_timeout_ms: 5000 });
  const verifierFile = path.join(verifierConfig, 'verifiers.json');
  save(verifierFile, [{ id: inputs.product.verification_profile_id, project_id: projectId, workspace_root: state.paths.workspace,
    required_files: [], subject_paths: ['product', '.artoo/product'], application: { version: 1, configuration: configurationPin(applicationFile) },
    commands: [{ id: 'browser-acceptance', argv: [inputs.programs.node.path, path.join(privateBundle, 'web-acceptance-cli.js'), browserFile],
      timeout_ms: 180000, observation: { format: 'static-web-acceptance.v3', evidence_root: state.paths.evidence, capabilities: { version: 1 } } }] }]);
  const environment = { ...nodeEnvironment, ARTOO_VERIFICATION_PROFILES_FILE: verifierFile };
  const facts = daemon.describeWindowsApplicationEntryVerifier(daemon.loadPreparedConfigFromEnv(environment), inputs.product.verification_profile_id);
  assert.equal(facts.verification_profile_id, inputs.product.verification_profile_id);
  assert.equal(facts.origin, inputs.product.origin);
  assert.deepEqual(facts.application_configuration, configurationPin(applicationFile));
  assert.deepEqual(facts.backend, { directory: path.join(privateBundle, 'native/windows-process'), manifest_sha256: 'sha256:' + nativeManifest.sha256 });
  const pins = [applicationFile, browserFile, verifierFile].map(reference);
  let publicationConfiguration, publicationPin;
  if (inputs.product.delivery === 'publication') {
    const publicationConfig = make(configRoot, 'publication'), publicationRoot = make(root, 'publication');
    const deployments = make(publicationRoot, 'deployments'), publicationSelections = make(publicationRoot, 'selections'), journal = make(publicationRoot, 'journal');
    publicationConfiguration = { version: 1, format: 'artoo.application-publication-profile.v1', id: inputs.product.publication_profile_id,
      project_id: projectId, computer_id: computerId, verification_profile_id: facts.verification_profile_id,
      verification_profile_digest: facts.verification_profile_digest, application_configuration: facts.application_configuration,
      application_contract_digest: facts.application_contract_digest, application_toolchain_digest: facts.application_toolchain_digest,
      backend: facts.backend, host_manifest: facts.host_manifest, host_entry: facts.host_entry,
      deployment_parent: deployments, selection_parent: publicationSelections, journal_parent: journal,
      origin: facts.origin, limits: inputs.product.limits };
    const file = path.join(publicationConfig, 'publication.json'); save(file, publicationConfiguration); publicationPin = reference(file); pins.push(publicationPin);
    Object.assign(environment, { ARTOO_APPLICATION_PUBLICATION_PROFILE_FILE: file,
      ARTOO_APPLICATION_PUBLICATION_PROFILE_SHA256: 'sha256:' + publicationPin.sha256,
      ARTOO_APPLICATION_PUBLICATION_VERIFIER: inputs.product.verification_profile_id });
  }
  return { environment, pins, facts, publicationConfiguration, publicationPin };
}

export function confirmApplicationCapability(capability, prepared, identity, workspace, domain) {
  const value = domain.ApplicationPublicationCapabilitiesV1Schema.parse(capability), config = prepared.publicationConfiguration;
  assert.deepEqual(value.binding, { version: 1, publication_profile_id: config.id,
    publication_profile_digest: 'sha256:' + prepared.publicationPin.sha256,
    publication_contract_digest: 'sha256:' + sha(domain.canonicalApplicationPublicationContract(value.contract)),
    project_id: identity.project_id, computer_id: identity.computer_id,
    workspace_root_digest: 'sha256:' + sha(JSON.stringify({ version: 1, workspace_root: workspace })),
    verification_profile_id: config.verification_profile_id, verification_profile_digest: config.verification_profile_digest,
    application_config_digest: config.application_configuration.sha256, application_contract_digest: config.application_contract_digest,
    application_toolchain_digest: config.application_toolchain_digest });
  assert.deepEqual(value.contract.limits, config.limits);
  return value;
}

/** These read-only observations cannot accept a review or settle the GoalRunner.
 * Publication receipts and original-session observations are validated by the
 * installed domain schemas before their configured identities are compared. */
export function confirmApplicationPublication({ publication, automation, domain, expected, original, now = Date.now() }) {
  assert.equal(automation.status, 'completed'); assert.equal(automation.delivery, 'published_product');
  assert.ok(publication, 'Missing application publication'); assert.equal(publication.status, 'published');
  assert.equal(publication.scope, 'bounded-local-application-publication');
  const request = domain.ApplicationPublicationRequestV1Schema.parse(publication.request);
  const receipt = domain.ApplicationPublicationReceiptV1Schema.parse(publication.receipt);
  assert.equal(receipt.outcome, 'published'); assert.deepEqual(receipt.request, request);
  const requestDigest = 'sha256:' + sha(domain.canonicalApplicationPublicationRequest(request));
  assert.equal(receipt.request_digest, requestDigest);
  assert.equal(publication.id, request.publication_id); assert.equal(publication.goal_id, expected.goal_id);
  assert.equal(request.goal_id, expected.goal_id); assert.equal(request.project_id, expected.project_id);
  assert.equal(request.computer_id, expected.computer_id); assert.equal(request.publisher_session_id, expected.session_id);
  assert.deepEqual(request.capabilities, expected.capabilities);
  assert.deepEqual(request.authorization.grant, expected.grant);
  assert.equal(request.authorization.actor_user_id, expected.actor_user_id);
  assert.equal(request.authorization.consent_id, expected.consent_id); assert.equal(request.authorization.policy_version, expected.policy_version);
  for (const source of [request.author, request.reviewer]) assert.ok(expected.agents.some(agent =>
    agent.agent_id === source.agent_id && agent.instance_id === source.agent_instance_id), 'Application contributor is outside the configured pair');
  assert.equal(publication.endpoint, expected.origin); assert.equal(receipt.deployment.origin, expected.origin);
  const observation = domain.ApplicationPublicationObservationV1Schema.parse(publication.latest_observation);
  assert.deepEqual(observation.request, request); assert.equal(observation.request_digest, requestDigest);
  assert.deepEqual(observation.deployment, receipt.deployment); assert.deepEqual(observation.lease, receipt.lease);
  if (original) {
    assert.equal(publication.id, original.publication_id); assert.equal(sha(JSON.stringify(request)), original.request_sha256);
    assert.equal(sha(JSON.stringify(receipt)), original.receipt_sha256);
    assert.ok(observation.sequence >= original.observation_sequence, 'Application observation sequence moved backward');
  }
  const common = { publication_id: publication.id, artifact_digest: request.author.candidate.artifact_digest,
    url: expected.origin, request, receipt, request_sha256: sha(JSON.stringify(request)), receipt_sha256: sha(JSON.stringify(receipt)),
    observation_sequence: observation.sequence, observation_event_id: observation.event_id, observation,
    scope: 'bounded local application; accepted independent review and original node-owned HTTP, database, reopen and live-owner evidence' };
  if (publication.current_state === 'closed-normal') {
    assert.equal(observation.state, 'closed-normal'); assert.equal(observation.closure?.kind, 'normal-drain');
    return { ...common, available: false, state: 'closed-normal', observed_at: new Date(now).toISOString() };
  }
  if (publication.current_state === 'draining') {
    assert.equal(observation.state, 'draining'); assert.equal(observation.closure, null);
    return { ...common, available: false, state: 'draining', observed_at: new Date(now).toISOString() };
  }
  assert.ok(['healthy', 'live'].includes(publication.current_state), 'Application is no longer available on its original session');
  assert.equal(observation.state, publication.current_state);
  const health = observation.health, live = observation.live;
  assert.ok(live && !observation.closure, 'Application has no original live owner');
  assert.deepEqual(live.service, receipt.second_service.live.service);
  if (health) assert.deepEqual(health.service, live.service);
  assert.ok(now < Date.parse(receipt.lease.deadline_at), 'Application lease expired');
  for (const time of [observation.observed_at, ...(health ? [health.checked_at] : []), live.observed_at, live.counters_observed_at])
    assert.ok(Number.isFinite(Date.parse(time)) && Date.parse(time) <= now
      && now - Date.parse(time) <= request.capabilities.contract.limits.health_freshness_ms, 'Application health or owner observation is stale');
  assert.ok(live.requests_used < request.capabilities.contract.limits.maximum_requests_per_generation, 'Application request budget is exhausted');
  return { ...common, available: true, state: publication.current_state, health_checked_at: health?.checked_at ?? null,
    deadline_at: receipt.lease.deadline_at,
    requests_remaining: request.capabilities.contract.limits.maximum_requests_per_generation - live.requests_used,
    observed_at: new Date(now).toISOString() };
}

/** A successful stop API alone cannot turn missing/aborted closure into a
 * normally stopped product. Pre-publication failure can have no started owner. */
export function confirmApplicationStopped(publication, domain, original) {
  if (original) {
    assert.equal(publication?.id, original.publication_id, 'Stopped application differs from the original publication');
    assert.equal(sha(JSON.stringify(domain.ApplicationPublicationRequestV1Schema.parse(publication.request))), original.request_sha256);
    assert.equal(sha(JSON.stringify(domain.ApplicationPublicationReceiptV1Schema.parse(publication.receipt))), original.receipt_sha256);
  }
  if (!publication) return { state: 'not-published', normal: true };
  const receipt = publication.receipt === null ? null : domain.ApplicationPublicationReceiptV1Schema.parse(publication.receipt);
  if (receipt?.outcome === 'failed' && receipt.cleanup.state !== 'unconfirmed')
    return { state: receipt.cleanup.state, normal: true, publication_id: publication.id };
  const observation = domain.ApplicationPublicationObservationV1Schema.parse(publication.latest_observation);
  assert.equal(observation.state, 'closed-normal', 'Application stop lacks an original normal closure');
  assert.equal(observation.closure?.kind, 'normal-drain', 'Application stop lacks an original normal drain');
  if (receipt?.outcome === 'published') {
    assert.deepEqual(observation.request, receipt.request); assert.deepEqual(observation.lease, receipt.lease);
    assert.deepEqual(observation.deployment, receipt.deployment);
    assert.deepEqual(observation.closure.service, receipt.second_service.live.service);
  }
  return { state: observation.state, normal: true, publication_id: publication.id, observation };
}

export async function stopApplicationGoal({ request, goalId, publishesApplication, domain, original }) {
  const route = '/api/v1/goals/' + encodeURIComponent(goalId), cleanup = { cleanup: true, timeout_ms: 75000 };
  const { automation } = await request(route + '/automation', undefined, undefined, cleanup);
  if (!['completed', 'failed', 'cancelled'].includes(automation.status))
    await request(route + '/cancel', undefined, undefined, { ...cleanup, method: 'POST' });
  if (!publishesApplication) return null;
  const stopped = await request(route + '/application-publication/stop', undefined, undefined, { ...cleanup, method: 'POST' });
  if (automation.status === 'completed') assert.ok(stopped.publication, 'Completed application has no original publication to stop');
  return confirmApplicationStopped(stopped.publication, domain, original);
}
