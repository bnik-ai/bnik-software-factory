import { describe, expect, test } from 'vitest';
import { DEPLOYMENT_TRANSITIONS, evaluateDeploymentTransition } from '../src/deploymentFsm.js';

// Spec: docs/design/validator-bot.md "Deployment" table.
// Deployment is HARD-REJECT (line 209): off-policy → revert + circuit-breaker,
// not soft-flag. This is the first FSM in this package whose verdict envelope
// is `reject` rather than `flag`.

describe('evaluateDeploymentTransition — allowed transitions', () => {
  test('pending → in_progress by OpsAgent (no env approval required)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'pending',
        toState: 'in_progress',
        actor: 'OpsAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('pending → in_progress by system (CI / runner reports — github-actions[bot] common case)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'pending',
        toState: 'in_progress',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('pending → awaiting_approval by system (prod env with required_reviewers)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'pending',
        toState: 'awaiting_approval',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('awaiting_approval → in_progress by human (env approval)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'awaiting_approval',
        toState: 'in_progress',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_progress → success by system', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'in_progress',
        toState: 'success',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_progress → failure by system', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'in_progress',
        toState: 'failure',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_progress → error by system', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'in_progress',
        toState: 'error',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });
});

// Hard-reject is the load-bearing difference from the other FSMs. Per
// validator-bot.md:224, reject triggers substrate revert + policy:violation
// label + Decision + agent throttling. Tests assert verdict='reject'
// explicitly (NOT 'flag') to pin the verdict envelope.

describe('evaluateDeploymentTransition — hard-reject envelope on off-policy', () => {
  test('illegal transition emits REJECT (not flag)', () => {
    const result = evaluateDeploymentTransition({
      fromState: 'pending',
      toState: 'success',
      actor: 'system',
    });
    expect(result).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
    expect(result.verdict).toBe('reject');
  });

  test('unauthorized actor emits REJECT (not flag)', () => {
    const result = evaluateDeploymentTransition({
      fromState: 'pending',
      toState: 'in_progress',
      actor: 'BuildAgent',
    });
    expect(result).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
    expect(result.verdict).toBe('reject');
  });

  test('terminal state emits REJECT (not flag)', () => {
    const result = evaluateDeploymentTransition({
      fromState: 'success',
      toState: 'in_progress',
      actor: 'system',
    });
    expect(result).toEqual({ verdict: 'reject', reason: 'terminal_state' });
    expect(result.verdict).toBe('reject');
  });
});

describe('evaluateDeploymentTransition — env-approval gate', () => {
  test('awaiting_approval → in_progress by OpsAgent rejects (only human approves, or system reports POST-approval)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'awaiting_approval',
        toState: 'in_progress',
        actor: 'OpsAgent',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });

  test('awaiting_approval → in_progress by human accepts (direct env-approval)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'awaiting_approval',
        toState: 'in_progress',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('awaiting_approval → in_progress by system accepts (runner reports POST-approval state; the GATE is enforced by GitHub Environments substrate-side, not validator FSM. GitHub stops the deploy if no human approves so no webhook reaches this resolver in that case)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'awaiting_approval',
        toState: 'in_progress',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('awaiting_approval has no other outgoing edge (cannot skip past in_progress to success)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'awaiting_approval',
        toState: 'success',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });
});

describe('evaluateDeploymentTransition — additional illegal transitions', () => {
  test('pending → success rejects (must pass through in_progress)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'pending',
        toState: 'success',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });

  test('in_progress → awaiting_approval rejects (backward)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'in_progress',
        toState: 'awaiting_approval',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });
});

describe('evaluateDeploymentTransition — additional unauthorized actor cases', () => {
  test('pending → in_progress by human rejects (OpsAgent-only)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'pending',
        toState: 'in_progress',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });

  test('pending → awaiting_approval by OpsAgent rejects (system-only)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'pending',
        toState: 'awaiting_approval',
        actor: 'OpsAgent',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });

  test('in_progress → success by OpsAgent rejects (system-only)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: 'in_progress',
        toState: 'success',
        actor: 'OpsAgent',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });
});

describe('evaluateDeploymentTransition — terminal states', () => {
  test.each(['success', 'failure', 'error'] as const)('%s is terminal', (fromState) => {
    expect(
      evaluateDeploymentTransition({ fromState, toState: 'in_progress', actor: 'system' }),
    ).toEqual({ verdict: 'reject', reason: 'terminal_state' });
  });
});

describe('DEPLOYMENT_TRANSITIONS table', () => {
  test('is deep-frozen', () => {
    expect(Object.isFrozen(DEPLOYMENT_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(DEPLOYMENT_TRANSITIONS.pending)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed.
    expect(Object.isFrozen(DEPLOYMENT_TRANSITIONS.pending.in_progress!)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: see above.
    expect(Object.isFrozen(DEPLOYMENT_TRANSITIONS.pending.in_progress!.allowedActors)).toBe(true);
  });

  test('success / failure / error are terminal', () => {
    expect(Object.keys(DEPLOYMENT_TRANSITIONS.success)).toEqual([]);
    expect(Object.keys(DEPLOYMENT_TRANSITIONS.failure)).toEqual([]);
    expect(Object.keys(DEPLOYMENT_TRANSITIONS.error)).toEqual([]);
  });

  test('awaiting_approval has exactly ONE outgoing edge: in_progress (by human OR system runner POST-approval)', () => {
    expect(Object.keys(DEPLOYMENT_TRANSITIONS.awaiting_approval)).toEqual(['in_progress']);
    // biome-ignore lint/style/noNonNullAssertion: just asserted exists.
    const actors = [...DEPLOYMENT_TRANSITIONS.awaiting_approval.in_progress!.allowedActors].sort();
    expect(actors).toEqual(['human', 'system']);
  });
});

describe('evaluateDeploymentTransition — __initial__ creation transitions (HARD-REJECT scoped narrowly)', () => {
  test('__initial__ → pending by OpsAgent accepts', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: '__initial__',
        toState: 'pending',
        actor: 'OpsAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → pending by system accepts (GitHub auto-deployments dispatched by system)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: '__initial__',
        toState: 'pending',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → in_progress by system accepts', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: '__initial__',
        toState: 'in_progress',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → pending by BuildAgent REJECTS (HARD-REJECT FSM; only OpsAgent + system author Deployments)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: '__initial__',
        toState: 'pending',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });

  test('__initial__ → success REJECTS (cannot skip to terminal on creation)', () => {
    expect(
      evaluateDeploymentTransition({
        fromState: '__initial__',
        toState: 'success',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });
});
