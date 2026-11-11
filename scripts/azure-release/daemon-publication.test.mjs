import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyCandidate, renderInstaller } from './daemon-publication.mjs';

const bytes = Buffer.from('exact immutable package bytes');
const source = 'a'.repeat(40), version = '0.1.0-rc.3', runId = '123', runAttempt = '2';
function fixture() {
  const identity = { sourceCommit: source, sourceRef: 'refs/heads/main', eventName: 'push', runId, runAttempt,
    name: '@jiayunxie/artood', version, sha256: createHash('sha256').update(bytes).digest('hex'),
    requiredPlatforms: ['linux-arm64', 'linux-x64', 'win32-x64'] };
  return { bytes, source, version, runId, runAttempt,
    metadata: { ...identity, format: 'artoo.npm-candidate.v1', tarball: `jiayunxie-artood-${version}.tgz`, size: bytes.length,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
    summary: { ...identity, status: 'passed', platforms: identity.requiredPlatforms } };
}

test('publication binds exact bytes, source, run attempt and all required platform reports', () => {
  assert.equal(verifyCandidate(fixture()).size, bytes.length);
  for (const [member, patch] of [
    ['metadata', { sourceCommit: 'b'.repeat(40) }], ['metadata', { sourceRef: 'refs/pull/33/merge' }],
    ['metadata', { size: bytes.length + 1 }], ['metadata', { sha256: 'c'.repeat(64) }],
    ['metadata', { integrity: 'sha512-wrong' }], ['metadata', { runAttempt: '1' }],
    ['metadata', { requiredPlatforms: ['win32-x64'] }],
    ['summary', { runId: '456' }], ['summary', { runAttempt: '1' }], ['summary', { eventName: 'pull_request' }],
    ['summary', { platforms: ['linux-x64', 'win32-x64'] }], ['summary', { status: 'failed' }],
    ['summary', { sha256: 'c'.repeat(64) }], ['summary', { sourceCommit: 'b'.repeat(40) }],
  ]) {
    const input = fixture(); input[member] = { ...input[member], ...patch };
    assert.throws(() => verifyCandidate(input), `${member} ${JSON.stringify(patch)}`);
  }
  assert.throws(() => verifyCandidate({ ...fixture(), bytes: Buffer.from('different package bytes') }));
});

test('both committed installers pin version, digest and byte length without unresolved placeholders', () => {
  const candidate = verifyCandidate(fixture());
  const fields = { PACKAGE_VERSION: version, PACKAGE_SHA256: candidate.hash, PACKAGE_SIZE: candidate.size };
  for (const name of ['install.ps1', 'install.sh']) {
    const template = readFileSync(new URL(`../npm-daemon/${name}`, import.meta.url), 'utf8');
    const rendered = renderInstaller(template, fields);
    assert.ok(rendered.includes(version) && rendered.includes(candidate.hash) && rendered.includes(String(candidate.size)));
    assert.doesNotMatch(rendered, /\{\{PACKAGE_/);
    assert.throws(() => renderInstaller(template + '{{PACKAGE_UNKNOWN}}', fields), /unresolved/);
    assert.throws(() => renderInstaller(template.replaceAll('{{PACKAGE_SHA256}}', ''), fields), /lacks/);
  }
});
