import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { InMemoryAgentDispatcher } from '../src/agentDispatcher.js';
import { AlwaysCurrentBranchSyncChecker, StubBranchSyncChecker } from '../src/branchSyncChecker.js';
import { processMessage } from '../src/processMessage.js';
import { routeTransition } from '../src/routingTable.js';
import { InMemorySubstrateClient } from '../src/substrateClient.js';
import type { Kind, ParsedTransitionMessage } from '../src/types.js';

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

function makePrReviewTriggerMessage(
  overrides: Partial<ParsedTransitionMessage> = {},
): ParsedTransitionMessage {
  return {
    lockToken: 'lt-pr-1',
    deliveryId: 'd-pr-1',
    eventType: 'webhook:pull_request',
    kind: 'pr',
    actor: 'human',
    recordType: 'PullRequest',
    recordKind: 'PR',
    recordId: 'PR_kwAOA_42',
    fromState: 'open',
    toState: 'in_review',
    payloadHash: createHash('sha256').update('pr').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    headBranch: 'sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
    baseBranch: 'main',
    ...overrides,
  };
}

describe('processMessage — routed transitions dispatch + ack', () => {
  test('goal:proposed→accepted → dispatches SpecAgent + acks with dispatch outcome', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(makeMessage(), {
      router: routeTransition,
      dispatcher,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('SpecAgent');
      expect(decision.dispatchId).toBe('disp-1');
    }
    expect(dispatcher.attemptCount()).toBe(1);
  });
});

describe('processMessage — no-dispatch transitions ack cleanly', () => {
  test('goal:in_progress→achieved → ack with no_dispatch outcome (no dispatcher call)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMessage({ fromState: 'in_progress', toState: 'achieved' }),
      { router: routeTransition, dispatcher },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'no_dispatch') {
      expect(decision.transitionKey).toBe('goal:in_progress→achieved');
    }
    expect(dispatcher.attemptCount()).toBe(0);
  });
});

describe('processMessage — routing failures deadletter', () => {
  test('unknown_kind → deadletter with reason carrying the route failure', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(makeMessage({ kind: 'incident' as Kind }), {
      router: routeTransition,
      dispatcher,
    });
    expect(decision.action).toBe('deadletter');
    if (decision.action === 'deadletter') {
      expect(decision.reason).toMatch(/^route:unknown_kind:/);
    }
    expect(dispatcher.attemptCount()).toBe(0);
  });

  test('unknown_transition → deadletter', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMessage({ fromState: 'achieved', toState: 'proposed' }),
      { router: routeTransition, dispatcher },
    );
    expect(decision.action).toBe('deadletter');
    if (decision.action === 'deadletter') {
      expect(decision.reason).toMatch(/^route:unknown_transition:/);
    }
  });
});

describe('processMessage — verdict gate', () => {
  test('verdict==="flag" → ack with verdict_gated, no dispatch (validator HARD-FLAGed)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    // The transition would otherwise dispatch SpecAgent (goal:proposed→accepted)
    // — the gate must intercept BEFORE the dispatcher is touched.
    const decision = await processMessage(makeMessage({ verdict: 'flag' }), {
      router: routeTransition,
      dispatcher,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'verdict_gated') {
      expect(decision.verdict).toBe('flag');
      expect(decision.transitionKey).toBe('goal:proposed→accepted');
    }
    expect(dispatcher.attemptCount()).toBe(0);
  });

  test('verdict==="reject" → ack with verdict_gated, no dispatch (validator HARD-REJECTed)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(makeMessage({ verdict: 'reject' }), {
      router: routeTransition,
      dispatcher,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'verdict_gated') {
      expect(decision.verdict).toBe('reject');
    }
    expect(dispatcher.attemptCount()).toBe(0);
  });

  test('verdict==="accept" → dispatches normally (positive control)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(makeMessage({ verdict: 'accept' }), {
      router: routeTransition,
      dispatcher,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('SpecAgent');
    }
    expect(dispatcher.attemptCount()).toBe(1);
  });

  test('verdict undefined → dispatches normally (v0 wire compatibility)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    // makeMessage() default has no verdict set
    const decision = await processMessage(makeMessage(), {
      router: routeTransition,
      dispatcher,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('SpecAgent');
    }
    expect(dispatcher.attemptCount()).toBe(1);
  });

  test('verdict-gate fires BEFORE routing (gated even when transition is otherwise unknown)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    // unknown_transition would normally deadletter — verdict gate intercepts first
    const decision = await processMessage(
      makeMessage({ fromState: 'achieved', toState: 'proposed', verdict: 'reject' }),
      { router: routeTransition, dispatcher },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'verdict_gated') {
      expect(decision.verdict).toBe('reject');
      expect(decision.transitionKey).toBe('goal:achieved→proposed');
    }
  });
});

