import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { LeasedConsumer } from '../adapters.js';
import type { RuntimeConfig } from '../config.js';
import { transaction } from '../database.js';
import { PostgresQueue, canonicalJson } from '../queue.js';
import type { Issue } from './client.js';
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

export class HumanMergeGate extends LeasedConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly config: RuntimeConfig,
    private readonly github: GateGitHub,
  ) {
    super(new PostgresQueue(pool, 'HumanMergeGate', config.queue));
    requireGate(config.mode === 'live' && config.mergePolicy, 'merge_policy_not_configured');
  }
  async track(task: number, pull: number, head: string) {
    const pair = await pairPull(this.config, this.github, task, pull, head, {
      headRepositoryIds: headRepositoryIds(this.config),
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
  async schedule() {
    const rows = await this.pool.query<{ pull_number: number }>(
      `SELECT p.pull_number FROM factory_pr_pairs p LEFT JOIN factory_pr_state s USING(repository_id,pull_number)
      WHERE p.repository_id=$1 AND p.installation_id=$2 AND (s.state IS NULL OR s.state <> 'reconciled') ORDER BY p.pull_number LIMIT 101`,
      [this.config.repositoryId, this.config.installationId],
    );
    requireGate(rows.rows.length <= 100, 'tracked_pull_limit_exceeded');
    const bucket = Math.floor(Date.now() / 60_000);
    for (const row of rows.rows)
      await this.queue.enqueue(
        `${this.config.repositoryId}:${row.pull_number}:${bucket}`,
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
        const previous = await this.pool.query<{ foundation: Foundation }>(
          'SELECT foundation FROM factory_pr_observations WHERE repository_id=$1 AND pull_number=$2 ORDER BY id DESC LIMIT 1',
          [body.repositoryId, body.pull],
        );
        // A merge the autonomy ledger admitted and the merger App performed (OSS-21) is an
        // accepted actor for exactly that merge commit; every other merge needs a configured human.
        const autonomyMerge = this.config.mergePolicy?.merger
          ? (
              await this.pool.query<{ merge_commit: string }>(
                "SELECT merge_commit FROM factory_autonomy_merges WHERE repository_id=$1 AND pull_number=$2 AND state='merged' AND merge_commit IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
                [body.repositoryId, body.pull],
              )
            ).rows[0]
          : undefined;
        const inspected = await inspectGate(
          this.config,
          this.github,
          pair,
          previous.rows[0]?.foundation,
          {
            headRepositoryIds: headRepositoryIds(this.config),
            ...(autonomyMerge && this.config.mergePolicy?.merger
              ? {
                  acceptMerger: {
                    login: `${this.config.mergePolicy.merger.appSlug}[bot]`,
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
        const review = await reviewEvidence(this.config, this.github, pull);
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
        if (Date.now() >= next) {
          await this.schedule();
          next = Date.now() + 60_000;
        }
        if (await this.step()) continue;
      } catch {
        console.error('human_merge_gate_step_failed');
      }
      await delay(Math.max(1000, this.config.pollMs), undefined, { signal }).catch(() => undefined);
    }
  }
}
