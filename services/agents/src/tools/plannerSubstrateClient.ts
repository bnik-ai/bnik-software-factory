// Spec: docs/decisions/0013-planner-agent.md §Decision item 4
// (PlannerAgent re-evaluates the ready-frontier on each intake /
// dependency-clear event). The Task FSM lives in
// services/validator/src/taskFsm.ts; PlannerAgent is the allowedActor for
// the proposed→ready transition and the validator gates the substrate
// write — this client is the read+write seam that the planner uses.
// Invariants:
//   - READ surface: listTasks(state) + getTaskMetadata(taskId). The planner
//     needs a backlog query (list-by-state) the per-record IssueTool does
//     not expose; this client owns that query.
//   - WRITE surface: transitionTask(taskId, fromState, toState, actor) —
//     mirrors the FSM signature so the validator's evaluateTaskTransition
//     contract reads the same shape end-to-end. PlannerAgent MUST pass
//     actor='PlannerAgent' for the proposed→ready transition (validator's
//     allowedActors gate). Other actors (BuildAgent for ready→in_progress)
//     are out of this client's scope.
//   - The transitionTask method does NOT bypass the validator: the real
//     impl writes the substrate (label change) and the validator's normal
//     inbound webhook flow evaluates the transition. PlannerAgent does not
//     emit a separate transition message; the substrate write IS the event.
//   - Pure interface: no I/O at construction. The real impl
//     (GithubPlannerSubstrateClient) wraps GraphQL/REST + label-edit calls;
//     the stub lets the binary boot and tests exercise the planner logic
//     against an in-memory backlog.

import type { Actor } from '../types.js';

// Subset of the Task FSM states the planner reads + writes. Mirrors
// services/validator/src/taskFsm.ts TaskState; duplicated here so the
// agents package doesn't import the validator package (cross-service
// boundary per repo layout).
export type PlannerTaskState =
  | 'proposed'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'abandoned';

// Task metadata fields the planner orders on. Mirrors the human-declared
// priority + agent-set target fields per ADR 0013 §Decision item 3
// (humans declare Priority/committed_*; agents set target_* within).
//   - priority: Crockford-ordered enum ('P0' highest → 'P3' lowest).
//     Tasks without a priority are treated as P3 (lowest) so they sort
//     last but still surface.
//   - blockedBy: list of Task recordIds that must be in `done` before
//     this Task can be marked ready. Empty list = ready as soon as
//     priority allows. Mirrors the `blocked-by:` field convention in
//     the Task issue body.
//   - createdAt: ISO-8601 timestamp from GitHub's issue.createdAt — tie-
//     breaker after priority + target so FIFO holds for same-priority
//     untargeted Tasks (cheap stability guarantee, matches reviewer
//     intuition).
//   - targetStartAt / committedStartAt: optional ISO-8601 timestamps the
//     planner uses for ordering inside a priority band. committed_* is
//     human-declared (hard constraint); target_* is the planner-set
//     ordering within the band. Per ADR 0013 §3, the planner orders by
//     priority first, then committed_* (when present, earlier first),
//     then target_* (when present), then createdAt.
export interface PlannerTaskMetadata {
  recordId: string;
  state: PlannerTaskState;
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  blockedBy: ReadonlyArray<string>;
  createdAt: string;
  targetStartAt?: string;
  committedStartAt?: string;
}

export type PlannerSubstrateResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface PlannerSubstrateClient {
  // Returns all Tasks currently in the given state. The planner calls
  // listTasks('proposed') to find the backlog and listTasks('done') (or
  // getTaskMetadata for each blocker) to evaluate dep-clear.
  listTasks(state: PlannerTaskState): Promise<PlannerSubstrateResult<ReadonlyArray<string>>>;
  // Returns the metadata the planner orders on. Missing → record_not_found.
  getTaskMetadata(taskId: string): Promise<PlannerSubstrateResult<PlannerTaskMetadata>>;
  // Effects the FSM-allowed transition via the substrate (label change).
  // The validator's normal inbound flow evaluates the transition; this
  // client does not bypass the gate.
  transitionTask(args: {
    taskId: string;
    fromState: PlannerTaskState;
    toState: PlannerTaskState;
    actor: Actor;
  }): Promise<PlannerSubstrateResult<{ taskId: string; toState: PlannerTaskState }>>;
}

