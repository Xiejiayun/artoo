// Controlled bootstrap/configuration regression only. No node, provider,
// browser, product, recovery, publisher or native process is executed here.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { initialMaxRetries, requestSlotLayout, slotProfiles, slotSourceMappings, createSlotInstances,
  configuredSlotLayout, slotConfigurationPaths, selectPublicationSlot } from './slots.mjs';
import { selectStoppedProductConfiguration } from './inputs.mjs';

const sessionRoot = path.resolve(os.tmpdir(), 'artoo-slot-fixture', 'session-original');
const digest = n => 'sha256:' + String(n).repeat(64);
function fixture(maxRetries = initialMaxRetries, selectedIndex = maxRetries) {
  const slots = requestSlotLayout(sessionRoot, 'destination', maxRetries)
    .map(slot => ({ ...slot, endpoint: 'http://127.0.0.1:' + (49152 + slot.index) }));
  const destination = { role: 'destination', identity: { project_id: 'proj_artoo' },
    workspace_slots: { version: 1, max_retries: maxRetries, members: structuredClone(slots) } };
  const profiles = slots.map(slot => slotProfiles({ slot, projectId: 'proj_artoo',
    nodeExecutable: path.join(sessionRoot, 'fixture-node.exe'), browserExecutable: path.join(sessionRoot, 'fixture-browser.exe'),
    acceptanceCli: path.join(sessionRoot, 'bundle', 'web-acceptance-cli.js') }));
  const discovered = { slots: slots.map(slot => ({ index: slot.index,
    verifier: { profile_digest: digest(slot.index + 1) }, release: { binding: {
      project_id: 'proj_artoo', workspace_root: slot.workspace, release_profile_id: slot.release_profile_id,
      verification_profile_id: slot.verification_profile_id, verification_profile_digest: digest(slot.index + 1),
      release_profile_digest: digest(slot.index + 5), contract_digest: digest(9) } } })) };
  Object.assign(discovered, { verifier: discovered.slots[0].verifier, release: discovered.slots[0].release });
  const selected = slots[selectedIndex], capabilities = discovered.slots[selectedIndex];
  const request = { project_id: 'proj_artoo', release_profile_id: selected.release_profile_id,
    verification_profile_id: selected.verification_profile_id, verification_profile_digest: capabilities.verifier.profile_digest,
    acceptance_binding: { release_binding: structuredClone(capabilities.release.binding) } };
  return { sessionRoot, destination, publication: { request, url: selected.endpoint,
    receipt: { release_profile_digest: capabilities.release.binding.release_profile_digest } },
    verifiers: profiles.map(profile => profile.verifier), releases: profiles.map(profile => profile.release), discovered };
}

test('three retries prepare four isolated destination scopes and one unchanged source scope', () => {
  const source = requestSlotLayout(sessionRoot, 'source'), slots = requestSlotLayout(sessionRoot, 'destination');
  assert.equal(source.length, 1); assert.equal(slots.length, 4);
  assert.equal(slots[0].workspace, path.join(sessionRoot, 'destination', 'workspace'));
  assert.equal(slots[0].verification_profile_id, 'native-web'); assert.equal(slots[0].release_profile_id, 'native-publish');
  assert.equal(slots[3].workspace, path.join(sessionRoot, 'destination', 'slots', '3', 'workspace'));
  for (const field of ['workspace', 'storage_root', 'evidence_root', 'browser_config', 'verification_profile_id', 'release_profile_id'])
    assert.equal(new Set(slots.map(slot => slot[field])).size, 4, field + ' must be separate');
  assert.equal(source[0].workspace, path.join(sessionRoot, 'source', 'workspace'));
  assert.throws(() => requestSlotLayout(sessionRoot, 'destination', 11), /retry count/u);
  assert.throws(() => requestSlotLayout(sessionRoot, 'destination', -1), /retry count/u);
});

