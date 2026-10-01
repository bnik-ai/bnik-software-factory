import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { InMemoryAgentDispatcher } from '../src/agentDispatcher.js';
import { __test, runConsumerLoop } from '../src/mainConsumer.js';
import { InMemoryEventQueueConsumer } from '../src/queueConsumer.js';
import { routeTransition } from '../src/routingTable.js';
import type { ParsedTransitionMessage } from '../src/types.js';

const {
  resolvePollIntervalMs,
  resolveMaxBatchSize,
  resolveIdleExitAfterEmptyPolls,
  resolveBranchSyncWiring,
  resolveTargetRepoAllowlist,
} = __test;

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

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('env resolvers', () => {
  test('defaults when unset', () => {
    expect(withEnv({ POLL_INTERVAL_MS: undefined }, resolvePollIntervalMs)).toBe(1000);
    expect(withEnv({ MAX_BATCH_SIZE: undefined }, resolveMaxBatchSize)).toBe(10);
    expect(
      withEnv({ IDLE_EXIT_AFTER_EMPTY_POLLS: undefined }, resolveIdleExitAfterEmptyPolls),
    ).toBe(5);
  });

  test('throw on out-of-range values', () => {
    expect(() => withEnv({ POLL_INTERVAL_MS: '49' }, resolvePollIntervalMs)).toThrow(/not a valid/);
    expect(() => withEnv({ MAX_BATCH_SIZE: '257' }, resolveMaxBatchSize)).toThrow(/not a valid/);
    expect(() =>
      withEnv({ IDLE_EXIT_AFTER_EMPTY_POLLS: '61' }, resolveIdleExitAfterEmptyPolls),
    ).toThrow(/not a valid/);
  });
});

describe('resolveBranchSyncWiring (ADR 0012 item 5 activation b)', () => {
  test('no env set → undefined wiring (v0 pass-through)', () => {
    const result = withEnv(
      { GITHUB_TOKEN: undefined, GITHUB_OWNER: undefined, GITHUB_REPO: undefined },
      resolveBranchSyncWiring,
    );
    expect(result.substrateClient).toBeUndefined();
    expect(result.branchSyncChecker).toBeUndefined();
  });

  test('all three env vars set → real GithubCompareBranchSyncChecker + GithubSubstrateClient', () => {
    const result = withEnv(
      { GITHUB_TOKEN: 'ghp_test', GITHUB_OWNER: 'example-org', GITHUB_REPO: 'software-factory' },
      resolveBranchSyncWiring,
    );
    expect(result.substrateClient).toBeDefined();
    expect(result.branchSyncChecker).toBeDefined();
    expect(result.branchSyncChecker?.constructor.name).toBe('GithubCompareBranchSyncChecker');
  });

  test('partial config (only token set) → throws so a half-deploy fails loudly', () => {
    expect(() =>
      withEnv(
        { GITHUB_TOKEN: 'ghp_test', GITHUB_OWNER: undefined, GITHUB_REPO: undefined },
        resolveBranchSyncWiring,
      ),
    ).toThrow(/must be set together/);
  });

  test('partial config (token + owner, repo missing) → throws', () => {
    expect(() =>
      withEnv(
        { GITHUB_TOKEN: 'ghp_test', GITHUB_OWNER: 'example-org', GITHUB_REPO: undefined },
        resolveBranchSyncWiring,
      ),
    ).toThrow(/must be set together/);
  });
});

