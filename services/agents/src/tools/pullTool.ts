// Spec: docs/design/validator-bot.md "Pull Request" FSM + ADR 0010
// (Review record gates `in_review → approved`).
// Invariants:
//   - openPr(): the head branch SHOULD match ADR 0008 grammar (validator
//     enforces). The real impl validates before calling.
//   - submitReview(): state is one of `approve` / `request-changes` /
//     `comment`. ADR 0010's review-loop discipline lives in ReviewAgent
//     itself; this tool just emits the substrate Review record.
//   - read(): fetches a PR record by node_id. Symmetric with IssueTool.read.
//     ReviewAgent uses it to load the PR before emitting a Review (analogous
//     to SpecAgent/DesignAgent reading their input record). The real impl
//     resolves via GraphQL; the stub returns previously-opened or seeded
//     records.

export interface PullOpenArgs {
  // Issue node_id of the Task this PR satisfies (ADR 0003 task linkage).
  taskRecordId?: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}

// PR author identity (issue #191). The ownership signals BuildAgent's
// auto-revision guard needs beyond the head-branch grammar: the ref name alone
// cannot prove the PR is App-authored. `login` is the GraphQL Actor login;
// `isBot` is `__typename === 'Bot'` (a human is a `User`, never a `Bot` — the
// substrate stamps it from the authenticated identity, so it is not forgeable).
// Mirrors the validator's actor-resolution (githubSubstrateClient.ts) and the
// githubIssueTool marker-trust floor.
export interface PullAuthor {
  // GraphQL Actor login. For a GitHub App the `[bot]` suffix is dropped (#161);
  // callers normalize before comparing to the configured App slug.
  login?: string;
  // __typename === 'Bot'. A non-Bot author can never be the App.
  isBot: boolean;
}

export interface PullRecord {
  recordId: string; // PR node_id
  number: number;
  state: 'draft' | 'open' | 'merged' | 'closed';
  headBranch: string;
  baseBranch: string;
  // GitHub PR body markdown. BuildAgent writes `task-ref: <Task_recordId>`
  // into it (buildAgent.ts), so ReviewAgent's verdict run can resolve the
  // paired Task from the PR (PR→Task linkage) to drive the
  // `task:in_review→in_progress` revision loop on request-changes (issue #178
  // rev2). Optional: a seeded/legacy record may omit it.
  body?: string;
  // PR author identity (issue #191). The auto-revision ownership guard asserts
  // the App authored the PR (not a human crafting an `sf/...`-named branch).
  // Optional: a seeded/legacy record may omit it (treated as not-App-owned by
  // the guard — fail closed → park).
  author?: PullAuthor;
  // Cross-repo (fork) signal (issue #191). True when the head branch lives in a
  // FORK, not the base repo — a fork PR could carry a colliding `sf/...` ref, so
  // cloning/pushing it would target the wrong base-repo branch. The guard
  // requires same-repo (false). Optional: a seeded/legacy record may omit it
  // (the guard fail-closes on absence → park).
  isCrossRepository?: boolean;
}

export interface PullCloseArgs {
  recordId: string;
  reason: string;
}

export interface PullMergeArgs {
  recordId: string; // PR node_id
  // squash | rebase | merge. v0 default is squash per existing convention
  // (see PR #54+ self-merge commands using --squash). Repo rulesets may
  // reject non-allowed methods; the real impl surfaces the GraphQL error.
  method?: 'squash' | 'rebase' | 'merge';
  // Optional override for the commit subject line. v0 default is the PR
  // title (GitHub's default behavior).
  commitTitle?: string;
}

export interface PullReviewSubmitArgs {
  recordId: string; // PR node_id
  state: 'approve' | 'request-changes' | 'comment';
  body: string;
  // ADR 0010's adjudication output — embedded in the Review body for
  // audit per the Review record carrying reviewer / adjudicator stamps.
  findings?: ReadonlyArray<{
    severity: 'P1' | 'P2' | 'P3';
    file: string;
    line: number;
    claim: string;
    suggestedFix?: string;
    verdict: 'fix' | 'pass' | 'pass-deferred';
  }>;
}

export type PullToolResult<T> = { ok: true; value: T } | { ok: false; reason: string };

// ADR 0012 item 1 requires the feeder branch be current with main BEFORE
// the approved verdict; ADR 0012 §Risks names "OpsAgent's merge gate
// re-checking at merge time" as the mitigation. This verb is that check.
// The substrate-edge mitigation (GitHub ruleset's
// `strict_required_status_checks_policy = true` on a non-empty
// `required_status_checks`) is currently INACTIVE in v0 because CI hasn't
// been wired — issue #105 documents the gap. This code-path check is the
// pre-CI fix. When CI lands and `required_status_checks` is populated,
// the substrate edge gives belt-and-suspenders.
export interface PullSyncStatus {
  recordId: string; // PR node_id
  status: 'current' | 'behind';
  // Number of base-branch commits NOT on the head (i.e. merges into
  // main since the PR was last rebased). Populated only when behind.
  behindBy?: number;
}

