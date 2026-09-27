import type { Pool } from 'pg';
import { transaction } from '../database.js';
import type { Pair } from '../github/merge-gate.js';
import { type CodingJob, type CodingOutcome, sha256 } from './protocol.js';

export interface RunLimits {
  maxTaskRuns: number;
  maxTurns: number;
  timeoutMs: number;
  maxBudgetUsd: number;
}
export function runLimits(env: NodeJS.ProcessEnv = {}): RunLimits {
  const read = (key: string, fallback: number, min: number, max: number, integer = true) => {
    const n = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max)
      throw new Error('invalid_run_limit');
    return n;
  };
  return {
    maxTaskRuns: read('FACTORY_MAX_TASK_RUNS', 4, 1, 20),
    maxTurns: read('FACTORY_MAX_RUN_TURNS', 60, 1, 60),
    timeoutMs: read('FACTORY_MAX_RUN_MS', 1800000, 1000, 1800000),
    maxBudgetUsd: read('FACTORY_MAX_RUN_BUDGET_USD', 5, 0.001, 100, false),
  };
}
const code = (s: unknown) =>
  typeof s === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(s) ? s : 'unclassified';
const amount = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
export function outcomeEvidence(outcome?: CodingOutcome) {
  const usd = amount(outcome?.model?.costUsd);
  const usage = outcome?.model?.usage;
  const counters = [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
  ];
  return {
    result: outcome
      ? { ok: outcome.ok, reason: code(outcome.reason), patchSha256: outcome.patchSha256 }
      : null,
    testsStatus: outcome?.testsStatus ?? 'not_run',
    tests:
      outcome?.tests.map((t, index) => ({
        index,
        commandSha256: sha256(t.command),
        exitCode: t.exitCode,
        signal: t.signal,
        outputSha256: sha256(t.output),
        outputTruncated: t.outputTruncated,
      })) ?? [],
    model: {
      subtype: outcome ? code(outcome.model?.subtype) : 'unavailable',
      turns: amount(outcome?.model?.turns),
      usage:
        usage && counters.every((k) => Number.isSafeInteger(usage[k]) && Number(usage[k]) >= 0)
          ? Object.fromEntries(counters.map((k) => [k, usage[k]]))
          : null,
    },
    cost: {
      status: usd === null ? 'unavailable' : 'estimated',
      estimatedUsd: usd,
      billedUsd: null,
      source: usd === null ? null : 'sdk_query_estimate',
      hardMonetaryCeiling: false,
    },
  };
}

