import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../database.js';
import { type Decision, decide, parseRequest } from './decision.js';
import {
  type AutonomyPolicy,
  comparePolicies,
  parsePolicy,
  policyDigest,
  weakeningCodes,
} from './policy.js';
import {
  AutonomyError,
  requireAutonomy,
  requireInteger,
  requireText,
  requireUniqueList,
  sha256Json,
} from './schema.js';

export const SCOPE_MAX_TTL_MS = 30 * 86_400_000;
/** An allowed decision must be acted on promptly; afterwards it is re-decided on current facts. */
export const ADMISSION_TTL_MS = 600_000;

export interface ScopeGrant {
  scopeId: string;
  repositoryId: number;
  taskIds: string[];
  models: string[];
  budgetMicrousd: number;
  maxTaskRuns: number;
  expiresAt: number;
}
export type Settlement =
  | { state: 'settled'; microusd: number }
  | { state: 'released' }
  | { state: 'unknown' };
interface RequestSummary {
  requestId: string;
  action: string;
  scopeId: string;
  taskId: string;
  base: string;
  head: string | null;
  tree: string | null;
  changesSha256: string | null;
  execution: { model: string; maxTurns: number; maxRunMs: number; budgetMicrousd: number } | null;
}

const timestamp = (milliseconds: number) => new Date(milliseconds).toISOString();
function requireActor(actor: unknown): asserts actor is string {
  requireText(actor, 128, 'actor_invalid');
}
async function lockRepository(client: PoolClient, repositoryId: number) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('factory_autonomy',$1))", [
    repositoryId,
  ]);
}
async function activeDocument(client: Pick<PoolClient, 'query'>, repositoryId: number) {
  const row = (
    await client.query(
      'SELECT c.active_policy_sha256,c.paused,p.document FROM factory_autonomy_control c JOIN factory_autonomy_policies p ON p.policy_sha256=c.active_policy_sha256 WHERE c.repository_id=$1',
      [repositoryId],
    )
  ).rows[0];
  return row
    ? {
        policySha256: row.active_policy_sha256 as string,
        paused: row.paused as boolean,
        policy: parsePolicy(row.document),
      }
    : null;
}

/**
 * Durable autonomy state: the active policy, pause, standing scopes, recorded
 * decisions, single-use admissions and budget reservations. Writes require the
 * trusted operator identity; the runtime role can only read these tables.
 */
export class AutonomyLedger {
  constructor(private readonly pool: Pool) {}

