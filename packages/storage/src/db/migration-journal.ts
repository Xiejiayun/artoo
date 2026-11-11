import { createHash } from "node:crypto";

/** The caller owns a transaction encompassing both DDL and this journal. */
export interface MigrationJournalSession {
  execute(statement: string): Promise<unknown>;
  query(statement: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export async function applyMigrationJournal(session: MigrationJournalSession, statements: readonly string[]): Promise<void> {
  await session.execute(`
    CREATE SCHEMA IF NOT EXISTS artoo_meta;
    CREATE TABLE IF NOT EXISTS artoo_meta.migrations (
      position integer PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const applied = await session.query("SELECT position, checksum FROM artoo_meta.migrations ORDER BY position");
  const checksums = statements.map((statement) =>
    createHash("sha256").update(statement.replace(/\r\n/g, "\n").trim()).digest("hex"),
  );
  for (const [index, migration] of applied.rows.entries()) {
    if (migration.position !== index || checksums[index] !== migration.checksum) {
      throw new Error(
        `Migration history changed at statement ${index + 1}. Restore the original migrations and append a new migration; database downgrades are not supported.`,
      );
    }
  }
  if (applied.rows.length === 0) {
    const existing = await session.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' LIMIT 1",
    );
    if (existing.rows.length > 0) {
      throw new Error(
        "Database has an untracked legacy schema. Back it up and migrate it with the legacy adoption tool before starting; no existing tables were changed.",
      );
    }
  }
  for (let index = applied.rows.length; index < statements.length; index++) {
    await session.execute(statements[index]!);
    await session.query("INSERT INTO artoo_meta.migrations (position, checksum) VALUES ($1, $2)", [index, checksums[index]!]);
  }
}
