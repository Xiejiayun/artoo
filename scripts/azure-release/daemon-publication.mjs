import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { github, requireJobs, verifyMainGates } from './gates.mjs';
import { command } from './support.mjs';

const required = ['linux-arm64', 'linux-x64', 'win32-x64'];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function verifyCandidate({ metadata, summary, bytes, source, version, runId, runAttempt }) {
  assert.match(version, versionPattern);
  assert.match(source, /^[a-f0-9]{40}$/);
  const asset = `jiayunxie-artood-${version}.tgz`;
  const hash = createHash('sha256').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(metadata.format, 'artoo.npm-candidate.v1');
  assert.equal(metadata.name, '@jiayunxie/artood');
  assert.equal(metadata.version, version);
  assert.equal(metadata.tarball, asset);
  assert.equal(metadata.sourceCommit, source);
  assert.equal(metadata.sourceRef, 'refs/heads/main');
  assert.ok(['push', 'workflow_dispatch'].includes(metadata.eventName));
  assert.equal(String(metadata.runId), String(runId));
  assert.equal(String(metadata.runAttempt), String(runAttempt));
  assert.equal(metadata.size, bytes.length);
  assert.equal(metadata.sha256, hash);
  assert.equal(metadata.integrity, integrity);
  assert.deepEqual([...metadata.requiredPlatforms].sort(), required);
  assert.equal(summary.status, 'passed');
  assert.equal(summary.sourceCommit, source);
  assert.equal(summary.sourceRef, 'refs/heads/main');
  assert.equal(summary.eventName, metadata.eventName);
  assert.equal(String(summary.runId), String(runId));
  assert.equal(String(summary.runAttempt), String(runAttempt));
  assert.equal(summary.name, metadata.name);
  assert.equal(summary.version, version);
  assert.equal(summary.sha256, hash);
  assert.deepEqual([...summary.platforms].sort(), required);
  assert.deepEqual([...summary.requiredPlatforms].sort(), required);
  return { asset, hash, integrity, size: bytes.length };
}

export function renderInstaller(template, fields) {
  let output = template;
  for (const [name, value] of Object.entries(fields)) {
    assert.ok(template.includes(`{{${name}}}`), `Installer lacks its ${name} pin.`);
    output = output.replaceAll(`{{${name}}}`, String(value));
  }
  assert.ok(!/\{\{PACKAGE_[A-Z_]+\}\}/.test(output), 'Installer contains an unresolved package pin.');
  return output;
}

