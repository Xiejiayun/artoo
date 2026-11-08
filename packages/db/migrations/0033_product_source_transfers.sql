CREATE TABLE product_source_transfers (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  goal_id text NOT NULL REFERENCES goals(id),
  plan_id text NOT NULL REFERENCES plans(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  source_node_id text NOT NULL REFERENCES computers(id),
  source_run_id text NOT NULL REFERENCES runs(id),
  source_evidence_id text NOT NULL REFERENCES run_evidence(id),
  source_review_id text NOT NULL REFERENCES autonomous_reviews(id),
  destination_node_id text NOT NULL REFERENCES computers(id),
  request_digest text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_upload',
  uploaded_by_device_id text REFERENCES devices(id),
  created_at timestamptz NOT NULL,
  available_at timestamptz,
  CONSTRAINT product_source_transfers_status_chk CHECK (status IN ('awaiting_upload','available')),
  CONSTRAINT product_source_transfers_digest_chk CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT product_source_transfers_nodes_chk CHECK (source_node_id <> destination_node_id),
  CONSTRAINT product_source_transfers_availability_chk CHECK (
    (status = 'available') = (available_at IS NOT NULL AND uploaded_by_device_id IS NOT NULL)
    AND (status <> 'awaiting_upload' OR (available_at IS NULL AND uploaded_by_device_id IS NULL))),
  CONSTRAINT product_source_transfers_request_chk CHECK ((jsonb_typeof(request) = 'object' AND request->'version' = '1'::jsonb
    AND request->>'kind' = 'product-source-transfer.v1' AND request->>'transfer_id' = id
    AND request->>'organization_id' = organization_id AND request->>'project_id' = project_id
    AND request->>'goal_id' = goal_id AND request->>'plan_id' = plan_id
    AND request->'authorization'->>'actor_user_id' = actor_user_id
    AND request->'source'->>'node_id' = source_node_id AND request->'source'->>'run_id' = source_run_id
    AND request->'source'->>'evidence_id' = source_evidence_id AND request->'source'->>'review_id' = source_review_id
    AND request->'destination'->>'node_id' = destination_node_id) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX product_source_transfers_goal_idx ON product_source_transfers (organization_id, goal_id, created_at);
--> statement-breakpoint
CREATE FUNCTION protect_product_source_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'product source transfer history is immutable'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'available_at' - 'uploaded_by_device_id') IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'available_at' - 'uploaded_by_device_id') THEN
    RAISE EXCEPTION 'product source transfer request is immutable';
  END IF;
  IF OLD.status = 'available' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'product source transfer availability is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER product_source_transfers_immutable BEFORE UPDATE OR DELETE ON product_source_transfers
  FOR EACH ROW EXECUTE FUNCTION protect_product_source_transfer();
