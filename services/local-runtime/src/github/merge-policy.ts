import { createHash } from 'node:crypto';
import { canonicalJson } from '../queue.js';
import { GitHubFailure } from './client.js';

export interface MergePolicy {
  version: 1;
  baseBranch: string;
  reviewers: string[];
  mergers: string[];
  requiredChecks: { name: string; appId: number }[];
  /**
   * Automatic-merge profile: the GitHub App that merges routine pull requests
   * under the autonomy policy. Present only when the installation opts in; it selects
   * the protection profile below and identifies the merger the reconciliation accepts.
   */
  merger?: { appSlug: string; appId: number };
}
const MERGE_POLICY_KEYS = 'baseBranch,mergers,requiredChecks,reviewers,version';
const AUTOMATIC_MERGE_POLICY_KEYS = 'baseBranch,merger,mergers,requiredChecks,reviewers,version';
export function requireGate(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new GitHubFailure(reason);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function parseMergePolicy(value: unknown): MergePolicy {
  const p = value as MergePolicy;
  requireGate(p && typeof p === 'object' && !Array.isArray(p), 'merge_policy_invalid');
  const keys = Object.keys(p).sort().join(',');
  requireGate(
    (keys === MERGE_POLICY_KEYS || keys === AUTOMATIC_MERGE_POLICY_KEYS) &&
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
  if (p.merger !== undefined)
    requireGate(
      p.merger &&
        typeof p.merger === 'object' &&
        Object.keys(p.merger).sort().join(',') === 'appId,appSlug' &&
        typeof p.merger.appSlug === 'string' &&
        /^[a-z0-9][a-z0-9-]{0,38}$/.test(p.merger.appSlug) &&
        Number.isSafeInteger(p.merger.appId) &&
        p.merger.appId > 0,
      'merge_policy_merger_invalid',
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
  restrictions?: { users: { login: string }[]; teams: unknown[]; apps: { slug?: string }[] };
}
export function verifyProtection(
  policy: MergePolicy,
  protection: Protection,
  codeowners: string,
): void {
  const r = protection.required_pull_request_reviews;
  const c = protection.required_status_checks;
  const bypass = r?.bypass_pull_request_allowances;
  // Automatic profile: the merger App approves and merges routine work under the autonomy
  // policy, so code-owner review is not required by GitHub; nothing may bypass the rest.
  requireGate(
    r &&
      r.dismiss_stale_reviews === true &&
      r.require_code_owner_reviews === (policy.merger === undefined) &&
      r.require_last_push_approval === true &&
      r.required_approving_review_count === 1 &&
      (!bypass || [bypass.users, bypass.teams, bypass.apps].every((a) => !a || a.length === 0)),
    policy.merger === undefined
      ? 'human_review_protection_missing'
      : 'automatic_review_protection_missing',
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
      push.users.length > 0 &&
      push.users.every((u) => policy.mergers.includes(u.login.toLowerCase())),
    'human_merge_restriction_missing',
  );
  // Human profile: no App may push to the base. Automatic profile: exactly the merger App.
  requireGate(
    policy.merger === undefined
      ? push.apps.length === 0
      : push.apps.length === 1 && push.apps[0]?.slug === policy.merger.appSlug,
    policy.merger === undefined
      ? 'human_merge_restriction_missing'
      : 'automatic_merge_restriction_missing',
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
  acceptMerger = false,
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
  // Automatic profile: the merger App's approval of the exact head, given after the autonomy
  // policy admitted the merge, satisfies the review requirement for the App's own merge only;
  // a human merge under this profile still needs a listed reviewer.
  const mergerLogin = policy.merger && acceptMerger ? `${policy.merger.appSlug}[bot]` : null;
  const approved = [...latest.values()].filter(
    (r) =>
      r.state === 'APPROVED' &&
      r.commit_id === head &&
      ((r.user.type === 'User' &&
        r.user.id !== authorId &&
        policy.reviewers.includes(r.user.login.toLowerCase())) ||
        (mergerLogin !== null &&
          r.user.type === 'Bot' &&
          r.user.login.toLowerCase() === mergerLogin)),
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

/** Latest non-comment review per user, ignoring reviews submitted after `before`. */
export function latestReviews(reviews: Review[], before = Number.POSITIVE_INFINITY): Review[] {
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
  return [...latest.values()];
}
/**
 * Graded state of the required checks on `head` for the merge-gate observation. Missing
 * or unknown-app runs never count; the latest attempt per required check decides.
 */
export function classifyChecks(
  policy: MergePolicy,
  checks: CheckRun[],
  head: string,
): 'passed' | 'failed' | 'pending' | 'missing' {
  const states = policy.requiredChecks.map((required) => {
    const latest = checks
      .filter(
        (c) => c.name === required.name && c.app?.id === required.appId && c.head_sha === head,
      )
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || !Number.isSafeInteger(latest.id)) return 'missing';
    if (latest.status !== 'completed') return 'pending';
    return latest.conclusion === 'success' && Number.isFinite(Date.parse(latest.completed_at ?? ''))
      ? 'passed'
      : 'failed';
  });
  if (states.includes('failed')) return 'failed';
  if (states.includes('missing')) return 'missing';
  if (states.includes('pending')) return 'pending';
  return 'passed';
}
