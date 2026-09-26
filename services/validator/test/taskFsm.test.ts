import { describe, expect, test } from 'vitest';
import { TASK_TRANSITIONS, evaluateTaskTransition } from '../src/taskFsm.js';

// Spec: docs/design/validator-bot.md "Issue(Task)" table.

describe('evaluateTaskTransition — allowed transitions', () => {
  test('proposed → ready by PlannerAgent', () => {
    expect(
      evaluateTaskTransition({ fromState: 'proposed', toState: 'ready', actor: 'PlannerAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready → in_progress by BuildAgent', () => {
    expect(
      evaluateTaskTransition({ fromState: 'ready', toState: 'in_progress', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_progress → in_review by BuildAgent (PR opened)', () => {
    expect(
      evaluateTaskTransition({
        fromState: 'in_progress',
        toState: 'in_review',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_review → done by OpsAgent (PR merged)', () => {
    expect(
      evaluateTaskTransition({ fromState: 'in_review', toState: 'done', actor: 'OpsAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('ready → done by OpsAgent (issue #180 post-merge bookkeeping — v0 BuildAgent never claims the Task)', () => {
    expect(
      evaluateTaskTransition({ fromState: 'ready', toState: 'done', actor: 'OpsAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_review → in_progress by BuildAgent (review changes_requested)', () => {
    expect(
      evaluateTaskTransition({
        fromState: 'in_review',
        toState: 'in_progress',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });
});

describe('evaluateTaskTransition — any → abandoned by human or PlannerAgent', () => {
  test.each([
    ['proposed', 'human'],
    ['proposed', 'PlannerAgent'],
    ['ready', 'human'],
    ['ready', 'PlannerAgent'],
    ['in_progress', 'human'],
    ['in_progress', 'PlannerAgent'],
    ['in_review', 'human'],
    ['in_review', 'PlannerAgent'],
  ] as const)('%s → abandoned by %s accepts', (fromState, actor) => {
    expect(evaluateTaskTransition({ fromState, toState: 'abandoned', actor })).toEqual({
      verdict: 'accept',
    });
  });
});

describe('evaluateTaskTransition — illegal transitions emit soft flag', () => {
  test('proposed → in_progress flags (must pass through ready)', () => {
    expect(
      evaluateTaskTransition({
        fromState: 'proposed',
        toState: 'in_progress',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('ready → in_review flags (must pass through in_progress)', () => {
    expect(
      evaluateTaskTransition({ fromState: 'ready', toState: 'in_review', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('in_progress → done flags (must pass through in_review)', () => {
    expect(
      evaluateTaskTransition({ fromState: 'in_progress', toState: 'done', actor: 'OpsAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('ready → proposed (backward) flags', () => {
    expect(
      evaluateTaskTransition({ fromState: 'ready', toState: 'proposed', actor: 'PlannerAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('in_review → ready (skip) flags', () => {
    expect(
      evaluateTaskTransition({ fromState: 'in_review', toState: 'ready', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });
});

describe('evaluateTaskTransition — unauthorized actor emits soft flag', () => {
  test('proposed → ready by BuildAgent flags (PlannerAgent-only)', () => {
    expect(
      evaluateTaskTransition({ fromState: 'proposed', toState: 'ready', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('ready → in_progress by PlannerAgent flags (BuildAgent-only)', () => {
    expect(
      evaluateTaskTransition({
        fromState: 'ready',
        toState: 'in_progress',
        actor: 'PlannerAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('in_review → done by BuildAgent flags (OpsAgent-only)', () => {
    expect(
      evaluateTaskTransition({ fromState: 'in_review', toState: 'done', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('ready → done by BuildAgent (issue #180 already-satisfied empty-diff settle)', () => {
    expect(
      evaluateTaskTransition({ fromState: 'ready', toState: 'done', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_review → in_progress by OpsAgent flags (BuildAgent-only)', () => {
    expect(
      evaluateTaskTransition({
        fromState: 'in_review',
        toState: 'in_progress',
        actor: 'OpsAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('in_progress → abandoned by BuildAgent flags (human or PlannerAgent only)', () => {
    expect(
      evaluateTaskTransition({
        fromState: 'in_progress',
        toState: 'abandoned',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });
});

describe('evaluateTaskTransition — terminal states emit soft flag', () => {
  test('done → anything flags terminal_state', () => {
    expect(
      evaluateTaskTransition({ fromState: 'done', toState: 'in_progress', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'terminal_state' });
  });

  test('abandoned → anything flags terminal_state', () => {
    expect(
      evaluateTaskTransition({ fromState: 'abandoned', toState: 'ready', actor: 'PlannerAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'terminal_state' });
  });
});

describe('TASK_TRANSITIONS table', () => {
  test('is deep-frozen', () => {
    expect(Object.isFrozen(TASK_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(TASK_TRANSITIONS.proposed)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed.
    expect(Object.isFrozen(TASK_TRANSITIONS.proposed.ready!)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: see above.
    expect(Object.isFrozen(TASK_TRANSITIONS.proposed.ready!.allowedActors)).toBe(true);
  });

  test('done and abandoned are terminal', () => {
    expect(Object.keys(TASK_TRANSITIONS.done)).toEqual([]);
    expect(Object.keys(TASK_TRANSITIONS.abandoned)).toEqual([]);
  });

  test('every non-terminal state has an abandoned edge with human + PlannerAgent', () => {
    for (const fromState of ['proposed', 'ready', 'in_progress', 'in_review'] as const) {
      // biome-ignore lint/style/noNonNullAssertion: every non-terminal has an abandoned edge.
      const actors = TASK_TRANSITIONS[fromState].abandoned!.allowedActors;
      expect(new Set(actors)).toEqual(new Set(['human', 'PlannerAgent']));
    }
  });
});

describe('evaluateTaskTransition — __initial__ creation transitions', () => {
  test('__initial__ → proposed by PlannerAgent accepts (Task fan-out from Design)', () => {
    expect(
      evaluateTaskTransition({
        fromState: '__initial__',
        toState: 'proposed',
        actor: 'PlannerAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → proposed by human accepts', () => {
    expect(
      evaluateTaskTransition({ fromState: '__initial__', toState: 'proposed', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → proposed by BuildAgent flags (BuildAgent works tasks, does not create them)', () => {
    expect(
      evaluateTaskTransition({
        fromState: '__initial__',
        toState: 'proposed',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('__initial__ → in_progress flags (must enter via proposed)', () => {
    expect(
      evaluateTaskTransition({
        fromState: '__initial__',
        toState: 'in_progress',
        actor: 'PlannerAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });
});
