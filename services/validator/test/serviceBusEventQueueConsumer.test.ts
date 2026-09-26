import { describe, expect, test, vi } from 'vitest';
import { InMemoryAuditLedgerWriter } from '../src/auditLedger.js';
import {
  DEFAULT_CONSUME_QUEUE_NAME,
  type ReceivedMessageLike,
  SERVICE_BUS_CONNECTION_STRING_ENV,
  SERVICE_BUS_CONSUME_QUEUE_ENV,
  SERVICE_BUS_NAMESPACE_ENV,
  ServiceBusEventQueueConsumer,
  type SessionReceiverLike,
  isTransientServiceBusError,
  isTransientServiceBusErrorStrict,
  resolveEventQueueConsumerBootConfig,
} from '../src/serviceBusEventQueueConsumer.js';
import { InMemorySubstrateClient } from '../src/substrateClient.js';

describe('isTransientServiceBusError (local consumer-catch predicate)', () => {
  test('treats ServiceTimeout + retryable + busy codes as transient', () => {
    expect(isTransientServiceBusError({ code: 'ServiceTimeout' })).toBe(true);
    expect(isTransientServiceBusError({ retryable: true })).toBe(true);
    expect(isTransientServiceBusError({ code: 'ServiceBusy' })).toBe(true);
    expect(isTransientServiceBusError({ code: 'SessionCannotBeLocked' })).toBe(true);
    expect(isTransientServiceBusError({ name: 'AbortError' })).toBe(true);
  });
  test('does NOT swallow genuine faults', () => {
    expect(isTransientServiceBusError({ code: 'UnauthorizedAccess' })).toBe(false);
    expect(isTransientServiceBusError(new TypeError('bug'))).toBe(false);
    expect(isTransientServiceBusError(null)).toBe(false);
    expect(isTransientServiceBusError('oops')).toBe(false);
  });
});

describe('isTransientServiceBusErrorStrict (process-wide guard predicate)', () => {
  test('matches ONLY a real ServiceBusError with a transient code', () => {
    expect(
      isTransientServiceBusErrorStrict({ name: 'ServiceBusError', code: 'ServiceTimeout' }),
    ).toBe(true);
    expect(
      isTransientServiceBusErrorStrict({ name: 'ServiceBusError', code: 'SessionCannotBeLocked' }),
    ).toBe(true);
    expect(isTransientServiceBusErrorStrict({ name: 'ServiceBusError', retryable: true })).toBe(
      true,
    );
  });
  test('does NOT swallow generic shapes from non-Service-Bus code', () => {
    // The exact masking risk codex flagged: generic retryable / AbortError
    // from unrelated code must still fail-fast at the process level.
    expect(isTransientServiceBusErrorStrict({ retryable: true })).toBe(false);
    expect(isTransientServiceBusErrorStrict({ name: 'AbortError' })).toBe(false);
    expect(isTransientServiceBusErrorStrict({ code: 'ServiceTimeout' })).toBe(false);
    expect(isTransientServiceBusErrorStrict(new TypeError('bug'))).toBe(false);
    // A real ServiceBusError but a non-transient code → still fail-fast.
    expect(
      isTransientServiceBusErrorStrict({ name: 'ServiceBusError', code: 'UnauthorizedAccess' }),
    ).toBe(false);
  });
});

// The labeled-issue resolver reads substrate.getCurrentLabels() and requires
// the just-applied label to still be present (post-event substrate view).
// Seed a substrate that reflects that state so resolution succeeds.
function makeSeededSubstrate(): InMemorySubstrateClient {
  const substrate = new InMemorySubstrateClient();
  substrate.setLabels('I_kwAOA-NodeId', ['kind:goal', 'status:accepted']);
  return substrate;
}

