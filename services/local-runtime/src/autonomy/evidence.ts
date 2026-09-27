import type { ReasonCategory } from './classify.js';
import { type AutonomyPolicy, CRITICAL_CATEGORIES, type CriticalCategory } from './policy.js';
import {
  requireAutonomy,
  requireGitObject,
  requireInteger,
  requireRecord,
  requireSha256,
  requireText,
  requireTimestamp,
  requireUniqueList,
} from './schema.js';

/**
 * Every receipt is written by trusted factory code from observed facts: exit
 * statuses the trusted runner collected, a reviewer's structured output parsed
 * by the supervisor, GitHub API reads by the merge gate. Worker output, test
 * logs, PR text and labels are data inside receipts, never receipt authors.
 */
export interface CandidateSubject {
  repositoryId: number;
  taskId: string;
  base: string;
  tree: string;
  changesSha256: string;
}
export interface AcceptanceReceipt {
  version: 1;
  kind: 'acceptance';
  runId: string;
  subject: CandidateSubject;
  suiteSha256: string;
  harnessSha256: string;
  runnerImage: string;
  status: 'passed' | 'failed' | 'error' | 'timeout';
  protectedSuite: { total: number; passed: number; failed: number; skipped: number };
  /** Bug fixes only: the reproducer run against the base tree and the candidate tree. */
  reproducer: {
    baseline: 'failed' | 'passed' | 'error' | 'not_run';
    candidate: 'passed' | 'failed' | 'error' | 'not_run';
  };
  sourceModifiedByTests: boolean;
  completedAt: number;
}
export const FINDING_SEVERITIES = ['high', 'medium', 'low'] as const;
export interface ReviewFinding {
  id: string;
  severity: (typeof FINDING_SEVERITIES)[number];
  summary: string;
  location: string;
}
export interface ReviewReceipt {
  version: 1;
  kind: 'review';
  runId: string;
  subject: CandidateSubject;
  intentSha256: string;
  reviewerConfigSha256: string;
  /** Always `fresh`: no author conversation or self-assessment in the reviewer's input. */
  context: 'fresh';
  status: 'complete' | 'incomplete' | 'error' | 'timeout';
  risk: 'routine' | 'critical';
  categories: CriticalCategory[];
  findings: ReviewFinding[];
  limitations: string[];
  completedAt: number;
}
export interface MergeGateObservation {
  version: 1;
  kind: 'merge_gate';
  repositoryId: number;
  pullNumber: number;
  head: string;
  /** Tree of the published head; must equal the tested candidate tree. */
  headTree: string;
  base: string;
  baseBranch: string;
  pullState: 'open' | 'closed' | 'merged';
  requiredChecks: 'passed' | 'failed' | 'pending' | 'missing';
  changesRequested: boolean;
  protectionVerified: boolean;
  observedAt: number;
}
export interface ApprovalRecord {
  version: 1;
  kind: 'approval';
  /** actionDigest() of the exact action: policy, task, base, head, tree, changes, limits. */
  actionSha256: string;
  action: 'execute' | 'publish' | 'merge';
  approver: { githubUserId: number; type: 'User' };
  source: 'github_review' | 'operator_console';
  approvedAt: number;
}
export const DEPENDENCY_FINDING_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
  'unknown',
] as const;
export interface PackageChange {
  ecosystem: string;
  name: string;
  version: string;
  previousVersion: string | null;
  /** SPDX identifier as the runner determined it; `null` when it could not. */
  license: string | null;
  major: boolean;
}
export interface DependencyFinding {
  id: string;
  severity: (typeof DEPENDENCY_FINDING_SEVERITIES)[number];
  ecosystem: string;
  name: string;
  version: string;
  fixedVersion: string | null;
}
/**
 * Written by the trusted runner after re-resolving the candidate's manifests in a
 * clean sandbox with install scripts disabled and running the pinned scanner
 * adapter over the result. It can make a manifest or lockfile change routine; it
 * never affects registry or hook configuration, which stays critical.
 */
