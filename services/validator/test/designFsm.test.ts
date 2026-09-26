import { describe, expect, test } from 'vitest';
import { DESIGN_TRANSITIONS, evaluateDesignTransition } from '../src/designFsm.js';

// Spec: docs/design/validator-bot.md "Issue(Design)" — same shape as Spec
// but DesignAgent is the proposing agent.

describe('evaluateDesignTransition — allowed transitions', () => {
  test('drafting → ready_for_review by DesignAgent', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'drafting',
        toState: 'ready_for_review',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('drafting → abandoned by human', () => {
    expect(
      evaluateDesignTransition({ fromState: 'drafting', toState: 'abandoned', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready_for_review → ratified by human', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready_for_review → ratified by ReviewAgent', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready_for_review → drafting by DesignAgent', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ready_for_review',
        toState: 'drafting',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready_for_review → abandoned by human', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ready_for_review',
        toState: 'abandoned',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ratified → superseded by system', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ratified',
        toState: 'superseded',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ratified → abandoned by human', () => {
    expect(
      evaluateDesignTransition({ fromState: 'ratified', toState: 'abandoned', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });
});

describe('evaluateDesignTransition — DesignAgent self-ratification is rejected', () => {
  test('ready_for_review → ratified by DesignAgent flags actor_not_authorized', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('SpecAgent cannot ratify a Design either (only ReviewAgent or human can)', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });
});

describe('evaluateDesignTransition — illegal transitions emit soft flag', () => {
  test('drafting → ratified flags', () => {
    expect(
      evaluateDesignTransition({ fromState: 'drafting', toState: 'ratified', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('drafting → superseded flags', () => {
    expect(
      evaluateDesignTransition({ fromState: 'drafting', toState: 'superseded', actor: 'system' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('ready_for_review → superseded flags', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ready_for_review',
        toState: 'superseded',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('ratified → drafting (backward) flags', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ratified',
        toState: 'drafting',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });
});

describe('evaluateDesignTransition — unauthorized actor emits soft flag', () => {
  test('drafting → ready_for_review by BuildAgent flags', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'drafting',
        toState: 'ready_for_review',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('drafting → ready_for_review by SpecAgent flags (DesignAgent-only)', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'drafting',
        toState: 'ready_for_review',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('ratified → superseded by human flags (system-only)', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'ratified',
        toState: 'superseded',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('drafting → abandoned by DesignAgent flags (human-only)', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'drafting',
        toState: 'abandoned',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });
});

describe('evaluateDesignTransition — terminal states emit soft flag', () => {
  test('superseded → anything flags terminal_state', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'superseded',
        toState: 'abandoned',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'flag', reason: 'terminal_state' });
  });

  test('abandoned → anything flags terminal_state', () => {
    expect(
      evaluateDesignTransition({
        fromState: 'abandoned',
        toState: 'drafting',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'flag', reason: 'terminal_state' });
  });
});

describe('DESIGN_TRANSITIONS table', () => {
  test('is deep-frozen', () => {
    expect(Object.isFrozen(DESIGN_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(DESIGN_TRANSITIONS.drafting)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed by the FSM contract.
    expect(Object.isFrozen(DESIGN_TRANSITIONS.drafting.ready_for_review!)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: see above.
    expect(Object.isFrozen(DESIGN_TRANSITIONS.drafting.ready_for_review!.allowedActors)).toBe(true);
  });

  test('terminal states have empty outgoing maps', () => {
    expect(Object.keys(DESIGN_TRANSITIONS.superseded)).toEqual([]);
    expect(Object.keys(DESIGN_TRANSITIONS.abandoned)).toEqual([]);
  });

  test('ratification actors are exactly { human, ReviewAgent } — never DesignAgent', () => {
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed.
    const ratifyActors = [...DESIGN_TRANSITIONS.ready_for_review.ratified!.allowedActors].sort();
    expect(ratifyActors).toEqual(['ReviewAgent', 'human']);
    expect(ratifyActors).not.toContain('DesignAgent');
  });
});

describe('evaluateDesignTransition — __initial__ creation transitions', () => {
  test('__initial__ → drafting by DesignAgent accepts', () => {
    expect(
      evaluateDesignTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by human accepts', () => {
    expect(
      evaluateDesignTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by SpecAgent flags (SpecAgent does not author Designs)', () => {
    expect(
      evaluateDesignTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });
});