// v0 stub: in-memory backlog the tests seed + the planner reads. Boot
// uses this so the binary starts without a substrate;
// GithubPlannerSubstrateClient is the GitHub-App-backed impl of the same interface.
export class StubPlannerSubstrateClient implements PlannerSubstrateClient {
  private readonly tasks: Map<string, PlannerTaskMetadata> = new Map();
  private readonly transitions: Array<{
    taskId: string;
    fromState: PlannerTaskState;
    toState: PlannerTaskState;
    actor: Actor;
  }> = [];

  // Test setup: seed a Task with full metadata.
  seedTask(meta: PlannerTaskMetadata): void {
    this.tasks.set(meta.recordId, {
      ...meta,
      blockedBy: [...meta.blockedBy],
    });
  }

  async listTasks(state: PlannerTaskState): Promise<PlannerSubstrateResult<ReadonlyArray<string>>> {
    const ids: string[] = [];
    for (const meta of this.tasks.values()) {
      if (meta.state === state) ids.push(meta.recordId);
    }
    return { ok: true, value: ids };
  }

  async getTaskMetadata(taskId: string): Promise<PlannerSubstrateResult<PlannerTaskMetadata>> {
    const meta = this.tasks.get(taskId);
    if (meta === undefined) {
      return { ok: false, reason: `record_not_found:${taskId}` };
    }
    return {
      ok: true,
      value: { ...meta, blockedBy: [...meta.blockedBy] },
    };
  }

  async transitionTask(args: {
    taskId: string;
    fromState: PlannerTaskState;
    toState: PlannerTaskState;
    actor: Actor;
  }): Promise<PlannerSubstrateResult<{ taskId: string; toState: PlannerTaskState }>> {
    const meta = this.tasks.get(args.taskId);
    if (meta === undefined) {
      return { ok: false, reason: `record_not_found:${args.taskId}` };
    }
    if (meta.state !== args.fromState) {
      return {
        ok: false,
        reason: `state_mismatch:expected=${args.fromState}:actual=${meta.state}`,
      };
    }
    this.tasks.set(args.taskId, { ...meta, state: args.toState, blockedBy: [...meta.blockedBy] });
    this.transitions.push({ ...args });
    return { ok: true, value: { taskId: args.taskId, toState: args.toState } };
  }

  // Test-only inspection.
  transitionHistory(): ReadonlyArray<{
    taskId: string;
    fromState: PlannerTaskState;
    toState: PlannerTaskState;
    actor: Actor;
  }> {
    return this.transitions;
  }
}

// ---------------------------------------------------------------------------
// Real GitHub-app-backed PlannerSubstrateClient. Spec: docs/decisions/
// 0013-planner-agent.md §Decision item 4 + ADR 0009 §D (structural-comment
// attribution). Mirrors GithubIssueTool's auth/redaction/endpoint shape so
// the two tools stay consistent.
// Invariants:
//   - listTasks(state): REST issue search scoped to the home repo with
//     `is:issue is:open label:kind:task`, plus `label:status:<state>` for a
//     labeled state OR exclusions of every later status for the IMPLICIT
//     `proposed` state (no `status:proposed` label exists). Returns the issues'
//     node_ids (the recordId the validator + planner address by).
//   - getTaskMetadata(id): GraphQL node(id:) for a node id OR repository.issue
//     for an `owner/repo#number` blocked-by ref; reads body + labels + createdAt +
//     state. blocked-by parsed from EITHER a `blocked-by:` body line OR the
//     `### blocked-by` issue-form heading (task.yml renders the input as a
//     heading). priority read from a `priority:P{0..3}` label if
//     present (else undefined → planner treats as P3). target_*/committed_*
//     have NO v0 substrate carrier (architecture.md L112) → left undefined.
//   - transitionTask(): apply `status:<to>` label + remove `status:<from>`
//     (REST labels API), then post the sf:agent=PlannerAgent structural
//     marker (GraphQL addComment) so the validator attributes the
//     proposed→ready transition to PlannerAgent → dispatches BuildAgent.
//   - getToken() mints a fresh installation token per call; this client
//     never reads the App key directly and never logs the token.

import { redact } from './githubIssueTool.js';
import { parseBlockedBy } from './taskDependencies.js';

const DEFAULT_API_BASE = 'https://api.github.com';
const READY_FOR_REVIEW_STATUS_PREFIX = 'status:';
const KIND_TASK_LABEL = 'kind:task';
const PRIORITY_LABEL_PREFIX = 'priority:';

// The Task states AFTER `proposed`. `proposed` is the IMPLICIT initial state:
// Tasks are created (task.yml + PlannerAgent fan-out) with only `kind:task`, and
// the validator derives `proposed` into the audit ledger — it never writes a
// `status:proposed` label. So a proposed Task is `kind:task` open WITHOUT any of
// these later status labels; searching `label:status:proposed` finds nothing.
const NON_PROPOSED_TASK_STATES: ReadonlyArray<string> = [
  'ready',
  'in_progress',
  'in_review',
  'done',
  'abandoned',
];

