import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DISPATCH_QUEUE_NAME,
  type ReceivedMessageLike,
  type ReceiverLike,
  SERVICE_BUS_CONNECTION_STRING_ENV,
  SERVICE_BUS_DISPATCH_QUEUE_ENV,
  SERVICE_BUS_NAMESPACE_ENV,
  ServiceBusDispatchQueueConsumer,
  isTransientServiceBusError,
  resolveDispatchConsumerBootConfig,
} from '../src/serviceBusEventQueueConsumer.js';

// Mirrors the validator's outgoingPublisher.serializePublishedMessage wire
// body: { message: WireParsedTransitionMessage, verdict: {...} } with
// payloadHash as hex and receivedAt as ISO 8601.
function makeWireBody(overrides: Partial<Record<string, unknown>> = {}): {
  message: Record<string, unknown>;
  verdict: { verdict: string; reason?: string };
} {
  const payloadHash = createHash('sha256').update('p').digest().toString('hex');
  const message: Record<string, unknown> = {
    lockToken: 'wire-lt',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.labeled',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA',
    fromState: 'proposed',
    toState: 'accepted',
    payloadHash,
    receivedAt: '2026-05-30T18:00:00.000Z',
    verdict: 'accept',
    ...overrides,
  };
  return { message, verdict: { verdict: 'accept' } };
}

function makeReceivedMessage(lockToken: string, body: unknown): ReceivedMessageLike {
  return { lockToken, body };
}

// A scriptable fake receiver: receiveMessages returns successive queued
// batches; completeMessage / deadLetterMessage record settlements.
class FakeReceiver implements ReceiverLike {
  completed: ReceivedMessageLike[] = [];
  deadlettered: { message: ReceivedMessageLike; reason?: string }[] = [];
  closed = false;
  private batches: ReceivedMessageLike[][];

  constructor(batches: ReceivedMessageLike[][]) {
    this.batches = batches;
  }

