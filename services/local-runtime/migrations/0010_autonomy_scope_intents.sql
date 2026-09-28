-- A scope binds each Task to the intent digest the owner reviewed at grant time. An
-- issue edited afterwards no longer matches and is not executed under the grant.
-- (Autonomy tables already carry SELECT for factory_runtime and writes for factory_controller.)
ALTER TABLE factory_autonomy_scopes
  ADD COLUMN task_intents jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(task_intents) = 'object');
