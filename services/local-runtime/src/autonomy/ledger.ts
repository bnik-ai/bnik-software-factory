import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../database.js';
import { type Decision, decide, parseRequest } from './decision.js';
import type { ApprovalRecord } from './evidence.js';
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
  requireSha256,
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
  /** Task id -> intent digest the owner reviewed; a bound Task executes only with that exact intent. */
  taskIntents?: Record<string, string>;
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
  intentSha256: string;
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
/**
 * Serializes every ledger write for a repository on its control row. A row lock
 * needs UPDATE privilege, which the read-only runtime role lacks, so that role
 * cannot stall pause, revocation or admission (an advisory lock would let it).
 */
async function lockRepository(client: PoolClient, repositoryId: number) {
  await client.query(
    "INSERT INTO factory_autonomy_control(repository_id,updated_by) VALUES($1,'ledger') ON CONFLICT(repository_id) DO NOTHING",
    [repositoryId],
  );
  await client.query('SELECT 1 FROM factory_autonomy_control WHERE repository_id=$1 FOR UPDATE', [
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
      requireAutonomy(await activeDocument(client, repositoryId), 'autonomy_not_configured');
      await client.query(
        'UPDATE factory_autonomy_control SET paused=$2,pause_reason=$3,updated_by=$4,updated_at=$5 WHERE repository_id=$1',
        [repositoryId, paused, paused ? reason : null, actor, timestamp(now)],
      );
    });
  }

  /** Why an open attempt must not take its next step right now, or null. */
  async halted(repositoryId: number, scopeId: string, now: number): Promise<string | null> {
    const active = await activeDocument(this.pool, repositoryId);
    if (!active) return 'autonomy_not_configured';
    if (active.paused) return 'autonomy_paused';
    const scope = (
      await this.pool.query<{ revoked_at: Date | null; expires_at: Date }>(
        'SELECT revoked_at,expires_at FROM factory_autonomy_scopes WHERE scope_id=$1 AND repository_id=$2',
        [scopeId, repositoryId],
      )
    ).rows[0];
    if (!scope) return 'scope_missing';
    if (scope.revoked_at !== null) return 'scope_revoked';
    if (new Date(scope.expires_at).getTime() <= now) return 'scope_expired';
    return null;
  }
  async grantScope(grant: ScopeGrant, actor: string, now: number) {
    requireActor(actor);
    requireAutonomy(
      typeof grant.scopeId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(grant.scopeId),
      'scope_id_invalid',
    );
    requireUniqueList<string>(grant.taskIds, 1, 100, 'scope_tasks_invalid');
    for (const taskId of grant.taskIds) requireText(taskId, 128, 'scope_tasks_invalid');
    const intents = grant.taskIntents ?? {};
    for (const [taskId, digest] of Object.entries(intents)) {
      requireAutonomy(grant.taskIds.includes(taskId), 'scope_intent_task_unknown');
      requireSha256(digest, 'scope_intent_invalid');
    }
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
        'INSERT INTO factory_autonomy_scopes(scope_id,repository_id,policy_sha256,task_ids,models,budget_microusd,max_task_runs,expires_at,granted_by,granted_at,task_intents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
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
          JSON.stringify(intents),
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
        intentSha256: request.task.intentSha256,
        base: request.base,
        head: request.head,
        tree: request.tree,
        changesSha256: request.changes === null ? null : sha256Json(request.changes),
        execution: request.execution,
      };
    }
    const decisionId = randomUUID();
    await this.pool.query(
      'INSERT INTO factory_autonomy_decisions(decision_id,repository_id,request_id,scope_id,task_id,action,outcome,risk,request_sha256,action_sha256,policy_sha256,request_summary,approved_action_sha256,decision,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
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
        decision.approvedBy === null ? null : decision.actionSha256,
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
      // The owner granted a Task as written; an edited issue is not that Task.
      const boundIntent = (scope.task_intents as Record<string, string> | null)?.[summary.taskId];
      if (boundIntent !== undefined)
        requireAutonomy(boundIntent === summary.intentSha256, 'scope_intent_mismatch');
      const alreadyConsumed = await client.query(
        'SELECT 1 FROM factory_autonomy_decisions WHERE request_id=$1 AND consumed_at IS NOT NULL',
        [summary.requestId],
      );
      requireAutonomy(alreadyConsumed.rowCount === 0, 'request_already_admitted');
      // Keyed on the approved action, not the approval record, so re-rendering the
      // same human approval (another timestamp or source) cannot admit it twice.
      if (row.approved_action_sha256 !== null) {
        const approvalUsed = await client.query(
          'SELECT 1 FROM factory_autonomy_decisions WHERE approved_action_sha256=$1 AND consumed_at IS NOT NULL',
          [row.approved_action_sha256],
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

  /** A controller that crashed after consuming an admission finds it here instead of re-admitting. */
  async consumedAdmission(
    requestId: string,
  ): Promise<{ decisionId: string; decision: Decision; reservationId: string | null } | null> {
    const row = (
      await this.pool.query(
        `SELECT d.decision_id,d.decision,r.reservation_id FROM factory_autonomy_decisions d
         LEFT JOIN factory_autonomy_reservations r ON r.decision_id=d.decision_id
         WHERE d.request_id=$1 AND d.consumed_at IS NOT NULL`,
        [requestId],
      )
    ).rows[0];
    return row
      ? {
          decisionId: row.decision_id,
          decision: row.decision as Decision,
          reservationId: row.reservation_id ?? null,
        }
      : null;
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

export interface ApprovalEvidence {
  /** For github_review: review id and head; for operator_console: the console actor. */
  [key: string]: string | number;
}
/** Human approvals observed by trusted code; the policy binds them to an action digest. */
export class ApprovalStore {
  constructor(private readonly pool: Pool) {}
  async record(
    repositoryId: number,
    approval: ApprovalRecord,
    evidence: ApprovalEvidence,
    recordedBy: string,
  ): Promise<void> {
    requireText(recordedBy, 128, 'actor_invalid');
    requireAutonomy(
      approval.version === 1 &&
        approval.kind === 'approval' &&
        /^[0-9a-f]{64}$/.test(approval.actionSha256),
      'approval_record_invalid',
    );
    await this.pool.query(
      `INSERT INTO factory_autonomy_approvals(approval_id,repository_id,action_sha256,action,approver_user_id,source,evidence,approved_at,recorded_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT (action_sha256, approver_user_id) DO NOTHING`,
      [
        randomUUID(),
        repositoryId,
        approval.actionSha256,
        approval.action,
        approval.approver.githubUserId,
        approval.source,
        JSON.stringify(evidence),
        timestamp(approval.approvedAt),
        recordedBy,
      ],
    );
  }
  /** Most recent first; the decision engine accepts the first that is current and authorized. */
  async forAction(repositoryId: number, actionSha256: string): Promise<ApprovalRecord[]> {
    const result = await this.pool.query(
      'SELECT action_sha256,action,approver_user_id,source,approved_at FROM factory_autonomy_approvals WHERE repository_id=$1 AND action_sha256=$2 ORDER BY approved_at DESC',
      [repositoryId, actionSha256],
    );
    return result.rows.map((row) => ({
      version: 1,
      kind: 'approval',
      actionSha256: row.action_sha256,
      action: row.action,
      approver: { githubUserId: Number(row.approver_user_id), type: 'User' },
      source: row.source,
      approvedAt: new Date(row.approved_at).getTime(),
    }));
  }
}
