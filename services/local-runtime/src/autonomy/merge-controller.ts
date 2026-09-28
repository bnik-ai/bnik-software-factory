import type { Pool } from 'pg';
import type { Pair } from '../github/merge-gate.js';
import type { Review } from '../github/merge-policy.js';
import {
  type LoadedTask,
  type RepositoryIdentityForPolicy,
  type TaskSource,
  buildRequest,
  chooseApproval,
  decideAction,
  intentDigest,
  lockRows,
  repositoryLockKey,
  taskLockKey,
} from './controller.js';
import { type Decision, actionDigest } from './decision.js';
import { type MergeTarget, mergeGateReasons } from './evidence.js';
import { ADMISSION_TTL_MS, type ApprovalStore, type AutonomyLedger } from './ledger.js';
import { type MergeExpectation, type MergeObservation, approvalsFromReviews } from './merge.js';
import type { MergeHost, PullFacts } from './merger.js';
import { type AutonomyMerge, type AutonomyMerges, TERMINAL_MERGE_STATES } from './merges.js';
import { type AutonomyPolicy, policyDigest } from './policy.js';
import type { AutonomyRun, AutonomyRuns } from './runs.js';
import { AutonomyError, requireAutonomy } from './schema.js';

/**
 * Merge controller (OSS-21). For a published attempt it observes the pull request through
 * trusted reads, turns configured approvers' reviews on the exact head into ledger
 * approvals, asks the policy to decide `merge` on the run's tree-bound receipts and the
 * observation, admits the action once, re-validates the admission and re-observes
 * immediately before merging, squash-merges the exact head with the merger identity and
 * verifies the merge commit it produced. Every step is a compare-and-set transition on the
 * merge record; a restarted or duplicated command resumes and never merges twice.
 *
 * A record ends (`blocked`) only when the pull request it binds is no longer what was
 * tested (head, tree, base, closed, merged by someone else) or the Task changed. Every
 * other refusal keeps it open with the reason recorded; the next `merge` or `merge-scan`
 * observes again.
 */
