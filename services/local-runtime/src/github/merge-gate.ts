import { parseBlockedBy } from '../../../agents/src/tools/taskDependencies.js';
import { type TaskState, evaluateTaskTransition } from '../../../validator/src/taskFsm.js';
import type { RuntimeConfig } from '../config.js';
import { GitHubFailure, type GitHubReads, type Issue, type Repository } from './client.js';
import {
  type CheckRun,
  type MergePolicy,
  type Protection,
  type Review,
  digest,
  requireGate,
  verifyChecks,
  verifyProtection,
  verifyReviews,
} from './merge-policy.js';

export interface GateGitHub extends GitHubReads {
  list<T>(resource: 'reviews' | 'checks' | 'tasks', ref: string): Promise<T[]>;
  codeowners(commit: string): Promise<string>;
  finishTask(
    number: number,
    oldStatuses: string[],
    assertCurrent: () => Promise<void>,
  ): Promise<void>;
}
export interface Pull {
  id: number;
  node_id: string;
  number: number;
  state: string;
  draft: boolean;
  body: string | null;
  user: { id: number; login: string; type: string };
  head: { sha: string; repo: { id: number } | null };
  base: { sha: string; ref: string; repo: { id: number } };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  merged_by: { id: number; login: string; type: string } | null;
  auto_merge: unknown;
}
export interface Pair {
  repositoryId: number;
  installationId: number;
  taskNumber: number;
  taskId: number;
  taskNodeId: string;
  taskHash: string;
  pullNumber: number;
  pullId: number;
  pullNodeId: string;
  initialHead: string;
}
export interface Foundation {
  head: string;
  base: string;
  policyHash: string;
  protectionHash: string;
  codeownersHash: string;
  observedAt: string;
}
export interface MergeProof {
  foundation: Foundation;
  pullId: number;
  taskId: number;
  mergeCommit: string;
  mergedAt: string;
  merger: { id: number; login: string; type: string };
  reviews: Review[];
  checks: CheckRun[];
}
const sha = /^[0-9a-f]{40}$/;
function ref(body: string | null, key: string): string | undefined {
  const matches = (body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${key}:`));
  return matches.length === 1 ? matches[0]?.slice(key.length + 1).trim() : undefined;
}
function taskHash(task: Issue): string {
  return digest({
    id: task.id,
    nodeId: task.node_id,
    number: task.number,
    title: task.title,
    body: task.body,
  });
}
export function assertPairTask(pair: Pair, task: Issue, allowPartial = false): string[] {
  requireGate(
    task.id === pair.taskId &&
      task.node_id === pair.taskNodeId &&
      task.number === pair.taskNumber &&
      taskHash(task) === pair.taskHash &&
      !task.pull_request &&
      !task.locked &&
      ref(task.body, 'pr-ref') === pair.pullNodeId,
    'paired_task_changed',
  );
  const labels = task.labels.map((l) => l.name);
  const statuses = labels.filter((l) => l.startsWith('status:'));
  requireGate(
    labels.includes('kind:task') &&
      statuses.length > 0 &&
      statuses.length <= (allowPartial ? 2 : 1) &&
      statuses.every(
        (s) =>
          s === 'status:ready' || s === 'status:in_review' || (allowPartial && s === 'status:done'),
      ) &&
      (task.state === 'open' ||
        (allowPartial && task.state === 'closed' && statuses.includes('status:done'))),
    'paired_task_state_invalid',
  );
  const old = statuses.filter((s) => s !== 'status:done');
  requireGate(
    old.length <= 1 &&
      old.every(
        (s) =>
          evaluateTaskTransition({
            fromState: s.slice(7) as TaskState,
            toState: 'done',
            actor: 'OpsAgent',
          }).verdict === 'accept',
      ),
    'task_transition_invalid',
  );
  return old;
}
export interface GateOptions {
  /** Repositories a pull request head may live in: the base itself, plus the configured publication fork. */
  headRepositoryIds?: number[];
  /**
   * Automatic merge: a merge the autonomy ledger admitted and the merger App performed. Reconciliation
   * accepts that bot as the merge actor for exactly this merge commit; humans stay the only
   * other accepted mergers.
   */
  acceptMerger?: { login: string; mergeCommit: string };
}
/** Where a pull request head may live: the base repository and, in fork publication mode, the fork. */
export function headRepositoryIds(config: RuntimeConfig): number[] {
  const ids = [config.repositoryId ?? 0];
  const fork =
    config.autonomy?.publisher?.mode === 'fork'
      ? config.autonomy.publisher.forkRepositoryId
      : config.mergeForkRepositoryId;
  if (fork) ids.push(fork);
  return ids;
}
export function assertPull(
  config: RuntimeConfig,
  pair: Pair,
  pull: Pull,
  options: GateOptions = {},
) {
  const headRepositoryIds = options.headRepositoryIds ?? [pair.repositoryId];
  requireGate(
    pair.repositoryId === config.repositoryId &&
      pair.installationId === config.installationId &&
      pull.id === pair.pullId &&
      pull.node_id === pair.pullNodeId &&
      pull.number === pair.pullNumber &&
      pull.base.repo.id === pair.repositoryId &&
      pull.head.repo !== null &&
      headRepositoryIds.includes(pull.head.repo.id) &&
      pull.base.ref === config.mergePolicy?.baseBranch &&
      sha.test(pull.head.sha) &&
      ref(pull.body, 'task-ref') === pair.taskNodeId &&
      !pull.draft &&
      !pull.auto_merge,
    'paired_pull_changed_or_unsafe',
  );
}
export async function pairPull(
  config: RuntimeConfig,
  github: GateGitHub,
  taskNumber: number,
  pullNumber: number,
  head: string,
  options: GateOptions = {},
): Promise<Pair> {
  requireGate(
    config.mode === 'live' &&
      config.mergePolicy &&
      Number.isSafeInteger(taskNumber) &&
      taskNumber > 0 &&
      Number.isSafeInteger(pullNumber) &&
      pullNumber > 0 &&
      sha.test(head),
    'pair_arguments_invalid',
  );
  await github.check();
  const prefix = `/repos/${config.repository}`;
  const task = await github.read<Issue>(`${prefix}/issues/${taskNumber}`);
  const pull = await github.read<Pull>(`${prefix}/pulls/${pullNumber}`);
  const pair: Pair = {
    repositoryId: config.repositoryId ?? 0,
    installationId: config.installationId,
    taskNumber,
    taskId: task.id,
    taskNodeId: task.node_id,
    taskHash: taskHash(task),
    pullNumber,
    pullId: pull.id,
    pullNodeId: pull.node_id,
    initialHead: head,
  };
  assertPull(config, pair, pull, options);
  assertPairTask(pair, task);
  requireGate(
    pull.state === 'open' && !pull.merged && pull.head.sha === head,
    'pair_head_not_open_or_current',
  );
  return pair;
}
/** Whether `login` is a human with write access; GitHub counts only such reviews. */
export async function writeCollaborator(
  github: GateGitHub,
  prefix: string,
  login: string,
  id?: number,
): Promise<boolean> {
  const permission = await github.read<{
    permission: string;
    user: { id: number; login: string; type: string };
  }>(`${prefix}/collaborators/${encodeURIComponent(login)}/permission`);
  return (
    ['write', 'admin'].includes(permission.permission) &&
    permission.user?.type === 'User' &&
    permission.user.login.toLowerCase() === login &&
    (id === undefined || permission.user.id === id)
  );
}
async function human(github: GateGitHub, prefix: string, login: string, id?: number) {
  requireGate(
    await writeCollaborator(github, prefix, login, id),
    'configured_human_permission_missing',
  );
}
export async function inspectGate(
  config: RuntimeConfig,
  github: GateGitHub,
  pair: Pair,
  previous?: Foundation,
  options: GateOptions = {},
) {
  requireGate(config.mode === 'live' && config.mergePolicy, 'merge_policy_not_configured');
  const policy: MergePolicy = config.mergePolicy;
  await github.check();
  const prefix = `/repos/${config.repository}`;
  const repo = await github.read<Repository>(prefix);
  requireGate(
    repo.id === pair.repositoryId &&
      repo.default_branch === policy.baseBranch &&
      !repo.archived &&
      !repo.disabled &&
      repo.allow_auto_merge === false &&
      repo.allow_squash_merge === true &&
      repo.allow_merge_commit === false &&
      repo.allow_rebase_merge === false,
    'repository_merge_settings_unsafe',
  );
  const pull = await github.read<Pull>(`${prefix}/pulls/${pair.pullNumber}`);
  assertPull(config, pair, pull, options);
  requireGate(pull.merged || pull.state === 'open', 'pull_closed_without_merge');
  const task = await github.read<Issue>(`${prefix}/issues/${pair.taskNumber}`);
  assertPairTask(pair, task, pull.merged);
  for (const login of new Set([...policy.reviewers, ...policy.mergers]))
    await human(github, prefix, login);
  const protection = await github.read<Protection>(
    `${prefix}/branches/${encodeURIComponent(policy.baseBranch)}/protection`,
  );
  const base = pull.merged ? previous?.base : pull.base.sha;
  requireGate(base && sha.test(base), 'pre_merge_observation_missing');
  const codeowners = await github.codeowners(base);
  verifyProtection(policy, protection, codeowners);
  requireGate(
    (await github.codeowners(pull.head.sha)) === codeowners,
    'codeowners_changed_in_pull',
  );
  const foundation: Foundation = {
    head: pull.head.sha,
    base,
    policyHash: digest(policy),
    protectionHash: digest(protection),
    codeownersHash: digest(codeowners),
    observedAt: new Date().toISOString(),
  };
  if (pull.merged) {
    const mergedAt = Date.parse(pull.merged_at ?? '');
    requireGate(
      previous &&
        previous.head === foundation.head &&
        previous.policyHash === foundation.policyHash &&
        previous.protectionHash === foundation.protectionHash &&
        previous.codeownersHash === foundation.codeownersHash &&
        Number.isFinite(mergedAt) &&
        Date.parse(previous.observedAt) <= mergedAt,
      'pre_merge_observation_stale',
    );
    const mergedBy = pull.merged_by;
    const mergerApp =
      options.acceptMerger !== undefined &&
      policy.merger !== undefined &&
      mergedBy?.type === 'Bot' &&
      mergedBy.login.toLowerCase() === options.acceptMerger.login.toLowerCase() &&
      mergedBy.login.toLowerCase() === `${policy.merger.appSlug}[bot]` &&
      pull.merge_commit_sha === options.acceptMerger.mergeCommit;
    requireGate(
      mergedBy &&
        (mergerApp ||
          (mergedBy.type === 'User' &&
            policy.mergers.includes(mergedBy.login.toLowerCase()) &&
            sha.test(pull.merge_commit_sha ?? ''))),
      'merge_actor_not_configured_human',
    );
    if (!mergerApp) await human(github, prefix, mergedBy.login.toLowerCase(), mergedBy.id);
    const commit = await github.read<{ parents: { sha: string }[] }>(
      `${prefix}/commits/${pull.merge_commit_sha}`,
    );
    requireGate(
      commit.parents.length === 1 && commit.parents[0]?.sha === base,
      'merge_base_differs_from_observation',
    );
  }
  return { pull, task, foundation };
}
export async function reviewEvidence(config: RuntimeConfig, github: GateGitHub, pull: Pull) {
  requireGate(config.mergePolicy, 'merge_policy_not_configured');
  const before = pull.merged ? Date.parse(pull.merged_at ?? '') : Date.now() + 60_000;
  const checks = verifyChecks(
    config.mergePolicy,
    await github.list<CheckRun>('checks', pull.head.sha),
    pull.head.sha,
    before,
  );
  // The merger App's own approval counts only for a merge the App itself made.
  const merger = config.mergePolicy.merger;
  const mergedByMerger =
    merger !== undefined &&
    pull.merged &&
    pull.merged_by?.type === 'Bot' &&
    pull.merged_by.login.toLowerCase() === `${merger.appSlug}[bot]`;
  const reviews = verifyReviews(
    config.mergePolicy,
    await github.list<Review>('reviews', String(pull.number)),
    pull.head.sha,
    pull.user.id,
    before,
    mergedByMerger,
  );
  for (const review of reviews)
    if (review.user.type === 'User')
      await human(
        github,
        `/repos/${config.repository}`,
        review.user.login.toLowerCase(),
        review.user.id,
      );
  // Re-read after paginated review/check reads. A moving head cannot reuse this result.
  const fresh = await github.read<Pull>(`/repos/${config.repository}/pulls/${pull.number}`);
  requireGate(
    fresh.state === pull.state &&
      !fresh.auto_merge &&
      fresh.head.sha === pull.head.sha &&
      fresh.base.sha === pull.base.sha &&
      fresh.merged === pull.merged &&
      fresh.merged_at === pull.merged_at &&
      fresh.merge_commit_sha === pull.merge_commit_sha &&
      fresh.body === pull.body &&
      !fresh.draft,
    'pull_changed_during_review',
  );
  return { checks, reviews };
}

export interface DependencyState {
  number: number;
  nodeId: string;
  state: 'clear' | 'blocked';
  blockers: string[];
}
export function dependencyStates(tasks: Issue[]): DependencyState[] {
  const byId = new Map(tasks.filter((t) => !t.pull_request).map((t) => [t.node_id, t]));
  return tasks
    .filter((t) => !t.pull_request && t.state === 'open')
    .map((task) => {
      const fields = (task.body ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^blocked-by:|^#{1,6}\s+blocked-by\s*$/i.test(s));
      const refs = fields.length > 1 ? ['ambiguous_blocked_by'] : parseBlockedBy(task.body ?? '');
      const blockers = refs.filter((id) => {
        const blocker = byId.get(id);
        const statuses = blocker?.labels
          .filter((l) => l.name.startsWith('status:'))
          .map((l) => l.name);
        return (
          !blocker ||
          id === task.node_id ||
          !blocker.labels.some((l) => l.name === 'kind:task') ||
          statuses?.length !== 1 ||
          !['status:done', 'status:abandoned'].includes(statuses[0] ?? '')
        );
      });
      return {
        number: task.number,
        nodeId: task.node_id,
        state: blockers.length ? 'blocked' : 'clear',
        blockers,
      };
    });
}
export function gateReason(error: unknown): string {
  return error instanceof GitHubFailure ? error.reason : 'review_surface_unreadable';
}
