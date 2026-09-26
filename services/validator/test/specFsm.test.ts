import { describe, expect, test } from 'vitest';
import { SPEC_TRANSITIONS, evaluateSpecTransition } from '../src/specFsm.js';

// Spec: docs/design/validator-bot.md "Issue(Spec)" table + field-level
// policy at line 209 (Spec status = soft-flag).

describe('evaluateSpecTransition — allowed transitions', () => {
  test('drafting → ready_for_review by SpecAgent', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'drafting',
        toState: 'ready_for_review',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('drafting → abandoned by human', () => {
    expect(
      evaluateSpecTransition({ fromState: 'drafting', toState: 'abandoned', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready_for_review → ratified by human', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready_for_review → ratified by ReviewAgent (designated reviewer)', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready_for_review → drafting by SpecAgent (review feedback)', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ready_for_review',
        toState: 'drafting',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready_for_review → abandoned by human', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ready_for_review',
        toState: 'abandoned',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ratified → superseded by system', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ratified',
        toState: 'superseded',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ratified → abandoned by human', () => {
    expect(
      evaluateSpecTransition({ fromState: 'ratified', toState: 'abandoned', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });
});

// Critical invariant: SpecAgent (the proposing agent) MUST NOT self-ratify.
// "ratified by human OR designated reviewer agent (NEVER SpecAgent itself)".

describe('evaluateSpecTransition — SpecAgent self-ratification is rejected', () => {
  test('ready_for_review → ratified by SpecAgent flags actor_not_authorized', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });
});

describe('evaluateSpecTransition — illegal transitions emit soft flag', () => {
  test('drafting → ratified flags (must pass through ready_for_review)', () => {
    expect(
      evaluateSpecTransition({ fromState: 'drafting', toState: 'ratified', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('drafting → superseded flags', () => {
    expect(
      evaluateSpecTransition({ fromState: 'drafting', toState: 'superseded', actor: 'system' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('ready_for_review → superseded flags (must go through ratified)', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ready_for_review',
        toState: 'superseded',
        actor: 'system',
      }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('ratified → drafting (backward) flags', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ratified',
        toState: 'drafting',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('drafting → drafting (self-loop) flags', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'drafting',
        toState: 'drafting',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });
});

describe('evaluateSpecTransition — unauthorized actor emits soft flag', () => {
  test('drafting → ready_for_review by BuildAgent flags', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'drafting',
        toState: 'ready_for_review',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('ready_for_review → drafting by PlannerAgent flags (SpecAgent-only)', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ready_for_review',
        toState: 'drafting',
        actor: 'PlannerAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('ratified → superseded by human flags (system-only)', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'ratified',
        toState: 'superseded',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('drafting → abandoned by SpecAgent flags (human-only)', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'drafting',
        toState: 'abandoned',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });
});

describe('evaluateSpecTransition — terminal states emit soft flag', () => {
  test('superseded → anything flags terminal_state', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'superseded',
        toState: 'abandoned',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'flag', reason: 'terminal_state' });
  });

  test('abandoned → anything flags terminal_state', () => {
    expect(
      evaluateSpecTransition({
        fromState: 'abandoned',
        toState: 'drafting',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'flag', reason: 'terminal_state' });
  });
});

describe('SPEC_TRANSITIONS table', () => {
  test('is deep-frozen', () => {
    expect(Object.isFrozen(SPEC_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(SPEC_TRANSITIONS.drafting)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed by the FSM contract.
    expect(Object.isFrozen(SPEC_TRANSITIONS.drafting.ready_for_review!)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: see above.
    expect(Object.isFrozen(SPEC_TRANSITIONS.drafting.ready_for_review!.allowedActors)).toBe(true);
  });

  test('terminal states have empty outgoing maps', () => {
    expect(Object.keys(SPEC_TRANSITIONS.superseded)).toEqual([]);
    expect(Object.keys(SPEC_TRANSITIONS.abandoned)).toEqual([]);
  });

  test('ratification actors are exactly { human, ReviewAgent } — never SpecAgent', () => {
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed.
    const ratifyActors = [...SPEC_TRANSITIONS.ready_for_review.ratified!.allowedActors].sort();
    expect(ratifyActors).toEqual(['ReviewAgent', 'human']);
    expect(ratifyActors).not.toContain('SpecAgent');
  });
});

describe('evaluateSpecTransition — __initial__ creation transitions', () => {
  test('__initial__ → drafting by SpecAgent accepts (canonical Spec authoring path)', () => {
    expect(
      evaluateSpecTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by human accepts (humans can also draft Specs)', () => {
    expect(
      evaluateSpecTransition({ fromState: '__initial__', toState: 'drafting', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → drafting by BuildAgent flags', () => {
    expect(
      evaluateSpecTransition({
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('__initial__ → ratified flags (only drafting is a legal first state)', () => {
    expect(
      evaluateSpecTransition({
        fromState: '__initial__',
        toState: 'ratified',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });
});
