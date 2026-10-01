import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  type ReceivedMessageLike,
  type ReceiverLike,
  ServiceBusAgentRunQueueConsumer,
  isTransientServiceBusError,
  resolveAgentRunConsumerBootConfig,
} from '../src/serviceBusAgentRunConsumer.js';

// Assert the real SDK path passes maxAutoLockRenewalDurationInMs +
// peekLock to createReceiver. Mock the dynamically-imported SDK module.
const createReceiverSpy = vi.fn(
  (_q: string, _opts?: { receiveMode?: string; maxAutoLockRenewalDurationInMs?: number }) => ({
    receiveMessages: async () => [],
    completeMessage: async () => undefined,
    abandonMessage: async () => undefined,
    deadLetterMessage: async () => undefined,
    close: async () => undefined,
  }),
);
vi.mock('@azure/service-bus', () => ({
  ServiceBusClient: class {
    createReceiver(
      q: string,
      opts?: { receiveMode?: string; maxAutoLockRenewalDurationInMs?: number },
    ) {
      return createReceiverSpy(q, opts);
    }
    async close() {
      return undefined;
    }
  },
}));

// A fake non-session receiver: a scripted queue of receiveMessages() returns,
// plus settle spies. Mirrors the @azure/service-bus ServiceBusReceiver surface
// we use without importing the SDK.
class FakeReceiver implements ReceiverLike {
  completed: ReceivedMessageLike[] = [];
  abandoned: ReceivedMessageLike[] = [];
  deadlettered: Array<{ message: ReceivedMessageLike; reason: string | undefined }> = [];
  closed = false;
  private readonly batches: ReceivedMessageLike[][];

  constructor(batches: ReceivedMessageLike[][]) {
    this.batches = [...batches];
  }

  async receiveMessages(_max: number, _opts?: { maxWaitTimeInMs?: number }) {
    return this.batches.shift() ?? [];
  }
  async completeMessage(message: ReceivedMessageLike): Promise<void> {
    this.completed.push(message);
  }
  async abandonMessage(message: ReceivedMessageLike): Promise<void> {
    this.abandoned.push(message);
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

// Build the exact wire body the orchestrator's serializeMessage emits.
function wireBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: 'SpecAgent',
    transition_key: 'goal:proposed→accepted',
    message: {
      lockToken: 'inner-lt',
      deliveryId: 'd-1',
      eventType: 'webhook:issues.transitioned',
      kind: 'goal',
      actor: 'human',
      recordType: 'Issue',
      recordId: 'I_kwAOA',
      fromState: 'proposed',
      toState: 'accepted',
      payloadHash: createHash('sha256').update('p').digest('hex'),
      receivedAt: '2026-05-30T18:00:00.000Z',
      ...overrides,
    },
  };
}

function sbMessage(body: unknown, lockToken: string | undefined): ReceivedMessageLike {
  return { body, lockToken };
}

describe('ServiceBusAgentRunQueueConsumer — receive → deserialize', () => {
  test('deserializes an object body into an AgentRunMessage (SB lock token wins)', async () => {
    const receiver = new FakeReceiver([
      [sbMessage(wireBody(), 'sb-lock-1'), sbMessage(wireBody(), 'sb-lock-2')],
    ]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });

    const batch = await consumer.receive({ maxMessages: 10 });

    expect(batch).toHaveLength(2);
    expect(batch.map((m) => m.lockToken)).toEqual(['sb-lock-1', 'sb-lock-2']);
    expect(batch[0]?.agent).toBe('SpecAgent');
    expect(batch[0]?.message.recordId).toBe('I_kwAOA');
    // The SB lock token replaces the inner wire lockToken (it is the SB lock).
    expect(batch[0]?.message.lockToken).toBe('inner-lt');
    expect(consumer.inflightCount()).toBe(2);
  });

  test('deserializes a JSON-string body (SDK delivered body as string)', async () => {
    const receiver = new FakeReceiver([[sbMessage(JSON.stringify(wireBody()), 'sb-lock-1')]]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(1);
    expect(batch[0]?.agent).toBe('SpecAgent');
  });

  test('empty queue → receiveMessages returns [] → receive returns [] (no crash)', async () => {
    const receiver = new FakeReceiver([[]]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });
    await expect(consumer.receive({ maxMessages: 10 })).resolves.toEqual([]);
  });

  test('a non-array receiveMessages result is treated as empty (defensive)', async () => {
    const receiver: ReceiverLike = {
      receiveMessages: async () => undefined as unknown as ReceivedMessageLike[],
      completeMessage: async () => undefined,
      abandonMessage: async () => undefined,
      deadLetterMessage: async () => undefined,
      close: async () => undefined,
    };
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });
    await expect(consumer.receive({ maxMessages: 10 })).resolves.toEqual([]);
  });
});