  /**
   * The currently active policy assesses its replacement. Every weakening must be
   * acknowledged by exact code, so an edited file cannot silently expand authority.
   */
  async activatePolicy(
    proposedValue: unknown,
    acknowledgedWeakenings: string[],
    actor: string,
    now: number,
  ) {
    const proposed = parsePolicy(proposedValue);
    requireActor(actor);
    requireUniqueList<string>(acknowledgedWeakenings, 0, 500, 'acknowledgement_invalid');
    return transaction(this.pool, async (client) => {
      await lockRepository(client, proposed.repository.id);
      const current = await activeDocument(client, proposed.repository.id);
      const weakenings = current
        ? weakeningCodes(comparePolicies(current.policy, proposed))
        : [
            'initial_activation',
            ...(proposed.mode === 'bounded' ? ['mode_changed:human_gated->bounded'] : []),
          ].sort();
      requireAutonomy(
        sha256Json([...acknowledgedWeakenings].sort()) === sha256Json(weakenings),
        'policy_weakening_not_acknowledged',
      );
      const policySha256 = policyDigest(proposed);
      await client.query(
        'INSERT INTO factory_autonomy_policies(policy_sha256,repository_id,revision,mode,document,previous_sha256,acknowledged_weakenings,activated_by,activated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          policySha256,
          proposed.repository.id,
          proposed.revision,
          proposed.mode,
          JSON.stringify(proposed),
          current?.policySha256 ?? null,
          JSON.stringify(weakenings),
          actor,
          timestamp(now),
        ],
      );
      // Pause state carries over; a new policy never silently resumes paused work.
      await client.query(
        `INSERT INTO factory_autonomy_control(repository_id,active_policy_sha256,updated_by,updated_at) VALUES($1,$2,$3,$4)
         ON CONFLICT(repository_id) DO UPDATE SET active_policy_sha256=EXCLUDED.active_policy_sha256,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
        [proposed.repository.id, policySha256, actor, timestamp(now)],
      );
      return { policySha256, weakenings };
    });
  }

  async activePolicy(repositoryId: number): Promise<AutonomyPolicy | null> {
    return (await activeDocument(this.pool, repositoryId))?.policy ?? null;
  }

  async setPaused(
    repositoryId: number,
    paused: boolean,
    reason: string | null,
    actor: string,
    now: number,
  ) {
    requireActor(actor);
    requireAutonomy(typeof paused === 'boolean', 'pause_invalid');
    if (paused) requireText(reason, 500, 'pause_reason_required');
    // Serialized with admission: once this returns, no admission can commit unpaused.
    await transaction(this.pool, async (client) => {
      await lockRepository(client, repositoryId);
      const result = await client.query(
        'UPDATE factory_autonomy_control SET paused=$2,pause_reason=$3,updated_by=$4,updated_at=$5 WHERE repository_id=$1',
        [repositoryId, paused, paused ? reason : null, actor, timestamp(now)],
      );
      requireAutonomy(result.rowCount === 1, 'autonomy_not_configured');
    });
  }

  async grantScope(grant: ScopeGrant, actor: string, now: number) {
    requireActor(actor);
    requireAutonomy(
      typeof grant.scopeId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(grant.scopeId),
      'scope_id_invalid',
    );
    requireUniqueList<string>(grant.taskIds, 1, 100, 'scope_tasks_invalid');
    for (const taskId of grant.taskIds) requireText(taskId, 128, 'scope_tasks_invalid');
    requireUniqueList<string>(grant.models, 1, 20, 'scope_models_invalid');
    requireInteger(grant.expiresAt, now + 1, now + SCOPE_MAX_TTL_MS, 'scope_expiry_invalid');
    return transaction(this.pool, async (client) => {
      await lockRepository(client, grant.repositoryId);
      const active = await activeDocument(client, grant.repositoryId);
      requireAutonomy(active, 'autonomy_not_configured');
      const { policy } = active;
      requireAutonomy(
        grant.models.every((model) => policy.execution.models.includes(model)),
        'scope_model_not_in_policy',
      );
      requireInteger(
        grant.budgetMicrousd,
        1,
        policy.execution.maxScopeMicrousd,
        'scope_budget_exceeds_policy',
      );
      requireInteger(
        grant.maxTaskRuns,
        1,
        policy.execution.maxTaskRuns,
        'scope_runs_exceed_policy',
      );
      await client.query(
        'INSERT INTO factory_autonomy_scopes(scope_id,repository_id,policy_sha256,task_ids,models,budget_microusd,max_task_runs,expires_at,granted_by,granted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          grant.scopeId,
          grant.repositoryId,
          active.policySha256,
          JSON.stringify(grant.taskIds),
          JSON.stringify(grant.models),
          grant.budgetMicrousd,
          grant.maxTaskRuns,
          timestamp(grant.expiresAt),
          actor,
          timestamp(now),
        ],
      );
      return { scopeId: grant.scopeId, policySha256: active.policySha256 };
    });
  }

  async revokeScope(scopeId: string, reason: string, actor: string, now: number) {
    requireActor(actor);
    requireText(reason, 500, 'revoke_reason_required');
    await transaction(this.pool, async (client) => {
      const owner = (
        await client.query('SELECT repository_id FROM factory_autonomy_scopes WHERE scope_id=$1', [
          scopeId,
        ])
      ).rows[0];
      requireAutonomy(owner, 'scope_missing_or_already_revoked');
      // Serialized with admission: once this returns, the scope admits nothing further.
      await lockRepository(client, Number(owner.repository_id));
      const result = await client.query(
        'UPDATE factory_autonomy_scopes SET revoked_at=$2,revoked_by=$3,revoke_reason=$4 WHERE scope_id=$1 AND revoked_at IS NULL',
        [scopeId, timestamp(now), actor, reason],
      );
      requireAutonomy(result.rowCount === 1, 'scope_missing_or_already_revoked');
    });
  }

  /** Decide and record. Recording never grants anything; only consume() does. */
  async admit(policy: AutonomyPolicy, requestValue: unknown, evidence: unknown, now: number) {
    const active = await activeDocument(this.pool, policy.repository.id);
    requireAutonomy(active && active.policySha256 === policyDigest(policy), 'policy_not_active');
    const decision: Decision = decide(policy, requestValue, evidence, now);
    let summary: RequestSummary | null = null;
    if (decision.requestSha256 !== null) {
      const request = parseRequest(policy, requestValue);
      summary = {
        requestId: request.requestId,
        action: request.action,
        scopeId: request.scopeId,
        taskId: request.task.id,
        base: request.base,
        head: request.head,
        tree: request.tree,
        changesSha256: request.changes === null ? null : sha256Json(request.changes),
        execution: request.execution,
      };
    }
    const decisionId = randomUUID();
    await this.pool.query(
      'INSERT INTO factory_autonomy_decisions(decision_id,repository_id,request_id,scope_id,task_id,action,outcome,risk,request_sha256,action_sha256,policy_sha256,request_summary,approval_sha256,decision,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        decisionId,
        policy.repository.id,
        summary?.requestId ?? null,
        summary?.scopeId ?? null,
        summary?.taskId ?? null,
        decision.action,
        decision.outcome,
        decision.risk,
        decision.requestSha256,
        decision.actionSha256,
        decision.policySha256,
        summary === null ? null : JSON.stringify(summary),
        decision.approvalSha256,
        JSON.stringify(decision),
        timestamp(decision.decidedAt),
      ],
    );
    return { decisionId, decision };
  }

  /**
   * Single-use admission. Re-checks everything that can change after a decision:
   * active policy, pause, scope revocation/expiry/membership, task attempts and budget.
   */
  async consume(decisionId: string, now: number) {
    requireAutonomy(
      typeof decisionId === 'string' && /^[0-9a-f-]{36}$/.test(decisionId),
      'admission_missing',
    );
    return transaction(this.pool, async (client) => {
      const owner = (
        await client.query(
          'SELECT repository_id FROM factory_autonomy_decisions WHERE decision_id=$1',
          [decisionId],
        )
      ).rows[0];
      requireAutonomy(owner, 'admission_missing');
      // Same lock order as every other ledger write: repository first, then rows.
      await lockRepository(client, Number(owner.repository_id));
      const row = (
        await client.query(
          'SELECT * FROM factory_autonomy_decisions WHERE decision_id=$1 FOR UPDATE',
          [decisionId],
        )
      ).rows[0];
      requireAutonomy(row.outcome === 'allow', 'admission_not_allowed');
      requireAutonomy(row.consumed_at === null, 'admission_already_consumed');
      requireAutonomy(
        now - new Date(row.decided_at).getTime() <= ADMISSION_TTL_MS,
        'admission_expired',
      );
      const summary = row.request_summary as RequestSummary;
      const active = await activeDocument(client, Number(row.repository_id));
      requireAutonomy(active, 'autonomy_not_configured');
      requireAutonomy(active.policySha256 === row.policy_sha256, 'policy_changed_since_decision');
      requireAutonomy(!active.paused, 'autonomy_paused');
      const scope = (
        await client.query('SELECT * FROM factory_autonomy_scopes WHERE scope_id=$1 FOR UPDATE', [
          summary.scopeId,
        ])
      ).rows[0];
      requireAutonomy(
        scope && Number(scope.repository_id) === Number(row.repository_id),
        'scope_missing',
      );
      requireAutonomy(scope.revoked_at === null, 'scope_revoked');
      requireAutonomy(new Date(scope.expires_at).getTime() > now, 'scope_expired');
      requireAutonomy(
        scope.policy_sha256 === active.policySha256,
        'scope_granted_under_other_policy',
      );
      requireAutonomy((scope.task_ids as string[]).includes(summary.taskId), 'task_outside_scope');
      const alreadyConsumed = await client.query(
        'SELECT 1 FROM factory_autonomy_decisions WHERE request_id=$1 AND consumed_at IS NOT NULL',
        [summary.requestId],
      );
      requireAutonomy(alreadyConsumed.rowCount === 0, 'request_already_admitted');
      if (row.approval_sha256 !== null) {
        const approvalUsed = await client.query(
          'SELECT 1 FROM factory_autonomy_decisions WHERE approval_sha256=$1 AND consumed_at IS NOT NULL',
          [row.approval_sha256],
        );
        requireAutonomy(approvalUsed.rowCount === 0, 'approval_already_used');
      }

      let reservationId: string | null = null;
      if (summary.action === 'execute') {
        const execution = summary.execution;
        requireAutonomy(execution, 'execution_limits_missing');
        requireAutonomy(
          (scope.models as string[]).includes(execution.model),
          'model_outside_scope',
        );
        // Attempts count per Task across every scope of the repository, so the policy
        // ceiling cannot be multiplied by granting overlapping scopes.
        const attempts = (
          await client.query(
            `SELECT count(*) FILTER (WHERE r.scope_id=$1) AS scope_runs, count(*) AS repository_runs
             FROM factory_autonomy_reservations r JOIN factory_autonomy_scopes s USING(scope_id)
             WHERE s.repository_id=$2 AND r.task_id=$3 AND r.state<>'released'`,
            [summary.scopeId, Number(row.repository_id), summary.taskId],
          )
        ).rows[0];
        requireAutonomy(
          Number(attempts.scope_runs) < Number(scope.max_task_runs) &&
            Number(attempts.repository_runs) < active.policy.execution.maxTaskRuns,
          'task_run_limit_reached',
        );
        const usage = (
          await client.query(
            `SELECT COALESCE(sum(CASE WHEN state='settled' THEN settled_microusd ELSE reserved_microusd END),0) AS committed
             FROM factory_autonomy_reservations WHERE scope_id=$1 AND state<>'released'`,
            [summary.scopeId],
          )
        ).rows[0];
        requireAutonomy(
          Number(usage.committed) + execution.budgetMicrousd <= Number(scope.budget_microusd),
          'scope_budget_exhausted',
        );
        reservationId = randomUUID();
        await client.query(
          "INSERT INTO factory_autonomy_reservations(reservation_id,scope_id,task_id,decision_id,reserved_microusd,state,created_at) VALUES($1,$2,$3,$4,$5,'reserved',$6)",
          [
            reservationId,
            summary.scopeId,
            summary.taskId,
            decisionId,
            execution.budgetMicrousd,
            timestamp(now),
          ],
        );
      }
      await client.query(
        'UPDATE factory_autonomy_decisions SET consumed_at=$2 WHERE decision_id=$1',
        [decisionId, timestamp(now)],
      );
      return { decisionId, reservationId };
    });
  }

  /**
   * `released` only when execution provably never started; `unknown` keeps the
   * full reservation until reconciled. A cost figure is an estimate, not a bill.
   */
  async settle(reservationId: string, settlement: Settlement, now: number) {
    requireAutonomy(
      ['settled', 'released', 'unknown'].includes(settlement.state),
      'settlement_invalid',
    );
    if (settlement.state === 'settled')
      requireInteger(settlement.microusd, 0, Number.MAX_SAFE_INTEGER, 'settlement_invalid');
    const allowedFrom = settlement.state === 'unknown' ? ['reserved'] : ['reserved', 'unknown'];
    const result = await this.pool.query(
      'UPDATE factory_autonomy_reservations SET state=$2,settled_microusd=$3,settled_at=$4 WHERE reservation_id=$1 AND state = ANY($5::text[])',
      [
        reservationId,
        settlement.state,
        settlement.state === 'settled' ? settlement.microusd : null,
        timestamp(now),
        allowedFrom,
      ],
    );
    if (result.rowCount !== 1) throw new AutonomyError('reservation_missing_or_already_settled');
  }
}