// Derive the GraphQL endpoint from a REST base (github.com: <base>/graphql;
// GHES drops the trailing /v3 → /api/graphql). Mirrors githubIssueTool.
function deriveGraphql(apiBaseUrl: string): string {
  const base = apiBaseUrl.replace(/\/+$/, '');
  if (base.endsWith('/api/v3')) {
    return `${base.slice(0, -'/v3'.length)}/graphql`;
  }
  return `${base}/graphql`;
}

function plannerStructuralMarker(run: string): string {
  return `<!-- sf:structural sf:agent=PlannerAgent run=${run} -->`;
}

export interface GithubPlannerSubstrateClientConfig {
  getToken: () => Promise<string>;
  // owner/repo of the home repo the planner reads + writes Tasks against.
  owner: string;
  repo: string;
  // Per-run ULID per ADR 0008 — stamped into the structural marker the
  // transition comment carries so the validator can attribute + ledger-join.
  runId: string;
  apiBaseUrl?: string;
  graphqlUrl?: string;
  fetchImpl?: typeof fetch;
}

interface SearchItem {
  node_id: string;
}

// All fields are OPTIONAL: the `... on Issue` inline fragment populates them
// only when the resolved node is actually an Issue. A node id that resolves to a
// non-Issue type (a malformed `blocked-by` ref to a User/Commit/etc.) returns a
// non-null node with NONE of these fields, so they must be guarded before use.
interface GraphqlTaskNode {
  number?: number;
  body?: string | null;
  state?: string;
  createdAt?: string;
  labels?: { nodes: Array<{ name: string }> };
}

