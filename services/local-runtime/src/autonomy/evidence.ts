import type { ReasonCategory } from './classify.js';
import { type AutonomyPolicy, CRITICAL_CATEGORIES, type CriticalCategory } from './policy.js';
import {
  requireAutonomy,
  requireGitObject,
  requireInteger,
  requireRecord,
  requireRepositoryPath,
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
  /** Whether the reviewer had the whole candidate tree's text files, part of them, or none. */
  snapshot: 'complete' | 'incomplete' | 'none';
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
export type DependencySeverity = (typeof DEPENDENCY_FINDING_SEVERITIES)[number];
export const PACKAGE_SOURCES = ['registry', 'git', 'url', 'file', 'link', 'workspace'] as const;
export interface PackageChange {
  ecosystem: string;
  name: string;
  version: string;
  previousVersion: string | null;
  /** SPDX identifier as the runner determined it; `null` when it could not. */
  license: string | null;
  /** True for any breaking change the ecosystem recognizes, including 0.x minor bumps. */
  major: boolean;
  /** Upgraded entries only; `null` for additions and removals. */
  direction: 'upgrade' | 'downgrade' | null;
  /** Where the resolved artifact comes from; only `registry` can be routine. */
  source: (typeof PACKAGE_SOURCES)[number];
}
export interface DependencyFinding {
  id: string;
  severity: DependencySeverity;
  ecosystem: string;
  name: string;
  version: string;
  fixedVersion: string | null;
}
/**
 * Written by the trusted runner after re-resolving the candidate's manifests in a
 * clean sandbox with install scripts disabled and running the pinned scanner
 * adapter over the result. It can make the data manifests and lockfiles it lists
 * routine; it never affects executable manifests, registry or hook configuration,
 * patches or vendored code, which stay critical.
 */
export interface DependencyReceipt {
  version: 1;
  kind: 'dependency';
  runId: string;
  subject: CandidateSubject;
  scanner: { adapter: string; image: string; databaseUpdatedAt: number };
  /** Repository paths of the manifests and lockfiles this receipt re-resolved and inspected. */
  manifests: string[];
  /** `unsupported`: the runner cannot re-resolve this ecosystem; the change stays critical. */
  status: 'complete' | 'error' | 'timeout' | 'unsupported';
  /** Whether the committed lockfiles are byte-identical to a clean re-resolution of the manifests. */
  resolution: 'reproduced' | 'mismatch' | 'not_attempted';
  /** Manifest fields outside dependency version specifications that changed (`scripts.postinstall`, `overrides`, `workspaces`, …). */
  manifestFieldsChanged: string[];
  /** The set of packages whose install-time scripts run after installation is not the same as before. */
  installScriptsChanged: boolean;
  packages: { added: PackageChange[]; removed: PackageChange[]; upgraded: PackageChange[] };
  findings: DependencyFinding[];
  /** Findings strictly below this severity were left out to bound the list; `null` when complete. */
  findingsOmittedBelow: Exclude<DependencySeverity, 'unknown'> | null;
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
      'snapshot',
      'completedAt',
    ],
    'review_receipt_invalid',
  );
  const receipt = value as unknown as ReviewReceipt;
  requireAutonomy(receipt.version === 1 && receipt.kind === 'review', 'review_receipt_invalid');
  requireAutonomy(
    ['complete', 'incomplete', 'none'].includes(receipt.snapshot),
    'review_receipt_invalid',
  );
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
  // A complete verdict that names a critical category cannot also call the change routine, and vice versa.
  requireAutonomy(
    (receipt.risk === 'routine') === (receipt.categories.length === 0),
    'review_risk_categories_inconsistent',
  );
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

const SEVERITY_RANK: Record<DependencySeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};
const ECOSYSTEM = /^[a-z][a-z0-9.-]{0,31}$/;
const NUMERIC_PREFIX = /^v?(\d+(?:\.\d+)*)/;
/**
 * Dotted numeric prefix of a version, or null for identifiers such as `latest`,
 * `^2.0.0` or a commit SHA. Suffixes (`rc1`, `.post1`, `.RELEASE`, `w`) are ignored.
 */
