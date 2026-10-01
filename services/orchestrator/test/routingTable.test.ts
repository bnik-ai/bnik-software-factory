import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { routeTransition } from '../src/routingTable.js';
import type { Actor, Kind, ParsedTransitionMessage } from '../src/types.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
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
    ...overrides,
  };
}

describe('routeTransition — Goal lifecycle', () => {
  test('proposed → accepted → SpecAgent', () => {
    const r = routeTransition(makeMessage());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent).toBe('SpecAgent');
      expect(r.transitionKey).toBe('goal:proposed→accepted');
    }
  });

  test('__initial__ → proposed → PlannerAgent (ADR 0013: new Goal intake re-plans the backlog)', () => {
    const r = routeTransition(makeMessage({ fromState: '__initial__', toState: 'proposed' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent).toBe('PlannerAgent');
      expect(r.transitionKey).toBe('goal:__initial__→proposed');
    }
  });

  test('in_progress → achieved → no_dispatch_needed', () => {
    const r = routeTransition(makeMessage({ fromState: 'in_progress', toState: 'achieved' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });
});

describe('routeTransition — Spec lifecycle', () => {
  test('drafting → ready_for_review → ReviewAgent', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'spec',
        recordKind: 'Spec',
        fromState: 'drafting',
        toState: 'ready_for_review',
        actor: 'SpecAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('ReviewAgent');
  });

  test('ready_for_review → ratified → DesignAgent', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'spec',
        recordKind: 'Spec',
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'ReviewAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('DesignAgent');
  });
});

describe('routeTransition — Design lifecycle', () => {
  test('drafting → ready_for_review → ReviewAgent', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'design',
        recordKind: 'Design',
        fromState: 'drafting',
        toState: 'ready_for_review',
        actor: 'DesignAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('ReviewAgent');
  });

  test('ready_for_review → ratified → PlannerAgent (fan out into Tasks)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'design',
        recordKind: 'Design',
        fromState: 'ready_for_review',
        toState: 'ratified',
        actor: 'ReviewAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('PlannerAgent');
  });
});

describe('routeTransition — Task lifecycle', () => {
  test('proposed → ready → BuildAgent', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        fromState: 'proposed',
        toState: 'ready',
        actor: 'PlannerAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('BuildAgent');
  });

  test('in_progress → in_review → ReviewAgent', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        fromState: 'in_progress',
        toState: 'in_review',
        actor: 'BuildAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('ReviewAgent');
  });

  test('in_review → done → PlannerAgent (ADR 0013: dep-clear re-plan trigger; OpsAgent already merged upstream)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        fromState: 'in_review',
        toState: 'done',
        actor: 'OpsAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent).toBe('PlannerAgent');
      expect(r.transitionKey).toBe('task:in_review→done');
    }
  });

  test('ready → done → PlannerAgent (OpsAgent post-merge bookkeeping; same dep-clear re-plan trigger)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        fromState: 'ready',
        toState: 'done',
        actor: 'OpsAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent).toBe('PlannerAgent');
      expect(r.transitionKey).toBe('task:ready→done');
    }
  });

  test.each([
    ['proposed', 'abandoned'],
    ['ready', 'abandoned'],
    ['in_progress', 'abandoned'],
    ['in_review', 'abandoned'],
  ] as const)(
    'task:%s → %s → PlannerAgent (ADR 0013: any →abandoned is a dep-clear trigger)',
    (fromState, toState) => {
      const r = routeTransition(
        makeMessage({
          kind: 'task',
          recordKind: 'Task',
          fromState,
          toState,
          actor: 'human',
        }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.agent).toBe('PlannerAgent');
        expect(r.transitionKey).toBe(`task:${fromState}→${toState}`);
      }
    },
  );

  test('ready → in_progress → no_dispatch_needed (BuildAgent already started)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        fromState: 'ready',
        toState: 'in_progress',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });
});

describe('routeTransition — PR lifecycle', () => {
  test('__initial__ → open → ReviewAgent', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: '__initial__',
        toState: 'open',
        actor: 'BuildAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('ReviewAgent');
  });

  test('draft → open → ReviewAgent', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'draft',
        toState: 'open',
        actor: 'BuildAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('ReviewAgent');
  });

  test('in_review → approved → OpsAgent (merge follows)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'in_review',
        toState: 'approved',
        actor: 'ReviewAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('OpsAgent');
  });

  test('approved → merged → no_dispatch_needed (deployment flow fires separately)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'approved',
        toState: 'merged',
        actor: 'OpsAgent',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });

  test('__initial__ → draft → no_dispatch_needed (draft PR; dispatch on ready_for_review)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: '__initial__',
        toState: 'draft',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });
});

describe('routeTransition — Deployment lifecycle (SREAgent on failure/error only)', () => {
  test('in_progress → failure → SREAgent', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'deployment',
        recordKind: 'Deployment',
        recordType: 'Deployment',
        fromState: 'in_progress',
        toState: 'failure',
        actor: 'system',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('SREAgent');
  });

  test('in_progress → error → SREAgent', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'deployment',
        recordKind: 'Deployment',
        recordType: 'Deployment',
        fromState: 'in_progress',
        toState: 'error',
        actor: 'system',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('SREAgent');
  });

  test('in_progress → success → no_dispatch_needed (observability only)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'deployment',
        recordKind: 'Deployment',
        recordType: 'Deployment',
        fromState: 'in_progress',
        toState: 'success',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });

  test('awaiting_approval → in_progress → no_dispatch_needed (env approval is GitHub-side gate)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'deployment',
        recordKind: 'Deployment',
        recordType: 'Deployment',
        fromState: 'awaiting_approval',
        toState: 'in_progress',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });
});

