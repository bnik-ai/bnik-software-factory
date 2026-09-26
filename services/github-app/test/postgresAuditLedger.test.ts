import { describe, expect, test } from 'vitest';
import { PostgresAuditLedger, type QueryableLike } from '../src/postgresAuditLedger.js';

// Minimal in-memory fake of the webhook_deliveries table that honours the
// exact SQL semantics the ledger relies on (ON CONFLICT DO NOTHING + the
// follow-up SELECT + the UPDATE). Lets us assert the three BeginDelivery
// cases without a real Postgres.
function makeFakePool(): QueryableLike & {
  rowsByDeliveryId: Map<string, { seq: number; enqueued: boolean }>;
} {
  const rowsByDeliveryId = new Map<string, { seq: number; enqueued: boolean }>();
  let nextSeq = 1;
  return {
    rowsByDeliveryId,
    async query(text, values) {
      const sql = text.trim();
      if (sql.startsWith('INSERT INTO webhook_deliveries')) {
        const deliveryId = values?.[0] as string;
        if (rowsByDeliveryId.has(deliveryId)) {
          return { rows: [] }; // ON CONFLICT DO NOTHING → no row
        }
        const row = { seq: nextSeq++, enqueued: false };
        rowsByDeliveryId.set(deliveryId, row);
        return { rows: [{ seq: row.seq, enqueued: row.enqueued }] };
      }
      if (sql.startsWith('SELECT seq, enqueued')) {
        const deliveryId = values?.[0] as string;
        const row = rowsByDeliveryId.get(deliveryId);
        return { rows: row ? [{ seq: row.seq, enqueued: row.enqueued }] : [] };
      }
      if (sql.startsWith('UPDATE webhook_deliveries')) {
        const deliveryId = values?.[0] as string;
        const row = rowsByDeliveryId.get(deliveryId);
        if (row) row.enqueued = true;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

describe('PostgresAuditLedger.beginDelivery', () => {
  test('first sighting returns inserted=true, alreadyEnqueued=false', async () => {
    const ledger = new PostgresAuditLedger(makeFakePool());
    const result = await ledger.beginDelivery({ deliveryId: 'd-1', event: 'issues' });
    expect(result).toEqual({ seq: 1, inserted: true, alreadyEnqueued: false });
  });

  test('second sighting (pending) returns inserted=false, alreadyEnqueued=false', async () => {
    const ledger = new PostgresAuditLedger(makeFakePool());
    await ledger.beginDelivery({ deliveryId: 'd-1', event: 'issues' });
    const result = await ledger.beginDelivery({ deliveryId: 'd-1', event: 'issues' });
    expect(result).toEqual({ seq: 1, inserted: false, alreadyEnqueued: false });
  });

  test('after confirmEnqueued, re-begin returns alreadyEnqueued=true', async () => {
    const ledger = new PostgresAuditLedger(makeFakePool());
    await ledger.beginDelivery({ deliveryId: 'd-1', event: 'issues' });
    await ledger.confirmEnqueued('d-1');
    const result = await ledger.beginDelivery({ deliveryId: 'd-1', event: 'issues' });
    expect(result).toEqual({ seq: 1, inserted: false, alreadyEnqueued: true });
  });

  test('seq is coerced to a number even if pg returns a bigint string', async () => {
    const pool: QueryableLike = {
      async query(text) {
        if (text.trim().startsWith('INSERT')) {
          return { rows: [{ seq: '42', enqueued: false }] };
        }
        return { rows: [] };
      },
    };
    const result = await new PostgresAuditLedger(pool).beginDelivery({
      deliveryId: 'd-1',
      event: 'issues',
    });
    expect(result.seq).toBe(42);
    expect(typeof result.seq).toBe('number');
  });

  test('throws if the conflict path finds no row (data-integrity guard)', async () => {
    const pool: QueryableLike = {
      async query() {
        return { rows: [] }; // both INSERT and SELECT return nothing
      },
    };
    await expect(
      new PostgresAuditLedger(pool).beginDelivery({ deliveryId: 'd-x', event: 'issues' }),
    ).rejects.toThrow(/no row/);
  });
});

describe('PostgresAuditLedger.confirmEnqueued', () => {
  test('marks the row enqueued', async () => {
    const pool = makeFakePool();
    const ledger = new PostgresAuditLedger(pool);
    await ledger.beginDelivery({ deliveryId: 'd-1', event: 'issues' });
    await ledger.confirmEnqueued('d-1');
    expect(pool.rowsByDeliveryId.get('d-1')?.enqueued).toBe(true);
  });
});
