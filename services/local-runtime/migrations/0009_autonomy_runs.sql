-- Controller pipeline state and human approvals. Written only by the controller
-- role (migrate.ts); the internet-facing runtime role keeps SELECT.
CREATE TABLE factory_autonomy_approvals (
  approval_id uuid PRIMARY KEY,
  repository_id bigint NOT NULL,
  action_sha256 text NOT NULL CHECK (action_sha256 ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('execute','publish','merge')),
  approver_user_id bigint NOT NULL CHECK (approver_user_id > 0),
  source text NOT NULL CHECK (source IN ('github_review','operator_console')),
  -- Where the approval was observed: review id and head, or the console actor.
  evidence jsonb NOT NULL,
  approved_at timestamptz NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (action_sha256, approver_user_id)
);
CREATE INDEX factory_autonomy_approvals_action ON factory_autonomy_approvals(action_sha256);
CREATE TABLE factory_autonomy_runs (
  run_id uuid PRIMARY KEY,
  repository_id bigint NOT NULL,
  scope_id text NOT NULL REFERENCES factory_autonomy_scopes(scope_id),
  task_id text NOT NULL,
  task_number integer NOT NULL CHECK (task_number > 0),
  task_issue_id bigint NOT NULL CHECK (task_issue_id > 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL CHECK (state IN (
    'admitted','executing','executed','collected','verified','publish_admitted',
    'published','held','repair','blocked','failed','cancelled','unknown')),
  reason text,
  execute_decision_id uuid REFERENCES factory_autonomy_decisions(decision_id),
  reservation_id uuid REFERENCES factory_autonomy_reservations(reservation_id),
  worker_job_id text,
  source_commit text CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{40}$'),
  archive_sha256 text CHECK (archive_sha256 IS NULL OR archive_sha256 ~ '^[0-9a-f]{64}$'),
  intent_sha256 text CHECK (intent_sha256 IS NULL OR intent_sha256 ~ '^[0-9a-f]{64}$'),
  base_tree text CHECK (base_tree IS NULL OR base_tree ~ '^[0-9a-f]{40}$'),
  candidate_tree text CHECK (candidate_tree IS NULL OR candidate_tree ~ '^[0-9a-f]{40}$'),
  changes_sha256 text CHECK (changes_sha256 IS NULL OR changes_sha256 ~ '^[0-9a-f]{64}$'),
  -- Receipts as produced (acceptance, review, dependency) and the decisions that consumed them.
  receipts jsonb NOT NULL DEFAULT '{}'::jsonb,
  publish_decision_id uuid REFERENCES factory_autonomy_decisions(decision_id),
  -- Branch, head, tree, PR number and node id, publisher installation and repository.
  publication jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (repository_id, task_id, attempt)
);
CREATE INDEX factory_autonomy_runs_task ON factory_autonomy_runs(repository_id, task_id, attempt DESC);
-- One open attempt per Task: a crashed controller resumes it instead of starting another.
-- A held attempt stays open until a human approves or cancels it.
CREATE UNIQUE INDEX factory_autonomy_runs_open_attempt
  ON factory_autonomy_runs(repository_id, task_id)
  WHERE state NOT IN ('published','repair','blocked','failed','cancelled');
