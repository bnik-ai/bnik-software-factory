// Real GitHub-backed IssueTool. Spec: docs/design/validator-bot.md
// (substrate label primitives) + ADR 0009 §D (structural-comment
// attribution `<!-- sf:structural sf:agent=<role> run=<run> -->`).
// Invariants:
//   - recordId is the GitHub Issue node_id the validator sees. read()
//     resolves it via the GraphQL node() interface; create() returns the
//     node_id of the new issue so downstream agents can address it.
//   - Label writes are the canonical substrate-state transitions
//     (applyLabel/removeLabel → REST labels API).
//   - structural comments/creates prepend the ADR 0009 §D HTML marker so
//     the validator can attribute the action to a specific agent run and
//     exempt it from the agent-comment hard-reject (carve-out matches the
//     leading sf:structural token).
//   - getToken() mints a fresh installation access token per call (caller
//     injects it; this package never reads the App key directly).

import type {
  IssueCloseArgs,
  IssueCommentArgs,
  IssueCreateArgs,
  IssueLabelArgs,
  IssueRecord,
  IssueTool,
  IssueToolResult,
  ListedComment,
} from './issueTool.js';

export interface GithubIssueToolConfig {
  getToken: () => Promise<string>;
  // owner/repo of the *home* repo this tool reads/labels against. create()
  // may target a different repo (IssueCreateArgs.repo, the PlannerAgent
  // cross-repo fan-out), parsed as 'owner/repo'.
  owner: string;
  repo: string;
  apiBaseUrl?: string;
  // GraphQL endpoint. Defaults are derived from apiBaseUrl (github.com →
  // <base>/graphql; GHES REST root .../api/v3 → .../api/graphql, since GHES
  // exposes GraphQL at /api/graphql, NOT /api/v3/graphql). Override here for
  // non-standard topologies.
  graphqlUrl?: string;
  // Injected for tests; defaults to global fetch (native in Node 20+).
  fetchImpl?: typeof fetch;
  // App slug (GITHUB_APP_SLUG, e.g. example-factory). The ONLY author whose
  // structural markers listComments trusts: PR
  // comments are user-writable, so a marker from any other author is forgeable
  // and must not drive the revision loop. When unset, the Bot-author floor
  // still blocks human forgery (see listComments). GraphQL Bot logins drop the
  // `[bot]` suffix that REST/webhook logins carry, so this is matched suffix-normalized.
  appBotLogin?: string;
}

const DEFAULT_API_BASE = 'https://api.github.com';

// Derive the GraphQL endpoint from a REST base. github.com: <base>/graphql.
// GHES exposes REST at <host>/api/v3 but GraphQL at <host>/api/graphql, so
// the trailing /v3 is dropped before appending /graphql.
export function deriveGraphqlUrl(apiBaseUrl: string): string {
  const base = apiBaseUrl.replace(/\/+$/, '');
  if (base.endsWith('/api/v3')) {
    return `${base.slice(0, -'/v3'.length)}/graphql`;
  }
  return `${base}/graphql`;
}

interface GraphqlIssueNode {
  number: number;
  title: string;
  body: string | null;
  state: string;
  // Optional: a non-null node whose inline fragments matched nothing (a
  // non-Issue/PR node id) comes back WITHOUT these fields.
  labels?: { nodes: Array<{ name: string }> };
}

// ADR 0009 §D structural marker. Prepended to a comment/issue body so the
// validator attributes the action to a run and exempts it from the
// agent-comment hard-reject. NB: must lead the body (carve-out matches the
// leading token).
function structuralMarker(structural: { role: string; run: string; verdict?: string }): string {
  const verdictAttr = structural.verdict !== undefined ? ` verdict=${structural.verdict}` : '';
  return `<!-- sf:structural sf:agent=${structural.role} run=${structural.run}${verdictAttr} -->`;
}

// Parse the ADR 0009 §D structural marker off a comment body's leading HTML
// comment: the inverse of structuralMarker(). Returns undefined for
// a non-structural comment (no leading marker / missing agent or run). The
// optional `verdict=` attribute carries the review verdict the marker stamped.
function parseStructuralMarker(
  body: string,
): { role: string; run: string; verdict?: string } | undefined {
  const match = body.match(
    /<!--\s*sf:structural\s+sf:agent=(\S+)\s+run=(\S+?)(?:\s+verdict=(\S+))?\s*-->/,
  );
  if (match === null) return undefined;
  const role = match[1];
  const run = match[2];
  if (role === undefined || run === undefined) return undefined;
  return match[3] === undefined ? { role, run } : { role, run, verdict: match[3] };
}

