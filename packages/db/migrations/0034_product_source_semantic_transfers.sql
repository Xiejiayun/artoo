CREATE TABLE product_source_semantic_transfers (
  id text PRIMARY KEY REFERENCES product_source_transfers(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  request_digest text NOT NULL,
  request jsonb NOT NULL,
  source_export_event_id text NOT NULL REFERENCES event_log(id),
  source_export_digest text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT product_source_semantic_transfers_digest_chk CHECK (
    request_digest ~ '^sha256:[a-f0-9]{64}$' AND source_export_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT product_source_semantic_transfers_request_chk CHECK ((jsonb_typeof(request) = 'object'
    AND request->'version' = '2'::jsonb AND request->>'kind' = 'product-source-transfer.v2'
    AND request->'byte_request'->>'transfer_id' = id AND request->'byte_request'->>'organization_id' = organization_id
    AND request->'byte_request'->'version' = '1'::jsonb AND request->'byte_request'->>'kind' = 'product-source-transfer.v1'
    AND request->'source_export'->'version' = '2'::jsonb AND request->>'source_export_digest' = source_export_digest) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX product_source_semantic_transfers_org_idx ON product_source_semantic_transfers (organization_id, created_at);
--> statement-breakpoint
CREATE FUNCTION protect_product_source_semantic_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'product source semantic transfer history is immutable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM product_source_transfers b JOIN event_log e ON e.id = NEW.source_export_event_id
    WHERE b.id = NEW.id AND b.organization_id = NEW.organization_id AND b.request = NEW.request->'byte_request'
      AND e.organization_id = NEW.organization_id AND e.run_id = b.source_run_id AND e.project_id = b.project_id
      AND e.actor_type = 'system' AND e.actor_id = b.source_node_id AND e.type = 'run.product-source.export.v2'
      AND e.sequence IS NOT NULL AND e.payload = NEW.request->'source_export'
  ) THEN RAISE EXCEPTION 'product source semantic transfer differs from its original byte request or source export'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER product_source_semantic_transfers_immutable BEFORE INSERT OR UPDATE OR DELETE ON product_source_semantic_transfers
  FOR EACH ROW EXECUTE FUNCTION protect_product_source_semantic_transfer();
