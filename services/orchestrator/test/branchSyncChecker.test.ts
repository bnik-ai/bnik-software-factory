import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  AlwaysCurrentBranchSyncChecker,
  GithubCompareBranchSyncChecker,
  StubBranchSyncChecker,
  isReviewTriggerTransition,
  reviewTriggerKeys,
} from '../src/branchSyncChecker.js';
import { InMemorySubstrateClient } from '../src/substrateClient.js';
import type { ParsedTransitionMessage } from '../src/types.js';

function makeMsg(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt',
    deliveryId: 'd',
    eventType: 'webhook:pull_request',
    kind: 'pr',
    actor: 'human',
    recordType: 'PullRequest',
    recordKind: 'PR',
    recordId: 'PR_x',
    fromState: 'open',
    toState: 'in_review',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

describe('GithubCompareBranchSyncChecker (ADR 0012 item 5 activation b)', () => {
  test('behindBy > 0 → status=behind, carries behindBy/aheadBy', async () => {
    const substrateClient = new InMemorySubstrateClient();
    substrateClient.seedCompare('main', 'sf/T-1/01H/build@x', {
      ok: true,
      behindBy: 4,
      aheadBy: 2,
    });
    const checker = new GithubCompareBranchSyncChecker({
      substrateClient,
      owner: 'example-org',
      repo: 'software-factory',
    });
    const r = await checker.checkSync({
      headBranch: 'sf/T-1/01H/build@x',
      baseBranch: 'main',
      prRecordId: 'PR_1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('behind');
      expect(r.behindBy).toBe(4);
      expect(r.aheadBy).toBe(2);
    }
    // Substrate call was made with the configured owner/repo.
    expect(substrateClient.compareCallHistory()).toHaveLength(1);
    expect(substrateClient.compareCallHistory()[0]).toEqual({
      owner: 'example-org',
      repo: 'software-factory',
      base: 'main',
      head: 'sf/T-1/01H/build@x',
    });
  });

  test('behindBy === 0 → status=current', async () => {
    const substrateClient = new InMemorySubstrateClient();
    substrateClient.seedCompare('main', 'sf/T-2/01H/build@x', {
      ok: true,
      behindBy: 0,
      aheadBy: 7,
    });
    const checker = new GithubCompareBranchSyncChecker({
      substrateClient,
      owner: 'o',
      repo: 'r',
    });
    const r = await checker.checkSync({
      headBranch: 'sf/T-2/01H/build@x',
      baseBranch: 'main',
      prRecordId: 'PR_2',
    });
    expect(r.ok && r.status).toBe('current');
  });

  test('substrate failure (e.g. 404/422 from compare) → ok:false carries reason', async () => {
    const substrateClient = new InMemorySubstrateClient();
    substrateClient.seedCompare('main', 'sf/T-3/01H/build@x', {
      ok: false,
      reason: 'compare_http_404',
    });
    const checker = new GithubCompareBranchSyncChecker({
      substrateClient,
      owner: 'o',
      repo: 'r',
    });
    const r = await checker.checkSync({
      headBranch: 'sf/T-3/01H/build@x',
      baseBranch: 'main',
      prRecordId: 'PR_3',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('compare_http_404');
  });

  test('default (unseeded) substrate path → treated as current (behindBy=0)', async () => {
    const substrateClient = new InMemorySubstrateClient();
    const checker = new GithubCompareBranchSyncChecker({
      substrateClient,
      owner: 'o',
      repo: 'r',
    });
    const r = await checker.checkSync({
      headBranch: 'never-seeded',
      baseBranch: 'main',
      prRecordId: 'PR_x',
    });
    expect(r.ok && r.status).toBe('current');
  });
});

describe('AlwaysCurrentBranchSyncChecker', () => {
  test('always returns current regardless of inputs', async () => {
    const c = new AlwaysCurrentBranchSyncChecker();
    const r = await c.checkSync({ headBranch: 'x', baseBranch: 'main', prRecordId: 'PR_y' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('current');
  });
});

describe('StubBranchSyncChecker', () => {
  test('returns behind for first N calls then current', async () => {
    const c = new StubBranchSyncChecker(2, 5);
    const r1 = await c.checkSync({ headBranch: 'x', baseBranch: 'main', prRecordId: 'PR_1' });
    const r2 = await c.checkSync({ headBranch: 'x', baseBranch: 'main', prRecordId: 'PR_2' });
    const r3 = await c.checkSync({ headBranch: 'x', baseBranch: 'main', prRecordId: 'PR_3' });
    expect(r1.ok && r1.status).toBe('behind');
    expect(r2.ok && r2.status).toBe('behind');
    expect(r3.ok && r3.status).toBe('current');
    if (r1.ok) expect(r1.behindBy).toBe(5);
  });

  test('records call history for assertion', async () => {
    const c = new StubBranchSyncChecker(0);
    await c.checkSync({ headBranch: 'a', baseBranch: 'main', prRecordId: 'PR_a' });
    await c.checkSync({ headBranch: 'b', baseBranch: 'stgx', prRecordId: 'PR_b' });
    expect(c.callHistory()).toHaveLength(2);
    expect(c.callHistory()[0]?.headBranch).toBe('a');
    expect(c.callHistory()[1]?.baseBranch).toBe('stgx');
  });
});

describe('isReviewTriggerTransition + reviewTriggerKeys', () => {
  test('true for the four PR review-trigger keys', () => {
    expect(isReviewTriggerTransition(makeMsg({ fromState: '__initial__', toState: 'open' }))).toBe(
      true,
    );
    expect(isReviewTriggerTransition(makeMsg({ fromState: 'draft', toState: 'open' }))).toBe(true);
    expect(isReviewTriggerTransition(makeMsg({ fromState: 'draft', toState: 'in_review' }))).toBe(
      true,
    );
    expect(isReviewTriggerTransition(makeMsg({ fromState: 'open', toState: 'in_review' }))).toBe(
      true,
    );
  });

  test('true for task:in_progress→in_review (paired-Task review-trigger; issue #111)', () => {
    expect(
      isReviewTriggerTransition(
        makeMsg({ kind: 'task', fromState: 'in_progress', toState: 'in_review' }),
      ),
    ).toBe(true);
  });

  test('false for non-review PR transitions', () => {
    expect(
      isReviewTriggerTransition(makeMsg({ fromState: 'in_review', toState: 'approved' })),
    ).toBe(false);
    expect(isReviewTriggerTransition(makeMsg({ fromState: 'approved', toState: 'merged' }))).toBe(
      false,
    );
    expect(
      isReviewTriggerTransition(makeMsg({ fromState: 'approved', toState: 'in_review' })),
    ).toBe(false);
  });

  test('false for non-PR / non-paired-Task transitions even with matching state names', () => {
    expect(
      isReviewTriggerTransition(makeMsg({ kind: 'task', fromState: 'open', toState: 'in_review' })),
    ).toBe(false);
    expect(
      isReviewTriggerTransition(
        makeMsg({ kind: 'spec', fromState: 'drafting', toState: 'ready_for_review' }),
      ),
    ).toBe(false);
  });

  test('reviewTriggerKeys exposes the canonical set (frozen view)', () => {
    const keys = reviewTriggerKeys();
    expect(keys.size).toBe(5);
    expect(keys.has('pr:open→in_review')).toBe(true);
    expect(keys.has('task:in_progress→in_review')).toBe(true);
  });

  test('NOT gated: the bounce re-fire edges pr:syncing→in_review + pr:changes_requested→in_review (issue #192 r6: re-gating them races finishSyncBounce cleanup)', () => {
    // The bounce already re-dispatches review after the INITIAL rebase; re-gating
    // its own re-fire (or the #182 post-revision re-review) would dispatch a
    // concurrent rebase on a mid-bounce base-advance, racing finishSyncBounce's
    // label cleanup and stranding the PR (codex #200 r6). The branch is current
    // out of the bounce; OpsAgent's pre-merge sync gate is the backstop.
    expect(
      isReviewTriggerTransition(
        makeMsg({ kind: 'pr', fromState: 'syncing', toState: 'in_review' }),
      ),
    ).toBe(false);
    expect(
      isReviewTriggerTransition(
        makeMsg({ kind: 'pr', fromState: 'changes_requested', toState: 'in_review' }),
      ),
    ).toBe(false);
  });
});