describe('ServiceBusAgentRunQueueConsumer — lock auto-renewal', () => {
  test('real SDK receiver is created with peekLock + maxAutoLockRenewalDurationInMs', async () => {
    createReceiverSpy.mockClear();
    const consumer = new ServiceBusAgentRunQueueConsumer({
      auth: { connectionString: 'Endpoint=sb://x/;SharedAccessKeyName=k;SharedAccessKey=s' },
      queueName: 'agent-runs-spec',
      maxAutoLockRenewalDurationInMs: 1_800_000,
    });
    await consumer.receive({ maxMessages: 1 });
    expect(createReceiverSpy).toHaveBeenCalledWith('agent-runs-spec', {
      receiveMode: 'peekLock',
      maxAutoLockRenewalDurationInMs: 1_800_000,
    });
  });

  test('defaults the renewal window when not configured (30 min)', async () => {
    createReceiverSpy.mockClear();
    const consumer = new ServiceBusAgentRunQueueConsumer({
      auth: { connectionString: 'Endpoint=sb://x/;SharedAccessKeyName=k;SharedAccessKey=s' },
      queueName: 'agent-runs-build',
    });
    await consumer.receive({ maxMessages: 1 });
    expect(createReceiverSpy).toHaveBeenCalledWith('agent-runs-build', {
      receiveMode: 'peekLock',
      maxAutoLockRenewalDurationInMs: 30 * 60 * 1000,
    });
  });
});

describe('isTransientServiceBusError — classification', () => {
  test.each([
    [{ name: 'ServiceBusError', code: 'ServiceBusy' }, true],
    [{ name: 'ServiceBusError', code: 'ServiceTimeout' }, true],
    [{ code: 'MessageLockLost' }, true],
    [{ retryable: true }, true],
    [{ code: 'ECONNRESET' }, true],
    [{ name: 'AbortError' }, true],
    [{ name: 'ServiceBusError', code: 'Unauthorized' }, false],
    [{ code: 'MessageSizeExceeded' }, false],
    ['a string', false],
    [null, false],
  ])('%o → %s', (err, expected) => {
    expect(isTransientServiceBusError(err)).toBe(expected);
  });
});

describe('ServiceBusAgentRunQueueConsumer — transient receive resilience', () => {
  function throwingReceiver(err: unknown): ReceiverLike {
    return {
      receiveMessages: async () => {
        throw err;
      },
      completeMessage: async () => undefined,
      abandonMessage: async () => undefined,
      deadLetterMessage: async () => undefined,
      close: async () => undefined,
    };
  }

  test('transient SB error (ServiceBusy) → empty poll, no crash', async () => {
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => throwingReceiver({ name: 'ServiceBusError', code: 'ServiceBusy' }),
      queueName: 'agent-runs-spec',
    });
    await expect(consumer.receive({ maxMessages: 10 })).resolves.toEqual([]);
  });

  test('retryable-flagged error → empty poll', async () => {
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => throwingReceiver({ retryable: true, message: 'blip' }),
      queueName: 'agent-runs-spec',
    });
    await expect(consumer.receive({ maxMessages: 10 })).resolves.toEqual([]);
  });

  test('socket-layer ECONNRESET → empty poll', async () => {
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => throwingReceiver({ code: 'ECONNRESET' }),
      queueName: 'agent-runs-spec',
    });
    await expect(consumer.receive({ maxMessages: 10 })).resolves.toEqual([]);
  });

  test('non-transient error (auth failure) propagates — a structural fault must surface', async () => {
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () =>
        throwingReceiver({ name: 'ServiceBusError', code: 'Unauthorized', message: 'bad creds' }),
      queueName: 'agent-runs-spec',
    });
    await expect(consumer.receive({ maxMessages: 10 })).rejects.toMatchObject({
      code: 'Unauthorized',
    });
  });
});

