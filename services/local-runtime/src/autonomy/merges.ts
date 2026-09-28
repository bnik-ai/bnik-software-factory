import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AutonomyError, requireAutonomy } from './schema.js';

/**
 * Merge records for published attempts (migration 0012). One record per run; every
 * state change is a compare-and-set transition so a restarted or duplicated merge
 * command resumes where the last one stopped and never merges twice.
 */
export const MERGE_STATES = [
  'observing',
  'held',
  'admitted',
  'merged',
  'blocked',
  'unknown',
] as const;
export type MergeState = (typeof MERGE_STATES)[number];
export const TERMINAL_MERGE_STATES: readonly MergeState[] = ['merged', 'blocked'];
export interface AutonomyMerge {
  mergeId: string;
  repositoryId: number;
  runId: string;
  taskId: string;
  pullNumber: number;
  head: string;
  tree: string;
  base: string;
  state: MergeState;
  reason: string | null;
  mergeDecisionId: string | null;
  observation: Record<string, unknown> | null;
  mergeCommit: string | null;
  proof: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
type Patch = Partial<
  Pick<
    AutonomyMerge,
    'reason' | 'mergeDecisionId' | 'observation' | 'mergeCommit' | 'proof' | 'evidence'
  >
>;
const COLUMNS: Record<keyof Patch, string> = {
  reason: 'reason',
  mergeDecisionId: 'merge_decision_id',
  observation: 'observation',
  mergeCommit: 'merge_commit',
  proof: 'proof',
  evidence: 'evidence',
};
const JSON_COLUMNS = new Set(['observation', 'proof', 'evidence']);
function row(value: Record<string, unknown>): AutonomyMerge {
  return {
    mergeId: value.merge_id as string,
    repositoryId: Number(value.repository_id),
    runId: value.run_id as string,
    taskId: value.task_id as string,
    pullNumber: Number(value.pull_number),
    head: value.head as string,
    tree: value.tree as string,
    base: value.base as string,
    state: value.state as MergeState,
    reason: (value.reason as string | null) ?? null,
    mergeDecisionId: (value.merge_decision_id as string | null) ?? null,
    observation: (value.observation as Record<string, unknown> | null) ?? null,
    mergeCommit: (value.merge_commit as string | null) ?? null,
    proof: (value.proof as Record<string, unknown> | null) ?? null,
    evidence: (value.evidence as Record<string, unknown>) ?? {},
    createdAt: value.created_at as Date,
    updatedAt: value.updated_at as Date,
  };
}
export class AutonomyMerges {
  constructor(private readonly pool: Pool) {}
  async forRun(runId: string): Promise<AutonomyMerge | null> {
    const result = await this.pool.query('SELECT * FROM factory_autonomy_merges WHERE run_id=$1', [
      runId,
    ]);
    return result.rows[0] ? row(result.rows[0]) : null;
  }
  async get(mergeId: string): Promise<AutonomyMerge | null> {
    const result = await this.pool.query(
      'SELECT * FROM factory_autonomy_merges WHERE merge_id=$1',
      [mergeId],
    );
    return result.rows[0] ? row(result.rows[0]) : null;
  }
  /** Merge records for a pull request, newest first (one per attempt that published it). */
  async forPull(repositoryId: number, pullNumber: number): Promise<AutonomyMerge[]> {
    const result = await this.pool.query(
      'SELECT * FROM factory_autonomy_merges WHERE repository_id=$1 AND pull_number=$2 ORDER BY created_at DESC',
      [repositoryId, pullNumber],
    );
    return result.rows.map(row);
  }
  async list(repositoryId: number, limit = 100): Promise<AutonomyMerge[]> {
    const result = await this.pool.query(
      'SELECT * FROM factory_autonomy_merges WHERE repository_id=$1 ORDER BY updated_at DESC LIMIT $2',
      [repositoryId, Math.min(Math.max(1, limit), 500)],
    );
    return result.rows.map(row);
  }
  async create(input: {
    repositoryId: number;
    runId: string;
    taskId: string;
    pullNumber: number;
    head: string;
    tree: string;
    base: string;
  }): Promise<AutonomyMerge> {
    try {
      const result = await this.pool.query(
        `INSERT INTO factory_autonomy_merges(merge_id,repository_id,run_id,task_id,pull_number,head,tree,base,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'observing') RETURNING *`,
        [
          randomUUID(),
          input.repositoryId,
          input.runId,
          input.taskId,
          input.pullNumber,
          input.head,
          input.tree,
          input.base,
        ],
      );
      return row(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AutonomyError('merge_record_exists');
      throw error;
    }
  }
  /** Compare-and-set transition; a stale controller loses and must re-read. */
  async transition(
    mergeId: string,
    from: readonly MergeState[],
    to: MergeState,
    patch: Patch = {},
  ): Promise<AutonomyMerge> {
    requireAutonomy((MERGE_STATES as readonly string[]).includes(to), 'merge_state_invalid');
    const assignments: string[] = ['state=$3', 'updated_at=clock_timestamp()'];
    const values: unknown[] = [mergeId, from, to];
    for (const [key, value] of Object.entries(patch) as [keyof Patch, unknown][]) {
      values.push(JSON_COLUMNS.has(key) ? JSON.stringify(value) : value);
      assignments.push(
        `${COLUMNS[key]}=$${values.length}${JSON_COLUMNS.has(key) ? '::jsonb' : ''}`,
      );
    }
    const result = await this.pool.query(
      `UPDATE factory_autonomy_merges SET ${assignments.join(',')} WHERE merge_id=$1 AND state = ANY($2::text[]) RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw new AutonomyError('merge_state_conflict');
    return row(result.rows[0]);
  }
}