  async receiveMessages(): Promise<ReceivedMessageLike[]> {
    return this.batches.shift() ?? [];
  }
  async completeMessage(message: ReceivedMessageLike): Promise<void> {
    this.completed.push(message);
  }
  async deadLetterMessage(
    message: ReceivedMessageLike,
    options?: { deadLetterReason?: string },
  ): Promise<void> {
    this.deadlettered.push({ message, reason: options?.deadLetterReason });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('ServiceBusDispatchQueueConsumer — receive + deserialize', () => {
  test('deserializes the validator wire body into a ParsedTransitionMessage, stitching the SB lockToken', async () => {
    const receiver = new FakeReceiver([[makeReceivedMessage('sb-lt-1', makeWireBody())]]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(1);
    const msg = batch[0];
    if (msg === undefined) throw new Error('expected a message');

    // lockToken comes from the SB envelope, NOT the wire body's own field.
    expect(msg.lockToken).toBe('sb-lt-1');
    expect(msg.deliveryId).toBe('d-1');
    expect(msg.kind).toBe('goal');
    expect(msg.recordKind).toBe('Goal');
    expect(msg.fromState).toBe('proposed');
    expect(msg.toState).toBe('accepted');
    // hex → Buffer round-trips the validator's payloadHash.toString('hex').
    expect(msg.payloadHash.equals(createHash('sha256').update('p').digest())).toBe(true);
    // ISO → Date.
    expect(msg.receivedAt.toISOString()).toBe('2026-05-30T18:00:00.000Z');
    // verdict from message.verdict — what processMessage gates on.
    expect(msg.verdict).toBe('accept');
    expect(consumer.inflightCount()).toBe(1);
  });

  test('forwards M2 + PR fields when present (verdict/repoFullName/installationId/headBranch/baseBranch)', async () => {
    const receiver = new FakeReceiver([
      [
        makeReceivedMessage(
          'sb-lt-2',
          makeWireBody({
            verdict: 'accept',
            repoFullName: 'example-org/software-factory',
            installationId: 12345,
            headBranch: 'sf/T-42/feature',
            baseBranch: 'main',
          }),
        ),
      ],
    ]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });

    const [msg] = await consumer.receive({ maxMessages: 10 });
    if (msg === undefined) throw new Error('expected a message');
    expect(msg.repoFullName).toBe('example-org/software-factory');
    expect(msg.installationId).toBe(12345);
    expect(msg.headBranch).toBe('sf/T-42/feature');
    expect(msg.baseBranch).toBe('main');
  });

  test('accepts a body delivered as a JSON string (SDK content-type variance)', async () => {
    const receiver = new FakeReceiver([
      [makeReceivedMessage('sb-lt-3', JSON.stringify(makeWireBody()))],
    ]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });

    const [msg] = await consumer.receive({ maxMessages: 10 });
    expect(msg?.lockToken).toBe('sb-lt-3');
  });

  test('empty queue → empty batch', async () => {
    const receiver = new FakeReceiver([[]]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });
    expect(await consumer.receive({ maxMessages: 10 })).toEqual([]);
  });

  test('deadletters an unparseable body inside receive() and excludes it from the batch', async () => {
    const receiver = new FakeReceiver([
      [
        makeReceivedMessage('sb-lt-good', makeWireBody()),
        makeReceivedMessage('sb-lt-bad', { not: 'a wire message' }),
      ],
    ]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch.map((m) => m.lockToken)).toEqual(['sb-lt-good']);
    expect(receiver.deadlettered).toHaveLength(1);
    expect(receiver.deadlettered[0]?.reason).toBe('unparseable_dispatch_message');
  });

  test('deadletters a message missing a lock token', async () => {
    const receiver = new FakeReceiver([[{ lockToken: undefined, body: makeWireBody() }]]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(0);
    expect(receiver.deadlettered[0]?.reason).toBe('missing_lock_token');
  });

  test('rejects a malformed receivedAt (non-ISO) by deadlettering', async () => {
    const receiver = new FakeReceiver([
      [makeReceivedMessage('sb-lt-x', makeWireBody({ receivedAt: 'not-a-date' }))],
    ]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });
    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(0);
    expect(receiver.deadlettered[0]?.reason).toBe('unparseable_dispatch_message');
  });
});

describe('ServiceBusDispatchQueueConsumer — ack / deadletter settle the stored raw message', () => {
  test('ack(lockToken) → completeMessage on the SAME raw SB message', async () => {
    const raw = makeReceivedMessage('sb-lt-1', makeWireBody());
    const receiver = new FakeReceiver([[raw]]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });

    await consumer.receive({ maxMessages: 10 });
    await consumer.ack('sb-lt-1');
    expect(receiver.completed).toEqual([raw]);
    expect(consumer.inflightCount()).toBe(0);
  });

  test('deadletter(lockToken, reason) → deadLetterMessage with the reason', async () => {
    const raw = makeReceivedMessage('sb-lt-1', makeWireBody());
    const receiver = new FakeReceiver([[raw]]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });

    await consumer.receive({ maxMessages: 10 });
    await consumer.deadletter('sb-lt-1', 'route:unknown_kind');
    expect(receiver.deadlettered).toEqual([{ message: raw, reason: 'route:unknown_kind' }]);
    expect(consumer.inflightCount()).toBe(0);
  });

  test('ack on an unknown lock token throws', async () => {
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => new FakeReceiver([[]]),
    });
    await expect(consumer.ack('nope')).rejects.toThrow(/unknown lock token/);
  });
});

