import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../config.js';
import { canonicalJson } from '../queue.js';
import { type CodingJob, parseJob } from '../worker/protocol.js';
import {
  type Comment,
  GitHubFailure,
  type GitHubReads,
  type Issue,
  type Repository,
} from './client.js';

export interface TaskSnapshot {
  issue: Issue;
  taskHash: string;
  sourceCommit: string;
  definition: Pick<CodingJob, 'prompt' | 'tests' | 'model' | 'maxTurns' | 'timeoutMs'>;
}
export const activationCommand = (sourceCommit: string, taskHash: string) =>
  `/factory activate ${sourceCommit} ${taskHash}`;
export function taskSnapshot(
  config: RuntimeConfig,
  issue: Issue,
  sourceCommit: string,
): TaskSnapshot {
  if (
    !Number.isSafeInteger(issue.id) ||
    issue.id < 1 ||
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1 ||
    typeof issue.node_id !== 'string' ||
    !issue.node_id ||
    issue.pull_request ||
    issue.state !== 'open' ||
    issue.locked ||
    typeof issue.title !== 'string' ||
    typeof issue.body !== 'string' ||
    issue.body.length > 65_536 ||
    !Array.isArray(issue.labels) ||
    issue.labels.some((label) => !label || typeof label.name !== 'string')
  )
    throw new GitHubFailure('task_not_eligible');
  const labels = issue.labels.map((label) => label.name).sort();
  if (
    !labels.includes('kind:task') ||
    !labels.includes('status:proposed') ||
    labels.some((label) => label.startsWith('status:') && label !== 'status:proposed')
  )
    throw new GitHubFailure('task_labels_invalid');
  const blocks = [...issue.body.matchAll(/^```factory-task\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) throw new GitHubFailure('task_definition_required');
  let definition: unknown;
  try {
    definition = JSON.parse(blocks[0]?.[1] ?? '');
  } catch {
    throw new GitHubFailure('task_definition_invalid');
  }
  if (
    !definition ||
    typeof definition !== 'object' ||
    Array.isArray(definition) ||
    Object.keys(definition).some(
      (key) => !['prompt', 'tests', 'model', 'maxTurns', 'timeoutMs'].includes(key),
    )
  )
    throw new GitHubFailure('task_definition_invalid');
  let job: CodingJob;
  try {
    job = parseJob({
      ...definition,
      id: 'activation-check',
      mode: 'live',
      repository: config.repository,
      sourceCommit,
      archiveSha256: '0'.repeat(64),
    });
  } catch {
    throw new GitHubFailure('task_definition_invalid');
  }
  const taskHash = createHash('sha256')
    .update(
      canonicalJson({
        repositoryId: config.repositoryId,
        issueId: issue.id,
        number: issue.number,
        nodeId: issue.node_id,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        locked: Boolean(issue.locked),
        labels,
      }),
    )
    .digest('hex');
  return {
    issue,
    taskHash,
    sourceCommit,
    definition: {
      prompt: job.prompt,
      tests: job.tests,
      model: job.model,
      maxTurns: job.maxTurns,
      timeoutMs: job.timeoutMs,
    },
  };
}
export async function prepareTask(
  config: RuntimeConfig,
  github: GitHubReads,
  number: number,
  commit: string,
): Promise<TaskSnapshot> {
  if (!Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(commit))
    throw new GitHubFailure('task_identity_invalid');
  const repoPath = `/repos/${config.repository}`;
  const checked = await github.check();
  const repository: Repository = checked.repository;
  const head = await github.read<{ sha: string }>(
    `${repoPath}/commits/${encodeURIComponent(repository.default_branch)}`,
  );
  if (head.sha !== commit) throw new GitHubFailure('source_is_not_current_default_head');
  const issue = await github.read<Issue>(`${repoPath}/issues/${number}`);
  if (issue.number !== number) throw new GitHubFailure('task_identity_mismatch');
  return taskSnapshot(config, issue, commit);
}
export interface ActivationProof extends TaskSnapshot {
  comment: Comment;
  actorId: number;
  actorLogin: string;
}
export async function verifyActivation(
  config: RuntimeConfig,
  github: GitHubReads,
  value: unknown,
  now = Date.now(),
): Promise<ActivationProof> {
  const body = value as {
    action?: string;
    sender?: Comment['user'];
    comment?: Comment;
    issue?: Issue;
  };
  if (
    !body ||
    body.action !== 'created' ||
    body.sender?.type !== 'User' ||
    body.comment?.user?.type !== 'User' ||
    body.sender.id !== body.comment.user.id ||
    body.sender.login !== body.comment.user.login ||
    !config.operators?.includes(body.sender.login.toLowerCase())
  )
    throw new GitHubFailure('activation_actor_not_authorized');
  const match = /^\/factory activate ([0-9a-f]{40}) ([0-9a-f]{64})$/.exec(
    body.comment.body?.trim() ?? '',
  );
  if (!match || !body.issue || !Number.isSafeInteger(body.comment.id) || body.comment.id < 1)
    throw new GitHubFailure('activation_command_invalid');
  const created = Date.parse(body.comment.created_at);
  if (
    !Number.isFinite(created) ||
    created > now + 60_000 ||
    now - created > 3_600_000 ||
    body.comment.updated_at !== body.comment.created_at
  )
    throw new GitHubFailure('activation_expired_or_edited');
  const repoPath = `/repos/${config.repository}`;
  const permission = await github.read<{
    permission: string;
    user: Comment['user'];
  }>(`${repoPath}/collaborators/${encodeURIComponent(body.sender.login)}/permission`);
  if (
    !['admin', 'write'].includes(permission.permission) ||
    permission.user?.id !== body.sender.id ||
    permission.user.type !== 'User' ||
    permission.user.login.toLowerCase() !== body.sender.login.toLowerCase()
  )
    throw new GitHubFailure('activation_actor_not_authorized');
  const comment = await github.read<Comment>(`${repoPath}/issues/comments/${body.comment.id}`);
  // Bind the current immutable human action, not text edited after activation.
  if (
    comment.id !== body.comment.id ||
    comment.user?.id !== body.sender.id ||
    comment.user.type !== 'User' ||
    comment.body !== body.comment.body ||
    comment.created_at !== body.comment.created_at ||
    comment.updated_at !== comment.created_at
  )
    throw new GitHubFailure('activation_comment_changed');
  const snapshot = await prepareTask(config, github, body.issue.number, match[1] ?? '');
  if (
    snapshot.issue.id !== body.issue.id ||
    snapshot.taskHash !== match[2] ||
    taskSnapshot(config, body.issue, snapshot.sourceCommit).taskHash !== snapshot.taskHash
  )
    throw new GitHubFailure('activation_task_changed');
  return {
    ...snapshot,
    comment,
    actorId: body.sender.id,
    actorLogin: body.sender.login.toLowerCase(),
  };
}
export function approvedJob(
  config: RuntimeConfig,
  id: string,
  proof: ActivationProof,
  archiveSha256: string,
): CodingJob {
  return parseJob({
    ...proof.definition,
    id: `activation-${id}`,
    mode: 'live',
    repository: config.repository,
    sourceCommit: proof.sourceCommit,
    archiveSha256,
  });
}
