import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { check, verifyEncryptedBackup } from './support.mjs';

try {
  const [directory, output] = process.argv.slice(2);
  check(directory && output && process.argv.length === 4, 'Usage: node scripts/azure-release/decrypt-backup.mjs <artifact-directory> <new-private-archive-path>');
  const key = Buffer.from(process.env.ARTOO_BACKUP_KEY ?? '', 'base64');
  check(key.length === 32, 'Supply the retained 32-byte recovery key through ARTOO_BACKUP_KEY.');
  try {
    const root = resolve(directory), envelope = JSON.parse(readFileSync(resolve(root, 'backup-manifest.json'), 'utf8'));
    await verifyEncryptedBackup(resolve(root, 'backup.tar.gz.enc'), envelope, key, resolve(output));
    console.log('Backup authenticated and decrypted. The archive contains production credentials and private data; keep it private.');
  } finally { key.fill(0); }
} catch { console.error('Backup decryption failed. Check the key, manifest and checksums; existing files are never overwritten.'); process.exitCode = 1; }