describe('resolveTargetRepoAllowlist (AGENT_TARGET_REPOS)', () => {
  test('unset or blank → undefined (no filtering, backward compat)', () => {
    expect(withEnv({ AGENT_TARGET_REPOS: undefined }, resolveTargetRepoAllowlist)).toBeUndefined();
    expect(withEnv({ AGENT_TARGET_REPOS: '' }, resolveTargetRepoAllowlist)).toBeUndefined();
    expect(withEnv({ AGENT_TARGET_REPOS: '  ' }, resolveTargetRepoAllowlist)).toBeUndefined();
  });

  test('single repo → one-entry set', () => {
    const allowlist = withEnv(
      { AGENT_TARGET_REPOS: 'example-owner/sample-app' },
      resolveTargetRepoAllowlist,
    );
    expect(allowlist).toEqual(new Set(['example-owner/sample-app']));
  });

  test('comma-separated list with whitespace → trimmed set', () => {
    const allowlist = withEnv(
      { AGENT_TARGET_REPOS: ' example-owner/sample-app , example-org/software-factory ' },
      resolveTargetRepoAllowlist,
    );
    expect(allowlist).toEqual(
      new Set(['example-owner/sample-app', 'example-org/software-factory']),
    );
  });

  test('malformed entry (not owner/repo) throws so a typo fails loudly at boot instead of silently filtering everything', () => {
    expect(() => withEnv({ AGENT_TARGET_REPOS: 'sample-app' }, resolveTargetRepoAllowlist)).toThrow(
      /not a valid owner\/repo/,
    );
    expect(() => withEnv({ AGENT_TARGET_REPOS: 'a/b,c/d/e' }, resolveTargetRepoAllowlist)).toThrow(
      /not a valid owner\/repo/,
    );
  });
});

describe('runConsumerLoop — repo-targeting filter acks cleanly', () => {
  test('non-target-repo message acks without dispatch; targeted message dispatches', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const dispatcher = new InMemoryAgentDispatcher();
    consumer.enqueue(
      makeMessage({
        lockToken: 'lt-foreign',
        deliveryId: 'd-f',
        repoFullName: 'example-org/software-factory',
      }),
    );
    consumer.enqueue(
      makeMessage({
        lockToken: 'lt-target',
        deliveryId: 'd-t',
        repoFullName: 'example-owner/sample-app',
      }),
    );
    const controller = new AbortController();

    const loop = runConsumerLoop({
      consumer,
      dispatcher,
      router: routeTransition,
      signal: controller.signal,
      pollIntervalMs: 50,
      targetRepoAllowlist: new Set(['example-owner/sample-app']),
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop;

    // Both settle as clean acks (repo_not_targeted is an ack like
    // no_dispatch); only the targeted message reached the router/dispatcher.
    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['lt-foreign', 'lt-target']);
    expect(consumer.deadletteredMessages()).toHaveLength(0);
    expect(dispatcher.attemptCount()).toBe(1);
  });
});

