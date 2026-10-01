// Spec: docs/design/validator-bot.md (substrate primitives — kind:* +
// status:* labels) + ADR 0009 §D (structural comment attribution
// `sf:structural`/`sf:agent`/`run`).
// Invariants:
//   - Label changes are how SF-state transitions happen on substrate
//     Issues. applyLabel / removeLabel are the canonical writes.
//   - Comments MUST carry the sf:structural marker per ADR 0009 §D when
//     the agent is making a substrate-meaningful statement (Review
//     verdict, audit note, etc.). The marker + role + run land as a
//     comment-body HTML comment per the documented format.
//   - All methods are async. Stub impls return synthetically.

export interface IssueRecord {
  // GitHub Issue node_id (the same recordId the validator sees).
  recordId: string;
  // The issue's currently-applied labels.
  labels: ReadonlyArray<string>;
  // GitHub's body markdown.
  body: string;
}

export interface IssueLabelArgs {
  recordId: string;
  label: string;
}

export interface IssueCloseArgs {
  recordId: string;
  // GitHub issue close `state_reason`. 'completed' for a satisfied Task
  // (OpsAgent closes a status:done Task); 'not_planned' for
  // abandonment.
  reason: 'completed' | 'not_planned';
}

export interface IssueCreateArgs {
  // The repo to create the issue in (e.g. 'example-org/software-factory').
  // Cross-repo creation is the v0 PlannerAgent fan-out pattern per ADR
  // 0003 (infra Tasks land in platform-overlay; app Tasks land in the app repo).
  repo: string;
  title: string;
  body: string;
  // Substrate labels applied at creation time. The kind:* label is the
  // canonical kind marker per ADR 0006; status:* labels are NOT applied
  // here — the issue's initial state comes from the per-kind default in
  // the validator's transitionResolver (Goal/Task → proposed,
  // Spec/Design/Decision → drafting).
  labels: ReadonlyArray<string>;
  // Structural attribution per ADR 0009. The real impl serializes this
  // into the issue body as `<!-- sf:structural sf:agent=<role> run=<ulid> -->`
  // alongside the user-supplied body so the validator can attribute the
  // creation to a specific agent run.
  structural?: {
    role: string;
    run: string;
  };
}

export interface IssueCommentArgs {
  recordId: string;
  // The comment body (markdown). For substrate-meaningful comments, the
  // structural marker is auto-prepended by the real impl per ADR 0009 §D
  // (`<!-- sf:structural sf:agent=<role> run=<ulid> -->`); the stub
  // records what it was asked to post verbatim.
  body: string;
  structural?: {
    role: string; // e.g. 'ReviewAgent'
    run: string; // ULID per ADR 0008
    // Optional marker attribute: the review VERDICT this
    // comment carries ('approve' | 'request-changes'). The validator's
    // review-required assertion accepts ONLY a verdict=approve marker as
    // structural review evidence — claim markers (no verdict) never satisfy it.
    verdict?: string;
  };
}

// A comment read back off a record (revision loop). BuildAgent's
// revision path lists a PR's comments to (a) count ReviewAgent `request-changes`
// rounds for the bounded-retry budget and (b) read the latest findings text to
// feed the revision. `structural` is the ADR 0009 §D marker parsed off the
// leading HTML comment (`sf:agent=<role> run=<run> verdict=<verdict>`); absent
// on non-structural comments.
export interface ListedComment {
  commentId: string;
  body: string;
  structural?: {
    role: string;
    run: string;
    verdict?: string;
  };
}

export type IssueToolResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface IssueTool {
  read(recordId: string): Promise<IssueToolResult<IssueRecord>>;
  applyLabel(args: IssueLabelArgs): Promise<IssueToolResult<{ recordId: string; label: string }>>;
  removeLabel(args: IssueLabelArgs): Promise<IssueToolResult<{ recordId: string; label: string }>>;
  // Close the issue with a GitHub `state_reason` (OpsAgent's
  // post-merge bookkeeping closes a status:done Task so the board never shows
  // open-but-done records). Idempotent — closing an already-closed issue is a
  // no-op success (GitHub returns 200).
  close(args: IssueCloseArgs): Promise<IssueToolResult<{ recordId: string }>>;
  comment(args: IssueCommentArgs): Promise<IssueToolResult<{ commentId: string }>>;
  create(args: IssueCreateArgs): Promise<IssueToolResult<{ recordId: string; number: number }>>;
  // Append a single line to the record body (BuildAgent writes the
  // `pr-ref: <PR recordId>` backlink onto the Task at PR-open; OpsAgent's
  // post-merge bookkeeping REQUIRES it for bidirectional pairing). Idempotent:
  // if the exact line already exists in the body, the call returns ok WITHOUT
  // writing.
  appendToBody(recordId: string, line: string): Promise<IssueToolResult<{ recordId: string }>>;
  // List a record's comments newest-last. The revision loop reads a
  // PR's comments to count ReviewAgent `request-changes` rounds (budget) and pull
  // the latest findings text. Real impl resolves via GraphQL comments(last:100);
  // the structural marker is parsed off each leading HTML comment.
  listComments(recordId: string): Promise<IssueToolResult<ReadonlyArray<ListedComment>>>;
}

