import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AutonomyError, requireAutonomy } from './schema.js';

/**
 * Durable pipeline state, one row per Task attempt. The controller advances a row
 * with compare-and-set transitions, so a crashed or duplicated controller resumes
 * from the recorded step instead of repeating paid or external work.
 */
export const RUN_STATES = [
  'admitted',
  'executing',
  'executed',
  'collected',
  'verified',
  'publish_admitted',
  'published',
  'held',
  'repair',
  'blocked',
  'failed',
  'cancelled',
  'unknown',
] as const;
export type RunState = (typeof RUN_STATES)[number];
/** States a controller never re-enters; a new attempt starts a new row. `held` waits for a human. */
export const TERMINAL_STATES: readonly RunState[] = [
  'published',
  'repair',
  'blocked',
  'failed',
  'cancelled',
];
export interface AutonomyRun {
  runId: string;
  repositoryId: number;
  scopeId: string;
  taskId: string;
  taskNumber: number;
  taskIssueId: number;
  attempt: number;
  state: RunState;
  reason: string | null;
  executeDecisionId: string | null;
  reservationId: string | null;
  workerJobId: string | null;
  sourceCommit: string | null;
  archiveSha256: string | null;
  intentSha256: string | null;
  baseTree: string | null;
  candidateTree: string | null;
  changesSha256: string | null;
  receipts: Record<string, unknown>;
  publishDecisionId: string | null;
  publication: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
type Patch = Partial<
  Pick<
    AutonomyRun,
    | 'reason'
    | 'executeDecisionId'
    | 'reservationId'
    | 'workerJobId'
    | 'sourceCommit'
    | 'archiveSha256'
    | 'intentSha256'
    | 'baseTree'
    | 'candidateTree'
    | 'changesSha256'
    | 'receipts'
    | 'publishDecisionId'
    | 'publication'
    | 'evidence'
  >
>;
const COLUMNS: Record<keyof Patch, string> = {
  reason: 'reason',
  executeDecisionId: 'execute_decision_id',
  reservationId: 'reservation_id',
  workerJobId: 'worker_job_id',
  sourceCommit: 'source_commit',
  archiveSha256: 'archive_sha256',
  intentSha256: 'intent_sha256',
  baseTree: 'base_tree',
  candidateTree: 'candidate_tree',
  changesSha256: 'changes_sha256',
  receipts: 'receipts',
  publishDecisionId: 'publish_decision_id',
  publication: 'publication',
  evidence: 'evidence',
};
const JSON_COLUMNS = new Set(['receipts', 'publication', 'evidence']);
function row(value: Record<string, unknown>): AutonomyRun {
  return {
    runId: value.run_id as string,
    repositoryId: Number(value.repository_id),
    scopeId: value.scope_id as string,
    taskId: value.task_id as string,
    taskNumber: Number(value.task_number),
    taskIssueId: Number(value.task_issue_id),
    attempt: Number(value.attempt),
    state: value.state as RunState,
    reason: (value.reason as string | null) ?? null,
    executeDecisionId: (value.execute_decision_id as string | null) ?? null,
    reservationId: (value.reservation_id as string | null) ?? null,
    workerJobId: (value.worker_job_id as string | null) ?? null,
    sourceCommit: (value.source_commit as string | null) ?? null,
    archiveSha256: (value.archive_sha256 as string | null) ?? null,
    intentSha256: (value.intent_sha256 as string | null) ?? null,
    baseTree: (value.base_tree as string | null) ?? null,
    candidateTree: (value.candidate_tree as string | null) ?? null,
    changesSha256: (value.changes_sha256 as string | null) ?? null,
    receipts: (value.receipts as Record<string, unknown>) ?? {},
    publishDecisionId: (value.publish_decision_id as string | null) ?? null,
    publication: (value.publication as Record<string, unknown> | null) ?? null,
    evidence: (value.evidence as Record<string, unknown>) ?? {},
    createdAt: value.created_at as Date,
    updatedAt: value.updated_at as Date,
  };
}
export class AutonomyRuns {
  constructor(private readonly pool: Pool) {}
  /** The attempt a controller must resume, if any. */
  async open(repositoryId: number, taskId: string): Promise<AutonomyRun | null> {
    const result = await this.pool.query(
      'SELECT * FROM factory_autonomy_runs WHERE repository_id=$1 AND task_id=$2 AND NOT (state = ANY($3::text[])) ORDER BY attempt DESC LIMIT 1',
      [repositoryId, taskId, TERMINAL_STATES],
    );
    return result.rows[0] ? row(result.rows[0]) : null;
  }
  async latest(repositoryId: number, taskId: string): Promise<AutonomyRun | null> {
    const result = await this.pool.query(
      'SELECT * FROM factory_autonomy_runs WHERE repository_id=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 1',
      [repositoryId, taskId],
    );
    return result.rows[0] ? row(result.rows[0]) : null;
  }
  async get(runId: string): Promise<AutonomyRun | null> {
    const result = await this.pool.query('SELECT * FROM factory_autonomy_runs WHERE run_id=$1', [
      runId,
    ]);
    return result.rows[0] ? row(result.rows[0]) : null;
  }
  /** Every published attempt of the repository (a scan must not miss old ones). */
  async published(repositoryId: number): Promise<AutonomyRun[]> {
    const result = await this.pool.query(
      "SELECT * FROM factory_autonomy_runs WHERE repository_id=$1 AND state='published' ORDER BY updated_at DESC",
      [repositoryId],
    );
    return result.rows.map(row);
  }
  async list(repositoryId: number, limit = 100): Promise<AutonomyRun[]> {
    const result = await this.pool.query(
      'SELECT * FROM factory_autonomy_runs WHERE repository_id=$1 ORDER BY updated_at DESC LIMIT $2',
      [repositoryId, Math.min(Math.max(1, limit), 500)],
    );
    return result.rows.map(row);
  }
  /** Starts the next attempt; fails when an open attempt exists (unique partial index). */
  async create(input: {
    repositoryId: number;
    scopeId: string;
    taskId: string;
    taskNumber: number;
    taskIssueId: number;
    intentSha256: string;
    sourceCommit: string;
  }): Promise<AutonomyRun> {
    const latest = await this.latest(input.repositoryId, input.taskId);
    const attempt = (latest?.attempt ?? 0) + 1;
    try {
      const result = await this.pool.query(
        `INSERT INTO factory_autonomy_runs(run_id,repository_id,scope_id,task_id,task_number,task_issue_id,attempt,state,intent_sha256,source_commit)
         VALUES($1,$2,$3,$4,$5,$6,$7,'admitted',$8,$9) RETURNING *`,
        [
          randomUUID(),
          input.repositoryId,
          input.scopeId,
          input.taskId,
          input.taskNumber,
          input.taskIssueId,
          attempt,
          input.intentSha256,
          input.sourceCommit,
        ],
      );
      return row(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AutonomyError('run_attempt_open_or_duplicate');
      throw error;
    }
  }
  /** Compare-and-set transition; a stale controller loses and must re-read. */
  async transition(
    runId: string,
    from: readonly RunState[],
    to: RunState,
    patch: Patch = {},
  ): Promise<AutonomyRun> {
    requireAutonomy((RUN_STATES as readonly string[]).includes(to), 'run_state_invalid');
    const assignments: string[] = ['state=$3', 'updated_at=clock_timestamp()'];
    const values: unknown[] = [runId, from, to];
    for (const [key, value] of Object.entries(patch) as [keyof Patch, unknown][]) {
      values.push(JSON_COLUMNS.has(key) ? JSON.stringify(value) : value);
      assignments.push(
        `${COLUMNS[key]}=$${values.length}${JSON_COLUMNS.has(key) ? '::jsonb' : ''}`,
      );
    }
    const result = await this.pool.query(
      `UPDATE factory_autonomy_runs SET ${assignments.join(',')} WHERE run_id=$1 AND state = ANY($2::text[]) RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw new AutonomyError('run_state_conflict');
    return row(result.rows[0]);
  }
}