// An `issues.labeled` webhook body that parses + resolves to a transition
// (kind:goal, status:accepted just applied → goal accepted).
function makeLabeledIssueBody(): Record<string, unknown> {
  return {
    action: 'labeled',
    issue: {
      node_id: 'I_kwAOA-NodeId',
      number: 42,
      title: 'A Goal',
      state: 'open',
      labels: [{ name: 'kind:goal' }, { name: 'status:accepted' }],
    },
    label: { name: 'status:accepted' },
    sender: { login: 'example-owner', type: 'User' },
  };
}

// SB body the github-app B1 producer enqueues: { deliveryId, event, payload }.
function makeSbBody(
  overrides: Partial<{ deliveryId: string; event: string; payload: unknown }> = {},
): unknown {
  return {
    deliveryId: overrides.deliveryId ?? 'd-1',
    event: overrides.event ?? 'issues',
    payload: overrides.payload ?? JSON.stringify(makeLabeledIssueBody()),
  };
}

interface FakeReceiver extends SessionReceiverLike {
  completed: ReceivedMessageLike[];
  deadlettered: Array<{ message: ReceivedMessageLike; reason?: string }>;
  closed: number;
}

function makeFakeReceiver(
  messages: ReceivedMessageLike[],
  opts: { receiveThrows?: Error } = {},
): FakeReceiver {
  const receiver: FakeReceiver = {
    completed: [],
    deadlettered: [],
    closed: 0,
    async receiveMessages() {
      if (opts.receiveThrows !== undefined) throw opts.receiveThrows;
      return messages;
    },
    async completeMessage(message) {
      receiver.completed.push(message);
    },
    async deadLetterMessage(message, options) {
      receiver.deadlettered.push({ message, reason: options?.deadLetterReason });
    },
    async close() {
      receiver.closed += 1;
    },
  };
  return receiver;
}

