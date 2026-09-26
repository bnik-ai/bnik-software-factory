// Integration: wire-format JSON → parser → consumer loop → runDesignAgent → ack.

import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { runDesignAgent } from '../src/agents/designAgent.js';
import { parseEnvelopeFromWire, runAgentConsumerLoop } from '../src/consumerLoop.js';
import { InMemoryAgentRunQueueConsumer } from '../src/queueConsumer.js';
import { StubIssueTool } from '../src/tools/issueTool.js';

function makeWirePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent: 'DesignAgent',
    transition_key: 'spec:ready_for_review→ratified',
    message: {
      lockToken: 'lt-inner',
      deliveryId: '01HZXYZ123456789ABCDEFGHJK',
      eventType: 'webhook:issues.labeled',
      kind: 'spec',
      actor: 'human',
      recordType: 'Issue',
      recordKind: 'Spec',
      recordId: 'I_kwAOA_spec_99',
      fromState: 'ready_for_review',
      toState: 'ratified',
      payloadHash: createHash('sha256').update('p').digest('hex'),
      receivedAt: '2026-05-30T18:00:00.000Z',
      verdict: 'accept',
      ...overrides,
    },
  });
}

describe('mainAgentDesign — wire-format → parser → loop → runDesignAgent → ack', () => {
  test('happy path: enqueued wire envelope is parsed, dispatched to runDesignAgent, acked', async () => {
    const wire = makeWirePayload();
    const parsed = parseEnvelopeFromWire(wire, 'sb-lock-token-1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(parsed.value);

    const issues = new StubIssueTool();
    issues.seedRecord({
      recordId: 'I_kwAOA_spec_99',
      labels: ['kind:spec', 'status:ratified'],
      body: 'parent-goal: I_kwAOA_goal_42\n\nSpec title here\n\nbody',
    });
    const handler = vi.fn(async (m: Parameters<typeof runDesignAgent>[0]) =>
      runDesignAgent(m, {
        issues,
        runId: '01HZXYZ123456789ABCDEFGHJK',
        repo: 'example-org/software-factory',
      }),
    );

    const controller = new AbortController();
    const loop = runAgentConsumerLoop({
      consumer,
      role: 'DesignAgent',
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
    expect(issues.createHistory()[0]!.title).toBe('Design: Spec title here');
  });

  test('wire payload with non-ISO receivedAt is rejected by parser', () => {
    const wire = makeWirePayload({ receivedAt: 'yesterday' });
    const parsed = parseEnvelopeFromWire(wire, 'sb-lock-token-bad');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/^invalid_receivedAt_iso/);
  });
});
