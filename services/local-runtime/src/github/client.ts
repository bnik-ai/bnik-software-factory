import { signAppJwt } from '../../../agents/src/auth/installationToken.js';
import type { RuntimeConfig } from '../config.js';

export const INTAKE_PERMISSIONS = {
  contents: 'read',
  issues: 'read',
  pull_requests: 'read',
  checks: 'read',
  statuses: 'read',
  metadata: 'read',
} as const;
export const REVIEW_PERMISSIONS = {
  ...INTAKE_PERMISSIONS,
  administration: 'read',
  issues: 'write',
} as const;
export const INTAKE_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'check_run',
  'check_suite',
  'status',
] as const;
export class GitHubFailure extends Error {
  constructor(
    readonly reason: string,
    readonly retryable = false,
  ) {
    super(reason);
  }
}
export interface Repository {
  id: number;
  full_name: string;
  default_branch: string;
  archived: boolean;
  disabled: boolean;
  allow_auto_merge?: boolean;
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_rebase_merge?: boolean;
}
export interface Issue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  locked: boolean;
  pull_request?: unknown;
  labels: { name: string }[];
}
export interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: { id: number; login: string; type: string };
}
export interface GitHubReads {
  check(): Promise<{
    appId: number;
    installationId: number;
    repository: Repository;
    webhookUrl: string;
  }>;
  read<T>(path: string): Promise<T>;
}
// Fixed GitHub origin; credentials never enter URL, errors, logs or job payloads.
export class InstallationClient implements GitHubReads {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly signal: AbortSignal,
    private readonly request: typeof fetch = fetch,
  ) {}
  private jwt(): string {
    if (!this.config.appId || !this.config.appPrivateKey)
      throw new GitHubFailure('app_identity_missing');
    return signAppJwt(this.config.appId, this.config.appPrivateKey);
  }
  private permissions() {
    return this.config.mergePolicy ? REVIEW_PERMISSIONS : INTAKE_PERMISSIONS;
  }
  private async call(
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    try {
      const response = await this.request(`https://api.github.com${path}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'software-factory-local',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok)
        throw new GitHubFailure(
          response.status === 404 ? 'github_record_unavailable' : 'github_request_failed',
          response.status >= 500 || response.status === 429 || response.status === 403,
        );
      if (response.status === 204) return undefined;
      let bytes = Buffer.alloc(0);
      if (!response.body) throw new GitHubFailure('github_response_invalid');
      for await (const chunk of response.body) {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 1_048_576) throw new GitHubFailure('github_response_too_large');
      }
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error instanceof GitHubFailure) throw error;
      throw new GitHubFailure('github_connection_failed', true);
    }
  }
  private async withToken<T>(
    permissions: Record<string, string>,
    work: (token: string) => Promise<T>,
    inspectSelection = false,
  ): Promise<T> {
    const minted = (await this.call(
      `/app/installations/${this.config.installationId}/access_tokens`,
      this.jwt(),
      'POST',
      {
        permissions,
        ...(inspectSelection ? {} : { repository_ids: [this.config.repositoryId] }),
      },
    )) as {
      token?: string;
      expires_at?: string;
      permissions?: Record<string, string>;
      repositories?: { id: number; full_name: string }[];
    };
    const token = minted.token;
    if (!token) throw new GitHubFailure('github_token_invalid');
    let result: T | undefined;
    let failure: unknown;
    try {
      if (
        !Number.isFinite(Date.parse(minted.expires_at ?? '')) ||
        Date.parse(minted.expires_at ?? '') <= Date.now() ||
        Date.parse(minted.expires_at ?? '') > Date.now() + 3_660_000 ||
        Object.keys(permissions).some((key) => minted.permissions?.[key] !== permissions[key]) ||
        Object.entries(minted.permissions ?? {}).some(
          ([key, value]) => permissions[key] !== value,
        ) ||
        (!inspectSelection &&
          (minted.repositories?.length !== 1 ||
            minted.repositories[0]?.id !== this.config.repositoryId ||
            minted.repositories[0]?.full_name.toLowerCase() !==
              this.config.repository.toLowerCase()))
      )
        throw new GitHubFailure('github_token_scope_invalid');
      result = await work(token);
    } catch (error) {
      failure = error;
    }
    // Revocation must still run if the caller was cancelled.
    const revoke = new InstallationClient(this.config, AbortSignal.timeout(10_000), this.request);
    await revoke.call('/installation/token', token, 'DELETE');
    if (failure) throw failure;
    return result as T;
  }
  async read<T>(path: string): Promise<T> {
    const prefix = `/repos/${this.config.repository}/`;
    if (
      (path !== prefix.slice(0, -1) && !path.startsWith(prefix)) ||
      path.includes('..') ||
      path.includes('?') ||
      path.includes('#')
    )
      throw new GitHubFailure('github_read_not_scoped');
    return this.withToken(
      { ...this.permissions(), issues: 'read' },
      async (token) => (await this.call(path, token)) as T,
    );
  }
  async list<T>(resource: 'reviews' | 'checks' | 'tasks', ref: string): Promise<T[]> {
    if (!this.config.mergePolicy) throw new GitHubFailure('merge_policy_not_configured');
    const path =
      resource === 'reviews' && /^[1-9]\d*$/.test(ref)
        ? `/pulls/${ref}/reviews`
        : resource === 'checks' && /^[0-9a-f]{40}$/.test(ref)
          ? `/commits/${ref}/check-runs`
          : resource === 'tasks' && ref === 'all'
            ? '/issues'
            : undefined;
    if (!path) throw new GitHubFailure('github_list_not_scoped');
    return this.withToken({ ...this.permissions(), issues: 'read' }, async (token) => {
      const all: T[] = [];
      for (let page = 1; page <= 5; page++) {
        const data = await this.call(
          `/repos/${this.config.repository}${path}?per_page=100&page=${page}${resource === 'tasks' ? '&state=all&labels=kind%3Atask' : resource === 'checks' ? '&filter=all' : ''}`,
          token,
        );
        const rows =
          resource === 'checks' ? (data as { check_runs: T[] }).check_runs : (data as T[]);
        if (!Array.isArray(rows)) throw new GitHubFailure('github_list_invalid');
        all.push(...rows);
        if (rows.length < 100) return all;
      }
      throw new GitHubFailure('github_list_limit_exceeded');
    });
  }
  async codeowners(commit: string): Promise<string> {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new GitHubFailure('commit_invalid');
    return this.withToken({ contents: 'read', metadata: 'read' }, async (token) => {
      const file = (await this.call(
        `/repos/${this.config.repository}/contents/.github/CODEOWNERS?ref=${commit}`,
        token,
      )) as { type: string; encoding: string; content: string; size: number };
      if (file.type !== 'file' || file.encoding !== 'base64' || file.size > 10000)
        throw new GitHubFailure('codeowners_unreadable');
      return Buffer.from(file.content, 'base64').toString('utf8');
    });
  }
  async finishTask(
    number: number,
    oldStatuses: string[],
    assertCurrent: () => Promise<void>,
  ): Promise<void> {
    if (
      !this.config.mergePolicy ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      oldStatuses.some((s) => !['status:ready', 'status:in_review'].includes(s))
    )
      throw new GitHubFailure('task_write_not_scoped');
    await this.withToken({ issues: 'write', metadata: 'read' }, async (token) => {
      const path = `/repos/${this.config.repository}/issues/${number}`;
      await assertCurrent();
      await this.call(`${path}/labels`, token, 'POST', { labels: ['status:done'] });
      for (const status of oldStatuses) {
        await assertCurrent();
        // Retried deletes must treat a label already removed as success, but not arbitrary 404s.
        const labels = (await this.call(`${path}/labels?per_page=100`, token)) as {
          name: string;
        }[];
        if (!Array.isArray(labels) || labels.length >= 100)
          throw new GitHubFailure('task_labels_unreadable');
        if (labels.some((label) => label.name === status))
          await this.call(`${path}/labels/${encodeURIComponent(status)}`, token, 'DELETE');
      }
      await assertCurrent();
      await this.call(path, token, 'PATCH', { state: 'closed', state_reason: 'completed' });
    });
  }
  async check() {
    const app = (await this.call('/app', this.jwt())) as { id: number; slug: string };
    if (String(app.id) !== this.config.appId || app.slug !== this.config.appSlug)
      throw new GitHubFailure('app_identity_mismatch');
    const installation = (await this.call(
      `/app/installations/${this.config.installationId}`,
      this.jwt(),
    )) as {
      id: number;
      app_id: number;
      repository_selection: string;
      suspended_at: unknown;
      account: { login: string };
      permissions: Record<string, string>;
      events: string[];
    };
    if (
      installation.id !== this.config.installationId ||
      installation.app_id !== app.id ||
      installation.repository_selection !== 'selected' ||
      installation.suspended_at ||
      installation.account?.login.toLowerCase() !==
        this.config.repository.split('/')[0]?.toLowerCase()
    )
      throw new GitHubFailure('installation_scope_invalid');
    if (
      Object.entries(this.permissions()).some(
        ([key, value]) => installation.permissions?.[key] !== value,
      ) ||
      Object.keys(installation.permissions ?? {}).some((key) => !(key in this.permissions())) ||
      INTAKE_EVENTS.some((event) => !installation.events?.includes(event))
    )
      throw new GitHubFailure('installation_permissions_or_events_invalid');
    const hook = (await this.call('/app/hook/config', this.jwt())) as {
      url: string;
      content_type: string;
      insecure_ssl: string;
    };
    if (
      hook.url !== this.config.webhookUrl ||
      hook.content_type !== 'json' ||
      String(hook.insecure_ssl) !== '0'
    )
      throw new GitHubFailure('webhook_configuration_mismatch');
    const repository = await this.withToken(
      { metadata: 'read' },
      async (token) => {
        const listed = (await this.call('/installation/repositories?per_page=2', token)) as {
          total_count: number;
          repositories: Repository[];
        };
        const repo = listed.repositories?.[0];
        if (
          listed.total_count !== 1 ||
          listed.repositories.length !== 1 ||
          !repo ||
          repo.id !== this.config.repositoryId ||
          repo.full_name.toLowerCase() !== this.config.repository.toLowerCase() ||
          repo.archived ||
          repo.disabled ||
          !repo.default_branch
        )
          throw new GitHubFailure('repository_selection_invalid');
        return repo;
      },
      true,
    );
    return { appId: app.id, installationId: installation.id, repository, webhookUrl: hook.url };
  }
}
