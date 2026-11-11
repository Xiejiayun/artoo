import { loadAiDataSharingPolicy } from '../../apps/server/src/config/ai-data-sharing.ts';
import { check, ReleaseError } from './support.mjs';

export const POLICY_ENV = 'ARTOO_AI_DATA_SHARING_POLICY';

/** GitHub supplies an empty string for a missing optional environment variable. */
export function readPolicyInput(value) {
  if (value === undefined || value === '') return null;
  check(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 48 * 1024,
    'AI sharing policy must be at most 48 KiB of reviewed public JSON metadata.');
  try {
    const policy = loadAiDataSharingPolicy({ [POLICY_ENV]: value });
    check(policy !== null, 'AI sharing policy cannot be whitespace.');
    return { value, version: policy.version };
  } catch {
    // Submitted metadata may accidentally contain credentials. Never echo it,
    // or a parser exception, into the public Actions log.
    throw new ReleaseError('Invalid ARTOO_AI_DATA_SHARING_POLICY public metadata; use the server policy schema.');
  }
}

/** Retain literal bytes or the existing secret reference; absence is distinct. */
export function readPolicyConfiguration(snapshot, containerName) {
  const containers = snapshot?.properties?.template?.containers;
  check(Array.isArray(containers) && containers.length === 1 && containers[0].name === containerName,
    'AI sharing policy requires the original application container.');
  const env = containers[0].env ?? [];
  check(Array.isArray(env), 'Invalid application environment configuration.');
  const entries = env.filter(entry => entry?.name === POLICY_ENV);
  check(entries.length <= 1, 'AI sharing policy has duplicate environment entries.');
  if (entries.length === 0) return { kind: 'absent' };
  const entry = entries[0];
  check(Object.keys(entry).every(key => ['name', 'value', 'secretRef'].includes(key)),
    'AI sharing policy has an unsupported environment representation.');
  if (entry.secretRef !== undefined && entry.secretRef !== null && entry.secretRef !== '') {
    check(typeof entry.secretRef === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(entry.secretRef) && entry.value == null,
      'AI sharing policy has an unsupported secret reference.');
    return { kind: 'secretRef', name: entry.secretRef };
  }
  check(typeof entry.value === 'string' && !entry.value.includes('\0') && !entry.value.startsWith('secretref:'),
    'AI sharing policy cannot be restored as an exact literal environment value.');
  return { kind: 'value', value: entry.value };
}

export function planPolicyConfiguration(snapshot, containerName, input) {
  return { before: readPolicyConfiguration(snapshot, containerName),
    update: input === null ? null : { kind: 'value', value: input.value },
    version: input?.version ?? null };
}

export function policyForPhase(plan, phase) {
  check(['deploy', 'recover'].includes(phase), 'Unknown AI sharing policy release phase.');
  return phase === 'recover'
    ? { write: plan.before, expected: plan.before }
    : { write: plan.update, expected: plan.update ?? plan.before };
}

/** These arguments are passed directly to spawn, never through a shell. */
export function imageUpdateArguments(appArgs, containerName, image, suffix, policy) {
  const args = ['containerapp', 'update', ...appArgs, '--container-name', containerName, '--image', image,
    '--revision-suffix', suffix, '--min-replicas', '1', '--max-replicas', '1'];
  if (policy === null) return args;
  if (policy.kind === 'absent') return [...args, '--remove-env-vars', POLICY_ENV];
  if (policy.kind === 'value') return [...args, '--set-env-vars', `${POLICY_ENV}=${policy.value}`];
  if (policy.kind === 'secretRef') return [...args, '--set-env-vars', `${POLICY_ENV}=secretref:${policy.name}`];
  throw new ReleaseError('Unknown AI sharing policy environment representation.');
}

export function verifyPolicyConfiguration(snapshot, containerName, expected) {
  check(JSON.stringify(readPolicyConfiguration(snapshot, containerName)) === JSON.stringify(expected),
    'Azure AI sharing policy configuration differs from the intended release state.');
}
