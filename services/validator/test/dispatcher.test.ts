import { describe, expect, test } from 'vitest';
import { evaluateTransition } from '../src/dispatcher.js';
import { HARD_REJECT_KINDS, type Kind, SOFT_FLAG_KINDS } from '../src/kinds.js';

// Spec: docs/design/validator-bot.md (per-kind FSM tables) +
// services/validator/src/{goal,spec,design,task,pr,deployment}Fsm.ts.
// Tests verify the dispatcher routes to the correct FSM by sampling one
// happy path + one off-policy path per kind, then asserts the verdict-
// envelope contract (flag for soft-flag kinds, reject for hard-reject).

describe('evaluateTransition — happy path per kind', () => {
  test('goal: proposed → accepted by human', () => {
    expect(
      evaluateTransition({
        kind: 'goal',
        fromState: 'proposed',
        toState: 'accepted',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('spec: drafting → ready_for_review by SpecAgent', () => {
    expect(
      evaluateTransition({
        kind: 'spec',
        fromState: 'drafting',
        toState: 'ready_for_review',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('design: drafting → ready_for_review by DesignAgent', () => {
    expect(
      evaluateTransition({
        kind: 'design',
        fromState: 'drafting',
        toState: 'ready_for_review',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('task: proposed → ready by PlannerAgent', () => {
    expect(
      evaluateTransition({
        kind: 'task',
        fromState: 'proposed',
        toState: 'ready',
        actor: 'PlannerAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('pr: draft → open by BuildAgent', () => {
    expect(
      evaluateTransition({
        kind: 'pr',
        fromState: 'draft',
        toState: 'open',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('deployment: pending → in_progress by OpsAgent', () => {
    expect(
      evaluateTransition({
        kind: 'deployment',
        fromState: 'pending',
        toState: 'in_progress',
        actor: 'OpsAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });
});

// The dispatcher MUST preserve the verdict envelope each FSM emits.
// Soft-flag kinds (goal/spec/design/task/pr) → flag.
// Hard-reject kinds (deployment) → reject.
// Off-policy paths are sampled here; per-kind FSM tests cover the matrix.

describe('evaluateTransition — verdict envelope contract', () => {
  test.each([
    ['goal', 'proposed', 'achieved', 'system'],
    ['spec', 'drafting', 'ratified', 'human'],
    ['design', 'drafting', 'ratified', 'human'],
    ['task', 'proposed', 'in_progress', 'BuildAgent'],
    ['pr', 'draft', 'merged', 'BuildAgent'],
  ] as const)(
    '%s illegal transition (%s → %s by %s) emits FLAG (soft enforcement)',
    (kind, fromState, toState, actor) => {
      const result = evaluateTransition({ kind, fromState, toState, actor });
      expect(result.verdict).toBe('flag');
      expect(SOFT_FLAG_KINDS.has(kind)).toBe(true);
    },
  );

  test('deployment illegal transition emits REJECT (hard enforcement)', () => {
    const result = evaluateTransition({
      kind: 'deployment',
      fromState: 'pending',
      toState: 'success',
      actor: 'system',
    });
    expect(result.verdict).toBe('reject');
    expect(HARD_REJECT_KINDS.has('deployment')).toBe(true);
  });

  test('deployment unauthorized actor emits REJECT', () => {
    expect(
      evaluateTransition({
        kind: 'deployment',
        fromState: 'pending',
        toState: 'in_progress',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'reject', reason: 'actor_not_authorized' });
  });
});

describe('evaluateTransition — self-ratification / self-approval blocks preserved through dispatch', () => {
  test('spec ready_for_review → ratified by SpecAgent flags (cannot self-ratify)', () => {
    expect(
      evaluateTransition({
        kind: 'spec',
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'SpecAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('design ready_for_review → ratified by DesignAgent flags (cannot self-ratify)', () => {
    expect(
      evaluateTransition({
        kind: 'design',
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'DesignAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('pr in_review → approved by BuildAgent flags (author cannot self-approve)', () => {
    expect(
      evaluateTransition({
        kind: 'pr',
        fromState: 'in_review',
        toState: 'approved',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });
});

describe('evaluateTransition — unknown from-state surfaces unknown_from_state', () => {
  test('goal with unknown fromState flags unknown_from_state', () => {
    expect(
      evaluateTransition({
        kind: 'goal',
        fromState: 'totally_made_up_state',
        toState: 'accepted',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'flag', reason: 'unknown_from_state' });
  });

  test('deployment with unknown fromState rejects unknown_from_state', () => {
    expect(
      evaluateTransition({
        kind: 'deployment',
        fromState: 'totally_made_up_state',
        toState: 'in_progress',
        actor: 'OpsAgent',
      }),
    ).toEqual({ verdict: 'reject', reason: 'unknown_from_state' });
  });
});

describe('evaluateTransition — exhaustiveness', () => {
  test('unknown kind throws at runtime (TS exhaustiveness check is also a hard guard)', () => {
    // Bypass TS via cast — simulates a malformed message off the queue.
    const malformed = {
      kind: 'incident' as Kind,
      fromState: 'x',
      toState: 'y',
      actor: 'system' as const,
    };
    expect(() => evaluateTransition(malformed)).toThrow(/Unknown validator kind/);
  });
});
