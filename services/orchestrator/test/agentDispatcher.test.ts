import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { InMemoryAgentDispatcher } from '../src/agentDispatcher.js';
import type { ParsedTransitionMessage } from '../src/types.js';

function makeMessage(): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.labeled',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA',
    fromState: 'proposed',
    toState: 'accepted',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
  };
}

describe('InMemoryAgentDispatcher', () => {
  test('records every dispatch attempt + returns monotonic dispatch IDs', async () => {
    const d = new InMemoryAgentDispatcher();
    const r1 = await d.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    const r2 = await d.dispatch({
      agent: 'ReviewAgent',
      message: makeMessage(),
      transitionKey: 'spec:drafting→ready_for_review',
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(r1.dispatchId).toBe('disp-1');
    if (r2.ok) expect(r2.dispatchId).toBe('disp-2');
    expect(d.attemptCount()).toBe(2);
  });

  test('attempt records preserve agent + transitionKey + the full message', async () => {
    const d = new InMemoryAgentDispatcher();
    const message = makeMessage();
    await d.dispatch({ agent: 'BuildAgent', message, transitionKey: 'task:proposed→ready' });
    const attempts = d.dispatchAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.agent).toBe('BuildAgent');
    expect(attempts[0]?.transitionKey).toBe('task:proposed→ready');
    expect(attempts[0]?.message).toBe(message);
  });
});
