import type { MergeHost, PullFacts } from '../src/autonomy/merger.js';
import { AutonomyError } from '../src/autonomy/schema.js';
import type { MergeFixture } from './merge-fixtures.js';

/**
 * In-memory merger identity bound to a MergeFixture, so observation (GitHub reads) and the
 * merge (GitHub writes) act on the same pull request. Failure knobs reproduce GitHub's
 * refusals and a connection lost after the merge happened.
 */
export const MERGER_BOT = { id: 9001, login: 'factory-merger[bot]', type: 'Bot' };
/** The App id is a different identifier from the bot user's id on GitHub. */
export const MERGER_APP_ID = 7001;
export const MERGE_COMMIT = 'c'.repeat(40);
export class FixtureMergeHost implements MergeHost {
  readonly repository = { fullName: 'example/factory-demo', id: 101 };
  readonly mergerLogin = MERGER_BOT.login;
  readonly commits = new Map<string, { tree: string; parents: string[] }>();
  calls: string[] = [];
  refuseMerge: string | null = null;
  crashAfterMerge = false;
  /** Fail before any GitHub call, as a token mint or scope check does. */
  failPerform: string | null = null;
  /** Make the produced merge commit differ from the tested tree (a proof mismatch). */
  mergeTreeOverride: string | null = null;
  /** How many times `perform` ran (one token per merge attempt). */
  performed = 0;
  constructor(
    private readonly github: MergeFixture,
    private readonly now: () => number = Date.now,
  ) {}
  async perform<T>(work: (host: MergeHost) => Promise<T>): Promise<T> {
    this.performed++;
    if (this.failPerform) throw new AutonomyError(this.failPerform);
    return work(this);
  }
  async approve(pullNumber: number, head: string, body: string) {
    this.calls.push('approve');
    if (pullNumber !== this.github.pull.number) throw new AutonomyError('github_pull_unavailable');
    const id = 500 + this.github.reviews.length;
    this.github.reviews.push({
      id,
      user: MERGER_BOT,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: new Date(this.now()).toISOString(),
    });
    if (!body.includes('merge-decision')) throw new AutonomyError('approval_body_invalid');
    return { reviewId: id };
  }
  async dismiss(pullNumber: number, reviewId: number, _message: string) {
    this.calls.push('dismiss');
    if (pullNumber !== this.github.pull.number) throw new AutonomyError('github_pull_unavailable');
    const review = this.github.reviews.find((entry) => entry.id === reviewId);
    if (!review || review.user.id !== MERGER_BOT.id)
      throw new AutonomyError('github_review_dismiss_failed');
    review.state = 'DISMISSED';
  }
  async merge(pullNumber: number, head: string, _title: string, _message: string) {
    this.calls.push('merge');
    if (pullNumber !== this.github.pull.number) throw new AutonomyError('github_pull_unavailable');
    if (this.refuseMerge) throw new AutonomyError(this.refuseMerge);
    if (this.github.pull.merged || this.github.pull.head.sha !== head)
      throw new AutonomyError('github_merge_head_changed');
    // Branch protection as GitHub enforces it: one approving review of this head by a write
    // collaborator or an App (never the author), no outstanding change request, checks green.
    const latest = new Map<number, (typeof this.github.reviews)[number]>();
    for (const review of this.github.reviews)
      if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))
        latest.set(review.user.id, review);
    const counted = [...latest.values()].filter(
      (review) =>
        review.user.id !== this.github.pull.user.id &&
        (review.user.type === 'Bot' ||
          (review.user.id === this.github.human.id && this.github.permission === 'write')),
    );
    if (
      counted.some((review) => review.state === 'CHANGES_REQUESTED') ||
      !counted.some((review) => review.state === 'APPROVED' && review.commit_id === head) ||
      !this.github.checks.some(
        (check) =>
          check.head_sha === head && check.status === 'completed' && check.conclusion === 'success',
      )
    )
      throw new AutonomyError('github_merge_not_allowed');
    const pull = this.github.pull;
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = new Date(this.now()).toISOString();
    pull.merge_commit_sha = MERGE_COMMIT;
    pull.merged_by = MERGER_BOT;
    this.commits.set(MERGE_COMMIT, {
      tree: this.mergeTreeOverride ?? this.github.headTree,
      parents: [pull.base.sha],
    });
    pull.base.sha = MERGE_COMMIT;
    if (this.crashAfterMerge) {
      this.crashAfterMerge = false;
      throw new AutonomyError('github_connection_failed');
    }
    return { sha: MERGE_COMMIT };
  }
  async pull(pullNumber: number): Promise<PullFacts> {
    this.calls.push('pull');
    if (pullNumber !== this.github.pull.number) throw new AutonomyError('github_pull_unavailable');
    const pull = this.github.pull;
    return {
      state: pull.state,
      merged: pull.merged,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      mergeCommitSha: pull.merge_commit_sha,
      mergedAt: pull.merged_at,
      mergedBy: pull.merged_by,
    };
  }
  async commit(sha: string) {
    this.calls.push('commit');
    const commit = this.commits.get(sha);
    if (!commit) throw new AutonomyError('github_commit_unavailable');
    return { sha, ...commit };
  }
}
