// / issue #164). Implements the SubstrateClient interface
// (services/validator/src/substrateClient.ts) against GitHub's GraphQL API so
// the transition resolver can re-read a record's CURRENT label set at decision
// time (validator-bot.md:292 "canonical state is always re-read from the
// substrate"). Replaces the InMemorySubstrateClient that caused
// issues.labeled events to dead-letter as applied_label_no_longer_present.
//
// Auth: an installation token minted from the installation id threaded off the
// webhook (Part 1). The client is PER-MESSAGE constructed via
// createGithubSubstrateClient({ env, installationId }) — the installation id
// varies per delivery, so a single boot-time client can't serve every record.
// The minted token is cached for the client's (per-message) lifetime.
//
// Scope of this client: getCurrentLabels + getIssue + getStructuralMarkers
// (the resolver's issue-event + actor paths), and the review-loop surface
// getReviewsForPr + getPullRequest (issue #170) the validator's review-loop
// assertions consume to enforce ADR 0010 model-independence on a native
// `pr:in_review→approved`. All reads share one GraphQL transport (queryNode);
// a missing/non-matching node maps to [] (getReviewsForPr) / undefined
// (getPullRequest) — the documented review-loop posture (an unseen PR is an
// upstream resolver gap, not a violation).
//
// Invariants:
//   - READ-ONLY. No mutations (the mutating substrate lives in services/
//     github-app).
//   - SECURITY: the installation token / App JWT / PEM MUST NEVER be logged or
//     surface in a thrown error. Errors carry only the recordId + HTTP status.
//   - fetch is dependency-injected for tests; CI MUST NOT reach api.github.com.
//   - A missing/non-Issue node (404 / null `node`) maps to undefined for
//     getIssue and [] for getCurrentLabels (the resolver treats an absent
//     record as "label no longer present" and defers — the correct posture).

import { type MintedToken, mintInstallationToken, signAppJwt } from './installationToken.js';
import type {
  IssueView,
  MarkerSurfaces,
  PrView,
  ReviewView,
  SubstrateClient,
} from './substrateClient.js';

const DEFAULT_API_BASE_URL = 'https://api.github.com';
// Mint a fresh token this many ms before GitHub's expiry so an in-flight
// GraphQL call can't have it expire mid-request.
const DEFAULT_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export interface GithubSubstrateClientEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

export interface CreateGithubSubstrateClientConfig {
  env: GithubSubstrateClientEnv;
  installationId: number;
  // Injected for tests; defaults to global fetch (native Node 20+).
  fetch?: typeof fetch;
  // api.github.com override (GHES).
  apiBaseUrl?: string;
  // Date.now() override for deterministic cache tests.
  clock?: () => number;
  // Override of the 5-minute safety margin (ms).
  safetyMarginMs?: number;
}

// GraphQL Issue node shape the validator reads.
interface IssueNode {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  labels?: { nodes?: ReadonlyArray<{ name?: string } | null> | null } | null;
}

// ADR 0009 §D marker-surface shape: issue body + the most recent structural
// comments. comments(last:N) returns the N newest comments oldest-first,
// which is exactly the order MarkerSurfaces.comments expects (the resolver
// scans newest-first). N=20 is ample headroom — the agent posts ONE
// structural marker per status transition, and only the most recent matters;
// 20 covers a record's recent activity without paginating.
interface MarkerNode {
  body?: string | null;
  // The record (issue/PR) author — authenticates the body marker. __typename
  // distinguishes Bot authors (GraphQL omits their `[bot]` suffix).
  author?: { login?: string | null; __typename?: string | null } | null;
  comments?: {
    nodes?: ReadonlyArray<{
      body?: string | null;
      author?: { login?: string | null; __typename?: string | null } | null;
    } | null> | null;
  } | null;
}

const RECENT_COMMENTS_PAGE = 20;

