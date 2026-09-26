// Postgres-backed AuditLedger for the github-app's webhook delivery
// idempotency / status ledger. Writes to the `webhook_deliveries` table.
//
// This is DISTINCT from the validator's hash-chained `audit_ledger`: this
// ledger only tracks per-delivery enqueue status to make the webhook's
// two-phase contract durable across redeliveries (see auditLedger.ts header).
//
// The `webhook_deliveries` table is created by the sibling validator PR's
// migration; this code only WRITES to it (assumes columns
// `delivery_id`, `event_type`, `seq`, `enqueued`).

import type { AuditLedger, BeginDeliveryArgs, BeginDeliveryResult } from './auditLedger.js';

// Minimal subset of pg.Pool we use, so unit tests can pass a fake without
// importing the runtime driver.
export interface QueryableLike {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<{ seq: number | string; enqueued: boolean }> }>;
}

export class PostgresAuditLedger implements AuditLedger {
  constructor(private readonly pool: QueryableLike) {}

  async beginDelivery(args: BeginDeliveryArgs): Promise<BeginDeliveryResult> {
    // First-seen: ON CONFLICT DO NOTHING returns the inserted row; a
    // conflict returns zero rows.
    const inserted = await this.pool.query(
      `INSERT INTO webhook_deliveries (delivery_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING seq, enqueued`,
      [args.deliveryId, args.event],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) {
      return { seq: Number(insertedRow.seq), inserted: true, alreadyEnqueued: false };
    }
    // Already-seen: read the existing row's current enqueue status. This
    // distinguishes already-enqueued (return idempotent 200) from
    // already-seen-but-pending (re-attempt enqueue), matching
    // InMemoryAuditLedger semantics exactly.
    const existing = await this.pool.query(
      'SELECT seq, enqueued FROM webhook_deliveries WHERE delivery_id = $1',
      [args.deliveryId],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new Error(
        `beginDelivery: ON CONFLICT returned no row for delivery_id "${args.deliveryId}" but the follow-up SELECT also found none.`,
      );
    }
    return {
      seq: Number(existingRow.seq),
      inserted: false,
      alreadyEnqueued: existingRow.enqueued,
    };
  }

  async confirmEnqueued(deliveryId: string): Promise<void> {
    await this.pool.query('UPDATE webhook_deliveries SET enqueued = true WHERE delivery_id = $1', [
      deliveryId,
    ]);
  }
}