describe('processMessage — branch-sync gate (ADR 0010 §re-sync)', () => {
  test('PR review-trigger with current branch → dispatches ReviewAgent (no behavior change)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(makePrReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher,
      branchSyncChecker: new AlwaysCurrentBranchSyncChecker(),
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('ReviewAgent');
    }
    expect(dispatcher.attemptCount()).toBe(1);
  });

  test('PR review-trigger with behind branch → dispatches BuildAgent rebase', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const checker = new StubBranchSyncChecker(5, 3);
    const decision = await processMessage(makePrReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher,
      branchSyncChecker: checker,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'review_blocked_by_stale_base') {
      expect(decision.transitionKey).toBe('pr:open→in_review');
      expect(decision.headBranch).toBe('sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7');
      expect(decision.baseBranch).toBe('main');
      expect(decision.behindBy).toBe(3);
      // ADR 0012 wire: BuildAgent IS dispatched with the rebase intent;
      // ReviewAgent is NOT dispatched. The rebaseDispatchId is populated.
      expect(decision.rebaseDispatchId).toBe('disp-1');
      expect(decision.rebaseDispatchError).toBeUndefined();
    }
    // Exactly ONE dispatch attempt: BuildAgent (rebase), not ReviewAgent.
    expect(dispatcher.attemptCount()).toBe(1);
    const attempt = dispatcher.dispatchAttempts()[0];
    expect(attempt?.agent).toBe('BuildAgent');
    expect(attempt?.transitionKey).toBe('pr:open→needs_sync_for_review');
    expect(attempt?.message.kind).toBe('pr');
    expect(attempt?.message.toState).toBe('needs_sync_for_review');
    expect(attempt?.message.actor).toBe('system');
    expect(attempt?.message.eventType).toBe('synthetic:branch_sync_required');
    expect(attempt?.message.deliveryId).toBe('d-pr-1:rebase');
    expect(attempt?.message.headBranch).toBe('sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7');
    // A pr:*→in_review trigger → reReviewMode='bounce' (ledger at
    // in_review, drive the syncing bounce after the rebase).
    expect(attempt?.message.reReviewMode).toBe('bounce');
    expect(checker.callHistory()).toHaveLength(1);
    expect(checker.callHistory()[0]?.prRecordId).toBe('PR_kwAOA_42');
  });

  test('rebase dispatch DETERMINISTIC failure → ack with rebaseDispatchError (no redelivery loop)', async () => {
    const checker = new StubBranchSyncChecker(1, 2);
    const failingDispatcher = {
      dispatch: async () => ({
        ok: false as const,
        agent: 'BuildAgent' as const,
        reason: 'unauthorized: missing role',
        transient: false,
      }),
    };
    const decision = await processMessage(makePrReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher: failingDispatcher,
      branchSyncChecker: checker,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'review_blocked_by_stale_base') {
      expect(decision.rebaseDispatchId).toBeUndefined();
      expect(decision.rebaseDispatchError).toBe('BuildAgent:unauthorized: missing role');
    }
  });

  test('rebase dispatch failure with transient=undefined → ack (default = deterministic, backward compat)', async () => {
    const checker = new StubBranchSyncChecker(1, 2);
    const failingDispatcher = {
      dispatch: async () => ({
        ok: false as const,
        agent: 'BuildAgent' as const,
        reason: 'queue unreachable',
      }),
    };
    const decision = await processMessage(makePrReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher: failingDispatcher,
      branchSyncChecker: checker,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'review_blocked_by_stale_base') {
      expect(decision.rebaseDispatchError).toBe('BuildAgent:queue unreachable');
    }
  });

  test('rebase dispatch TRANSIENT failure → retry (SB redelivers on fresh execution)', async () => {
    const checker = new StubBranchSyncChecker(1, 2);
    const transientDispatcher = {
      dispatch: async () => ({
        ok: false as const,
        agent: 'BuildAgent' as const,
        reason: 'enqueue_failed:agent-runs-build:ServerBusy: namespace throttled',
        transient: true,
      }),
    };
    const decision = await processMessage(makePrReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher: transientDispatcher,
      branchSyncChecker: checker,
    });
    // action: 'retry' (NOT 'deadletter'). deadletter is one-way to DLQ
    // — does not redeliver. mainConsumer translates 'retry' to "exit
    // without settling so SB redelivers on next execution".
    expect(decision.action).toBe('retry');
    if (decision.action === 'retry') {
      expect(decision.reason).toBe(
        'rebase_dispatch_transient:pr:open→in_review:BuildAgent:enqueue_failed:agent-runs-build:ServerBusy: namespace throttled',
      );
    }
  });

  test('pr:draft→in_review is also a review-trigger', async () => {
    const checker = new StubBranchSyncChecker(1);
    const decision = await processMessage(
      makePrReviewTriggerMessage({ fromState: 'draft', toState: 'in_review' }),
      {
        router: routeTransition,
        dispatcher: new InMemoryAgentDispatcher(),
        branchSyncChecker: checker,
      },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'review_blocked_by_stale_base') {
      expect(decision.transitionKey).toBe('pr:draft→in_review');
    }
  });

  test('pr:draft→open is also a review-trigger', async () => {
    const checker = new StubBranchSyncChecker(1);
    const decision = await processMessage(
      makePrReviewTriggerMessage({ fromState: 'draft', toState: 'open' }),
      {
        router: routeTransition,
        dispatcher: new InMemoryAgentDispatcher(),
        branchSyncChecker: checker,
      },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('review_blocked_by_stale_base');
  });

  test('non-review-trigger PR transition (pr:in_review→approved) → checker NOT consulted', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const checker = new StubBranchSyncChecker(5);
    const decision = await processMessage(
      makePrReviewTriggerMessage({ fromState: 'in_review', toState: 'approved' }),
      { router: routeTransition, dispatcher, branchSyncChecker: checker },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('OpsAgent');
    }
    expect(checker.callHistory()).toHaveLength(0);
  });

  test('non-PR transition (goal:proposed→accepted) → checker NOT consulted', async () => {
    const checker = new StubBranchSyncChecker(5);
    const decision = await processMessage(makeMessage(), {
      router: routeTransition,
      dispatcher: new InMemoryAgentDispatcher(),
      branchSyncChecker: checker,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('dispatched');
    expect(checker.callHistory()).toHaveLength(0);
  });

  test('review-trigger without headBranch on the message → check skipped (v0 pass-through)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const checker = new StubBranchSyncChecker(5);
    const msg = makePrReviewTriggerMessage();
    msg.headBranch = undefined;
    const decision = await processMessage(msg, {
      router: routeTransition,
      dispatcher,
      branchSyncChecker: checker,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('dispatched');
    expect(checker.callHistory()).toHaveLength(0);
  });

  test('default checker (when deps.branchSyncChecker omitted) is pass-through', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(makePrReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('dispatched');
    expect(dispatcher.attemptCount()).toBe(1);
  });

  test('checker failure (non-ok result) → deadletter rather than risk stale-base approval', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const failingChecker = {
      checkSync: async () => ({ ok: false as const, reason: 'github_api_5xx' }),
    };
    const decision = await processMessage(makePrReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher,
      branchSyncChecker: failingChecker,
    });
    expect(decision.action).toBe('deadletter');
    if (decision.action === 'deadletter') {
      expect(decision.reason).toBe('branch_sync_check_failed:pr:open→in_review:github_api_5xx');
    }
    expect(dispatcher.attemptCount()).toBe(0);
  });
});