export interface DependencyReceipt {
  version: 1;
  kind: 'dependency';
  runId: string;
  subject: CandidateSubject;
  scanner: { adapter: string; image: string; databaseUpdatedAt: number };
  /** `unsupported`: the runner cannot re-resolve this ecosystem; the change stays critical. */
  status: 'complete' | 'error' | 'timeout' | 'unsupported';
  /** Whether the committed lockfile is byte-identical to a clean re-resolution of the manifests. */
  resolution: 'reproduced' | 'mismatch' | 'not_attempted';
  /** The project's own manifest scripts changed (what an install or CI run executes). */
  rootScriptsChanged: boolean;
  /** An added or upgraded package declares install-time scripts. */
  packageInstallScripts: boolean;
  packages: { added: PackageChange[]; removed: PackageChange[]; upgraded: PackageChange[] };
  findings: DependencyFinding[];
  completedAt: number;
}
export interface Evidence {
  acceptance?: unknown;
  review?: unknown;
  mergeGate?: unknown;
  approval?: unknown;
  dependency?: unknown;
}
export type ReasonEffect = 'block' | 'repair' | 'approval';
export interface DecisionReason {
  code: string;
  category: ReasonCategory | 'evidence' | 'control';
  effect: ReasonEffect;
  path?: string;
}

export const CLOCK_SKEW_MS = 60_000;
export const MERGE_OBSERVATION_MAX_AGE_MS = 300_000;

function requireSubject(value: unknown, reason: string): asserts value is CandidateSubject {
  requireRecord(value, ['repositoryId', 'taskId', 'base', 'tree', 'changesSha256'], reason);
  requireInteger(value.repositoryId, 1, Number.MAX_SAFE_INTEGER, reason);
  requireText(value.taskId, 128, reason);
  requireGitObject(value.base, reason);
  requireGitObject(value.tree, reason);
  requireSha256(value.changesSha256, reason);
}
function sameSubject(left: CandidateSubject, right: CandidateSubject): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.taskId === right.taskId &&
    left.base === right.base &&
    left.tree === right.tree &&
    left.changesSha256 === right.changesSha256
  );
}
function requireRunId(value: unknown, reason: string) {
  requireAutonomy(
    typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
    reason,
  );
}
function fresh(completedAt: number, now: number, maxAgeMs: number): boolean {
  return completedAt <= now + CLOCK_SKEW_MS && now - completedAt <= maxAgeMs;
}

