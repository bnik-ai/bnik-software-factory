// Spec: docs/decisions/0012-review-loop-resync.md item 5 ("Activation status"
// — real `GET /compare` checker + task→PR lookup). The paired-Task path needs
// the same stale-base gate the pr:* path has.
// Invariants:
//   - READ-ONLY. The orchestrator only ever READS from substrate; mutating
//     writes belong to L3 agents (ADR 0011) or the github-app service.
//   - Two needs the orchestrator has today:
//       (1) compareBranches() — drives GithubCompareBranchSyncChecker
//           (`GET /repos/{owner}/{repo}/compare/{base}...{head}` → behind_by).
//       (2) getTaskHeadBranch() — drives the paired-Task review-trigger
//           gate. The task message carries the task recordId
//           only; the gate needs headBranch/baseBranch which live on the
//           PR the task references via its body's `pr-ref:` field.
//   - Real impl is fetch-backed (no @octokit/* deps in orchestrator package).
//     v0 boot uses InMemorySubstrateClient (test seam) when no env-driven
//     GitHub config is provided — see mainConsumer.startConsumer().
//   - The interface returns typed result envelopes ({ok:true,...} / {ok:false,
//     reason}) — the caller decides whether to deadletter / skip / proceed.
//     Throws are reserved for programmer errors (the substrate client should
//     not throw on a 404 or 5xx from GitHub; those are typed failures).

export interface CompareBranchesArgs {
  // `owner/repo` come from boot config (env), but pass them explicitly so
  // multi-repo deployments don't need a new SubstrateClient per repo.
  owner: string;
  repo: string;
  base: string;
  head: string;
}

export type CompareBranchesResult =
  | { ok: true; behindBy: number; aheadBy: number }
  | { ok: false; reason: string };

// What the orchestrator needs to apply the branch-sync gate on the paired-
// Task review-trigger (`task:in_progress→in_review`): the PR's
// headBranch/baseBranch + its recordId (so the synthetic rebase dispatch
// targets the right PR, not the task).
export interface TaskHeadBranchView {
  prRecordId: string;
  headBranch: string;
  baseBranch: string;
}

export type TaskHeadBranchResult =
  | { ok: true; value: TaskHeadBranchView }
  | { ok: false; reason: string };

export interface SubstrateClient {
  compareBranches(args: CompareBranchesArgs): Promise<CompareBranchesResult>;
  // Resolves the task's body `pr-ref:` field → PR record → its head/base
  // branches. `undefined`-shaped failures (task not found / no pr-ref /
  // PR not found) return ok:false with a typed reason.
  getTaskHeadBranch(taskRecordId: string): Promise<TaskHeadBranchResult>;
}

// In-memory client for tests + the v0 default boot. Seedable per test;
// `compareBranches` returns `current` (behindBy=0) by default; `getTaskHeadBranch`
// returns the typed failure `task_not_seeded:<id>` by default. Both behaviors
// can be overridden via the seed* helpers.
export class InMemorySubstrateClient implements SubstrateClient {
  private readonly compareByKey: Map<string, CompareBranchesResult> = new Map();
  private readonly taskByRecordId: Map<string, TaskHeadBranchResult> = new Map();
  private readonly compareCalls: CompareBranchesArgs[] = [];
  private readonly taskCalls: string[] = [];

  // Test setup: seed a specific compare result for a (base, head) pair.
  // Key encodes only base...head — owner/repo are fixed per boot.
  seedCompare(base: string, head: string, result: CompareBranchesResult): void {
    this.compareByKey.set(`${base}...${head}`, result);
  }

  // Test setup: seed a task → headBranch view (ok or typed failure).
  seedTaskHeadBranch(taskRecordId: string, result: TaskHeadBranchResult): void {
    this.taskByRecordId.set(taskRecordId, result);
  }

  async compareBranches(args: CompareBranchesArgs): Promise<CompareBranchesResult> {
    this.compareCalls.push(args);
    const result = this.compareByKey.get(`${args.base}...${args.head}`);
    if (result === undefined) {
      // Default: branch is current (behindBy=0, aheadBy=0). Mirrors the
      // AlwaysCurrentBranchSyncChecker baseline so existing tests don't
      // need to seed every compare.
      return { ok: true, behindBy: 0, aheadBy: 0 };
    }
    return result;
  }

  async getTaskHeadBranch(taskRecordId: string): Promise<TaskHeadBranchResult> {
    this.taskCalls.push(taskRecordId);
    const result = this.taskByRecordId.get(taskRecordId);
    if (result === undefined) {
      return { ok: false, reason: `task_not_seeded:${taskRecordId}` };
    }
    return result;
  }

  // Test-only inspection.
  compareCallHistory(): readonly CompareBranchesArgs[] {
    return this.compareCalls;
  }
  taskCallHistory(): readonly string[] {
    return this.taskCalls;
  }
}

// GitHub REST-backed SubstrateClient. Uses Node's global fetch (Node 20+);
// no @octokit/* dep added to the orchestrator package. Pass a `token`
// provider (closure) so the caller controls auth refresh — typically a
// PAT or an installation token minted by services/github-app.
//
// Spec for compareBranches:
//   GET /repos/{owner}/{repo}/compare/{base}...{head}
//   Response: { ahead_by: number, behind_by: number, ... }
// Spec for getTaskHeadBranch:
//   The task's body carries `pr-ref: <PR_recordId>` (ADR 0003 task linkage
//   + reviewAgent.ts:74 PR_REF_PREFIX). Substrate impl reads the issue body
//   then the PR record via GraphQL or REST. v0 wires via GraphQL `node(id)`
//   pattern (matches services/validator/src/substrateClient.ts shape).
export interface GithubSubstrateClientConfig {
  // Closure returns a fresh GitHub token. Caller is responsible for
  // refresh (installation-token cache lives in services/github-app).
  getToken: () => Promise<string> | string;
  // Optional fetch override for tests (defaults to globalThis.fetch).
  fetch?: typeof fetch;
  // Optional GraphQL/REST base URLs for GitHub Enterprise. Defaults to
  // https://api.github.com.
  apiBaseUrl?: string;
}