// labels(first:100) — GitHub's GraphQL per-connection page maximum. An SF
// record carries one kind:* + one status:* + a handful of area/priority
// labels (far under 100), and the resolver only needs the status:* labels to
// derive fromState; 100 guarantees no status:* label is truncated for any
// realistic issue. (A paginated read would be over-engineering for the SF
// label cardinality; if a record ever exceeds 100 labels, that itself
// violates the substrate's single-status invariant and should fail loudly.)
// Both Issue and PullRequest node IDs flow through here (pr/pull_request_review
// events carry PullRequest node IDs). PullRequest is a distinct GraphQL type, so
// it needs its own inline fragment — without it, PR nodes match nothing and the
// fields come back null. (codex PR #152)
const ISSUE_NODE_QUERY =
  'query($id:ID!){node(id:$id){... on Issue{number title body state labels(first:100){nodes{name}}} ... on PullRequest{number title body state labels(first:100){nodes{name}}}}}';

// Marker surfaces query: the body + the N most recent comments, for Issue AND
// PullRequest nodes. Used by the actor resolver to recover the agent behind an
// App-sent transition from the most recent `sf:agent=<role@model>` structural
// marker (ADR 0009 §D).
// Each surface carries `author{login}` so the resolver can reject markers NOT
// posted by the SF App (comments/bodies are human-writable → forgeable). (codex
// PR #152)
const MARKER_NODE_QUERY = `query($id:ID!){node(id:$id){... on Issue{body author{login __typename} comments(last:${RECENT_COMMENTS_PAGE}){nodes{body author{login __typename}}}} ... on PullRequest{body author{login __typename} comments(last:${RECENT_COMMENTS_PAGE}){nodes{body author{login __typename}}}}}}`;

// ADR 0010 review-loop surface. getReviewsForPr reads the PR's native Reviews
// so the assertion can find the ruling `approved` Review and parse its
// reviewer/adjudicator `sf:agent=review@<model>` structural stamps (carried in
// the review body — review-agent.md §3+§6). reviews(last:100) returns the
// MOST-RECENT page (chronological within it, oldest-first), so the terminal
// review findRulingApprovedReview scans for (from the end) is always present:
// first:100 would drop the ruling approval on a >100-review PR, flagging a
// valid approval or passing on a stale earlier one. 100 is GitHub's
// per-connection page max and far exceeds any realistic round count (a
// converged loop is a handful of changes_requested + one approved). Only
// APPROVED / CHANGES_REQUESTED states map to ReviewView's union — COMMENTED /
// DISMISSED / PENDING are not merge-gating and are dropped.
const PR_REVIEWS_QUERY =
  'query($id:ID!){node(id:$id){... on PullRequest{reviews(last:100){nodes{id state body}}}}}';

// ADR 0008 §2 / ADR 0009 §2: the author's model is on the PR head. headRefName
// is the `sf/<task>/<run>/<role>@<model>` feeder branch (parseBranchRef);
// commits(last:1) is the head commit whose `SF-Agent: <role>@<model>` trailer
// is the fallback when the ref isn't an SF feeder branch (human-opened PR).
const PR_HEAD_QUERY =
  'query($id:ID!){node(id:$id){... on PullRequest{headRefName commits(last:1){nodes{commit{message}}}}}}';

// GraphQL PullRequest.reviews node shape the validator reads.
interface ReviewsNode {
  reviews?: {
    nodes?: ReadonlyArray<{ id?: string; state?: string; body?: string | null } | null> | null;
  } | null;
}

// GraphQL PullRequest head shape: head branch name + head commit message.
interface PullRequestHeadNode {
  headRefName?: string | null;
  commits?: {
    nodes?: ReadonlyArray<{ commit?: { message?: string | null } | null } | null> | null;
  } | null;
}

// Map a GraphQL PullRequestReviewState to ReviewView's narrow union. Only the
// two merge-relevant states survive; everything else (COMMENTED, DISMISSED,
// PENDING) is dropped — those never gate `pr:in_review→approved`.
function mapReviewState(state: string | undefined): ReviewView['state'] | undefined {
  if (state === 'APPROVED') return 'approved';
  if (state === 'CHANGES_REQUESTED') return 'changes_requested';
  return undefined;
}