describe('ServiceBusAgentRunQueueConsumer — malformed messages deadletter inside receive', () => {
  test('unparseable body is deadlettered with the parser reason and excluded', async () => {
    const receiver = new FakeReceiver([[sbMessage('not-json', 'sb-lock-1')]]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(0);
    expect(receiver.deadlettered).toHaveLength(1);
    expect(receiver.deadlettered[0]?.reason).toMatch(/^payload_not_json/);
    expect(consumer.inflightCount()).toBe(0);
  });

  test('missing lock token is deadlettered (cannot be settled later)', async () => {
    const receiver = new FakeReceiver([[sbMessage(wireBody(), undefined)]]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(0);
    expect(receiver.deadlettered[0]?.reason).toBe('missing_lock_token');
  });

  test('non-serializable body (number) is deadlettered', async () => {
    const receiver = new FakeReceiver([[sbMessage(42, 'sb-lock-1')]]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(0);
    expect(receiver.deadlettered[0]?.reason).toBe('body_not_serializable');
  });

  test('valid and invalid messages in one batch: valid returned, invalid deadlettered', async () => {
    const receiver = new FakeReceiver([
      [sbMessage(wireBody(), 'sb-ok'), sbMessage('not-json', 'sb-bad')],
    ]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch.map((m) => m.lockToken)).toEqual(['sb-ok']);
    expect(receiver.deadlettered.map((d) => d.reason)).toEqual([
      expect.stringMatching(/^payload_not_json/),
    ]);
  });
});

describe('ServiceBusAgentRunQueueConsumer — ack / deadletter settle the exact message', () => {
  test('ack completes the stored raw message and clears inflight', async () => {
    const ok = sbMessage(wireBody(), 'sb-lock-1');
    const receiver = new FakeReceiver([[ok]]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });

    await consumer.receive({ maxMessages: 10 });
    await consumer.ack('sb-lock-1');

    expect(receiver.completed).toEqual([ok]);
    expect(consumer.inflightCount()).toBe(0);
  });

  test('deadletter dead-letters the stored raw message with reason', async () => {
    const ok = sbMessage(wireBody(), 'sb-lock-1');
    const receiver = new FakeReceiver([[ok]]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });

    await consumer.receive({ maxMessages: 10 });
    await consumer.deadletter('sb-lock-1', 'wrong_transition');

    expect(receiver.deadlettered).toEqual([{ message: ok, reason: 'wrong_transition' }]);
    expect(consumer.inflightCount()).toBe(0);
  });

  test('ack/deadletter on an unknown lock token throws', async () => {
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => new FakeReceiver([[]]),
      queueName: 'agent-runs-spec',
    });
    await consumer.receive({ maxMessages: 10 });
    await expect(consumer.ack('nope')).rejects.toThrow(/unknown lock token/);
    await expect(consumer.deadletter('nope', 'r')).rejects.toThrow(/unknown lock token/);
  });
});

