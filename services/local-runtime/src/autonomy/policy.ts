import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  AutonomyError,
  pathWithin,
  requireAutonomy,
  requireInteger,
  requireRecord,
  requireRepositoryPath,
  requireSha256,
  requireUniqueList,
  sha256Json,
} from './schema.js';

export const CRITICAL_CATEGORIES = [
  'security_auth',
  'secrets_permissions',
  'production_deployment',
  'infrastructure_spend',
  'destructive_data',
  'release_licensing',
  'governance',
] as const;
export type CriticalCategory = (typeof CRITICAL_CATEGORIES)[number];

/** Upper bounds match the worker's own ceilings (worker/protocol.ts, worker/records.ts). */
export const POLICY_CEILINGS = {
  maxTurns: 60,
  maxRunMs: 1_800_000,
  maxRunMicrousd: 100_000_000,
  maxScopeMicrousd: 1_000_000_000,
  maxTaskRuns: 20,
  maxChangedFiles: 1000,
  maxChangedBytes: 8 * 1024 * 1024,
  receiptTtlMs: 86_400_000,
} as const;

/**
 * Trusted autonomy policy v1. Loaded only from an operator-selected host file;
 * never from a PR branch, Task text, labels, worker output or model output.
 */
export interface AutonomyPolicy {
  version: 1;
  /** Strictly increases on every activation; prevents replaying an older document. */
  revision: number;
  /** `human_gated` keeps a human approval on every action (the existing alpha behavior). */
  mode: 'human_gated' | 'bounded';
  repository: { fullName: string; id: number; installationId: number; baseBranch: string };
  /** Path prefixes routine work may change; `.` means the whole repository. */
  allowedPaths: string[];
  /** Added to the built-in critical rules in classify.ts; cannot remove them. */
  criticalPaths: { path: string; category: CriticalCategory }[];
  execution: {
    models: string[];
    maxTurns: number;
    maxRunMs: number;
    maxRunMicrousd: number;
    maxScopeMicrousd: number;
    maxTaskRuns: number;
  };
  changeLimits: { maxChangedFiles: number; maxChangedBytes: number };
  /** What merging into baseBranch triggers. `deployment` holds every merge for a human. */
  mergeEffect: 'none' | 'deployment';
  verification: {
    acceptanceSuiteSha256: string;
    acceptanceHarnessSha256: string;
    acceptanceRunnerImage: string;
    reviewerConfigSha256: string;
    evalProtocolSha256: string;
    /** In-repository copies of protected assets; changes to them are governance-critical. */
    protectedPaths: string[];
    receiptTtlMs: number;
  };
  approvers: { githubUserIds: number[] };
}

