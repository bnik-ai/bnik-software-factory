// Integration: wire-format JSON → parser → consumer loop → runSpecAgent → ack.
// Covers the boot wiring sans process-signal handlers.

import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { runSpecAgent } from '../src/agents/specAgent.js';
import { parseEnvelopeFromWire, runAgentConsumerLoop } from '../src/consumerLoop.js';
import { InMemoryAgentRunQueueConsumer } from '../src/queueConsumer.js';
import { StubIssueTool } from '../src/tools/issueTool.js';

function makeWirePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent: 'SpecAgent',
    transition_key: 'goal:proposed→accepted',
    message: {
      lockToken: 'lt-inner',
      deliveryId: '01HZXYZ123456789ABCDEFGHJK',
      eventType: 'webhook:issues.labeled',
      kind: 'goal',
      actor: 'human',
      recordType: 'Issue',
      recordKind: 'Goal',
      recordId: 'I_kwAOA_goal_42',
      fromState: 'proposed',
      toState: 'accepted',
      payloadHash: createHash('sha256').update('p').digest('hex'),
      receivedAt: '2026-05-30T18:00:00.000Z',
      verdict: 'accept',
      ...overrides,
    },
  });
}

describe('mainAgentSpec — wire-format → parser → loop → runSpecAgent → ack', () => {
  test('happy path: enqueued wire envelope is parsed, dispatched to runSpecAgent, then acked', async () => {
    const wire = makeWirePayload();
    const parsed = parseEnvelopeFromWire(wire, 'sb-lock-token-1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(parsed.value);

    const issues = new StubIssueTool();
    issues.seedRecord({
      recordId: 'I_kwAOA_goal_42',
      labels: ['kind:goal', 'status:accepted'],
      body: 'Goal title here\n\nbody',
    });
    const handler = vi.fn(async (m: Parameters<typeof runSpecAgent>[0]) =>
      runSpecAgent(m, {
        issues,
        runId: '01HZXYZ123456789ABCDEFGHJK',
        repo: 'example-org/software-factory',
      }),
    );

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

    expect(handler).toHaveBeenCalledTimes(1);
    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['sb-lock-token-1']);
    expect(issues.createHistory()).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    expect(issues.createHistory()[0]!.title).toBe('Spec: Goal title here');
  });

  test('malformed wire payload (bad hex) → parseEnvelopeFromWire returns failure', () => {
    const wire = makeWirePayload({ payloadHash: 'zz'.repeat(32) });
    const parsed = parseEnvelopeFromWire(wire, 'sb-lock-token-bad');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid_payloadHash_hex');
  });

  test('non-JSON wire payload → parseEnvelopeFromWire returns payload_not_json', () => {
    const parsed = parseEnvelopeFromWire('not-json-{', 'sb-lock-token-junk');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/^payload_not_json/);
  });

  test('mis-routed envelope (DesignAgent on spec queue) is deadlettered by the loop', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue({
      lockToken: 'lt-misroute',
      agent: 'DesignAgent',
      transitionKey: 'goal:proposed→accepted',
      message: {
        lockToken: 'lt-misroute',
        deliveryId: 'd-misroute',
        eventType: 'webhook:issues.labeled',
        kind: 'goal',
        actor: 'human',
        recordType: 'Issue',
        recordKind: 'Goal',
        recordId: 'I_kwAOA',
        fromState: 'proposed',
        toState: 'accepted',
        payloadHash: createHash('sha256').update('p').digest(),
        receivedAt: new Date('2026-05-30T18:00:00.000Z'),
      },
    });
    const handler = vi.fn();
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
  });
});
