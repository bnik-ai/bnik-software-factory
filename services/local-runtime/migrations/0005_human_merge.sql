CREATE TABLE factory_pr_pairs (
  repository_id bigint NOT NULL,
  installation_id bigint NOT NULL,
  pull_number integer NOT NULL,
  task_number integer NOT NULL,
  pair jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(repository_id,pull_number),
  UNIQUE(repository_id,task_number)
);
CREATE TABLE factory_pr_observations (
  id bigserial PRIMARY KEY,
  repository_id bigint NOT NULL,
  pull_number integer NOT NULL,
  foundation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX factory_pr_observations_lookup ON factory_pr_observations(repository_id,pull_number,id DESC);
CREATE TABLE factory_merge_receipts (
  repository_id bigint NOT NULL,
  pull_number integer NOT NULL,
  proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(repository_id,pull_number)
);
CREATE TABLE factory_pr_state (
  repository_id bigint NOT NULL,
  pull_number integer NOT NULL,
  state text NOT NULL CHECK(state IN ('parked','awaiting_human_merge','reconciled')),
  reason text NOT NULL,
  head text,
  evidence jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(repository_id,pull_number)
);
CREATE TABLE factory_dependency_state (
  repository_id bigint PRIMARY KEY,
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