const POLICY_KEYS = [
  'version',
  'revision',
  'mode',
  'repository',
  'allowedPaths',
  'criticalPaths',
  'execution',
  'changeLimits',
  'mergeEffect',
  'verification',
  'approvers',
];
function requirePrefixList(
  value: unknown,
  minimum: number,
  reason: string,
): asserts value is string[] {
  requireUniqueList<string>(value, minimum, 200, reason);
  for (const prefix of value) {
    if (prefix === '.') continue;
    requireRepositoryPath(prefix, reason);
  }
}
export function parsePolicy(value: unknown): AutonomyPolicy {
  requireRecord(value, POLICY_KEYS, 'policy_fields_invalid');
  const policy = value as unknown as AutonomyPolicy;
  requireAutonomy(policy.version === 1, 'policy_version_unsupported');
  requireInteger(policy.revision, 1, Number.MAX_SAFE_INTEGER, 'policy_revision_invalid');
  requireAutonomy(
    policy.mode === 'human_gated' || policy.mode === 'bounded',
    'policy_mode_invalid',
  );

  requireRecord(
    policy.repository,
    ['fullName', 'id', 'installationId', 'baseBranch'],
    'policy_repository_invalid',
  );
  requireAutonomy(
    typeof policy.repository.fullName === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
        policy.repository.fullName,
      ),
    'policy_repository_invalid',
  );
  requireInteger(policy.repository.id, 1, Number.MAX_SAFE_INTEGER, 'policy_repository_invalid');
  requireInteger(
    policy.repository.installationId,
    1,
    Number.MAX_SAFE_INTEGER,
    'policy_repository_invalid',
  );
  requireAutonomy(
    typeof policy.repository.baseBranch === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/.test(policy.repository.baseBranch) &&
      !policy.repository.baseBranch.includes('..'),
    'policy_repository_invalid',
  );

  requirePrefixList(policy.allowedPaths, 1, 'policy_allowed_paths_invalid');
  requireUniqueList<unknown>(policy.criticalPaths, 0, 200, 'policy_critical_paths_invalid');
  for (const entry of policy.criticalPaths) {
    requireRecord(entry, ['path', 'category'], 'policy_critical_paths_invalid');
    requireRepositoryPath(entry.path, 'policy_critical_paths_invalid');
    requireAutonomy(
      (CRITICAL_CATEGORIES as readonly string[]).includes(String(entry.category)),
      'policy_critical_paths_invalid',
    );
  }

  requireRecord(
    policy.execution,
    ['models', 'maxTurns', 'maxRunMs', 'maxRunMicrousd', 'maxScopeMicrousd', 'maxTaskRuns'],
    'policy_execution_invalid',
  );
  requireUniqueList<string>(policy.execution.models, 1, 20, 'policy_models_invalid');
  for (const model of policy.execution.models)
    requireAutonomy(
      typeof model === 'string' && /^claude-[A-Za-z0-9.-]{1,93}$/.test(model),
      'policy_models_invalid',
    );
  requireInteger(
    policy.execution.maxTurns,
    1,
    POLICY_CEILINGS.maxTurns,
    'policy_execution_invalid',
  );
  requireInteger(
    policy.execution.maxRunMs,
    1000,
    POLICY_CEILINGS.maxRunMs,
    'policy_execution_invalid',
  );
  requireInteger(
    policy.execution.maxRunMicrousd,
    1,
    POLICY_CEILINGS.maxRunMicrousd,
    'policy_execution_invalid',
  );
  requireInteger(
    policy.execution.maxScopeMicrousd,
    policy.execution.maxRunMicrousd,
    POLICY_CEILINGS.maxScopeMicrousd,
    'policy_execution_invalid',
  );
  requireInteger(
    policy.execution.maxTaskRuns,
    1,
    POLICY_CEILINGS.maxTaskRuns,
    'policy_execution_invalid',
  );

  requireRecord(
    policy.changeLimits,
    ['maxChangedFiles', 'maxChangedBytes'],
    'policy_change_limits_invalid',
  );
  requireInteger(
    policy.changeLimits.maxChangedFiles,
    1,
    POLICY_CEILINGS.maxChangedFiles,
    'policy_change_limits_invalid',
  );
  requireInteger(
    policy.changeLimits.maxChangedBytes,
    1,
    POLICY_CEILINGS.maxChangedBytes,
    'policy_change_limits_invalid',
  );

  requireAutonomy(
    policy.mergeEffect === 'none' || policy.mergeEffect === 'deployment',
    'policy_merge_effect_invalid',
  );

  requireRecord(
    policy.verification,
    [
      'acceptanceSuiteSha256',
      'acceptanceHarnessSha256',
      'acceptanceRunnerImage',
      'reviewerConfigSha256',
      'evalProtocolSha256',
      'protectedPaths',
      'receiptTtlMs',
    ],
    'policy_verification_invalid',
  );
  requireSha256(policy.verification.acceptanceSuiteSha256, 'policy_verification_invalid');
  requireSha256(policy.verification.acceptanceHarnessSha256, 'policy_verification_invalid');
  requireSha256(policy.verification.reviewerConfigSha256, 'policy_verification_invalid');
  requireSha256(policy.verification.evalProtocolSha256, 'policy_verification_invalid');
  // Digest-pinned only; a mutable tag is not a trust root.
  requireAutonomy(
    typeof policy.verification.acceptanceRunnerImage === 'string' &&
      /^sha256:[0-9a-f]{64}$/.test(policy.verification.acceptanceRunnerImage),
    'policy_runner_image_not_digest_pinned',
  );
  requirePrefixList(policy.verification.protectedPaths, 0, 'policy_protected_paths_invalid');
  requireAutonomy(
    !policy.verification.protectedPaths.includes('.'),
    'policy_protected_paths_invalid',
  );
  requireInteger(
    policy.verification.receiptTtlMs,
    60_000,
    POLICY_CEILINGS.receiptTtlMs,
    'policy_verification_invalid',
  );

  requireRecord(policy.approvers, ['githubUserIds'], 'policy_approvers_invalid');
  requireUniqueList<number>(policy.approvers.githubUserIds, 1, 20, 'policy_approvers_invalid');
  for (const userId of policy.approvers.githubUserIds)
    requireInteger(userId, 1, Number.MAX_SAFE_INTEGER, 'policy_approvers_invalid');
  return structuredClone(policy);
}
export function policyDigest(policy: AutonomyPolicy): string {
  return sha256Json(policy);
}
/**
 * The operator chooses this path; never pass a worker-, Task- or PR-supplied path.
 * Opened without following a final symlink and checked on the open handle, so the
 * file cannot be swapped between the check and the read. Ownership is not checked:
 * container and host user IDs legitimately differ.
 */
