ALTER TABLE factory_work DROP CONSTRAINT factory_work_state_check;
ALTER TABLE factory_work ADD CONSTRAINT factory_work_state_check
  CHECK (state IN ('pending','running','done','dead','quarantined'));
ALTER TABLE factory_work ADD COLUMN recovery_version integer NOT NULL DEFAULT 0
  CHECK (recovery_version >= 0);

-- Action receipt and queue mutation commit together; no secret/payload copies.
CREATE TABLE factory_recovery_actions (
  request_id uuid PRIMARY KEY,
  work_id bigint NOT NULL REFERENCES factory_work(id),
  action text NOT NULL CHECK (action IN ('replay','quarantine')),
  expected_version integer NOT NULL,
  reason text NOT NULL,
  principal text NOT NULL DEFAULT session_user,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX factory_recovery_work ON factory_recovery_actions(work_id,created_at);
