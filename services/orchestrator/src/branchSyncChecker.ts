// Spec: docs/decisions/0010-multi-model-review-loop.md §"Re-sync onto main"
// + docs/design/review-agent.md §2 step 0.
//
// What this module does:
//   For review-trigger transitions (pr:open→in_review and friends), the
//   orchestrator must NOT dispatch ReviewAgent against a feeder branch
//   that is behind `main` — a stale-base review can pass yet break on
//   merge as other agents land changes in a fast multi-agent factory.
//   This module is the seam for the pre-review check.
//
// Invariants:
//   - This interface is queried by processMessage BEFORE dispatching
//     ReviewAgent for any review-trigger transition. The check is pure
//     in the orchestrator-routing sense — it returns 'current' or
//     'behind' and processMessage decides what to do.
//   - v0 default impl is AlwaysCurrentBranchSyncChecker — returns
//     {ok: true, status: 'current'} unconditionally so existing
//     behavior is unchanged. GithubCompareBranchSyncChecker queries the
//     GitHub API via `GET /repos/{owner}/{repo}/compare/{base}...{head}`
//     and returns 'behind' when behind_by > 0.
//   - ReviewAgent itself stays READ-ONLY (no git.*). The rebase action
//     belongs to BuildAgent; the orchestrator dispatches it when this
//     checker reports 'behind' and returns the review_blocked_by_stale_base
//     outcome (processMessage.ts; ADR 0010 §"Re-sync onto main").
//   - The check fires for the review-trigger routing keys ONLY (not
//     for every PR transition). isReviewTriggerTransition() enumerates them.

import type { SubstrateClient } from './substrateClient.js';
import type { ParsedTransitionMessage } from './types.js';

export type BranchSyncStatus = 'current' | 'behind';

export type BranchSyncResult =
  | { ok: true; status: BranchSyncStatus; aheadBy?: number; behindBy?: number }
  | { ok: false; reason: string };

export interface BranchSyncCheckArgs {
  // The PR's feeder branch (ADR 0008 grammar: sf/T-<id>/<run>/<role>@<model>).
  headBranch: string;
  // The integration branch the PR will merge into. Default 'main' per ADR 0002.
  baseBranch: string;
  // PR record_node_id, threaded through for real-impl logging + Octokit lookups.
  prRecordId: string;
}

export interface BranchSyncChecker {
  // Returns 'behind' iff baseBranch has commits not on headBranch (i.e.
  // the merge-base is older than baseBranch's HEAD).
  checkSync(args: BranchSyncCheckArgs): Promise<BranchSyncResult>;
}

// v0 default: assumes the feeder branch is always current. Behavior is
// unchanged for any caller that doesn't override the checker. The real
// GitHub-API-backed impl is GithubCompareBranchSyncChecker below; wired
// into mainConsumer.startConsumer() when a SubstrateClient is configured
// via env.
export class AlwaysCurrentBranchSyncChecker implements BranchSyncChecker {
  async checkSync(_args: BranchSyncCheckArgs): Promise<BranchSyncResult> {
    return { ok: true, status: 'current' };
  }
}

// Real impl per ADR 0012 item 5 "Activation status" (b). Queries GitHub's
// `GET /repos/{owner}/{repo}/compare/{base}...{head}` (wrapped behind
// SubstrateClient so the orchestrator package owns no @octokit dep) and
// reports `behind` when behind_by > 0, `current` otherwise. Substrate-
// client failures bubble up as `ok:false` so processMessage.ts deadletters
// instead of risking a stale-base ReviewAgent dispatch.
export interface GithubCompareBranchSyncCheckerConfig {
  substrateClient: SubstrateClient;
  owner: string;
  repo: string;
}

export class GithubCompareBranchSyncChecker implements BranchSyncChecker {
  private readonly substrateClient: SubstrateClient;
  private readonly owner: string;
  private readonly repo: string;

  constructor(config: GithubCompareBranchSyncCheckerConfig) {
    this.substrateClient = config.substrateClient;
    this.owner = config.owner;
    this.repo = config.repo;
  }

