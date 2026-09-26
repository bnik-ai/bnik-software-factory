import { createHash } from 'node:crypto';
import { canonicalJson } from '../queue.js';
import { GitHubFailure } from './client.js';

export interface MergePolicy {
  version: 1;
  baseBranch: string;
  reviewers: string[];
  mergers: string[];
  requiredChecks: { name: string; appId: number }[];
}
export function requireGate(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new GitHubFailure(reason);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function parseMergePolicy(value: unknown): MergePolicy {
  const p = value as MergePolicy;
  requireGate(p && typeof p === 'object' && !Array.isArray(p), 'merge_policy_invalid');
  requireGate(
    Object.keys(p).sort().join(',') === 'baseBranch,mergers,requiredChecks,reviewers,version' &&
      p.version === 1 &&
      typeof p.baseBranch === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_/-]{0,99}$/.test(p.baseBranch),
    'merge_policy_invalid',
  );
  for (const users of [p.reviewers, p.mergers]) {
    requireGate(
      Array.isArray(users) &&
        users.length > 0 &&
        users.length <= 20 &&
        new Set(users).size === users.length &&
        users.every((u) => typeof u === 'string' && /^[a-z0-9][a-z0-9-]{0,38}$/.test(u)),
      'merge_policy_users_invalid',
    );
  }
  requireGate(
    Array.isArray(p.requiredChecks) &&
      p.requiredChecks.length > 0 &&
      p.requiredChecks.length <= 20 &&
      new Set(p.requiredChecks.map((c) => c.name)).size === p.requiredChecks.length &&
      p.requiredChecks.every(
        (c) =>
          c &&
          Object.keys(c).sort().join(',') === 'appId,name' &&
          typeof c.name === 'string' &&
          c.name.trim() === c.name &&
          c.name.length > 0 &&
          c.name.length <= 100 &&
          Number.isSafeInteger(c.appId) &&
          c.appId > 0,
      ),
    'merge_policy_checks_invalid',
  );
  return structuredClone(p);
}
export interface Protection {
  required_status_checks?: { strict: boolean; checks: { context: string; app_id: number }[] };
  required_pull_request_reviews?: {
    dismiss_stale_reviews: boolean;
    require_code_owner_reviews: boolean;
    require_last_push_approval: boolean;
    required_approving_review_count: number;
    bypass_pull_request_allowances?: { users?: unknown[]; teams?: unknown[]; apps?: unknown[] };
  };
  enforce_admins?: { enabled: boolean };
  allow_force_pushes?: { enabled: boolean };
  allow_deletions?: { enabled: boolean };
  restrictions?: { users: { login: string }[]; teams: unknown[]; apps: unknown[] };
}
export function verifyProtection(
  policy: MergePolicy,
  protection: Protection,
  codeowners: string,
): void {
  const r = protection.required_pull_request_reviews;
  const c = protection.required_status_checks;
  const bypass = r?.bypass_pull_request_allowances;
  requireGate(
    r &&
      r.dismiss_stale_reviews === true &&
      r.require_code_owner_reviews === true &&
      r.require_last_push_approval === true &&
      r.required_approving_review_count === 1 &&
      (!bypass || [bypass.users, bypass.teams, bypass.apps].every((a) => !a || a.length === 0)),
    'human_review_protection_missing',
  );
  requireGate(
    protection.enforce_admins?.enabled === true &&
      protection.allow_force_pushes?.enabled === false &&
      protection.allow_deletions?.enabled === false,
    'branch_protection_unsafe',
  );
  requireGate(
    c?.strict === true &&
      Array.isArray(c.checks) &&
      c.checks.length === policy.requiredChecks.length &&
      policy.requiredChecks.every((expected) =>
        c.checks.some(
          (actual) => actual.context === expected.name && actual.app_id === expected.appId,
        ),
      ),
    'required_checks_protection_mismatch',
  );
  const push = protection.restrictions;
  requireGate(
    push &&
      push.teams.length === 0 &&
      push.apps.length === 0 &&
      push.users.length > 0 &&
      push.users.every((u) => policy.mergers.includes(u.login.toLowerCase())),
    'human_merge_restriction_missing',
  );
  // One global rule only: no later pattern may silently override human ownership.
  const rules = codeowners
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const owners = rules[0]?.split(/\s+/);
  requireGate(
    rules.length === 1 &&
      owners?.shift() === '*' &&
      digest(owners.sort()) === digest(policy.reviewers.map((u) => `@${u}`).sort()),
    'human_codeowners_mismatch',
  );
}

export interface Review {
  id: number;
  user: { id: number; login: string; type: string };
  state: string;
  commit_id: string;
  submitted_at: string;
}
export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  app: { id: number };
  status: string;
  conclusion: string | null;
  completed_at: string | null;
}
export function verifyReviews(
  policy: MergePolicy,
  reviews: Review[],
  head: string,
  authorId: number,
  before = Number.POSITIVE_INFINITY,
): Review[] {
  const latest = new Map<number, Review>();
  for (const review of reviews) {
    if (review.state === 'PENDING' || review.state === 'COMMENTED') continue;
    requireGate(
      Number.isSafeInteger(review.id) && Number.isFinite(Date.parse(review.submitted_at)),
      'review_evidence_invalid',
    );
    if (Date.parse(review.submitted_at) > before) continue;
    if ((latest.get(review.user.id)?.id ?? 0) < review.id) latest.set(review.user.id, review);
  }
  requireGate(
    ![...latest.values()].some((r) => r.state === 'CHANGES_REQUESTED'),
    'changes_requested',
  );
  const approved = [...latest.values()].filter(
    (r) =>
      r.user.type === 'User' &&
      r.user.id !== authorId &&
      policy.reviewers.includes(r.user.login.toLowerCase()) &&
      r.state === 'APPROVED' &&
      r.commit_id === head,
  );
  requireGate(approved.length > 0, 'human_approval_missing_or_stale');
  return approved;
}
export function verifyChecks(
  policy: MergePolicy,
  checks: CheckRun[],
  head: string,
  before = Number.POSITIVE_INFINITY,
): CheckRun[] {
  return policy.requiredChecks.map((required) => {
    const matching = checks
      .filter(
        (c) => c.name === required.name && c.app?.id === required.appId && c.head_sha === head,
      )
      .sort((a, b) => b.id - a.id);
    const latest = matching[0];
    requireGate(
      latest &&
        Number.isSafeInteger(latest.id) &&
        latest.status === 'completed' &&
        latest.conclusion === 'success' &&
        Number.isFinite(Date.parse(latest.completed_at ?? '')) &&
        Date.parse(latest.completed_at ?? '') <= before,
      'required_ci_missing_failed_or_pending',
    );
    return latest;
  });
}