export interface PullDiff {
  // Unified diff text (GitHub `application/vnd.github.diff` media type).
  diff: string;
  // True when the diff was cut at the size cap — the reviewer sees the
  // truncation note and reviews what is present.
  truncated: boolean;
}

// Base-tree file read (issue #179). ReviewAgent resolves a symbol/file/fixture
// the diff CITES but does not define against the PR's base ref — it may already
// exist in base from an earlier merged task, so a "missing" finding would be
// false. A clean not-found at base maps to `found: false` (a genuinely-absent
// reference — still a defect), distinct from a transport failure (ok: false).
export interface BaseFileRead {
  path: string;
  found: boolean;
  // File contents at the base ref. UNTRUSTED repo data; present only when found.
  content?: string;
  // True when content was cut at the size cap.
  truncated: boolean;
}

export interface PullTool {
  open(args: PullOpenArgs): Promise<PullToolResult<PullRecord>>;
  read(recordId: string): Promise<PullToolResult<PullRecord>>;
  close(args: PullCloseArgs): Promise<PullToolResult<{ recordId: string }>>;
  submitReview(args: PullReviewSubmitArgs): Promise<PullToolResult<{ reviewId: string }>>;
  merge(args: PullMergeArgs): Promise<PullToolResult<{ recordId: string; mergeSha: string }>>;
  // The PR's unified diff — the review surface (M5 finding: a metadata-only
  // review forces the brain to fail closed with REQUEST_CHANGES; the verdict
  // is only meaningful when the reviewer sees the code).
  diff(recordId: string): Promise<PullToolResult<PullDiff>>;
  // Read a file's contents at the PR's BASE ref (issue #179). ReviewAgent uses
  // it to refute a false "missing symbol/file/fixture" finding: a reference
  // resolvable in base (from an earlier merged task) is NOT a defect. Real impl
  // wraps GitHub's contents API at `?ref=<baseBranch>`; a clean 404 →
  // `found: false` (genuinely absent), only a transport error → ok: false.
  readBaseFile(recordId: string, path: string): Promise<PullToolResult<BaseFileRead>>;
  // Resolve whether the PR's head is current with its base. Real impl
  // wraps GitHub's `GET /repos/{owner}/{repo}/compare/{base}...{head}`.
  // Returns 'behind' when behind_by > 0.
  getSyncStatus(recordId: string): Promise<PullToolResult<PullSyncStatus>>;
}

export class StubPullTool implements PullTool {
  private readonly records: Map<string, PullRecord> = new Map();
  private readonly diffs: Map<string, PullDiff> = new Map();
  // Per-PR base-tree files (issue #179). recordId → (path → contents). Unseeded
  // paths default to found:false (a clean not-found at base — a genuine missing
  // reference), exercising ReviewAgent's fail-closed path.
  private readonly baseFiles: Map<string, Map<string, { content: string; truncated: boolean }>> =
    new Map();
  private failNextBaseFileReadReason: string | undefined;
  private readonly opened: PullOpenArgs[] = [];
  private readonly closed: PullCloseArgs[] = [];
  private readonly reviews: PullReviewSubmitArgs[] = [];
  private readonly merged: PullMergeArgs[] = [];
  private readonly syncStatusCalls: string[] = [];
  // Per-PR sync override for tests. When unset, getSyncStatus returns
  // 'current' (the safe default — pre-issue-#105 behavior).
  private readonly syncStatusOverrides: Map<string, PullSyncStatus> = new Map();
  private nextPrNumber = 1;
  private nextReviewId = 1;
  private nextMergeSha = 1;
  // open()-default PR ownership (issue #191): App-authored, same-repo, so
  // existing tests (and the genuine BuildAgent path) pass the ownership guard
  // without per-test seeding. Override via setDefaultAuthor for human/fork cases.
  private defaultAuthor: PullAuthor = { login: 'sfac-app[bot]', isBot: true };
  private defaultIsCrossRepository = false;

  // Test setup: seed a PR record so read() returns it (the real impl pulls
  // from GitHub GraphQL). Mirrors StubIssueTool.seedRecord.
  seedRecord(record: PullRecord): void {
    this.records.set(record.recordId, record);
  }

  // Test helper: set the author/fork ownership stamped on subsequently opened
  // PRs (issue #191). Default is App-authored same-repo; override to simulate a
  // human-opened PR (isBot:false) or a fork (isCrossRepository:true).
  setDefaultOwnership(author: PullAuthor, isCrossRepository: boolean): void {
    this.defaultAuthor = author;
    this.defaultIsCrossRepository = isCrossRepository;
  }

