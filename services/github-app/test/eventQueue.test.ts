import { describe, expect, test } from 'vitest';
import { InMemoryEventQueue } from '../src/eventQueue.js';

describe('InMemoryEventQueue', () => {
  test('records a single enqueue with all supplied fields', async () => {
    const queue = new InMemoryEventQueue();
    await queue.enqueue({
      deliveryId: 'a',
      event: 'issues',
      payload: '{"action":"opened"}',
      sessionId: 'MDU6SXNzdWUx',
    });
    expect(queue.enqueuedMessages()).toEqual([
      {
        deliveryId: 'a',
        event: 'issues',
        payload: '{"action":"opened"}',
        sessionId: 'MDU6SXNzdWUx',
      },
    ]);
  });

  test('preserves enqueue order across multiple calls', async () => {
    const queue = new InMemoryEventQueue();
    await queue.enqueue({ deliveryId: 'a', event: 'issues', payload: '{"a":1}' });
    await queue.enqueue({ deliveryId: 'b', event: 'push', payload: '{"b":2}' });
    await queue.enqueue({ deliveryId: 'c', event: 'pull_request', payload: '{"c":3}' });
    expect(queue.enqueuedMessages().map((m) => m.deliveryId)).toEqual(['a', 'b', 'c']);
  });

  test('omitting sessionId leaves the field unset rather than recording undefined', async () => {
    const queue = new InMemoryEventQueue();
    await queue.enqueue({ deliveryId: 'a', event: 'ping', payload: '{}' });
    const messages = queue.enqueuedMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.sessionId).toBeUndefined();
  });
});
