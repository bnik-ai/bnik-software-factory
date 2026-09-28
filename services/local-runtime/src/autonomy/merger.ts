import { signAppJwt } from '../../../agents/src/auth/installationToken.js';
import type { RepositoryIdentity } from './publisher.js';
import { AutonomyError, requireAutonomy } from './schema.js';

/**
 * Merger identity (OSS-21): a GitHub App installation separate from the publisher. One
 * token per merge action, minted with exactly these permissions on the base repository
 * only and revoked afterwards. It approves and squash-merges the exact head the policy
 * admitted; it never bypasses branch protection (the App is a restricted pusher, not a
 * bypass allowance) and never pushes to the base branch directly.
 */
export const MERGER_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
} as const;
export interface MergerCredentials {
  appId: string;
  appPrivateKey: string;
  installationId: number;
}
export interface PullFacts {
  state: string;
  merged: boolean;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  mergedBy: { id: number; login: string; type: string } | null;
}
export interface MergeHost {
  readonly repository: RepositoryIdentity;
  /** Login GitHub records as the actor of this App's merges: `<slug>[bot]`. */
  readonly mergerLogin: string;
  approve(pullNumber: number, head: string, body: string): Promise<{ reviewId: number }>;
  /** Dismisses the merger's own approving review; an approval never outlives its attempt. */
  dismiss(pullNumber: number, reviewId: number, message: string): Promise<void>;
  /** Squash-merge exactly `head`; GitHub refuses when the head moved or protection is unmet. */
  merge(pullNumber: number, head: string, title: string, message: string): Promise<{ sha: string }>;
  pull(pullNumber: number): Promise<PullFacts>;
  commit(sha: string): Promise<{ sha: string; tree: string; parents: string[] }>;
}
const SHA = /^[0-9a-f]{40}$/;
function sha(value: unknown, reason: string): string {
  requireAutonomy(typeof value === 'string' && SHA.test(value), reason);
  return value;
}
function expect<T>(
  reply: { status: number; json: unknown },
  statuses: number[],
  reason: string,
): T {
  if (!statuses.includes(reply.status)) {
    // GitHub's merge refusals are distinct outcomes the controller records.
    if (reply.status === 405) throw new AutonomyError('github_merge_not_allowed');
    if (reply.status === 409) throw new AutonomyError('github_merge_head_changed');
    throw new AutonomyError(reason);
  }
  return reply.json as T;
}

