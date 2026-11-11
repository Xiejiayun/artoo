import test from 'node:test';
import assert from 'node:assert/strict';
import { command } from './support.mjs';
import { POLICY_ENV, readPolicyInput, readPolicyConfiguration, planPolicyConfiguration,
  policyForPhase, imageUpdateArguments, verifyPolicyConfiguration } from './policy.mjs';

const containerName = 'server';
const appArgs = ['--resource-group', 'fixture-group', '--name', 'fixture-app'];
const image = `fixture.azurecr.io/artoo@sha256:${'a'.repeat(64)}`;
const provider = { id: 'fixture', name: 'Fixture "A & B" provider', privacy_url: 'https://provider.example.com/privacy' };
const input = JSON.stringify({ mode: 'external', providers: [provider] }, null, 2);
const snapshot = entries => ({ properties: { template: { containers: [{ name: containerName,
  env: [{ name: 'UNRELATED', value: 'preserve-this-value' }, ...entries] }] } } });
const argsFor = policy => imageUpdateArguments(appArgs, containerName, image, 'fixture-release', policy);

test('optional policy uses the server schema and preserves the exact reviewed input bytes', () => {
  assert.equal(readPolicyInput(undefined), null);
  assert.equal(readPolicyInput(''), null);
  const parsed = readPolicyInput(input);
  assert.equal(parsed.value, input);
  assert.match(parsed.version, /^sha256:[a-f0-9]{64}$/);
  assert.equal(readPolicyInput(JSON.stringify(JSON.parse(input))).version, parsed.version);
});

test('invalid policy is rejected with bounded errors that never include submitted metadata', () => {
  const marker = 'private-credential-must-not-appear';
  for (const value of ['   ', `{"api_key":"${marker}"`, JSON.stringify({ mode: 'external', providers: [] }),
    JSON.stringify({ mode: 'local', providers: [provider] }),
    JSON.stringify({ mode: 'external', providers: [{ ...provider, api_key: marker }] }),
    JSON.stringify({ mode: 'external', providers: [{ ...provider, privacy_url: `https://user:${marker}@provider.example.com/privacy` }] }),
    marker.repeat(4096)]) {
    assert.throws(() => readPolicyInput(value), error => error.message.length < 200 && !error.message.includes(marker));
  }
});

test('an absent input preserves literal, secret-reference and absent policies without adding env arguments', () => {
  for (const entries of [[], [{ name: POLICY_ENV, value: input, secretRef: null }],
    [{ name: POLICY_ENV, secretRef: 'existing-policy', value: null }], [{ name: POLICY_ENV, value: '' }]]) {
    const original = snapshot(entries), before = structuredClone(original);
    const plan = planPolicyConfiguration(original, containerName, readPolicyInput(''));
    const policy = policyForPhase(plan, 'deploy');
    assert.equal(policy.write, null);
    assert.equal(argsFor(policy.write).some(arg => arg.includes('env-vars') || arg.includes(POLICY_ENV)), false);
    verifyPolicyConfiguration(original, containerName, policy.expected);
    assert.deepEqual(original, before);
  }
});

test('the actual image update argv carries one complete JSON value without shell parsing or other env changes', async () => {
  const original = snapshot([{ name: POLICY_ENV, secretRef: 'existing-policy', value: null }]);
  const plan = planPolicyConfiguration(original, containerName, readPolicyInput(input));
  const args = argsFor(policyForPhase(plan, 'deploy').write);
  const observed = JSON.parse(await command(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args]));
  assert.deepEqual(observed, ['containerapp', 'update', ...appArgs, '--container-name', containerName,
    '--image', image, '--revision-suffix', 'fixture-release', '--min-replicas', '1', '--max-replicas', '1',
    '--set-env-vars', `${POLICY_ENV}=${input}`]);
  assert.equal(observed.some(arg => arg.includes('UNRELATED') || arg.includes('preserve-this-value')), false);
  verifyPolicyConfiguration(snapshot([{ name: POLICY_ENV, value: input }]), containerName, policyForPhase(plan, 'deploy').expected);
});

test('recovery restores the original literal bytes rather than reformatting the old JSON', () => {
  const previous = ' \n{"mode" : "local", "providers" : []}\n';
  const plan = planPolicyConfiguration(snapshot([{ name: POLICY_ENV, value: previous }]), containerName, readPolicyInput(input));
  const recovery = policyForPhase(plan, 'recover');
  assert.deepEqual(argsFor(recovery.write).slice(-2), ['--set-env-vars', `${POLICY_ENV}=${previous}`]);
  verifyPolicyConfiguration(snapshot([{ name: POLICY_ENV, value: previous, secretRef: null }]), containerName, recovery.expected);
  assert.throws(() => verifyPolicyConfiguration(snapshot([{ name: POLICY_ENV, value: previous.trim() }]), containerName, recovery.expected), /differs/);
});

test('recovery restores a secret reference without copying its value into public configuration', () => {
  const plan = planPolicyConfiguration(snapshot([{ name: POLICY_ENV, secretRef: 'old-policy', value: null }]), containerName, readPolicyInput(input));
  const recovery = policyForPhase(plan, 'recover');
  assert.deepEqual(argsFor(recovery.write).slice(-2), ['--set-env-vars', `${POLICY_ENV}=secretref:old-policy`]);
  verifyPolicyConfiguration(snapshot([{ name: POLICY_ENV, secretRef: 'old-policy' }]), containerName, recovery.expected);
  assert.throws(() => verifyPolicyConfiguration(snapshot([{ name: POLICY_ENV, value: 'secretref:old-policy' }]), containerName, recovery.expected));
});

test('recovery removes a newly introduced policy when the original variable was absent', () => {
  const plan = planPolicyConfiguration(snapshot([]), containerName, readPolicyInput(input));
  const recovery = policyForPhase(plan, 'recover');
  assert.deepEqual(argsFor(recovery.write).slice(-2), ['--remove-env-vars', POLICY_ENV]);
  verifyPolicyConfiguration(snapshot([]), containerName, recovery.expected);
  assert.throws(() => verifyPolicyConfiguration(snapshot([{ name: POLICY_ENV, value: '' }]), containerName, recovery.expected), /differs/);
  assert.throws(() => verifyPolicyConfiguration(snapshot([{ name: POLICY_ENV, value: input }]), containerName, recovery.expected), /differs/);
});

test('preparation rejects ambiguous or unrestorable existing policy representations', () => {
  const entry = { name: POLICY_ENV, value: input };
  for (const entries of [[entry, entry], [{ ...entry, secretRef: 'also-a-secret' }],
    [{ name: POLICY_ENV, value: null }], [{ ...entry, unsupported: true }],
    [{ name: POLICY_ENV, value: 'secretref:literal-is-not-a-reference' }]]) {
    assert.throws(() => planPolicyConfiguration(snapshot(entries), containerName, readPolicyInput(input)));
  }
  assert.throws(() => readPolicyConfiguration(snapshot([]), 'different-container'), /original application/);
  assert.throws(() => policyForPhase({}, 'unknown'), /Unknown/);
});
