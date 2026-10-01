// Real GitHub-backed PullTool. Spec: docs/design/validator-bot.md "Pull
// Request" FSM + ADR 0010 (Review record gates in_review → approved) +
// ADR 0012 (pre-merge stale-base gate via getSyncStatus).
// Invariants:
//   - recordId is the PR node_id the validator sees. open() returns it;
//     read/close/review/merge/getSyncStatus resolve number-addressed REST
//     calls from it via GraphQL.
//   - submitReview() maps the iface's approve|request-changes|comment to
//     GitHub's APPROVE|REQUEST_CHANGES|COMMENT review events.
//   - merge() default method squash (v0 convention). getSyncStatus() wraps
//     the compare API: behind when behind_by > 0.
//   - getToken() mints a fresh installation token per call; never logged.

import { deriveGraphqlUrl, normalizeBotLogin, redact } from './githubIssueTool.js';
import type {
  BaseFileRead,
  PullAuthor,
  PullCloseArgs,
  PullDiff,
  PullMergeArgs,
  PullOpenArgs,
  PullRecord,
  PullReviewSubmitArgs,
  PullSyncStatus,
  PullTool,
  PullToolResult,
} from './pullTool.js';

export interface GithubPullToolConfig {
  getToken: () => Promise<string>;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
  // GraphQL endpoint; derived from apiBaseUrl when omitted (GHES exposes
  // GraphQL at /api/graphql, not /api/v3/graphql — see deriveGraphqlUrl).
  graphqlUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_BASE = 'https://api.github.com';

const REVIEW_EVENT: Record<PullReviewSubmitArgs['state'], string> = {
  approve: 'APPROVE',
  'request-changes': 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

interface PrApiShape {
  node_id: string;
  number: number;
  state: string;
  draft?: boolean;
  merged?: boolean;
  // GitHub REST `GET /pulls/{number}` returns the PR body markdown. ReviewAgent
  // reads `task-ref:` out of it to resolve the paired Task.
  body?: string | null;
  // PR author. REST `user.type` is `User` | `Bot` — the App is a
  // `Bot`. REST bot logins carry the `[bot]` suffix (GraphQL drops it); we
  // normalize before the App-slug comparison in BuildAgent's ownership guard.
  user?: { login?: string | null; type?: string | null } | null;
  // Head/base repo identity. A fork PR has head.repo.id !==
  // base.repo.id (or a null head.repo for a deleted fork) → cross-repository.
  // The ownership guard requires same-repo (clone/push must target the base
  // repo, not a fork carrying a colliding `sf/...` ref).
  head: { ref: string; repo?: { id?: number | null } | null };
  base: { ref: string; repo?: { id?: number | null } | null };
}

// Review-surface size cap (chars). ~120KB ≈ 30k tokens — bounds the verdict
// run's context cost on outsized diffs; the prompt carries a truncation note.
const DIFF_CHAR_CAP = 120_000;

// Base-tree file read cap (chars). Reads are a few small cited files to
// refute a false "missing" finding, not the whole tree — a tighter cap.
const BASE_FILE_CHAR_CAP = 64_000;

export class GithubPullTool implements PullTool {
  private readonly getToken: () => Promise<string>;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;
  private readonly graphqlUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GithubPullToolConfig) {
    this.getToken = config.getToken;
    this.owner = config.owner;
    this.repo = config.repo;
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.graphqlUrl = config.graphqlUrl ?? deriveGraphqlUrl(this.apiBaseUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sfac-agent',
      'Content-Type': 'application/json',
    };
  }

  private get repoPath(): string {
    return `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}`;
  }

  async open(args: PullOpenArgs): Promise<PullToolResult<PullRecord>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.repoPath}/pulls`, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({
          title: args.title,
          body: args.body,
          head: args.headBranch,
          base: args.baseBranch,
          draft: args.draft ?? false,
        }),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `open_failed:${response.status}:${await safeText(response)}` };
    }
    const pr = (await response.json()) as PrApiShape;
    return { ok: true, value: toPullRecord(pr) };
  }

  async read(recordId: string): Promise<PullToolResult<PullRecord>> {
    const numberResult = await this.resolveNumber(recordId);
    if (!numberResult.ok) return numberResult;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.repoPath}/pulls/${numberResult.value}`, {
        method: 'GET',
        headers: await this.headers(),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `read_failed:${response.status}:${await safeText(response)}` };
    }
    const pr = (await response.json()) as PrApiShape;
    return { ok: true, value: toPullRecord(pr) };
  }

  async close(args: PullCloseArgs): Promise<PullToolResult<{ recordId: string }>> {
    const numberResult = await this.resolveNumber(args.recordId);
    if (!numberResult.ok) return numberResult;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.repoPath}/pulls/${numberResult.value}`, {
        method: 'PATCH',
        headers: await this.headers(),
        body: JSON.stringify({ state: 'closed' }),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `close_failed:${response.status}:${await safeText(response)}` };
    }
    return { ok: true, value: { recordId: args.recordId } };
  }

  async submitReview(args: PullReviewSubmitArgs): Promise<PullToolResult<{ reviewId: string }>> {
    const numberResult = await this.resolveNumber(args.recordId);
    if (!numberResult.ok) return numberResult;
    // ADR 0010 adjudication output: the structured findings are embedded
    // in the Review body for audit (PullReviewSubmitArgs contract), since
    // GitHub's review API has no findings field.
    const reviewBody = renderReviewBody(args.body, args.findings);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.repoPath}/pulls/${numberResult.value}/reviews`, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ event: REVIEW_EVENT[args.state], body: reviewBody }),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `review_failed:${response.status}:${await safeText(response)}` };
    }
    const json = (await response.json()) as { node_id?: string; id?: number };
    const reviewId = json.node_id ?? (json.id !== undefined ? String(json.id) : undefined);
    if (reviewId === undefined) {
      return { ok: false, reason: 'review_failed:no_id_returned' };
    }
    return { ok: true, value: { reviewId } };
  }

  async merge(
    args: PullMergeArgs,
  ): Promise<PullToolResult<{ recordId: string; mergeSha: string }>> {
    const numberResult = await this.resolveNumber(args.recordId);
    if (!numberResult.ok) return numberResult;
    const mergeBody: Record<string, string> = { merge_method: args.method ?? 'squash' };
    if (args.commitTitle !== undefined) mergeBody.commit_title = args.commitTitle;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.repoPath}/pulls/${numberResult.value}/merge`, {
        method: 'PUT',
        headers: await this.headers(),
        body: JSON.stringify(mergeBody),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `merge_failed:${response.status}:${await safeText(response)}` };
    }
    const json = (await response.json()) as { sha: string; merged: boolean };
    if (json.merged !== true) {
      return { ok: false, reason: 'merge_failed:not_merged' };
    }
    return { ok: true, value: { recordId: args.recordId, mergeSha: json.sha } };
  }

  // Pre-merge stale-base gate (ADR 0012 item 1). Wraps the compare API:
  // GET /repos/{owner}/{repo}/compare/{base}...{head} → behind when
  // behind_by > 0.
  async getSyncStatus(recordId: string): Promise<PullToolResult<PullSyncStatus>> {
    const prResult = await this.read(recordId);
    if (!prResult.ok) return prResult;
    const { baseBranch, headBranch } = prResult.value;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.repoPath}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}`,
        { method: 'GET', headers: await this.headers() },
      );
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `sync_status_failed:${response.status}:${await safeText(response)}`,
      };
    }
    const json = (await response.json()) as { behind_by: number };
    const behindBy = json.behind_by;
    if (behindBy > 0) {
      return { ok: true, value: { recordId, status: 'behind', behindBy } };
    }
    return { ok: true, value: { recordId, status: 'current' } };
  }

  // Resolve a PR node_id → number via GraphQL (REST PR calls are
  // number-addressed).
  // Unified diff via the GitHub media type (Accept: application/vnd.github.diff).
  // Capped: a runaway diff must not blow the review brain's context — the cap
  // keeps the review surface bounded; the truncation note tells the reviewer.
  async diff(recordId: string): Promise<PullToolResult<PullDiff>> {
    const numberResult = await this.resolveNumber(recordId);
    if (!numberResult.ok) return numberResult;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/pulls/${numberResult.value}`,
        {
          method: 'GET',
          headers: { ...(await this.headers()), Accept: 'application/vnd.github.diff' },
        },
      );
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `diff_failed:${response.status}:${await safeText(response)}` };
    }
    const text = await response.text();
    const truncated = text.length > DIFF_CHAR_CAP;
    return {
      ok: true,
      value: { diff: truncated ? text.slice(0, DIFF_CHAR_CAP) : text, truncated },
    };
  }

  // Read a file at the PR's BASE ref. GitHub contents API with the
  // raw media type returns file bytes directly. A clean 404 = genuinely absent
  // at base (found:false, NOT a transport error); only network/other-non-2xx is
  // ok:false. The base ref comes from the PR record (like getSyncStatus).
  async readBaseFile(recordId: string, filePath: string): Promise<PullToolResult<BaseFileRead>> {
    const prResult = await this.read(recordId);
    if (!prResult.ok) return prResult;
    const ref = prResult.value.baseBranch;
    // Reject traversal / absolute paths: filePath is UNTRUSTED review
    // output. `encodeURIComponent` leaves `.`/`..` segments intact, so the URL
    // parser would normalize `/contents/../x` onto another REST endpoint (and a
    // directory/JSON response could be marked found:true). Only repo-relative
    // file paths are valid; anything else fails closed (→ unresolved upstream).
    if (!isSafeRepoRelativePath(filePath)) {
      return { ok: false, reason: `invalid_base_path:${redact(filePath.slice(0, 120))}` };
    }
    // Encode each segment; keep '/' literal (contents API path is hierarchical).
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.repoPath}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        {
          method: 'GET',
          headers: { ...(await this.headers()), Accept: 'application/vnd.github.raw+json' },
        },
      );
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (response.status === 404) {
      return { ok: true, value: { path: filePath, found: false, truncated: false } };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `base_file_read_failed:${response.status}:${await safeText(response)}`,
      };
    }
    const text = await response.text();
    const truncated = text.length > BASE_FILE_CHAR_CAP;
    return {
      ok: true,
      value: {
        path: filePath,
        found: true,
        content: truncated ? text.slice(0, BASE_FILE_CHAR_CAP) : text,
        truncated,
      },
    };
  }

  private async resolveNumber(recordId: string): Promise<PullToolResult<number>> {
    const query = 'query($id: ID!) { node(id: $id) { ... on PullRequest { number } } }';
    let response: Response;
    try {
      response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ query, variables: { id: recordId } }),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `resolve_number_failed:${response.status}:${await safeText(response)}`,
      };
    }
    const json = (await response.json()) as {
      data?: { node?: { number?: number } | null };
      errors?: Array<{ message: string }>;
    };
    if (json.errors !== undefined && json.errors.length > 0) {
      return { ok: false, reason: `graphql_error:${json.errors.map((e) => e.message).join(';')}` };
    }
    const number = json.data?.node?.number;
    if (number === undefined) {
      return { ok: false, reason: `pr_record_not_found:${recordId}` };
    }
    return { ok: true, value: number };
  }
}

// A repo-relative file path with no traversal: non-empty, no backslash, and no
// empty / `.` / `..` segment (which reject absolute, trailing-slash, and dot
// paths). Pre-encoded `%2e%2e` is harmless — encodeURIComponent re-encodes the
// `%`, so only literal dot segments can normalize the URL.
function isSafeRepoRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes('\\')) return false;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

function toPullRecord(pr: PrApiShape): PullRecord {
  let state: PullRecord['state'];
  if (pr.merged === true) {
    state = 'merged';
  } else if (pr.state === 'closed') {
    state = 'closed';
  } else if (pr.draft === true) {
    state = 'draft';
  } else {
    state = 'open';
  }
  return {
    recordId: pr.node_id,
    number: pr.number,
    state,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    ...(pr.body !== undefined && pr.body !== null ? { body: pr.body } : {}),
    // Ownership signals for BuildAgent's auto-revision guard.
    author: toPullAuthor(pr.user),
    isCrossRepository: isCrossRepository(pr),
  };
}

// Map REST `user` → PullAuthor. `type === 'Bot'` marks a bot
// account (a human is `User` — the substrate stamps it, not forgeable). Login is
// suffix-normalized (REST keeps `[bot]`, GraphQL drops it) so it compares to the
// configured App slug.
function toPullAuthor(user: PrApiShape['user']): PullAuthor {
  const login = user?.login ?? undefined;
  const isBot = user?.type === 'Bot';
  return login === undefined ? { isBot } : { login: normalizeBotLogin(login), isBot };
}

// Cross-repo (fork) signal. A fork PR's head repo differs from the
// base repo; a deleted-fork head repo is null. Same-repo iff both repo ids are
// present and equal. Fail closed (→ cross-repo true) on any missing id so an
// indeterminate head never reads as same-repo.
function isCrossRepository(pr: PrApiShape): boolean {
  const headRepoId = pr.head.repo?.id;
  const baseRepoId = pr.base.repo?.id;
  if (headRepoId === undefined || headRepoId === null) return true;
  if (baseRepoId === undefined || baseRepoId === null) return true;
  return headRepoId !== baseRepoId;
}

// Embed ADR 0010 findings into the Review body as a markdown table so the
// structured adjudication survives in the GitHub Review record (the API has
// no findings field). Empty/absent findings → the body unchanged.
function renderReviewBody(body: string, findings?: PullReviewSubmitArgs['findings']): string {
  if (findings === undefined || findings.length === 0) return body;
  const rows = findings.map(
    (f) =>
      `| ${f.severity} | ${f.file}:${f.line} | ${f.verdict} | ${f.claim}${f.suggestedFix !== undefined ? ` (fix: ${f.suggestedFix})` : ''} |`,
  );
  const table = [
    '',
    '### Findings',
    '| Severity | Location | Verdict | Claim |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
  return `${body}\n${table}\n`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return redact((await response.text()).slice(0, 500));
  } catch {
    return '<unreadable>';
  }
}
