import type { RuntimeConfig } from '../config.js';
import type { Issue } from '../github/client.js';
import {
  type Foundation,
  type GateGitHub,
  type Pair,
  type Pull,
  assertPairTask,
  assertPull,
  headRepositoryIds,
  writeCollaborator,
} from '../github/merge-gate.js';
export { headRepositoryIds };
import {
  type CheckRun,
  type MergePolicy,
  type Protection,
  type Review,
  classifyChecks,
  digest,
  latestReviews,
  requireGate,
  verifyProtection,
} from '../github/merge-policy.js';
import type { ApprovalRecord, MergeGateObservation } from './evidence.js';
import type { AutonomyPolicy } from './policy.js';
import { requireAutonomy } from './schema.js';

/**
 * Trusted merge-gate observation (OSS-21). Reads the pull request, its Task, the base
 * branch protection, CODEOWNERS, required check runs and reviews from GitHub and writes
 * the graded facts the policy consumes (`mergeGateReasons`). Pairing or repository
 * anomalies throw (the merge is refused with that reason); protection, checks and reviews
 * are reported as fields so the decision can hold or repair instead of failing opaquely.
 * Nothing here writes to GitHub.
 */
export interface MergeExpectation {
  head: string;
  tree: string;
  base: string;
}
export interface MergeObservation {
  observation: MergeGateObservation;
  pull: Pull;
  task: Issue;
  foundation: Foundation;
  /** Latest review per user, bounded to the observation time. */
  reviews: Review[];
  checks: CheckRun[];
  protectionReason: string | null;
  /** Merge-policy reviewer logins (lowercase): the humans whose approval reconciliation accepts. */
  reviewers: readonly string[];
}
const SHA = /^[0-9a-f]{40}$/;