  async checkSync(args: BranchSyncCheckArgs): Promise<BranchSyncResult> {
    const compare = await this.substrateClient.compareBranches({
      owner: this.owner,
      repo: this.repo,
      base: args.baseBranch,
      head: args.headBranch,
    });
    if (!compare.ok) {
      return { ok: false, reason: compare.reason };
    }
    if (compare.behindBy > 0) {
      return {
        ok: true,
        status: 'behind',
        behindBy: compare.behindBy,
        aheadBy: compare.aheadBy,
      };
    }
    return { ok: true, status: 'current', aheadBy: compare.aheadBy, behindBy: 0 };
  }
}

// Test helper: returns 'behind' the first N calls then 'current' forever
// (simulates a rebase happening between dispatch attempts).
export class StubBranchSyncChecker implements BranchSyncChecker {
  private remainingBehind: number;
  private readonly behindBy: number;
  private readonly calls: BranchSyncCheckArgs[] = [];

  constructor(behindForFirstNCalls: number, behindBy = 3) {
    this.remainingBehind = behindForFirstNCalls;
    this.behindBy = behindBy;
  }

  async checkSync(args: BranchSyncCheckArgs): Promise<BranchSyncResult> {
    this.calls.push(args);
    if (this.remainingBehind > 0) {
      this.remainingBehind -= 1;
      return { ok: true, status: 'behind', behindBy: this.behindBy };
    }
    return { ok: true, status: 'current' };
  }

  callHistory(): readonly BranchSyncCheckArgs[] {
    return this.calls;
  }
}

// Routing keys that mean "ReviewAgent is about to run on this PR" —
// every key here must have the pre-review branch-sync gate applied.
// Sourced from routingTable.ts ROUTING_TABLE rows that map to
// ReviewAgent (NOT the paired task:in_review→in_progress transition which
// is BuildAgent revision, not a review trigger).
//
// Includes `task:in_progress→in_review`: the paired-Task
// route also dispatches ReviewAgent (which then reads `pr-ref:` from the
// task body to emit a Review on the referenced PR — reviewAgent.ts:113),
// so a stale-base review on this path has the same risk as the pr:* paths.
// processMessage.ts resolves headBranch/baseBranch via SubstrateClient
// (task.body → pr-ref → PR.headRefName/baseRefName) when the trigger is
// the task-kind one — the task message itself doesn't carry headBranch.
// POST-REBASE RE-DISPATCH: when a gated edge is behind, the
// orchestrator dispatches BuildAgent to rebase instead of ReviewAgent. The
// rebase's force-push is a `pull_request.synchronize` event the validator settles
// observationally, so it can't re-fire the review on its own. BuildAgent closes
// the loop by bouncing the PR in_review→syncing→in_review (prFsm); the final
// `pr:syncing→in_review` routes to ReviewAgent.
//
// The bounce's OWN re-fire edges (`pr:syncing→in_review`) and the post-revision
// re-review (`pr:changes_requested→in_review`) are deliberately NOT gated
// here. The branch is already current coming out of the bounce/revision, and
// re-gating them would dispatch a CONCURRENT rebase if the base advanced during
// the bounce — racing finishSyncBounce's in-flight label cleanup and stranding the
// PR with no status label. A rare base-advance during the bounce
// is the lesser harm: ReviewAgent reviews a hair-stale branch and OpsAgent's
// pre-merge getSyncStatus gate (ADR 0012 §Risks) refuses a behind merge anyway.
const REVIEW_TRIGGER_KEYS = new Set<string>([
  'pr:__initial__→open',
  'pr:draft→open',
  'pr:draft→in_review',
  'pr:open→in_review',
  'task:in_progress→in_review',
]);

export function isReviewTriggerTransition(message: ParsedTransitionMessage): boolean {
  const key = `${message.kind}:${message.fromState}→${message.toState}`;
  return REVIEW_TRIGGER_KEYS.has(key);
}

export function reviewTriggerKeys(): ReadonlySet<string> {
  return REVIEW_TRIGGER_KEYS;
}