export function acceptanceReasons(
  policy: AutonomyPolicy,
  subject: CandidateSubject,
  intentKind: 'change' | 'bugfix',
  value: unknown,
  now: number,
): DecisionReason[] {
  const block = (code: string): DecisionReason[] => [
    { code, category: 'evidence', effect: 'block' },
  ];
  if (value === undefined) return block('acceptance_receipt_missing');
  requireRecord(
    value,
    [
      'version',
      'kind',
      'runId',
      'subject',
      'suiteSha256',
      'harnessSha256',
      'runnerImage',
      'status',
      'protectedSuite',
      'reproducer',
      'sourceModifiedByTests',
      'completedAt',
    ],
    'acceptance_receipt_invalid',
  );
  const receipt = value as unknown as AcceptanceReceipt;
  requireAutonomy(
    receipt.version === 1 && receipt.kind === 'acceptance',
    'acceptance_receipt_invalid',
  );
  requireRunId(receipt.runId, 'acceptance_receipt_invalid');
  requireSubject(receipt.subject, 'acceptance_receipt_invalid');
  requireSha256(receipt.suiteSha256, 'acceptance_receipt_invalid');
  requireSha256(receipt.harnessSha256, 'acceptance_receipt_invalid');
  requireAutonomy(
    ['passed', 'failed', 'error', 'timeout'].includes(receipt.status),
    'acceptance_receipt_invalid',
  );
  requireRecord(
    receipt.protectedSuite,
    ['total', 'passed', 'failed', 'skipped'],
    'acceptance_receipt_invalid',
  );
  for (const count of Object.values(receipt.protectedSuite))
    requireInteger(count, 0, 1_000_000, 'acceptance_receipt_invalid');
  requireRecord(receipt.reproducer, ['baseline', 'candidate'], 'acceptance_receipt_invalid');
  requireAutonomy(
    ['failed', 'passed', 'error', 'not_run'].includes(receipt.reproducer.baseline) &&
      ['passed', 'failed', 'error', 'not_run'].includes(receipt.reproducer.candidate),
    'acceptance_receipt_invalid',
  );
  requireAutonomy(typeof receipt.sourceModifiedByTests === 'boolean', 'acceptance_receipt_invalid');
  requireTimestamp(receipt.completedAt, 'acceptance_receipt_invalid');

  if (!sameSubject(receipt.subject, subject)) return block('acceptance_subject_mismatch');
  if (
    receipt.suiteSha256 !== policy.verification.acceptanceSuiteSha256 ||
    receipt.harnessSha256 !== policy.verification.acceptanceHarnessSha256 ||
    receipt.runnerImage !== policy.verification.acceptanceRunnerImage
  )
    return block('acceptance_trust_root_mismatch');
  if (!fresh(receipt.completedAt, now, policy.verification.receiptTtlMs))
    return block('acceptance_receipt_stale');
  if (receipt.status === 'error' || receipt.status === 'timeout')
    return block('acceptance_inconclusive');

  const suite = receipt.protectedSuite;
  const consistent =
    suite.passed + suite.failed + suite.skipped === suite.total &&
    (receipt.status === 'passed'
      ? suite.total > 0 && suite.failed === 0 && suite.skipped === 0
      : suite.failed > 0);
  if (!consistent) return block('acceptance_receipt_inconsistent');

  const reasons: DecisionReason[] = [];
  const repair = (code: string) => reasons.push({ code, category: 'evidence', effect: 'repair' });
  if (receipt.status === 'failed') repair('protected_acceptance_failed');
  if (receipt.sourceModifiedByTests) repair('tests_modified_candidate_source');
  if (intentKind === 'bugfix') {
    const { baseline, candidate } = receipt.reproducer;
    if (baseline === 'error' || candidate === 'error')
      reasons.push({ code: 'bug_reproducer_inconclusive', category: 'evidence', effect: 'block' });
    else if (baseline === 'not_run' || candidate === 'not_run') repair('bug_reproducer_missing');
    else {
      if (baseline !== 'failed') repair('bug_reproducer_passes_on_base');
      if (candidate !== 'passed') repair('bug_reproducer_fails_on_candidate');
    }
  }
  return reasons;
}

