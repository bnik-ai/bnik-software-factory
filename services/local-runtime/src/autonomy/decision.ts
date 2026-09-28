import {
  type ChangeManifest,
  type Reason,
  classifyChanges,
  compareReasons,
  holdsPublication,
  parseChangeManifest,
} from './classify.js';
import {
  type DecisionReason,
  type Evidence,
  acceptanceReasons,
  checkApproval,
  dependencyReasons,
  mergeGateReasons,
  reviewReasons,
} from './evidence.js';
import { type AutonomyPolicy, policyDigest } from './policy.js';
import {
  AutonomyError,
  requireAutonomy,
  requireGitObject,
  requireInteger,
  requireRecord,
  requireSha256,
  requireText,
  sha256Json,
} from './schema.js';

export type AutonomyAction = 'execute' | 'publish' | 'merge';
/**
 * One proposed consequential action, assembled by the trusted controller.
 * Task text, labels and model output never set any field that lowers risk:
 * `intentKind` only adds the bug-reproducer requirement.
 */
export interface ActionRequest {
  version: 1;
  /** Controller-derived and stable for one intended action, so duplicate events deduplicate. */
  requestId: string;
  action: AutonomyAction;
  scopeId: string;
  policySha256: string;
  repository: { id: number; installationId: number; baseBranch: string };
  task: { id: string; intentSha256: string; intentKind: 'change' | 'bugfix' };
  base: string;
  /** Merge only: the published PR head. */
  head: string | null;
  /** Publish and merge: the frozen candidate tree that was tested and reviewed. */
  tree: string | null;
  changes: ChangeManifest | null;
  /** Execute only. */
  execution: { model: string; maxTurns: number; maxRunMs: number; budgetMicrousd: number } | null;
  /** Execute only: the Task attempt, so every attempt is a distinct approvable action. */
  attempt?: number;
}
export interface Decision {
  version: 1;
  action: AutonomyAction | null;
  outcome: 'allow' | 'approval_required' | 'repair_required' | 'blocked';
  /** `not_assessed` for execute: risk belongs to the resulting change, assessed before publish/merge. */
  risk: 'routine' | 'critical' | 'unknown' | 'not_assessed';
  reasons: DecisionReason[];
  requestSha256: string | null;
  actionSha256: string | null;
  policySha256: string;
  evidenceSha256: string;
  approvedBy: number | null;
  /** Digest of the approval used, so the ledger can admit each approval at most once. */
  approvalSha256: string | null;
  decidedAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Either the rules or the reviewer can escalate. A reviewer finding of secrets,
 * security or governance risk also holds publication, since pushing discloses
 * secrets and runs code in CI; other reviewer escalations hold the merge.
 */
const REVIEW_PUBLICATION_HOLD_CATEGORIES: readonly string[] = [
  'secrets_permissions',
  'security_auth',
  'governance',
];

export function parseRequest(policy: AutonomyPolicy, value: unknown): ActionRequest {
  const keys = [
    'version',
    'requestId',
    'action',
    'scopeId',
    'policySha256',
    'repository',
    'task',
    'base',
    'head',
    'tree',
    'changes',
    'execution',
  ];
  if (value !== null && typeof value === 'object' && 'attempt' in value) keys.push('attempt');
  requireRecord(value, keys, 'request_invalid');
  const request = value as unknown as ActionRequest;
  requireAutonomy(request.version === 1, 'request_invalid');
  requireAutonomy(
    typeof request.requestId === 'string' && UUID.test(request.requestId),
    'request_id_invalid',
  );
  requireAutonomy(
    ['execute', 'publish', 'merge'].includes(request.action),
    'request_action_invalid',
  );
  if (request.attempt !== undefined) {
    requireAutonomy(request.action === 'execute', 'request_attempt_only_for_execute');
    requireInteger(request.attempt, 1, 100_000, 'request_attempt_invalid');
  }
  requireText(request.scopeId, 128, 'request_scope_invalid');
  requireSha256(request.policySha256, 'request_invalid');
  requireAutonomy(request.policySha256 === policyDigest(policy), 'policy_changed_since_request');
  requireRecord(request.repository, ['id', 'installationId', 'baseBranch'], 'request_invalid');
  requireAutonomy(
    request.repository.id === policy.repository.id &&
      request.repository.installationId === policy.repository.installationId &&
      request.repository.baseBranch === policy.repository.baseBranch,
    'repository_outside_policy',
  );
  requireRecord(request.task, ['id', 'intentSha256', 'intentKind'], 'request_task_invalid');
  requireText(request.task.id, 128, 'request_task_invalid');
  requireSha256(request.task.intentSha256, 'request_task_invalid');
  requireAutonomy(
    request.task.intentKind === 'change' || request.task.intentKind === 'bugfix',
    'request_task_invalid',
  );
  requireGitObject(request.base, 'request_base_invalid');

  let changes: ChangeManifest | null = null;
  if (request.action === 'execute') {
    requireAutonomy(
      request.head === null && request.tree === null && request.changes === null,
      'execute_request_carries_candidate',
    );
    requireRecord(
      request.execution,
      ['model', 'maxTurns', 'maxRunMs', 'budgetMicrousd'],
      'execution_limits_invalid',
    );
    const { execution } = request;
    requireAutonomy(policy.execution.models.includes(execution.model), 'model_not_allowed');
    requireInteger(
      execution.maxTurns,
      1,
      policy.execution.maxTurns,
      'execution_limits_exceed_policy',
    );
    requireInteger(
      execution.maxRunMs,
      1000,
      policy.execution.maxRunMs,
      'execution_limits_exceed_policy',
    );
    requireInteger(
      execution.budgetMicrousd,
      1,
      policy.execution.maxRunMicrousd,
      'execution_limits_exceed_policy',
    );
  } else {
    requireAutonomy(request.execution === null, 'candidate_request_carries_execution');
    requireGitObject(request.tree, 'request_tree_invalid');
    if (request.action === 'merge') requireGitObject(request.head, 'request_head_invalid');
    else requireAutonomy(request.head === null, 'publish_request_carries_head');
    changes = parseChangeManifest(request.changes);
  }
  return { ...structuredClone({ ...request, changes: null }), changes };
}
/** Identity of the substantive action. Approvals bind this, not the request id. */
export function actionDigest(request: ActionRequest): string {
  const { requestId: _requestId, ...substance } = request;
  return sha256Json(substance);
}
function toDecisionReason(reason: Reason, effect: DecisionReason['effect']): DecisionReason {
  return reason.path === undefined
    ? { code: reason.code, category: reason.category, effect }
    : { code: reason.code, category: reason.category, effect, path: reason.path };
}
function sortReasons(reasons: DecisionReason[]): DecisionReason[] {
  const unique = new Map(reasons.map((reason) => [sha256Json(reason), reason]));
  return [...unique.values()].sort(
    (left, right) =>
      compareReasons(left as Reason, right as Reason) ||
      (left.effect < right.effect ? -1 : left.effect > right.effect ? 1 : 0),
  );
}

/**
 * Pure policy decision. Precedence: blocked > repair_required > approval_required > allow.
 * Approval never converts a failed, missing, stale or inconclusive result into a pass.
 * Pause, scope, budget and single-use admission are enforced by the ledger.
 */
export function decide(
  policy: AutonomyPolicy,
  requestValue: unknown,
  evidenceValue: unknown,
  now: number,
): Decision {
  const policySha256 = policyDigest(policy);
  const base = {
    version: 1 as const,
    policySha256,
    evidenceSha256: sha256Json(evidenceValue ?? null),
    decidedAt: now,
  };
  let request: ActionRequest | null = null;
  try {
    requireInteger(now, 1, 8_640_000_000_000_000, 'decision_clock_invalid');
    request = parseRequest(policy, requestValue);
    const evidence = (evidenceValue ?? {}) as Evidence;
    requireAutonomy(
      evidence !== null &&
        typeof evidence === 'object' &&
        !Array.isArray(evidence) &&
        Object.keys(evidence).every((key) =>
          ['acceptance', 'review', 'mergeGate', 'approval', 'dependency'].includes(key),
        ),
      'evidence_fields_invalid',
    );
    const actionSha256 = actionDigest(request);
    const reasons: DecisionReason[] = [];
    let risk: Decision['risk'] = 'not_assessed';

    if (request.action !== 'execute') {
      const changes = request.changes as ChangeManifest;
      const subject = {
        repositoryId: request.repository.id,
        taskId: request.task.id,
        base: request.base,
        tree: request.tree as string,
        changesSha256: sha256Json(changes),
      };
      const classification = classifyChanges(policy, changes);
      // A passing dependency receipt is the only thing that lowers a classification
      // reason, and only `dependency_manifest` for the manifests it lists; executable
      // manifests, configuration, patches and vendored code stay critical.
      let classificationReasons = classification.reasons;
      // Only a manifest that still exists after the change can be re-resolved; a deleted
      // or renamed-away lockfile stays critical, since "reproduced" is vacuous without it.
      const survivingPaths = new Set(
        changes.files.map((file) => file.newPath).filter((path): path is string => path !== null),
      );
      const manifestPaths = classification.reasons
        .filter(
          (reason) =>
            reason.code === 'dependency_manifest' &&
            reason.path !== undefined &&
            survivingPaths.has(reason.path),
        )
        .map((reason) => reason.path as string);
      // Any supplied receipt is validated; one that covers no manifest of this change is refused.
      if (manifestPaths.length > 0 || evidence.dependency !== undefined) {
        const dependency = dependencyReasons(
          policy,
          subject,
          manifestPaths,
          evidence.dependency,
          now,
        );
        reasons.push(...dependency.reasons);
        if (dependency.verifiedManifests.length > 0)
          classificationReasons = classification.reasons.filter(
            (reason) =>
              !(
                reason.code === 'dependency_manifest' &&
                reason.path !== undefined &&
                dependency.verifiedManifests.includes(reason.path)
              ),
          );
      }
      for (const reason of classificationReasons) {
        const deferredToMerge = request.action === 'publish' && !holdsPublication(reason);
        if (!deferredToMerge) reasons.push(toDecisionReason(reason, 'approval'));
      }
      // Truncation keeps holds first, so this only fires if that invariant ever breaks.
      if (
        request.action === 'publish' &&
        classification.publicationHold &&
        !classification.reasons.some(holdsPublication)
      )
        reasons.push({ code: 'publication_hold', category: 'uninspectable', effect: 'approval' });
      reasons.push(
        ...acceptanceReasons(policy, subject, request.task.intentKind, evidence.acceptance, now),
      );
      const review = reviewReasons(
        policy,
        subject,
        request.task.intentSha256,
        evidence.review,
        now,
      );
      reasons.push(
        ...review.filter(
          (reason) =>
            request?.action === 'merge' ||
            reason.effect !== 'approval' ||
            REVIEW_PUBLICATION_HOLD_CATEGORIES.includes(reason.category),
        ),
      );
      const semanticCritical = review.some((reason) => reason.effect === 'approval');
      risk = classificationReasons.length > 0 || semanticCritical ? 'critical' : 'routine';
      if (request.action === 'merge') {
        reasons.push(
          ...mergeGateReasons(
            {
              repositoryId: request.repository.id,
              baseBranch: request.repository.baseBranch,
              head: request.head as string,
              tree: request.tree as string,
              base: request.base,
            },
            evidence.mergeGate,
            now,
          ),
        );
        if (policy.mergeEffect === 'deployment')
          reasons.push({
            code: 'merge_triggers_deployment',
            category: 'production_deployment',
            effect: 'approval',
          });
      }
    }
    if (policy.mode === 'human_gated')
      reasons.push({ code: 'human_gated_mode', category: 'control', effect: 'approval' });

    let approvedBy: number | null = null;
    let approvalSha256: string | null = null;
    if (reasons.some((reason) => reason.effect === 'approval')) {
      const approval = checkApproval(policy, request.action, actionSha256, evidence.approval, now);
      if (approval.status === 'valid') {
        approvedBy = approval.approval.approver.githubUserId;
        approvalSha256 = sha256Json(approval.approval);
      } else if (approval.status !== 'absent')
        reasons.push({
          code: `approval_${approval.status}`,
          category: 'control',
          effect: 'approval',
        });
    }
    const effects = new Set(reasons.map((reason) => reason.effect));
    const outcome: Decision['outcome'] = effects.has('block')
      ? 'blocked'
      : effects.has('repair')
        ? 'repair_required'
        : effects.has('approval') && approvedBy === null
          ? 'approval_required'
          : 'allow';
    return {
      ...base,
      action: request.action,
      outcome,
      risk,
      reasons: sortReasons(reasons),
      requestSha256: sha256Json(request),
      actionSha256,
      approvedBy: outcome === 'allow' ? approvedBy : null,
      approvalSha256: outcome === 'allow' ? approvalSha256 : null,
    };
  } catch (error) {
    const code = error instanceof AutonomyError ? error.reason : 'decision_input_unreadable';
    return {
      ...base,
      action: request?.action ?? null,
      outcome: 'blocked',
      risk: 'unknown',
      reasons: [{ code, category: 'evidence', effect: 'block' }],
      requestSha256: request ? sha256Json(request) : null,
      actionSha256: request ? actionDigest(request) : null,
      approvedBy: null,
      approvalSha256: null,
    };
  }
}
