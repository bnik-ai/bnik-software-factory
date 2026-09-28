-- Controller serialization rows: one per Task and one per repository, held with
-- SELECT ... FOR UPDATE / FOR SHARE NOWAIT for the life of a controller command. Row locks
-- need UPDATE privilege, which the internet-facing runtime role never receives on this
-- table, so that role cannot stall or spoof a controller (an advisory lock would let it).
CREATE TABLE factory_autonomy_locks (
  lock_key text PRIMARY KEY CHECK (lock_key ~ '^(Repository:[0-9]+|Task:[0-9]+:[0-9]+)$'),
  repository_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