export function reviewReasons(
  policy: AutonomyPolicy,
  subject: CandidateSubject,
  intentSha256: string,
  value: unknown,
  now: number,
): DecisionReason[] {
  const block = (code: string): DecisionReason[] => [
    { code, category: 'evidence', effect: 'block' },
  ];
  if (value === undefined) return block('review_receipt_missing');
  requireRecord(
    value,
    [
      'version',
      'kind',
      'runId',
      'subject',
      'intentSha256',
      'reviewerConfigSha256',
      'context',
      'status',
      'risk',
      'categories',
      'findings',
      'limitations',
      'completedAt',
    ],
    'review_receipt_invalid',
  );
  const receipt = value as unknown as ReviewReceipt;
  requireAutonomy(receipt.version === 1 && receipt.kind === 'review', 'review_receipt_invalid');
  requireRunId(receipt.runId, 'review_receipt_invalid');
  requireSubject(receipt.subject, 'review_receipt_invalid');
  requireSha256(receipt.intentSha256, 'review_receipt_invalid');
  requireSha256(receipt.reviewerConfigSha256, 'review_receipt_invalid');
  requireAutonomy(receipt.context === 'fresh', 'review_context_not_fresh');
  requireAutonomy(
    ['complete', 'incomplete', 'error', 'timeout'].includes(receipt.status),
    'review_receipt_invalid',
  );
  requireAutonomy(
    receipt.risk === 'routine' || receipt.risk === 'critical',
    'review_receipt_invalid',
  );
  requireUniqueList<string>(
    receipt.categories,
    0,
    CRITICAL_CATEGORIES.length,
    'review_receipt_invalid',
  );
  for (const category of receipt.categories)
    requireAutonomy(
      (CRITICAL_CATEGORIES as readonly string[]).includes(category),
      'review_receipt_invalid',
    );
  // A reviewer that names a critical category cannot also call the change routine, and vice versa.
  requireAutonomy(
    (receipt.risk === 'routine') === (receipt.categories.length === 0),
    'review_risk_categories_inconsistent',
  );
  requireUniqueList<unknown>(receipt.findings, 0, 200, 'review_receipt_invalid');
  const findingIds = new Set<string>();
  for (const finding of receipt.findings) {
    requireRecord(finding, ['id', 'severity', 'summary', 'location'], 'review_finding_invalid');
    requireAutonomy(
      typeof finding.id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(finding.id),
      'review_finding_invalid',
    );
    requireAutonomy(!findingIds.has(finding.id), 'review_finding_invalid');
    findingIds.add(finding.id);
    requireAutonomy(
      (FINDING_SEVERITIES as readonly unknown[]).includes(finding.severity),
      'review_finding_invalid',
    );
    requireText(finding.summary, 2000, 'review_finding_invalid');
    requireText(finding.location, 1024, 'review_finding_invalid');
  }
  requireUniqueList<string>(receipt.limitations, 0, 50, 'review_receipt_invalid');
  for (const limitation of receipt.limitations)
    requireText(limitation, 500, 'review_receipt_invalid');
  requireTimestamp(receipt.completedAt, 'review_receipt_invalid');

  if (!sameSubject(receipt.subject, subject)) return block('review_subject_mismatch');
  if (receipt.intentSha256 !== intentSha256) return block('review_intent_mismatch');
  if (receipt.reviewerConfigSha256 !== policy.verification.reviewerConfigSha256)
    return block('review_trust_root_mismatch');
  if (!fresh(receipt.completedAt, now, policy.verification.receiptTtlMs))
    return block('review_receipt_stale');
  if (receipt.status !== 'complete') return block('review_inconclusive');
  // Anything the reviewer could not examine is unknown, not approved.
  if (receipt.limitations.length > 0) return block('review_reported_limitations');

  const reasons: DecisionReason[] = [];
  for (const category of receipt.categories)
    reasons.push({ code: 'semantic_review_critical', category, effect: 'approval' });
  // High and medium findings need a bounded repair; low findings are nits and never interrupt.
  for (const finding of receipt.findings)
    if (finding.severity !== 'low')
      reasons.push({
        code: `review_finding_${finding.severity}:${finding.id}`,
        category: 'evidence',
        effect: 'repair',
      });
  return reasons;
}

