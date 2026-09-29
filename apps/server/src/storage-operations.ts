import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadMigrationStatements } from "@artoo/db";
import { PgliteDbClient } from "@artoo/storage";

interface Entry { name: string; sha256: string; size: number }
interface Manifest { format: "artoo-backup-v1"; createdAt: string; database: Entry; artifacts: Entry[] }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exists = (file: string) => access(file).then(() => true, () => false);
async function requireNew(destination: string) {
  if (await exists(destination)) throw new Error(`Destination already exists; refusing overwrite: ${destination}`);
  await mkdir(dirname(destination), { recursive: true });
}

/** Offline backup: the DB lock excludes the server and other maintenance tools.
 * A backup is only visible at destination after its complete manifest is saved. */
export async function backupStorage(dbDir: string, artifactDir: string, destination: string): Promise<void> {
  destination = resolve(destination);
  if (!(await exists(join(dbDir, "PG_VERSION")))) throw new Error("Existing database directory required");
  await requireNew(destination);
  const db = await PgliteDbClient.create({ dataDir: resolve(dbDir) });
  try { await writeBackup(db, artifactDir, destination); } finally { await db.close(); }
}
async function writeBackup(db: PgliteDbClient, artifactDir: string, destination: string) {
  const staging = `${destination}.partial-${randomUUID()}`;
  await mkdir(staging);
  const database = await db.backup();
  await writeFile(join(staging, "database.tar.gz"), database, { flag: "wx", mode: 0o600 });
  await mkdir(join(staging, "artifacts"));
  const artifacts: Entry[] = [];
  for (const name of (await readdir(artifactDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).sort()) {
    if (name.endsWith(".upload")) continue;
    if (!/^[a-f0-9]{64}$/.test(name)) throw new Error(`Unexpected artifact store entry: ${name}`);
    const source = join(artifactDir, name);
    if (!(await lstat(source)).isFile()) throw new Error("Artifact store must contain regular files only");
    const bytes = await readFile(source);
    if (hash(bytes) !== name) throw new Error(`Artifact content is corrupt: ${name}`);
    await writeFile(join(staging, "artifacts", name), bytes, { flag: "wx", mode: 0o600 });
    artifacts.push({ name, sha256: name, size: bytes.length });
  }
  const manifest: Manifest = { format: "artoo-backup-v1", createdAt: new Date().toISOString(),
    database: { name: "database.tar.gz", sha256: hash(database), size: database.length }, artifacts };
  await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  await requireNew(destination);
  await rename(staging, destination);
}

export async function restoreStorage(source: string, destination: string): Promise<void> {
  destination = resolve(destination);
  await requireNew(destination);
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== "artoo-backup-v1" || manifest.database?.name !== "database.tar.gz" || !Array.isArray(manifest.artifacts)) throw new Error("Unsupported backup manifest");
  const verify = async (filename: string, entry: Entry) => {
    if (!(await lstat(filename)).isFile()) throw new Error("Backup entries must be regular files");
    const bytes = await readFile(filename);
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error(`Backup checksum mismatch: ${entry.name}`);
    return bytes;
  };
  const database = await verify(join(source, "database.tar.gz"), manifest.database);
  const artifacts: { name: string; bytes: Uint8Array }[] = [];
  const names = new Set<string>();
  for (const entry of manifest.artifacts) {
    if (!/^[a-f0-9]{64}$/.test(entry.name) || entry.sha256 !== entry.name || names.has(entry.name)) throw new Error("Invalid artifact manifest entry");
    names.add(entry.name);
    artifacts.push({ name: entry.name, bytes: await verify(join(source, "artifacts", entry.name), entry) });
  }
  const staging = `${destination}.partial-${randomUUID()}`;
  await mkdir(staging);
  const db = await PgliteDbClient.create({ dataDir: join(staging, "db"), archive: database });
  try { if (!(await db.healthCheck())) throw new Error("Restored database health check failed"); } finally { await db.close(); }
  await mkdir(join(staging, "artifacts"));
  for (const entry of artifacts) await writeFile(join(staging, "artifacts", entry.name), entry.bytes, { flag: "wx", mode: 0o600 });
  await requireNew(destination);
  await rename(staging, destination);
}

/** Back up before any journal change. Exact schema validation is performed by
 * the storage client, so unknown legacy histories cannot be silently adopted. */
export async function adoptLegacyStorage(dbDir: string, artifactDir: string, backupDir: string, throughFile?: string): Promise<void> {
  if (!(await exists(join(dbDir, "PG_VERSION")))) throw new Error("Existing legacy database required");
  backupDir = resolve(backupDir);
  await requireNew(backupDir);
  const db = await PgliteDbClient.create({ dataDir: resolve(dbDir) });
  try {
    await writeBackup(db, artifactDir, backupDir);
    await db.adoptLegacyMigrations(await loadMigrationStatements(throughFile));
  } finally { await db.close(); }
}

export async function unlockStorage(dbDir: string): Promise<void> {
  const lockDir = `${await realpath(resolve(dbDir))}.artoo-lock`;
  const recovery = join(lockDir, "recovery");
  // Only one recovery tool may examine/remove a dead owner. Keep the lock
  // directory present until that tool releases its recovery marker.
  await mkdir(recovery);
  let removeLock = false;
  try {
  const ownerPath = join(lockDir, "owner.json");
  const original = await readFile(ownerPath, "utf8");
  const owner = JSON.parse(original) as { pid: number; hostname: string };
  if (owner.hostname !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Cannot verify this lock owner on the current host");
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    if (await readFile(ownerPath, "utf8") !== original) throw new Error("Lock changed during recovery");
    await unlink(ownerPath);
    removeLock = true;
    return;
  }
  throw new Error(`Database owner process ${owner.pid} is still running; refusing unlock`);
  } finally {
    await rmdir(recovery);
    if (removeLock) await rmdir(lockDir);
  }
}
