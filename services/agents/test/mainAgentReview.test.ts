// Integration: wire-format JSON → parser → consumer loop → ReviewAgent stub
// handler → ack. ReviewAgent's real runner is held per Idea 0005; for v0 the
// entrypoint dispatches to AGENT_REGISTRY's stub which returns the
// `'ReviewAgent: stub'` envelope so messages ack cleanly. This test confirms
// the entrypoint plumbing is exercisable end-to-end despite the held real
// implementation.

import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { runAgent } from '../src/agentRegistry.js';
import { parseEnvelopeFromWire, runAgentConsumerLoop } from '../src/consumerLoop.js';
import { InMemoryAgentRunQueueConsumer } from '../src/queueConsumer.js';

function makeWirePayload(): string {
  return JSON.stringify({
    agent: 'ReviewAgent',
    transition_key: 'pr:draft→in_review',
    message: {
      lockToken: 'lt-inner',
      deliveryId: '01HZXYZ123456789ABCDEFGHJK',
      eventType: 'webhook:pull_request.ready_for_review',
      kind: 'pr',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordId: 'PR_kwAOA_pr_77',
      fromState: 'draft',
      toState: 'in_review',
      payloadHash: createHash('sha256').update('p').digest('hex'),
      receivedAt: '2026-05-30T18:00:00.000Z',
      verdict: 'accept',
    },
  });
}

describe('mainAgentReview — wire-format → parser → loop → stub handler → ack', () => {
  test('happy path (v0 stub): enqueued envelope is parsed, dispatched, acked', async () => {
    const wire = makeWirePayload();
    const parsed = parseEnvelopeFromWire(wire, 'sb-lock-token-1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(parsed.value);

    const handler = vi.fn(async (m: Parameters<typeof runAgent>[1]) => runAgent('ReviewAgent', m));

    const controller = new AbortController();
    const loop = runAgentConsumerLoop({
      consumer,
      role: 'ReviewAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await loop;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['sb-lock-token-1']);
    // Stub returns { ok: true, result: 'ReviewAgent: stub' } — entrypoint
    // treats it as a normal ack-eligible success per ADR 0011 / Idea 0005
    // hold rationale (mainAgentReview.ts header).
  });
});
