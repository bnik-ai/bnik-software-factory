ALTER TABLE factory_worker_runs ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE factory_work ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE factory_work ADD COLUMN content_deleted_at timestamptz;

-- Backfill only available metadata. Never invent zero accounting or claim the
-- newly introduced budget/revision policy was enforced on historical attempts.
UPDATE factory_worker_runs r SET evidence=jsonb_build_object(
  'version',1,'legacy',true,'sourceHead',w.body->'sourceCommit',
  'archiveSha256',w.body->'archiveSha256',
  'task',CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
    'activationId',a.id,'issueId',a.issue_id::text,'number',a.issue_number,'repositoryId',a.repository_id::text) END,
  'limits',jsonb_build_object('maxTurns',w.body->'maxTurns','timeoutMs',w.body->'timeoutMs','maxBudgetUsd',NULL,'maxTaskRuns',NULL),
  'result',CASE WHEN w.result IS NULL THEN NULL ELSE jsonb_build_object('ok',w.result->'ok','patchSha256',w.result->'patchSha256') END,
  'testsStatus',COALESCE(w.result->'testsStatus','"not_run"'::jsonb),
  'tests',COALESCE((SELECT jsonb_agg(jsonb_build_object('index',ordinality-1,'exitCode',t->'exitCode',
    'commandSha256',encode(sha256(convert_to(t->>'command','UTF8')),'hex'),
    'outputSha256',encode(sha256(convert_to(t->>'output','UTF8')),'hex')))
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.result->'tests')='array' THEN w.result->'tests' ELSE '[]'::jsonb END) WITH ORDINALITY AS tests(t,ordinality)),'[]'::jsonb),
  'cost',jsonb_build_object('status',CASE WHEN jsonb_typeof(w.result->'model'->'costUsd')='number' THEN 'estimated' ELSE 'unavailable' END,
    'estimatedUsd',w.result->'model'->'costUsd','billedUsd',NULL,'hardMonetaryCeiling',false),
  'executionMayHaveStarted',r.state<>'preparing'
)
FROM factory_work w LEFT JOIN factory_task_activations a ON w.delivery_key='activation-' || a.id::text AND w.record_key=a.repository
WHERE r.work_id=w.id;