export class RunRecords {
  constructor(private readonly pool: Pool) {}
  async linkPublication(jobId: string, repository: string, pair: Pair) {
    return transaction(this.pool, async (client) => {
      const row = (
        await client.query(
          "SELECT r.run_id,r.evidence FROM factory_worker_runs r JOIN factory_work w ON w.id=r.work_id WHERE w.delivery_key=$1 AND w.record_key=$2 AND w.queue_name='CodingJob' AND r.state='succeeded' FOR UPDATE OF r",
          [jobId, repository.toLowerCase()],
        )
      ).rows[0];
      if (
        !row ||
        String(pair.taskId) !== row.evidence.task?.issueId ||
        String(pair.repositoryId) !== row.evidence.task?.repositoryId
      )
        throw new Error('publication_task_mismatch');
      const publication = { pullNumber: pair.pullNumber, builtHead: pair.initialHead };
      if (
        row.evidence.publication &&
        (row.evidence.publication.pullNumber !== publication.pullNumber ||
          row.evidence.publication.builtHead !== publication.builtHead)
      )
        throw new Error('publication_already_recorded');
      if (row.evidence.publication) return row.evidence.publication;
      await client.query(
        'UPDATE factory_worker_runs SET evidence=evidence || $2::jsonb WHERE run_id=$1',
        [row.run_id, JSON.stringify({ publication })],
      );
      return publication;
    });
  }
  async prepare(job: CodingJob, limits: RunLimits) {
    let task: {
      activationId: string;
      issueId: string;
      number: number;
      repositoryId: string;
    } | null = null;
    if (job.mode === 'live') {
      const id = /^activation-([0-9a-f-]{36})$/.exec(job.id)?.[1];
      if (!id) throw new Error('run_activation_link_required');
      const row = (
        await this.pool.query(
          'SELECT id,issue_id,issue_number,repository_id FROM factory_task_activations WHERE id=$1 AND repository=$2 AND source_commit=$3',
          [id, job.repository.toLowerCase(), job.sourceCommit],
        )
      ).rows[0];
      if (!row) throw new Error('run_activation_link_required');
      task = {
        activationId: row.id,
        issueId: row.issue_id,
        number: row.issue_number,
        repositoryId: row.repository_id,
      };
    }
    const count = task
      ? Number(
          (
            await this.pool.query(
              "SELECT count(*) AS n FROM factory_worker_runs r JOIN factory_work w ON w.id=r.work_id JOIN factory_task_activations a ON w.delivery_key='activation-' || a.id::text AND w.record_key=a.repository WHERE w.record_key=$1 AND a.issue_id::text=$2 AND a.repository_id::text=$3 AND w.delivery_key<>$4",
              [job.repository.toLowerCase(), task.issueId, task.repositoryId, job.id],
            )
          ).rows[0].n,
        )
      : 0;
    if (count >= limits.maxTaskRuns) throw new Error('task_run_limit_reached');
    return {
      version: 1,
      task,
      sourceHead: job.sourceCommit,
      archiveSha256: job.archiveSha256,
      revision: count,
      limits: { ...limits, concurrency: 1 },
      ...outcomeEvidence(),
    };
  }
  async status(id?: string) {
    return (
      await this.pool.query(
        `SELECT w.delivery_key AS job_id,w.id AS work_id,w.state AS work_state,w.attempts,GREATEST(w.attempts-1,0) AS retry_count,
      w.cancel_requested,w.content_deleted_at,r.run_id,r.state,COALESCE(r.reason,w.last_error) AS reason,r.image_id,r.started_at,r.ended_at,r.evidence,
      (SELECT jsonb_build_object('pullNumber',p.pull_number,'observedHead',s.head,'verifiedHead',CASE WHEN s.state IN ('awaiting_human_merge','reconciled') THEN s.head ELSE NULL END,'state',s.state,'reason',s.reason)
       FROM factory_pr_pairs p LEFT JOIN factory_pr_state s USING(repository_id,pull_number)
       WHERE p.repository_id::text=r.evidence->'task'->>'repositoryId' AND p.task_number::text=r.evidence->'task'->>'number'
       AND p.pull_number::text=r.evidence->'publication'->>'pullNumber' AND s.head=r.evidence->'publication'->>'builtHead' LIMIT 1) AS review
      FROM factory_work w LEFT JOIN factory_worker_runs r ON r.work_id=w.id
      WHERE w.queue_name='CodingJob' AND ($1::text IS NULL OR w.delivery_key=$1) ORDER BY w.id DESC,r.started_at DESC LIMIT 100`,
        [id ?? null],
      )
    ).rows.map((row) => ({
      ...row,
      reason: row.reason === null ? null : code(row.reason),
      evidence: { ...outcomeEvidence(), ...row.evidence },
    }));
  }
  async cancel(id: string, repository: string) {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('CodingJob',606))");
      const row = (
        await client.query(
          "SELECT id,state FROM factory_work WHERE queue_name='CodingJob' AND delivery_key=$1 AND record_key=$2 FOR UPDATE",
          [id, repository.toLowerCase()],
        )
      ).rows[0];
      if (!row || !['pending', 'running'].includes(row.state)) return 0;
      await client.query(
        "UPDATE factory_work SET cancel_requested=true,state=CASE WHEN state='pending' THEN 'dead' ELSE state END,last_error='operator_cancelled',settled_at=CASE WHEN state='pending' THEN clock_timestamp() ELSE settled_at END WHERE id=$1",
        [row.id],
      );
      await client.query(
        "UPDATE factory_worker_runs SET cancel_requested=true WHERE work_id=$1 AND state IN ('preparing','running')",
        [row.id],
      );
      return 1;
    });
  }
  async prune(days: number) {
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw new Error('invalid_retention_days');
    const result = await this.pool.query(
      `UPDATE factory_work w SET body=NULL,result=NULL,content_deleted_at=clock_timestamp()
      WHERE queue_name='CodingJob' AND state IN ('done','dead') AND settled_at<clock_timestamp()-$1*interval '1 day'
      AND content_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM factory_worker_runs r WHERE r.work_id=w.id AND (r.ended_at IS NULL OR r.state IN ('cleanup_failed','lease_lost')))`,
      [days],
    );
    return result.rowCount ?? 0;
  }
}