export class GithubPlannerSubstrateClient implements PlannerSubstrateClient {
  private readonly getToken: () => Promise<string>;
  private readonly owner: string;
  private readonly repo: string;
  private readonly runId: string;
  private readonly apiBaseUrl: string;
  private readonly graphqlUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GithubPlannerSubstrateClientConfig) {
    this.getToken = config.getToken;
    this.owner = config.owner;
    this.repo = config.repo;
    this.runId = config.runId;
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.graphqlUrl = config.graphqlUrl ?? deriveGraphql(this.apiBaseUrl);
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

  async listTasks(state: PlannerTaskState): Promise<PlannerSubstrateResult<ReadonlyArray<string>>> {
    // REST issue search. `repo:` scopes to the home repo; `is:issue is:open`
    // excludes PRs + closed records (terminal Tasks aren't backlog). For the
    // IMPLICIT `proposed` state there is no `status:proposed` label, so match
    // `kind:task` open issues NOT yet promoted to a later status; for the
    // labeled states (ready / in_progress / ...) match the status carrier
    // directly.
    const scope = [
      `repo:${this.owner}/${this.repo}`,
      'is:issue',
      'is:open',
      `label:${KIND_TASK_LABEL}`,
    ];
    const stateClauses =
      state === 'proposed'
        ? NON_PROPOSED_TASK_STATES.map((s) => `-label:${READY_FOR_REVIEW_STATUS_PREFIX}${s}`)
        : [`label:${READY_FOR_REVIEW_STATUS_PREFIX}${state}`];
    const query = [...scope, ...stateClauses].join(' ');
    // Page through ALL matches — a single per_page=100 page silently strands
    // proposed Tasks beyond the first 100 (GitHub search order is NOT the
    // planner's priority/dependency order), so ready work could never be
    // promoted. GitHub's search API caps at 1000 results
    // (10 pages of 100); stop when a page returns fewer than a full page or the
    // declared total_count is reached, whichever comes first.
    const PER_PAGE = 100;
    const MAX_PAGES = 10; // GitHub search hard cap: 1000 results.
    const nodeIds: string[] = [];
    const encodedQuery = encodeURIComponent(query);
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${this.apiBaseUrl}/search/issues?q=${encodedQuery}&per_page=${PER_PAGE}&page=${page}`;
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers: await this.headers() });
      } catch (err) {
        return { ok: false, reason: `network_error:${redact(String(err))}` };
      }
      if (!response.ok) {
        return {
          ok: false,
          reason: `list_tasks_failed:${response.status}:${await safeText(response)}`,
        };
      }
      const json = (await response.json()) as { items?: SearchItem[]; total_count?: number };
      const items = json.items ?? [];
      for (const item of items) nodeIds.push(item.node_id);
      // Last page when this page wasn't full, or we've collected the declared total.
      if (items.length < PER_PAGE) break;
      if (typeof json.total_count === 'number' && nodeIds.length >= json.total_count) break;
    }
    return { ok: true, value: nodeIds };
  }

  async getTaskMetadata(taskId: string): Promise<PlannerSubstrateResult<PlannerTaskMetadata>> {
    // Two id forms resolve to the same Issue shape: a GraphQL node id (the
    // listTasks backlog form) via node(id:), and an `owner/repo#number`
    // cross-repo reference (the task.yml + ADR 0003 blocked-by form) via
    // repository.issue. Supporting both is required so a human-declared blocker
    // actually resolves instead of being a permanent record_not_found that
    // strands the dependent Task.
    const ISSUE_FIELDS = 'number body state createdAt labels(first: 50) { nodes { name } }';
    const ref = parseIssueRef(taskId);
    const { query, variables } =
      ref === undefined
        ? {
            query: `query($id: ID!) { node(id: $id) { ... on Issue { ${ISSUE_FIELDS} } } }`,
            variables: { id: taskId } as Record<string, unknown>,
          }
        : {
            query: `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE_FIELDS} } } }`,
            variables: { owner: ref.owner, name: ref.repo, number: ref.number },
          };
    let response: Response;
    try {
      response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `get_metadata_failed:${response.status}:${await safeText(response)}`,
      };
    }
    const json = (await response.json()) as {
      data?: {
        node?: GraphqlTaskNode | null;
        repository?: { issue?: GraphqlTaskNode | null } | null;
      };
      errors?: Array<{ message: string }>;
    };
    if (json.errors !== undefined && json.errors.length > 0) {
      return { ok: false, reason: `graphql_error:${json.errors.map((e) => e.message).join(';')}` };
    }
    const node = ref === undefined ? json.data?.node : json.data?.repository?.issue;
    // null = absent record. A non-null node MISSING the Issue fields (`labels`/
    // `createdAt`) is a non-Issue node (the `... on Issue` fragment matched
    // nothing) — also not a readable Task. Surface the typed not-found rather
    // than throwing on `node.labels.nodes` and crashing the planner.
    if (
      node === undefined ||
      node === null ||
      node.labels === undefined ||
      node.createdAt === undefined
    ) {
      return { ok: false, reason: `record_not_found:${taskId}` };
    }
    const labelNames = node.labels.nodes.map((label) => label.name);
    const meta: PlannerTaskMetadata = {
      recordId: taskId,
      state: deriveStateFromLabels(labelNames),
      blockedBy: parseBlockedBy(node.body ?? ''),
      createdAt: node.createdAt,
    };
    const priority = parsePriority(labelNames);
    if (priority !== undefined) {
      return { ok: true, value: { ...meta, priority } };
    }
    return { ok: true, value: meta };
  }

  async transitionTask(args: {
    taskId: string;
    fromState: PlannerTaskState;
    toState: PlannerTaskState;
    actor: Actor;
  }): Promise<PlannerSubstrateResult<{ taskId: string; toState: PlannerTaskState }>> {
    const numberResult = await this.resolveNumber(args.taskId);
    if (!numberResult.ok) return numberResult;
    const issueNumber = numberResult.value;

    // Apply the new status label first (the validator's labeled webhook is
    // the transition event). Then remove the prior status label so the
    // substrate stays single-status (matches the IssueTool convention).
    const apply = await this.applyLabel(
      issueNumber,
      `${READY_FOR_REVIEW_STATUS_PREFIX}${args.toState}`,
    );
    if (!apply.ok) return apply;
    const remove = await this.removeLabel(
      issueNumber,
      `${READY_FOR_REVIEW_STATUS_PREFIX}${args.fromState}`,
    );
    if (!remove.ok) return remove;

    // Structural marker so the validator attributes the proposed→ready
    // transition to PlannerAgent (ADR 0009 §D) → dispatches BuildAgent.
    const comment = await this.postMarkerComment(
      args.taskId,
      `${args.actor} promoted this Task \`${args.fromState}\`→\`${args.toState}\`.`,
    );
    if (!comment.ok) return comment;

    return { ok: true, value: { taskId: args.taskId, toState: args.toState } };
  }

  private async applyLabel(
    issueNumber: number,
    label: string,
  ): Promise<PlannerSubstrateResult<true>> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels`,
        {
          method: 'POST',
          headers: await this.headers(),
          body: JSON.stringify({ labels: [label] }),
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
    return { ok: true, value: true };
  }

  private async removeLabel(
    issueNumber: number,
    label: string,
  ): Promise<PlannerSubstrateResult<true>> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
        { method: 'DELETE', headers: await this.headers() },
      );
    } catch (err) {
      return { ok: false, reason: `network_error:${redact(String(err))}` };
    }
    // 404 = label already absent → idempotent success (matches IssueTool).
    if (!response.ok && response.status !== 404) {
      return {
        ok: false,
        reason: `remove_label_failed:${response.status}:${await safeText(response)}`,
      };
    }
    return { ok: true, value: true };
  }

  private async postMarkerComment(
    subjectId: string,
    body: string,
  ): Promise<PlannerSubstrateResult<true>> {
    const mutation = `mutation($subjectId: ID!, $body: String!) {
      addComment(input: { subjectId: $subjectId, body: $body }) {
        commentEdge { node { id } }
      }
    }`;
    const markerBody = `${plannerStructuralMarker(this.runId)}\n\n${body}`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ query: mutation, variables: { subjectId, body: markerBody } }),
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
    if (json.data?.addComment?.commentEdge?.node?.id === undefined) {
      return { ok: false, reason: 'comment_failed:no_id_returned' };
    }
    return { ok: true, value: true };
  }

  private async resolveNumber(recordId: string): Promise<PlannerSubstrateResult<number>> {
    const query = 'query($id: ID!) { node(id: $id) { ... on Issue { number } } }';
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
      return { ok: false, reason: `record_not_found:${recordId}` };
    }
    return { ok: true, value: number };
  }
}

// Derive the Task's FSM state from its single status:* label. Returns
// undefined when no status label is present (substrate-shape problem the
// caller surfaces). Unknown status values fall through to undefined.
const PLANNER_TASK_STATES: ReadonlySet<string> = new Set<PlannerTaskState>([
  'proposed',
  'ready',
  'in_progress',
  'in_review',
  'done',
  'abandoned',
]);
// Precedence: when MULTIPLE status labels are present (the
// transient apply-then-remove swap window, or a failed cleanup after
// status:done landed), the MOST-ADVANCED state wins — terminal first. A
// label-ORDER scan would be nondeterministic there: a leftover status:ready before
// status:done would read as 'ready' and keep dependents blocked even though the
// transition to done is already ledgered.
const STATE_PRECEDENCE: ReadonlyArray<PlannerTaskState> = [
  'done',
  'abandoned',
  'in_review',
  'in_progress',
  'ready',
];
function deriveStateFromLabels(labelNames: ReadonlyArray<string>): PlannerTaskState {
  const present = new Set<string>();
  for (const name of labelNames) {
    if (!name.startsWith(READY_FOR_REVIEW_STATUS_PREFIX)) continue;
    const value = name.slice(READY_FOR_REVIEW_STATUS_PREFIX.length);
    if (PLANNER_TASK_STATES.has(value)) present.add(value);
  }
  for (const state of STATE_PRECEDENCE) {
    if (present.has(state)) return state;
  }
  // No status label = the IMPLICIT initial state. Tasks are created with only
  // `kind:task`; the validator derives `proposed` into the ledger and never
  // writes a `status:proposed` label, so an unlabeled Task is `proposed` — not a
  // metadata error (it's the planner's primary backlog state).
  return 'proposed';
}

// Parse an `owner/repo#number` cross-repo issue reference (the task.yml + ADR
// 0003 blocked-by form). Returns undefined for a GraphQL node id (the listTasks
// backlog form), which getTaskMetadata resolves via node(id:).
function parseIssueRef(ref: string): { owner: string; repo: string; number: number } | undefined {
  const match = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/.exec(ref.trim());
  if (match === null) return undefined;
  const [, owner, repo, numberText] = match;
  if (owner === undefined || repo === undefined || numberText === undefined) return undefined;
  const number = Number.parseInt(numberText, 10);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return { owner, repo, number };
}

// Read Priority from a `priority:P{0..3}` label if present (else undefined →
// planner treats as P3). Only the four canonical bands are recognized.
function parsePriority(labelNames: ReadonlyArray<string>): 'P0' | 'P1' | 'P2' | 'P3' | undefined {
  for (const name of labelNames) {
    if (!name.startsWith(PRIORITY_LABEL_PREFIX)) continue;
    const value = name.slice(PRIORITY_LABEL_PREFIX.length);
    if (value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3') {
      return value;
    }
  }
  return undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return redact((await response.text()).slice(0, 500));
  } catch {
    return '<unreadable>';
  }
}
