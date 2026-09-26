import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  IDLE_EXIT_MAX,
  IDLE_EXIT_MIN,
  __test,
  parseEnvelopeFromWire,
  resolveIdleExitAfterEmptyPolls,
  resolveMaxBatchSize,
  resolvePollIntervalMs,
  resolveQueueName,
  runAgentConsumerLoop,
} from '../src/consumerLoop.js';
import { type AgentRunMessage, InMemoryAgentRunQueueConsumer } from '../src/queueConsumer.js';
import { ServiceBusAgentRunQueueConsumer } from '../src/serviceBusAgentRunConsumer.js';
import type { AgentRole, ParsedTransitionMessage } from '../src/types.js';

function makeInner(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
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
    receivedAt: new Date('2026-05-30T18:00:00.000Z'),
    ...overrides,
  };
}

function makeEnvelope(
  lockToken: string,
  agent: AgentRole = 'SpecAgent',
  innerOverrides: Partial<ParsedTransitionMessage> = {},
): AgentRunMessage {
  return {
    lockToken,
    agent,
    transitionKey: 'goal:proposed→accepted',
    message: makeInner({ lockToken, deliveryId: `d-${lockToken}`, ...innerOverrides }),
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

describe('env-resolution helpers — shared with validator/mainConsumer.ts', () => {
  test('resolvePollIntervalMs defaults + range checks', () => {
    expect(withEnv({ POLL_INTERVAL_MS: undefined }, resolvePollIntervalMs)).toBe(1000);
    expect(withEnv({ POLL_INTERVAL_MS: '500' }, resolvePollIntervalMs)).toBe(500);
    expect(() => withEnv({ POLL_INTERVAL_MS: '49' }, resolvePollIntervalMs)).toThrow(/not a valid/);
    expect(() => withEnv({ POLL_INTERVAL_MS: '60001' }, resolvePollIntervalMs)).toThrow(
      /not a valid/,
    );
  });

  test('resolveMaxBatchSize defaults + range checks', () => {
    expect(withEnv({ MAX_BATCH_SIZE: undefined }, resolveMaxBatchSize)).toBe(10);
    expect(withEnv({ MAX_BATCH_SIZE: '32' }, resolveMaxBatchSize)).toBe(32);
    expect(() => withEnv({ MAX_BATCH_SIZE: '0' }, resolveMaxBatchSize)).toThrow(/not a valid/);
    expect(() => withEnv({ MAX_BATCH_SIZE: '257' }, resolveMaxBatchSize)).toThrow(/not a valid/);
  });

  test('resolveIdleExitAfterEmptyPolls defaults + range checks', () => {
    expect(
      withEnv({ IDLE_EXIT_AFTER_EMPTY_POLLS: undefined }, resolveIdleExitAfterEmptyPolls),
    ).toBe(5);
    expect(withEnv({ IDLE_EXIT_AFTER_EMPTY_POLLS: '20' }, resolveIdleExitAfterEmptyPolls)).toBe(20);
    expect(() =>
      withEnv(
        { IDLE_EXIT_AFTER_EMPTY_POLLS: String(IDLE_EXIT_MIN - 1) },
        resolveIdleExitAfterEmptyPolls,
      ),
    ).toThrow(/not a valid/);
    expect(() =>
      withEnv(
        { IDLE_EXIT_AFTER_EMPTY_POLLS: String(IDLE_EXIT_MAX + 1) },
        resolveIdleExitAfterEmptyPolls,
      ),
    ).toThrow(/not a valid/);
  });

  test('resolveQueueName returns default when env unset', () => {
    expect(
      withEnv({ AGENT_QUEUE_NAME: undefined }, () => resolveQueueName('agent-runs-spec')),
    ).toBe('agent-runs-spec');
  });

  test('resolveQueueName honors env override (e.g. for ad-hoc per-role swap)', () => {
    expect(
      withEnv({ AGENT_QUEUE_NAME: 'agent-runs-design' }, () => resolveQueueName('agent-runs-spec')),
    ).toBe('agent-runs-design');
  });
});

describe('runAgentConsumerLoop — happy path', () => {
  test('processes a batch, invokes handler with inner message, acks all, exits on abort', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(makeEnvelope('lt-1'));
    consumer.enqueue(makeEnvelope('lt-2'));
    const controller = new AbortController();
    const handler = vi.fn(async () => ({ ok: true as const, result: 'ok' }));

    const loop = runAgentConsumerLoop({
      consumer,
      role: 'SpecAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 50,
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop;

    expect(handler).toHaveBeenCalledTimes(2);
    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['lt-1', 'lt-2']);
    expect(consumer.inflightCount()).toBe(0);
  });

  test('exits immediately when signal is already aborted', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    const controller = new AbortController();
    controller.abort();
    const handler = vi.fn();

    await runAgentConsumerLoop({
      consumer,
      role: 'SpecAgent',
      handler,
      signal: controller.signal,
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('runAgentConsumerLoop — Container Apps Job idle-drain exit', () => {
  test('exits cleanly after N consecutive empty polls', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    const controller = new AbortController();
    const handler = vi.fn();
    const start = Date.now();

    await runAgentConsumerLoop({
      consumer,
      role: 'SpecAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 10,
      idleExitAfterEmptyPolls: 3,
    });

    expect(Date.now() - start).toBeLessThan(500);
    expect(controller.signal.aborted).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('receiving a message resets the empty-poll counter', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    const controller = new AbortController();
    const handler = vi.fn(async () => ({ ok: true as const, result: 'ok' }));

    setTimeout(() => {
      consumer.enqueue(makeEnvelope('lt-late'));
    }, 30);

    await runAgentConsumerLoop({
      consumer,
      role: 'SpecAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 10,
      idleExitAfterEmptyPolls: 5,
    });

    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['lt-late']);
  });
});

describe('runAgentConsumerLoop — handler error ends the execution', () => {
  test('first handler throw → loop RETURNS without further polls (session-order discipline)', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(makeEnvelope('lt-1'));
    consumer.enqueue(makeEnvelope('lt-2'));
    const errors: Array<{ deliveryId: string; message: string }> = [];
    const handler = vi.fn(async () => {
      throw new Error('handler crashed');
    });

    await runAgentConsumerLoop({
      consumer,
      role: 'SpecAgent',
      handler,
      signal: new AbortController().signal,
      pollIntervalMs: 50,
      onError: (deliveryId, err) => errors.push({ deliveryId, message: err.message }),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([{ deliveryId: 'd-lt-1', message: 'handler crashed' }]);
    expect(consumer.ackedMessages()).toHaveLength(0);
    expect(consumer.deadletteredMessages()).toHaveLength(0);
    expect(consumer.inflightCount()).toBe(2);
  });
});

describe('runAgentConsumerLoop — handler typed failure deadletters and continues', () => {
  test('typed failure is NOT a thrown exception → deadletter with reason, next message processes', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(makeEnvelope('lt-1'));
    consumer.enqueue(makeEnvelope('lt-2'));
    let call = 0;
    const handler = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false as const, reason: 'wrong_transition' };
      return { ok: true as const, result: 'ok' };
    });
    const controller = new AbortController();

    const loop = runAgentConsumerLoop({
      consumer,
      role: 'SpecAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop;

    expect(handler).toHaveBeenCalledTimes(2);
    expect(consumer.deadletteredMessages().map((d) => d.message.lockToken)).toEqual(['lt-1']);
    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['lt-2']);
  });
});

describe('runAgentConsumerLoop — defensive role mismatch deadletters', () => {
  test('envelope with wrong agent field is deadlettered with wrong_role reason', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(makeEnvelope('lt-1', 'DesignAgent')); // mis-routed
    const handler = vi.fn(async () => ({ ok: true as const, result: 'ok' }));
    const controller = new AbortController();

    const loop = runAgentConsumerLoop({
      consumer,
      role: 'SpecAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await loop;

    expect(handler).not.toHaveBeenCalled();
    expect(consumer.deadletteredMessages()).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const dl = consumer.deadletteredMessages()[0]!;
    expect(dl.reason).toBe('wrong_role:expected=SpecAgent:got=DesignAgent');
  });
});

describe('parseEnvelopeFromWire — wraps payloadParser + lockToken', () => {
  test('returns AgentRunMessage on success', () => {
    const wire = JSON.stringify({
      agent: 'SpecAgent',
      transition_key: 'goal:proposed→accepted',
      message: {
        lockToken: 'lt-from-wire',
        deliveryId: 'd-1',
        eventType: 'webhook:issues.transitioned',
        kind: 'goal',
        actor: 'human',
        recordType: 'Issue',
        recordId: 'I_kwAOA',
        fromState: 'proposed',
        toState: 'accepted',
        payloadHash: 'aa'.repeat(32),
        receivedAt: '2026-05-30T18:00:00.000Z',
      },
    });
    const result = parseEnvelopeFromWire(wire, 'sb-lock-token');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The wrapper's lockToken (from SB) wins over any lockToken in the
    // wire-format inner message — that's the SB lock, not the validator's.
    expect(result.value.lockToken).toBe('sb-lock-token');
    expect(result.value.agent).toBe('SpecAgent');
    expect(result.value.message.recordId).toBe('I_kwAOA');
  });

  test('forwards parser failure reason', () => {
    const result = parseEnvelopeFromWire('not-json', 'sb-lock-token');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^payload_not_json/);
  });
});

describe('resolveAgentRunConsumer (internal) — env-gated impl selection', () => {
  const { resolveAgentRunConsumer } = __test;

  test('no Service Bus env → InMemoryAgentRunQueueConsumer (preserves CI boot)', () => {
    const consumer = withEnv(
      { SERVICE_BUS_CONNECTION_STRING: undefined, SERVICE_BUS_NAMESPACE: undefined },
      () => resolveAgentRunConsumer('SpecAgent', 'agent-runs-spec'),
    );
    expect(consumer).toBeInstanceOf(InMemoryAgentRunQueueConsumer);
  });

  test('SERVICE_BUS_NAMESPACE set → ServiceBusAgentRunQueueConsumer (managed identity)', () => {
    const consumer = withEnv(
      {
        SERVICE_BUS_CONNECTION_STRING: undefined,
        SERVICE_BUS_NAMESPACE: 'ns.servicebus.windows.net',
      },
      () => resolveAgentRunConsumer('SpecAgent', 'agent-runs-spec'),
    );
    expect(consumer).toBeInstanceOf(ServiceBusAgentRunQueueConsumer);
  });

  test('SERVICE_BUS_CONNECTION_STRING set → ServiceBusAgentRunQueueConsumer', () => {
    const consumer = withEnv(
      {
        SERVICE_BUS_CONNECTION_STRING: 'Endpoint=sb://x/;SharedAccessKeyName=k;SharedAccessKey=s',
        SERVICE_BUS_NAMESPACE: undefined,
      },
      () => resolveAgentRunConsumer('BuildAgent', 'agent-runs-build'),
    );
    expect(consumer).toBeInstanceOf(ServiceBusAgentRunQueueConsumer);
  });
});

describe('processOneEnvelope (internal) — unit-test the per-message branches', () => {
  const { processOneEnvelope } = __test;

  test('handler-ok → ack, continue', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(makeEnvelope('lt-1'));
    const batch = await consumer.receive({ maxMessages: 1 });
    // biome-ignore lint/style/noNonNullAssertion: enqueued one message.
    const envelope = batch[0]!;
    const outcome = await processOneEnvelope(envelope, {
      consumer,
      role: 'SpecAgent',
      handler: async () => ({ ok: true, result: 'ok' }),
      signal: new AbortController().signal,
    });
    expect(outcome).toBe('continue');
    expect(consumer.ackedMessages()).toHaveLength(1);
  });
});