test('all profiles use their own protected browser/evidence/storage and full source mappings', () => {
  const f = fixture(), slots = f.destination.workspace_slots.members;
  const mapped = slotSourceMappings(f.discovered.slots[0], slots);
  assert.deepEqual(mapped.releaseProfileIds, slots.map(slot => slot.release_profile_id));
  assert.equal(mapped.destinationResearchMappings.length, 4);
  for (const slot of slots) {
    const verifier = f.verifiers[slot.index], release = f.releases[slot.index], mapping = mapped.destinationResearchMappings[slot.index];
    assert.equal(verifier.workspace_root, slot.workspace); assert.equal(verifier.commands[0].argv[2], slot.browser_config);
    assert.equal(verifier.commands[0].observation.evidence_root, slot.evidence_root);
    assert.equal(release.storage_root, slot.storage_root); assert.equal(release.public_url, slot.endpoint);
    assert.equal(release.verification_profile_id, verifier.id); assert.equal(mapping.destinationProfileId, verifier.id);
    assert.deepEqual(mapping.sourceRelease, f.discovered.slots[0].release);
    assert.deepEqual(mapping.commandPairs, [{ source_command_id: 'browser-acceptance', destination_command_id: 'browser-acceptance' }]);
  }
});

async function instances(change = () => {}) {
  const requests = [], computerId = 'destination-computer';
  const result = await createSlotInstances({ role: 'destination', computerId, slots: requestSlotLayout(sessionRoot, 'destination'),
    createInstance: async input => {
      requests.push(structuredClone(input)); const count = requests.length;
      const agent = { id: input.agent_id ?? 'logical-' + count };
      const created = { agent, agent_instance: { id: 'instance-' + count, agent_id: agent.id, computer_id: computerId,
        runtime: 'codex', workspace_root: input.workspace_root, model_profile_id: null, effort_profile_id: null } };
      change(created, count); return created;
    } });
  return { requests, result };
}
test('fresh instances retain the same writer/reviewer across all four scopes', async () => {
  const { requests, result } = await instances();
  assert.equal(result.length, 8); assert.equal(new Set(result.map(item => item.instance_id)).size, 8);
  for (const [index, input] of requests.entries()) {
    assert.equal(Object.hasOwn(input, 'capabilities'), false);
    if (index < 2) { assert.equal(input.agent_id, undefined); assert.equal(typeof input.display_name, 'string'); }
    else { assert.equal(input.agent_id, 'logical-' + (index % 2 + 1)); assert.equal(Object.hasOwn(input, 'display_name'), false); }
    assert.equal(result[index].participant_role, index % 2 === 0 ? 'writer' : 'reviewer');
    assert.equal(result[index].slot_index, Math.floor(index / 2));
  }
});
for (const [name, change] of [
  ['logical contributor', created => { created.agent.id = created.agent_instance.agent_id = 'substitute'; }],
  ['workspace', created => { created.agent_instance.workspace_root += '-other'; }],
  ['computer', created => { created.agent_instance.computer_id += '-other'; }],
  ['runtime', created => { created.agent_instance.runtime = 'other'; }],
  ['model', created => { created.agent_instance.model_profile_id = 'other'; }],
  ['effort', created => { created.agent_instance.effort_profile_id = 'other'; }],
  ['instance reuse', created => { created.agent_instance.id = 'instance-1'; }],
]) test('rejects API replacement of a later slot ' + name, async () => {
  await assert.rejects(instances((created, count) => { if (count === 3) change(created); }), { name: 'AssertionError' });
});

for (const index of [0, 1, 3]) test('reopen selects exact original publication slot ' + index + ' even with reordered profiles', () => {
  const f = fixture(3, index); f.verifiers.reverse(); f.releases.reverse(); f.discovered.slots.reverse();
  const { selected, slots } = selectStoppedProductConfiguration(f);
  assert.equal(selected.index, index); assert.equal(slots.length, 4);
  assert.equal(selected.workspace, f.destination.workspace_slots.members[index].workspace);
  assert.equal(selected.storage_root, f.destination.workspace_slots.members[index].storage_root);
  assert.equal(selected.endpoint, f.publication.url);
});

