import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { ParsedTransitionMessage } from '../src/queueConsumer.js';
import { runReviewLoopAssertions } from '../src/reviewLoopAssertions.js';
import { InMemorySubstrateClient } from '../src/substrateClient.js';

// Spec: docs/decisions/0010-multi-model-review-loop.md §"Substrate constraints"
// (pairwise-distinct model invariant + Review-required-before-merge);
// docs/design/review-agent.md §3 (model-segment comparison) + §6 (the
// rule the validator must gain). The runner fires on `pr:in_review→approved`
// only; everything else is silent-ok.

// ADR 0008 §2: ULID = 26-char Crockford base32 (no I/L/O/U).
const RUN_REVIEWER = '01HZX0000000000000000000RV';
const RUN_ADJUDICATOR = '01HZX0000000000000000000AJ';
const RUN_AUTHOR = '01HZX0000000000000000000AT';
const TASK = 'T-42';

function makePrApprovalMessage(
  overrides: Partial<ParsedTransitionMessage> = {},
): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:pull_request_review.submitted',
    kind: 'pr',
    actor: 'ReviewAgent',
    recordType: 'PullRequest',
    recordKind: 'PullRequest',
    recordId: 'PR_kwAOPR_1',
    fromState: 'in_review',
    toState: 'approved',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

function stamp(model: string, run: string): string {
  return `<!-- sf:structural sf:agent=review@${model} run=${run} -->`;
}

// Issue #178 rev6: the verdict=approve marker — the ONLY structural shape the
// review-required assertion accepts as evidence.
function approveStamp(model: string, run: string): string {
  return `<!-- sf:structural sf:agent=review@${model} run=${run} verdict=approve -->`;
}

function reviewBody(reviewerModel: string, adjudicatorModel: string): string {
  return [
    stamp(reviewerModel, RUN_REVIEWER),
    'Reviewer findings — normalized triage embedded here.',
    stamp(adjudicatorModel, RUN_ADJUDICATOR),
    'Adjudicator verdicts.',
  ].join('\n\n');
}

function seedHappyApprovedPr(
  substrate: InMemorySubstrateClient,
  opts: { reviewerModel: string; adjudicatorModel: string; authorModel: string },
): void {
  substrate.seedPullRequest('PR_kwAOPR_1', {
    headRef: `sf/${TASK}/${RUN_AUTHOR}/build@${opts.authorModel}`,
  });
  substrate.seedReview('PR_kwAOPR_1', {
    recordId: 'REV_1',
    state: 'approved',
    body: reviewBody(opts.reviewerModel, opts.adjudicatorModel),
  });
}

