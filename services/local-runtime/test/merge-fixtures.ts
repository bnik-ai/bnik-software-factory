import type { RuntimeConfig } from '../src/config.js';
import { GitHubFailure, type Issue } from '../src/github/client.js';
import type { GateGitHub, Pull } from '../src/github/merge-gate.js';
import type { CheckRun, MergePolicy, Protection, Review } from '../src/github/merge-policy.js';
import { liveConfig, repository, task } from './github-fixtures.js';
export const head = 'a'.repeat(40);
export const base = 'b'.repeat(40);
export const policy: MergePolicy = {
  version: 1,
  baseBranch: 'main',
  reviewers: ['example-maintainer'],
  mergers: ['example-maintainer'],
  requiredChecks: [{ name: 'test', appId: 123 }],
};
export const gateConfig = (): RuntimeConfig => ({
  ...liveConfig(),
  mergePolicy: structuredClone(policy),
});
export class MergeFixture implements GateGitHub {
  config = gateConfig();
  repo = {
    ...repository,
    allow_auto_merge: false,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
  };
  task: Issue = {
    ...task(),
    body: 'pr-ref: PR_FIXTURE',
    labels: [{ name: 'kind:task' }, { name: 'status:ready' }],
  };
  pull: Pull = {
    id: 22,
    node_id: 'PR_FIXTURE',
    number: 2,
    state: 'open',
    draft: false,
    body: 'task-ref: I_FIXTURE',
    user: { id: 44, login: 'factory[bot]', type: 'Bot' },
    head: { sha: head, repo: { id: 42 } },
    base: { sha: base, ref: 'main', repo: { id: 42 } },
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    merged_by: null,
    auto_merge: null,
  };
  human = { id: 55, login: 'example-maintainer', type: 'User' };
  permission = 'write';
  owners = '* @example-maintainer\n';
  parents = [{ sha: base }];
  /** Tree of the pull request head, as GitHub's git/commits endpoint reports it. */
  headTree = 'd'.repeat(40);
  protection: Protection = {
    required_status_checks: {
      strict: true,
      checks: [{ context: 'test', app_id: 123 }],
    },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
      required_approving_review_count: 1,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    restrictions: {
      users: [{ login: 'example-maintainer' }],
      teams: [],
      apps: [],
    },
  };
  reviews: Review[] = [
    {
      id: 1,
      user: this.human,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2026-01-01T00:00:00Z',
    },
  ];
  checks: CheckRun[] = [
    {
      id: 1,
      name: 'test',
      head_sha: head,
      app: { id: 123 },
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-01-01T00:00:00Z',
    },
  ];
  dependent: Issue = {
    ...task(),
    id: 11,
    node_id: 'I_DEPENDENT',
    number: 3,
    body: 'blocked-by: I_FIXTURE',
    labels: [{ name: 'kind:task' }, { name: 'status:proposed' }],
  };
  failRead = false;
  /** Reads fail as a retryable GitHub failure (5xx, 429, 403, connection). */
  failReadTransient = false;
  failAfterLabel = false;
  writes = 0;
  async check() {
    return {
      appId: 8,
      installationId: 7,
      repository: this.repo,
      webhookUrl: 'https://factory.example.com/webhook',
    };
  }
  async read<T>(path: string): Promise<T> {
    if (this.failRead) throw new Error('unreadable');
    if (this.failReadTransient) throw new GitHubFailure('github_connection_failed', true);
    const value = path.endsWith('/factory-demo')
      ? this.repo
      : path.endsWith('/protection')
        ? this.protection
        : path.includes('/collaborators/')
          ? { permission: this.permission, user: this.human }
          : path.endsWith('/pulls/2')
            ? this.pull
            : path.endsWith('/issues/1')
              ? this.task
              : path.includes('/git/commits/')
                ? {
                    sha: path.slice(path.lastIndexOf('/') + 1),
                    tree: { sha: this.headTree },
                    parents: this.parents,
                  }
                : path.includes('/commits/')
                  ? { parents: this.parents }
                  : undefined;
    if (!value) throw new Error('unexpected_fixture_read');
    return structuredClone(value) as T;
  }
  async list<T>(resource: 'reviews' | 'checks' | 'tasks'): Promise<T[]> {
    return structuredClone(
      resource === 'reviews'
        ? this.reviews
        : resource === 'checks'
          ? this.checks
          : [this.task, this.dependent],
    ) as T[];
  }
  async codeowners() {
    return this.owners;
  }
  async finishTask(_number: number, statuses: string[], current: () => Promise<void>) {
    await current();
    this.writes++;
    if (!this.task.labels.some((l) => l.name === 'status:done'))
      this.task.labels.push({ name: 'status:done' });
    if (this.failAfterLabel) {
      this.failAfterLabel = false;
      throw new Error('interrupted');
    }
    await current();
    this.task.labels = this.task.labels.filter((l) => !statuses.includes(l.name));
    await current();
    this.task.state = 'closed';
  }
  merge() {
    this.pull.merged = true;
    this.pull.state = 'closed';
    this.pull.merged_at = new Date(Date.now() + 1000).toISOString();
    this.pull.merge_commit_sha = 'c'.repeat(40);
    this.pull.merged_by = this.human;
    this.pull.base.sha = this.pull.merge_commit_sha;
  }
}
