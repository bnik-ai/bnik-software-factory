-- Merge lifecycle of a published attempt (OSS-21). The run row stays terminal at
-- `published`; this record carries observation, decision, admission, the exact merge and
-- its proof. Written only by the controller role; the runtime role keeps SELECT.
CREATE TABLE factory_autonomy_merges (
  merge_id uuid PRIMARY KEY,
  repository_id bigint NOT NULL,
  run_id uuid NOT NULL UNIQUE REFERENCES factory_autonomy_runs(run_id),
  task_id text NOT NULL,
  pull_number integer NOT NULL CHECK (pull_number > 0),
  head text NOT NULL CHECK (head ~ '^[0-9a-f]{40}$'),
  tree text NOT NULL CHECK (tree ~ '^[0-9a-f]{40}$'),
  base text NOT NULL CHECK (base ~ '^[0-9a-f]{40}$'),
  -- observing: evidence gathered and decided each run; held: exact-revision approval needed;
  -- admitted: ledger allowed, merge in flight; merged: verified merge commit recorded;
  -- blocked: refused (terminal for this attempt); unknown: effect uncertain, operator decides.
  state text NOT NULL CHECK (state IN ('observing','held','admitted','merged','blocked','unknown')),
  reason text,
  merge_decision_id uuid REFERENCES factory_autonomy_decisions(decision_id),
  observation jsonb,
  merge_commit text CHECK (merge_commit IS NULL OR merge_commit ~ '^[0-9a-f]{40}$'),
  proof jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX factory_autonomy_merges_open ON factory_autonomy_merges(repository_id, state);
CREATE INDEX factory_autonomy_merges_pull ON factory_autonomy_merges(repository_id, pull_number);
