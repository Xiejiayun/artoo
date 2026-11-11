import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class ReleaseError extends Error {}
export function check(condition, message) { if (!condition) throw new ReleaseError(message); }
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function journalDigest(rows) {
  check(Array.isArray(rows) && rows.every((row, i) => row.position === i && /^[a-f0-9]{64}$/.test(row.checksum)), 'Database migration journal is not a complete ordered history.');
  return sha256(JSON.stringify(rows.map(({ position, checksum }) => ({ position, checksum }))));
}

export function safeRecovery(beforeJournal, afterJournal) {
  return journalDigest(beforeJournal) === journalDigest(afterJournal);
}

export function validateTarget(env) {
  const target = { subscription: env.AZURE_SUBSCRIPTION_ID, resourceGroup: env.AZURE_RESOURCE_GROUP,
    app: env.AZURE_CONTAINER_APP, registry: env.AZURE_CONTAINER_REGISTRY, registryHost: env.AZURE_REGISTRY_HOST,
    origin: env.ARTOO_ORIGIN, source: env.SOURCE_SHA, image: env.RELEASE_IMAGE };
  check(/^[a-f0-9-]{36}$/i.test(target.subscription ?? ''), 'Set the Azure subscription ID.');
  check(/^[A-Za-z0-9_.()-]{1,90}$/.test(target.resourceGroup ?? ''), 'Invalid resource group.');
  check(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(target.app ?? ''), 'Invalid Container App name.');
  check(/^[a-z0-9]{5,50}$/.test(target.registry ?? ''), 'Invalid registry name.');
  check(/^[a-z0-9-]+\.azurecr\.io$/.test(target.registryHost ?? ''), 'Invalid registry host.');
  check(/^[a-f0-9]{40}$/.test(target.source ?? ''), 'Release requires an immutable source SHA.');
  let origin; try { origin = new URL(target.origin); } catch { throw new ReleaseError('Invalid Artoo origin.'); }
  check(origin.protocol === 'https:' && origin.origin === target.origin && !origin.username && !origin.password, 'Artoo origin must be an HTTPS origin.');
  if (target.image) check(target.image.startsWith(`${target.registryHost}/artoo@sha256:`) && /@sha256:[a-f0-9]{64}$/.test(target.image), 'Release image must use the intended registry and an immutable SHA-256 digest.');
  return target;
}

export async function command(program, args, { input, env = process.env, label = program, timeout = 300000 } = {}) {
  const child = spawn(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', bytes = 0, stdinFailed = false, termination;
  const stop = () => { child.kill('SIGTERM'); termination ??= setTimeout(() => child.kill('SIGKILL'), 5000); };
  const timer = setTimeout(stop, timeout);
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) stop(); else stdout += chunk; });
  // Provider errors can contain credential-bearing URLs. Never forward them to CI logs.
  child.stderr.resume();
  child.stdin.on('error', () => { stdinFailed = true; });
  if (input) child.stdin.end(input); else child.stdin.end();
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new ReleaseError(`${label} could not start.`)));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    check(result.code === 0 && !result.signal && !stdinFailed && bytes <= 16 * 1024 * 1024, `${label} failed; provider output suppressed to protect credentials.`);
    return stdout;
  } finally { clearTimeout(timer); clearTimeout(termination); }
}

export async function fileDigest(path) {
  const hash = createHash('sha256'); let size = 0;
  await pipeline(createReadStream(path), new Writable({ write(chunk, _encoding, done) { size += chunk.length; hash.update(chunk); done(); } }));
  return { sha256: hash.digest('hex'), size };
}

export async function encryptBackup(source, destination, key) {
  check(Buffer.isBuffer(key) && key.length === 32, 'ARTOO_BACKUP_KEY must encode 32 random bytes.');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = await fileDigest(source);
  await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  const ciphertext = await fileDigest(destination);
  return { format: 'artoo.release-backup.v1', algorithm: 'aes-256-gcm', iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), plaintext, ciphertext };
}

export async function verifyEncryptedBackup(path, envelope, key, destination) {
  check(envelope?.format === 'artoo.release-backup.v1' && envelope.algorithm === 'aes-256-gcm', 'Unknown backup format.');
  const actual = await fileDigest(path);
  check(actual.sha256 === envelope.ciphertext.sha256 && actual.size === envelope.ciphertext.size, 'Encrypted backup checksum mismatch.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  let size = 0; const hash = createHash('sha256');
  const measure = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; hash.update(chunk); done(null, chunk); } });
  const sink = destination ? createWriteStream(destination, { flags: 'wx', mode: 0o600 }) : new Writable({ write(_chunk, _encoding, done) { done(); } });
  await pipeline(createReadStream(path), decipher, measure, sink);
  check(size === envelope.plaintext.size && hash.digest('hex') === envelope.plaintext.sha256, 'Decrypted backup checksum mismatch.');
}