describe('processMessage — ADR 0013 continuous-intake routing keys → PlannerAgent', () => {
  test('task:in_review→done dispatches PlannerAgent (dep-clear re-plan trigger)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        recordId: 'I_kwAOA_task_done_99',
        fromState: 'in_review',
        toState: 'done',
        actor: 'OpsAgent',
      }),
      { router: routeTransition, dispatcher },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('PlannerAgent');
    }
    expect(dispatcher.attemptCount()).toBe(1);
    const attempt = dispatcher.dispatchAttempts()[0];
    expect(attempt?.agent).toBe('PlannerAgent');
    expect(attempt?.transitionKey).toBe('task:in_review→done');
  });

  test('goal:__initial__→proposed dispatches PlannerAgent (new Goal intake)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMessage({ fromState: '__initial__', toState: 'proposed' }),
      { router: routeTransition, dispatcher },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('PlannerAgent');
    }
    expect(dispatcher.attemptCount()).toBe(1);
  });

  test('task:in_progress→abandoned dispatches PlannerAgent (any →abandoned re-plans)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        fromState: 'in_progress',
        toState: 'abandoned',
        actor: 'human',
      }),
      { router: routeTransition, dispatcher },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('PlannerAgent');
    }
    expect(dispatcher.attemptCount()).toBe(1);
  });
});