describe('ServiceBusEventQueueConsumer — receive → parse → ack', () => {
  test('parses SB body, stitches lockToken, returns ParsedTransitionMessage', async () => {
    const sbMessage: ReceivedMessageLike = { body: makeSbBody(), lockToken: 'lt-1' };
    const receiver = makeFakeReceiver([sbMessage]);
    const consumer = new ServiceBusEventQueueConsumer({
      receiverFactory: async () => receiver,
      substrate: makeSeededSubstrate(),
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(1);
    expect(batch[0]?.lockToken).toBe('lt-1');
    expect(batch[0]?.deliveryId).toBe('d-1');
    expect(batch[0]?.recordId).toBe('I_kwAOA-NodeId');
    expect(batch[0]?.toState).toBe('accepted');
    // Receiver stays open while the message is inflight.
    expect(consumer.inflightCount()).toBe(1);
    expect(receiver.closed).toBe(0);
  });

  test('ack completes the stored SB message and closes the session receiver', async () => {
    const sbMessage: ReceivedMessageLike = { body: makeSbBody(), lockToken: 'lt-1' };
    const receiver = makeFakeReceiver([sbMessage]);
    const consumer = new ServiceBusEventQueueConsumer({
      receiverFactory: async () => receiver,
      substrate: makeSeededSubstrate(),
    });

    await consumer.receive({ maxMessages: 10 });
    await consumer.ack('lt-1');

    expect(receiver.completed).toEqual([sbMessage]);
    expect(consumer.inflightCount()).toBe(0);
    expect(receiver.closed).toBe(1); // session released after last message settled
  });

  test('deadletter dead-letters the stored SB message with the reason + closes', async () => {
    const sbMessage: ReceivedMessageLike = { body: makeSbBody(), lockToken: 'lt-9' };
    const receiver = makeFakeReceiver([sbMessage]);
    const consumer = new ServiceBusEventQueueConsumer({
      receiverFactory: async () => receiver,
      substrate: makeSeededSubstrate(),
    });

    await consumer.receive({ maxMessages: 10 });
    await consumer.deadletter('lt-9', 'fsm_rejected');

    expect(receiver.deadlettered).toHaveLength(1);
    expect(receiver.deadlettered[0]?.reason).toBe('fsm_rejected');
    expect(receiver.closed).toBe(1);
  });

  test('unparseable payload is dead-lettered inside receive() and excluded from the batch', async () => {
    const bad: ReceivedMessageLike = {
      body: makeSbBody({ payload: 'not-json{' }),
      lockToken: 'lt-bad',
    };
    const receiver = makeFakeReceiver([bad]);
    const consumer = new ServiceBusEventQueueConsumer({ receiverFactory: async () => receiver });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(0);
    expect(receiver.deadlettered[0]?.reason).toBe('unparseable_or_unresolvable');
    // No inflight work → receiver closed in finally.
    expect(receiver.closed).toBe(1);
  });

  test('missing lockToken is dead-lettered and excluded', async () => {
    const noToken: ReceivedMessageLike = { body: makeSbBody(), lockToken: undefined };
    const receiver = makeFakeReceiver([noToken]);
    const consumer = new ServiceBusEventQueueConsumer({ receiverFactory: async () => receiver });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(0);
    expect(receiver.deadlettered[0]?.reason).toBe('missing_lock_token');
    expect(receiver.closed).toBe(1);
  });

  test('null receiver (no session available) → empty batch, no throw', async () => {
    const consumer = new ServiceBusEventQueueConsumer({ receiverFactory: async () => null });
    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(0);
  });

  test('CRITICAL: session receiver is close()d in finally when receiveMessages throws', async () => {
    const receiver = makeFakeReceiver([], { receiveThrows: new Error('boom') });
    const consumer = new ServiceBusEventQueueConsumer({ receiverFactory: async () => receiver });

    await expect(consumer.receive({ maxMessages: 10 })).rejects.toThrow('boom');
    expect(receiver.closed).toBe(1); // lock released despite the error
  });

  test('issue #183: a BENIGN dependabot[bot] event (issues.assigned, inert) settles observationally — completeMessage, NOT dead-lettered (no validator-events DLQ noise)', async () => {
    const body = makeLabeledIssueBody();
    body.action = 'assigned';
    (body.sender as unknown) = { login: 'dependabot[bot]', type: 'Bot' };
    const sbMessage: ReceivedMessageLike = {
      body: makeSbBody({ payload: JSON.stringify(body) }),
      lockToken: 'lt-dependabot',
    };
    const receiver = makeFakeReceiver([sbMessage]);
    const consumer = new ServiceBusEventQueueConsumer({
      receiverFactory: async () => receiver,
      substrate: makeSeededSubstrate(),
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    // No transition produced for the caller.
    expect(batch).toHaveLength(0);
    // Settled cleanly, NOT dead-lettered.
    expect(receiver.completed).toEqual([sbMessage]);
    expect(receiver.deadlettered).toHaveLength(0);
  });

  test('issue #183 (codex P2): a non-App bot applying a status:* label (dependabot[bot] labeled status:accepted) is DEAD-LETTERED, not silently settled — untrusted substrate-state mutation stays visible', async () => {
    const body = makeLabeledIssueBody(); // action: 'labeled', label status:accepted
    (body.sender as unknown) = { login: 'dependabot[bot]', type: 'Bot' };
    const sbMessage: ReceivedMessageLike = {
      body: makeSbBody({ payload: JSON.stringify(body) }),
      lockToken: 'lt-dependabot-mutation',
    };
    const receiver = makeFakeReceiver([sbMessage]);
    const consumer = new ServiceBusEventQueueConsumer({
      receiverFactory: async () => receiver,
      substrate: makeSeededSubstrate(),
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(0);
    // VISIBLE: dead-lettered, NOT completed.
    expect(receiver.deadlettered).toHaveLength(1);
    expect(receiver.deadlettered[0]?.message).toEqual(sbMessage);
    expect(receiver.completed).toHaveLength(0);
  });

  test('feeds the injected ledgerReader so fromState resolves from committed rows', async () => {
    // Seed a prior committed transition for the record; the resolver should
    // use it as fromState rather than __initial__.
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'prior',
      eventType: 'issues',
      actor: 'human',
      recordType: 'Issue',
      recordKind: 'Goal',
      recordId: 'I_kwAOA-NodeId',
      fromState: '__initial__',
      toState: 'proposed',
      verdict: 'accept',
      payloadHash: Buffer.alloc(32),
      receivedAt: new Date(),
    });
    const sbMessage: ReceivedMessageLike = { body: makeSbBody(), lockToken: 'lt-1' };
    const consumer = new ServiceBusEventQueueConsumer({
      receiverFactory: async () => makeFakeReceiver([sbMessage]),
      ledgerReader: ledger,
      substrate: makeSeededSubstrate(),
    });
    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch[0]?.fromState).toBe('proposed');
  });

  test('redelivery replays the ALREADY-RECORDED transition (no re-resolution drift)', async () => {
    // Seed a committed row for this delivery whose recorded toState differs
    // from what a fresh resolve would produce — proving the consumer replays
    // the recorded row rather than re-resolving. An empty substrate would make
    // a fresh resolve dead-letter; replay must still succeed.
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-1', // same deliveryId the SB body carries
      eventType: 'issues',
      actor: 'human',
      recordType: 'Issue',
      recordKind: 'Goal',
      recordId: 'I_kwAOA-NodeId',
      fromState: 'proposed',
      toState: 'accepted',
      verdict: 'accept',
      payloadHash: Buffer.alloc(32, 9),
      receivedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const sbMessage: ReceivedMessageLike = { body: makeSbBody(), lockToken: 'lt-redeliver' };
    const consumer = new ServiceBusEventQueueConsumer({
      receiverFactory: async () => makeFakeReceiver([sbMessage]),
      ledgerReader: ledger,
      // Deliberately EMPTY substrate: a fresh resolve would dead-letter;
      // replay from the recorded row must not.
      substrate: new InMemorySubstrateClient(),
    });
    const batch = await consumer.receive({ maxMessages: 10 });
    expect(batch).toHaveLength(1);
    expect(batch[0]?.lockToken).toBe('lt-redeliver');
    expect(batch[0]?.fromState).toBe('proposed');
    expect(batch[0]?.toState).toBe('accepted');
    expect(batch[0]?.payloadHash.equals(Buffer.alloc(32, 9))).toBe(true);
  });

  test('M2: a transient substrate throw is contained (no crash) and leaves the message UNSETTLED for redelivery (codex #139 [P1])', async () => {
    // A labeled-issue body carrying an installation id routes through the
    // substrateFactory. A throwing factory simulates a GitHub 500 / token
    // mint failure. receive() must NOT propagate the throw (which would
    // reject the whole consumer loop), and must NOT deadletter (one-way to
    // DLQ) — the message is left unsettled so SB redelivers it.
    const body = makeLabeledIssueBody();
    (body.installation as unknown) = { id: 555 };
    const sbMessage: ReceivedMessageLike = {
      body: makeSbBody({ payload: JSON.stringify(body) }),
      lockToken: 'lt-transient',
    };
    const receiver = makeFakeReceiver([sbMessage]);
    const consumer = new ServiceBusEventQueueConsumer({
      receiverFactory: async () => receiver,
      // Boot substrate is the seeded in-memory one; the factory is what the
      // installationId-carrying delivery routes to, and it throws.
      substrate: makeSeededSubstrate(),
      substrateFactory: () => ({
        async getCurrentLabels() {
          throw new Error('graphql_http_500:I_kwAOA-NodeId');
        },
        async getIssue() {
          throw new Error('unused');
        },
        async getReviewsForPr() {
          return [];
        },
        async getPullRequest() {
          return undefined;
        },
        async getStructuralMarkers() {
          return undefined;
        },
      }),
    });

    const batch = await consumer.receive({ maxMessages: 10 });
    // Contained: empty batch, no throw.
    expect(batch).toHaveLength(0);
    // NOT deadlettered — left unsettled for SB redelivery.
    expect(receiver.deadlettered).toHaveLength(0);
    expect(consumer.inflightCount()).toBe(0);
    // Session receiver released (no inflight work to settle on it).
    expect(receiver.closed).toBe(1);
  });

  test('constructor throws when neither receiverFactory nor auth supplied', () => {
    expect(() => new ServiceBusEventQueueConsumer({})).toThrow(/receiverFactory or auth/);
  });

  test('close() is safe with no SB client created (receiverFactory seam path)', async () => {
    const consumer = new ServiceBusEventQueueConsumer({ receiverFactory: async () => null });
    await expect(consumer.close()).resolves.toBeUndefined();
  });

  test('a single ServiceBusClient is created and reused across receive() polls (auth path)', async () => {
    // The consumer dynamically imports @azure/service-bus inside the auth-path
    // receiverFactory, so vi.doMock before the first receive() is picked up
    // without re-importing the consumer module.
    let constructed = 0;
    let closed = 0;
    vi.doMock('@azure/service-bus', () => ({
      ServiceBusClient: class {
        constructor() {
          constructed += 1;
        }
        async acceptNextSession() {
          // No session available → null (empty poll). Exercises the client
          // cache without needing a real receiver.
          throw Object.assign(new Error('timeout'), { name: 'AbortError' });
        }
        async close() {
          closed += 1;
        }
      },
    }));
    const consumer = new ServiceBusEventQueueConsumer({
      auth: { fullyQualifiedNamespace: 'ns.servicebus.windows.net', credential: {} },
      sessionWaitMs: 5,
    });
    await consumer.receive({ maxMessages: 1 });
    await consumer.receive({ maxMessages: 1 });
    await consumer.receive({ maxMessages: 1 });
    expect(constructed).toBe(1); // one client across three polls (no per-poll leak)
    await consumer.close();
    expect(closed).toBe(1);
    vi.doUnmock('@azure/service-bus');
  });
});

describe('resolveEventQueueConsumerBootConfig — env-driven', () => {
  function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const originals: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      originals[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test('no env → in-memory', () => {
    withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: undefined,
        [SERVICE_BUS_NAMESPACE_ENV]: undefined,
        [SERVICE_BUS_CONSUME_QUEUE_ENV]: undefined,
      },
      () => {
        expect(resolveEventQueueConsumerBootConfig()).toEqual({ kind: 'in-memory' });
      },
    );
  });

  test('SERVICE_BUS_NAMESPACE → managed-identity with default queue', () => {
    withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: undefined,
        [SERVICE_BUS_NAMESPACE_ENV]: 'sfac-dev-region-sb-main.servicebus.windows.net',
        [SERVICE_BUS_CONSUME_QUEUE_ENV]: undefined,
      },
      () => {
        const r = resolveEventQueueConsumerBootConfig();
        expect(r.kind).toBe('managed-identity');
        if (r.kind === 'managed-identity') {
          expect(r.queueName).toBe(DEFAULT_CONSUME_QUEUE_NAME);
        }
      },
    );
  });

  test('connection-string precedence + queue override', () => {
    withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: 'Endpoint=sb://x.servicebus.windows.net/;...',
        [SERVICE_BUS_NAMESPACE_ENV]: 'ignored.servicebus.windows.net',
        [SERVICE_BUS_CONSUME_QUEUE_ENV]: 'custom-q',
      },
      () => {
        const r = resolveEventQueueConsumerBootConfig();
        expect(r.kind).toBe('connection-string');
        if (r.kind === 'connection-string') expect(r.queueName).toBe('custom-q');
      },
    );
  });
});
