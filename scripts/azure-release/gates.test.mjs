import test from 'node:test';
import assert from 'node:assert/strict';
import { requireJobs, selectMainRun, verifyMainGates } from './gates.mjs';

const sha = 'a'.repeat(40);
const run = { id: 8, run_attempt: 2, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure' };
const job = name => ({ name, id: 1, status: 'completed', conclusion: 'success' });

test('release gates reject PR evidence, old commits and an unpassed latest run', () => {
  assert.throws(() => selectMainRun([{ ...run, event: 'pull_request' }], sha));
  assert.throws(() => selectMainRun([{ ...run, head_sha: 'b'.repeat(40) }], sha));
  const latest = selectMainRun([run, { ...run, id: 9, run_attempt: 1 }], sha);
  assert.equal(latest.id, 9);
  assert.throws(() => requireJobs(latest, [{ ...job('shared'), conclusion: 'failure' }], ['shared']));
});

test('only named required jobs qualify; unrelated optional platform failures do not change their result', () => {
  const result = requireJobs(run, [job('shared'), { ...job('ios'), conclusion: 'failure' }], ['shared']);
  assert.equal(result.overall_conclusion, 'failure');
  assert.equal(result.jobs.length, 1);
  for (const jobs of [[], [job('shared'), job('shared')], [{ ...job('shared'), status: 'in_progress' }], [{ ...job('shared'), conclusion: 'skipped' }]]) {
    assert.throws(() => requireJobs(run, jobs, ['shared']));
  }
});

test('authoritative gate queries bind current main, actual attempt and complete job discovery', async () => {
  const paths = [];
  const get = async path => {
    paths.push(path);
    if (path.endsWith('/git/ref/heads/main')) return { object: { sha } };
    if (path.includes('/workflows/')) return { workflow_runs: [run] };
    return { total_count: 1, jobs: [job('shared')] };
  };
  const result = await verifyMainGates({ repository: 'owner/repo', sha, get, gates: { 'preview.yml': ['shared'] } });
  assert.equal(result.source_sha, sha);
  assert.ok(paths.some(path => path.includes('/runs/8/attempts/2/jobs')));
  await assert.rejects(verifyMainGates({ repository: 'owner/repo', sha, gates: {}, get: async () => ({ object: { sha: 'b'.repeat(40) } }) }), /current main/);
  await assert.rejects(verifyMainGates({ repository: 'owner/repo', sha, gates: { 'preview.yml': ['shared'] }, get: async path => path.includes('/jobs?') ? { total_count: 101, jobs: [job('shared')] } : get(path) }), /pagination/);
});
