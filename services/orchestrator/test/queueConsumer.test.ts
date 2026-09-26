import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { InMemoryEventQueueConsumer } from '../src/queueConsumer.js';
import type { ParsedTransitionMessage } from '../src/types.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.labeled',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA',
    fromState: 'proposed',
    toState: 'accepted',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

describe('InMemoryEventQueueConsumer', () => {
  test('receive returns up to maxMessages in FIFO order', async () => {
    const c = new InMemoryEventQueueConsumer();
    c.enqueue(makeMessage({ lockToken: 'lt-a', deliveryId: 'd-a' }));
    c.enqueue(makeMessage({ lockToken: 'lt-b', deliveryId: 'd-b' }));
    c.enqueue(makeMessage({ lockToken: 'lt-c', deliveryId: 'd-c' }));

    const batch = await c.receive({ maxMessages: 2 });
    expect(batch.map((m) => m.lockToken)).toEqual(['lt-a', 'lt-b']);
    expect(c.pendingCount()).toBe(1);
    expect(c.inflightCount()).toBe(2);
  });

  test('ack removes inflight message', async () => {
    const c = new InMemoryEventQueueConsumer();
    c.enqueue(makeMessage({ lockToken: 'lt-1' }));
    await c.receive({ maxMessages: 1 });
    await c.ack('lt-1');
    expect(c.inflightCount()).toBe(0);
    expect(c.ackedMessages().map((m) => m.lockToken)).toEqual(['lt-1']);
  });

  test('deadletter removes inflight + records reason', async () => {
    const c = new InMemoryEventQueueConsumer();
    c.enqueue(makeMessage({ lockToken: 'lt-1' }));
    await c.receive({ maxMessages: 1 });
    await c.deadletter('lt-1', 'route:unknown_transition');
    expect(c.inflightCount()).toBe(0);
    expect(c.deadletteredMessages()[0]?.reason).toBe('route:unknown_transition');
  });

  test('ack with unknown lockToken throws', async () => {
    const c = new InMemoryEventQueueConsumer();
    await expect(c.ack('lt-missing')).rejects.toThrow(/unknown lock token/);
  });

  test('deadletter with unknown lockToken throws', async () => {
    const c = new InMemoryEventQueueConsumer();
    await expect(c.deadletter('lt-missing', 'r')).rejects.toThrow(/unknown lock token/);
  });
});