export function loadPolicy(filename: string): AutonomyPolicy {
  requireAutonomy(isAbsolute(filename), 'policy_path_must_be_absolute');
  let document: unknown;
  let descriptor: number | null = null;
  try {
    try {
      descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP')
        throw new AutonomyError('policy_file_unsafe');
      throw error;
    }
    const stat = fstatSync(descriptor);
    requireAutonomy(
      stat.isFile() && (stat.mode & 0o022) === 0 && stat.size > 0 && stat.size <= 65_536,
      'policy_file_unsafe',
    );
    document = JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error instanceof AutonomyError) throw error;
    throw new AutonomyError('policy_file_unreadable');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return parsePolicy(document);
}

export interface PolicyChange {
  code: string;
  effect: 'weakens' | 'strengthens';
  detail?: string;
}
function uncovered(candidates: string[], coverage: string[]): string[] {
  return candidates.filter(
    (candidate) => !coverage.some((prefix) => pathWithin(candidate, prefix)),
  );
}
/**
 * Assessed by the currently active (trusted) policy. Any weakening must be
 * acknowledged explicitly at activation; a replacement cannot vouch for itself.
 * Trust-root digests are opaque, so any change to them counts as weakening.
 */
export function comparePolicies(current: AutonomyPolicy, proposed: AutonomyPolicy): PolicyChange[] {
  requireAutonomy(proposed.revision > current.revision, 'policy_revision_not_increasing');
  const changes: PolicyChange[] = [];
  const weakens = (code: string, detail?: string) =>
    changes.push(
      detail === undefined ? { code, effect: 'weakens' } : { code, effect: 'weakens', detail },
    );
  const strengthens = (code: string, detail?: string) =>
    changes.push(
      detail === undefined
        ? { code, effect: 'strengthens' }
        : { code, effect: 'strengthens', detail },
    );

  if (sha256Json(current.repository) !== sha256Json(proposed.repository))
    weakens('repository_changed');
  if (current.mode !== proposed.mode)
    (proposed.mode === 'bounded' ? weakens : strengthens)(
      'mode_changed',
      `${current.mode}->${proposed.mode}`,
    );
  for (const added of uncovered(proposed.allowedPaths, current.allowedPaths))
    weakens('allowed_path_added', added);
  for (const removed of uncovered(current.allowedPaths, proposed.allowedPaths))
    strengthens('allowed_path_removed', removed);
  const criticalEntry = (entry: { path: string; category: string }) =>
    `${entry.category}:${entry.path}`;
  const currentCritical = current.criticalPaths.map(criticalEntry);
  const proposedCritical = proposed.criticalPaths.map(criticalEntry);
  for (const removed of currentCritical.filter((entry) => !proposedCritical.includes(entry)))
    weakens('critical_path_removed', removed);
  for (const added of proposedCritical.filter((entry) => !currentCritical.includes(entry)))
    strengthens('critical_path_added', added);
  for (const removed of uncovered(
    current.verification.protectedPaths,
    proposed.verification.protectedPaths,
  ))
    weakens('protected_path_removed', removed);
  for (const added of uncovered(
    proposed.verification.protectedPaths,
    current.verification.protectedPaths,
  ))
    strengthens('protected_path_added', added);
  for (const model of proposed.execution.models)
    if (!current.execution.models.includes(model)) weakens('model_added', model);
  for (const model of current.execution.models)
    if (!proposed.execution.models.includes(model)) strengthens('model_removed', model);
  const numericLimits: [string, number, number][] = [
    ['execution.maxTurns', current.execution.maxTurns, proposed.execution.maxTurns],
    ['execution.maxRunMs', current.execution.maxRunMs, proposed.execution.maxRunMs],
    [
      'execution.maxRunMicrousd',
      current.execution.maxRunMicrousd,
      proposed.execution.maxRunMicrousd,
    ],
    [
      'execution.maxScopeMicrousd',
      current.execution.maxScopeMicrousd,
      proposed.execution.maxScopeMicrousd,
    ],
    ['execution.maxTaskRuns', current.execution.maxTaskRuns, proposed.execution.maxTaskRuns],
    [
      'changeLimits.maxChangedFiles',
      current.changeLimits.maxChangedFiles,
      proposed.changeLimits.maxChangedFiles,
    ],
    [
      'changeLimits.maxChangedBytes',
      current.changeLimits.maxChangedBytes,
      proposed.changeLimits.maxChangedBytes,
    ],
    [
      'verification.receiptTtlMs',
      current.verification.receiptTtlMs,
      proposed.verification.receiptTtlMs,
    ],
  ];
  for (const [field, before, after] of numericLimits) {
    if (after > before) weakens('limit_raised', field);
    if (after < before) strengthens('limit_lowered', field);
  }
  if (current.mergeEffect !== proposed.mergeEffect)
    (proposed.mergeEffect === 'none' ? weakens : strengthens)(
      'merge_effect_changed',
      `${current.mergeEffect}->${proposed.mergeEffect}`,
    );
  for (const field of [
    'acceptanceSuiteSha256',
    'acceptanceHarnessSha256',
    'acceptanceRunnerImage',
    'reviewerConfigSha256',
    'evalProtocolSha256',
  ] as const)
    if (current.verification[field] !== proposed.verification[field])
      weakens('trust_root_changed', field);
  for (const userId of proposed.approvers.githubUserIds)
    if (!current.approvers.githubUserIds.includes(userId))
      weakens('approver_added', String(userId));
  for (const userId of current.approvers.githubUserIds)
    if (!proposed.approvers.githubUserIds.includes(userId))
      strengthens('approver_removed', String(userId));
  return changes;
}
export function weakeningCodes(changes: PolicyChange[]): string[] {
  return changes
    .filter((change) => change.effect === 'weakens')
    .map((change) =>
      change.detail === undefined ? change.code : `${change.code}:${change.detail}`,
    )
    .sort();
}

export interface TreeEntry {
  path: string;
  mode: '100644' | '100755';
  sha256: string;
}
/**
 * Content identity for a protected suite or harness bundle, independent of Git
 * object format. Pinned in the policy; the trusted runner recomputes it.
 */
export function contentTreeDigest(entries: TreeEntry[]): string {
  requireUniqueList<TreeEntry>(entries, 1, 10_000, 'tree_entries_invalid');
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    requireRecord(entry, ['path', 'mode', 'sha256'], 'tree_entries_invalid');
    requireRepositoryPath(entry.path, 'tree_entries_invalid');
    requireAutonomy(entry.mode === '100644' || entry.mode === '100755', 'tree_entries_invalid');
    requireSha256(entry.sha256, 'tree_entries_invalid');
    requireAutonomy(!seenPaths.has(entry.path.toLowerCase()), 'tree_entries_case_collision');
    seenPaths.add(entry.path.toLowerCase());
  }
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return sha256Json({
    version: 1,
    entries: sorted.map(({ path, mode, sha256 }) => [path, mode, sha256]),
  });
}
