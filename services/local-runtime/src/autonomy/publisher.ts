import { signAppJwt } from '../../../agents/src/auth/installationToken.js';
import type { ChangeManifest, GitMode } from './classify.js';
import { AutonomyError, requireAutonomy, requireGitObject, requireText } from './schema.js';

/**
 * Trusted publisher. Builds the exact candidate tree on GitHub through the Git Data
 * API (blobs, tree, commit, ref), proves the created commit's tree equals the tested
 * tree before any pull request exists, then opens or updates the paired PR. The
 * worker never sees the credential; the publisher never sees the worker.
 */
export interface RepositoryIdentity {
  fullName: string;
  id: number;
}
export interface TreeEntryInput {
  path: string;
  mode: Exclude<GitMode, '160000'>;
  /** Blob SHA, or null to delete the path. */
  sha: string | null;
}
export interface PullSummary {
  number: number;
  nodeId: string;
  id: number;
  headSha: string;
}
export interface GitHost {
  /** Where branches and objects are written: the fork, or the base repository itself. */
  readonly writeRepository: RepositoryIdentity;
  readonly baseRepository: RepositoryIdentity;
  createBlob(content: Buffer): Promise<string>;
  createTree(baseTree: string, entries: TreeEntryInput[]): Promise<string>;
  createCommit(tree: string, parents: string[], message: string): Promise<string>;
  getCommit(sha: string): Promise<{ sha: string; tree: string; parents: string[] }>;
  getRef(branch: string): Promise<string | null>;
  createRef(branch: string, sha: string): Promise<void>;
  /** Fast-forward only. The caller re-reads the ref afterwards; there is no server-side compare-and-swap. */
  updateRef(branch: string, sha: string): Promise<void>;
  findOpenPull(headLabel: string, base: string): Promise<PullSummary | null>;
  createPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullSummary>;
  updatePull(number: number, input: { body: string }): Promise<void>;
}
export interface PublishInput {
  /** GitHub commit the candidate was built from (the Task's pinned source commit). */
  base: string;
  /** The sandbox's base tree, when known: it must be GitHub's tree of `base`, or no candidate built on it can match. */
  baseTree?: string | null;
  candidateTree: string;
  manifest: ChangeManifest;
  blobs: Record<string, string>;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  message: string;
  /** Revision: the branch head the controller last published; the new commit continues it. */
  previousHead: string | null;
}
export interface Publication {
  branch: string;
  head: string;
  tree: string;
  pullNumber: number;
  pullNodeId: string;
  pullId: number;
  writeRepositoryId: number;
  baseRepositoryId: number;
  /** `created`, `updated` (revision) or `unchanged` (idempotent repeat or adopted after a crash). */
  outcome: 'created' | 'updated' | 'unchanged';
  /** GitHub publisher only: whether the per-publication token was revoked afterwards. */
  tokenRevoked?: boolean;
}
/**
 * A failure after the branch was written or found already written: the publication may
 * exist, so the controller records the run as uncertain for an operator, never as a clean
 * block. Failures before any write leave nothing behind and are simply retried.
 */
