/** Additive extension to the existing journal. v3 core codec, receipts, and
 * outbox bytes stay intact. Applied only by the explicit offline upgrade API. */
export const OWNED_RESULT_FINALIZATION_MIGRATION_004 = `
ALTER TABLE runs ADD COLUMN owned_result_admission_json TEXT;
ALTER TABLE runs ADD COLUMN owned_result_admission_digest TEXT;
CREATE TABLE journal_extensions (
  name TEXT PRIMARY KEY CHECK(name='owned-result-finalization'),
  version INTEGER NOT NULL CHECK(version=1)
) STRICT;
INSERT INTO journal_extensions(name,version) VALUES('owned-result-finalization',1);
PRAGMA user_version=4;
`;