export async function observeMergeGate(
  config: RuntimeConfig,
  github: GateGitHub,
  pair: Pair,
  expectation: MergeExpectation,
  now: () => number,
): Promise<MergeObservation> {
  requireGate(config.mode === 'live' && config.mergePolicy, 'merge_policy_not_configured');
  const policy: MergePolicy = config.mergePolicy;
  requireAutonomy(SHA.test(expectation.head), 'merge_expectation_invalid');
  requireAutonomy(SHA.test(expectation.tree), 'merge_expectation_invalid');
  requireAutonomy(SHA.test(expectation.base), 'merge_expectation_invalid');
  await github.check();
  const prefix = `/repos/${config.repository}`;
  const repo = await github.read<{
    id: number;
    default_branch: string;
    archived: boolean;
    disabled: boolean;
    allow_auto_merge: boolean;
    allow_squash_merge: boolean;
    allow_merge_commit: boolean;
    allow_rebase_merge: boolean;
  }>(prefix);
  requireGate(
    repo.id === pair.repositoryId &&
      repo.default_branch === policy.baseBranch &&
      !repo.archived &&
      !repo.disabled &&
      repo.allow_auto_merge === false &&
      repo.allow_squash_merge === true &&
      repo.allow_merge_commit === false &&
      repo.allow_rebase_merge === false,
    'repository_merge_settings_unsafe',
  );
  const pull = await github.read<Pull>(`${prefix}/pulls/${pair.pullNumber}`);
  assertPull(config, pair, pull, { headRepositoryIds: headRepositoryIds(config) });
  const task = await github.read<Issue>(`${prefix}/issues/${pair.taskNumber}`);
  assertPairTask(pair, task, pull.merged);
  // The published head's tree is what the policy compares with the tested tree.
  const headCommit = await github.read<{ sha: string; tree: { sha: string } }>(
    `${prefix}/git/commits/${pull.head.sha}`,
  );
  requireGate(
    headCommit.sha === pull.head.sha && SHA.test(headCommit.tree?.sha),
    'head_commit_unreadable',
  );
  const protection = await github.read<Protection>(
    `${prefix}/branches/${encodeURIComponent(policy.baseBranch)}/protection`,
  );
  const codeowners = await github.codeowners(pull.base.sha);
  let protectionReason: string | null = null;
  try {
    verifyProtection(policy, protection, codeowners);
    requireGate(
      (await github.codeowners(pull.head.sha)) === codeowners,
      'codeowners_changed_in_pull',
    );
  } catch (error) {
    protectionReason = error instanceof Error ? error.message : 'protection_unverified';
  }
  const observedAt = now();
  const checks = await github.list<CheckRun>('checks', pull.head.sha);
  const latest = latestReviews(
    await github.list<Review>('reviews', String(pull.number)),
    pull.merged ? Date.parse(pull.merged_at ?? '') : observedAt + 60_000,
  );
  // As on GitHub, a request for changes counts from a human with write access or from an
  // installed App; any other account's review is visible but cannot hold every pull request.
  // An approval by a listed reviewer without write access is one GitHub's protection ignores
  // and the merge would be refused on: it is dropped here so no admission rests on it.
  const reviews: Review[] = [];
  for (const review of latest) {
    if (
      review.state === 'APPROVED' &&
      review.user.type === 'User' &&
      review.commit_id === pull.head.sha &&
      policy.reviewers.includes(review.user.login.toLowerCase()) &&
      !(await writeCollaborator(github, prefix, review.user.login.toLowerCase(), review.user.id))
    )
      continue;
    reviews.push(review);
  }
  let changesRequested = false;
  for (const review of reviews)
    if (
      review.state === 'CHANGES_REQUESTED' &&
      (review.user.type === 'Bot' ||
        (review.user.type === 'User' &&
          (await writeCollaborator(
            github,
            prefix,
            review.user.login.toLowerCase(),
            review.user.id,
          ))))
    ) {
      changesRequested = true;
      break;
    }
  // Re-read after the paginated reads: a moving head cannot reuse this observation.
  const fresh = await github.read<Pull>(`${prefix}/pulls/${pull.number}`);
  requireGate(
    fresh.state === pull.state &&
      !fresh.auto_merge &&
      fresh.head.sha === pull.head.sha &&
      fresh.base.sha === pull.base.sha &&
      fresh.merged === pull.merged &&
      fresh.body === pull.body &&
      !fresh.draft,
    'pull_changed_during_review',
  );
  const foundation: Foundation = {
    head: pull.head.sha,
    base: pull.base.sha,
    policyHash: digest(policy),
    protectionHash: digest(protection),
    codeownersHash: digest(codeowners),
    observedAt: new Date(observedAt).toISOString(),
  };
  const observation: MergeGateObservation = {
    version: 1,
    kind: 'merge_gate',
    repositoryId: pair.repositoryId,
    pullNumber: pull.number,
    head: pull.head.sha,
    headTree: headCommit.tree.sha,
    base: pull.base.sha,
    baseBranch: pull.base.ref,
    pullState: pull.merged ? 'merged' : pull.state === 'open' ? 'open' : 'closed',
    requiredChecks: classifyChecks(policy, checks, pull.head.sha),
    changesRequested,
    protectionVerified: protectionReason === null,
    observedAt,
  };
  return {
    observation,
    pull,
    task,
    foundation,
    reviews,
    checks,
    protectionReason,
    reviewers: policy.reviewers,
  };
}

/**
 * Native GitHub reviews on the exact head by configured approvers become ledger approval
 * records bound to the merge action digest. The pull request author, bots, unlisted users,
 * reviews of another commit and superseded reviews never count; the ledger still admits each
 * approval once. `reviewers` are the merge policy's reviewer logins: reconciliation accepts
 * a human approval only from them, so an approver outside that list cannot unlock a merge
 * the gate would then park.
 */
export function approvalsFromReviews(
  policy: AutonomyPolicy,
  reviews: Review[],
  head: string,
  authorId: number,
  actionSha256: string,
  reviewers: readonly string[],
): { approval: ApprovalRecord; evidence: { reviewId: number; head: string } }[] {
  requireAutonomy(/^[0-9a-f]{64}$/.test(actionSha256), 'approval_action_invalid');
  return latestReviews(reviews)
    .filter(
      (review) =>
        review.state === 'APPROVED' &&
        review.commit_id === head &&
        review.user.type === 'User' &&
        review.user.id !== authorId &&
        policy.approvers.githubUserIds.includes(review.user.id) &&
        reviewers.includes(review.user.login.toLowerCase()),
    )
    .map((review) => ({
      approval: {
        version: 1,
        kind: 'approval',
        actionSha256,
        action: 'merge',
        approver: { githubUserId: review.user.id, type: 'User' },
        source: 'github_review',
        approvedAt: Date.parse(review.submitted_at),
      },
      evidence: { reviewId: review.id, head },
    }));
}
