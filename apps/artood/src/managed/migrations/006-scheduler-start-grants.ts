/** Explicit offline v5 -> v6 storage extension. This table alone grants no
 * producer ownership or launch authority; existing Run/history bytes stay put. */
export const SCHEDULER_START_GRANTS_MIGRATION_006 = `
CREATE UNIQUE INDEX scheduler_preparations_grant_identity
ON scheduler_preparations(namespace,run_id,request_id,node_attempt_id);
CREATE TABLE scheduler_start_grants (
  namespace TEXT NOT NULL,
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  node_attempt_id TEXT NOT NULL,
  ready_id TEXT NOT NULL,
  grant_id TEXT NOT NULL UNIQUE,
  proposal_digest TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  grant_digest TEXT NOT NULL,
  owner_incarnation TEXT NOT NULL,
  PRIMARY KEY(namespace,run_id),
  UNIQUE(namespace,request_id),
  UNIQUE(namespace,node_attempt_id),
  UNIQUE(namespace,ready_id),
  FOREIGN KEY(namespace,run_id,request_id,node_attempt_id)
    REFERENCES scheduler_preparations(namespace,run_id,request_id,node_attempt_id)
) STRICT;
CREATE TRIGGER scheduler_start_grants_immutable_update
BEFORE UPDATE ON scheduler_start_grants BEGIN
  SELECT RAISE(ABORT,'Scheduler start grant is immutable');
END;
CREATE TRIGGER scheduler_start_grants_immutable_delete
BEFORE DELETE ON scheduler_start_grants BEGIN
  SELECT RAISE(ABORT,'Scheduler start grant is immutable');
END;
PRAGMA user_version=6;
`;