export class StubIssueTool implements IssueTool {
  private readonly records: Map<string, IssueRecord> = new Map();
  private readonly labelApplies: IssueLabelArgs[] = [];
  private readonly labelRemoves: IssueLabelArgs[] = [];
  private readonly closes: IssueCloseArgs[] = [];
  private readonly comments: IssueCommentArgs[] = [];
  // Per-record comment store: listComments reads these back. comment()
  // pushes here; seedComment() pre-seeds a findings comment for revision tests.
  private readonly commentsByRecord: Map<string, ListedComment[]> = new Map();
  private readonly creates: IssueCreateArgs[] = [];
  private readonly appends: Array<{ recordId: string; line: string }> = [];
  private nextCommentId = 1;
  private nextIssueNumber = 1;

  // Test setup: seed a record (the real impl pulls from GitHub).
  seedRecord(record: IssueRecord): void {
    this.records.set(record.recordId, record);
  }

  async read(recordId: string): Promise<IssueToolResult<IssueRecord>> {
    const record = this.records.get(recordId);
    if (record === undefined) {
      return { ok: false, reason: `record_not_found:${recordId}` };
    }
    return { ok: true, value: { ...record, labels: [...record.labels] } };
  }

  async applyLabel(
    args: IssueLabelArgs,
  ): Promise<IssueToolResult<{ recordId: string; label: string }>> {
    this.labelApplies.push(args);
    return { ok: true, value: { recordId: args.recordId, label: args.label } };
  }

  async removeLabel(
    args: IssueLabelArgs,
  ): Promise<IssueToolResult<{ recordId: string; label: string }>> {
    this.labelRemoves.push(args);
    return { ok: true, value: { recordId: args.recordId, label: args.label } };
  }

  async close(args: IssueCloseArgs): Promise<IssueToolResult<{ recordId: string }>> {
    this.closes.push(args);
    return { ok: true, value: { recordId: args.recordId } };
  }

  async comment(args: IssueCommentArgs): Promise<IssueToolResult<{ commentId: string }>> {
    this.comments.push(args);
    const commentId = `stub-comment-${this.nextCommentId}`;
    this.nextCommentId += 1;
    // Mirror into the per-record store so listComments reads it back.
    // The stub keeps `structural` as a parsed field (the real impl prepends the
    // ADR 0009 §D marker into the body and parses it back); the body is the raw
    // human-readable text the caller passed.
    const listed: ListedComment = { commentId, body: args.body, structural: args.structural };
    const existing = this.commentsByRecord.get(args.recordId);
    if (existing === undefined) {
      this.commentsByRecord.set(args.recordId, [listed]);
    } else {
      existing.push(listed);
    }
    return { ok: true, value: { commentId } };
  }

  // Test setup: pre-seed a comment on a record so listComments returns it without
  // a prior comment() call (revision tests seed a ReviewAgent request-changes
  // findings comment on the PR).
  seedComment(recordId: string, comment: ListedComment): void {
    const existing = this.commentsByRecord.get(recordId);
    if (existing === undefined) {
      this.commentsByRecord.set(recordId, [comment]);
    } else {
      existing.push(comment);
    }
  }

  async listComments(recordId: string): Promise<IssueToolResult<ReadonlyArray<ListedComment>>> {
    return { ok: true, value: [...(this.commentsByRecord.get(recordId) ?? [])] };
  }

  async create(
    args: IssueCreateArgs,
  ): Promise<IssueToolResult<{ recordId: string; number: number }>> {
    this.creates.push(args);
    const number = this.nextIssueNumber;
    this.nextIssueNumber += 1;
    // Synthetic GraphQL node_id of the same shape the validator sees.
    const recordId = `I_stub_${args.repo.replace(/[^a-zA-Z0-9]/g, '_')}_${number}`;
    // Auto-seed the created record so subsequent read() calls work.
    this.records.set(recordId, {
      recordId,
      labels: [...args.labels],
      body: args.body,
    });
    return { ok: true, value: { recordId, number } };
  }

  async appendToBody(
    recordId: string,
    line: string,
  ): Promise<IssueToolResult<{ recordId: string }>> {
    const record = this.records.get(recordId);
    if (record === undefined) {
      return { ok: false, reason: `record_not_found:${recordId}` };
    }
    // Idempotent: the exact line already present → ok without a write.
    if (record.body.split('\n').includes(line)) {
      return { ok: true, value: { recordId } };
    }
    this.appends.push({ recordId, line });
    this.records.set(recordId, { ...record, body: `${record.body}\n${line}` });
    return { ok: true, value: { recordId } };
  }

  // Test-only inspection.
  labelApplyHistory(): readonly IssueLabelArgs[] {
    return this.labelApplies;
  }
  labelRemoveHistory(): readonly IssueLabelArgs[] {
    return this.labelRemoves;
  }
  closeHistory(): readonly IssueCloseArgs[] {
    return this.closes;
  }
  commentHistory(): readonly IssueCommentArgs[] {
    return this.comments;
  }
  createHistory(): readonly IssueCreateArgs[] {
    return this.creates;
  }
  appendHistory(): ReadonlyArray<{ recordId: string; line: string }> {
    return this.appends;
  }
}