// GraphQL Bot logins come back WITHOUT the `[bot]` suffix (`example-factory`,
// __typename=Bot), while the App-bot trust set (appBotLoginsFromEnv) holds the
// REST/webhook form (`example-factory[bot]`). Normalize at the substrate boundary
// — keyed on __typename so only genuine Bot authors gain the suffix (a human
// account can never become `[bot]`-suffixed, preserving the forgery check).
// Found live in M5: the ReviewAgent claim marker was treated as forged and the
// pr:open→in_review transition dead-lettered as actor_unresolved_app_sender.
function normalizeAuthorLogin(
  author: { login?: string | null; __typename?: string | null } | null | undefined,
): string | undefined {
  const login = author?.login;
  if (typeof login !== 'string') return undefined;
  if (author?.__typename === 'Bot' && !login.endsWith('[bot]')) return `${login}[bot]`;
  return login;
}

export class GithubSubstrateClient implements SubstrateClient {
  private readonly env: GithubSubstrateClientEnv;
  private readonly installationId: number;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly clock: () => number;
  private readonly safetyMarginMs: number;
  // Per-client (per-message) token cache. Invalidated by the safety margin.
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(config: CreateGithubSubstrateClientConfig) {
    const appId = config.env.GITHUB_APP_ID;
    const pemKey = config.env.GITHUB_APP_PRIVATE_KEY;
    if (appId === undefined || appId === '' || pemKey === undefined || pemKey === '') {
      throw new Error('GithubSubstrateClient requires GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY');
    }
    this.env = config.env;
    this.installationId = config.installationId;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.clock = config.clock ?? Date.now;
    this.safetyMarginMs = config.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  }

  async getCurrentLabels(recordId: string): Promise<readonly string[]> {
    const issue = await this.getIssue(recordId);
    return issue?.labels ?? [];
  }

  async getIssue(recordId: string): Promise<IssueView | undefined> {
    const node = await this.queryNode<IssueNode>(ISSUE_NODE_QUERY, recordId);
    if (node === undefined) return undefined;
    const labels: string[] = [];
    for (const label of node.labels?.nodes ?? []) {
      const name = label?.name;
      if (typeof name === 'string') labels.push(name);
    }
    return { body: node.body ?? '', labels };
  }

  // ADR 0009 §D: read the issue body + recent structural comments so the
  // actor resolver can recover the agent behind an App-sent transition.
  // comments(last:N) yields oldest-first — the order MarkerSurfaces expects.
  async getStructuralMarkers(recordId: string): Promise<MarkerSurfaces | undefined> {
    const node = await this.queryNode<MarkerNode>(MARKER_NODE_QUERY, recordId);
    if (node === undefined) return undefined;
    const comments: { body: string; authorLogin?: string }[] = [];
    for (const comment of node.comments?.nodes ?? []) {
      const body = comment?.body;
      if (typeof body !== 'string') continue;
      const authorLogin = normalizeAuthorLogin(comment?.author);
      comments.push(authorLogin !== undefined ? { body, authorLogin } : { body });
    }
    const bodyAuthorLogin = normalizeAuthorLogin(node.author);
    return {
      body: node.body ?? '',
      ...(typeof bodyAuthorLogin === 'string' ? { bodyAuthorLogin } : {}),
      comments,
    };
  }

  // ADR 0010 review-loop assertion surface (issue #170). Reads the PR's native
  // Reviews; maps each merge-relevant review to a ReviewView whose body carries
  // the reviewer/adjudicator stamps. An absent/non-PR node → [] (the PR has no
  // readable Reviews, the documented "approved-without-review" fail-closed input).
  async getReviewsForPr(prRecordId: string): Promise<readonly ReviewView[]> {
    const node = await this.queryNode<ReviewsNode>(PR_REVIEWS_QUERY, prRecordId);
    if (node === undefined) return [];
    const reviews: ReviewView[] = [];
    for (const review of node.reviews?.nodes ?? []) {
      const recordId = review?.id;
      const state = mapReviewState(review?.state);
      if (typeof recordId !== 'string' || state === undefined) continue;
      reviews.push({ recordId, state, body: review?.body ?? '' });
    }
    return reviews;
  }

