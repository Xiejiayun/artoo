import { createRequire } from 'node:module';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { ReleaseError, check, sha256, sleep, command, fileDigest, encryptBackup, verifyEncryptedBackup,
  journalDigest, safeRecovery, validateTarget } from './support.mjs';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const LOCK = [0x4152544f, 0x53455256];
const phase = process.argv[2];
const target = validateTarget(process.env);
check(['prepare', 'deploy', 'recover', 'cleanup'].includes(phase), 'Choose prepare, deploy, recover or cleanup.');
check(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true', 'Production deployment runs only on the Linux Actions runner.');
check(process.env.GITHUB_REF === 'refs/heads/main' && process.env.GITHUB_SHA === target.source, 'Deployment requires the exact main checkout.');
check(/^\d+$/.test(process.env.GITHUB_RUN_ID ?? ''), 'Missing Actions run identity.');
const root = resolve(process.env.RUNNER_TEMP, `artoo-release-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
const privateDir = join(root, 'private'), publicDir = resolve(process.env.RELEASE_EVIDENCE_DIRECTORY);
check(publicDir === join(root, 'evidence'), 'Release evidence directory does not match this run.');
const statePath = join(privateDir, 'state.json');
let state;
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
const load = () => { state = JSON.parse(readFileSync(statePath, 'utf8')); check(state.target.source === target.source && state.target.subscription === target.subscription && state.target.app === target.app, 'Saved deployment target differs.'); };
const az = async args => command('az', [...args, '--subscription', target.subscription, '--only-show-errors', '--output', 'json'], { label: `Azure ${args[0]} ${args[1]}` });
const azJson = async args => JSON.parse(await az(args) || 'null');
const appArgs = ['--resource-group', target.resourceGroup, '--name', target.app];
const revisions = () => azJson(['containerapp', 'revision', 'list', ...appArgs]);
const app = () => azJson(['containerapp', 'show', ...appArgs]);
const writeReceipt = (name, value) => writeFileSync(join(publicDir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

function readSecret(name, values) {
  const value = values.find(item => item.name === name)?.value;
  check(typeof value === 'string' && value.length > 0, `Stored Container App secret ${name} is unavailable.`);
  return value;
}
function runtimeConfiguration(snapshot, secrets) {
  check(snapshot.properties.template.containers.length === 1, 'Expected one application container.');
  const container = snapshot.properties.template.containers[0];
  const values = Object.fromEntries(container.env.map(entry => [entry.name, entry.secretRef ? readSecret(entry.secretRef, secrets) : entry.value]));
  check(values.ARTOO_BLOB_BACKEND === 'supabase', 'Expected external Supabase storage.');
  const caPath = values.ARTOO_DATABASE_CA_FILE;
  check(typeof caPath === 'string' && posix.isAbsolute(caPath), 'A trusted database CA mount is required.');
  const mount = container.volumeMounts?.find(item => caPath.startsWith(`${item.mountPath}/`));
  const volume = snapshot.properties.template.volumes?.find(item => item.name === mount?.volumeName);
  const secret = volume?.secrets?.find(item => item.path === posix.relative(mount.mountPath, caPath));
  check(secret?.secretRef, 'Database CA mount must map to a stored secret.');
  const ca = readSecret(secret.secretRef, secrets);
  let url; try { url = new URL(values.ARTOO_DATABASE_URL); } catch { throw new ReleaseError('Invalid database URL.'); }
  check(['postgres:', 'postgresql:'].includes(url.protocol) && url.port === '5432' && url.hostname.endsWith('.pooler.supabase.com')
    && url.pathname === '/postgres' && url.password && !url.hash, 'Expected a Supabase Session pooler on port 5432.');
  check([...url.searchParams.keys()].every(key => key === 'sslmode'), 'Unexpected database connection options.');
  check(/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(values.SUPABASE_URL ?? ''), 'Invalid Supabase origin.');
  const project = new URL(values.SUPABASE_URL).hostname.split('.')[0];
  check(decodeURIComponent(url.username) === `postgres.${project}`, 'Database and Storage must use the same Supabase project.');
  check(/^[A-Za-z0-9_-]+$/.test(values.ARTOO_SUPABASE_STORAGE_BUCKET ?? '') && values.SUPABASE_SERVICE_ROLE_KEY, 'Private storage configuration is incomplete.');
  const pg = { host: url.hostname, port: 5432, database: 'postgres', user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), ssl: { rejectUnauthorized: true, ca },
    application_name: 'artoo-github-deploy', connectionTimeoutMillis: 10000, statement_timeout: 30000 };
  return { values, pg, ca, containerName: container.name };
}
async function connect() { const client = new Client(state.runtime.pg); await client.connect(); return client; }
const journal = async client => (await client.query('SELECT position, checksum FROM artoo_meta.migrations ORDER BY position')).rows;
async function idle(client) {
  const result = await client.query(`SELECT
    (SELECT count(*) FROM public.runs WHERE status IN ('queued','starting','running','awaiting_input','paused')) +
    (SELECT count(*) FROM public.assistant_turns WHERE status IN ('queued','waiting','running')) +
    (SELECT count(*) FROM public.goal_automations WHERE status IN ('planning','executing','waiting')) AS active`);
  check(Number(result.rows[0].active) === 0, 'Work is still active. Drain or stop runs, assistants and autonomous goals before deployment.');
}
async function stopRevisions(names) {
  for (const name of names) await az(['containerapp', 'revision', 'deactivate', ...appArgs, '--revision', name]);
  for (let attempt = 0; attempt < 36; attempt++) {
    let remaining = 0;
    for (const name of names) remaining += (await azJson(['containerapp', 'replica', 'list', ...appArgs, '--revision', name])).length;
    if (remaining === 0) return;
    await sleep(5000);
  }
  throw new ReleaseError('Old replicas did not stop; refusing a second database writer.');
}
async function acquireLock(client) {
  for (let i = 0; i < 30; i++) {
    if ((await client.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired', LOCK)).rows[0].acquired) return;
    await sleep(2000);
  }
  throw new ReleaseError('The server database ownership lock is still held; no unknown session was terminated.');
}
async function exportDatabase(rawDir) {
  const { pg, ca } = state.runtime;
  const caFile = join(privateDir, 'database-ca.pem'), envFile = join(privateDir, 'pg.env');
  writeFileSync(caFile, ca, { mode: 0o600 });
  const variables = { PGHOST: pg.host, PGPORT: '5432', PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: pg.database,
    PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/run/artoo-ca.pem', PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'artoo-backup' };
  check(Object.values(variables).every(value => !/[\r\n\0]/.test(value)), 'Database configuration cannot be represented safely.');
  writeFileSync(envFile, Object.entries(variables).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
  const args = ['run', '--rm', '--network', 'host', '--env-file', envFile, '--mount', `type=bind,source=${caFile},target=/run/artoo-ca.pem,readonly`,
    state.postgresImage, 'pg_dump', '--format=custom', '--no-owner', '--no-acl', '--schema=public', '--schema=artoo_meta'];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }); child.stderr.resume();
  const closed = new Promise((resolve, reject) => { child.once('error', () => reject(new ReleaseError('Database backup could not start.'))); child.once('close', code => resolve(code)); });
  await pipeline(child.stdout, createWriteStream(join(rawDir, 'database.dump'), { flags: 'wx', mode: 0o600 }));
  check(await closed === 0, 'Database backup failed; raw provider output suppressed.');
  return fileDigest(join(rawDir, 'database.dump'));
}
async function verifyDatabaseRestore(rawDir) {
  const name = `artoo-restore-${process.env.GITHUB_RUN_ID}-${randomBytes(4).toString('hex')}`;
  await command('docker', ['run', '--detach', '--rm', '--network', 'none', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', state.postgresImage], { label: 'Isolated restore database' });
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try { await command('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { label: 'Restore database readiness', timeout: 5000 }); ready = true; break; }
      catch { await sleep(1000); }
    }
    check(ready, 'Isolated restore database did not become ready.');
    const child = spawn('docker', ['exec', '--interactive', name, 'pg_restore', '--exit-on-error', '--clean', '--if-exists', '--no-owner', '--no-acl', '-U', 'postgres', '-d', 'postgres'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    const closed = new Promise((resolve, reject) => { child.once('error', () => reject(new ReleaseError('Restore rehearsal could not start.'))); child.once('close', code => resolve(code)); });
    await pipeline(createReadStream(join(rawDir, 'database.dump')), child.stdin);
    check(await closed === 0, 'The isolated database restore rehearsal failed.');
    const text = await command('docker', ['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c',
      "SELECT coalesce(json_agg(t ORDER BY position),'[]'::json) FROM (SELECT position, checksum FROM artoo_meta.migrations) t"], { label: 'Restored migration verification' });
    check(safeRecovery(state.beforeJournal, JSON.parse(text)), 'Restored migration journal differs from the backup.');
    return { status: 'passed', postgres_major: 17, source_server_version: state.databaseVersion,
      tool_image: state.postgresImage, migration_journal_sha256: journalDigest(state.beforeJournal), isolation: 'temporary container, no network or published ports' };
  } finally { await command('docker', ['rm', '--force', name], { label: 'Restore rehearsal cleanup' }); }
}
async function exportObjects(client, rawDir) {
  const { values } = state.runtime, bucket = values.ARTOO_SUPABASE_STORAGE_BUCKET;
  const buckets = await client.query('SELECT id,name,public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id=$1', [bucket]);
  check(buckets.rows.length === 1 && buckets.rows[0].public === false, 'Expected one private Supabase bucket.');
  const result = await client.query('SELECT name, metadata FROM storage.objects WHERE bucket_id=$1 ORDER BY name', [bucket]);
  const records = []; let total = 0;
  mkdirSync(join(rawDir, 'objects'), { mode: 0o700 });
  for (const item of result.rows) {
    check(typeof item.name === 'string' && item.name.length > 0 && !item.name.split('/').some(part => part === '..' || part === '.' || !part), 'Unsafe storage object key.');
    const endpoint = `${values.SUPABASE_URL}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${item.name.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${values.SUPABASE_SERVICE_ROLE_KEY}` }, signal: AbortSignal.timeout(60000), redirect: 'error' });
    check(response.ok && response.body, 'A Supabase object backup failed.');
    const file = `${records.length.toString().padStart(6, '0')}.blob`;
    const limit = new Transform({ transform(chunk, _encoding, done) {
      total += chunk.length;
      if (total > 2 * 1024 ** 3) done(new ReleaseError('Backup exceeds the reviewed 2 GiB limit.'));
      else done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(join(rawDir, 'objects', file), { flags: 'wx', mode: 0o600 }));
    const hash = await fileDigest(join(rawDir, 'objects', file));
    if (item.metadata?.size !== undefined) check(hash.size === Number(item.metadata.size), 'A storage object backup size differs.');
    records.push({ key: item.name, metadata: item.metadata, file, ...hash });
  }
  writeFileSync(join(rawDir, 'objects.json'), JSON.stringify({ bucket, configuration: buckets.rows[0], objects: records }, null, 2), { mode: 0o600 });
  return { count: records.length, bytes: total };
}

async function prepare() {
  check(process.env.MAINTENANCE_CONFIRMED === 'true', 'Explicit maintenance confirmation is required.');
  check(!existsSync(privateDir), 'This run already has deployment state; do not repeat preparation.');
  mkdirSync(privateDir, { recursive: true, mode: 0o700 }); chmodSync(privateDir, 0o700);
  mkdirSync(publicDir, { recursive: true, mode: 0o700 });
  const key = Buffer.from(process.env.ARTOO_BACKUP_KEY ?? '', 'base64');
  check(key.length === 32, 'Set ARTOO_BACKUP_KEY to a separately retained 32-byte recovery key.');
  const snapshot = await app();
  check(snapshot.location.toLowerCase().replaceAll(' ', '') === 'southeastasia', 'The release target is not in Singapore.');
  check(snapshot.properties.configuration.activeRevisionsMode === 'Single', 'Expected the healthy app in Single revision mode.');
  check(snapshot.properties.template.scale.minReplicas === 1 && snapshot.properties.template.scale.maxReplicas === 1, 'Expected min=max=1 replicas.');
  const active = (await revisions()).filter(item => item.properties.active);
  check(active.length === 1 && active[0].properties.healthState === 'Healthy', 'Expected exactly one healthy active revision.');
  const secrets = await azJson(['containerapp', 'secret', 'list', ...appArgs, '--show-values']);
  const runtime = runtimeConfiguration(snapshot, secrets), previousImage = snapshot.properties.template.containers[0].image;
  check(previousImage.startsWith(`${target.registryHost}/artoo@sha256:`), 'The current image must be an immutable image from the same registry.');
  state = { version: 1, phase: 'preparing', target, snapshot, secrets, runtime, previousImage, previousRevision: active[0].name, stopped: false, deploymentStarted: false };
  save();
  let client = await connect();
  try {
    state.databaseVersion = (await client.query('SHOW server_version')).rows[0].server_version;
    check(/^17\./.test(state.databaseVersion), 'The backup/restore tool requires PostgreSQL 17; review tooling before a server major upgrade.');
    const images = JSON.parse(await command('docker', ['image', 'inspect', 'postgres:17'], { label: 'PostgreSQL backup tool identity' }));
    state.postgresImage = images[0]?.RepoDigests?.find(digest => digest.startsWith('postgres@sha256:'));
    check(state.postgresImage, 'Could not identify the PostgreSQL backup/restore tool image.');
    await idle(client); state.beforeJournal = await journal(client); journalDigest(state.beforeJournal); save();
  }
  finally { await client.end(); }
  console.log('Drained application verified. Entering the approved maintenance window.');
  await az(['containerapp', 'revision', 'set-mode', ...appArgs, '--mode', 'multiple']);
  state.stopped = true; save();
  await stopRevisions([state.previousRevision]);
  client = await connect();
  try {
    await acquireLock(client); await idle(client);
    check(safeRecovery(state.beforeJournal, await journal(client)), 'Migration history changed during maintenance preparation.');
    const raw = join(privateDir, 'backup'); mkdirSync(raw, { mode: 0o700 });
    writeFileSync(join(raw, 'configuration.json'), JSON.stringify({ app: snapshot, secrets, source_sha: target.source, previous_image: previousImage }, null, 2), { mode: 0o600 });
    const database = await exportDatabase(raw), objects = await exportObjects(client, raw);
    const restore = await verifyDatabaseRestore(raw);
    const archive = join(privateDir, 'backup.tar.gz');
    await command('tar', ['-czf', archive, '-C', raw, '.'], { label: 'Backup archive' });
    const encrypted = join(publicDir, 'backup.tar.gz.enc');
    const envelope = await encryptBackup(archive, encrypted, key);
    await verifyEncryptedBackup(encrypted, envelope, key);
    writeReceipt('backup-manifest.json', { ...envelope, source_sha: target.source, previous_image: previousImage,
      created_at: new Date().toISOString(), database, objects, restore });
    state.phase = 'prepared'; save();
    console.log('Encrypted database and object backup verified; isolated PostgreSQL restore passed.');
  } finally { await client.end(); key.fill(0); }
}

async function ready(expectedSha) {
  for (let i = 0; i < 60; i++) {
    try {
      const read = async path => fetch(`${target.origin}${path}`, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { 'Cache-Control': 'no-cache' } });
      for (const path of ['/health/live', '/health/ready']) check((await read(path)).ok, 'Health endpoint not ready.');
      const html = await read('/'); check(html.ok && (await html.text()).includes('id="root"'), 'Web portal is not available.');
      check([401, 403].includes((await read('/api/v1/projects')).status), 'Unauthenticated API access was not rejected.');
      if (expectedSha) { const result = await read(`/artoo-release.json?release=${expectedSha}`); check(result.ok && (await result.json()).commit === expectedSha, 'Public build identity differs from the release.'); }
      return;
    } catch { if (i === 59) throw new ReleaseError('Public TLS, readiness, portal, authorization or release identity verification failed.'); await sleep(5000); }
  }
}
async function switchImage(image, suffix, expectedSha) {
  await az(['containerapp', 'update', ...appArgs, '--container-name', state.runtime.containerName, '--image', image,
    '--revision-suffix', suffix, '--min-replicas', '1', '--max-replicas', '1']);
  const changed = await app(), revision = changed.properties.latestRevisionName;
  check(changed.properties.template.containers[0].image === image, 'Azure selected a different image.');
  await az(['containerapp', 'ingress', 'traffic', 'set', ...appArgs, '--revision-weight', `${revision}=100`]);
  await ready(expectedSha);
  const active = (await revisions()).filter(item => item.properties.active);
  check(active.length === 1 && active[0].name === revision && active[0].properties.healthState === 'Healthy', 'Expected exactly one healthy new revision.');
  await az(['containerapp', 'revision', 'set-mode', ...appArgs, '--mode', 'single']);
  return revision;
}
async function deploy() {
  load(); check(state.phase === 'prepared' && target.image, 'A verified, uploaded backup and immutable image are required.');
  check(process.env.BACKUP_ARTIFACT_ID && /^\d+$/.test(process.env.BACKUP_ARTIFACT_ID), 'Encrypted backup must be uploaded before applying migrations.');
  const client = await connect();
  try { await acquireLock(client); check(safeRecovery(state.beforeJournal, await journal(client)), 'Migration journal changed after the backup.'); }
  finally { await client.end(); }
  state.deploymentStarted = true; state.phase = 'deploying'; save();
  const revision = await switchImage(target.image, `gh-${target.source.slice(0, 8)}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`, target.source);
  state.phase = 'deployed'; state.newRevision = revision; save();
  writeReceipt('deployment.json', { status: 'deployed', source_sha: target.source, image: target.image, revision,
    previous_revision: state.previousRevision, previous_image: state.previousImage, backup_artifact_id: process.env.BACKUP_ARTIFACT_ID,
    origin: target.origin, completed_at: new Date().toISOString(), checks: ['single-writer', 'encrypted-backup', 'isolated-database-restore', 'https-live', 'https-ready', 'web-portal', 'unauthenticated-api-rejected', 'public-build-sha'],
    remaining_acceptance: ['real Google sign-in', 'paired executor reconnect', 'agent instance creation and task', 'application artifact round trip'] });
  console.log(`Deployed ${target.source} as ${revision}. Complete the recorded signed-in acceptance checks.`);
}
async function recover() {
  if (!existsSync(statePath)) { console.log('No maintenance state exists; nothing to recover.'); return; }
  load(); if (state.phase === 'deployed' || !state.stopped) return;
  await az(['containerapp', 'revision', 'set-mode', ...appArgs, '--mode', 'multiple']);
  const active = (await revisions()).filter(item => item.properties.active).map(item => item.name);
  await stopRevisions(active);
  const client = await connect();
  let compatible;
  try { await acquireLock(client); compatible = safeRecovery(state.beforeJournal, await journal(client)); }
  finally { await client.end(); }
  if (!compatible) {
    state.phase = 'recovery-required'; save();
    writeReceipt('recovery.json', { status: 'forward-fix-or-data-restore-required', previous_image: state.previousImage,
      reason: 'A new migration completed. Reverting only the image would be unsafe; all revisions remain stopped.', source_sha: target.source });
    throw new ReleaseError('Database schema advanced. Keep maintenance active and use a validated forward fix or separately approved data/object restore.');
  }
  const revision = await switchImage(state.previousImage, `rb-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`, undefined);
  state.phase = 'recovered'; save();
  writeReceipt('recovery.json', { status: 'previous-image-restored', image: state.previousImage, revision, migration_journal_unchanged: true });
  console.log('Previous compatible image restored; original failure remains a failed deployment.');
}

try {
  if (phase === 'prepare') await prepare();
  else if (phase === 'deploy') await deploy();
  else if (phase === 'recover') await recover();
  else if (existsSync(privateDir)) rmSync(privateDir, { recursive: true, force: true });
} catch (error) {
  console.error(error instanceof ReleaseError ? error.message : `${phase} failed; private provider details suppressed.`);
  process.exitCode = 1;
}
