// Integration: wire-format JSON → parser → consumer loop → runBuildAgent → ack.

import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { runBuildAgent } from '../src/agents/buildAgent.js';
import { parseEnvelopeFromWire, runAgentConsumerLoop } from '../src/consumerLoop.js';
import { InMemoryAgentRunQueueConsumer } from '../src/queueConsumer.js';
import { StubGitTool } from '../src/tools/gitTool.js';
import { StubIssueTool } from '../src/tools/issueTool.js';
import { StubPullTool } from '../src/tools/pullTool.js';

function makeWirePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent: 'BuildAgent',
    transition_key: 'task:proposed→ready',
    message: {
      lockToken: 'lt-inner',
      deliveryId: '01HZXYZ123456789ABCDEFGHJK',
      eventType: 'webhook:issues.labeled',
      kind: 'task',
      actor: 'human',
      recordType: 'Issue',
      recordKind: 'Task',
      recordId: 'I_kwAOA_task_123456',
      fromState: 'proposed',
      toState: 'ready',
      payloadHash: createHash('sha256').update('p').digest('hex'),
      receivedAt: '2026-05-30T18:00:00.000Z',
      verdict: 'accept',
      ...overrides,
    },
  });
}

describe('mainAgentBuild — wire-format → parser → loop → runBuildAgent → ack', () => {
  test('happy path: enqueued wire envelope is parsed, dispatched to runBuildAgent, acked', async () => {
    const wire = makeWirePayload();
    const parsed = parseEnvelopeFromWire(wire, 'sb-lock-token-1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(parsed.value);

    const issues = new StubIssueTool();
    issues.seedRecord({
      recordId: 'I_kwAOA_task_123456',
      labels: ['kind:task', 'status:ready'],
      body: 'design-ref: I_kwAOA_design_99\n\nTask title here\n\nbody',
    });
    const git = new StubGitTool();
    const pulls = new StubPullTool();
    const handler = vi.fn(async (m: Parameters<typeof runBuildAgent>[0]) =>
      runBuildAgent(m, {
        issues,
        git,
        pulls,
        runId: '01HZXYZ123456789ABCDEFGHJK',
        repo: 'example-org/software-factory',
        model: 'opus-4-7',
      }),
    );

    const controller = new AbortController();
    const loop = runAgentConsumerLoop({
      consumer,
      role: 'BuildAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await loop;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['sb-lock-token-1']);
  });

  test('envelope with empty payloadHash is rejected by parser', () => {
    const wire = makeWirePayload({ payloadHash: '' });
    const parsed = parseEnvelopeFromWire(wire, 'sb-lock-token-bad');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid_payloadHash');
  });
});
