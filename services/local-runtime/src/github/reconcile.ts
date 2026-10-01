import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { LeasedConsumer } from '../adapters.js';
import { ConfigurationError, type RuntimeConfig, readMergePolicy } from '../config.js';
import { transaction } from '../database.js';
import { PostgresQueue, canonicalJson } from '../queue.js';
import { GitHubFailure, type Issue } from './client.js';
import {
  type Foundation,
  type GateGitHub,
  type MergeProof,
  type Pair,
  assertPairTask,
  dependencyStates,
  gateReason,
  headRepositoryIds,
  inspectGate,
  pairPull,
  reviewEvidence,
} from './merge-gate.js';
import { requireGate } from './merge-policy.js';

/** How long a parked pull request rests before the periodic scan looks at it again. */
export const PARKED_RESCAN_MINUTES = 15;
/** The most pull requests one scan queues; the stalest go first, the rest wait for the next scan. */
export const SCAN_LIMIT = 100;
/** A webhook delivery, as far as it names a pull request, a Task or a head commit. */
type CheckPullRequest = { number?: number; base?: { repo?: { id?: number } } };
export interface DeliveryBody {
  action?: string;
  pull_request?: { number?: number };
  review?: { state?: string; user?: { login?: string } };
  issue?: { number?: number; pull_request?: unknown };
  check_run?: { head_sha?: string; pull_requests?: CheckPullRequest[] };
  check_suite?: { head_sha?: string; pull_requests?: CheckPullRequest[] };
}
/** Task edits that change what the pairing binds (title, body, status labels, lock) or the Task's life. */
const TASK_ACTIONS = new Set([
  'edited',
  'labeled',
  'unlabeled',
  'closed',
  'reopened',
  'deleted',
  'transferred',
  'locked',
  'unlocked',
]);
/**
 * Whose approval can count (merge-policy.ts `verifyReviews`): a listed reviewer, or under the
 * automatic profile the merger App's bot, for the App's own merge only. As the policy file says
 * now, else as loaded.
 */
function countedReviewers(config: RuntimeConfig): Set<string> {
  let policy = config.mergePolicy;
  if (config.mergePolicyFile) {
    try {
      policy = readMergePolicy(config.mergePolicyFile, config.autonomy?.merger ?? undefined);
    } catch {
      // The look itself refuses an unreadable policy; the loaded one still decides what to queue.
    }
  }
  const logins = [...(policy?.reviewers ?? [])];
  if (policy?.merger) logins.push(`${policy.merger.appSlug}[bot]`);
  return new Set(logins.map((login) => login.toLowerCase()));
}
/**
 * Queues a gate look, in the caller's transaction, at every tracked pull request a delivery
 * concerns, when the delivery can change what the gate observes: a pull-request event; a review
 * whose approval can count (`countedReviewers`), a dismissal, anyone's change request (any
 * user's latest CHANGES_REQUESTED parks, merge-policy.ts `verifyReviews`), or any review while
 * the pair is parked on a change request or a look at it is running (it may have read the
 * change request the review lifts); a Task edit, label, lock or state change (the pairing
 * binds the Task); a completed check run or suite on its head (the gate reads check runs, never
 * statuses). Comments, statuses and other reviews cost no GitHub reads; the one-minute scan
 * covers pairs awaiting a merge. Parked and pending pairs both; never a reconciled one; not when
 * a look is already pending (a running look may have read stale evidence, so a delivery during
 * it still queues one).
 */
