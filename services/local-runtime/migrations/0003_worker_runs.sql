CREATE TABLE factory_worker_runs (
  run_id uuid PRIMARY KEY,
  work_id bigint NOT NULL REFERENCES factory_work(id),
  lease_token uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('preparing','running','succeeded','failed','cancelled','timed_out','lease_lost','cleanup_failed')),
  image_id text,
  cancel_requested boolean NOT NULL DEFAULT false,
  reason text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz
);
CREATE INDEX factory_worker_runs_work ON factory_worker_runs(work_id,started_at);