// Helper: paired-Task review-trigger message. Body fields are
// not carried on the message — the orchestrator looks them up via
// SubstrateClient.getTaskHeadBranch.
function makeTaskReviewTriggerMessage(
  overrides: Partial<ParsedTransitionMessage> = {},
): ParsedTransitionMessage {
  return {
    lockToken: 'lt-task-1',
    deliveryId: 'd-task-1',
    eventType: 'webhook:issues.labeled',
    kind: 'task',
    actor: 'BuildAgent',
    recordType: 'Issue',
    recordKind: 'Task',
    recordId: 'I_t_42',
    fromState: 'in_progress',
    toState: 'in_review',
    payloadHash: createHash('sha256').update('task').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

describe('processMessage — branch-sync gate on paired-Task path', () => {
  test('task:in_progress→in_review WITHOUT SubstrateClient → gate skipped, ReviewAgent dispatches', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const checker = new StubBranchSyncChecker(5);
    const decision = await processMessage(makeTaskReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher,
      branchSyncChecker: checker,
      // substrateClient omitted on purpose — v0 boot posture.
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('ReviewAgent');
    }
    // The checker was NOT consulted — no head/base resolved on this path
    // when no SubstrateClient is wired.
    expect(checker.callHistory()).toHaveLength(0);
  });

  test('task:in_progress→in_review WITH SubstrateClient + current branch → ReviewAgent dispatches', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const substrateClient = new InMemorySubstrateClient();
    substrateClient.seedTaskHeadBranch('I_t_42', {
      ok: true,
      value: {
        prRecordId: 'PR_kwAOA_42',
        headBranch: 'sf/T-42/01H/build@opus-4-7',
        baseBranch: 'main',
      },
    });
    const decision = await processMessage(makeTaskReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher,
      substrateClient,
      branchSyncChecker: new AlwaysCurrentBranchSyncChecker(),
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('ReviewAgent');
    }
  });

  test('task:in_progress→in_review WITH SubstrateClient + behind branch → BuildAgent rebase dispatched (PR recordId, kind=pr)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const substrateClient = new InMemorySubstrateClient();
    substrateClient.seedTaskHeadBranch('I_t_42', {
      ok: true,
      value: {
        prRecordId: 'PR_kwAOA_42',
        headBranch: 'sf/T-42/01H/build@opus-4-7',
        baseBranch: 'main',
      },
    });
    const checker = new StubBranchSyncChecker(1, 3);
    const decision = await processMessage(makeTaskReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher,
      substrateClient,
      branchSyncChecker: checker,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'review_blocked_by_stale_base') {
      expect(decision.transitionKey).toBe('task:in_progress→in_review');
      expect(decision.headBranch).toBe('sf/T-42/01H/build@opus-4-7');
      expect(decision.baseBranch).toBe('main');
      expect(decision.behindBy).toBe(3);
      expect(decision.rebaseDispatchId).toBe('disp-1');
    }
    // ONE dispatch, to BuildAgent, against the PR's recordId with kind='pr'.
    expect(dispatcher.attemptCount()).toBe(1);
    const attempt = dispatcher.dispatchAttempts()[0];
    expect(attempt?.agent).toBe('BuildAgent');
    // synthetic transition key always uses pr:<fromState>→needs_sync_for_review
    expect(attempt?.transitionKey).toBe('pr:in_progress→needs_sync_for_review');
    expect(attempt?.message.kind).toBe('pr');
    expect(attempt?.message.recordId).toBe('PR_kwAOA_42');
    expect(attempt?.message.toState).toBe('needs_sync_for_review');
    expect(attempt?.message.headBranch).toBe('sf/T-42/01H/build@opus-4-7');
    expect(attempt?.message.baseBranch).toBe('main');
    expect(attempt?.message.eventType).toBe('synthetic:branch_sync_required');
    expect(attempt?.message.actor).toBe('system');
    expect(attempt?.message.deliveryId).toBe('d-task-1:rebase');
    // The paired-Task route is a CLAIM trigger (PR ledger at open) →
    // reReviewMode='claim' so BuildAgent claims after the rebase, not the bounce.
    expect(attempt?.message.reReviewMode).toBe('claim');
    // Checker was consulted with the PR's recordId.
    expect(checker.callHistory()[0]?.prRecordId).toBe('PR_kwAOA_42');
  });

  test('SubstrateClient lookup failure (typed) → deadletter with reason', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const substrateClient = new InMemorySubstrateClient();
    // intentionally NOT seeded — unseeded → task_not_seeded reason.
    const decision = await processMessage(makeTaskReviewTriggerMessage(), {
      router: routeTransition,
      dispatcher,
      substrateClient,
      branchSyncChecker: new AlwaysCurrentBranchSyncChecker(),
    });
    expect(decision.action).toBe('deadletter');
    if (decision.action === 'deadletter') {
      expect(decision.reason).toBe(
        'branch_sync_input_lookup_failed:task:in_progress→in_review:task_not_seeded:I_t_42',
      );
    }
    // ReviewAgent NOT dispatched.
    expect(dispatcher.attemptCount()).toBe(0);
  });

  test('non-paired task transition (task:proposed→ready) → SubstrateClient NOT consulted', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const substrateClient = new InMemorySubstrateClient();
    const decision = await processMessage(
      makeTaskReviewTriggerMessage({ fromState: 'proposed', toState: 'ready' }),
      {
        router: routeTransition,
        dispatcher,
        substrateClient,
      },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('BuildAgent');
    }
    expect(substrateClient.taskCallHistory()).toHaveLength(0);
  });
});

