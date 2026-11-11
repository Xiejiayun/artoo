import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { command, encryptBackup, verifyEncryptedBackup, safeRecovery, journalDigest, validateTarget } from './support.mjs';

test('rollback requires the same complete migration journal', () => {
  const first = [{ position: 0, checksum: 'a'.repeat(64) }];
  assert.equal(safeRecovery(first, structuredClone(first)), true);
  assert.equal(safeRecovery(first, [...first, { position: 1, checksum: 'b'.repeat(64) }]), false);
  assert.equal(safeRecovery(first, [{ position: 0, checksum: 'b'.repeat(64) }]), false);
  assert.throws(() => journalDigest([{ position: 2, checksum: 'a'.repeat(64) }]), /complete ordered/);
});

test('backup authenticates exact bytes and rejects corruption or another recovery key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artoo-backup-test-'));
  try {
    const key = randomBytes(32), contents = randomBytes(131073);
    await writeFile(join(root, 'input'), contents);
    const envelope = await encryptBackup(join(root, 'input'), join(root, 'encrypted'), key);
    await verifyEncryptedBackup(join(root, 'encrypted'), envelope, key, join(root, 'restored'));
    assert.deepEqual(await readFile(join(root, 'restored')), contents);
    await assert.rejects(verifyEncryptedBackup(join(root, 'encrypted'), envelope, randomBytes(32)));
    const broken = Buffer.from(await readFile(join(root, 'encrypted'))); broken[5] ^= 1;
    await writeFile(join(root, 'broken'), broken);
    await assert.rejects(verifyEncryptedBackup(join(root, 'broken'), envelope, key), /checksum/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deployment target rejects mutable, foreign registry and credential-bearing origins', () => {
  const env = { AZURE_SUBSCRIPTION_ID: 'a79d7fcd-8b10-426b-82e2-6a1655a9096e', AZURE_RESOURCE_GROUP: 'jiaxie_group',
    AZURE_CONTAINER_APP: 'artoo', AZURE_CONTAINER_REGISTRY: 'jiaxie', AZURE_REGISTRY_HOST: 'example.azurecr.io',
    ARTOO_ORIGIN: 'https://artoo.example.com', SOURCE_SHA: 'a'.repeat(40), RELEASE_IMAGE: `example.azurecr.io/artoo@sha256:${'b'.repeat(64)}` };
  assert.equal(validateTarget(env).app, 'artoo');
  for (const patch of [{ RELEASE_IMAGE: 'example.azurecr.io/artoo:latest' }, { RELEASE_IMAGE: `foreign.azurecr.io/artoo@sha256:${'b'.repeat(64)}` },
    { ARTOO_ORIGIN: 'https://user:password@artoo.example.com' }, { SOURCE_SHA: 'main' }]) assert.throws(() => validateTarget({ ...env, ...patch }));
});

test('real command failures suppress provider credentials and time out with observed process closure', async () => {
  assert.equal(await command(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok');
  await assert.rejects(command(process.execPath, ['-e', 'console.error("private-provider-credential");process.exit(3)'],
    { label: 'Provider probe' }), error => error.message.includes('Provider probe failed') && !error.message.includes('private-provider-credential'));
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(() => {},1000)'], { timeout: 50, label: 'Deadline probe' }), /Deadline probe failed/);
});