describe('ServiceBusDispatchQueueConsumer — receiver reuse + close + transient guard', () => {
  test('reuses one receiver across polls (factory called once)', async () => {
    const receiver = new FakeReceiver([[], []]);
    const factory = vi.fn(async () => receiver);
    const consumer = new ServiceBusDispatchQueueConsumer({ receiverFactory: factory });

    await consumer.receive({ maxMessages: 10 });
    await consumer.receive({ maxMessages: 10 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('close() closes the receiver', async () => {
    const receiver = new FakeReceiver([[]]);
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => receiver,
    });
    await consumer.receive({ maxMessages: 10 });
    await consumer.close();
    expect(receiver.closed).toBe(true);
  });

  test('a transient receiveMessages error normalizes to an empty poll (no throw)', async () => {
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => ({
        receiveMessages: async () => {
          throw { name: 'ServiceBusError', code: 'ServiceTimeout' };
        },
        completeMessage: async () => undefined,
        deadLetterMessage: async () => undefined,
        close: async () => undefined,
      }),
    });
    expect(await consumer.receive({ maxMessages: 10 })).toEqual([]);
  });

  test('a non-transient receiveMessages error propagates (loop ends execution for redelivery)', async () => {
    const consumer = new ServiceBusDispatchQueueConsumer({
      receiverFactory: async () => ({
        receiveMessages: async () => {
          throw new Error('UnauthorizedAccess');
        },
        completeMessage: async () => undefined,
        deadLetterMessage: async () => undefined,
        close: async () => undefined,
      }),
    });
    await expect(consumer.receive({ maxMessages: 10 })).rejects.toThrow(/UnauthorizedAccess/);
  });

  test('requires receiverFactory OR auth', () => {
    expect(() => new ServiceBusDispatchQueueConsumer({})).toThrow(
      /requires either receiverFactory or auth/,
    );
  });
});

describe('isTransientServiceBusError', () => {
  test('treats SB transient codes + retryable + abort/timeout as transient', () => {
    expect(isTransientServiceBusError({ code: 'ServiceTimeout' })).toBe(true);
    expect(isTransientServiceBusError({ code: 'ServiceBusy' })).toBe(true);
    expect(isTransientServiceBusError({ retryable: true })).toBe(true);
    expect(isTransientServiceBusError({ name: 'AbortError' })).toBe(true);
    expect(isTransientServiceBusError({ code: 'OperationTimeoutError' })).toBe(true);
  });
  test('does NOT swallow genuine faults', () => {
    expect(isTransientServiceBusError({ code: 'UnauthorizedAccess' })).toBe(false);
    expect(isTransientServiceBusError(new TypeError('bug'))).toBe(false);
    expect(isTransientServiceBusError(null)).toBe(false);
    expect(isTransientServiceBusError('oops')).toBe(false);
  });
});

describe('resolveDispatchConsumerBootConfig', () => {
  function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
    const previous: Record<string, string | undefined> = {};
    for (const key of Object.keys(overrides)) previous[key] = process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test('no SB env → in-memory (preserves CI/test boot)', () => {
    const cfg = withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: undefined,
        [SERVICE_BUS_NAMESPACE_ENV]: undefined,
        [SERVICE_BUS_DISPATCH_QUEUE_ENV]: undefined,
      },
      () => resolveDispatchConsumerBootConfig(),
    );
    expect(cfg).toEqual({ kind: 'in-memory' });
  });

  test('connection string preferred over namespace; default queue name', () => {
    const cfg = withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: 'Endpoint=sb://x/;SharedAccessKey=k',
        [SERVICE_BUS_NAMESPACE_ENV]: 'x.servicebus.windows.net',
        [SERVICE_BUS_DISPATCH_QUEUE_ENV]: undefined,
      },
      () => resolveDispatchConsumerBootConfig(),
    );
    expect(cfg).toEqual({
      kind: 'connection-string',
      connectionString: 'Endpoint=sb://x/;SharedAccessKey=k',
      queueName: DEFAULT_DISPATCH_QUEUE_NAME,
    });
  });

  test('namespace only → managed-identity; honors SERVICE_BUS_DISPATCH_QUEUE override', () => {
    const cfg = withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: undefined,
        [SERVICE_BUS_NAMESPACE_ENV]: 'x.servicebus.windows.net',
        [SERVICE_BUS_DISPATCH_QUEUE_ENV]: 'custom-dispatch',
      },
      () => resolveDispatchConsumerBootConfig(),
    );
    expect(cfg).toEqual({
      kind: 'managed-identity',
      fullyQualifiedNamespace: 'x.servicebus.windows.net',
      queueName: 'custom-dispatch',
    });
  });
});