describe('processMessage — dispatch failures deadletter', () => {
  test('failing dispatcher → deadletter with reason carrying dispatch failure', async () => {
    const failingDispatcher = {
      dispatch: async () => ({
        ok: false as const,
        agent: 'SpecAgent' as const,
        reason: 'agent unreachable',
      }),
    };
    const decision = await processMessage(makeMessage(), {
      router: routeTransition,
      dispatcher: failingDispatcher,
    });
    expect(decision.action).toBe('deadletter');
    if (decision.action === 'deadletter') {
      expect(decision.reason).toBe('dispatch:SpecAgent:agent unreachable');
    }
  });
});

describe('processMessage — repo-targeting filter (AGENT_TARGET_REPOS)', () => {
  const allowlist: ReadonlySet<string> = new Set(['example-owner/sample-app']);

  test('targeted repo → dispatches normally', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMessage({ repoFullName: 'example-owner/sample-app' }),
      {
        router: routeTransition,
        dispatcher,
        targetRepoAllowlist: allowlist,
      },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('dispatched');
    expect(dispatcher.attemptCount()).toBe(1);
  });

  test('non-target repo (SF/sample-console events from the un-suspended installation) → ack repo_not_targeted, NO routing/dispatch', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMessage({ repoFullName: 'example-org/software-factory' }),
      { router: routeTransition, dispatcher, targetRepoAllowlist: allowlist },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'repo_not_targeted') {
      expect(decision.repoFullName).toBe('example-org/software-factory');
      expect(decision.transitionKey).toBe('goal:proposed→accepted');
    } else {
      expect.fail(`expected repo_not_targeted, got ${JSON.stringify(decision)}`);
    }
    expect(dispatcher.attemptCount()).toBe(0);
  });

  test('allowlist unset → no filtering (backward compat; foreign repoFullName still dispatches)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMessage({ repoFullName: 'example-org/software-factory' }),
      { router: routeTransition, dispatcher },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('dispatched');
    expect(dispatcher.attemptCount()).toBe(1);
  });

  test('message without repoFullName (installation lifecycle / older wire) passes through even with allowlist configured', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(makeMessage(), {
      router: routeTransition,
      dispatcher,
      targetRepoAllowlist: allowlist,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('dispatched');
    expect(dispatcher.attemptCount()).toBe(1);
  });

  test('repo filter runs BEFORE the verdict gate (non-target flag-verdict message acks repo_not_targeted, not verdict_gated)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMessage({ repoFullName: 'example-org/sample-console', verdict: 'flag' }),
      { router: routeTransition, dispatcher, targetRepoAllowlist: allowlist },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('repo_not_targeted');
    expect(dispatcher.attemptCount()).toBe(0);
  });
});

