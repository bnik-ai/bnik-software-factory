import { describe, expect, test } from 'vitest';
import { GOAL_TRANSITIONS, evaluateGoalTransition } from '../src/goalFsm.js';

// Spec: docs/design/validator-bot.md "Issue(Goal)" table + field-level
// policy table at line 209 (Goal status = soft-flag enforcement).

describe('evaluateGoalTransition — allowed transitions', () => {
  test('proposed → accepted by human accepts', () => {
    expect(
      evaluateGoalTransition({ fromState: 'proposed', toState: 'accepted', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('proposed → abandoned by human accepts', () => {
    expect(
      evaluateGoalTransition({ fromState: 'proposed', toState: 'abandoned', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('accepted → in_progress by SpecAgent accepts', () => {
    expect(
      evaluateGoalTransition({ fromState: 'accepted', toState: 'in_progress', actor: 'SpecAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('accepted → abandoned by human accepts', () => {
    expect(
      evaluateGoalTransition({ fromState: 'accepted', toState: 'abandoned', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_progress → achieved by system accepts', () => {
    expect(
      evaluateGoalTransition({ fromState: 'in_progress', toState: 'achieved', actor: 'system' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_progress → abandoned by human accepts', () => {
    expect(
      evaluateGoalTransition({ fromState: 'in_progress', toState: 'abandoned', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });
});

// Goal off-policy transitions emit `flag`, NOT `reject`. The semantic
// difference matters: `reject` triggers auto-revert + circuit-breaker
// per validator-bot.md:224; `flag` records the violation, labels it, and
// opens a Decision for human review per line 225. The hard-reject FSMs
// (Deployment / Decision) are covered in their own test files.

describe('evaluateGoalTransition — illegal transitions emit soft flag', () => {
  test('proposed → in_progress flags (must go through accepted first)', () => {
    expect(
      evaluateGoalTransition({ fromState: 'proposed', toState: 'in_progress', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('proposed → achieved flags', () => {
    expect(
      evaluateGoalTransition({ fromState: 'proposed', toState: 'achieved', actor: 'system' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('accepted → achieved flags (must go through in_progress)', () => {
    expect(
      evaluateGoalTransition({ fromState: 'accepted', toState: 'achieved', actor: 'system' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('accepted → accepted (self-loop) flags', () => {
    expect(
      evaluateGoalTransition({ fromState: 'accepted', toState: 'accepted', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('in_progress → proposed (backward) flags', () => {
    expect(
      evaluateGoalTransition({ fromState: 'in_progress', toState: 'proposed', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });
});

describe('evaluateGoalTransition — unauthorized actor emits soft flag', () => {
  test('proposed → accepted by SpecAgent flags (human-only)', () => {
    expect(
      evaluateGoalTransition({ fromState: 'proposed', toState: 'accepted', actor: 'SpecAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('proposed → abandoned by BuildAgent flags (human-only)', () => {
    expect(
      evaluateGoalTransition({ fromState: 'proposed', toState: 'abandoned', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('accepted → in_progress by human flags (SpecAgent-only)', () => {
    expect(
      evaluateGoalTransition({ fromState: 'accepted', toState: 'in_progress', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('accepted → in_progress by BuildAgent flags', () => {
    expect(
      evaluateGoalTransition({
        fromState: 'accepted',
        toState: 'in_progress',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('in_progress → achieved by human flags (system-only)', () => {
    expect(
      evaluateGoalTransition({ fromState: 'in_progress', toState: 'achieved', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('accepted → abandoned by SpecAgent flags (human-only)', () => {
    expect(
      evaluateGoalTransition({ fromState: 'accepted', toState: 'abandoned', actor: 'SpecAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });
});

describe('evaluateGoalTransition — terminal states emit soft flag', () => {
  test('achieved → anything flags with terminal_state', () => {
    expect(
      evaluateGoalTransition({ fromState: 'achieved', toState: 'in_progress', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'terminal_state' });
  });

  test('abandoned → anything flags with terminal_state', () => {
    expect(
      evaluateGoalTransition({ fromState: 'abandoned', toState: 'proposed', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'terminal_state' });
  });
});

describe('GOAL_TRANSITIONS table', () => {
  test('outer table is frozen — runtime mutation throws TypeError', () => {
    expect(Object.isFrozen(GOAL_TRANSITIONS)).toBe(true);
    expect(() => {
      (GOAL_TRANSITIONS as Record<string, unknown>).new_state = {};
    }).toThrow(TypeError);
  });

  test('per-from-state inner tables are deep-frozen', () => {
    expect(Object.isFrozen(GOAL_TRANSITIONS.proposed)).toBe(true);
    expect(Object.isFrozen(GOAL_TRANSITIONS.accepted)).toBe(true);
  });

  test('individual transition entries are deep-frozen — allowedActors cannot be reassigned', () => {
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed by the FSM contract; lookup cannot return undefined for these well-known transitions.
    const entry = GOAL_TRANSITIONS.proposed.accepted!;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { allowedActors: ReadonlyArray<string> }).allowedActors = ['BuildAgent'];
    }).toThrow(TypeError);
  });

  test('allowedActors arrays are deep-frozen', () => {
    // biome-ignore lint/style/noNonNullAssertion: see above.
    expect(Object.isFrozen(GOAL_TRANSITIONS.proposed.accepted!.allowedActors)).toBe(true);
  });

  test('terminal states have empty outgoing-transition maps', () => {
    expect(Object.keys(GOAL_TRANSITIONS.achieved)).toEqual([]);
    expect(Object.keys(GOAL_TRANSITIONS.abandoned)).toEqual([]);
  });
});

describe('evaluateGoalTransition — __initial__ creation transitions', () => {
  test('__initial__ → proposed by human accepts (Goal authoring is a human action)', () => {
    expect(
      evaluateGoalTransition({ fromState: '__initial__', toState: 'proposed', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → proposed by SpecAgent flags (only human can create Goals)', () => {
    expect(
      evaluateGoalTransition({ fromState: '__initial__', toState: 'proposed', actor: 'SpecAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('__initial__ → accepted flags (only proposed is a legal first state for a Goal)', () => {
    expect(
      evaluateGoalTransition({ fromState: '__initial__', toState: 'accepted', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });
});