export interface MergeTarget {
  repositoryId: number;
  baseBranch: string;
  head: string;
  tree: string;
  base: string;
}
export function mergeGateReasons(
  target: MergeTarget,
  value: unknown,
  now: number,
): DecisionReason[] {
  const block = (code: string): DecisionReason[] => [
    { code, category: 'evidence', effect: 'block' },
  ];
  if (value === undefined) return block('merge_gate_observation_missing');
  requireRecord(
    value,
    [
      'version',
      'kind',
      'repositoryId',
      'pullNumber',
      'head',
      'headTree',
      'base',
      'baseBranch',
      'pullState',
      'requiredChecks',
      'changesRequested',
      'protectionVerified',
      'observedAt',
    ],
    'merge_gate_observation_invalid',
  );
  const observation = value as unknown as MergeGateObservation;
  requireAutonomy(
    observation.version === 1 && observation.kind === 'merge_gate',
    'merge_gate_observation_invalid',
  );
  requireInteger(
    observation.repositoryId,
    1,
    Number.MAX_SAFE_INTEGER,
    'merge_gate_observation_invalid',
  );
  requireInteger(
    observation.pullNumber,
    1,
    Number.MAX_SAFE_INTEGER,
    'merge_gate_observation_invalid',
  );
  requireGitObject(observation.head, 'merge_gate_observation_invalid');
  requireGitObject(observation.headTree, 'merge_gate_observation_invalid');
  requireGitObject(observation.base, 'merge_gate_observation_invalid');
  requireText(observation.baseBranch, 100, 'merge_gate_observation_invalid');
  requireAutonomy(
    ['open', 'closed', 'merged'].includes(observation.pullState),
    'merge_gate_observation_invalid',
  );
  requireAutonomy(
    ['passed', 'failed', 'pending', 'missing'].includes(observation.requiredChecks),
    'merge_gate_observation_invalid',
  );
  requireAutonomy(
    typeof observation.changesRequested === 'boolean' &&
      typeof observation.protectionVerified === 'boolean',
    'merge_gate_observation_invalid',
  );
  requireTimestamp(observation.observedAt, 'merge_gate_observation_invalid');

  if (
    observation.repositoryId !== target.repositoryId ||
    observation.baseBranch !== target.baseBranch
  )
    return block('merge_gate_target_mismatch');
  if (observation.head !== target.head) return block('pull_head_changed');
  if (observation.headTree !== target.tree) return block('published_tree_differs_from_tested_tree');
  if (observation.base !== target.base) return block('pull_base_changed');
  if (!fresh(observation.observedAt, now, MERGE_OBSERVATION_MAX_AGE_MS))
    return block('merge_gate_observation_stale');
  if (observation.pullState !== 'open') return block('pull_not_open');
  if (!observation.protectionVerified) return block('branch_protection_not_verified');

  const reasons: DecisionReason[] = [];
  // A human request for changes is an override on any PR, routine or not.
  if (observation.changesRequested)
    reasons.push({ code: 'human_requested_changes', category: 'control', effect: 'block' });
  if (observation.requiredChecks === 'failed')
    reasons.push({ code: 'required_checks_failed', category: 'evidence', effect: 'repair' });
  if (observation.requiredChecks === 'pending' || observation.requiredChecks === 'missing')
    reasons.push({
      code: `required_checks_${observation.requiredChecks}`,
      category: 'evidence',
      effect: 'block',
    });
  return reasons;
}

