// Spec: docs/design/validator-bot.md "Audit ledger" + plan
// InMemoryAuditLedgerWriter — same hash-chain math (reuses computeRowHash),
// same DuplicateLedgerEntryError on a duplicate delivery_id.
// Invariants:
//   - append() runs in a transaction: BEGIN → SELECT this_hash,seq FROM
//     audit_ledger ORDER BY seq DESC LIMIT 1 FOR UPDATE → compute
//     prevHash/seq/thisHash → INSERT ... RETURNING * → COMMIT. The FOR
//     UPDATE serializes concurrent appenders so the chain stays linear
//     even with multiple validator executions racing.
//   - genesis (empty table): prevHash = 32 zero bytes, seq = 1.
//   - PG SQLSTATE 23505 (unique_violation on delivery_id) → rolled back +
//     re-thrown as DuplicateLedgerEntryError (the type processMessage
//     treats as idempotent-ack).
//   - getLastTransitionForRecord() matches the in-memory semantics: most
//     recent committed-state row (verdict ∈ accept,flag AND to_state set)
//     for the record, via the (record_id, processed_at DESC) index.
//   - DB rows ↔ AuditLedgerRow mapping mirrors the in-memory writer exactly
//     (Buffers for the hash/payload columns, Dates for the timestamps).

import {
  type AppendArgs,
  type AuditLedgerReader,
  type AuditLedgerRow,
  type AuditLedgerWriter,
  DuplicateLedgerEntryError,
  type LedgerVerdict,
  computeRowHash,
} from './auditLedger.js';
import type { PgClient, PgPool } from './postgresClient.js';

const GENESIS_PREV_HASH: Buffer = Buffer.alloc(32);
const PG_UNIQUE_VIOLATION = '23505';
// Named in 0001_audit_ledger.sql. A 23505 on THIS constraint is a delivery
// redelivery (idempotent); a 23505 on any other constraint (e.g. the seq
// primary key) is a chain bug and must surface, not be swallowed as a dup.
const DELIVERY_ID_CONSTRAINT = 'audit_ledger_delivery_id_key';
// Arbitrary fixed key: pg_advisory_xact_lock serializes ALL appenders on the
// chain so the tail read + insert are atomic w.r.t. concurrent executions.
// Row-level FOR UPDATE alone does NOT block an INSERT of a NEW tail row, so a
// second appender could read a stale tail and compute a duplicate seq.
const APPEND_ADVISORY_LOCK_KEY = 4_021_980_017;

// Shape of an audit_ledger row as pg returns it. bytea → Buffer,
// timestamptz → Date, bigserial → string ('seq' is returned as a string by
// node-postgres for int8 by default, so we Number() it on the way in).
interface AuditLedgerDbRow {
  seq: string | number;
  delivery_id: string;
  event_type: string;
  actor: string;
  record_type: string;
  record_kind: string | null;
  record_id: string;
  from_state: string | null;
  to_state: string | null;
  verdict: LedgerVerdict;
  payload_hash: Buffer;
  prev_hash: Buffer;
  this_hash: Buffer;
  received_at: Date;
  processed_at: Date;
}

function mapDbRow(row: AuditLedgerDbRow): AuditLedgerRow {
  return Object.freeze({
    seq: Number(row.seq),
    deliveryId: row.delivery_id,
    eventType: row.event_type,
    actor: row.actor,
    recordType: row.record_type,
    recordKind: row.record_kind ?? undefined,
    recordId: row.record_id,
    fromState: row.from_state ?? undefined,
    toState: row.to_state ?? undefined,
    verdict: row.verdict,
    payloadHash: Buffer.from(row.payload_hash),
    prevHash: Buffer.from(row.prev_hash),
    thisHash: Buffer.from(row.this_hash),
    receivedAt: new Date(row.received_at),
    processedAt: new Date(row.processed_at),
  });
}

// True only for a 23505 on the delivery_id unique constraint — a redelivery.
// A 23505 on any other constraint (seq PK) is NOT a duplicate delivery and
// must propagate so it is never mis-acked as idempotent.
function isDeliveryIdDuplicate(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === PG_UNIQUE_VIOLATION && e.constraint === DELIVERY_ID_CONSTRAINT;
}

export class PostgresAuditLedgerWriter implements AuditLedgerWriter, AuditLedgerReader {
  constructor(private readonly pool: PgPool) {}

  async append(args: AppendArgs): Promise<AuditLedgerRow> {
    const client: PgClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.appendInTransaction(client, args, true);
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isDeliveryIdDuplicate(err)) {
        throw new DuplicateLedgerEntryError(args.deliveryId, args.eventType);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // Caller owns BEGIN/COMMIT/ROLLBACK. Used by durable transports to commit
  // the audit row, outgoing work and incoming settlement as one transaction.
  // Do not catch SQL errors and continue using an aborted transaction.
  async appendInTransaction(
    client: PgClient,
    args: AppendArgs,
    lockTail = false,
  ): Promise<AuditLedgerRow> {
    // Serialize ALL appenders for the duration of the transaction. Row-level
    // FOR UPDATE on the tail does not block a concurrent INSERT of a NEW tail
    // row, so two executions could both read the same predecessor and compute
    // the same next seq. The transaction-scoped advisory lock makes the
    // tail-read + insert atomic across executions; it auto-releases on
    // COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock($1)', [APPEND_ADVISORY_LOCK_KEY]);
    // The standalone/cloud writer retains its legacy tail lock. Local append-only
    // roles use the same advisory lock without requiring UPDATE permission.
    const tail = await client.query<{
      this_hash: Buffer;
      seq: string | number;
    }>(
      `SELECT this_hash, seq FROM audit_ledger ORDER BY seq DESC LIMIT 1${lockTail ? ' FOR UPDATE' : ''}`,
    );
    const previous = tail.rows[0];
    const prevHash =
      previous !== undefined ? Buffer.from(previous.this_hash) : Buffer.from(GENESIS_PREV_HASH);
    const seq = previous !== undefined ? Number(previous.seq) + 1 : 1;
    const payloadHash = Buffer.from(args.payloadHash);
    const thisHash = computeRowHash({ payloadHash, prevHash, seq });

    const inserted = await client.query<AuditLedgerDbRow>(
      `INSERT INTO audit_ledger (
       seq, delivery_id, event_type, actor, record_type, record_kind,
       record_id, from_state, to_state, verdict,
       payload_hash, prev_hash, this_hash, received_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
      [
        seq,
        args.deliveryId,
        args.eventType,
        args.actor,
        args.recordType,
        args.recordKind ?? null,
        args.recordId,
        args.fromState ?? null,
        args.toState ?? null,
        args.verdict,
        payloadHash,
        prevHash,
        thisHash,
        args.receivedAt,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('INSERT ... RETURNING * returned no row');
    }
    return mapDbRow(row);
  }

  async getByDeliveryId(deliveryId: string): Promise<AuditLedgerRow | undefined> {
    const result = await this.pool.query<AuditLedgerDbRow>(
      'SELECT * FROM audit_ledger WHERE delivery_id = $1 LIMIT 1',
      [deliveryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapDbRow(row);
  }

  async getLastTransitionForRecord(recordId: string): Promise<AuditLedgerRow | undefined> {
    const result = await this.pool.query<AuditLedgerDbRow>(
      `SELECT * FROM audit_ledger
         WHERE record_id = $1
           AND verdict IN ('accept', 'flag')
           AND to_state IS NOT NULL
         ORDER BY processed_at DESC
         LIMIT 1`,
      [recordId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapDbRow(row);
  }
}
