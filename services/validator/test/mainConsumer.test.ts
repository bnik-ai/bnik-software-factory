import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { InMemoryAuditLedgerWriter } from '../src/auditLedger.js';
import { evaluateTransition } from '../src/dispatcher.js';
import { __test, runConsumerLoop } from '../src/mainConsumer.js';
import { InMemoryOutgoingPublisher } from '../src/outgoingPublisher.js';
import { PostgresAuditLedgerWriter } from '../src/postgresAuditLedgerWriter.js';
import { InMemoryEventQueueConsumer, type ParsedTransitionMessage } from '../src/queueConsumer.js';
import { ServiceBusEventQueueConsumer } from '../src/serviceBusEventQueueConsumer.js';
import { InMemorySubstrateClient } from '../src/substrateClient.js';

const {
  resolvePollIntervalMs,
  resolveMaxBatchSize,
  resolveIdleExitAfterEmptyPolls,
  resolveAuditLedgerFromEnv,
  resolveEventQueueConsumerFromEnv,
} = __test;

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

describe('resolvePollIntervalMs', () => {
  test('returns default 1000 when unset', () => {
    expect(withEnv({ POLL_INTERVAL_MS: undefined }, resolvePollIntervalMs)).toBe(1000);
  });

  test('returns the parsed integer when valid', () => {
    expect(withEnv({ POLL_INTERVAL_MS: '500' }, resolvePollIntervalMs)).toBe(500);
  });

  test('throws on non-integer (trailing junk via Number, not parseInt)', () => {
    expect(() => withEnv({ POLL_INTERVAL_MS: '500abc' }, resolvePollIntervalMs)).toThrow(
      /not a valid/,
    );
  });

  test('throws below the min (50) and above the max (60000)', () => {
    expect(() => withEnv({ POLL_INTERVAL_MS: '49' }, resolvePollIntervalMs)).toThrow(/not a valid/);
    expect(() => withEnv({ POLL_INTERVAL_MS: '60001' }, resolvePollIntervalMs)).toThrow(
      /not a valid/,
    );
  });
});

describe('resolveMaxBatchSize', () => {
  test('returns default 10 when unset', () => {
    expect(withEnv({ MAX_BATCH_SIZE: undefined }, resolveMaxBatchSize)).toBe(10);
  });

  test('returns the parsed integer when valid', () => {
    expect(withEnv({ MAX_BATCH_SIZE: '32' }, resolveMaxBatchSize)).toBe(32);
  });

  test('throws below the min (1) and above the max (256)', () => {
    expect(() => withEnv({ MAX_BATCH_SIZE: '0' }, resolveMaxBatchSize)).toThrow(/not a valid/);
    expect(() => withEnv({ MAX_BATCH_SIZE: '257' }, resolveMaxBatchSize)).toThrow(/not a valid/);
  });
});

describe('resolveIdleExitAfterEmptyPolls', () => {
  test('returns default 5 when unset', () => {
    expect(
      withEnv({ IDLE_EXIT_AFTER_EMPTY_POLLS: undefined }, resolveIdleExitAfterEmptyPolls),
    ).toBe(5);
  });

  test('returns the parsed integer when valid', () => {
    expect(withEnv({ IDLE_EXIT_AFTER_EMPTY_POLLS: '20' }, resolveIdleExitAfterEmptyPolls)).toBe(20);
  });

  test('throws below the min (1) and above the max (60)', () => {
    expect(() =>
      withEnv({ IDLE_EXIT_AFTER_EMPTY_POLLS: '0' }, resolveIdleExitAfterEmptyPolls),
    ).toThrow(/not a valid/);
    expect(() =>
      withEnv({ IDLE_EXIT_AFTER_EMPTY_POLLS: '61' }, resolveIdleExitAfterEmptyPolls),
    ).toThrow(/not a valid/);
  });
});

describe('resolveAuditLedgerFromEnv — env-driven backend selection', () => {
  test('no POSTGRES_HOST → InMemoryAuditLedgerWriter', () => {
    const ledger = withEnv({ POSTGRES_HOST: undefined }, resolveAuditLedgerFromEnv);
    expect(ledger).toBeInstanceOf(InMemoryAuditLedgerWriter);
  });

  test('POSTGRES_HOST set → PostgresAuditLedgerWriter (lazy pool, no connection)', () => {
    const ledger = withEnv(
      {
        POSTGRES_HOST: 'sfac-dev-region-pg-main.postgres.database.azure.com',
        POSTGRES_USER: 'sfac-dev-region-id-main',
        POSTGRES_DATABASE: 'software_factory',
      },
      resolveAuditLedgerFromEnv,
    );
    expect(ledger).toBeInstanceOf(PostgresAuditLedgerWriter);
  });
});

