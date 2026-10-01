// Integration: wire-format JSON → parser → consumer loop → runPlannerAgent
// → ack. Mirrors mainAgentSpec.test.ts / mainAgentBuild.test.ts / etc.
// Confirms the entrypoint plumbing is end-to-end exercisable and that the
// stamp uses a ULID (DO NOT use message.deliveryId).

import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { runPlannerAgent } from '../src/agents/plannerAgent.js';
import { parseEnvelopeFromWire, runAgentConsumerLoop } from '../src/consumerLoop.js';
import { InMemoryAgentRunQueueConsumer } from '../src/queueConsumer.js';
import { ULID_REGEX, mintRunId } from '../src/runId.js';
import { StubPlannerSubstrateClient } from '../src/tools/plannerSubstrateClient.js';

function makeWirePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent: 'PlannerAgent',
    transition_key: 'task:in_review→done',
    message: {
      lockToken: 'lt-inner',
      deliveryId: 'd-inner',
      eventType: 'webhook:issues.labeled',
      kind: 'task',
      actor: 'OpsAgent',
      recordType: 'Issue',
      recordKind: 'Task',
      recordId: 'I_kwAOA_task_done_99',
      fromState: 'in_review',
      toState: 'done',
      payloadHash: createHash('sha256').update('p').digest('hex'),
      receivedAt: '2026-05-30T18:00:00.000Z',
      verdict: 'accept',
      ...overrides,
    },
  });
}

describe('mainAgentPlanner — wire-format → parser → loop → runPlannerAgent → ack', () => {
  test('happy path: enqueued wire envelope is parsed, dispatched to runPlannerAgent, then acked', async () => {
    const wire = makeWirePayload();
    const parsed = parseEnvelopeFromWire(wire, 'sb-lock-token-1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(parsed.value);

    const substrate = new StubPlannerSubstrateClient();
    substrate.seedTask({
      recordId: 'I_kwAOA_task_p1',
      state: 'proposed',
      priority: 'P1',
      blockedBy: [],
      createdAt: '2026-05-30T10:00:00Z',
    });

    // Mint a fresh ULID here exactly as the entrypoint does — proves the
    // boot path's stamp parses against the validator's ULID_RE
    // (deliveryId is NOT ULID-shaped).
    const runId = mintRunId();
    expect(ULID_REGEX.test(runId)).toBe(true);

    const handler = vi.fn(async (m: Parameters<typeof runPlannerAgent>[0]) =>
      runPlannerAgent(m, {
        substrate,
        runId,
        repo: 'example-org/software-factory',
      }),
    );

    const controller = new AbortController();
    const loop = runAgentConsumerLoop({
      consumer,
      role: 'PlannerAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await loop;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['sb-lock-token-1']);
    // Substrate write side: the cleared P1 Task promoted to ready under
    // PlannerAgent attribution.
    expect(substrate.transitionHistory()).toHaveLength(1);
    expect(substrate.transitionHistory()[0]?.taskId).toBe('I_kwAOA_task_p1');
    expect(substrate.transitionHistory()[0]?.actor).toBe('PlannerAgent');
  });

  test('mis-routed envelope (BuildAgent on planner queue) is deadlettered by the loop', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue({
      lockToken: 'lt-misroute',
      agent: 'BuildAgent',
      transitionKey: 'task:proposed→ready',
      message: {
        lockToken: 'lt-misroute',
        deliveryId: 'd-misroute',
        eventType: 'webhook:issues.labeled',
        kind: 'task',
        actor: 'PlannerAgent',
        recordType: 'Issue',
        recordKind: 'Task',
        recordId: 'I_kwAOA',
        fromState: 'proposed',
        toState: 'ready',
        payloadHash: createHash('sha256').update('p').digest(),
        receivedAt: new Date('2026-05-30T18:00:00.000Z'),
      },
    });
    const handler = vi.fn();
    const controller = new AbortController();
    const loop = runAgentConsumerLoop({
      consumer,
      role: 'PlannerAgent',
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
