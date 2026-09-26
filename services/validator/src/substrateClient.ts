// Spec: docs/design/validator-bot.md:292 ("canonical state is always
// re-read from the substrate (GitHub) or the mirror at decision time").
// The transition resolver uses this to derive fromState by reading the
// record's current label set; B7 wires the real GraphQL implementation,
// v0 boot uses InMemorySubstrateClient.
// Invariants:
//   - SubstrateClient is READ-ONLY. The MUTATING substrate client lives
//     in services/github-app/src/ as `substrateClient()` (writes are
//     image-scoped to the terraform Container App per github-app.md:172).
//   - Reads return the substrate's CURRENT view, not the pre-event view.
//     For webhook handling: the webhook fires after the substrate change,
//     so currentLabels = post-event label set. The resolver derives
//     fromState by subtracting the just-applied label (envelope.statusLabel)
//     from the current set.
//   - getIssue returns the issue's full body + labels view (undefined if
//     the record is not in the substrate). Used by cross-record
//     assertions (B3-PR25+) to verify body-carried references per ADR
//     0003 (parent-goal / spec-ref / design-ref). Body is the v0 carrier
//     for those linking fields per ADR 0007; B7 GraphQL impl reads
//     `issue(id) { body, labels { name } }` in one query.

export interface IssueView {
  readonly body: string;
  readonly labels: readonly string[];
}

// ADR 0009 §D: the real agent behind an App-sent transition is carried in a
// structural-comment marker on the record (issue body and/or recent
// structural comments). The validator's actor resolver reads these surfaces
// to recover the agent the App acted as. `body` is the record's standing
// marker; `comments` are oldest-first (GraphQL `issue.comments` natural
// order) so the resolver scans newest-first for most-recent-wins. Undefined
// from getStructuralMarkers means the record is absent from the substrate.
// One marker-bearing comment: body + authoring login. The actor resolver trusts
// a structural marker ONLY when authorLogin is a recognized App-bot login —
// comments/bodies are human-writable, so an unauthenticated marker is forgeable
// (codex PR #152). Mirrors actorResolution.MarkerSurfaces (structurally typed).
export interface MarkerComment {
  readonly body: string;
  readonly authorLogin?: string;
}

export interface MarkerSurfaces {
  readonly body: string;
  readonly bodyAuthorLogin?: string;
  readonly comments: readonly MarkerComment[];
}

// Spec: docs/design/review-agent.md §3 + §6, ADR 0010 §"Substrate constraints".
// Minimum shape the validator's review-loop assertions need from a Review
// record: the recordId (for audit), the state (`changes_requested` |
// `approved` — only `approved` gates the PR merge), the body (carries the
// finding triage + reviewer/adjudicator structural-comment stamps), and
// optionally the structural comments themselves split out (when the
// substrate impl exposes them separately from the body). The validator only
// cares about the model segment of each stamp; everything else is audit detail.
export interface ReviewView {
  readonly recordId: string;
  readonly state: 'changes_requested' | 'approved';
  readonly body: string;
  readonly structuralComments?: readonly string[];
}

// Spec: docs/design/review-agent.md §3 ("the author's model is on the PR head
// branch (`build@<model>`, ADR 0008) and head-commit `SF-Agent` trailer").
// The validator extracts the author's model segment from the head ref's
// `role@model` last segment, falling back to the head-commit message trailer
// when the ref isn't an SF feeder branch (e.g. a human-opened PR). Both
// fields are optional — a PR with neither is unstamped and review-loop
// model independence cannot be checked.
export interface PrView {
  readonly headRef?: string;
  readonly headCommitMessage?: string;
}

export interface SubstrateClient {
  getCurrentLabels(recordId: string): Promise<readonly string[]>;
  getIssue(recordId: string): Promise<IssueView | undefined>;
  // ADR 0009 §D: fetch the record's body + recent structural comments so the
  // actor resolver can recover the agent behind an App-sent transition from
  // the most recent `sf:agent=<role@model>` marker. Returns undefined when
  // the record is absent from the substrate (resolver then falls back to the
  // single-agent FSM inference). Comments are oldest-first.
  getStructuralMarkers(recordId: string): Promise<MarkerSurfaces | undefined>;
  // ADR 0010 §"Substrate constraints" + review-agent.md §6: cross-record
  // assertion needs to find Reviews for a PR so the validator can enforce
  // "an approved Review (carrying compliant stamps) is required before
  // `pr:in_review→approved`." Returns the empty list when the PR has none.
  getReviewsForPr(prRecordId: string): Promise<readonly ReviewView[]>;
  // ADR 0010 §"Substrate constraints" + review-agent.md §3: the author's
  // model is on the PR head — ref segment (`build@<model>`) or head-commit
  // SF-Agent trailer. Returns undefined when the PR is unseen by the
  // substrate (treated as `getIssue` is — upstream resolver gap, silent).
  getPullRequest(prRecordId: string): Promise<PrView | undefined>;
}