describe('resolveEventQueueConsumerFromEnv — env-driven backend selection', () => {
  const reader = new InMemoryAuditLedgerWriter();
  const substrate = new InMemorySubstrateClient();

  test('no SB env → InMemoryEventQueueConsumer', () => {
    const consumer = withEnv(
      { SERVICE_BUS_NAMESPACE: undefined, SERVICE_BUS_CONNECTION_STRING: undefined },
      () => resolveEventQueueConsumerFromEnv(reader, substrate),
    );
    expect(consumer).toBeInstanceOf(InMemoryEventQueueConsumer);
  });

  test('SERVICE_BUS_NAMESPACE set → ServiceBusEventQueueConsumer', () => {
    const consumer = withEnv(
      {
        SERVICE_BUS_NAMESPACE: 'sfac-dev-region-sb-main.servicebus.windows.net',
        SERVICE_BUS_CONNECTION_STRING: undefined,
      },
      () => resolveEventQueueConsumerFromEnv(reader, substrate),
    );
    expect(consumer).toBeInstanceOf(ServiceBusEventQueueConsumer);
  });
});

describe('runConsumerLoop — publishes downstream after ledger append, before ack', () => {
  test('successful messages get published to downstream queue with verdict populated', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const ledger = new InMemoryAuditLedgerWriter();
    const publisher = new InMemoryOutgoingPublisher();
    consumer.enqueue(makeMessage({ lockToken: 'lt-1', deliveryId: 'd-1' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-2', deliveryId: 'd-2' }));
    const controller = new AbortController();

    const loop = runConsumerLoop({
      consumer,
      ledger,
      dispatcher: evaluateTransition,
      publisher,
      signal: controller.signal,
      pollIntervalMs: 50,
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop;

    expect(publisher.publishCount()).toBe(2);
    expect(publisher.publishedMessages().map((m) => m.message.deliveryId)).toEqual(['d-1', 'd-2']);
    // Verdict was populated from the FSM evaluation (default: accept for the
    // goal:proposed→accepted transition in makeMessage).
    expect(publisher.publishedMessages().every((m) => m.message.verdict === 'accept')).toBe(true);
  });

  test('publish failure aborts the loop without acking the inbound message', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const ledger = new InMemoryAuditLedgerWriter();
    const failingPublisher = {
      publish: vi.fn(async () => {
        throw new Error('publish to agent-runs-dispatch failed');
      }),
    };
    consumer.enqueue(makeMessage({ lockToken: 'lt-1', deliveryId: 'd-1' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-2', deliveryId: 'd-2' }));
    const errors: string[] = [];

    await runConsumerLoop({
      consumer,
      ledger,
      dispatcher: evaluateTransition,
      publisher: failingPublisher,
      signal: new AbortController().signal,
      pollIntervalMs: 50,
      onError: (deliveryId) => errors.push(deliveryId),
    });

    // Ledger row was written for d-1 (publish failure is post-ledger).
    expect(ledger.size()).toBe(1);
    // But d-1 was NEVER acked — the publish failure aborted the loop before ack.
    expect(consumer.ackedMessages()).toHaveLength(0);
    // Both messages still locked (not deadlettered — publish failure is
    // transient, SB redelivery should retry).
    expect(consumer.inflightCount()).toBe(2);
    expect(errors).toEqual(['d-1']);
  });
});

describe('runConsumerLoop — happy path', () => {
  test('processes a batch and acks all messages, then exits when signal aborts', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const ledger = new InMemoryAuditLedgerWriter();
    consumer.enqueue(makeMessage({ lockToken: 'lt-1', deliveryId: 'd-1' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-2', deliveryId: 'd-2' }));
    const controller = new AbortController();

    const loop = runConsumerLoop({
      consumer,
      ledger,
      dispatcher: evaluateTransition,
      publisher: new InMemoryOutgoingPublisher(),
      signal: controller.signal,
      pollIntervalMs: 50,
    });

    // Give the loop a tick to drain the batch.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop;

    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['lt-1', 'lt-2']);
    expect(consumer.inflightCount()).toBe(0);
    expect(ledger.size()).toBe(2);
  });

  test('exits immediately when signal is already aborted', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const ledger = new InMemoryAuditLedgerWriter();
    const controller = new AbortController();
    controller.abort();

    await runConsumerLoop({
      consumer,
      ledger,
      dispatcher: evaluateTransition,
      publisher: new InMemoryOutgoingPublisher(),
      signal: controller.signal,
    });

    expect(consumer.ackedMessages()).toHaveLength(0);
  });
});

describe('runConsumerLoop — Container Apps Job idle-drain exit', () => {
  test('exits cleanly after N consecutive empty polls', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const ledger = new InMemoryAuditLedgerWriter();
    const controller = new AbortController();
    const start = Date.now();

    await runConsumerLoop({
      consumer,
      ledger,
      dispatcher: evaluateTransition,
      publisher: new InMemoryOutgoingPublisher(),
      signal: controller.signal,
      pollIntervalMs: 10,
      idleExitAfterEmptyPolls: 3,
    });

    expect(Date.now() - start).toBeLessThan(500);
    expect(controller.signal.aborted).toBe(false);
  });

  test('receiving a message resets the empty-poll counter', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const ledger = new InMemoryAuditLedgerWriter();
    const controller = new AbortController();

    // Enqueue one message after a delay; the loop should see empty polls,
    // then process the message and reset the counter, then drain again.
    setTimeout(() => {
      consumer.enqueue(makeMessage({ lockToken: 'lt-late', deliveryId: 'd-late' }));
    }, 30);

    await runConsumerLoop({
      consumer,
      ledger,
      dispatcher: evaluateTransition,
      publisher: new InMemoryOutgoingPublisher(),
      signal: controller.signal,
      pollIntervalMs: 10,
      idleExitAfterEmptyPolls: 5,
    });

    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['lt-late']);
  });
});

describe('runConsumerLoop — error handling ends the execution', () => {
  test('first message error → loop RETURNS (job execution ends) without further polls', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const failingLedger = {
      append: vi.fn(async () => {
        throw new Error('ledger is down');
      }),
    };
    consumer.enqueue(makeMessage({ lockToken: 'lt-1', deliveryId: 'd-1' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-2', deliveryId: 'd-2' }));
    const errors: Array<{ deliveryId: string; message: string }> = [];

    // No signal.abort needed — the loop must return on its own after the
    // first error. If it doesn't, this test would hang on `await loop`.
    await runConsumerLoop({
      consumer,
      ledger: failingLedger,
      dispatcher: evaluateTransition,
      publisher: new InMemoryOutgoingPublisher(),
      signal: new AbortController().signal,
      pollIntervalMs: 50,
      onError: (deliveryId, err) => errors.push({ deliveryId, message: err.message }),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.deliveryId).toBe('d-1');
    expect(consumer.ackedMessages()).toHaveLength(0);
    expect(consumer.deadletteredMessages()).toHaveLength(0);
    expect(consumer.inflightCount()).toBe(2);
  });

  test('middle message error → first ack succeeds, third never processed, loop returns', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const realLedger = new InMemoryAuditLedgerWriter();
    let calls = 0;
    const sometimesFailingLedger = {
      append: async (args: Parameters<typeof realLedger.append>[0]) => {
        calls += 1;
        if (calls === 2) throw new Error('transient ledger glitch');
        return realLedger.append(args);
      },
    };
    consumer.enqueue(makeMessage({ lockToken: 'lt-1', deliveryId: 'd-1' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-2', deliveryId: 'd-2' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-3', deliveryId: 'd-3' }));
    const errors: string[] = [];

    await runConsumerLoop({
      consumer,
      ledger: sometimesFailingLedger,
      dispatcher: evaluateTransition,
      publisher: new InMemoryOutgoingPublisher(),
      signal: new AbortController().signal,
      pollIntervalMs: 50,
      onError: (deliveryId) => errors.push(deliveryId),
    });

    expect(consumer.ackedMessages().map((m) => m.deliveryId)).toEqual(['d-1']);
    expect(errors).toEqual(['d-2']);
    expect(consumer.inflightCount()).toBe(2);
    expect(realLedger.size()).toBe(1);
  });
});
