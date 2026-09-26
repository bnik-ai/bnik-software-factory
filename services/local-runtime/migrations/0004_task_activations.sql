CREATE TABLE factory_task_activations (
  id uuid PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE,
  repository_id bigint NOT NULL,
  repository text NOT NULL,
  installation_id bigint NOT NULL,
  issue_number integer NOT NULL,
  issue_id bigint NOT NULL,
  comment_id bigint NOT NULL,
  actor_id bigint NOT NULL,
  actor_login text NOT NULL,
  source_commit text NOT NULL,
  task_hash text NOT NULL,
  proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(repository_id,comment_id)
);
