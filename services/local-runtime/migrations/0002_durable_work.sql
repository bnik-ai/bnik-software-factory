CREATE TABLE factory_work (
  id bigserial PRIMARY KEY,
  queue_name text NOT NULL,
  delivery_key text NOT NULL,
  record_key text NOT NULL,
  body jsonb,
  body_hash text NOT NULL CHECK (length(body_hash) = 64),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  result jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE (queue_name, delivery_key),
  CHECK (state NOT IN ('pending', 'running') OR body IS NOT NULL),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX factory_work_claim ON factory_work(queue_name, available_at, id)
  WHERE state IN ('pending', 'running');
CREATE INDEX factory_work_record_order ON factory_work(queue_name, record_key, id)
  WHERE state IN ('pending', 'running');
CREATE INDEX factory_work_retention ON factory_work(settled_at) WHERE state = 'done';

-- Explicit demo receipts. No GitHub or model side effects are represented here.
CREATE TABLE factory_demo_effects (
  work_id bigint PRIMARY KEY REFERENCES factory_work(id),
  agent text NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
