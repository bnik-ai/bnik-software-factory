import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { runSreAgent } from '../src/agents/sreAgent.js';
import type { ParsedTransitionMessage } from '../src/types.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:deployment_status',
    kind: 'deployment',
    actor: 'system',
    recordType: 'Deployment',
    recordKind: 'Deployment',
    recordId: 'DEP_kwAOA_55',
    fromState: 'in_progress',
    toState: 'failure',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

const deps = { runId: '01HZXYZ123456789ABCDEFGHJK' };

describe('runSreAgent — happy path on deployment:in_progress→failure|error', () => {
  test('failure transition → success result naming mode + record', async () => {
    const result = await runSreAgent(makeMessage(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('observed deployment failure on DEP_kwAOA_55');
    expect(result.result).toContain('run 01HZXYZ123456789ABCDEFGHJK');
  });

  test('error transition → success result naming mode=error', async () => {
    const result = await runSreAgent(makeMessage({ toState: 'error' }), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('observed deployment error on DEP_kwAOA_55');
  });
});

describe('runSreAgent — defensive guards', () => {
  test('non-deployment kind → typed wrong_transition', async () => {
    const result = await runSreAgent(makeMessage({ kind: 'pr' }), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^sre_agent_wrong_transition:pr:/);
  });

  test('deployment but not in_progress→failure/error → typed not_failure_state', async () => {
    const result = await runSreAgent(
      makeMessage({ fromState: 'in_progress', toState: 'success' }),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('sre_agent_not_failure_state:in_progress→success');
  });
});