describe('routeTransition — revision loop, re-sync bounce and actor-asymmetric dispatch', () => {
  test('task:in_review→in_progress → BuildAgent (revision loop trigger; ADR 0010 authoritative path)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        fromState: 'in_review',
        toState: 'in_progress',
        actor: 'BuildAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('BuildAgent');
  });

  test('pr:draft→in_review → ReviewAgent (reviewer requested on draft PR; PR FSM admits draft→in_review)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'draft',
        toState: 'in_review',
        actor: 'human',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('ReviewAgent');
  });

  test('pr:in_review→changes_requested → BuildAgent (revision dispatch on the PR FSM)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'in_review',
        toState: 'changes_requested',
        actor: 'ReviewAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('BuildAgent');
  });

  test('pr:changes_requested→in_review → ReviewAgent (re-review after revision)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'changes_requested',
        toState: 'in_review',
        actor: 'BuildAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('ReviewAgent');
  });

  test('pr:syncing→in_review → ReviewAgent (re-sync bounce re-fires review)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'syncing',
        toState: 'in_review',
        actor: 'BuildAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('ReviewAgent');
  });

  test('pr:in_review→syncing → BuildAgent (bounce step 2: durable syncing → finish the bounce)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'in_review',
        toState: 'syncing',
        actor: 'BuildAgent',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('BuildAgent');
  });

  test('spec:__initial__→drafting + actor=SpecAgent → no_dispatch_needed (agent already running)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'spec',
        recordKind: 'Spec',
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'SpecAgent',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });

  test('spec:__initial__→drafting + actor=human → SpecAgent (human-created records need agent dispatched)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'spec',
        recordKind: 'Spec',
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'human',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('SpecAgent');
  });

  test('design:__initial__→drafting + actor=DesignAgent → no_dispatch_needed', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'design',
        recordKind: 'Design',
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'DesignAgent',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });

  test('design:__initial__→drafting + actor=human → DesignAgent (human-created design)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'design',
        recordKind: 'Design',
        fromState: '__initial__',
        toState: 'drafting',
        actor: 'human',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('DesignAgent');
  });

  test('task:__initial__→proposed + actor=PlannerAgent → no_dispatch_needed (fan-out already running)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        fromState: '__initial__',
        toState: 'proposed',
        actor: 'PlannerAgent',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });

  test('task:__initial__→proposed + actor=human → PlannerAgent (human-created task)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        fromState: '__initial__',
        toState: 'proposed',
        actor: 'human',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('PlannerAgent');
  });

  test('spec:ready_for_review→drafting → no_dispatch_needed (SpecAgent reworking; already running)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'spec',
        recordKind: 'Spec',
        fromState: 'ready_for_review',
        toState: 'drafting',
        actor: 'SpecAgent',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });

  test('pr:approved→in_review + actor=ReviewAgent → no_dispatch_needed (paired task:in_review→in_progress is the authoritative trigger; avoids redundant BuildAgent dispatch)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'approved',
        toState: 'in_review',
        actor: 'ReviewAgent',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });

  test('pr:approved→in_review + actor=human → BuildAgent (human changes-after-approval has no paired agent transition; orchestrator dispatches directly)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'pr',
        recordKind: 'PullRequest',
        recordType: 'PullRequest',
        fromState: 'approved',
        toState: 'in_review',
        actor: 'human',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent).toBe('BuildAgent');
  });
});

describe('routeTransition — Decision lifecycle (orchestrator knows kind:decision)', () => {
  test.each([
    ['__initial__', 'drafting'],
    ['drafting', 'proposed'],
    ['drafting', 'abandoned'],
    ['proposed', 'approved'],
    ['proposed', 'rejected'],
    ['approved', 'superseded'],
  ] as const)('decision %s → %s → no_dispatch_needed', (fromState, toState) => {
    const r = routeTransition(
      makeMessage({
        kind: 'decision',
        recordKind: 'Decision',
        fromState,
        toState,
        actor: 'system',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dispatch_needed');
  });

  test('decision with novel transition → unknown_transition (not unknown_kind, since kind is now recognized)', () => {
    const r = routeTransition(
      makeMessage({
        kind: 'decision',
        recordKind: 'Decision',
        fromState: 'rejected',
        toState: 'approved',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_transition');
  });
});

describe('routeTransition — typed failures', () => {
  test('unknown kind → unknown_kind', () => {
    const r = routeTransition(makeMessage({ kind: 'incident' as Kind }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_kind');
  });

  test('unknown transition (kind valid but not in tables) → unknown_transition', () => {
    const r = routeTransition(
      makeMessage({ kind: 'goal', fromState: 'achieved', toState: 'proposed' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_transition');
  });

  test('transitionKey is set on every result (debugging)', () => {
    const r = routeTransition(makeMessage());
    expect(r.transitionKey).toBe('goal:proposed→accepted');
    const fail = routeTransition(makeMessage({ fromState: 'achieved', toState: 'proposed' }));
    expect(fail.transitionKey).toBe('goal:achieved→proposed');
  });
});

describe('routeTransition — actor-irrelevance for non-__initial__ transitions', () => {
  // The invariant: actor is NOT part of the routing key for normal
  // transitions. EXCEPTION: __initial__ transitions where human vs agent
  // distinguishes "agent already running" from "human needs agent
  // dispatched" (covered by the actor=human tests above).
  test('Goal proposed → accepted routes to SpecAgent regardless of actor', () => {
    const actors: Actor[] = ['human', 'SpecAgent', 'system'];
    for (const actor of actors) {
      const r = routeTransition(makeMessage({ actor }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.agent).toBe('SpecAgent');
    }
  });
});