// Normalize a GitHub login for App-bot comparison: lowercase + drop a trailing
// `[bot]`. GraphQL Actor logins for a GitHub App lack the `[bot]` suffix that
// webhook senders carry, so the config slug and the queried author login
// are normalized to the same form before matching.
export function normalizeBotLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, '');
}

export class GithubIssueTool implements IssueTool {
  private readonly getToken: () => Promise<string>;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;
  private readonly graphqlUrl: string;
  private readonly fetchImpl: typeof fetch;
  // Suffix-normalized App login (or undefined); see GithubIssueToolConfig.
  private readonly appBotLogin: string | undefined;

  constructor(config: GithubIssueToolConfig) {
    this.getToken = config.getToken;
    this.owner = config.owner;
    this.repo = config.repo;
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.graphqlUrl = config.graphqlUrl ?? deriveGraphqlUrl(this.apiBaseUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.appBotLogin =
      config.appBotLogin === undefined ? undefined : normalizeBotLogin(config.appBotLogin);
  }

  private async restHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sfac-agent',
      'Content-Type': 'application/json',
    };
  }

  // GraphQL node() resolution of an Issue OR PullRequest by node_id. PR nodes
  // are type `PullRequest`, not `Issue` — without its own inline fragment a PR
  // node matches nothing and the fields come back null (the claim guard reads
  // PR labels through this tool; resolveNumber() carries the same PR fragment).
  async read(recordId: string): Promise<IssueToolResult<IssueRecord>> {
    const query = `query($id: ID!) {
      node(id: $id) {
        ... on Issue {
          number
          title
          body
          state
          labels(first: 50) { nodes { name } }
        }
        ... on PullRequest {
          number
          title
          body
          state
          labels(first: 50) { nodes { name } }
        }
      }
    }`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers: await this.restHeaders(),
        body: JSON.stringify({ query, variables: { id: recordId } }),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `read_failed:${response.status}:${await safeText(response)}` };
    }
    const json = (await response.json()) as {
      data?: { node?: GraphqlIssueNode | null };
      errors?: Array<{ message: string }>;
    };
    if (json.errors !== undefined && json.errors.length > 0) {
      return { ok: false, reason: `graphql_error:${json.errors.map((e) => e.message).join(';')}` };
    }
    const node = json.data?.node;
    // A non-null node MISSING the fragment fields is a non-Issue/PR node (no
    // inline fragment matched) — typed not-found, never a labels.nodes throw.
    if (node === undefined || node === null || node.labels === undefined) {
      return { ok: false, reason: `record_not_found:${recordId}` };
    }
    return {
      ok: true,
      value: {
        recordId,
        labels: node.labels.nodes.map((label) => label.name),
        body: node.body ?? '',
      },
    };
  }

  async create(
    args: IssueCreateArgs,
  ): Promise<IssueToolResult<{ recordId: string; number: number }>> {
    const [owner, repo] = parseRepo(args.repo);
    if (owner === undefined || repo === undefined) {
      return { ok: false, reason: `invalid_repo:${args.repo}` };
    }
    const body =
      args.structural !== undefined
        ? `${structuralMarker(args.structural)}\n\n${args.body}`
        : args.body;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: await this.restHeaders(),
        body: JSON.stringify({ title: args.title, body, labels: [...args.labels] }),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `create_failed:${response.status}:${await safeText(response)}` };
    }
    const json = (await response.json()) as { node_id: string; number: number };
    return { ok: true, value: { recordId: json.node_id, number: json.number } };
  }

  // Comment via GraphQL addComment(subjectId) so the node_id recordId is
  // used directly (no number round-trip). Structural marker leads the body.
  async comment(args: IssueCommentArgs): Promise<IssueToolResult<{ commentId: string }>> {
    const body =
      args.structural !== undefined
        ? `${structuralMarker(args.structural)}\n\n${args.body}`
        : args.body;
    const mutation = `mutation($subjectId: ID!, $body: String!) {
      addComment(input: { subjectId: $subjectId, body: $body }) {
        commentEdge { node { id } }
      }
    }`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers: await this.restHeaders(),
        body: JSON.stringify({ query: mutation, variables: { subjectId: args.recordId, body } }),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `comment_failed:${response.status}:${await safeText(response)}` };
    }
    const json = (await response.json()) as {
      data?: { addComment?: { commentEdge?: { node?: { id: string } } } };
      errors?: Array<{ message: string }>;
    };
    if (json.errors !== undefined && json.errors.length > 0) {
      return { ok: false, reason: `graphql_error:${json.errors.map((e) => e.message).join(';')}` };
    }
    const commentId = json.data?.addComment?.commentEdge?.node?.id;
    if (commentId === undefined) {
      return { ok: false, reason: 'comment_failed:no_id_returned' };
    }
    return { ok: true, value: { commentId } };
  }

  // Label writes resolve the issue number from the node_id, then hit the
  // REST labels API (the GraphQL label mutations require label *ids*, so
  // REST-by-name is the simpler canonical path).
  async applyLabel(
    args: IssueLabelArgs,
  ): Promise<IssueToolResult<{ recordId: string; label: string }>> {
    const numberResult = await this.resolveNumber(args.recordId);
    if (!numberResult.ok) return numberResult;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues/${numberResult.value}/labels`,
        {
          method: 'POST',
          headers: await this.restHeaders(),
          body: JSON.stringify({ labels: [args.label] }),
        },
      );
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `apply_label_failed:${response.status}:${await safeText(response)}`,
      };
    }
    return { ok: true, value: { recordId: args.recordId, label: args.label } };
  }

  async removeLabel(
    args: IssueLabelArgs,
  ): Promise<IssueToolResult<{ recordId: string; label: string }>> {
    const numberResult = await this.resolveNumber(args.recordId);
    if (!numberResult.ok) return numberResult;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues/${numberResult.value}/labels/${encodeURIComponent(args.label)}`,
        { method: 'DELETE', headers: await this.restHeaders() },
      );
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    // DELETE returns 200 with the remaining labels; a 404 means the label
    // was already absent — idempotent success.
    if (!response.ok && response.status !== 404) {
      return {
        ok: false,
        reason: `remove_label_failed:${response.status}:${await safeText(response)}`,
      };
    }
    return { ok: true, value: { recordId: args.recordId, label: args.label } };
  }

  // Close the issue with a GitHub `state_reason`. REST PATCH
  // /issues/{number} with state=closed + state_reason. Idempotent: GitHub
  // returns 200 when closing an already-closed issue, so a re-delivered
  // bookkeeping run is a no-op success.
  async close(args: IssueCloseArgs): Promise<IssueToolResult<{ recordId: string }>> {
    const numberResult = await this.resolveNumber(args.recordId);
    if (!numberResult.ok) return numberResult;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues/${numberResult.value}`,
        {
          method: 'PATCH',
          headers: await this.restHeaders(),
          body: JSON.stringify({ state: 'closed', state_reason: args.reason }),
        },
      );
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `close_failed:${response.status}:${await safeText(response)}` };
    }
    return { ok: true, value: { recordId: args.recordId } };
  }

  // Append a single line to the record body (the `pr-ref:` Task→PR backlink
  // write). read() handles Issue AND PullRequest
  // nodes; the write goes through REST PATCH /repos/{owner}/{repo}/issues/
  // {number} (a PR is an Issue in the REST issues namespace, same as the
  // labels API). Idempotent: the exact line already present → ok, no write.
  async appendToBody(
    recordId: string,
    line: string,
  ): Promise<IssueToolResult<{ recordId: string }>> {
    const current = await this.read(recordId);
    if (!current.ok) return current;
    if (current.value.body.split('\n').includes(line)) {
      return { ok: true, value: { recordId } };
    }
    const numberResult = await this.resolveNumber(recordId);
    if (!numberResult.ok) return numberResult;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues/${numberResult.value}`,
        {
          method: 'PATCH',
          headers: await this.restHeaders(),
          body: JSON.stringify({ body: `${current.value.body}\n${line}` }),
        },
      );
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `append_to_body_failed:${response.status}:${await safeText(response)}`,
      };
    }
    return { ok: true, value: { recordId } };
  }

  // List a record's comments oldest→newest. GraphQL comments(last:
  // 100) over the Issue/PullRequest node; the ADR 0009 §D structural marker is
  // parsed off each leading HTML comment into the `structural` field so the
  // revision loop can filter ReviewAgent `request-changes` rounds without
  // re-deriving the marker grammar. v0 cap: newest 100 (no pagination) — far above
  // any realistic per-PR review-round count; the budget is bounded long before.
  //
  // SECURITY: PR/issue comments are user-writable, so a structural
  // marker is trusted ONLY from the App bot. GitHub stamps author.__typename
  // from the authenticated identity — a human is a `User`, never a `Bot` — so a
  // Bot-author floor blocks all human forgery; when appBotLogin is configured we
  // additionally require the login to match, excluding any OTHER installed App.
  // A marker from a non-Bot or mismatched author is dropped (the comment body is
  // still returned, just without the trusted `structural` field).
  async listComments(recordId: string): Promise<IssueToolResult<ReadonlyArray<ListedComment>>> {
    // comments(last:100): the revision loop needs the NEWEST request-changes
    // marker; first:100 returns the OLDEST comments, so on a PR with >100
    // comments the current findings fall off the page → build_agent_revision_no_findings
    // or revising against stale findings. last:100 returns the most-recent page (oldest-first
    // within it), the order the caller scans.
    const query = `query($id: ID!) {
      node(id: $id) {
        ... on Issue { comments(last: 100) { nodes { id body author { __typename login } } } }
        ... on PullRequest { comments(last: 100) { nodes { id body author { __typename login } } } }
      }
    }`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers: await this.restHeaders(),
        body: JSON.stringify({ query, variables: { id: recordId } }),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `list_comments_failed:${response.status}:${await safeText(response)}`,
      };
    }
    const json = (await response.json()) as {
      data?: {
        node?: {
          comments?: {
            nodes?: Array<{
              id: string;
              body: string | null;
              author?: { __typename?: string; login?: string } | null;
            }>;
          };
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    if (json.errors !== undefined && json.errors.length > 0) {
      return { ok: false, reason: `graphql_error:${json.errors.map((e) => e.message).join(';')}` };
    }
    const node = json.data?.node;
    if (node === undefined || node === null || node.comments === undefined) {
      return { ok: false, reason: `record_not_found:${recordId}` };
    }
    const listed: ListedComment[] = (node.comments.nodes ?? []).map((comment) => {
      const body = comment.body ?? '';
      // Trust a structural marker only from the App bot (see method header).
      const structural = this.isTrustedMarkerAuthor(comment.author)
        ? parseStructuralMarker(body)
        : undefined;
      return structural === undefined
        ? { commentId: comment.id, body }
        : { commentId: comment.id, body, structural };
    });
    return { ok: true, value: listed };
  }

  // A structural marker is trusted only from the App bot: require a
  // Bot author (blocks human `User` forgery) and, when appBotLogin is set, a
  // login match (excludes any other installed App). Suffix-normalized (normalizeBotLogin).
  private isTrustedMarkerAuthor(
    author: { __typename?: string; login?: string } | null | undefined,
  ): boolean {
    if (author?.__typename !== 'Bot') return false;
    if (this.appBotLogin === undefined) return true;
    return author.login !== undefined && normalizeBotLogin(author.login) === this.appBotLogin;
  }

  // Resolve an Issue/PullRequest node_id → number via GraphQL (labels API is
  // REST and number-addressed). PullRequest is included because a PR is an
  // Issue in GitHub's REST labels namespace (`/issues/{number}/labels` accepts
  // PR numbers); the structural-review path applies status:* labels
  // to PR node_ids, whose GraphQL node type is PullRequest, not Issue. Without
  // the PullRequest fragment the `... on Issue` query returns no number and the
  // label write fails record_not_found.
  private async resolveNumber(recordId: string): Promise<IssueToolResult<number>> {
    const query =
      'query($id: ID!) { node(id: $id) { ... on Issue { number } ... on PullRequest { number } } }';
    let response: Response;
    try {
      response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers: await this.restHeaders(),
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
      return { ok: false, reason: `record_not_found:${recordId}` };
    }
    return { ok: true, value: number };
  }
}

function parseRepo(slug: string): [string | undefined, string | undefined] {
  const parts = slug.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return [undefined, undefined];
  }
  return [parts[0], parts[1]];
}

// Read a response body for an error message without throwing.
async function safeText(response: Response): Promise<string> {
  try {
    return redact((await response.text()).slice(0, 500));
  } catch {
    return '<unreadable>';
  }
}

// Redact anything that looks like a GitHub token from error strings — the
// installation token must never surface in logs/thrown reasons.
export function redact(input: string): string {
  return input
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***')
    .replace(/x-access-token:[^@\s/]+/g, 'x-access-token:***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/token\s+[A-Za-z0-9._-]{20,}/g, 'token ***');
}