const DEFAULT_API_BASE_URL = 'https://api.github.com';
const PR_REF_PREFIX = 'pr-ref:';

interface GithubCompareResponse {
  ahead_by?: number;
  behind_by?: number;
}

interface GithubIssueBodyResponse {
  body?: string | null;
}

interface GithubPullResponse {
  node_id?: string;
  head?: { ref?: string };
  base?: { ref?: string };
}

export class GithubSubstrateClient implements SubstrateClient {
  private readonly getToken: () => Promise<string> | string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(config: GithubSubstrateClientConfig) {
    this.getToken = config.getToken;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  }

  async compareBranches(args: CompareBranchesArgs): Promise<CompareBranchesResult> {
    // GitHub's compare endpoint requires URL-encoding for branch names
    // that contain `/` (ADR 0008 feeder branches always do). The base...
    // head separator is literal — do NOT encode the triple-dot.
    const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(
      args.repo,
    )}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: await this.authHeaders(),
      });
    } catch (err) {
      return { ok: false, reason: `compare_fetch_failed:${asMessage(err)}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `compare_http_${response.status}` };
    }
    let body: GithubCompareResponse;
    try {
      body = (await response.json()) as GithubCompareResponse;
    } catch (err) {
      return { ok: false, reason: `compare_body_parse_failed:${asMessage(err)}` };
    }
    if (typeof body.behind_by !== 'number' || typeof body.ahead_by !== 'number') {
      return { ok: false, reason: 'compare_body_missing_counts' };
    }
    return { ok: true, behindBy: body.behind_by, aheadBy: body.ahead_by };
  }

  async getTaskHeadBranch(taskRecordId: string): Promise<TaskHeadBranchResult> {
    // Two-hop GraphQL lookup (REST has no first-class node_id endpoint):
    //   1. node(id: taskRecordId) { ... on Issue { body } } → extract `pr-ref:`
    //   2. node(id: prRecordId)   { ... on PullRequest { headRefName, baseRefName } }
    // Each hop returns a typed failure on missing/malformed data; callers
    // see one of `task_*` / `pr_ref_missing` / `pr_*` reasons.
    const taskQuery = 'query($id:ID!){node(id:$id){... on Issue{body}}}';
    const taskResult = await this.graphql<{ node: { body?: string } | null }>(taskQuery, {
      id: taskRecordId,
    });
    if (!taskResult.ok) {
      return { ok: false, reason: `task_fetch_failed:${taskResult.reason}` };
    }
    const body = taskResult.value.node?.body;
    if (typeof body !== 'string' || body.length === 0) {
      return { ok: false, reason: `task_body_missing:${taskRecordId}` };
    }
    const prRecordId = extractPrRefFromBody(body);
    if (prRecordId === undefined) {
      return { ok: false, reason: `pr_ref_missing:${taskRecordId}` };
    }
    const prQuery = 'query($id:ID!){node(id:$id){... on PullRequest{headRefName baseRefName}}}';
    const prResult = await this.graphql<{
      node: { headRefName?: string; baseRefName?: string } | null;
    }>(prQuery, { id: prRecordId });
    if (!prResult.ok) {
      return { ok: false, reason: `pr_fetch_failed:${prResult.reason}` };
    }
    const headRefName = prResult.value.node?.headRefName;
    const baseRefName = prResult.value.node?.baseRefName;
    if (typeof headRefName !== 'string' || headRefName.length === 0) {
      return { ok: false, reason: `pr_head_ref_missing:${prRecordId}` };
    }
    if (typeof baseRefName !== 'string' || baseRefName.length === 0) {
      return { ok: false, reason: `pr_base_ref_missing:${prRecordId}` };
    }
    return {
      ok: true,
      value: { prRecordId, headBranch: headRefName, baseBranch: baseRefName },
    };
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/graphql`, {
        method: 'POST',
        headers: { ...(await this.authHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      return { ok: false, reason: `graphql_fetch_failed:${asMessage(err)}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `graphql_http_${response.status}` };
    }
    let parsed: { data?: T; errors?: ReadonlyArray<{ message: string }> };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch (err) {
      return { ok: false, reason: `graphql_body_parse_failed:${asMessage(err)}` };
    }
    if (parsed.errors !== undefined && parsed.errors.length > 0) {
      return { ok: false, reason: `graphql_errors:${parsed.errors[0]?.message}` };
    }
    if (parsed.data === undefined) {
      return { ok: false, reason: 'graphql_data_missing' };
    }
    return { ok: true, value: parsed.data };
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    };
  }
}

// Re-exported for the v0 paired-Task path stub in tests; matches the
// reviewAgent's PR_REF_PREFIX so the body parsing rule is single-sourced
// at the spec level (the agent and the orchestrator agree on the format).
// NEWEST backlink wins: a replacement BuildAgent run APPENDS a
// second `pr-ref:` line, so the LAST line is the active PR — the branch-sync
// gate must check the same PR ReviewAgent claims (reviewAgent.extractPrRef
// uses the same newest-wins rule).
export function extractPrRefFromBody(body: string): string | undefined {
  let newest: string | undefined;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(PR_REF_PREFIX)) continue;
    const ref = trimmed.slice(PR_REF_PREFIX.length).trim();
    if (ref.length > 0) newest = ref;
  }
  return newest;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