  // ADR 0008 §2 / ADR 0009 §2 (issue #170): recover the author-model source
  // from the PR head — branch name + head commit message. Undefined for an
  // absent/non-PR node (PR unseen by the substrate → author model unknown →
  // the assertion stays silent on author-relative inequalities, same posture
  // as getIssue). headRef / headCommitMessage are each optional per PrView.
  async getPullRequest(prRecordId: string): Promise<PrView | undefined> {
    const node = await this.queryNode<PullRequestHeadNode>(PR_HEAD_QUERY, prRecordId);
    if (node === undefined) return undefined;
    const headRef = node.headRefName;
    const headCommitMessage = node.commits?.nodes?.[0]?.commit?.message;
    return {
      ...(typeof headRef === 'string' ? { headRef } : {}),
      ...(typeof headCommitMessage === 'string' ? { headCommitMessage } : {}),
    };
  }

  // Runs a node($id) GraphQL query and returns the typed node, or undefined
  // for a missing/non-Issue node (404 / null `node` / NOT_FOUND — the record
  // is absent from the substrate's current view). Generic over the node shape
  // so getIssue + getStructuralMarkers share one transport + error path.
  private async queryNode<T>(query: string, recordId: string): Promise<T | undefined> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/graphql`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'sfac-validator',
        },
        body: JSON.stringify({ query, variables: { id: recordId } }),
      });
    } catch (err) {
      // Never include the token; the fetch error message is safe.
      throw new GithubSubstrateError(`graphql_fetch_failed:${recordId}:${asMessage(err)}`);
    }
    if (!response.ok) {
      throw new GithubSubstrateError(
        `graphql_http_${response.status}:${recordId}`,
        response.status,
      );
    }
    let parsed: {
      data?: { node?: T | null };
      errors?: ReadonlyArray<{ type?: string; message?: string }>;
    };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch (err) {
      throw new GithubSubstrateError(`graphql_body_parse_failed:${recordId}:${asMessage(err)}`);
    }
    if (parsed.errors !== undefined && parsed.errors.length > 0) {
      // NOT_FOUND surfaces as a GraphQL error for a bad node id; treat it as a
      // missing record (undefined) rather than a hard failure.
      if (parsed.errors.some((e) => e.type === 'NOT_FOUND')) return undefined;
      throw new GithubSubstrateError(
        `graphql_errors:${recordId}:${parsed.errors[0]?.message ?? ''}`,
      );
    }
    const node = parsed.data?.node;
    // null node = the id resolved to nothing, or to a non-Issue type (the
    // inline fragment yields an empty object — defensively treat a node
    // lacking every Issue field as absent).
    if (node === null || node === undefined) return undefined;
    return node;
  }

  // Mint + cache an installation token for this client's installation id.
  private async token(): Promise<string> {
    const now = this.clock();
    if (this.cached !== undefined && this.cached.expiresAt > now) {
      return this.cached.token;
    }
    const appId = this.env.GITHUB_APP_ID as string;
    const pemKey = this.env.GITHUB_APP_PRIVATE_KEY as string;
    const appJwt = signAppJwt(appId, pemKey, Math.floor(now / 1000));
    const minted: MintedToken = await mintInstallationToken(this.installationId, appJwt, {
      fetch: this.fetchImpl,
      ...(this.apiBaseUrl !== DEFAULT_API_BASE_URL ? { apiBaseUrl: this.apiBaseUrl } : {}),
    });
    const expiresAt = minted.expiresAt.getTime() - this.safetyMarginMs;
    this.cached = { token: minted.token, expiresAt };
    return minted.token;
  }
}

export class GithubSubstrateError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GithubSubstrateError';
    this.status = status;
  }
}

// Factory: builds a per-message read-only substrate client for one
// installation id. Throws if the App env is missing (the boot wiring only
// calls this when both env vars are set).
export function createGithubSubstrateClient(
  config: CreateGithubSubstrateClientConfig,
): GithubSubstrateClient {
  return new GithubSubstrateClient(config);
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