describe('runConsumerLoop — happy path', () => {
  test('processes a batch + acks all + exits when signal aborts', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const dispatcher = new InMemoryAgentDispatcher();
    consumer.enqueue(makeMessage({ lockToken: 'lt-1', deliveryId: 'd-1' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-2', deliveryId: 'd-2' }));
    const controller = new AbortController();

    const loop = runConsumerLoop({
      consumer,
      dispatcher,
      router: routeTransition,
      signal: controller.signal,
      pollIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop;

    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['lt-1', 'lt-2']);
    expect(dispatcher.attemptCount()).toBe(2); // both goal:proposed→accepted route to SpecAgent
  });

  test('deadletters routing-failure messages', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const dispatcher = new InMemoryAgentDispatcher();
    consumer.enqueue(
      makeMessage({ lockToken: 'lt-1', fromState: 'achieved', toState: 'proposed' }),
    );
    const controller = new AbortController();

    const loop = runConsumerLoop({
      consumer,
      dispatcher,
      router: routeTransition,
      signal: controller.signal,
      pollIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop;

    expect(consumer.deadletteredMessages()).toHaveLength(1);
    expect(consumer.ackedMessages()).toHaveLength(0);
    expect(dispatcher.attemptCount()).toBe(0);
  });
});

describe('runConsumerLoop — Container Apps Job idle-drain exit', () => {
  test('exits cleanly after N consecutive empty polls', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const dispatcher = new InMemoryAgentDispatcher();
    const controller = new AbortController();
    const start = Date.now();

    await runConsumerLoop({
      consumer,
      dispatcher,
      router: routeTransition,
      signal: controller.signal,
      pollIntervalMs: 10,
      idleExitAfterEmptyPolls: 3,
    });

    expect(Date.now() - start).toBeLessThan(500);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('runConsumerLoop — error ends the execution (session-order preserved)', () => {
  test('first message error → loop returns without further polls', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const failingDispatcher = {
      dispatch: vi.fn(async () => {
        throw new Error('dispatcher is down');
      }),
    };
    consumer.enqueue(makeMessage({ lockToken: 'lt-1', deliveryId: 'd-1' }));
    consumer.enqueue(makeMessage({ lockToken: 'lt-2', deliveryId: 'd-2' }));
    const errors: { deliveryId: string; message: string }[] = [];

    await runConsumerLoop({
      consumer,
      dispatcher: failingDispatcher,
      router: routeTransition,
      signal: new AbortController().signal,
      pollIntervalMs: 50,
      onError: (deliveryId, err) => errors.push({ deliveryId, message: err.message }),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.deliveryId).toBe('d-1');
    expect(consumer.ackedMessages()).toHaveLength(0);
    expect(consumer.deadletteredMessages()).toHaveLength(0);
    expect(consumer.inflightCount()).toBe(2);
  });
});

describe('runConsumerLoop — transient retry leaves message unsettled', () => {
  // Stub: always reports "behind" so processMessage's branch-sync gate
  // dispatches the synthetic BuildAgent rebase. Pairs with a transient
  // dispatcher so processMessage returns action:'retry'.
  class BehindChecker {
    async checkSync(): Promise<{ ok: true; status: 'behind'; behindBy: number }> {
      return { ok: true, status: 'behind', behindBy: 2 };
    }
  }
  function makePrReviewTriggerMsg(): ParsedTransitionMessage {
    return makeMessage({
      kind: 'pr',
      recordType: 'PullRequest',
      recordKind: 'pr',
      recordId: 'PR_kwAOA_42',
      fromState: 'open',
      toState: 'in_review',
      eventType: 'webhook:pull_request',
      actor: 'human',
      headBranch: 'sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
      baseBranch: 'main',
    });
  }

  test('rebase dispatch transient → loop exits, message unsettled (no ack, no deadletter)', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const transientDispatcher = {
      dispatch: vi.fn(async () => ({
        ok: false as const,
        agent: 'BuildAgent' as const,
        reason: 'enqueue_failed:agent-runs-build:ServerBusy',
        transient: true,
      })),
    };
    consumer.enqueue(makePrReviewTriggerMsg());

    await runConsumerLoop({
      consumer,
      dispatcher: transientDispatcher,
      router: routeTransition,
      signal: new AbortController().signal,
      pollIntervalMs: 50,
      branchSyncChecker: new BehindChecker(),
    });

    // The retry branch returns BEFORE settling: no ack, no deadletter,
    // message stays inflight. SB will redeliver on next job execution.
    expect(consumer.ackedMessages()).toHaveLength(0);
    expect(consumer.deadletteredMessages()).toHaveLength(0);
    expect(consumer.inflightCount()).toBe(1);
    expect(transientDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  test('rebase dispatch DETERMINISTIC failure → ack (not retry, no redelivery loop)', async () => {
    const consumer = new InMemoryEventQueueConsumer();
    const deterministicDispatcher = {
      dispatch: vi.fn(async () => ({
        ok: false as const,
        agent: 'BuildAgent' as const,
        reason: 'unauthorized',
        transient: false,
      })),
    };
    consumer.enqueue(makePrReviewTriggerMsg());

    await runConsumerLoop({
      consumer,
      dispatcher: deterministicDispatcher,
      router: routeTransition,
      signal: new AbortController().signal,
      pollIntervalMs: 50,
      idleExitAfterEmptyPolls: 2,
      branchSyncChecker: new BehindChecker(),
    });

    // Deterministic → ack with rebaseDispatchError; no redelivery.
    expect(consumer.ackedMessages()).toHaveLength(1);
    expect(consumer.deadletteredMessages()).toHaveLength(0);
  });
});
