// Audit-ledger contract for the webhook's substrate-write path.
//
// The route handler must NOT use a single "insert → return 200 on conflict"
// pattern: if the insert succeeds but the downstream enqueue fails, the
// next retry sees a conflict and returns 200 without enqueueing — silently
// dropping the webhook. Instead
// the ledger exposes a two-phase contract:
//
//   1. `beginDelivery({ deliveryId, event })` reserves a row keyed by
//      `delivery_id` and returns its seq plus whether it was newly inserted
//      and whether a prior request has already confirmed enqueue. Three
//      cases:
//
//      - `{ inserted: true,  alreadyEnqueued: false }` → first sighting;
//        the caller MUST enqueue and then call `confirmEnqueued`.
//      - `{ inserted: false, alreadyEnqueued: false }` → a prior request
//        inserted but never confirmed (e.g. the queue write threw and
//        GitHub redelivered). The caller MUST re-attempt enqueue and
//        confirm. The downstream queue is at-least-once; consumers must
//        deduplicate on `delivery_id` (the design's stated invariant).
//      - `{ inserted: false, alreadyEnqueued: true  }` → already
//        processed end-to-end; the caller returns 200 idempotent and
//        does NOT re-enqueue.
//
//   2. `confirmEnqueued(deliveryId)` marks the row as fully processed.
//      Called only AFTER the queue write succeeds.
//
// The Postgres implementation (postgresAuditLedger.ts) stores the status
// flag in a column on `webhook_deliveries`. `beginDelivery` does
// `INSERT … ON CONFLICT (delivery_id) DO NOTHING RETURNING seq, enqueued`
// then, on conflict, a follow-up `SELECT seq, enqueued FROM
// webhook_deliveries WHERE delivery_id = $1`. `confirmEnqueued` does
// `UPDATE webhook_deliveries SET enqueued = true WHERE delivery_id = $1`.
// The in-memory implementation below has identical observable behaviour
// and is used by tests and v0 boot until the Postgres-backed
// implementation lands.

export interface BeginDeliveryArgs {
  deliveryId: string;
  event: string;
}

export interface BeginDeliveryResult {
  seq: number;
  inserted: boolean;
  alreadyEnqueued: boolean;
}

export interface AuditLedger {
  beginDelivery(args: BeginDeliveryArgs): Promise<BeginDeliveryResult>;
  confirmEnqueued(deliveryId: string): Promise<void>;
}

interface LedgerRow {
  seq: number;
  enqueued: boolean;
}

export class InMemoryAuditLedger implements AuditLedger {
  private readonly rowsByDeliveryId = new Map<string, LedgerRow>();
  private nextSeq = 1;

  async beginDelivery(args: BeginDeliveryArgs): Promise<BeginDeliveryResult> {
    const existing = this.rowsByDeliveryId.get(args.deliveryId);
    if (existing !== undefined) {
      return { seq: existing.seq, inserted: false, alreadyEnqueued: existing.enqueued };
    }
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.rowsByDeliveryId.set(args.deliveryId, { seq, enqueued: false });
    return { seq, inserted: true, alreadyEnqueued: false };
  }

  async confirmEnqueued(deliveryId: string): Promise<void> {
    const row = this.rowsByDeliveryId.get(deliveryId);
    if (row === undefined) {
      throw new Error(
        `confirmEnqueued called for delivery_id "${deliveryId}" with no prior beginDelivery row`,
      );
    }
    row.enqueued = true;
  }

  // Test-only inspection helpers — not part of the AuditLedger contract.
  recordedDeliveryIds(): readonly string[] {
    return Array.from(this.rowsByDeliveryId.keys());
  }

  size(): number {
    return this.rowsByDeliveryId.size;
  }

  isEnqueued(deliveryId: string): boolean {
    return this.rowsByDeliveryId.get(deliveryId)?.enqueued ?? false;
  }
}