export class GitHubMerger {
  /** Whether the last minted token was revoked; recorded by the caller, never fatal. */
  lastTokenRevoked: boolean | null = null;
  constructor(
    private readonly credentials: MergerCredentials,
    readonly repository: RepositoryIdentity,
    readonly appSlug: string,
    private readonly signal: AbortSignal,
    private readonly request: typeof fetch = fetch,
  ) {
    requireAutonomy(
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository.fullName) &&
        Number.isSafeInteger(repository.id) &&
        repository.id > 0,
      'merger_repository_invalid',
    );
    requireAutonomy(/^[a-z0-9][a-z0-9-]{0,38}$/.test(appSlug), 'merger_app_slug_invalid');
  }
  private async call(
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
    signal: AbortSignal = this.signal,
  ): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'software-factory-merger',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new AutonomyError('github_connection_failed');
    }
    if (response.status === 204) return { status: 204, json: undefined };
    let bytes = Buffer.alloc(0);
    if (response.body)
      for await (const chunk of response.body) {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 4 * 1024 * 1024) throw new AutonomyError('github_response_too_large');
      }
    let json: unknown = undefined;
    if (bytes.length > 0)
      try {
        json = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new AutonomyError('github_response_invalid');
      }
    return { status: response.status, json };
  }
  /** Mints one scoped token, runs `work` against a token-bound host, revokes the token. */
  async perform<T>(work: (host: MergeHost) => Promise<T>): Promise<T> {
    const jwt = signAppJwt(this.credentials.appId, this.credentials.appPrivateKey);
    const minted = await this.call(
      `/app/installations/${this.credentials.installationId}/access_tokens`,
      jwt,
      'POST',
      { permissions: MERGER_PERMISSIONS, repository_ids: [this.repository.id] },
    );
    const data = minted.json as {
      token?: string;
      expires_at?: string;
      permissions?: Record<string, string>;
      repositories?: { id: number }[];
    };
    const token = data?.token;
    requireAutonomy(
      minted.status === 201 && typeof token === 'string' && token.length > 0,
      'merger_token_unavailable',
    );
    let result: T | undefined;
    let failure: unknown;
    try {
      const expiry = Date.parse(data.expires_at ?? '');
      requireAutonomy(
        Number.isFinite(expiry) &&
          expiry > Date.now() &&
          expiry <= Date.now() + 3_660_000 &&
          Object.entries(MERGER_PERMISSIONS).every(
            ([key, value]) => data.permissions?.[key] === value,
          ) &&
          Object.keys(data.permissions ?? {}).every((key) => key in MERGER_PERMISSIONS) &&
          Array.isArray(data.repositories) &&
          data.repositories.length === 1 &&
          data.repositories[0]?.id === this.repository.id,
        'merger_token_scope_invalid',
      );
      result = await work(this.host(token));
    } catch (error) {
      failure = error;
    }
    try {
      const revoked = await this.call(
        '/installation/token',
        token,
        'DELETE',
        undefined,
        AbortSignal.timeout(10_000),
      );
      this.lastTokenRevoked = revoked.status === 204;
    } catch {
      this.lastTokenRevoked = false;
    }
    if (failure) throw failure;
    return result as T;
  }
  private host(token: string): MergeHost {
    const repo = `/repos/${this.repository.fullName}`;
    const mergerLogin = `${this.appSlug}[bot]`;
    return {
      repository: this.repository,
      mergerLogin,
      approve: async (pullNumber, head, body) => {
        const review = expect<{ id: unknown }>(
          await this.call(`${repo}/pulls/${pullNumber}/reviews`, token, 'POST', {
            commit_id: head,
            event: 'APPROVE',
            body,
          }),
          [200],
          'github_review_create_failed',
        );
        requireAutonomy(Number.isSafeInteger(review.id), 'github_review_invalid');
        return { reviewId: review.id as number };
      },
      dismiss: async (pullNumber, reviewId, message) => {
        requireAutonomy(Number.isSafeInteger(reviewId) && reviewId > 0, 'github_review_invalid');
        expect<unknown>(
          await this.call(
            `${repo}/pulls/${pullNumber}/reviews/${reviewId}/dismissals`,
            token,
            'PUT',
            {
              message,
            },
          ),
          [200],
          'github_review_dismiss_failed',
        );
      },
      merge: async (pullNumber, head, title, message) => {
        const merged = expect<{ sha: unknown; merged: unknown }>(
          await this.call(`${repo}/pulls/${pullNumber}/merge`, token, 'PUT', {
            sha: head,
            merge_method: 'squash',
            commit_title: title,
            commit_message: message,
          }),
          [200],
          'github_merge_failed',
        );
        requireAutonomy(merged.merged === true, 'github_merge_not_confirmed');
        return { sha: sha(merged.sha, 'github_merge_commit_invalid') };
      },
      pull: async (pullNumber) => {
        const pull = expect<{
          state: unknown;
          merged: unknown;
          head: { sha: unknown };
          base: { sha: unknown };
          merge_commit_sha: unknown;
          merged_at: unknown;
          merged_by: { id: unknown; login: unknown; type: unknown } | null;
        }>(await this.call(`${repo}/pulls/${pullNumber}`, token), [200], 'github_pull_unavailable');
        return {
          state: String(pull.state),
          merged: pull.merged === true,
          headSha: sha(pull.head?.sha, 'github_pull_invalid'),
          baseSha: sha(pull.base?.sha, 'github_pull_invalid'),
          mergeCommitSha:
            typeof pull.merge_commit_sha === 'string' && SHA.test(pull.merge_commit_sha)
              ? pull.merge_commit_sha
              : null,
          mergedAt: typeof pull.merged_at === 'string' ? pull.merged_at : null,
          mergedBy:
            pull.merged_by && Number.isSafeInteger(pull.merged_by.id)
              ? {
                  id: pull.merged_by.id as number,
                  login: String(pull.merged_by.login),
                  type: String(pull.merged_by.type),
                }
              : null,
        };
      },
      commit: async (commit) => {
        const data = expect<{ sha: unknown; tree: { sha: unknown }; parents: { sha: unknown }[] }>(
          await this.call(`${repo}/git/commits/${sha(commit, 'commit_invalid')}`, token),
          [200],
          'github_commit_unavailable',
        );
        return {
          sha: sha(data.sha, 'github_commit_invalid'),
          tree: sha(data.tree?.sha, 'github_commit_invalid'),
          parents: (data.parents ?? []).map((parent) => sha(parent.sha, 'github_commit_invalid')),
        };
      },
    };
  }
}