export async function queueDeliveryLooks(
  client: PoolClient,
  config: RuntimeConfig,
  queue: PostgresQueue,
  event: string,
  body: DeliveryBody,
  deliveryKey: string,
): Promise<number[]> {
  const pulls = new Set<number>();
  const tasks = new Set<number>();
  let head: string | null = null;
  let onlyIfParkedOnChangeRequest = false;
  const number = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
  if (event === 'pull_request') {
    const pull = number(body.pull_request?.number);
    if (pull) pulls.add(pull);
  } else if (event === 'pull_request_review') {
    const pull = number(body.pull_request?.number);
    const reviewer = body.review?.user?.login?.toLowerCase();
    if (pull) {
      pulls.add(pull);
      onlyIfParkedOnChangeRequest = !(
        body.action === 'dismissed' ||
        body.review?.state?.toLowerCase() === 'changes_requested' ||
        (reviewer && countedReviewers(config).has(reviewer))
      );
    }
  } else if (event === 'issues') {
    const issue = number(body.issue?.number);
    if (issue && TASK_ACTIONS.has(body.action ?? '')) tasks.add(issue);
  } else if ((event === 'check_run' || event === 'check_suite') && body.action === 'completed') {
    const check = event === 'check_run' ? body.check_run : body.check_suite;
    for (const entry of check?.pull_requests ?? []) {
      const pull = number(entry?.number);
      if (pull && entry?.base?.repo?.id === config.repositoryId) pulls.add(pull);
    }
    head = check?.head_sha ?? null;
  }
  if (head !== null && !/^[0-9a-f]{40}$/.test(head)) head = null;
  if (!pulls.size && !tasks.size && head === null) return [];
  const rows = await client.query<{ pull_number: number }>(
    `SELECT p.pull_number FROM factory_pr_pairs p LEFT JOIN factory_pr_state s USING(repository_id,pull_number)
    WHERE p.repository_id=$1 AND p.installation_id=$2
      AND (p.pull_number = ANY($3::bigint[]) OR p.task_number = ANY($4::bigint[])
        OR ($5::text IS NOT NULL AND (s.head = $5 OR p.pair->>'initialHead' = $5)))
      AND (s.state IS NULL OR s.state <> 'reconciled')
      AND (NOT $7::boolean OR (s.state = 'parked' AND s.reason = 'changes_requested')
        OR EXISTS (SELECT 1 FROM factory_work r WHERE r.queue_name='HumanMergeGate' AND r.state='running'
          AND (r.body->>'repositoryId')::bigint=p.repository_id AND (r.body->>'pull')::bigint=p.pull_number))
      AND NOT EXISTS (SELECT 1 FROM factory_work w WHERE w.queue_name='HumanMergeGate'
        AND w.state='pending' AND (w.body->>'repositoryId')::bigint=p.repository_id
        AND (w.body->>'pull')::bigint=p.pull_number)
    ORDER BY p.pull_number LIMIT $6::int`,
    [
      config.repositoryId,
      config.installationId,
      [...pulls],
      [...tasks],
      head,
      SCAN_LIMIT,
      onlyIfParkedOnChangeRequest,
    ],
  );
  for (const row of rows.rows)
    await queue.enqueue(
      `${config.repositoryId}:${row.pull_number}:delivery:${deliveryKey}`,
      config.repository.toLowerCase(),
      {
        pull: row.pull_number,
        repositoryId: config.repositoryId,
        installationId: config.installationId,
      },
      client,
    );
  return rows.rows.map((row) => row.pull_number);
}
export class HumanMergeGate extends LeasedConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly config: RuntimeConfig,
    private readonly github: GateGitHub,
  ) {
    super(new PostgresQueue(pool, 'HumanMergeGate', config.queue));
    requireGate(config.mode === 'live' && config.mergePolicy, 'merge_policy_not_configured');
  }
  /**
   * This look's configuration: the merge policy as its file holds it now, else as loaded. A file
   * that is missing (the review services mount its directory, runtime/compose.review.yaml) or cannot
   * be read observed nothing (retryable: the next scan looks again); an invalid file parks with its
   * validation reason.
   */
  private current(): RuntimeConfig {
    if (!this.config.mergePolicyFile) return this.config;
    try {
      return {
        ...this.config,
        mergePolicy: readMergePolicy(
          this.config.mergePolicyFile,
          this.config.autonomy?.merger ?? undefined,
        ),
      };
    } catch (error) {
      if (error instanceof GitHubFailure) throw error;
      if (error instanceof ConfigurationError) throw new GitHubFailure(error.reason);
      // With the directory mounted, a missing file is an edit in progress or a removal: look again next scan.
      if ((error as { code?: unknown }).code === 'ENOENT')
        throw new GitHubFailure('merge_policy_file_missing', true);
      throw new GitHubFailure('merge_policy_unreadable', true);
    }
  }
  async track(task: number, pull: number, head: string) {
    const config = this.current();
    const pair = await pairPull(config, this.github, task, pull, head, {
      headRepositoryIds: headRepositoryIds(config),
    });
    await transaction(this.pool, async (client) => {
      const inserted = await client.query(
        'INSERT INTO factory_pr_pairs(repository_id,installation_id,pull_number,task_number,pair) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING pull_number',
        [pair.repositoryId, pair.installationId, pull, task, JSON.stringify(pair)],
      );
      if (!inserted.rowCount) {
        const old = await client.query<{ pair: Pair }>(
          'SELECT pair FROM factory_pr_pairs WHERE repository_id=$1 AND pull_number=$2',
          [pair.repositoryId, pull],
        );
        requireGate(
          old.rows[0] && canonicalJson(old.rows[0].pair) === canonicalJson(pair),
          'pair_already_registered_differently',
        );
      }
      await this.queue.enqueue(
        randomUUID(),
        this.config.repository.toLowerCase(),
        { pull, repositoryId: pair.repositoryId, installationId: pair.installationId },
        client,
      );
    });
    return pair;
  }
  /**
   * Queues the pairs due for a look that no queued item covers yet: never evaluated, pending
   * (anything but parked or reconciled), parked by a retryable GitHub failure (`transient`), or
   * parked PARKED_RESCAN_MINUTES ago; `includeParked` (the operator's review-scan) queues every
   * parked pair at once. A parked pull request rarely changes by itself, and each look costs
   * GitHub reads on this serial loop; rescanning every one every minute starves fresh deliveries
   * (closures miss their window behind dozens of permanently parked pairs),
   * and queuing a pair again while its look is still queued grows the queue faster than the loop
   * drains it. A delivery concerning a tracked pull request queues a look at once
   * (`queueDeliveryLooks`, from the intake); so do `track` and the autonomy commands.
   * At most SCAN_LIMIT pairs per scan, stalest first: the rest follow on later scans. The
   * delivery key names the minute and the observation the look would follow, so one minute
   * queues a pair once, a fresh look in the same minute (operator scan, transient park) still
   * queues, and a dead item never blocks the next minute.
   */
  async schedule(options: { includeParked?: boolean } = {}) {
    const rows = await this.pool.query<{ pull_number: number; mark: string }>(
      `SELECT p.pull_number, COALESCE((extract(epoch FROM s.updated_at)*1000000)::bigint::text,'new') AS mark
      FROM factory_pr_pairs p LEFT JOIN factory_pr_state s USING(repository_id,pull_number)
      WHERE p.repository_id=$1 AND p.installation_id=$2
        AND (s.state IS NULL OR (s.state <> 'reconciled'
          AND (s.state <> 'parked' OR $4::boolean OR COALESCE((s.evidence->>'transient')::boolean, false)
            OR s.updated_at < clock_timestamp() - ($3::int * interval '1 minute'))))
        AND NOT EXISTS (SELECT 1 FROM factory_work w WHERE w.queue_name='HumanMergeGate'
          AND w.state IN ('pending','running') AND (w.body->>'repositoryId')::bigint=p.repository_id
          AND (w.body->>'pull')::bigint=p.pull_number)
      ORDER BY s.updated_at NULLS FIRST, p.pull_number LIMIT $5::int`,
      [
        this.config.repositoryId,
        this.config.installationId,
        PARKED_RESCAN_MINUTES,
        options.includeParked === true,
        SCAN_LIMIT,
      ],
    );
    const bucket = Math.floor(Date.now() / 60_000);
    for (const row of rows.rows)
      await this.queue.enqueue(
        `${this.config.repositoryId}:${row.pull_number}:${bucket}:${row.mark}`,
        this.config.repository.toLowerCase(),
        {
          pull: row.pull_number,
          repositoryId: this.config.repositoryId,
          installationId: this.config.installationId,
        },
      );
  }
  private async fenced(token: string, fn: (client: PoolClient) => Promise<void>) {
    this.signal(token).throwIfAborted();
    await transaction(this.pool, async (client) => {
      const lease = await client.query(
        "SELECT id FROM factory_work WHERE queue_name='HumanMergeGate' AND lease_token=$1 AND state='running' AND lease_until>clock_timestamp() FOR UPDATE",
        [token],
      );
      requireGate(lease.rowCount === 1, 'merge_gate_lease_lost');
      await fn(client);
      const stillOwned = await client.query(
        "SELECT id FROM factory_work WHERE queue_name='HumanMergeGate' AND lease_token=$1 AND state='running' AND lease_until>clock_timestamp()",
        [token],
      );
      requireGate(stillOwned.rowCount === 1, 'merge_gate_lease_lost');
    });
  }
  async step(): Promise<boolean> {
    const work = await this.take();
    if (!work) return false;
    const body = work.body as { pull: number; repositoryId: number; installationId: number };
    let head: string | null = null;
    let state = 'parked';
    let reason = 'review_surface_unreadable';
    let evidence: unknown = {};
    let cached = false;
    try {
      requireGate(
        body.repositoryId === this.config.repositoryId &&
          body.installationId === this.config.installationId,
        'queued_configuration_changed',
      );
      const rows = await this.pool.query<{ pair: Pair }>(
        'SELECT pair FROM factory_pr_pairs WHERE repository_id=$1 AND installation_id=$2 AND pull_number=$3',
        [body.repositoryId, body.installationId, body.pull],
      );
      const pair = rows.rows[0]?.pair;
      requireGate(pair, 'pair_not_registered');
      const settled = await this.pool.query<{
        state: string;
        reason: string;
        head: string;
        evidence: unknown;
      }>(
        'SELECT state,reason,head,evidence FROM factory_pr_state WHERE repository_id=$1 AND pull_number=$2',
        [body.repositoryId, body.pull],
      );
      if (settled.rows[0]?.state === 'reconciled') {
        ({ state, reason, head, evidence } = settled.rows[0]);
        cached = true;
      } else {
        // Read after the cached check: a reconciled pull request is never re-judged by a policy read.
        const config = this.current();
        const previous = await this.pool.query<{ foundation: Foundation }>(
          'SELECT foundation FROM factory_pr_observations WHERE repository_id=$1 AND pull_number=$2 ORDER BY id DESC LIMIT 1',
          [body.repositoryId, body.pull],
        );
        // A merge the autonomy ledger admitted and the merger App performed is an
        // accepted actor for exactly that merge commit; every other merge needs a configured human.
        const autonomyMerge = config.mergePolicy?.merger
          ? (
              await this.pool.query<{ merge_commit: string }>(
                "SELECT merge_commit FROM factory_autonomy_merges WHERE repository_id=$1 AND pull_number=$2 AND state='merged' AND merge_commit IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
                [body.repositoryId, body.pull],
              )
            ).rows[0]
          : undefined;
        const inspected = await inspectGate(
          config,
          this.github,
          pair,
          previous.rows[0]?.foundation,
          {
            headRepositoryIds: headRepositoryIds(config),
            ...(autonomyMerge && config.mergePolicy?.merger
              ? {
                  acceptMerger: {
                    login: `${config.mergePolicy.merger.appSlug}[bot]`,
                    mergeCommit: autonomyMerge.merge_commit,
                  },
                }
              : {}),
          },
        );
        const { pull, foundation } = inspected;
        head = pull.head.sha;
        if (!pull.merged) {
          await this.fenced(work.lease_token, async (client) => {
            await client.query(
              'INSERT INTO factory_pr_observations(repository_id,pull_number,foundation) VALUES($1,$2,$3::jsonb)',
              [body.repositoryId, body.pull, JSON.stringify(foundation)],
            );
          });
        }
        evidence = { foundation };
        const review = await reviewEvidence(config, this.github, pull);
        evidence = { foundation, ...review };
        if (!pull.merged) {
          state = 'awaiting_human_merge';
          reason = 'human_review_and_ci_verified';
        } else {
          requireGate(
            pull.merged_by && pull.merged_at && pull.merge_commit_sha,
            'merge_evidence_missing',
          );
          const proof: MergeProof = {
            foundation: previous.rows[0]?.foundation ?? foundation,
            pullId: pair.pullId,
            taskId: pair.taskId,
            mergeCommit: pull.merge_commit_sha,
            mergedAt: pull.merged_at,
            merger: pull.merged_by,
            ...review,
          };
          await this.fenced(work.lease_token, async (client) => {
            const old = await client.query<{ proof: MergeProof }>(
              'SELECT proof FROM factory_merge_receipts WHERE repository_id=$1 AND pull_number=$2',
              [body.repositoryId, body.pull],
            );
            requireGate(
              !old.rows[0] || canonicalJson(old.rows[0].proof) === canonicalJson(proof),
              'merge_receipt_conflict',
            );
            await client.query(
              'INSERT INTO factory_merge_receipts(repository_id,pull_number,proof) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',
              [body.repositoryId, body.pull, JSON.stringify(proof)],
            );
          });
          const expectedStatuses = assertPairTask(pair, inspected.task, true);
          const assertCurrent = async () => {
            this.signal(work.lease_token).throwIfAborted();
            await this.queue.renew(work.lease_token);
            const currentStatuses = assertPairTask(
              pair,
              await this.github.read<Issue>(
                `/repos/${this.config.repository}/issues/${pair.taskNumber}`,
              ),
              true,
            );
            requireGate(
              currentStatuses.every((status) => expectedStatuses.includes(status)),
              'task_status_changed_during_reconciliation',
            );
          };
          await this.github.finishTask(pair.taskNumber, expectedStatuses, assertCurrent);
          const completed = await this.github.read<Issue>(
            `/repos/${this.config.repository}/issues/${pair.taskNumber}`,
          );
          requireGate(
            assertPairTask(pair, completed, true).length === 0 && completed.state === 'closed',
            'task_completion_unverified',
          );
          const dependencies = dependencyStates(await this.github.list<Issue>('tasks', 'all'));
          evidence = { proof, dependencies, taskCompleted: true, automaticActivation: false };
          state = 'reconciled';
          reason = 'human_merge_reconciled';
        }
      }
    } catch (error) {
      reason = gateReason(error);
      // A retryable GitHub failure (5xx, 429, 403, connection) observed nothing about the pull
      // request: the next scan looks again instead of resting PARKED_RESCAN_MINUTES.
      if (error instanceof GitHubFailure && error.retryable)
        evidence = { ...(evidence as Record<string, unknown>), transient: true };
    }
    try {
      this.signal(work.lease_token).throwIfAborted();
      await this.queue.complete(
        work.lease_token,
        { state, reason, head, cached },
        async (client) => {
          if (cached) return;
          await client.query(
            `INSERT INTO factory_pr_state(repository_id,pull_number,state,reason,head,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)
          ON CONFLICT(repository_id,pull_number) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,head=EXCLUDED.head,evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
            [body.repositoryId, body.pull, state, reason, head, JSON.stringify(evidence)],
          );
          if (state === 'reconciled')
            await client.query(
              `INSERT INTO factory_dependency_state(repository_id,snapshot) VALUES($1,$2::jsonb)
          ON CONFLICT(repository_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,updated_at=clock_timestamp()`,
              [
                body.repositoryId,
                JSON.stringify((evidence as { dependencies: unknown }).dependencies),
              ],
            );
          if (state === 'awaiting_human_merge' || state === 'reconciled')
            await client.query(
              `UPDATE factory_worker_runs SET evidence=evidence || jsonb_build_object('review',
                jsonb_build_object('reviewedHead',$1::text,'state',$2::text,'observedAt',clock_timestamp()))
               WHERE evidence->'publication'->>'builtHead'=$1 AND evidence->'publication'->>'pullNumber'=$3
                 AND evidence->'task'->>'repositoryId'=$4`,
              [head, state, String(body.pull), String(body.repositoryId)],
            );
        },
      );
      return true;
    } finally {
      await this.forget(work.lease_token);
    }
  }
  async status() {
    return (
      await this.pool.query(
        'SELECT pull_number,state,reason,head,evidence,updated_at FROM factory_pr_state WHERE repository_id=$1 ORDER BY pull_number',
        [this.config.repositoryId],
      )
    ).rows;
  }
  async run(signal: AbortSignal) {
    let next = 0;
    while (!signal.aborted) {
      try {
        // The next scan is booked before this one runs: a failing scan never keeps step() from
        // draining the queue.
        if (Date.now() >= next) {
          next = Date.now() + 60_000;
          await this.schedule();
        }
        if (await this.step()) continue;
      } catch {
        console.error('human_merge_gate_step_failed');
      }
      await delay(Math.max(1000, this.config.pollMs), undefined, { signal }).catch(() => undefined);
    }
  }
}
