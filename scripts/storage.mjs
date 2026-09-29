import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { adoptLegacyStorage, backupStorage, restoreStorage, unlockStorage } from "../apps/server/dist/storage-operations.js";
if (existsSync(".env")) loadEnvFile(".env");
const [command, ...args] = process.argv.slice(2);
const root = resolve(process.env.ARTOO_DATA_DIR || ".artoo");
const db = resolve(process.env.ARTOO_DB_DIR || `${root}/db`);
const artifacts = resolve(process.env.ARTOO_ARTIFACT_DIR || `${root}/artifacts`);
try {
  if (command === "backup" && args.length === 1) await backupStorage(db, artifacts, args[0]);
  else if (command === "restore" && args.length === 2) await restoreStorage(args[0], args[1]);
  else if (command === "adopt-legacy" && [1, 2].includes(args.length)) await adoptLegacyStorage(db, artifacts, args[0], args[1]);
  else if (command === "unlock" && args.length === 0) await unlockStorage(db);
  else throw new Error("Usage: npm run storage -- backup <new-backup-dir> | restore <backup-dir> <new-data-dir> | adopt-legacy <new-backup-dir> [last-migration.sql] | unlock");
  console.log(`Storage ${command} complete.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
