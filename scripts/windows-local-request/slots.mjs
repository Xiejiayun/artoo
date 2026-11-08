// Local bootstrap layout only. These records select existing protected profiles;
// they cannot authorize a run, a review, source recovery or publication.
import assert from 'node:assert/strict';
import * as path from 'node:path';

export const initialMaxRetries = 3;
export const researchRevisionFeature = 'product-research-revision.v1';

export function requestSlotLayout(sessionRoot, role, maxRetries = initialMaxRetries) {
  assert.ok(path.isAbsolute(sessionRoot) && path.resolve(sessionRoot) === sessionRoot, 'Expected an absolute session root');
  assert.ok(role === 'source' || role === 'destination', 'Unknown local node role');
  assert.ok(Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 10, 'Invalid configured retry count');
  return Array.from({ length: role === 'source' ? 1 : maxRetries + 1 }, (_, index) => {
    const root = index === 0 ? path.join(sessionRoot, role) : path.join(sessionRoot, role, 'slots', String(index));
    const suffix = index === 0 ? '' : '-slot-' + index;
    return { index, workspace: path.join(root, 'workspace'), verification_profile_id: 'native-web' + suffix,
      release_profile_id: 'native-publish' + suffix, storage_root: path.join(root, 'release'),
      evidence_root: path.join(root, 'evidence'), browser_config: path.join(root, 'config', 'browser.json') };
  });
}

export function assertLoopbackEndpoint(endpoint) {
  const url = new URL(endpoint);
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.origin === endpoint
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Expected an exact loopback endpoint');
  return Number(url.port);
}

export function slotProfiles({ slot, projectId, nodeExecutable, browserExecutable, acceptanceCli }) {
  const port = assertLoopbackEndpoint(slot.endpoint);
  return {
    browser: { evidence_root: slot.evidence_root, browser_executable: browserExecutable, windows_browser_process: { version: 1 },
      browser_program: { version: 3, viewports: [{ id: 'compact', width: 390, height: 844 }, { id: 'wide', width: 1280, height: 900 }] },
      design_capture_cases: true, action_timeout_ms: 2000 },
    verifier: { id: slot.verification_profile_id, project_id: projectId, workspace_root: slot.workspace,
      subject_paths: ['product', '.artoo/product'], required_files: [],
      measurement_plan_policy: { version: 2, coverage: 'every-must-criterion', methods: ['workspace-check', 'configured-static-release'] },
      commands: [{ id: 'browser-acceptance', argv: [nodeExecutable, acceptanceCli, slot.browser_config], timeout_ms: 90000,
        observation: { format: 'static-web-acceptance.v3', evidence_root: slot.evidence_root, capabilities: { version: 1 } } }] },
    release: { id: slot.release_profile_id, project_id: projectId, verification_profile_id: slot.verification_profile_id,
      storage_root: slot.storage_root, output_path: 'product', public_url: slot.endpoint, listen_host: '127.0.0.1', listen_port: port,
      health_checks: [{ path: '/' }], health_timeout_ms: 5000,
      monitoring: { interval_ms: 3600000, failure_threshold: 1 }, criterion_acceptance: { version: 1 } },
  };
}

export function slotSourceMappings(source, slots) {
  return { version: 1, releaseProfileIds: slots.map(slot => slot.release_profile_id),
    destinationResearchMappings: slots.map(slot => ({ sourceProfileDigest: source.verifier.profile_digest,
      destinationProfileId: slot.verification_profile_id, sourceRelease: source.release,
      commandPairs: [{ source_command_id: 'browser-acceptance', destination_command_id: 'browser-acceptance' }] })) };
}

/** Register slot zero first so normal scheduling retains its original identities.
 * Later scopes reuse logical contributors but always receive fresh instances. */
