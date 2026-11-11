import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_GATES = Object.freeze({
  'preview.yml': ['shared'],
  'azure-deployment.yml': ['postgres', 'image'],
});

export function selectMainRun(runs, sha) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  const eligible = runs.filter(run => run.head_sha === sha && run.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run.event));
  const selected = eligible.sort((a, b) => b.id - a.id)[0];
  assert.ok(selected, `No main workflow run exists for ${sha}.`);
  return selected;
}

export function requireJobs(run, jobs, names) {
  for (const name of names) {
    const matches = jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, `Expected exactly one ${name} job in run ${run.id}, attempt ${run.run_attempt}.`);
    assert.equal(matches[0].status, 'completed', `${name} has not completed.`);
    assert.equal(matches[0].conclusion, 'success', `${name} did not pass.`);
  }
  return { run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha,
    url: run.html_url, overall_status: run.status, overall_conclusion: run.conclusion,
    jobs: jobs.filter(job => names.includes(job.name)).map(job => ({ name: job.name, id: job.id, conclusion: job.conclusion })) };
}

export async function github(path, { token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  assert.ok(token, 'GH_TOKEN is required to inspect authoritative Actions runs.');
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `GitHub metadata request failed (${response.status}).`);
  return response.json();
}

export async function verifyMainGates({ repository, sha, get = github, gates = WEB_GATES }) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  const head = await get(`/repos/${repository}/git/ref/heads/main`);
  assert.equal(head.object.sha, sha, 'Release input must be the current main commit.');
  const receipts = {};
  for (const [workflow, names] of Object.entries(gates)) {
    const list = await get(`/repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&branch=main&per_page=100`);
    const run = selectMainRun(list.workflow_runs, sha);
    const results = await get(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    assert.ok(results.total_count <= 100, 'Workflow jobs require pagination; refusing incomplete evidence.');
    receipts[workflow] = requireJobs(run, results.jobs, names);
  }
  return { version: 1, source_sha: sha, repository, verified_at: new Date().toISOString(), gates: receipts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Production releases run only from main.');
    assert.equal(process.env.SOURCE_SHA, process.env.GITHUB_SHA, 'Dispatch SHA and workflow checkout must match.');
    const receipt = await verifyMainGates({ repository: process.env.GITHUB_REPOSITORY, sha: process.env.SOURCE_SHA });
    const output = resolve(process.env.RELEASE_EVIDENCE_DIRECTORY);
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(join(output, 'gates.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    console.log(`Required main gates passed for ${receipt.source_sha}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