function numericPrefix(version: string): number[] | null {
  const match = NUMERIC_PREFIX.exec(version);
  return match ? (match[1] as string).split('.').map(Number) : null;
}
function compareNumeric(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
/** Breaking by digits alone: a different leading component, or a different second component under 0.x. */
/**
 * SPDX expression against the allowlist: a single identifier (including `WITH`
 * exceptions) must be listed verbatim; an `OR` choice needs one listed operand; an
 * `AND` conjunction needs all. Parentheses or mixed operators are not accepted.
 */
export function licenseAllowed(license: string, allowlist: readonly string[]): boolean {
  if (allowlist.includes(license)) return true;
  if (/[()]/.test(license)) return false;
  const choices = license.split(/\s+OR\s+/);
  if (choices.length > 1)
    return (
      choices.every((choice) => !/\s+AND\s+/.test(choice)) &&
      choices.some((choice) => allowlist.includes(choice.trim()))
    );
  const conjuncts = license.split(/\s+AND\s+/);
  return conjuncts.length > 1 && conjuncts.every((conjunct) => allowlist.includes(conjunct.trim()));
}
function visiblyBreaking(before: number[], after: number[]): boolean {
  if (before[0] !== after[0]) return true;
  return before[0] === 0 && (before[1] ?? 0) !== (after[1] ?? 0);
}
function requirePackageChange(value: unknown, reason: string): asserts value is PackageChange {
  requireRecord(
    value,
    ['ecosystem', 'name', 'version', 'previousVersion', 'license', 'major', 'direction', 'source'],
    reason,
  );
  requireAutonomy(typeof value.ecosystem === 'string' && ECOSYSTEM.test(value.ecosystem), reason);
  requireText(value.name, 256, reason);
  requireText(value.version, 128, reason);
  if (value.previousVersion !== null) requireText(value.previousVersion, 128, reason);
  if (value.license !== null) requireText(value.license, 128, reason);
  requireAutonomy(typeof value.major === 'boolean', reason);
  requireAutonomy(
    value.direction === null || value.direction === 'upgrade' || value.direction === 'downgrade',
    reason,
  );
  requireAutonomy((PACKAGE_SOURCES as readonly unknown[]).includes(value.source), reason);
  // A resolved registry version always starts with a number; `latest` or `^2.0.0` is a spec, not a version.
  if (value.source === 'registry')
    for (const version of [value.version, value.previousVersion])
      if (version !== null) requireAutonomy(numericPrefix(version) !== null, reason);
}
export interface DependencyAssessment {
  reasons: DecisionReason[];
  /** Manifest paths the receipt made routine; empty unless every check passed. */
  verifiedManifests: string[];
}
/**
 * `manifestPaths` are the changed paths the classifier flagged as data manifests.
 * The receipt may cover some of them; uncovered ones simply stay critical.
 */
export function dependencyReasons(
  policy: AutonomyPolicy,
  subject: CandidateSubject,
  manifestPaths: readonly string[],
  value: unknown,
  now: number,
): DependencyAssessment {
  const unverified: DependencyAssessment = { reasons: [], verifiedManifests: [] };
  if (value === undefined) return unverified;
  const block = (code: string): DependencyAssessment => ({
    reasons: [{ code, category: 'evidence', effect: 'block' }],
    verifiedManifests: [],
  });
  requireRecord(
    value,
    [
      'version',
      'kind',
      'runId',
      'subject',
      'scanner',
      'manifests',
      'status',
      'resolution',
      'manifestFieldsChanged',
      'installScriptsChanged',
      'packages',
      'findings',
      'findingsOmittedBelow',
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
  requireUniqueList<string>(receipt.manifests, 1, 200, 'dependency_receipt_invalid');
  for (const path of receipt.manifests) requireRepositoryPath(path, 'dependency_receipt_invalid');
  requireAutonomy(
    ['complete', 'error', 'timeout', 'unsupported'].includes(receipt.status),
    'dependency_receipt_invalid',
  );
  requireAutonomy(
    ['reproduced', 'mismatch', 'not_attempted'].includes(receipt.resolution),
    'dependency_receipt_invalid',
  );
  requireUniqueList<string>(receipt.manifestFieldsChanged, 0, 200, 'dependency_receipt_invalid');
  for (const field of receipt.manifestFieldsChanged)
    requireText(field, 256, 'dependency_receipt_invalid');
  requireAutonomy(typeof receipt.installScriptsChanged === 'boolean', 'dependency_receipt_invalid');
  requireRecord(receipt.packages, ['added', 'removed', 'upgraded'], 'dependency_receipt_invalid');
  const seenPackages = new Map<string, string>();
  for (const [list, entries] of Object.entries(receipt.packages)) {
    requireUniqueList<unknown>(entries, 0, 5000, 'dependency_receipt_invalid');
    for (const entry of entries) {
      requirePackageChange(entry, 'dependency_receipt_invalid');
      const key = `${entry.ecosystem}/${entry.name}`.toLowerCase();
      // One package, one story: a removal plus an addition is an upgrade the runner must report as such.
      requireAutonomy(!seenPackages.has(key), 'dependency_receipt_inconsistent');
      seenPackages.set(key, list);
      requireAutonomy(
        (list === 'upgraded') === (entry.previousVersion !== null) &&
          (list === 'upgraded') === (entry.direction !== null),
        'dependency_receipt_inconsistent',
      );
      if (entry.previousVersion !== null) {
        requireAutonomy(entry.previousVersion !== entry.version, 'dependency_receipt_inconsistent');
        const before = numericPrefix(entry.previousVersion);
        const after = numericPrefix(entry.version);
        if (before !== null && after !== null) {
          // The runner may know a break the digits do not show; it may not deny one they do.
          requireAutonomy(
            entry.major || !visiblyBreaking(before, after),
            'dependency_receipt_inconsistent',
          );
          const order = compareNumeric(before, after);
          requireAutonomy(
            order === 0 || order < 0 === (entry.direction === 'upgrade'),
            'dependency_receipt_inconsistent',
          );
        }
      }
    }
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
  requireAutonomy(
    receipt.findingsOmittedBelow === null ||
      (['critical', 'high', 'medium', 'low'] as readonly unknown[]).includes(
        receipt.findingsOmittedBelow,
      ),
    'dependency_receipt_invalid',
  );
  requireTimestamp(receipt.completedAt, 'dependency_receipt_invalid');

  // Without verification configured, a receipt is checked for shape but grants nothing.
  if (policy.dependencies === null) return unverified;
  const settings = policy.dependencies;
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
  // A receipt about manifests this change does not touch describes some other change.
  if (!receipt.manifests.every((path) => manifestPaths.includes(path)))
    return block('dependency_receipt_inconsistent');
  if (receipt.status === 'error' || receipt.status === 'timeout')
    return block('dependency_scan_inconclusive');
  if (receipt.status === 'unsupported')
    return {
      reasons: [
        { code: 'dependency_ecosystem_unsupported', category: 'security_auth', effect: 'approval' },
      ],
      verifiedManifests: [],
    };
  if (receipt.resolution === 'not_attempted') return block('dependency_receipt_inconsistent');
  const threshold = SEVERITY_RANK[settings.holdSeverity];
  if (receipt.findingsOmittedBelow !== null) {
    // Omitting anything at or above the hold threshold leaves the decision without evidence.
    if (SEVERITY_RANK[receipt.findingsOmittedBelow] > threshold)
      return block('dependency_findings_incomplete');
    if (
      receipt.findings.some(
        (finding) =>
          finding.severity !== 'unknown' &&
          SEVERITY_RANK[finding.severity] <
            SEVERITY_RANK[receipt.findingsOmittedBelow as DependencySeverity],
      )
    )
      return block('dependency_receipt_inconsistent');
  }

  const reasons: DecisionReason[] = [];
  const hold = (code: string, category: DecisionReason['category']) =>
    reasons.push({ code, category, effect: 'approval' });
  if (receipt.resolution === 'mismatch') hold('lockfile_not_reproducible', 'security_auth');
  for (const field of receipt.manifestFieldsChanged)
    hold(`manifest_field_changed:${field}`, 'governance');
  if (receipt.installScriptsChanged) hold('install_scripts_changed', 'security_auth');
  const label = (entry: PackageChange) => `${entry.ecosystem}/${entry.name}`;
  if (!settings.allowNewDependencies)
    for (const entry of receipt.packages.added)
      hold(`new_dependency:${label(entry)}`, 'security_auth');
  if (!settings.allowMajorUpgrades)
    for (const entry of receipt.packages.upgraded)
      if (entry.major) hold(`major_upgrade:${label(entry)}`, 'security_auth');
  if (!settings.allowDowngrades)
    for (const entry of receipt.packages.upgraded)
      if (entry.direction === 'downgrade')
        hold(`dependency_downgrade:${label(entry)}`, 'security_auth');
  for (const entry of [...receipt.packages.added, ...receipt.packages.upgraded]) {
    if (entry.source !== 'registry')
      hold(`dependency_source_not_registry:${label(entry)}`, 'security_auth');
    if (entry.license === null || !licenseAllowed(entry.license, settings.licenseAllowlist))
      hold(`license_not_allowed:${label(entry)}`, 'release_licensing');
  }
  // Unknown severity is not "below threshold"; it holds like the threshold itself.
  for (const finding of receipt.findings)
    if (finding.severity === 'unknown' || SEVERITY_RANK[finding.severity] >= threshold)
      hold(`vulnerability:${finding.id}`, 'security_auth');
  return { reasons, verifiedManifests: reasons.length === 0 ? [...receipt.manifests] : [] };
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