export async function createSlotInstances({ role, computerId, slots, createInstance }) {
  const instances = [], logical = [], seen = new Set();
  for (const slot of slots) for (let index = 0; index < 2; index++) {
    // Never submit capabilities: only the real node heartbeat supplies them.
    const created = await createInstance({ runtime: 'codex', workspace_root: slot.workspace,
      ...(slot.index === 0 ? { display_name: role + ' contributor ' + (index + 1) } : { agent_id: logical[index].agent_id }) });
    const instance = created.agent_instance, agent = created.agent;
    assert.ok(typeof agent?.id === 'string' && agent.id && typeof instance?.id === 'string' && instance.id, 'Missing configured instance identity');
    assert.equal(instance.computer_id, computerId); assert.equal(instance.agent_id, agent.id);
    assert.equal(instance.runtime, 'codex'); assert.equal(instance.workspace_root, slot.workspace);
    assert.equal(seen.has(instance.id), false, 'A slot reused another instance'); seen.add(instance.id);
    const participant = { agent_id: agent.id, instance_id: instance.id, runtime: instance.runtime,
      model_profile_id: instance.model_profile_id ?? null, effort_profile_id: instance.effort_profile_id ?? null };
    if (slot.index === 0) logical.push(participant);
    else for (const key of ['agent_id', 'runtime', 'model_profile_id', 'effort_profile_id'])
      assert.equal(participant[key], logical[index][key], 'Configured slots changed a logical contributor');
    if (index === 1) assert.notEqual(logical[0].agent_id, logical[1].agent_id, 'Writer and reviewer must be independent');
    instances.push({ ...participant, slot_index: slot.index, participant_role: index === 0 ? 'writer' : 'reviewer', workspace: slot.workspace });
  }
  return instances;
}

export function configuredSlotLayout(node, sessionRoot) {
  const configured = node.workspace_slots;
  if (configured === undefined) return requestSlotLayout(sessionRoot, node.role, 0); // Original one-scope sessions.
  assert.ok(configured && configured.version === 1 && Array.isArray(configured.members)
    && Object.keys(configured).sort().join(',') === 'max_retries,members,version', 'Unsupported original workspace slot layout');
  assert.ok(node.role !== 'source' || configured.max_retries === 0, 'Source has one original workspace');
  const expected = requestSlotLayout(sessionRoot, node.role, configured.max_retries);
  assert.equal(configured.members.length, expected.length, 'Original workspace slot count changed');
  const endpoints = new Set();
  return expected.map((slot, index) => {
    const member = configured.members[index];
    assert.ok(member && typeof member === 'object', 'Missing original workspace slot');
    const { endpoint, ...layout } = member;
    assert.deepEqual(layout, slot, 'Original workspace slot layout changed');
    assertLoopbackEndpoint(endpoint);
    assert.equal(endpoints.has(endpoint), false, 'Original workspace slots share an endpoint'); endpoints.add(endpoint);
    return { ...slot, endpoint };
  });
}

export function slotConfigurationPaths(sessionRoot, nodes) {
  return nodes.flatMap(node => [
    ...configuredSlotLayout(node, sessionRoot).map(slot => slot.browser_config),
    ...['verifiers.json', 'releases.json', 'discovered-capabilities.json', 'source.json']
      .map(name => path.join(sessionRoot, node.role, 'config', name)),
  ]).sort();
}

/** The accepted request selects exactly one previously discovered profile pair.
 * Endpoints and workspace paths are checked after selection, never guessed. */
export function selectPublicationSlot(slots, request) {
  const matching = slots.filter(slot => slot.release_profile_id === request?.release_profile_id
    && slot.verification_profile_id === request?.verification_profile_id);
  assert.equal(matching.length, 1, 'Publication must select one original configured slot');
  const slot = matching[0], binding = slot.release?.binding;
  assert.ok(binding && slot.verifier, 'Missing original slot capability discovery');
  assert.equal(binding.workspace_root, slot.workspace, 'Publication slot workspace changed');
  assert.equal(binding.release_profile_id, slot.release_profile_id);
  assert.equal(binding.verification_profile_id, slot.verification_profile_id);
  assert.equal(binding.project_id, request.project_id);
  assert.equal(binding.verification_profile_digest, slot.verifier.profile_digest);
  assert.equal(request.verification_profile_digest, slot.verifier.profile_digest, 'Publication verifier differs from its original slot');
  assert.deepEqual(request.acceptance_binding?.release_binding, binding, 'Publication differs from its original slot binding');
  return slot;
}