describe('runReviewLoopAssertions — not-applicable paths are silent', () => {
  test.each([
    ['goal', 'proposed', 'accepted'],
    ['spec', 'drafting', 'ready_for_review'],
    ['design', 'drafting', 'ready_for_review'],
    ['task', 'proposed', 'ready'],
    ['deployment', 'pending', 'success'],
    ['decision', 'proposed', 'approved'],
  ] as const)('%s message: ok=true (not a PR approval surface)', async (kind, from, to) => {
    const substrate = new InMemorySubstrateClient();
    const result = await runReviewLoopAssertions(
      makePrApprovalMessage({ kind, fromState: from, toState: to, recordId: `I_${kind}_1` }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });

  test('PR transition other than in_review→approved: ok=true', async () => {
    const substrate = new InMemorySubstrateClient();
    const result = await runReviewLoopAssertions(
      makePrApprovalMessage({ fromState: 'draft', toState: 'open', actor: 'BuildAgent' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });

  test('PR approved→in_review regression: ok=true (not a review-required surface)', async () => {
    const substrate = new InMemorySubstrateClient();
    const result = await runReviewLoopAssertions(
      makePrApprovalMessage({ fromState: 'approved', toState: 'in_review', actor: 'system' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('runReviewLoopAssertions — Rule 2: Review-required-before-merge', () => {
  test('pr:in_review→approved with zero Review records → pr_approved_without_review', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@sonnet-4.5`,
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('pr_approved_without_review');
    expect(result.detail).toContain('PR_kwAOPR_1');
  });

  test('pr:in_review→approved with only changes_requested Reviews → pr_approved_without_review', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@sonnet-4.5`,
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_1',
      state: 'changes_requested',
      body: reviewBody('opus-4.7', 'haiku-4.5'),
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('pr_approved_without_review');
  });
});

describe('runReviewLoopAssertions — Rule 1: model-segment pairwise inequalities', () => {
  test('reviewer model equals author model → reviewer_model_equals_author', async () => {
    const substrate = new InMemorySubstrateClient();
    seedHappyApprovedPr(substrate, {
      reviewerModel: 'sonnet-4.5',
      adjudicatorModel: 'haiku-4.5',
      authorModel: 'sonnet-4.5',
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('reviewer_model_equals_author');
    expect(result.detail).toContain('sonnet-4.5');
  });

  test('adjudicator model equals author model → adjudicator_model_equals_author', async () => {
    const substrate = new InMemorySubstrateClient();
    seedHappyApprovedPr(substrate, {
      reviewerModel: 'opus-4.7',
      adjudicatorModel: 'sonnet-4.5',
      authorModel: 'sonnet-4.5',
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('adjudicator_model_equals_author');
  });

  test('adjudicator model equals reviewer model → adjudicator_model_equals_reviewer', async () => {
    const substrate = new InMemorySubstrateClient();
    seedHappyApprovedPr(substrate, {
      reviewerModel: 'opus-4.7',
      adjudicatorModel: 'opus-4.7',
      authorModel: 'sonnet-4.5',
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('adjudicator_model_equals_reviewer');
  });

  test('three distinct models (reviewer, adjudicator, author) → ok=true', async () => {
    const substrate = new InMemorySubstrateClient();
    seedHappyApprovedPr(substrate, {
      reviewerModel: 'opus-4.7',
      adjudicatorModel: 'haiku-4.5',
      authorModel: 'sonnet-4.5',
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result).toEqual({ ok: true });
  });

  test('approved Review with no parseable stamps → pr_approved_with_noncompliant_review', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@sonnet-4.5`,
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_unstamped',
      state: 'approved',
      body: 'Approved — no structural attribution comment present.',
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('pr_approved_with_noncompliant_review');
    expect(result.detail).toContain('REV_unstamped');
  });
});

describe('runReviewLoopAssertions — author-model recovery', () => {
  test('author model recovered from head-commit SF-Agent trailer when headRef missing', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headCommitMessage: [
        'fix(prFsm): reword reject reasons',
        '',
        'SF-Agent: build@sonnet-4.5',
        `SF-Run: ${RUN_AUTHOR}`,
        `SF-Task: ${TASK}`,
      ].join('\n'),
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_1',
      state: 'approved',
      body: reviewBody('sonnet-4.5', 'haiku-4.5'),
    });
    // reviewerModel == authorModel via trailer fallback → must trip
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('reviewer_model_equals_author');
  });

  test('headRef wins over headCommitMessage when both present (ADR 0009 rule 4)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@sonnet-4.5`,
      // Trailer claims opus, ref claims sonnet — ref wins. Reviewer is opus,
      // so this should PASS (reviewer != author via ref-derived author).
      headCommitMessage: `chore: x\n\nSF-Agent: build@opus-4.7\nSF-Run: ${RUN_AUTHOR}\nSF-Task: ${TASK}`,
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_1',
      state: 'approved',
      body: reviewBody('opus-4.7', 'haiku-4.5'),
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result).toEqual({ ok: true });
  });

  test('PR view absent → author-relative checks skipped, pairwise reviewer/adjudicator still enforced', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_1',
      state: 'approved',
      body: reviewBody('opus-4.7', 'opus-4.7'),
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('adjudicator_model_equals_reviewer');
  });

  test('PR view absent + reviewer/adjudicator pairwise-distinct → ok (silent on author-side)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_1',
      state: 'approved',
      body: reviewBody('opus-4.7', 'haiku-4.5'),
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result).toEqual({ ok: true });
  });

  test('non-SF headRef (human-opened PR) falls back to trailer parsing', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: 'main', // not an sf/<task>/<run>/<agent> branch
      headCommitMessage: `chore: x\n\nSF-Agent: build@sonnet-4.5\nSF-Run: ${RUN_AUTHOR}\nSF-Task: ${TASK}`,
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_1',
      state: 'approved',
      body: reviewBody('sonnet-4.5', 'haiku-4.5'),
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('reviewer_model_equals_author');
  });
});

describe('runReviewLoopAssertions — multi-Review history', () => {
  test('last approved Review wins (post-approval regression then re-approval)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@sonnet-4.5`,
    });
    // First approval was non-compliant (reviewer == author), regressed,
    // re-approved with compliant stamps. The terminal approved Review is
    // what the validator must judge.
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_stale',
      state: 'approved',
      body: reviewBody('sonnet-4.5', 'haiku-4.5'),
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_revision',
      state: 'changes_requested',
      body: reviewBody('opus-4.7', 'haiku-4.5'),
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_final',
      state: 'approved',
      body: reviewBody('opus-4.7', 'haiku-4.5'),
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result).toEqual({ ok: true });
  });

  test('changes_requested rounds interleaved with the final approved Review are ignored', async () => {
    const substrate = new InMemorySubstrateClient();
    seedHappyApprovedPr(substrate, {
      reviewerModel: 'opus-4.7',
      adjudicatorModel: 'haiku-4.5',
      authorModel: 'sonnet-4.5',
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_round1',
      state: 'changes_requested',
      body: reviewBody('sonnet-4.5', 'sonnet-4.5'), // self-equal, but state != approved → ignored
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result).toEqual({ ok: true });
  });
});

describe('runReviewLoopAssertions — structuralComments split surface', () => {
  test('reviewer + adjudicator parsed from structuralComments when set', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@sonnet-4.5`,
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_1',
      state: 'approved',
      body: 'Triage prose without inline comments.',
      structuralComments: [stamp('opus-4.7', RUN_REVIEWER), stamp('haiku-4.5', RUN_ADJUDICATOR)],
    });
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result).toEqual({ ok: true });
  });
});

describe('runReviewLoopAssertions — structural review evidence (issue #178 rev5)', () => {
  test('App-authored review@<model> marker comment + distinct author model → ok (no native Review needed)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@opus-4-7`,
    });
    substrate.setComments('PR_kwAOPR_1', [
      `${approveStamp('sonnet-4-6', RUN_REVIEWER)}\nStructural findings: APPROVE.`,
    ]);
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result).toEqual({ ok: true });
  });

  test('structural reviewer model EQUALS author model → reviewer_model_equals_author', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@opus-4-7`,
    });
    substrate.setComments('PR_kwAOPR_1', [
      `${approveStamp('opus-4-7', RUN_REVIEWER)}\nStructural findings: APPROVE.`,
    ]);
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.assertion).toBe('reviewer_model_equals_author');
  });

  test('forged (human-authored) review marker is ignored → falls through to native path', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setComments(
      'PR_kwAOPR_1',
      [`${approveStamp('sonnet-4-6', RUN_REVIEWER)}\nForged.`],
      'mallory', // not an App-bot login → marker untrusted
    );
    // Native path: no approved Review seeded → Rule 2 fires.
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.assertion).toBe('pr_approved_without_review');
  });

  test('claim/request-changes marker WITHOUT verdict=approve never satisfies the assertion (rev6)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setComments('PR_kwAOPR_1', [
      `${stamp('sonnet-4-6', RUN_REVIEWER)}\nReview claimed.`, // claim: no verdict attr
    ]);
    // Falls through to the native path: no approved Review seeded → Rule 2.
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.assertion).toBe('pr_approved_without_review');
  });

  test('no marker + native getReviewsForPr THROWS (live #164 deferral) → FAIL CLOSED, never a crash (rev10)', async () => {
    const substrate = new InMemorySubstrateClient();
    const throwing = new Proxy(substrate, {
      get(target, prop, receiver) {
        if (prop === 'getReviewsForPr') {
          return () => {
            throw new Error('GithubSubstrateClient.getReviewsForPr not implemented');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    // Evidence-less approval must not pass the gate: soft-flag (recorded,
    // OpsAgent verdict-gated, human completes the merge) — and never a throw
    // that would crash the consumer into a redelivery loop.
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), throwing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.assertion).toBe('pr_approved_without_review');
  });
});

describe('runReviewLoopAssertions — stale approve markers never satisfy (issue #178 rev7)', () => {
  test('older verdict=approve + NEWER claim/request-changes marker → no structural evidence (falls to native Rule 2)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setComments('PR_kwAOPR_1', [
      `${approveStamp('sonnet-4-6', RUN_REVIEWER)}\nRound 1: approved.`, // older
      `${stamp('sonnet-4-6', RUN_ADJUDICATOR)}\nRound 2: re-review claimed.`, // newest, non-approve
    ]);
    const result = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.assertion).toBe('pr_approved_without_review');
  });
});

describe('runReviewLoopAssertions — structural path is ReviewAgent-actor-only (issue #178 rev11)', () => {
  test('human-actor approval ignores even a fresh approve marker → native evidence required', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setComments('PR_kwAOPR_1', [
      `${approveStamp('sonnet-4-6', RUN_REVIEWER)}\nRound 1 structural approval.`,
    ]);
    // Human re-approved after a regression: the stale marker must not satisfy.
    const result = await runReviewLoopAssertions(
      makePrApprovalMessage({ actor: 'human' }),
      substrate,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.assertion).toBe('pr_approved_without_review');
  });

  test('threaded appBotLogins set authenticates a custom App slug marker', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@opus-4-7`,
    });
    substrate.setComments(
      'PR_kwAOPR_1',
      [`${approveStamp('sonnet-4-6', RUN_REVIEWER)}\nApproved.`],
      'custom-app[bot]', // NOT in the env defaults
    );
    // Without threading: untrusted marker → native path → Rule 2 fail.
    const without = await runReviewLoopAssertions(makePrApprovalMessage(), substrate);
    expect(without.ok).toBe(false);
    // With the configured set threaded: marker trusted → ok.
    const withSet = await runReviewLoopAssertions(
      makePrApprovalMessage(),
      substrate,
      new Set(['custom-app[bot]']),
    );
    expect(withSet).toEqual({ ok: true });
  });
});

describe('runReviewLoopAssertions — author model from message.headBranch (issue #178 rev13)', () => {
  test('substrate PR view unavailable + same-model headBranch on the message → reviewer_model_equals_author', async () => {
    const substrate = new InMemorySubstrateClient(); // no seedPullRequest
    substrate.setComments('PR_kwAOPR_1', [`${approveStamp('opus-4-7', RUN_REVIEWER)}\nApproved.`]);
    const result = await runReviewLoopAssertions(
      makePrApprovalMessage({ headBranch: `sf/${TASK}/${RUN_AUTHOR}/build@opus-4-7` }),
      substrate,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.assertion).toBe('reviewer_model_equals_author');
  });

  test('substrate PR view unavailable + DISTINCT-model headBranch → ok', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setComments('PR_kwAOPR_1', [
      `${approveStamp('sonnet-4-6', RUN_REVIEWER)}\nApproved.`,
    ]);
    const result = await runReviewLoopAssertions(
      makePrApprovalMessage({ headBranch: `sf/${TASK}/${RUN_AUTHOR}/build@opus-4-7` }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });
});
