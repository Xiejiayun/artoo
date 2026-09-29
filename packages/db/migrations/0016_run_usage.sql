CREATE TABLE run_usage (
  run_id text PRIMARY KEY REFERENCES runs(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  cost_usd double precision,
  currency text,
  provider_session_id text,
  updated_at timestamptz NOT NULL,
  CONSTRAINT run_usage_nonnegative_chk CHECK (
    (input_tokens IS NULL OR input_tokens >= 0) AND
    (output_tokens IS NULL OR output_tokens >= 0) AND
    (cached_input_tokens IS NULL OR cached_input_tokens >= 0) AND
    (cost_usd IS NULL OR cost_usd >= 0)
  ),
  CONSTRAINT run_usage_currency_chk CHECK (currency IS NULL OR currency = 'USD')
);
