/** Explicit offline v4 -> v5 extension. No existing receipt, payload or outbox
 * is rewritten. Old binaries reject version 5 instead of downgrading the mode. */
export const SCHEDULER_PREPARATION_MIGRATION_005 = `
CREATE TABLE scheduler_preparations (
  namespace TEXT NOT NULL,
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  node_attempt_id TEXT NOT NULL UNIQUE,
  proposal_json TEXT NOT NULL,
  proposal_digest TEXT NOT NULL,
  owner_incarnation TEXT NOT NULL,
  PRIMARY KEY(namespace,run_id),
  UNIQUE(namespace,request_id),
  FOREIGN KEY(namespace,run_id) REFERENCES runs(namespace,run_id)
) STRICT;
CREATE TRIGGER scheduler_preparations_immutable_update
BEFORE UPDATE ON scheduler_preparations BEGIN
  SELECT RAISE(ABORT,'Scheduler preparation is immutable');
END;
CREATE TRIGGER scheduler_preparations_immutable_delete
BEFORE DELETE ON scheduler_preparations BEGIN
  SELECT RAISE(ABORT,'Scheduler preparation is immutable');
END;
PRAGMA user_version=5;
`;
