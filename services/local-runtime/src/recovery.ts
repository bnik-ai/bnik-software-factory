import type { Pool } from 'pg';
import { transaction } from './database.js';
import type { WorkState } from './queue.js';

export class RecoveryFailure extends Error {}
export interface RecoveryRequest {
  action: 'replay' | 'quarantine';
  workId: string;
  version: number;
  requestId: string;
  reason: string;
}
interface Row {
  id: string;
  queue_name: string;
  record_key: string;
  state: WorkState;
  attempts: number;
  max_attempts: number;
  recovery_version: number;
  last_error: string | null;
  body_hash: string;
  has_body: boolean;
  available_at: Date;
  lease_until: Date | null;
}
const columns = `id,queue_name,record_key,state,attempts,max_attempts,recovery_version,last_error,
 body_hash,body IS NOT NULL AS has_body,available_at,lease_until`;
const idPattern = /^[1-9][0-9]{0,18}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const replayQueues = new Set(['GitHubIntake', 'HumanMergeGate']);
export function recoveryRequest(args: string[]): RecoveryRequest {
  const [action, workId, rawVersion, requestId, reason] = args;
  if (
    args.length !== 5 ||
    (action !== 'replay' && action !== 'quarantine') ||
    !workId ||
    !idPattern.test(workId) ||
    !rawVersion ||
    !/^(0|[1-9][0-9]{0,8})$/.test(rawVersion) ||
    !requestId ||
    !uuidPattern.test(requestId) ||
    !reason ||
    !/^[a-z][a-z0-9_]{2,63}$/.test(reason)
  )
    throw new RecoveryFailure('recovery_arguments_invalid');
  return { action, workId, version: Number(rawVersion), requestId, reason };
}
function reason(value: string | null) {
  return value && /^[a-z][a-z0-9_]{0,255}$/.test(value) ? value : 'unclassified_failure';
}
function snapshot(row: Row) {
  return {
    workId: row.id,
    queue: row.queue_name,
    state: (
      {
        pending: 'queued',
        running: 'running',
        done: 'completed',
        dead: 'failed',
        quarantined: 'quarantined',
      } as const
    )[row.state],
    reason:
      row.state === 'dead' || row.state === 'quarantined' || row.last_error
        ? reason(row.last_error)
        : row.state === 'pending'
          ? 'waiting_for_claim'
          : row.state === 'running'
            ? 'lease_held'
            : 'settled',
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    recoveryVersion: row.recovery_version,
    bodyHash: row.body_hash,
    availableAt: row.available_at,
    leaseUntil: row.lease_until,
    replayAllowed:
      replayQueues.has(row.queue_name) &&
      ['dead', 'quarantined'].includes(row.state) &&
      row.has_body &&
      row.attempts < 100,
    nextAction:
      row.queue_name === 'CodingJob'
        ? 'inspect_worker_status_recover_cleanup_then_fresh_human_activation'
        : 'inspect_current_cause_before_recovery',
  };
}
export class Recovery {
  constructor(private readonly pool: Pool) {}
  async inspect(id?: string) {
    if (id !== undefined && !idPattern.test(id)) throw new RecoveryFailure('work_id_invalid');
    const rows = await this.pool.query<Row>(
      `SELECT ${columns} FROM factory_work WHERE ($1::bigint IS NULL OR id=$1) ORDER BY id DESC LIMIT 100`,
      [id ?? null],
    );
    if (id && !rows.rowCount) throw new RecoveryFailure('work_not_found');
    const actions = id
      ? (
          await this.pool.query(
            'SELECT request_id,action,expected_version,reason,principal,before_state,after_state,created_at FROM factory_recovery_actions WHERE work_id=$1 ORDER BY created_at DESC LIMIT 100',
            [id],
          )
        ).rows
      : [];
    // Keep PR policy state distinct from an individual scan's queue settlement.
    const reviews = (
      await this.pool.query(
        'SELECT pull_number,state,reason,head,updated_at FROM factory_pr_state ORDER BY updated_at DESC LIMIT 100',
      )
    ).rows.map((row) => ({
      ...row,
      state:
        row.state === 'awaiting_human_merge'
          ? 'awaiting-human'
          : row.state === 'reconciled'
            ? 'completed'
            : 'failed',
      reason: reason(row.reason),
    }));
    return { work: rows.rows.map(snapshot), reviews, actions, limit: 100 };
  }
  async act(input: RecoveryRequest) {
    const request = recoveryRequest([
      input.action,
      input.workId,
      String(input.version),
      input.requestId,
      input.reason,
    ]);
    return transaction(this.pool, async (client) => {
      // Serializes the same request even when callers supply conflicting work IDs.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 611))', [
        request.requestId,
      ]);
      const previous = await client.query(
        'SELECT * FROM factory_recovery_actions WHERE request_id=$1',
        [request.requestId],
      );
      const old = previous.rows[0];
      if (old) {
        if (
          old.work_id !== request.workId ||
          old.action !== request.action ||
          old.expected_version !== request.version ||
          old.reason !== request.reason
        )
          throw new RecoveryFailure('recovery_request_conflict');
        return {
          requestId: request.requestId,
          cached: true,
          outcome: old.after_state,
        };
      }
      const identity = await client.query<{ queue_name: string }>(
        'SELECT queue_name FROM factory_work WHERE id=$1',
        [request.workId],
      );
      if (!identity.rows[0]) throw new RecoveryFailure('work_not_found');
      // Same lock order as enqueue/claim; never revive work alongside a sibling lease.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 606))', [
        identity.rows[0].queue_name,
      ]);
      const selected = await client.query<Row>(
        `SELECT ${columns} FROM factory_work WHERE id=$1 FOR UPDATE`,
        [request.workId],
      );
      const row = selected.rows[0];
      if (!row) throw new RecoveryFailure('work_not_found');
      if (row.recovery_version !== request.version)
        throw new RecoveryFailure('recovery_version_changed_inspect_again');
      if (row.state === 'running' || row.state === 'done')
        throw new RecoveryFailure('active_or_completed_work_cannot_be_recovered');
      if (request.action === 'replay') {
        if (!replayQueues.has(row.queue_name))
          throw new RecoveryFailure('replay_queue_forbidden_fresh_activation_required');
        if (!['dead', 'quarantined'].includes(row.state) || !row.has_body)
          throw new RecoveryFailure('replay_requires_failed_retained_item');
        const siblings = await client.query(
          "SELECT 1 FROM factory_work WHERE queue_name=$1 AND record_key=$2 AND id<>$3 AND state IN ('pending','running')",
          [row.queue_name, row.record_key, row.id],
        );
        if (siblings.rowCount) throw new RecoveryFailure('record_has_active_work_inspect_again');
        if (row.attempts >= 100) throw new RecoveryFailure('lifetime_attempt_limit_reached');
      } else if (!['pending', 'dead'].includes(row.state))
        throw new RecoveryFailure('quarantine_requires_queued_or_failed_item');
      const unfinished = await client.query(
        "SELECT 1 FROM factory_worker_runs WHERE work_id=$1 AND (ended_at IS NULL OR state='cleanup_failed')",
        [row.id],
      );
      if (unfinished.rowCount) throw new RecoveryFailure('worker_cleanup_required');
      const before = snapshot(row);
      const updated = await client.query<Row>(
        `UPDATE factory_work SET state=$2,recovery_version=recovery_version+1,
         max_attempts=CASE WHEN $2='pending' THEN attempts+1 ELSE max_attempts END,
         available_at=clock_timestamp(),settled_at=CASE WHEN $2='pending' THEN NULL ELSE clock_timestamp() END,
         last_error=$3 WHERE id=$1 RETURNING ${columns}`,
        [
          row.id,
          request.action === 'replay' ? 'pending' : 'quarantined',
          `operator_${request.action}`,
        ],
      );
      const after = updated.rows[0];
      if (!after) throw new RecoveryFailure('work_not_found');
      const outcome = snapshot(after);
      await client.query(
        `INSERT INTO factory_recovery_actions(request_id,work_id,action,expected_version,reason,before_state,after_state)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [
          request.requestId,
          row.id,
          request.action,
          request.version,
          request.reason,
          JSON.stringify(before),
          JSON.stringify(outcome),
        ],
      );
      return { requestId: request.requestId, cached: false, outcome };
    });
  }
}
