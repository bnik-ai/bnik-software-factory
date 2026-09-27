-- Trusted autonomy ledger. The internet-facing runtime role receives SELECT only
-- (migrate.ts); writes belong to the trusted operator/controller identity.
CREATE TABLE factory_autonomy_policies (
  policy_sha256 text PRIMARY KEY CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  repository_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  mode text NOT NULL CHECK (mode IN ('human_gated','bounded')),
  document jsonb NOT NULL,
  previous_sha256 text REFERENCES factory_autonomy_policies(policy_sha256),
  acknowledged_weakenings jsonb NOT NULL,
  activated_by text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (repository_id, revision)
);
CREATE TABLE factory_autonomy_control (
  repository_id bigint PRIMARY KEY,
  active_policy_sha256 text NOT NULL REFERENCES factory_autonomy_policies(policy_sha256),
  paused boolean NOT NULL DEFAULT false,
  pause_reason text,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE factory_autonomy_scopes (
  scope_id text PRIMARY KEY CHECK (scope_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
  repository_id bigint NOT NULL,
  policy_sha256 text NOT NULL REFERENCES factory_autonomy_policies(policy_sha256),
  task_ids jsonb NOT NULL CHECK (jsonb_typeof(task_ids) = 'array'),
  models jsonb NOT NULL CHECK (jsonb_typeof(models) = 'array'),
  budget_microusd bigint NOT NULL CHECK (budget_microusd > 0),
  max_task_runs integer NOT NULL CHECK (max_task_runs > 0),
  expires_at timestamptz NOT NULL,
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE TABLE factory_autonomy_decisions (
  decision_id uuid PRIMARY KEY,
  repository_id bigint NOT NULL,
  request_id uuid,
  scope_id text,
  task_id text,
  action text CHECK (action IN ('execute','publish','merge')),
  outcome text NOT NULL CHECK (outcome IN ('allow','approval_required','repair_required','blocked')),
  risk text NOT NULL CHECK (risk IN ('routine','critical','unknown','not_assessed')),
  request_sha256 text,
  action_sha256 text,
  policy_sha256 text NOT NULL,
  request_summary jsonb,
  decision jsonb NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  CHECK (consumed_at IS NULL OR outcome = 'allow')
);
CREATE INDEX factory_autonomy_decisions_request ON factory_autonomy_decisions(request_id, decided_at DESC);
-- One consequential effect per controller request, however many times it is re-decided.
CREATE UNIQUE INDEX factory_autonomy_decisions_consumed_once
  ON factory_autonomy_decisions(request_id) WHERE consumed_at IS NOT NULL;
CREATE TABLE factory_autonomy_reservations (
  reservation_id uuid PRIMARY KEY,
  scope_id text NOT NULL REFERENCES factory_autonomy_scopes(scope_id),
  task_id text NOT NULL,
  decision_id uuid NOT NULL UNIQUE REFERENCES factory_autonomy_decisions(decision_id),
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd > 0),
  -- unknown: execution may have started and the outcome is unreconciled; keeps its full reservation.
  state text NOT NULL CHECK (state IN ('reserved','settled','released','unknown')),
  settled_microusd bigint CHECK (settled_microusd >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  CHECK ((state = 'settled') = (settled_microusd IS NOT NULL))
);
CREATE INDEX factory_autonomy_reservations_task ON factory_autonomy_reservations(scope_id, task_id);
