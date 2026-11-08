CREATE TABLE product_release_health_reports (
  event_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  release_id text NOT NULL REFERENCES product_releases(id),
  computer_id text NOT NULL REFERENCES computers(id),
  version integer NOT NULL CONSTRAINT product_release_health_version_chk CHECK (version = 1),
  sequence integer NOT NULL CONSTRAINT product_release_health_sequence_chk CHECK (sequence >= 1),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  CONSTRAINT product_release_health_sequence_uniq UNIQUE (organization_id, release_id, sequence)
);
