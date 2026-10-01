import { describe, expect, test } from 'vitest';
import { DECISION_TRANSITIONS, evaluateDecisionTransition } from '../src/decisionFsm.js';

// Spec: docs/design/validator-bot.md "Issue(Decision)" table (lines 138-154)
// + line 245 (Decision is HARD-REJECT).

describe('evaluateDecisionTransition — allowed transitions', () => {
  test('drafting → proposed by SpecAgent accepts (author agent)', () => {
    expect(
      evaluateDecisionTransition({
        fromState: 'drafting',
        toState: 'proposed',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('drafting → proposed by DesignAgent accepts (author agent)', () => {
    expect(
      evaluateDecisionTransition({
        fromState: 'drafting',
        toState: 'proposed',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('drafting → proposed by human accepts', () => {
    expect(
      evaluateDecisionTransition({ fromState: 'drafting', toState: 'proposed', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('drafting → abandoned by human accepts', () => {
    expect(
      evaluateDecisionTransition({ fromState: 'drafting', toState: 'abandoned', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('proposed → approved by human accepts', () => {
    expect(
      evaluateDecisionTransition({ fromState: 'proposed', toState: 'approved', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('proposed → approved by ReviewAgent accepts (App as designated reviewer)', () => {
    expect(
      evaluateDecisionTransition({
        fromState: 'proposed',
        toState: 'approved',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('proposed → rejected by human accepts', () => {
    expect(
      evaluateDecisionTransition({ fromState: 'proposed', toState: 'rejected', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('proposed → abandoned REJECTS (NOT in spec table — proposed → rejected is the documented close path)', () => {
    expect(
      evaluateDecisionTransition({ fromState: 'proposed', toState: 'abandoned', actor: 'human' }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });

  test('approved → superseded by system accepts (later Decision marks supersedes)', () => {
    expect(
      evaluateDecisionTransition({
        fromState: 'approved',
        toState: 'superseded',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });
});

describe('evaluateDecisionTransition — HARD-REJECT envelope on off-policy', () => {
  test('proposed → approved by SpecAgent (the proposing agent cannot self-approve) → reject', () => {
    const result = evaluateDecisionTransition({
      fromState: 'proposed',
      toState: 'approved',
      actor: 'SpecAgent',
    });
    expect(result).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
    expect(result.verdict).toBe('reject');
  });

  test('proposed → approved by DesignAgent (also self-approval; proposing agents NEVER ratify their own) → reject', () => {
    expect(
      evaluateDecisionTransition({
        fromState: 'proposed',
        toState: 'approved',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });

  test('proposed → rejected by ReviewAgent (rejection is human-only — substantive editorial call) → reject', () => {
    expect(
      evaluateDecisionTransition({
        fromState: 'proposed',
        toState: 'rejected',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });

  test('approved → superseded by human (only system marks supersedes; the system actor wraps the later-Decision substrate logic) → reject', () => {
    expect(
      evaluateDecisionTransition({
        fromState: 'approved',
        toState: 'superseded',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });
});

describe('evaluateDecisionTransition — illegal transitions reject', () => {
  test('drafting → approved skips proposed (must pass through proposed) → reject', () => {
    expect(
      evaluateDecisionTransition({ fromState: 'drafting', toState: 'approved', actor: 'human' }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });

  test('proposed → superseded skips approved → reject', () => {
    expect(
      evaluateDecisionTransition({
        fromState: 'proposed',
        toState: 'superseded',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });

  test('approved → rejected (cannot reject an already-approved decision) → reject', () => {
    expect(
      evaluateDecisionTransition({ fromState: 'approved', toState: 'rejected', actor: 'human' }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });

  test('drafting → rejected (only approved-after-proposal can be rejected) → reject', () => {
    expect(
      evaluateDecisionTransition({ fromState: 'drafting', toState: 'rejected', actor: 'human' }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });
});

describe('evaluateDecisionTransition — terminal states reject', () => {
  test.each(['rejected', 'superseded', 'abandoned'] as const)('%s → anything rejects', (term) => {
    const result = evaluateDecisionTransition({
      fromState: term,
      toState: 'approved',
      actor: 'human',
    });
    expect(result).toEqual({ verdict: 'reject', reason: 'terminal_state' });
  });
});

describe('evaluateDecisionTransition — __initial__ creation', () => {
  test('__initial__ → drafting by SpecAgent accepts (proposing agent)', () => {
    expect(
      evaluateDecisionTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by DesignAgent accepts', () => {
    expect(
      evaluateDecisionTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by human accepts', () => {
    expect(
      evaluateDecisionTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by system accepts (validator-bot.md:245: hard-reject mode opens a Decision issue — system MUST be allowed)', () => {
    expect(
      evaluateDecisionTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by OpsAgent accepts (infra Decisions; the "any agent can author" ownership model)', () => {
    expect(
      evaluateDecisionTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'OpsAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by BuildAgent accepts (any agent except ReviewAgent can author Decisions; ReviewAgent EXCLUDED here to enforce no-self-approval at the FSM layer)', () => {
    expect(
      evaluateDecisionTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by ReviewAgent REJECTS (ReviewAgent is the designated approver; excluding it from authoring enforces "never the proposing agent" rule at FSM layer without a cross-record check)', () => {
    expect(
      evaluateDecisionTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });

  test('__initial__ → approved (skip drafting/proposed) REJECTS', () => {
    expect(
      evaluateDecisionTransition({
        fromState: '__initial__',
        toState: 'approved',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });
});

describe('DECISION_TRANSITIONS table', () => {
  test('is deep-frozen', () => {
    expect(Object.isFrozen(DECISION_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(DECISION_TRANSITIONS.drafting)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed.
    expect(Object.isFrozen(DECISION_TRANSITIONS.proposed.approved!)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: see above.
    expect(Object.isFrozen(DECISION_TRANSITIONS.proposed.approved!.allowedActors)).toBe(true);
  });

  test('rejected / superseded / abandoned are terminal (empty outgoing maps)', () => {
    expect(Object.keys(DECISION_TRANSITIONS.rejected)).toEqual([]);
    expect(Object.keys(DECISION_TRANSITIONS.superseded)).toEqual([]);
    expect(Object.keys(DECISION_TRANSITIONS.abandoned)).toEqual([]);
  });

  test('approval actors are exactly { human, ReviewAgent } — never any proposing agent', () => {
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed.
    const approvers = [...DECISION_TRANSITIONS.proposed.approved!.allowedActors].sort();
    expect(approvers).toEqual(['ReviewAgent', 'human']);
    expect(approvers).not.toContain('SpecAgent');
    expect(approvers).not.toContain('DesignAgent');
  });
});