export class UncertainPublication extends AutonomyError {}
async function uncertainOnFailure<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UncertainPublication) throw error;
    const reason = (error as { reason?: unknown }).reason;
    throw new UncertainPublication(typeof reason === 'string' ? reason : 'publication_failed');
  }
}
const BRANCH = /^factory\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function publicationBranch(taskNumber: number, runId: string): string {
  requireAutonomy(Number.isSafeInteger(taskNumber) && taskNumber > 0, 'task_number_invalid');
  requireAutonomy(/^[0-9a-f-]{36}$/.test(runId), 'run_id_invalid');
  return `factory/task-${taskNumber}-${runId.slice(0, 8)}`;
}
export async function publishCandidate(host: GitHost, input: PublishInput): Promise<Publication> {
  requireGitObject(input.base, 'publish_base_invalid');
  requireGitObject(input.candidateTree, 'publish_tree_invalid');
  requireAutonomy(BRANCH.test(input.branch), 'publish_branch_invalid');
  requireText(input.title, 256, 'publish_title_invalid');
  requireAutonomy(
    typeof input.body === 'string' && input.body.length <= 60_000,
    'publish_body_invalid',
  );
  requireAutonomy(/^task-ref: \S+$/m.test(input.body), 'publish_body_requires_task_ref');
  // Commit messages span lines; only NUL and size are refused.
  requireAutonomy(
    typeof input.message === 'string' &&
      input.message.trim().length > 0 &&
      input.message.length <= 4000 &&
      !input.message.includes('\0'),
    'publish_message_invalid',
  );
  requireAutonomy(
    input.manifest.complete === true && input.manifest.files.length > 0,
    'publish_change_empty',
  );
  if (input.previousHead !== null)
    requireGitObject(input.previousHead, 'publish_previous_head_invalid');

  const baseCommit = await host.getCommit(input.base);
  requireAutonomy(baseCommit.sha === input.base, 'publish_base_unavailable');
  // The sandbox rebuilt the base from GitHub's archive; if its tree is not GitHub's (export-ignore,
  // attribute filters), no candidate built on it can match, and that is the reason to report.
  if (input.baseTree)
    requireAutonomy(baseCommit.tree === input.baseTree, 'publish_base_tree_mismatch');
  const expectedParent = input.previousHead ?? input.base;
  const existing = await host.getRef(input.branch);
  let head: string;
  let outcome: Publication['outcome'];
  if (existing !== null && existing !== input.previousHead) {
    // The branch exists and is not the head being continued: a publication made before
    // a crash is adopted when it carries exactly this candidate; anything else is refused.
    const published = await host.getCommit(existing);
    requireAutonomy(
      published.sha === existing &&
        published.tree === input.candidateTree &&
        published.parents[0] === expectedParent,
      'publish_branch_diverged',
    );
    head = existing;
    outcome = 'unchanged';
  } else {
    if (existing === null)
      requireAutonomy(input.previousHead === null, 'publish_branch_missing_for_revision');
    const entries: TreeEntryInput[] = [];
    for (const file of input.manifest.files) {
      if (file.oldPath !== null && file.oldPath !== file.newPath)
        entries.push({ path: file.oldPath, mode: '100644', sha: null });
      if (file.newPath === null) continue;
      const mode = file.newMode;
      requireAutonomy(mode !== null && mode !== '160000', 'publish_submodule_unsupported');
      let content: Buffer;
      if (file.binary || mode === '120000') {
        const encoded = input.blobs[file.newPath];
        requireAutonomy(typeof encoded === 'string', 'publish_blob_missing');
        content = Buffer.from(encoded, 'base64');
      } else {
        requireAutonomy(typeof file.newContent === 'string', 'publish_content_missing');
        content = Buffer.from(file.newContent, 'utf8');
      }
      entries.push({ path: file.newPath, mode, sha: await host.createBlob(content) });
    }
    const createdTree = await host.createTree(baseCommit.tree, entries);
    // Nothing is reachable yet; a mismatch here means the published content would differ from what was tested.
    requireAutonomy(createdTree === input.candidateTree, 'published_tree_mismatch');
    head = await host.createCommit(createdTree, [expectedParent], input.message);
    const created = await host.getCommit(head);
    requireAutonomy(
      created.sha === head &&
        created.tree === input.candidateTree &&
        created.parents[0] === expectedParent,
      'published_commit_mismatch',
    );
    if (existing === null) {
      await uncertainOnFailure(() => host.createRef(input.branch, head));
      outcome = 'created';
    } else {
      // existing === previousHead: the revision fast-forwards the published branch.
      await uncertainOnFailure(() => host.updateRef(input.branch, head));
      outcome = 'updated';
    }
  }
  // A branch now carries the candidate: from here every failure is an effect to reconcile.
  return uncertainOnFailure(async () => {
    requireAutonomy((await host.getRef(input.branch)) === head, 'publish_ref_not_current');
    const tree = input.candidateTree;

    // Always owner-qualified: GitHub ignores an unqualified head filter and would return
    // every open pull request against the base.
    const headLabel = `${host.writeRepository.fullName.split('/')[0]}:${input.branch}`;
    let pull = await host.findOpenPull(headLabel, input.baseBranch);
    if (pull === null) {
      requireAutonomy(outcome !== 'updated', 'publish_revision_without_pull');
      pull = await host.createPull({
        title: input.title,
        body: input.body,
        head: headLabel,
        base: input.baseBranch,
      });
    } else if (outcome !== 'unchanged') await host.updatePull(pull.number, { body: input.body });
    const current = await host.findOpenPull(headLabel, input.baseBranch);
    requireAutonomy(
      current !== null && current.number === pull.number && current.headSha === head,
      'publish_pull_head_not_current',
    );
    return {
      branch: input.branch,
      head,
      tree,
      pullNumber: pull.number,
      pullNodeId: pull.nodeId,
      pullId: pull.id,
      writeRepositoryId: host.writeRepository.id,
      baseRepositoryId: host.baseRepository.id,
      outcome,
    };
  });
}