const SEVERITY_RANK: Record<(typeof DEPENDENCY_FINDING_SEVERITIES)[number], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};
const ECOSYSTEM = /^[a-z][a-z0-9.-]{0,31}$/;
function requirePackageChange(value: unknown, reason: string): asserts value is PackageChange {
  requireRecord(
    value,
    ['ecosystem', 'name', 'version', 'previousVersion', 'license', 'major'],
    reason,
  );
  requireAutonomy(typeof value.ecosystem === 'string' && ECOSYSTEM.test(value.ecosystem), reason);
  requireText(value.name, 256, reason);
  requireText(value.version, 128, reason);
  if (value.previousVersion !== null) requireText(value.previousVersion, 128, reason);
  if (value.license !== null) requireText(value.license, 128, reason);
  requireAutonomy(typeof value.major === 'boolean', reason);
}
export interface DependencyAssessment {
  reasons: DecisionReason[];
  /** True only when every deterministic check and the scanner passed; nothing else lowers risk. */
  verified: boolean;
}
export function dependencyReasons(
  policy: AutonomyPolicy,
  subject: CandidateSubject,
  value: unknown,
  now: number,
): DependencyAssessment {
  // Without verification configured or a receipt present, manifest changes stay critical.
  if (policy.dependencies === null || value === undefined) return { reasons: [], verified: false };
  const settings = policy.dependencies;
  const block = (code: string): DependencyAssessment => ({
    reasons: [{ code, category: 'evidence', effect: 'block' }],
    verified: false,
  });
  requireRecord(
    value,
    [
      'version',
      'kind',
      'runId',
      'subject',
      'scanner',
      'status',
      'resolution',
      'rootScriptsChanged',
      'packageInstallScripts',
      'packages',
      'findings',
      'completedAt',
    ],
    'dependency_receipt_invalid',
  );
  const receipt = value as unknown as DependencyReceipt;
  requireAutonomy(
    receipt.version === 1 && receipt.kind === 'dependency',
    'dependency_receipt_invalid',
  );
  requireRunId(receipt.runId, 'dependency_receipt_invalid');
  requireSubject(receipt.subject, 'dependency_receipt_invalid');
  requireRecord(
    receipt.scanner,
    ['adapter', 'image', 'databaseUpdatedAt'],
    'dependency_receipt_invalid',
  );
  requireText(receipt.scanner.adapter, 32, 'dependency_receipt_invalid');
  requireText(receipt.scanner.image, 71, 'dependency_receipt_invalid');
  requireTimestamp(receipt.scanner.databaseUpdatedAt, 'dependency_receipt_invalid');
  requireAutonomy(
    ['complete', 'error', 'timeout', 'unsupported'].includes(receipt.status),
    'dependency_receipt_invalid',
  );
  requireAutonomy(
    ['reproduced', 'mismatch', 'not_attempted'].includes(receipt.resolution),
    'dependency_receipt_invalid',
  );
  requireAutonomy(
    typeof receipt.rootScriptsChanged === 'boolean' &&
      typeof receipt.packageInstallScripts === 'boolean',
    'dependency_receipt_invalid',
  );
  requireRecord(receipt.packages, ['added', 'removed', 'upgraded'], 'dependency_receipt_invalid');
  for (const list of [
    receipt.packages.added,
    receipt.packages.removed,
    receipt.packages.upgraded,
  ]) {
    requireUniqueList<unknown>(list, 0, 5000, 'dependency_receipt_invalid');
    for (const entry of list) requirePackageChange(entry, 'dependency_receipt_invalid');
  }
  requireUniqueList<unknown>(receipt.findings, 0, 5000, 'dependency_receipt_invalid');
  for (const finding of receipt.findings) {
    requireRecord(
      finding,
      ['id', 'severity', 'ecosystem', 'name', 'version', 'fixedVersion'],
      'dependency_finding_invalid',
    );
    requireAutonomy(
      typeof finding.id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(finding.id),
      'dependency_finding_invalid',
    );
    requireAutonomy(
      (DEPENDENCY_FINDING_SEVERITIES as readonly unknown[]).includes(finding.severity),
      'dependency_finding_invalid',
    );
    requireAutonomy(
      typeof finding.ecosystem === 'string' && ECOSYSTEM.test(finding.ecosystem),
      'dependency_finding_invalid',
    );
    requireText(finding.name, 256, 'dependency_finding_invalid');
    requireText(finding.version, 128, 'dependency_finding_invalid');
    if (finding.fixedVersion !== null)
      requireText(finding.fixedVersion, 128, 'dependency_finding_invalid');
  }
  requireTimestamp(receipt.completedAt, 'dependency_receipt_invalid');

  if (!sameSubject(receipt.subject, subject)) return block('dependency_subject_mismatch');
  if (
    receipt.scanner.adapter !== settings.scanner.adapter ||
    receipt.scanner.image !== settings.scanner.image
  )
    return block('dependency_trust_root_mismatch');
  if (!fresh(receipt.completedAt, now, policy.verification.receiptTtlMs))
    return block('dependency_receipt_stale');
  // Database age is measured at scan time; the receipt TTL bounds the rest.
  if (
    receipt.scanner.databaseUpdatedAt > receipt.completedAt + CLOCK_SKEW_MS ||
    receipt.completedAt - receipt.scanner.databaseUpdatedAt > settings.scanner.databaseMaxAgeMs
  )
    return block('dependency_database_stale');
  if (receipt.status === 'error' || receipt.status === 'timeout')
    return block('dependency_scan_inconclusive');
  if (receipt.status === 'unsupported')
    return {
      reasons: [
        { code: 'dependency_ecosystem_unsupported', category: 'security_auth', effect: 'approval' },
      ],
      verified: false,
    };
  if (receipt.resolution === 'not_attempted') return block('dependency_receipt_inconsistent');

  const reasons: DecisionReason[] = [];
  const hold = (code: string, category: DecisionReason['category']) =>
    reasons.push({ code, category, effect: 'approval' });
  if (receipt.resolution === 'mismatch') hold('lockfile_not_reproducible', 'security_auth');
  if (receipt.rootScriptsChanged) hold('manifest_scripts_changed', 'governance');
  if (receipt.packageInstallScripts) hold('install_scripts_in_dependencies', 'security_auth');
  const label = (entry: PackageChange) => `${entry.ecosystem}/${entry.name}`;
  if (!settings.allowNewDependencies)
    for (const entry of receipt.packages.added)
      hold(`new_dependency:${label(entry)}`, 'security_auth');
  if (!settings.allowMajorUpgrades)
    for (const entry of receipt.packages.upgraded)
      if (entry.major) hold(`major_upgrade:${label(entry)}`, 'security_auth');
  for (const entry of [...receipt.packages.added, ...receipt.packages.upgraded])
    if (entry.license === null || !settings.licenseAllowlist.includes(entry.license))
      hold(`license_not_allowed:${label(entry)}`, 'release_licensing');
  // Unknown severity is not "below threshold"; it holds like the threshold itself.
  const threshold = SEVERITY_RANK[settings.holdSeverity];
  for (const finding of receipt.findings)
    if (finding.severity === 'unknown' || SEVERITY_RANK[finding.severity] >= threshold)
      hold(`vulnerability:${finding.id}`, 'security_auth');
  return { reasons, verified: reasons.length === 0 };
}