async function main(mode) {
  const env = process.env, source = env.SOURCE_SHA, version = env.PACKAGE_VERSION, repository = env.GITHUB_REPOSITORY;
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(source, env.GITHUB_SHA);
  assert.match(version, versionPattern);
  assert.match(env.CANDIDATE_RUN_ID, /^\d+$/);
  const root = resolve(env.RELEASE_DIRECTORY);
  if (mode === 'finalize') {
    await verifyMainGates({ repository, sha: source });
    const run = await github(`/repos/${repository}/actions/runs/${env.CANDIDATE_RUN_ID}`);
    assert.equal(String(run.run_attempt), env.CANDIDATE_RUN_ATTEMPT, 'The package matrix was rerun; inspect the new attempt instead.');
    const refs = await github(`/repos/${repository}/git/matching-refs/tags/artood-v${version}`);
    assert.ok(!refs.some(ref => ref.ref === `refs/tags/artood-v${version}`), 'The release tag already exists; choose a new version.');
    console.log('Main and the reviewed candidate attempt are unchanged; the release tag is unused.');
  } else if (mode === 'inspect') {
    const gates = await verifyMainGates({ repository, sha: source });
    const tag = `refs/tags/artood-v${version}`;
    const matching = await github(`/repos/${repository}/git/matching-refs/tags/artood-v${version}`);
    assert.ok(!matching.some(ref => ref.ref === tag), 'The release tag already exists; choose a new version.');
    const run = await github(`/repos/${repository}/actions/runs/${env.CANDIDATE_RUN_ID}`);
    assert.equal(run.head_sha, source);
    assert.equal(run.head_branch, 'main');
    assert.ok(['push', 'workflow_dispatch'].includes(run.event));
    assert.equal(run.path, '.github/workflows/npm-daemon-cross-platform.yml');
    const jobs = await github(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    assert.ok(jobs.total_count <= 100);
    const receipt = requireJobs(run, jobs.jobs, ['build', 'Required Windows/Linux aggregate', ...required.map(platform => `Required package (${platform})`)]);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'release-gates.json'), JSON.stringify({ ...gates, candidate: receipt }, null, 2) + '\n');
    appendFileSync(env.GITHUB_ENV, `CANDIDATE_RUN_ATTEMPT=${run.run_attempt}\nCANDIDATE_ARTIFACT=npm-daemon-candidate-${run.id}-${run.run_attempt}\nSUMMARY_ARTIFACT=npm-daemon-cross-platform-${run.id}-${run.run_attempt}\n`);
    console.log(`Candidate run ${run.id}, attempt ${run.run_attempt}, qualifies for source ${source}.`);
  } else {
    assert.equal(mode, 'render');
    const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    const metadata = readJson(join(root, 'candidate', 'release-metadata.json'));
    const summary = readJson(join(root, 'summary', 'cross-platform-summary.json'));
    const asset = `jiayunxie-artood-${version}.tgz`, bytes = readFileSync(join(root, 'candidate', asset));
    const candidate = verifyCandidate({ metadata, summary, bytes, source, version, runId: env.CANDIDATE_RUN_ID, runAttempt: env.CANDIDATE_RUN_ATTEMPT });
    const pkg = JSON.parse(await command('tar', ['-xOzf', join(root, 'candidate', asset), 'package/package.json'], { label: 'Candidate manifest inspection' }));
    assert.equal(pkg.name, '@jiayunxie/artood'); assert.equal(pkg.version, version); assert.notEqual(pkg.private, true);
    assert.deepEqual(pkg.bin, { artood: 'bin/artood.mjs' });
    for (const key of ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'workspaces']) assert.equal(pkg[key], undefined);
    const output = join(root, 'public'); mkdirSync(output);
    copyFileSync(join(root, 'candidate', asset), join(output, asset));
    copyFileSync(join(root, 'summary', 'cross-platform-summary.json'), join(output, 'cross-platform-summary.json'));
    copyFileSync(join(root, 'release-gates.json'), join(output, 'release-gates.json'));
    const installers = {};
    for (const name of ['install.ps1', 'install.sh']) {
      const template = readFileSync(join('scripts', 'npm-daemon', name), 'utf8');
      const content = renderInstaller(template, { PACKAGE_VERSION: version, PACKAGE_SHA256: candidate.hash, PACKAGE_SIZE: candidate.size });
      writeFileSync(join(output, name), content);
      installers[name] = { sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) };
    }
    writeFileSync(join(output, 'release-metadata.json'), JSON.stringify({ ...metadata, installers }, null, 2) + '\n');
    writeFileSync(join(root, 'notes.md'), `Install and connect this computer with the one-command setup in your Artoo Web portal.\n\n` +
      `Package: \`@jiayunxie/artood@${version}\`\n\nSource: \`${source}\`\n\nSHA-256: \`${candidate.hash}\`\n\n` +
      `The same package passed the required Windows x64, Linux x64 and Linux arm64 matrix. macOS implementation is included but release qualification remains deferred. ` +
      `GitHub distribution is available here; npm publication is a separate staged approval and registry-verification step.\n`);
    appendFileSync(env.GITHUB_ENV, `RELEASE_TAG=artood-v${version}\nPUBLIC_ASSET_DIRECTORY=${output}\nPACKAGE_SHA256=${candidate.hash}\n`);
    console.log(`Verified ${metadata.name}@${version}; installers pin ${candidate.hash} (${candidate.size} bytes).`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