test('old single-scope metadata retains its original identities and exact file set', () => {
  const f = fixture(0, 0); delete f.destination.workspace_slots; delete f.discovered.slots;
  assert.equal(selectStoppedProductConfiguration(f).selected.index, 0);
  const source = { role: 'source' };
  const expected = ['source', 'destination'].flatMap(role => ['browser.json', 'verifiers.json', 'releases.json', 'discovered-capabilities.json', 'source.json']
    .map(name => path.join(sessionRoot, role, 'config', name))).sort();
  assert.deepEqual(slotConfigurationPaths(sessionRoot, [source, f.destination]), expected);
});

test('new configuration pins include every browser configuration exactly once', () => {
  const f = fixture(), source = { role: 'source' };
  const files = slotConfigurationPaths(sessionRoot, [source, f.destination]);
  assert.equal(files.length, 13); assert.equal(new Set(files).size, files.length);
  for (const slot of f.destination.workspace_slots.members) assert.ok(files.includes(slot.browser_config));
});

for (const [name, mutate] of [
  ['unknown profile', f => { f.publication.request.release_profile_id = 'unknown'; }],
  ['mixed profile pair', f => { f.publication.request.verification_profile_id = 'native-web'; }],
  ['changed verification digest', f => { f.publication.request.verification_profile_digest = digest(9); }],
  ['changed release binding', f => { f.publication.request.acceptance_binding.release_binding.workspace_root += '-other'; }],
  ['missing release binding', f => { delete f.publication.request.acceptance_binding; }],
  ['changed receipt digest', f => { f.publication.receipt.release_profile_digest = digest(9); }],
  ['another slot endpoint', f => { f.publication.url = f.destination.workspace_slots.members[0].endpoint; }],
  ['nested storage prefix', f => { f.releases[3].storage_root = path.join(f.releases[3].storage_root, 'substitute'); }],
  ['another workspace', f => { f.verifiers[3].workspace_root = f.verifiers[0].workspace_root; }],
  ['missing profiles', f => { f.verifiers.pop(); }],
  ['duplicate profile', f => { f.releases[3] = structuredClone(f.releases[0]); }],
  ['wrong listener', f => { f.releases[3].listen_port++; }],
  ['wrong endpoint configuration', f => { f.releases[3].public_url = 'http://127.0.0.1:50000'; }],
  ['duplicate discovery', f => { f.discovered.slots[3] = structuredClone(f.discovered.slots[0]); }],
  ['changed slot order', f => { f.destination.workspace_slots.members.reverse(); }],
  ['changed slot root', f => { f.destination.workspace_slots.members[3].workspace += '-other'; }],
  ['shared endpoint', f => { f.destination.workspace_slots.members[3].endpoint = f.destination.workspace_slots.members[0].endpoint; }],
  ['expanded slot layout', f => { f.destination.workspace_slots.extra = true; }],
  ['downgraded layout', f => { delete f.destination.workspace_slots; }],
]) test('retained slot selection fails closed for ' + name, () => {
  const f = fixture(); mutate(f);
  assert.throws(() => selectStoppedProductConfiguration(f), { name: 'AssertionError' });
});

test('a configured endpoint cannot resolve an ambiguous publication profile pair', () => {
  const f = fixture(), { selected } = selectStoppedProductConfiguration(f);
  assert.throws(() => selectPublicationSlot([selected, { ...selected }], f.publication.request), /one original configured slot/u);
});
test('source layout cannot quietly add destination retry scopes', () => {
  const source = { role: 'source', workspace_slots: { version: 1, max_retries: 3, members: requestSlotLayout(sessionRoot, 'source') } };
  assert.throws(() => configuredSlotLayout(source, sessionRoot), /one original workspace/u);
});