export type ApprovalCheck =
  | { status: 'valid'; approval: ApprovalRecord }
  | { status: 'absent' }
  | { status: 'not_current' }
  | { status: 'not_authorized' };
export function checkApproval(
  policy: AutonomyPolicy,
  action: ApprovalRecord['action'],
  actionSha256: string,
  value: unknown,
  now: number,
): ApprovalCheck {
  if (value === undefined) return { status: 'absent' };
  requireRecord(
    value,
    ['version', 'kind', 'actionSha256', 'action', 'approver', 'source', 'approvedAt'],
    'approval_record_invalid',
  );
  const approval = value as unknown as ApprovalRecord;
  requireAutonomy(
    approval.version === 1 && approval.kind === 'approval',
    'approval_record_invalid',
  );
  requireSha256(approval.actionSha256, 'approval_record_invalid');
  requireAutonomy(
    ['execute', 'publish', 'merge'].includes(approval.action),
    'approval_record_invalid',
  );
  requireRecord(approval.approver, ['githubUserId', 'type'], 'approval_record_invalid');
  requireInteger(
    approval.approver.githubUserId,
    1,
    Number.MAX_SAFE_INTEGER,
    'approval_record_invalid',
  );
  requireAutonomy(
    approval.source === 'github_review' || approval.source === 'operator_console',
    'approval_record_invalid',
  );
  requireTimestamp(approval.approvedAt, 'approval_record_invalid');
  // Bots, Apps and the factory's own identities never approve.
  if (
    approval.approver.type !== 'User' ||
    !policy.approvers.githubUserIds.includes(approval.approver.githubUserId)
  )
    return { status: 'not_authorized' };
  if (
    approval.action !== action ||
    approval.actionSha256 !== actionSha256 ||
    approval.approvedAt > now + CLOCK_SKEW_MS
  )
    return { status: 'not_current' };
  return { status: 'valid', approval };
}