  async open(args: PullOpenArgs): Promise<PullToolResult<PullRecord>> {
    this.opened.push(args);
    const number = this.nextPrNumber;
    this.nextPrNumber += 1;
    const recordId = `PR_stub_${number}`;
    const state = args.draft === true ? 'draft' : 'open';
    const record: PullRecord = {
      recordId,
      number,
      state,
      headBranch: args.headBranch,
      baseBranch: args.baseBranch,
      body: args.body,
      // issue #191: default App-authored same-repo so opened PRs pass the
      // ownership guard (override via setDefaultOwnership for human/fork tests).
      author: { ...this.defaultAuthor },
      isCrossRepository: this.defaultIsCrossRepository,
    };
    // Auto-seed so subsequent read() calls work — mirrors StubIssueTool.create.
    this.records.set(recordId, record);
    return {
      ok: true,
      value: record,
    };
  }

  async read(recordId: string): Promise<PullToolResult<PullRecord>> {
    const record = this.records.get(recordId);
    if (record === undefined) {
      return { ok: false, reason: `pr_record_not_found:${recordId}` };
    }
    return { ok: true, value: { ...record } };
  }

  async close(args: PullCloseArgs): Promise<PullToolResult<{ recordId: string }>> {
    this.closed.push(args);
    return { ok: true, value: { recordId: args.recordId } };
  }

  private failNextSubmitReviewReason: string | undefined;

  // Test helper: make the next submitReview fail with the given reason.
  failNextSubmitReview(reason: string): void {
    this.failNextSubmitReviewReason = reason;
  }

  async submitReview(args: PullReviewSubmitArgs): Promise<PullToolResult<{ reviewId: string }>> {
    if (this.failNextSubmitReviewReason !== undefined) {
      const reason = this.failNextSubmitReviewReason;
      this.failNextSubmitReviewReason = undefined;
      return { ok: false, reason };
    }
    this.reviews.push(args);
    const reviewId = `stub-review-${this.nextReviewId}`;
    this.nextReviewId += 1;
    return { ok: true, value: { reviewId } };
  }

  async merge(
    args: PullMergeArgs,
  ): Promise<PullToolResult<{ recordId: string; mergeSha: string }>> {
    this.merged.push(args);
    const mergeSha = `stub-merge-${this.nextMergeSha.toString(16).padStart(8, '0')}`;
    this.nextMergeSha += 1;
    return { ok: true, value: { recordId: args.recordId, mergeSha } };
  }

  async getSyncStatus(recordId: string): Promise<PullToolResult<PullSyncStatus>> {
    this.syncStatusCalls.push(recordId);
    const override = this.syncStatusOverrides.get(recordId);
    if (override !== undefined) {
      return { ok: true, value: override };
    }
    return { ok: true, value: { recordId, status: 'current' } };
  }

  async diff(recordId: string): Promise<PullToolResult<PullDiff>> {
    const seeded = this.diffs.get(recordId);
    if (seeded === undefined) {
      // Fail-by-default: tests exercising the review surface seed explicitly;
      // an unseeded read surfaces as the same typed failure shape the real
      // tool produces, so the agent's fail-closed path is testable.
      return { ok: false, reason: `diff_not_seeded:${recordId}` };
    }
    return { ok: true, value: seeded };
  }

  // Test helper: seed the diff returned for a specific PR.
  seedDiff(recordId: string, diff: string, truncated = false): void {
    this.diffs.set(recordId, { diff, truncated });
  }

  async readBaseFile(recordId: string, path: string): Promise<PullToolResult<BaseFileRead>> {
    if (this.failNextBaseFileReadReason !== undefined) {
      const reason = this.failNextBaseFileReadReason;
      this.failNextBaseFileReadReason = undefined;
      return { ok: false, reason };
    }
    const seeded = this.baseFiles.get(recordId)?.get(path);
    if (seeded === undefined) {
      // Clean not-found at base (NOT a transport failure): the cited reference
      // is genuinely absent → ReviewAgent keeps fail-closed on it.
      return { ok: true, value: { path, found: false, truncated: false } };
    }
    return {
      ok: true,
      value: { path, found: true, content: seeded.content, truncated: seeded.truncated },
    };
  }

  // Test helper: seed a file present at a PR's base ref.
  seedBaseFile(recordId: string, path: string, content: string, truncated = false): void {
    let perPr = this.baseFiles.get(recordId);
    if (perPr === undefined) {
      perPr = new Map();
      this.baseFiles.set(recordId, perPr);
    }
    perPr.set(path, { content, truncated });
  }

  // Test helper: make the next readBaseFile fail with a transport reason.
  failNextBaseFileRead(reason: string): void {
    this.failNextBaseFileReadReason = reason;
  }

  // Test helper: set the next getSyncStatus response for a specific PR.
  setSyncStatus(recordId: string, status: PullSyncStatus): void {
    this.syncStatusOverrides.set(recordId, status);
  }

  // Test-only inspection.
  openHistory(): readonly PullOpenArgs[] {
    return this.opened;
  }
  closeHistory(): readonly PullCloseArgs[] {
    return this.closed;
  }
  reviewHistory(): readonly PullReviewSubmitArgs[] {
    return this.reviews;
  }
  mergeHistory(): readonly PullMergeArgs[] {
    return this.merged;
  }
  syncStatusHistory(): readonly string[] {
    return this.syncStatusCalls;
  }
}
