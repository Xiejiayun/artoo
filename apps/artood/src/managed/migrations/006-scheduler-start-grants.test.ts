import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCHEDULER_PREPARATION_MIGRATION_005 } from "./005-scheduler-preparation.js";
import { SCHEDULER_START_GRANTS_MIGRATION_006 } from "./006-scheduler-start-grants.js";

// Real SQLite SQL constraints only. Protected macOS boundary/worker migration is
// exercised separately; these rows are controlled metadata, never authority.
function fixture(body: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; CREATE TABLE runs(namespace TEXT,run_id TEXT,PRIMARY KEY(namespace,run_id)) STRICT;",
    );
    db.exec(SCHEDULER_PREPARATION_MIGRATION_005);
    body(db);
  } finally {
    db.close();
  }
}
function prepare(db: DatabaseSync, id: string) {
  db.prepare("INSERT INTO runs VALUES ('namespace',?)").run(id);
  db.prepare("INSERT INTO scheduler_preparations VALUES ('namespace',?,?,?,?,?,?)").run(
    id,
    `request_${id}`,
    `attempt_${id}`,
    '{"controlled":true}',
    "proposal_digest",
    "original_worker",
  );
}
function grant(
  db: DatabaseSync,
  id: string,
  ready = `ready_${id}`,
  grantId = `grant_${id}`,
  attempt = `attempt_${id}`,
) {
  db.prepare("INSERT INTO scheduler_start_grants VALUES ('namespace',?,?,?,?,?,?,?,?,?)").run(
    id,
    `request_${id}`,
    attempt,
    ready,
    grantId,
    "proposal_digest",
    '{"controlled":true}',
    "grant_digest",
    "original_worker",
  );
}

describe("scheduler start grant storage migration", () => {
  it("preserves preparation bytes and enforces exact preparation identity, uniqueness and immutability", () =>
    fixture((db) => {
      prepare(db, "one");
      prepare(db, "two");
      prepare(db, "three");
      const original = db.prepare("SELECT * FROM scheduler_preparations ORDER BY run_id").all();
      db.exec(`BEGIN; ${SCHEDULER_START_GRANTS_MIGRATION_006} COMMIT;`);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
      expect(db.prepare("SELECT * FROM scheduler_preparations ORDER BY run_id").all()).toEqual(original);
      grant(db, "one");
      expect(() => grant(db, "two", "ready_two", "grant_two", "attempt_three")).toThrow(/FOREIGN KEY/);
      expect(() => grant(db, "two", "ready_one")).toThrow(/UNIQUE/);
      expect(() => grant(db, "two", "ready_two", "grant_one")).toThrow(/UNIQUE/);
      expect(() => grant(db, "one", "other_ready", "other_grant")).toThrow(/UNIQUE/);
      const saved = db.prepare("SELECT * FROM scheduler_start_grants").all();
      expect(() => db.exec("UPDATE scheduler_start_grants SET grant_json='{}'")).toThrow(/immutable/);
      expect(() => db.exec("DELETE FROM scheduler_start_grants")).toThrow(/immutable/);
      expect(() => db.exec("DELETE FROM scheduler_preparations")).toThrow(/immutable/);
      expect(db.prepare("SELECT * FROM scheduler_start_grants").all()).toEqual(saved);
      grant(db, "two");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }));

  it("rolls schema, index and version back together when an offline upgrade fails", () =>
    fixture((db) => {
      prepare(db, "kept");
      const original = db.prepare("SELECT * FROM scheduler_preparations").all();
      expect(() =>
        db.exec(`BEGIN; ${SCHEDULER_START_GRANTS_MIGRATION_006} SELECT * FROM absent_migration_fixture; COMMIT;`),
      ).toThrow();
      db.exec("ROLLBACK");
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(5);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('scheduler_start_grants','scheduler_preparations_grant_identity')",
          )
          .all(),
      ).toEqual([]);
      expect(db.prepare("SELECT * FROM scheduler_preparations").all()).toEqual(original);
      db.exec(`BEGIN; ${SCHEDULER_START_GRANTS_MIGRATION_006} COMMIT;`);
      grant(db, "kept");
    }));
});
