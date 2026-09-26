import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { InMemoryEventQueueConsumer, type ParsedTransitionMessage } from '../src/queueConsumer.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.transitioned',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA',
    fromState: 'proposed',
    toState: 'accepted',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-29T18:00:00Z'),
    ...overrides,
  };
}

describe('InMemoryEventQueueConsumer — receive', () => {
  test('returns empty when queue is empty', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    await expect(consumer.receive({ maxMessages: 5 })).resolves.toEqual([]);
  });

  test('returns up to maxMessages in FIFO order', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    consumer.enqueue(makeMessage({ lockToken: 'lt-1' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-2' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-3' }));
    const batch = await consumer.receive({ maxMessages: 2 });
    expect(batch.map((m) => m.lockToken)).toEqual(['lt-1', 'lt-2']);
    expect(consumer.inflightCount()).toBe(2);
    expect(consumer.pendingCount()).toBe(1);
  });

  test('a received message stays inflight until ack or deadletter', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    consumer.enqueue(makeMessage());
    await consumer.receive({ maxMessages: 1 });
    expect(consumer.inflightCount()).toBe(1);
    expect(consumer.ackedMessages()).toHaveLength(0);
  });
});

describe('InMemoryEventQueueConsumer — ack', () => {
  test('ack removes from inflight and records the message', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    consumer.enqueue(makeMessage({ lockToken: 'lt-1' }));
    await consumer.receive({ maxMessages: 1 });
    await consumer.ack('lt-1');
    expect(consumer.inflightCount()).toBe(0);
    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['lt-1']);
  });

  test('ack on unknown lock token throws', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    await expect(consumer.ack('unknown')).rejects.toThrow(/unknown lock token/);
  });
});

describe('InMemoryEventQueueConsumer — deadletter', () => {
  test('deadletter removes from inflight and records the reason', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    consumer.enqueue(makeMessage({ lockToken: 'lt-1' }));
    await consumer.receive({ maxMessages: 1 });
    await consumer.deadletter('lt-1', 'unknown_actor');
    expect(consumer.inflightCount()).toBe(0);
    expect(consumer.deadletteredMessages()).toHaveLength(1);
    expect(consumer.deadletteredMessages()[0]?.reason).toBe('unknown_actor');
  });

  test('deadletter on unknown lock token throws', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    await expect(consumer.deadletter('unknown', 'reason')).rejects.toThrow(/unknown lock token/);
  });
});