export class InMemorySubstrateClient implements SubstrateClient {
  // The default App-bot login an authentic marker is posted under. Seeded
  // markers represent App-authored markers, so the test substrate stamps them
  // with this recognized login (back-compat with appBotLoginsFromEnv defaults);
  // tests pass an explicit non-App login to exercise the forged-marker path.
  private static readonly DEFAULT_APP_AUTHOR = 'softwarefactory[bot]';

  private readonly labelsByRecord: Map<string, ReadonlySet<string>> = new Map();
  private readonly bodiesByRecord: Map<string, string> = new Map();
  private readonly bodyAuthorByRecord: Map<string, string> = new Map();
  private readonly commentsByRecord: Map<string, readonly MarkerComment[]> = new Map();
  private readonly reviewsByPr: Map<string, ReviewView[]> = new Map();
  private readonly prsByRecord: Map<string, PrView> = new Map();

  setLabels(recordId: string, labels: readonly string[]): void {
    this.labelsByRecord.set(recordId, new Set(labels));
  }

  setIssue(
    recordId: string,
    issue: { body: string; labels: readonly string[]; authorLogin?: string },
  ): void {
    this.bodiesByRecord.set(recordId, issue.body);
    this.labelsByRecord.set(recordId, new Set(issue.labels));
    this.bodyAuthorByRecord.set(
      recordId,
      issue.authorLogin ?? InMemorySubstrateClient.DEFAULT_APP_AUTHOR,
    );
  }

  // Test helper: seed the record's structural comments (oldest-first), used by
  // the actor resolver's marker-from-comment path. authorLogin defaults to the
  // App bot (markers are App-posted); pass a human login to seed a forged marker.
  setComments(
    recordId: string,
    comments: readonly string[],
    authorLogin: string = InMemorySubstrateClient.DEFAULT_APP_AUTHOR,
  ): void {
    this.commentsByRecord.set(
      recordId,
      comments.map((body) => ({ body, authorLogin })),
    );
  }

  // Test helper: seed a Review under a given PR. Appends so a single PR can
  // have many `changes_requested` rounds + one terminal `approved` Review,
  // matching the substrate shape the review loop produces.
  seedReview(prRecordId: string, review: ReviewView): void {
    const list = this.reviewsByPr.get(prRecordId);
    if (list === undefined) {
      this.reviewsByPr.set(prRecordId, [review]);
      return;
    }
    list.push(review);
  }

  // Test helper: seed the PR's head metadata used to recover the author's
  // model segment. Either field may be omitted independently.
  seedPullRequest(prRecordId: string, pr: PrView): void {
    this.prsByRecord.set(prRecordId, pr);
  }

  async getCurrentLabels(recordId: string): Promise<readonly string[]> {
    const labels = this.labelsByRecord.get(recordId);
    if (labels === undefined) return [];
    return Array.from(labels);
  }

  async getIssue(recordId: string): Promise<IssueView | undefined> {
    const body = this.bodiesByRecord.get(recordId);
    if (body === undefined) return undefined;
    const labels = this.labelsByRecord.get(recordId);
    return { body, labels: labels === undefined ? [] : Array.from(labels) };
  }

  async getStructuralMarkers(recordId: string): Promise<MarkerSurfaces | undefined> {
    const body = this.bodiesByRecord.get(recordId);
    // A record with no seeded body but seeded comments still resolves; only a
    // wholly-unseen record returns undefined (resolver falls back).
    const comments = this.commentsByRecord.get(recordId);
    if (body === undefined && comments === undefined) return undefined;
    const bodyAuthorLogin = this.bodyAuthorByRecord.get(recordId);
    return {
      body: body ?? '',
      ...(bodyAuthorLogin !== undefined ? { bodyAuthorLogin } : {}),
      comments: comments === undefined ? [] : comments.slice(),
    };
  }

  async getReviewsForPr(prRecordId: string): Promise<readonly ReviewView[]> {
    const list = this.reviewsByPr.get(prRecordId);
    if (list === undefined) return [];
    // Fresh array so the caller can't mutate the substrate's backing store.
    return list.slice();
  }

  async getPullRequest(prRecordId: string): Promise<PrView | undefined> {
    return this.prsByRecord.get(prRecordId);
  }
}