describe('ServiceBusAgentRunQueueConsumer — lifecycle', () => {
  test('receiver is constructed once and reused across receive() calls', async () => {
    const receiver = new FakeReceiver([[], []]);
    const factory = vi.fn(() => receiver);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: factory,
      queueName: 'agent-runs-spec',
    });

    await consumer.receive({ maxMessages: 10 });
    await consumer.receive({ maxMessages: 10 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('close() closes the receiver', async () => {
    const receiver = new FakeReceiver([[]]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });
    await consumer.receive({ maxMessages: 10 });
    await consumer.close();
    expect(receiver.closed).toBe(true);
  });

  test('close() abandons unsettled inflight messages for immediate redelivery', async () => {
    // Two messages received; only the first is acked. The loop's end_execution
    // path leaves the second inflight — close() must abandon it (release lock
    // for redelivery) rather than leave it locked until expiry.
    const m1 = sbMessage(wireBody(), 'sb-1');
    const m2 = sbMessage(wireBody(), 'sb-2');
    const receiver = new FakeReceiver([[m1, m2]]);
    const consumer = new ServiceBusAgentRunQueueConsumer({
      receiverFactory: () => receiver,
      queueName: 'agent-runs-spec',
    });
    await consumer.receive({ maxMessages: 10 });
    await consumer.ack('sb-1');
    expect(consumer.inflightCount()).toBe(1);

    await consumer.close();

    expect(receiver.abandoned).toEqual([m2]);
    expect(receiver.completed).toEqual([m1]);
    expect(consumer.inflightCount()).toBe(0);
    expect(receiver.closed).toBe(true);
  });

  test('constructor without receiverFactory or auth throws', () => {
    expect(() => new ServiceBusAgentRunQueueConsumer({ queueName: 'agent-runs-spec' })).toThrow(
      /requires either receiverFactory or auth/,
    );
  });
});

describe('resolveAgentRunConsumerBootConfig — env resolution', () => {
  test('connection string wins over namespace', () => {
    const cfg = resolveAgentRunConsumerBootConfig({
      SERVICE_BUS_CONNECTION_STRING: 'Endpoint=sb://x/;SharedAccessKeyName=k;SharedAccessKey=s',
      SERVICE_BUS_NAMESPACE: 'ns.servicebus.windows.net',
      AGENT_QUEUE_NAME: 'agent-runs-build',
    });
    expect(cfg).toEqual({
      kind: 'connection-string',
      connectionString: 'Endpoint=sb://x/;SharedAccessKeyName=k;SharedAccessKey=s',
      queueName: 'agent-runs-build',
    });
  });

  test('namespace → managed-identity when no connection string', () => {
    const cfg = resolveAgentRunConsumerBootConfig({
      SERVICE_BUS_NAMESPACE: 'ns.servicebus.windows.net',
      AGENT_QUEUE_NAME: 'agent-runs-review',
    });
    expect(cfg).toEqual({
      kind: 'managed-identity',
      fullyQualifiedNamespace: 'ns.servicebus.windows.net',
      queueName: 'agent-runs-review',
    });
  });

  test('neither set → in-memory (preserves dev/CI boot)', () => {
    expect(resolveAgentRunConsumerBootConfig({ AGENT_QUEUE_NAME: 'agent-runs-spec' })).toEqual({
      kind: 'in-memory',
    });
  });

  test('empty-string env vars are treated as unset', () => {
    expect(
      resolveAgentRunConsumerBootConfig({
        SERVICE_BUS_CONNECTION_STRING: '',
        SERVICE_BUS_NAMESPACE: '',
        AGENT_QUEUE_NAME: 'agent-runs-spec',
      }),
    ).toEqual({ kind: 'in-memory' });
  });

  test('missing AGENT_QUEUE_NAME on a Service-Bus boot → queueName undefined (caller supplies default)', () => {
    expect(
      resolveAgentRunConsumerBootConfig({
        SERVICE_BUS_NAMESPACE: 'ns.servicebus.windows.net',
      }),
    ).toEqual({
      kind: 'managed-identity',
      fullyQualifiedNamespace: 'ns.servicebus.windows.net',
      queueName: undefined,
    });
  });
});

describe('ServiceBusAgentRunQueueConsumer — constructor queueName resolution', () => {
  test('throws when no queueName and AGENT_QUEUE_NAME unset', () => {
    const key = 'AGENT_QUEUE_NAME';
    const prev = process.env[key];
    // Computed member access (not a static property) so biome's noDelete is
    // satisfied; mirrors consumerLoop.test.ts's withEnv helper.
    delete process.env[key];
    try {
      expect(
        () =>
          new ServiceBusAgentRunQueueConsumer({ receiverFactory: () => new FakeReceiver([[]]) }),
      ).toThrow(/requires a queueName/);
    } finally {
      if (prev !== undefined) process.env[key] = prev;
    }
  });
});