export interface Reverification {
  acceptance: unknown;
  review: unknown;
  dependency?: unknown;
}
export interface MergeAdapters {
  pool: Pool;
  ledger: AutonomyLedger;
  runs: AutonomyRuns;
  merges: AutonomyMerges;
  approvals: ApprovalStore;
  policy: AutonomyPolicy;
  repository: RepositoryIdentityForPolicy & { fullName: string };
  taskSource: TaskSource;
  actor: string;
  now: () => number;
  /** The registered pairing for this publication (track-pr), or a fresh pairing check. */
  loadPair(run: AutonomyRun, pullNumber: number, head: string): Promise<Pair>;
  observe(pair: Pair, expectation: MergeExpectation): Promise<MergeObservation>;
  /** One token, one merge: approve when the admission was routine, squash-merge the exact head, read back. */
  perform<T>(work: (host: MergeHost) => Promise<T>): Promise<T>;
  /** Fresh acceptance and review receipts for the published head when the recorded ones expired. */
  reverify?: (run: AutonomyRun, expectation: MergeExpectation) => Promise<Reverification>;
  /** Reconcile the Task after a verified merge (pairing, labels, dependency snapshot). */
  afterMerge?: (run: AutonomyRun, merge: AutonomyMerge) => Promise<void>;
}
export interface MergeResult {
  merge: AutonomyMerge;
  decisions: Decision[];
}
interface MergedOutcome {
  kind: 'merged';
  facts: PullFacts;
  commit: { sha: string; tree: string; parents: string[] };
  mergerLogin: string;
}
/** Refusals that end a record: what was tested is no longer what the pull request offers. */
const SETTLED_REASONS: ReadonlySet<string> = new Set([
  'merge_gate_target_mismatch',
  'pull_head_changed',
  'published_tree_differs_from_tested_tree',
  'pull_base_changed',
  'pull_not_open',
  'pull_closed_without_merge',
  'merged_by_other_actor',
  'task_changed_since_publication',
]);
/** GitHub answered the merge call with a refusal; anything else (a lost connection) is uncertain. */
const GITHUB_REFUSALS: ReadonlySet<string> = new Set([
  'github_merge_not_allowed',
  'github_merge_head_changed',
  'github_merge_failed',
]);
/** GitHub refusals a scan retries before leaving the record to the operator's explicit `merge`. */
const REFUSALS_BEFORE_OPERATOR = 3;
/** An admission returned to `observing` for one of these is decided again at once. */
const REDECIDE_REASONS: ReadonlySet<string> = new Set([
  'admission_missing',
  'admission_expired',
  'policy_changed_since_decision',
  'approval_withdrawn',
  'merge_not_performed',
]);
function refusals(merge: AutonomyMerge): number {
  const value = merge.evidence.refusals;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function admissionNumber(merge: AutonomyMerge): number {
  const value = merge.evidence.admission;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}
/** Deterministic per record and admission: a dead admission is followed by a new request. */
function requestSeed(merge: AutonomyMerge): string {
  const admission = admissionNumber(merge);
  return admission === 1 ? `${merge.mergeId}:merge` : `${merge.mergeId}:merge:${admission}`;
}
/** The merger's own approving review of the head, if one is still standing. */
function ownApproval(reviews: Review[], head: string, mergerLogin: string): Review | undefined {
  return reviews.find(
    (review) =>
      review.state === 'APPROVED' &&
      review.commit_id === head &&
      review.user.type === 'Bot' &&
      review.user.login.toLowerCase() === mergerLogin.toLowerCase(),
  );
}
function approvedOn(
  reviews: Review[],
  head: string,
  matches: (user: Review['user']) => boolean,
): boolean {
  return reviews.some(
    (review) => review.state === 'APPROVED' && review.commit_id === head && matches(review.user),
  );
}
export class MergeController {
  constructor(private readonly adapters: MergeAdapters) {}
  private get policy() {
    return this.adapters.policy;
  }
  private now() {
    return this.adapters.now();
  }
  /**
   * The operator's explicit command: drives the merge of a Task's published attempt as far as
   * the evidence allows, settles an uncertain one, and retries what scans have given up on.
   */
  async merge(taskNumber: number): Promise<MergeResult> {
    return this.drive(taskNumber, true);
  }
  /** Every published attempt whose merge is open, one after another; uncertain ones are the operator's. */
  async scan(): Promise<{ taskNumber: number; state: string; reason: string | null }[]> {
    const results: { taskNumber: number; state: string; reason: string | null }[] = [];
    const published = (await this.adapters.runs.published(this.adapters.repository.id)).filter(
      (run) => run.publication !== null,
    );
    const seen = new Set<string>();
    for (const run of published) {
      if (seen.has(run.taskId)) continue;
      seen.add(run.taskId);
      const existing = await this.adapters.merges.forRun(run.runId);
      // Left to the operator's explicit `merge`: uncertain records, a spent approval, repeated
      // refusals. A merge whose reconciliation did not complete is revisited.
      if (
        existing &&
        (existing.state === 'blocked' ||
          (existing.state === 'merged' && existing.evidence.reconciled === true) ||
          existing.state === 'unknown' ||
          (existing.state === 'held' && existing.reason === 'approval_already_used') ||
          refusals(existing) >= REFUSALS_BEFORE_OPERATOR)
      )
        continue;
      try {
        const { merge } = await this.drive(run.taskNumber, false);
        results.push({ taskNumber: run.taskNumber, state: merge.state, reason: merge.reason });
      } catch (error) {
        results.push({
          taskNumber: run.taskNumber,
          state: 'error',
          reason: error instanceof AutonomyError ? error.reason : 'merge_failed',
        });
      }
    }
    return results;
  }
  private async drive(taskNumber: number, explicit: boolean): Promise<MergeResult> {
    const repositoryId = this.adapters.repository.id;
    const client = await this.adapters.pool.connect();
    try {
      await lockRows(client, repositoryId, [
        {
          key: taskLockKey(repositoryId, taskNumber),
          mode: 'UPDATE',
          refused: 'task_run_in_progress',
        },
        { key: repositoryLockKey(repositoryId), mode: 'SHARE', refused: 'controller_busy' },
      ]);
      return await this.mergeLocked(taskNumber, explicit);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
  private async mergeLocked(taskNumber: number, explicit: boolean): Promise<MergeResult> {
    const decisions: Decision[] = [];
    const repositoryId = this.adapters.repository.id;
    const task = await this.adapters.taskSource.load(taskNumber);
    const latest = await this.adapters.runs.latest(repositoryId, task.id);
    requireAutonomy(
      latest !== null && latest.state === 'published' && latest.publication !== null,
      'merge_requires_published_run',
    );
    let run = latest;
    const publication = run.publication as { head: string; pullNumber: number };
    let merge =
      (await this.adapters.merges.forRun(run.runId)) ??
      (await this.adapters.merges.create({
        repositoryId,
        runId: run.runId,
        taskId: task.id,
        pullNumber: publication.pullNumber,
        head: publication.head,
        tree: run.candidateTree as string,
        base: run.sourceCommit as string,
      }));
    if (merge.state === 'merged')
      return {
        merge: merge.evidence.reconciled === true ? merge : await this.reconcile(run, merge),
        decisions,
      };
    if (TERMINAL_MERGE_STATES.includes(merge.state)) return { merge, decisions };
    // An uncertain merge is settled by the operator's explicit command, never by a scan; the
    // explicit command also retries a merge GitHub kept refusing.
    if (merge.state === 'unknown' && !explicit) return { merge, decisions };
    if (explicit && refusals(merge) > 0)
      merge = await this.adapters.merges.transition(merge.mergeId, [merge.state], merge.state, {
        evidence: { ...merge.evidence, refusals: 0 },
      });
    // The pairing is checked once while the pull request is open and kept on the record: after
    // a merge (or a crash beside one) the same identities are what later steps verify against.
    if (!merge.evidence.pair) {
      const pair = await this.adapters.loadPair(run, merge.pullNumber, merge.head);
      merge = await this.adapters.merges.transition(merge.mergeId, [merge.state], merge.state, {
        evidence: { ...merge.evidence, pair: pair as unknown as Record<string, unknown> },
      });
    }
    const pair = merge.evidence.pair as unknown as Pair;
    // Pause, revocation and expiry stop merging as they stop everything else; the record keeps its state.
    const halted = await this.adapters.ledger.halted(repositoryId, run.scopeId, this.now());
    if (halted !== null) throw new AutonomyError(halted);
    if (run.intentSha256 !== intentDigest(task)) {
      merge = await this.adapters.merges.transition(merge.mergeId, [merge.state], 'blocked', {
        reason: 'task_changed_since_publication',
      });
      return { merge, decisions };
    }
    const expectation: MergeExpectation = { head: merge.head, tree: merge.tree, base: merge.base };
    const target: MergeTarget = {
      repositoryId,
      baseBranch: this.adapters.repository.baseBranch,
      head: merge.head,
      tree: merge.tree,
      base: merge.base,
    };
    let guard = 0;
    // observing → admitted → (dead) observing → admitted → merged is the longest path.
    while (guard++ < 8) {
      switch (merge.state) {
        case 'observing':
        case 'held': {
          const observed = await this.adapters.observe(pair, expectation);
          const observation = observed.observation as unknown as Record<string, unknown>;
          const request = buildRequest(
            this.policy,
            this.adapters.repository,
            {
              action: 'merge',
              scopeId: run.scopeId,
              task: {
                id: task.id,
                intentSha256: run.intentSha256 as string,
                intentKind: task.intentKind,
              },
              base: merge.base,
              head: merge.head,
              tree: merge.tree,
              changes: run.evidence.manifest as never,
              execution: null,
            },
            requestSeed(merge),
          );
          const digest = actionDigest(request);
          const evidence = {
            ...merge.evidence,
            actionSha256: digest,
            protectionReason: observed.protectionReason,
          };
          // A crash between the ledger's admission and this record's transition: resume that admission.
          const prior = await this.adapters.ledger.consumedAdmission(request.requestId);
          if (prior) {
            merge = await this.adapters.merges.transition(
              merge.mergeId,
              [merge.state],
              'admitted',
              {
                mergeDecisionId: prior.decisionId,
                observation,
                evidence: { ...evidence, approvedBy: prior.decision.approvedBy },
                reason: null,
              },
            );
            break;
          }
          // The observation alone can refuse; nothing is re-verified or decided until it clears.
          const gate = mergeGateReasons(target, observed.observation, this.now());
          if (gate.length > 0) {
            merge = await this.refuse(merge, gate[0]?.code as string, observation, evidence);
            return { merge, decisions };
          }
          // Native reviews on the exact head by configured approvers are the approvals; only a
          // review present now counts, so a dismissed review unlocks nothing.
          const current = approvalsFromReviews(
            this.policy,
            observed.reviews,
            merge.head,
            observed.pull.user.id,
            digest,
            observed.reviewers,
          );
          for (const { approval, evidence: proof } of current)
            await this.adapters.approvals.record(
              repositoryId,
              approval,
              proof,
              this.adapters.actor,
            );
          // A scan does not re-decide (or re-verify) a hold nobody has approved yet.
          if (
            !explicit &&
            merge.state === 'held' &&
            merge.reason === 'merge_approval_required' &&
            current.length === 0
          ) {
            merge = await this.adapters.merges.transition(merge.mergeId, ['held'], 'held', {
              observation,
              evidence,
            });
            return { merge, decisions };
          }
          run = await this.freshReceipts(run, expectation);
          const receipts = run.receipts as Record<string, unknown>;
          // Decided and recorded now; consumed immediately before the merge call, so an admission
          // that dies first spends neither the request nor the human approval.
          const admitted = await decideAction(
            this.adapters.ledger,
            this.policy,
            request,
            {
              acceptance: receipts.acceptance,
              review: receipts.review,
              ...(receipts.dependency ? { dependency: receipts.dependency } : {}),
              mergeGate: observed.observation,
            },
            chooseApproval(
              this.policy,
              request,
              current.map((entry) => entry.approval),
            ),
            this.now(),
          );
          decisions.push(admitted.decision);
          if (admitted.decision.outcome === 'allow') {
            merge = await this.adapters.merges.transition(
              merge.mergeId,
              [merge.state],
              'admitted',
              {
                mergeDecisionId: admitted.decisionId,
                observation,
                evidence: { ...evidence, approvedBy: admitted.decision.approvedBy },
                reason: null,
              },
            );
            break;
          }
          if (admitted.decision.outcome === 'approval_required') {
            merge = await this.adapters.merges.transition(merge.mergeId, [merge.state], 'held', {
              reason: 'merge_approval_required',
              observation,
              evidence,
            });
            return { merge, decisions };
          }
          merge = await this.refuse(
            merge,
            admitted.decision.reasons[0]?.code ?? admitted.decision.outcome,
            observation,
            evidence,
          );
          return { merge, decisions };
        }
        case 'admitted': {
          merge = await this.execute(run, task, merge, pair, target, expectation);
          // A dead admission went back to observing: decide once more under what holds now.
          if (merge.state === 'observing' && REDECIDE_REASONS.has(merge.reason ?? '')) break;
          return { merge, decisions };
        }
        case 'unknown': {
          merge = await this.settle(run, merge, pair, expectation);
          if (merge.state === 'observing' && REDECIDE_REASONS.has(merge.reason ?? '')) break;
          return { merge, decisions };
        }
        default:
          return { merge, decisions };
      }
    }
    throw new AutonomyError('merge_step_limit');
  }
  /** Records a refusal: a settled reason ends the record, any other keeps it open for the next scan. */
  private refuse(
    merge: AutonomyMerge,
    code: string,
    observation: Record<string, unknown>,
    evidence: Record<string, unknown>,
  ): Promise<AutonomyMerge> {
    return this.adapters.merges.transition(
      merge.mergeId,
      [merge.state],
      SETTLED_REASONS.has(code) ? 'blocked' : 'observing',
      { reason: code, observation, evidence },
    );
  }
  /** Receipts older than the policy's TTL are replaced by fresh verification of the published head. */
  private async freshReceipts(
    run: AutonomyRun,
    expectation: MergeExpectation,
  ): Promise<AutonomyRun> {
    const ttl = this.policy.verification.receiptTtlMs;
    const stale = ['acceptance', 'review', 'dependency'].some((kind) => {
      const completedAt = (run.receipts[kind] as { completedAt?: unknown } | undefined)
        ?.completedAt;
      return typeof completedAt === 'number' && this.now() - completedAt > ttl;
    });
    if (!stale || !this.adapters.reverify) return run;
    const fresh = await this.adapters.reverify(run, expectation);
    return this.adapters.runs.transition(run.runId, ['published'], 'published', {
      receipts: {
        ...run.receipts,
        acceptance: fresh.acceptance,
        review: fresh.review,
        ...(fresh.dependency !== undefined ? { dependency: fresh.dependency } : {}),
      },
    });
  }
  private async execute(
    run: AutonomyRun,
    task: LoadedTask,
    admitted: AutonomyMerge,
    pair: Pair,
    target: MergeTarget,
    expectation: MergeExpectation,
  ): Promise<AutonomyMerge> {
    let merge = admitted;
    const observed = await this.adapters.observe(pair, expectation);
    const observation = observed.observation as unknown as Record<string, unknown>;
    const decisionId = merge.mergeDecisionId ?? '';
    const digest = String(merge.evidence.actionSha256 ?? '');
    // A merge already made (by this controller before a crash) is verified, not repeated.
    if (observed.observation.pullState === 'merged') return this.confirm(run, merge, null);
    // The factory's approval never outlives the attempt: whenever this call ends without the
    // merge, a lingering approval of the head is dismissed first.
    const lingering = observed.reviews.find(
      (review) =>
        review.state === 'APPROVED' &&
        review.commit_id === merge.head &&
        review.user.type === 'Bot',
    );
    const withdraw = async (): Promise<void> => {
      if (!lingering) return;
      try {
        await this.adapters.perform(async (host) => {
          const own = ownApproval(observed.reviews, merge.head, host.mergerLogin);
          if (own)
            await host.dismiss(
              merge.pullNumber,
              own.id,
              'The bounded-autonomy attempt this approval belonged to did not merge.',
            );
        });
      } catch (error) {
        merge = await this.adapters.merges.transition(merge.mergeId, ['admitted'], 'admitted', {
          evidence: {
            ...merge.evidence,
            dismissal: error instanceof AutonomyError ? error.reason : 'dismiss_failed',
          },
        });
      }
    };
    if (observed.observation.pullState !== 'open') {
      await withdraw();
      return this.adapters.merges.transition(merge.mergeId, ['admitted'], 'blocked', {
        reason: 'pull_closed_without_merge',
        observation,
      });
    }
    // The admission is honoured only while what it rested on still holds: the same active
    // policy (read from the ledger, not this process's copy), within the admission TTL, and an
    // approving review still on the exact head.
    const active = await this.adapters.ledger.activePolicy(this.adapters.repository.id);
    requireAutonomy(
      active !== null && policyDigest(active) === policyDigest(this.policy),
      'policy_not_active',
    );
    const admission = await this.adapters.ledger.admission(decisionId);
    const dead =
      admission === null
        ? 'admission_missing'
        : admission.policySha256 !== policyDigest(active)
          ? 'policy_changed_since_decision'
          : this.now() - admission.decidedAt > ADMISSION_TTL_MS
            ? 'admission_expired'
            : admission.decision.approvedBy !== null &&
                !approvedOn(
                  observed.reviews,
                  merge.head,
                  (user) => user.type === 'User' && user.id === admission.decision.approvedBy,
                )
              ? 'approval_withdrawn'
              : null;
    if (admission === null || dead !== null) {
      await withdraw();
      return this.adapters.merges.transition(merge.mergeId, ['admitted'], 'observing', {
        reason: dead,
        observation,
        evidence: { ...merge.evidence, admission: admissionNumber(merge) + 1 },
      });
    }
    // Immediately before merging: same head, base and tree, protection intact, checks green,
    // no change request. A settled reason ends the record; a passing condition is waited for.
    const recheck = mergeGateReasons(target, observed.observation, this.now());
    if (recheck.length > 0) {
      const code = recheck[0]?.code as string;
      await withdraw();
      return this.adapters.merges.transition(
        merge.mergeId,
        ['admitted'],
        SETTLED_REASONS.has(code) ? 'blocked' : 'admitted',
        { reason: `pre_merge_recheck_failed:${code}`, observation },
      );
    }
    const approvedBy = admission.decision.approvedBy;
    // The gate reconciles a merged pull request against its last observation while open.
    await this.adapters.pool.query(
      'INSERT INTO factory_pr_observations(repository_id,pull_number,foundation) VALUES($1,$2,$3::jsonb)',
      [this.adapters.repository.id, merge.pullNumber, JSON.stringify(observed.foundation)],
    );
    let wrote = false;
    let consumption: string | null = null;
    let outcome:
      | MergedOutcome
      | { kind: 'refused'; reason: string }
      | { kind: 'failed'; reason: string };
    try {
      outcome = await this.adapters.perform(async (host) => {
        let facts = await host.pull(merge.pullNumber);
        requireAutonomy(!facts.merged && facts.state === 'open', 'pull_not_open');
        requireAutonomy(facts.headSha === merge.head, 'pull_head_changed');
        // The single-use admission is consumed here, with the token minted and the head confirmed:
        // consume() re-checks the policy, TTL, pause, scope and the approval's single use.
        let approval = ownApproval(observed.reviews, merge.head, host.mergerLogin)?.id ?? null;
        const dismiss = async () => {
          if (approval !== null)
            await host.dismiss(
              merge.pullNumber,
              approval,
              'The bounded-autonomy attempt this approval belonged to did not merge.',
            );
        };
        if (admission.consumedAt === null)
          try {
            await this.adapters.ledger.consume(decisionId, this.now());
          } catch (error) {
            consumption =
              error instanceof AutonomyError ? error.reason : 'admission_consume_failed';
            await dismiss();
            throw error;
          }
        // A routine admission carries the factory's own approval, given once; an approval-based
        // admission rests on the human's review and the factory never approves beside it.
        if (approvedBy === null && approval === null)
          approval = (
            await host.approve(
              merge.pullNumber,
              merge.head,
              `Approved by the bounded-autonomy policy.\n\nmerge-decision: ${decisionId}\naction-sha256: ${digest}\nfactory-tree: ${merge.tree}`,
            )
          ).reviewId;
        wrote = true;
        try {
          await host.merge(
            merge.pullNumber,
            merge.head,
            task.title.slice(0, 72),
            `factory-run: ${run.runId}\nfactory-tree: ${merge.tree}\nmerge-decision: ${decisionId}\nSF-Actor: factory`,
          );
        } catch (error) {
          // GitHub refused with the pull request untouched: a recorded refusal, not uncertainty.
          if (error instanceof AutonomyError && GITHUB_REFUSALS.has(error.reason)) {
            const after = await host.pull(merge.pullNumber);
            if (!after.merged && after.headSha === merge.head) {
              await dismiss();
              return { kind: 'refused' as const, reason: error.reason };
            }
          }
          throw error;
        }
        facts = await host.pull(merge.pullNumber);
        requireAutonomy(facts.merged && facts.mergeCommitSha !== null, 'merge_not_confirmed');
        const commit = await host.commit(facts.mergeCommitSha as string);
        return { kind: 'merged' as const, facts, commit, mergerLogin: host.mergerLogin };
      });
    } catch (error) {
      const reason = error instanceof AutonomyError ? error.reason : 'merge_failed';
      // Only a merge call whose outcome is unknown makes the record uncertain.
      if (wrote)
        return this.adapters.merges.transition(merge.mergeId, ['admitted'], 'unknown', {
          reason,
          observation,
        });
      if (consumption !== null) {
        // The ledger refused to consume: a dead admission is decided again, a spent approval
        // (an earlier consumption that never merged) shows on the record, anything else is
        // the ledger's condition to report.
        if (REDECIDE_REASONS.has(consumption))
          return this.adapters.merges.transition(merge.mergeId, ['admitted'], 'observing', {
            reason: consumption,
            observation,
            evidence: { ...merge.evidence, admission: admissionNumber(merge) + 1 },
          });
        if (consumption === 'approval_already_used')
          return this.adapters.merges.transition(merge.mergeId, ['admitted'], 'held', {
            reason: consumption,
            observation,
          });
        await this.adapters.merges.transition(merge.mergeId, ['admitted'], 'admitted', {
          reason: consumption,
          observation,
        });
        throw error;
      }
      outcome = { kind: 'failed', reason };
    }
    if (outcome.kind === 'failed')
      // Nothing reached GitHub (token, scope or read failure) or the pull request moved first.
      return this.adapters.merges.transition(
        merge.mergeId,
        ['admitted'],
        SETTLED_REASONS.has(outcome.reason) ? 'blocked' : 'admitted',
        { reason: outcome.reason, observation },
      );
    if (outcome.kind === 'refused') {
      // Consecutive identical refusals are counted; a scan gives up after a few and leaves the
      // record to the operator's explicit `merge`, which resets the count.
      const last = merge.evidence.lastRefusal as { reason?: unknown } | undefined;
      return this.adapters.merges.transition(merge.mergeId, ['admitted'], 'observing', {
        reason: outcome.reason,
        observation,
        evidence: {
          ...merge.evidence,
          lastRefusal: { reason: outcome.reason, at: this.now() },
          refusals: last?.reason === outcome.reason ? refusals(merge) + 1 : 1,
        },
      });
    }
    return this.prove(run, merge, outcome);
  }
  /** A merge is recorded; its Task reconciliation is repeated until the gate confirms it. */
  private async reconcile(run: AutonomyRun, merge: AutonomyMerge): Promise<AutonomyMerge> {
    if (!this.adapters.afterMerge) return merge;
    try {
      await this.adapters.afterMerge(run, merge);
      return this.adapters.merges.transition(merge.mergeId, ['merged'], 'merged', {
        evidence: { ...merge.evidence, reconciled: true, reconcileError: null },
      });
    } catch (error) {
      return this.adapters.merges.transition(merge.mergeId, ['merged'], 'merged', {
        evidence: {
          ...merge.evidence,
          reconciled: false,
          reconcileError: error instanceof Error ? error.message : 'reconcile_failed',
        },
      });
    }
  }
  /** Operator settlement of an uncertain merge from GitHub's facts; nothing is merged here. */
  private async settle(
    run: AutonomyRun,
    merge: AutonomyMerge,
    pair: Pair,
    expectation: MergeExpectation,
  ): Promise<AutonomyMerge> {
    const observed = await this.adapters.observe(pair, expectation);
    const observation = observed.observation as unknown as Record<string, unknown>;
    if (observed.observation.pullState === 'merged') return this.confirm(run, merge, null);
    if (observed.observation.pullState === 'open' && observed.observation.head === merge.head)
      // The merge never happened; the recorded admission is re-validated on the way back.
      return this.adapters.merges.transition(merge.mergeId, ['unknown'], 'observing', {
        reason: 'merge_not_performed',
        observation,
      });
    return this.adapters.merges.transition(merge.mergeId, ['unknown'], 'blocked', {
      reason:
        observed.observation.pullState === 'open'
          ? 'pull_head_changed'
          : 'pull_closed_without_merge',
      observation,
    });
  }
  /** Reads a merged pull request back through the merger identity and records the proof. */
  private async confirm(
    run: AutonomyRun,
    merge: AutonomyMerge,
    outcome: MergedOutcome | null,
  ): Promise<AutonomyMerge> {
    let merged = outcome;
    if (merged === null)
      try {
        merged = await this.adapters.perform(async (host) => {
          const facts = await host.pull(merge.pullNumber);
          requireAutonomy(facts.merged && facts.mergeCommitSha !== null, 'merge_not_confirmed');
          const commit = await host.commit(facts.mergeCommitSha as string);
          return { kind: 'merged' as const, facts, commit, mergerLogin: host.mergerLogin };
        });
      } catch (error) {
        // Reads only: the record keeps its state and shows why it could not be settled.
        return this.adapters.merges.transition(merge.mergeId, [merge.state], merge.state, {
          reason: error instanceof AutonomyError ? error.reason : 'merge_failed',
        });
      }
    return this.prove(run, merge, merged);
  }
  /** The merge commit must be the merger's, on the observed base alone, with the tested tree. */
  private async prove(
    run: AutonomyRun,
    merge: AutonomyMerge,
    { facts, commit, mergerLogin }: MergedOutcome,
  ): Promise<AutonomyMerge> {
    const proof = { facts, commit } as unknown as Record<string, unknown>;
    const ours =
      facts.mergedBy !== null &&
      facts.mergedBy.type === 'Bot' &&
      facts.mergedBy.login.toLowerCase() === mergerLogin.toLowerCase();
    if (!ours)
      return this.adapters.merges.transition(merge.mergeId, [merge.state], 'blocked', {
        reason: 'merged_by_other_actor',
        mergeCommit: commit.sha,
        proof,
      });
    if (
      commit.parents.length !== 1 ||
      commit.parents[0] !== merge.base ||
      commit.tree !== merge.tree
    )
      return this.adapters.merges.transition(merge.mergeId, [merge.state], 'unknown', {
        reason: 'merge_proof_mismatch',
        mergeCommit: commit.sha,
        proof,
      });
    const done = await this.adapters.merges.transition(merge.mergeId, [merge.state], 'merged', {
      reason: null,
      mergeCommit: commit.sha,
      proof: {
        mergedBy: facts.mergedBy,
        mergedAt: facts.mergedAt,
        parents: commit.parents,
        tree: commit.tree,
        approvedBy: merge.evidence.approvedBy ?? null,
      } as unknown as Record<string, unknown>,
    });
    return this.reconcile(run, done);
  }
}