describe('processMessage — any-merge Task bookkeeping', () => {
  function makeMergedMessage(
    overrides: Partial<ParsedTransitionMessage> = {},
  ): ParsedTransitionMessage {
    return {
      lockToken: 'lt-m-1',
      deliveryId: 'd-m-1',
      eventType: 'webhook:pull_request.closed',
      kind: 'pr',
      actor: 'human',
      recordType: 'PullRequest',
      recordKind: 'PR',
      recordId: 'PR_kwAOA_77',
      fromState: 'in_review',
      toState: 'merged',
      payloadHash: createHash('sha256').update('m').digest(),
      receivedAt: new Date('2026-05-30T18:00:00Z'),
      ...overrides,
    };
  }

  test('human merge (pr:in_review→merged) → dispatches OpsAgent for bookkeeping despite the FLAG verdict', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    // The validator FLAGS a human merge (human is not an allowed merge actor;
    // in_review→merged is not even a legal edge) — the carve-out must dispatch
    // OpsAgent anyway so the paired Task reaches done and dependents replan.
    const decision = await processMessage(makeMergedMessage({ verdict: 'flag' }), {
      router: routeTransition,
      dispatcher,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack' && decision.outcome === 'dispatched') {
      expect(decision.agent).toBe('OpsAgent');
    } else {
      expect.fail(`expected dispatched/OpsAgent, got ${JSON.stringify(decision)}`);
    }
    const attempt = dispatcher.dispatchAttempts()[0];
    expect(attempt?.agent).toBe('OpsAgent');
    expect(attempt?.transitionKey).toBe('pr:in_review→merged');
    // The FULL transition message is forwarded so OpsAgent has the PR recordId.
    expect(attempt?.message.recordId).toBe('PR_kwAOA_77');
    expect(attempt?.message.toState).toBe('merged');
  });

  test('autonomous App merge (pr:approved→merged, actor=OpsAgent) → NOT intercepted (bookkept inline); falls through to no_dispatch', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMergedMessage({ fromState: 'approved', actor: 'OpsAgent', verdict: 'accept' }),
      { router: routeTransition, dispatcher },
    );
    // The carve-out excludes actor=OpsAgent to avoid a second run racing the
    // inline completePairedTask; routing then returns no_dispatch for
    // pr:approved→merged. No agent dispatched.
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('no_dispatch');
    expect(dispatcher.attemptCount()).toBe(0);
  });

  test('merged carve-out runs BEFORE the verdict gate (reject verdict still dispatches bookkeeping)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(makeMergedMessage({ verdict: 'reject' }), {
      router: routeTransition,
      dispatcher,
    });
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('dispatched');
    expect(dispatcher.attemptCount()).toBe(1);
  });

  test('a non-target-repo merge still acks repo_not_targeted (carve-out is AFTER the repo gate)', async () => {
    const dispatcher = new InMemoryAgentDispatcher();
    const decision = await processMessage(
      makeMergedMessage({ repoFullName: 'example-org/sample-console', verdict: 'flag' }),
      {
        router: routeTransition,
        dispatcher,
        targetRepoAllowlist: new Set(['example-org/sample-app']),
      },
    );
    expect(decision.action).toBe('ack');
    if (decision.action === 'ack') expect(decision.outcome).toBe('repo_not_targeted');
    expect(dispatcher.attemptCount()).toBe(0);
  });

  test('OpsAgent bookkeeping dispatch failure → deadletter', async () => {
    const failingDispatcher = {
      dispatch: async () => ({
        ok: false as const,
        agent: 'OpsAgent' as const,
        reason: 'enqueue_failed:agent-runs-ops:boom',
      }),
    };
    const decision = await processMessage(makeMergedMessage({ verdict: 'flag' }), {
      router: routeTransition,
      dispatcher: failingDispatcher,
    });
    expect(decision.action).toBe('deadletter');
    if (decision.action === 'deadletter') {
      expect(decision.reason).toBe('dispatch:OpsAgent:enqueue_failed:agent-runs-ops:boom');
    }
  });
});
