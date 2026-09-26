-- Spec: docs/design/validator-bot.md audit schema
-- The validator package OWNS the mirror schema. This migration creates both
-- the github-app-owned delivery-status idempotency table (webhook_deliveries)
-- and the validator-owned hash-chained event log (audit_ledger) so the two
-- sibling services share one bootstrap (the github-app PR writes
-- webhook_deliveries assuming it exists).
--
-- Column/type reconciliation with services/validator/src/auditLedger.ts:
--   - LedgerVerdict union is accept|reject|flag|record-only → the verdict
--     CHECK enumerates ALL FOUR (do NOT drop record-only; it is a live
--     member of the type even if the current resolver path emits only the
--     first three).
--   - record_kind, from_state, to_state are `string | undefined` on
--     AuditLedgerRow → NULLABLE here.
--   - payload_hash / prev_hash / this_hash are Buffers → bytea.
--   - received_at is supplied by the writer; processed_at defaults to now().
--   - seq is the monotonic chain index (PRIMARY KEY, bigserial).
--   - delivery_id is UNIQUE (validator-bot.md:239); a duplicate INSERT raises
--     SQLSTATE 23505, which postgresAuditLedgerWriter translates to
--     DuplicateLedgerEntryError.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event_type text NOT NULL,
  seq bigserial NOT NULL,
  enqueued boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_ledger (
  seq bigserial PRIMARY KEY,
  -- Named constraint so the writer can distinguish a delivery_id duplicate
  -- (→ DuplicateLedgerEntryError, idempotent ACK) from a seq collision
  -- (a chain bug — must surface, never be swallowed as idempotent).
  delivery_id text NOT NULL CONSTRAINT audit_ledger_delivery_id_key UNIQUE,
  event_type text NOT NULL,
  actor text NOT NULL,
  record_type text NOT NULL,
  record_kind text,
  record_id text NOT NULL,
  from_state text,
  to_state text,
  verdict text NOT NULL CHECK (verdict IN ('accept', 'reject', 'flag', 'record-only')),
  payload_hash bytea NOT NULL,
  prev_hash bytea NOT NULL,
  this_hash bytea NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- getLastTransitionForRecord() scans by record_id, most-recent-first.
CREATE INDEX IF NOT EXISTS audit_ledger_record_lookup
  ON audit_ledger (record_id, processed_at DESC);

-- Deployment-specific role grants belong in the deployment overlay.
