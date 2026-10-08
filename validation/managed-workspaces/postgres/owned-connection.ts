import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientConfig } from "pg";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
type Identity = { device: string; inode: string };

async function privatePath(path: string, expected: Identity, directory: boolean) {
  const value = await lstat(path, { bigint: true });
  if (await realpath(path) !== path || value.isSymbolicLink() || value.uid !== BigInt(process.getuid!())
    || (directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n)
    || (value.mode & 0o777n) !== (directory ? 0o700n : 0o600n)
    || String(value.dev) !== expected.device || String(value.ino) !== expected.inode) {
    throw new Error("Owned PostgreSQL path identity, mode or ownership changed");
  }
}

/** Only the exact fresh local cluster selected by the outer launcher is usable.
 * No external database URL, TCP host, inherited libpq setting or older receipt
 * provides connection authority. SQL locking remains real multi-backend work. */
export async function ownedConnectionConfig(phase: "receipt" | "admin" | "assignment"):
Promise<{ config: ClientConfig; outputDir: string }> {
  if (Object.keys(process.env).some((key) => key.startsWith("PG") || /(?:^|_)(?:DATABASE|DB)_URL$/.test(key))) {
    throw new Error("External PostgreSQL environment is forbidden");
  }
  const selected = process.env.ARTOO_PG_HARNESS_RECEIPT;
  if (!selected || phase !== process.env.ARTOO_PG_VALIDATION_PHASE || !process.env.ARTOO_PG_RUN_TOKEN) {
    throw new Error("Use the explicit owned PostgreSQL launcher");
  }
  const file = resolve(selected), info = await lstat(file);
  const runs = await realpath(join(REPO, "artifacts/managed-workspaces/postgres", phase));
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid!() || info.nlink !== 1
    || (info.mode & 0o777) !== 0o600 || await realpath(file) !== file || !file.startsWith(`${runs}/`)
    || !/^run-[a-f0-9]{32}\/cluster\.json$/.test(file.slice(runs.length + 1))) {
    throw new Error("Receipt is outside the selected task-owned run directory");
  }
  const receipt = JSON.parse(await readFile(file, "utf8"));
  if (receipt.status !== "running" || receipt.phase !== phase || receipt.artifactRoot !== await realpath(HERE)
    || receipt.uid !== process.getuid!() || receipt.token !== process.env.ARTOO_PG_RUN_TOKEN
    || receipt.runId !== file.slice(runs.length + 1).split("/")[0]
    || !/^\/private\/tmp\/artoo-repo-pg-[a-zA-Z0-9_]+$/.test(receipt.clusterRoot)
    || receipt.user !== "artoo_harness" || receipt.database !== "artoo_concurrency" || receipt.port !== 55479
    || receipt.version !== "postgres (PostgreSQL) 17.11") {
    throw new Error("Invalid owned PostgreSQL 17.11 receipt");
  }
  const root = await realpath(receipt.clusterRoot);
  if (root !== receipt.clusterRoot || receipt.dataDir !== join(root, "data") || receipt.socketDir !== join(root, "socket")) {
    throw new Error("Cluster paths changed");
  }
  await privatePath(root, receipt.clusterIdentity, true);
  await privatePath(receipt.socketDir, receipt.socketIdentity, true);
  await privatePath(receipt.dataDir, receipt.dataIdentity, true);
  await privatePath(join(root, "owner.json"), receipt.ownerIdentity, false);
  const owner = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
  for (const key of ["runId", "token", "artifactRoot", "uid", "phase", "binaryDirectory"]) {
    if (owner[key] !== receipt[key]) throw new Error("Cluster owner marker differs");
  }
  const lines = (await readFile(join(receipt.dataDir, "postmaster.pid"), "utf8")).trim().split("\n");
  if (!Number.isSafeInteger(receipt.postmasterPid) || receipt.postmasterPid <= 1
    || Number(lines[0]) !== receipt.postmasterPid || resolve(lines[1]!) !== receipt.dataDir
    || Number(lines[2]) !== receipt.postmasterStartSeconds || Number(lines[3]) !== receipt.port
    || lines[4] !== receipt.socketDir || lines[5] !== "") {
    throw new Error("Postmaster identity or no-TCP boundary changed");
  }
  process.kill(receipt.postmasterPid, 0); // Observation only; never a signal.
  return { outputDir: dirname(file), config: {
    host: receipt.socketDir, port: receipt.port, user: receipt.user, database: receipt.database,
    password: "", ssl: false, connectionTimeoutMillis: 5000, query_timeout: 25000,
    options: "-c statement_timeout=20000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=30000",
  } };
}