export interface PublisherCredentials {
  appId: string;
  appPrivateKey: string;
  installationId: number;
}
export const PUBLISHER_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
} as const;
/**
 * GitHub-backed host. One installation token per publication, minted with exactly
 * the publisher permissions and restricted to the write and base repositories, and
 * revoked afterwards even on failure.
 */
export class GitHubPublisher {
  constructor(
    private readonly credentials: PublisherCredentials,
    readonly writeRepository: RepositoryIdentity,
    readonly baseRepository: RepositoryIdentity,
    private readonly signal: AbortSignal,
    private readonly request: typeof fetch = fetch,
  ) {
    for (const repository of [writeRepository, baseRepository])
      requireAutonomy(
        /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository.fullName) &&
          Number.isSafeInteger(repository.id) &&
          repository.id > 0,
        'publisher_repository_invalid',
      );
  }
  private async call(
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
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
          'User-Agent': 'software-factory-publisher',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
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
  async publish(input: PublishInput): Promise<Publication> {
    const jwt = signAppJwt(this.credentials.appId, this.credentials.appPrivateKey);
    const repositoryIds = [...new Set([this.writeRepository.id, this.baseRepository.id])];
    const minted = await this.call(
      `/app/installations/${this.credentials.installationId}/access_tokens`,
      jwt,
      'POST',
      {
        permissions: PUBLISHER_PERMISSIONS,
        repository_ids: repositoryIds,
      },
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
      'publisher_token_unavailable',
    );
    let result: Publication | undefined;
    let failure: unknown;
    try {
      const expiry = Date.parse(data.expires_at ?? '');
      requireAutonomy(
        Number.isFinite(expiry) &&
          expiry > Date.now() &&
          expiry <= Date.now() + 3_660_000 &&
          Object.entries(PUBLISHER_PERMISSIONS).every(
            ([key, value]) => data.permissions?.[key] === value,
          ) &&
          Object.keys(data.permissions ?? {}).every((key) => key in PUBLISHER_PERMISSIONS) &&
          Array.isArray(data.repositories) &&
          data.repositories.length === repositoryIds.length &&
          repositoryIds.every((id) =>
            data.repositories?.some((repository) => repository.id === id),
          ),
        'publisher_token_scope_invalid',
      );
      result = await publishCandidate(this.host(token), input);
    } catch (error) {
      failure = error;
    }
    // The publication is real even when the short-lived token could not be revoked; record both.
    let tokenRevoked = false;
    try {
      const revoked = await new GitHubPublisher(
        this.credentials,
        this.writeRepository,
        this.baseRepository,
        AbortSignal.timeout(10_000),
        this.request,
      ).call('/installation/token', token, 'DELETE');
      tokenRevoked = revoked.status === 204;
    } catch {
      tokenRevoked = false;
    }
    if (failure) throw failure;
    return { ...(result as Publication), tokenRevoked };
  }
  private host(token: string): GitHost {
    const write = `/repos/${this.writeRepository.fullName}`;
    const base = `/repos/${this.baseRepository.fullName}`;
    const expect = <T>(
      result: { status: number; json: unknown },
      statuses: number[],
      reason: string,
    ): T => {
      if (!statuses.includes(result.status)) throw new AutonomyError(reason);
      return result.json as T;
    };
    const sha = (value: unknown, reason: string): string => {
      requireGitObject(value, reason);
      return value;
    };
    const pull = (value: {
      number: number;
      node_id: string;
      id: number;
      head: { sha: string };
    }): PullSummary => ({
      number: value.number,
      nodeId: value.node_id,
      id: value.id,
      headSha: sha(value.head?.sha, 'github_pull_invalid'),
    });
    return {
      writeRepository: this.writeRepository,
      baseRepository: this.baseRepository,
      createBlob: async (content) =>
        sha(
          expect<{ sha: unknown }>(
            await this.call(`${write}/git/blobs`, token, 'POST', {
              content: content.toString('base64'),
              encoding: 'base64',
            }),
            [201],
            'github_blob_create_failed',
          ).sha,
          'github_blob_invalid',
        ),
      createTree: async (baseTree, entries) =>
        sha(
          expect<{ sha: unknown }>(
            await this.call(`${write}/git/trees`, token, 'POST', {
              base_tree: baseTree,
              tree: entries.map((entry) => ({
                path: entry.path,
                mode: entry.mode,
                type: 'blob',
                sha: entry.sha,
              })),
            }),
            [201],
            'github_tree_create_failed',
          ).sha,
          'github_tree_invalid',
        ),
      createCommit: async (tree, parents, message) =>
        sha(
          expect<{ sha: unknown }>(
            await this.call(`${write}/git/commits`, token, 'POST', { message, tree, parents }),
            [201],
            'github_commit_create_failed',
          ).sha,
          'github_commit_invalid',
        ),
      getCommit: async (commit) => {
        const data = expect<{ sha: unknown; tree: { sha: unknown }; parents: { sha: unknown }[] }>(
          await this.call(`${write}/git/commits/${commit}`, token),
          [200],
          'github_commit_unavailable',
        );
        return {
          sha: sha(data.sha, 'github_commit_invalid'),
          tree: sha(data.tree?.sha, 'github_commit_invalid'),
          parents: (data.parents ?? []).map((parent) => sha(parent.sha, 'github_commit_invalid')),
        };
      },
      getRef: async (branch) => {
        const result = await this.call(`${write}/git/ref/heads/${branch}`, token);
        if (result.status === 404) return null;
        return sha(
          expect<{ object: { sha: unknown } }>(result, [200], 'github_ref_unavailable').object?.sha,
          'github_ref_invalid',
        );
      },
      createRef: async (branch, commit) => {
        expect(
          await this.call(`${write}/git/refs`, token, 'POST', {
            ref: `refs/heads/${branch}`,
            sha: commit,
          }),
          [201],
          'github_ref_create_failed',
        );
      },
      updateRef: async (branch, commit) => {
        expect(
          await this.call(`${write}/git/refs/heads/${branch}`, token, 'PATCH', {
            sha: commit,
            force: false,
          }),
          [200],
          'github_ref_update_failed',
        );
      },
      findOpenPull: async (headLabel, baseBranch) => {
        const branch = headLabel.slice(headLabel.indexOf(':') + 1);
        const pulls = expect<
          {
            number: number;
            node_id: string;
            id: number;
            head: { sha: string; ref?: unknown; repo?: { id?: unknown } | null };
          }[]
        >(
          await this.call(
            `${base}/pulls?state=open&head=${encodeURIComponent(headLabel)}&base=${encodeURIComponent(baseBranch)}&per_page=5`,
            token,
          ),
          [200],
          'github_pull_lookup_failed',
        );
        requireAutonomy(Array.isArray(pulls), 'github_pull_lookup_failed');
        // Only a pull request whose head is exactly this branch on the write repository is ours.
        const ours = pulls.filter(
          (entry) => entry.head?.ref === branch && entry.head?.repo?.id === this.writeRepository.id,
        );
        requireAutonomy(ours.length <= 1, 'github_pull_ambiguous');
        return ours[0] ? pull(ours[0]) : null;
      },
      createPull: async (input) =>
        pull(
          expect<{ number: number; node_id: string; id: number; head: { sha: string } }>(
            await this.call(`${base}/pulls`, token, 'POST', {
              ...input,
              maintainer_can_modify: false,
              draft: false,
            }),
            [201],
            'github_pull_create_failed',
          ),
        ),
      updatePull: async (number, input) => {
        expect(
          await this.call(`${base}/pulls/${number}`, token, 'PATCH', input),
          [200],
          'github_pull_update_failed',
        );
      },
    };
  }
}
