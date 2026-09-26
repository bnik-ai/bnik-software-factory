import { describe, expect, test } from 'vitest';
import { InMemoryAuditLedger } from '../src/auditLedger.js';

describe('InMemoryAuditLedger.beginDelivery', () => {
  test('first call for a delivery_id returns inserted=true, alreadyEnqueued=false, monotonic seq', async () => {
    const ledger = new InMemoryAuditLedger();
    const first = await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    const second = await ledger.beginDelivery({ deliveryId: 'b', event: 'push' });
    expect(first).toEqual({ seq: 1, inserted: true, alreadyEnqueued: false });
    expect(second).toEqual({ seq: 2, inserted: true, alreadyEnqueued: false });
  });

  test('repeat call BEFORE confirmEnqueued returns inserted=false, alreadyEnqueued=false, same seq', async () => {
    const ledger = new InMemoryAuditLedger();
    const first = await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    const retry = await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    expect(retry).toEqual({ seq: first.seq, inserted: false, alreadyEnqueued: false });
  });

  test('repeat call AFTER confirmEnqueued returns inserted=false, alreadyEnqueued=true, same seq', async () => {
    const ledger = new InMemoryAuditLedger();
    const first = await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    await ledger.confirmEnqueued('a');
    const retry = await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    expect(retry).toEqual({ seq: first.seq, inserted: false, alreadyEnqueued: true });
  });

  test('repeat call ignores event mismatch (delivery_id is the idempotency key, not delivery_id + event)', async () => {
    const ledger = new InMemoryAuditLedger();
    await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    const sameDeliveryDifferentEvent = await ledger.beginDelivery({
      deliveryId: 'a',
      event: 'pull_request',
    });
    expect(sameDeliveryDifferentEvent.inserted).toBe(false);
  });

  test('seq does NOT advance for repeat calls', async () => {
    const ledger = new InMemoryAuditLedger();
    await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    const next = await ledger.beginDelivery({ deliveryId: 'b', event: 'push' });
    expect(next.seq).toBe(2);
  });
});

describe('InMemoryAuditLedger.confirmEnqueued', () => {
  test('marks the row as enqueued so isEnqueued returns true', async () => {
    const ledger = new InMemoryAuditLedger();
    await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    expect(ledger.isEnqueued('a')).toBe(false);
    await ledger.confirmEnqueued('a');
    expect(ledger.isEnqueued('a')).toBe(true);
  });

  test('throws when called for a delivery_id without a prior beginDelivery', async () => {
    const ledger = new InMemoryAuditLedger();
    await expect(ledger.confirmEnqueued('missing')).rejects.toThrow(/no prior beginDelivery row/);
  });
});

describe('InMemoryAuditLedger inspection helpers', () => {
  test('recordedDeliveryIds + size reflect insertion order and count', async () => {
    const ledger = new InMemoryAuditLedger();
    await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    await ledger.beginDelivery({ deliveryId: 'b', event: 'push' });
    await ledger.beginDelivery({ deliveryId: 'a', event: 'issues' });
    expect(ledger.recordedDeliveryIds()).toEqual(['a', 'b']);
    expect(ledger.size()).toBe(2);
  });
});
