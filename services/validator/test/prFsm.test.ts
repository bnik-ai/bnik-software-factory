import { describe, expect, test } from 'vitest';
import { PR_TRANSITIONS, evaluatePrTransition } from '../src/prFsm.js';

// Spec: docs/design/validator-bot.md "Pull Request" table.

describe('evaluatePrTransition — allowed transitions', () => {
  test('draft → open by BuildAgent (PR ready)', () => {
    expect(
      evaluatePrTransition({ fromState: 'draft', toState: 'open', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('open → in_review by system (first pull_request_review event)', () => {
    expect(
      evaluatePrTransition({ fromState: 'open', toState: 'in_review', actor: 'system' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('open → in_review by ReviewAgent (issue #178 structural review applies status:in_review)', () => {
    // ReviewAgent advancing the PR to in_review via a status label is FSM-valid:
    // open → in_review admits REVIEW_REQUESTERS, which includes ReviewAgent.
    expect(
      evaluatePrTransition({ fromState: 'open', toState: 'in_review', actor: 'ReviewAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_review → approved by ReviewAgent (issue #178 structural review applies status:approved)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'in_review',
        toState: 'approved',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_review → approved by human', () => {
    expect(
      evaluatePrTransition({ fromState: 'in_review', toState: 'approved', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('approved → merged by OpsAgent (required checks pass + policy)', () => {
    expect(
      evaluatePrTransition({ fromState: 'approved', toState: 'merged', actor: 'OpsAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('approved → in_review by system (additional commits after approval)', () => {
    expect(
      evaluatePrTransition({ fromState: 'approved', toState: 'in_review', actor: 'system' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('approved → in_review by ReviewAgent (changes_requested AFTER approval — PR #46 rev1)', () => {
    expect(
      evaluatePrTransition({ fromState: 'approved', toState: 'in_review', actor: 'ReviewAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('approved → in_review by human (manual changes-requested loop)', () => {
    expect(
      evaluatePrTransition({ fromState: 'approved', toState: 'in_review', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_review → changes_requested by ReviewAgent (issue #182 request-changes verdict)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'in_review',
        toState: 'changes_requested',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_review → changes_requested by human → actor_not_authorized (issue #198: native human request-changes deferred at the resolver — only ReviewAgent drives this edge until the downstream bridge exists)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'in_review',
        toState: 'changes_requested',
        actor: 'human',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('in_review → changes_requested by BuildAgent → actor_not_authorized (only ReviewAgent drives request-changes)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'in_review',
        toState: 'changes_requested',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('changes_requested → in_review by BuildAgent (issue #182 revision pushed → re-review)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'changes_requested',
        toState: 'in_review',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('changes_requested → closed by author/human (abandon a non-converging revision loop)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'changes_requested',
        toState: 'closed',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_review → syncing by BuildAgent (issue #192 re-sync bounce step 1)', () => {
    expect(
      evaluatePrTransition({ fromState: 'in_review', toState: 'syncing', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('syncing → in_review by BuildAgent (issue #192 re-sync bounce step 2 → re-fires review)', () => {
    expect(
      evaluatePrTransition({ fromState: 'syncing', toState: 'in_review', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('in_review → syncing by ReviewAgent → actor_not_authorized (BuildAgent owns the rebase bounce)', () => {
    expect(
      evaluatePrTransition({ fromState: 'in_review', toState: 'syncing', actor: 'ReviewAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('syncing → closed by author/human (PR closed mid-bounce)', () => {
    expect(
      evaluatePrTransition({ fromState: 'syncing', toState: 'closed', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });
});

describe('evaluatePrTransition — "any → closed" by author or human', () => {
  test.each([
    ['draft', 'BuildAgent'],
    ['draft', 'human'],
    ['open', 'BuildAgent'],
    ['open', 'human'],
    ['in_review', 'BuildAgent'],
    ['in_review', 'human'],
    ['approved', 'BuildAgent'],
    ['approved', 'human'],
  ] as const)('%s → closed by %s accepts', (fromState, actor) => {
    expect(evaluatePrTransition({ fromState, toState: 'closed', actor })).toEqual({
      verdict: 'accept',
    });
  });
});

describe('evaluatePrTransition — illegal transitions emit soft flag', () => {
  test('draft → approved flags (must pass through in_review)', () => {
    expect(
      evaluatePrTransition({ fromState: 'draft', toState: 'approved', actor: 'ReviewAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('draft → in_review by system accepts (PR #47 review: GitHub allows requesting reviewers on draft PRs; FSM now has draft → in_review row matching open → in_review)', () => {
    expect(
      evaluatePrTransition({ fromState: 'draft', toState: 'in_review', actor: 'system' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('open → approved flags (must pass through in_review)', () => {
    expect(
      evaluatePrTransition({ fromState: 'open', toState: 'approved', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('in_review → merged flags (must pass through approved)', () => {
    expect(
      evaluatePrTransition({ fromState: 'in_review', toState: 'merged', actor: 'OpsAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('open → draft (backward) flags', () => {
    expect(
      evaluatePrTransition({ fromState: 'open', toState: 'draft', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });
});

describe('evaluatePrTransition — unauthorized actor emits soft flag', () => {
  test('draft → open by human flags (BuildAgent-only)', () => {
    expect(evaluatePrTransition({ fromState: 'draft', toState: 'open', actor: 'human' })).toEqual({
      verdict: 'flag',
      reason: 'actor_not_authorized',
    });
  });

  test('in_review → approved by BuildAgent flags (the proposing agent cannot self-approve)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'in_review',
        toState: 'approved',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('approved → merged by ReviewAgent flags (OpsAgent-only)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'approved',
        toState: 'merged',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('in_review → changes_requested by BuildAgent flags (issue #182: only ReviewAgent requests changes)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'in_review',
        toState: 'changes_requested',
        actor: 'BuildAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('changes_requested → in_review by ReviewAgent flags (issue #182: only BuildAgent drives the revision back)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'changes_requested',
        toState: 'in_review',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('changes_requested → approved flags (must pass back through in_review for re-review)', () => {
    expect(
      evaluatePrTransition({
        fromState: 'changes_requested',
        toState: 'approved',
        actor: 'ReviewAgent',
      }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });

  test('open → in_review by PlannerAgent flags (PlannerAgent is not on the review-requester allow-list per PR #46 rev2)', () => {
    expect(
      evaluatePrTransition({ fromState: 'open', toState: 'in_review', actor: 'PlannerAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('draft → closed by PlannerAgent flags (author/human only)', () => {
    expect(
      evaluatePrTransition({ fromState: 'draft', toState: 'closed', actor: 'PlannerAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });
});

describe('evaluatePrTransition — terminal states emit soft flag', () => {
  test('merged → anything flags terminal_state', () => {
    expect(
      evaluatePrTransition({ fromState: 'merged', toState: 'closed', actor: 'human' }),
    ).toEqual({ verdict: 'flag', reason: 'terminal_state' });
  });

  test('closed → anything flags terminal_state', () => {
    expect(evaluatePrTransition({ fromState: 'closed', toState: 'open', actor: 'human' })).toEqual({
      verdict: 'flag',
      reason: 'terminal_state',
    });
  });
});

describe('PR_TRANSITIONS table', () => {
  test('is deep-frozen', () => {
    expect(Object.isFrozen(PR_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(PR_TRANSITIONS.draft)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed.
    expect(Object.isFrozen(PR_TRANSITIONS.draft.open!)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: see above.
    expect(Object.isFrozen(PR_TRANSITIONS.draft.open!.allowedActors)).toBe(true);
  });

  test('merged and closed are terminal', () => {
    expect(Object.keys(PR_TRANSITIONS.merged)).toEqual([]);
    expect(Object.keys(PR_TRANSITIONS.closed)).toEqual([]);
  });

  test('every non-terminal state has a closed edge with { human, BuildAgent }', () => {
    for (const fromState of ['draft', 'open', 'in_review', 'approved'] as const) {
      // biome-ignore lint/style/noNonNullAssertion: every non-terminal has a closed edge.
      const actors = PR_TRANSITIONS[fromState].closed!.allowedActors;
      expect(new Set(actors)).toEqual(new Set(['human', 'BuildAgent']));
    }
  });

  test('BuildAgent (PR author) cannot appear in the approved-set (must NOT self-approve)', () => {
    // biome-ignore lint/style/noNonNullAssertion: structure is fixed.
    expect(PR_TRANSITIONS.in_review.approved!.allowedActors).not.toContain('BuildAgent');
  });
});

describe('evaluatePrTransition — __initial__ creation transitions', () => {
  test('__initial__ → draft by BuildAgent accepts (canonical PR-creation path)', () => {
    expect(
      evaluatePrTransition({ fromState: '__initial__', toState: 'draft', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → open by BuildAgent accepts (non-draft PR creation)', () => {
    expect(
      evaluatePrTransition({ fromState: '__initial__', toState: 'open', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → open by human accepts (humans can also open PRs)', () => {
    expect(
      evaluatePrTransition({ fromState: '__initial__', toState: 'open', actor: 'human' }),
    ).toEqual({ verdict: 'accept' });
  });

  test('__initial__ → open by ReviewAgent flags (reviewers do not author PRs)', () => {
    expect(
      evaluatePrTransition({ fromState: '__initial__', toState: 'open', actor: 'ReviewAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'actor_not_authorized' });
  });

  test('__initial__ → merged flags (must enter via draft or open)', () => {
    expect(
      evaluatePrTransition({ fromState: '__initial__', toState: 'merged', actor: 'BuildAgent' }),
    ).toEqual({ verdict: 'flag', reason: 'illegal_transition' });
  });
});
