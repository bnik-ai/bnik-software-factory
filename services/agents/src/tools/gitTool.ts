// Spec: ADR 0008 (sf/<task>/<run>/<role>@<model> branch grammar) +
// ADR 0009 (SF-Agent/SF-Run/SF-Task commit trailers).
// Invariants:
//   - branch(): the name MUST match ADR 0008 grammar (validator enforces;
//     this tool's stub doesn't validate to avoid duplicating the regex;
//     a real impl should validate before calling out).
//   - commit(): the trailers field is the substrate identity per ADR 0009.
//     The author{Agent,Run,Task} args become the SF-Agent / SF-Run /
//     SF-Task trailers in the commit message body.
//   - All methods are async. Stub impls return synthetically; real impls
//     do shell-out or API calls.

export interface GitBranchArgs {
  // ADR 0008 grammar: sf/T-<id>/<ulid>/<role>@<model> (the caller mints
  // the name per the ADR; this tool just creates the ref).
  name: string;
  fromRef?: string;
}

export interface GitCommitArgs {
  message: string;
  // ADR 0009 trailer attribution.
  authorAgent: string; // e.g. 'BuildAgent'
  authorRun: string; // ULID per ADR 0008
  authorTask?: string; // Task ID (e.g. 'T-42')
  paths?: ReadonlyArray<string>; // files to stage; default = all
}

export interface GitPushArgs {
  branch: string;
  setUpstream?: boolean;
  // True for the force-push-with-lease that ephemeral feeder-branch
  // rebases need (ADR 0008 §"branches are ephemeral"; ADR 0012 §2
  // "rebase + force-push"). Real impl uses `git push --force-with-lease`
  // to refuse silent overwrites if another agent pushed concurrently.
  forceWithLease?: boolean;
}

export interface GitRebaseArgs {
  // The feeder branch to rebase (ADR 0008 grammar:
  // sf/T-<id>/<ulid>/<role>@<model>).
  headBranch: string;
  // The base to rebase onto. Default 'main' per ADR 0002.
  baseBranch: string;
}

export type GitToolResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface GitTool {
  branch(args: GitBranchArgs): Promise<GitToolResult<{ name: string }>>;
  commit(args: GitCommitArgs): Promise<GitToolResult<{ sha: string }>>;
  push(args: GitPushArgs): Promise<GitToolResult<{ branch: string }>>;
  // Rebase headBranch onto baseBranch. ADR 0012 §"Strategy: rebase, not
  // merge-in" — preserves the linear history ADR 0002 wants. The real
  // impl `git fetch origin && git checkout <head> && git rebase <base>`
  // (then BuildAgent issues a separate push with forceWithLease=true).
  // Returns { oldHeadSha, newHeadSha, treeChanged } — two independent
  // signals:
  //   - oldHeadSha vs newHeadSha: head-equality. Drives the push gate;
  //     a rebase that rewrites commits (new parents) MUST be pushed even
  //     if the resulting tree is identical, else the remote stays behind
  //     and BranchSyncChecker keeps reporting `behind` (infinite loop).
  //   - treeChanged: tree-equality only. Reserved for the downstream
  //     full-vs-delta review decision per ADR 0012 item 4 ("If the
  //     rebase changes the tree, the review surface changed → full
  //     review that round, not a delta").
  rebase(
    args: GitRebaseArgs,
  ): Promise<GitToolResult<{ oldHeadSha: string; newHeadSha: string; treeChanged: boolean }>>;
  // Report whether the worktree carries any uncommitted change
  // (staged, unstaged, OR untracked). BuildAgent checks this AFTER the coding
  // run and BEFORE commit — an empty diff means the Task is already satisfied
  // by existing code (a terminal already-done outcome), which must settle the
  // Task rather than dead-letter on `git commit`'s `nothing to commit`. Real
  // impl: changed iff the worktree is dirty (`git status --porcelain
  // --untracked-files=all`) OR the branch carries commits ahead of
  // `origin/<baseBranch>` — the coding agent has a Bash tool and may `git
  // commit` itself, so a clean worktree ALONE does NOT prove an empty diff
  // (treating it as one would drop committed work + falsely settle done).
  // The decision fetches the base first so it uses the LIVE base tip, not the
  // possibly-stale clone-time ref. `changed` is false ONLY when
  // the branch's tree equals the CURRENT base tree (clean + at-tip / no net
  // diff) — a branch merely BEHIND an advanced base is `changed:true`, never a
  // false already-satisfied. Two extra signals let BuildAgent
  // react precisely on a clean tree:
  //   - worktreeDirty: uncommitted edits present → BuildAgent commits (stamps
  //     ADR 0009 trailers) then push + PR.
  //   - committedAhead: the branch carries commits ahead of base — the coding
  //     agent self-committed (those commits lack the trailers) → fail closed
  //     rather than publish un-attributed commits.
  //   - clean + !committedAhead + changed → behind a freshly-advanced base
  //     (stale checkout) → fail closed for a re-run, never settle done.
  hasChanges(
    baseBranch: string,
  ): Promise<GitToolResult<{ changed: boolean; worktreeDirty: boolean; committedAhead: boolean }>>;
  // Current HEAD commit sha (`git rev-parse HEAD`). The revision path
  // captures HEAD before the coding run and compares after: the revision
  // branch is legitimately AHEAD of base (the open PR's commits), so the
  // committedAhead signal can't distinguish "self-committed during this run"
  // from "already ahead". A moved HEAD means the coding agent self-committed
  // (those commits lack the ADR 0009 trailers) → BuildAgent fails closed rather
  // than push un-attributed commits, the same guard the fresh-build path enforces
  // via committedAhead.
  headSha(): Promise<GitToolResult<{ sha: string }>>;
}

// In-memory stub: records every call so tests can assert the agent
// behavior + reveal the wire shape. The git-backed impl (githubGitTool.ts)
// implements this same interface.
export class StubGitTool implements GitTool {
  private readonly branchCalls: GitBranchArgs[] = [];
  private readonly commitCalls: GitCommitArgs[] = [];
  private readonly pushCalls: GitPushArgs[] = [];
  private readonly rebaseCalls: GitRebaseArgs[] = [];
  private nextSha = 1;
  // Test override: when true, the stub reports the rebase changed the
  // tree (the orchestrator's downstream check uses this to decide full
  // vs delta review per ADR 0012 item 4). Default false — the stub
  // treats the rebase tree as unchanged for tests that don't care.
  private nextRebaseTreeChanged = false;
  // Test override: when true, the stub reports the rebase
  // left the head SHA unchanged (oldHeadSha === newHeadSha → BuildAgent
  // must skip the push). Default false — the stub mints a fresh head
  // every rebase, modeling the common case where main advanced and the
  // rebase rewrote commits (push MUST fire even when tree is identical).
  private nextRebaseHeadUnchanged = false;
  // Test override: the next hasChanges() result. Default true —
  // the common real-build case has a non-empty diff (commit proceeds); tests
  // exercising the already-satisfied empty-diff path set it false.
  private nextHasChanges = true;

  async branch(args: GitBranchArgs): Promise<GitToolResult<{ name: string }>> {
    this.branchCalls.push(args);
    return { ok: true, value: { name: args.name } };
  }

  async commit(args: GitCommitArgs): Promise<GitToolResult<{ sha: string }>> {
    this.commitCalls.push(args);
    const sha = `stub-sha-${this.nextSha.toString(16).padStart(8, '0')}`;
    this.nextSha += 1;
    return { ok: true, value: { sha } };
  }

  async push(args: GitPushArgs): Promise<GitToolResult<{ branch: string }>> {
    this.pushCalls.push(args);
    return { ok: true, value: { branch: args.branch } };
  }

  async rebase(
    args: GitRebaseArgs,
  ): Promise<GitToolResult<{ oldHeadSha: string; newHeadSha: string; treeChanged: boolean }>> {
    this.rebaseCalls.push(args);
    // Mint the pre-rebase head deterministically, then the post-rebase
    // head. Two consecutive counter values keep the sequence stable for
    // tests; no timestamps / randomness.
    const oldHeadSha = `stub-pre-rebase-sha-${this.nextSha.toString(16).padStart(8, '0')}`;
    this.nextSha += 1;
    const newHeadSha = this.nextRebaseHeadUnchanged
      ? oldHeadSha
      : `stub-rebase-sha-${this.nextSha.toString(16).padStart(8, '0')}`;
    if (!this.nextRebaseHeadUnchanged) this.nextSha += 1;
    const treeChanged = this.nextRebaseTreeChanged;
    this.nextRebaseTreeChanged = false; // one-shot override
    this.nextRebaseHeadUnchanged = false; // one-shot override
    return { ok: true, value: { oldHeadSha, newHeadSha, treeChanged } };
  }

  async hasChanges(
    baseBranch: string,
  ): Promise<GitToolResult<{ changed: boolean; worktreeDirty: boolean; committedAhead: boolean }>> {
    this.hasChangesBaseBranches.push(baseBranch);
    // worktreeDirty defaults to `changed` (the normal path: uncommitted edits
    // BuildAgent will commit); the agent-already-committed and behind-base cases
    // (changed=true, worktreeDirty=false) set nextWorktreeDirty explicitly.
    const worktreeDirty = this.nextWorktreeDirty ?? this.nextHasChanges;
    const committedAhead = this.nextCommittedAhead ?? false;
    this.nextWorktreeDirty = undefined; // one-shot override
    this.nextCommittedAhead = undefined; // one-shot override
    return { ok: true, value: { changed: this.nextHasChanges, worktreeDirty, committedAhead } };
  }

  // Returns queued head shas in order (FIFO), else a stable default so the
  // common revision path reads the SAME head before/after coding (no
  // self-commit detected). Tests simulating a self-commit enqueue two distinct
  // shas via setNextHeadShas([pre, post]).
  async headSha(): Promise<GitToolResult<{ sha: string }>> {
    const sha = this.headShaQueue.shift() ?? 'stub-head-sha-stable';
    this.headShaCalls += 1;
    return { ok: true, value: { sha } };
  }

  private readonly headShaQueue: string[] = [];
  headShaCalls = 0;
  // Test-only setter: enqueue the head shas headSha() returns in order. Two
  // distinct values model the coding agent self-committing between the pre- and
  // post-coding reads.
  setNextHeadShas(shas: readonly string[]): void {
    this.headShaQueue.push(...shas);
  }

  // Records the baseBranch arg of each hasChanges() call (the real impl must
  // compare against origin/<baseBranch>, so the stub asserts BuildAgent
  // threads it).
  readonly hasChangesBaseBranches: string[] = [];
  // One-shot override for the agent-already-committed case (clean tree +
  // commits ahead → changed=true, worktreeDirty=false). Default undefined →
  // worktreeDirty mirrors nextHasChanges.
  private nextWorktreeDirty: boolean | undefined = undefined;
  // One-shot override for committedAhead (clean tree + commits ahead = agent
  // self-committed). Default undefined → false.
  private nextCommittedAhead: boolean | undefined = undefined;

  // Test-only setter: force the next hasChanges() result. false
  // models the empty-diff / already-satisfied Task the settle path handles.
  setNextHasChanges(value: boolean): void {
    this.nextHasChanges = value;
  }

  // Test-only setter: force the next hasChanges() worktreeDirty
  // independently of `changed`. Use { changed:true, worktreeDirty:false } to
  // model the agent-already-committed case (BuildAgent must skip its own commit
  // and push the agent's commits + open the PR, not dead-letter or settle done).
  setNextWorktreeDirty(value: boolean): void {
    this.nextWorktreeDirty = value;
  }

  // Test-only setter: force the next hasChanges() committedAhead.
  setNextCommittedAhead(value: boolean): void {
    this.nextCommittedAhead = value;
  }

  // Test-only setter for the next rebase's treeChanged result.
  setNextRebaseTreeChanged(value: boolean): void {
    this.nextRebaseTreeChanged = value;
  }

  // Test-only setter: force the next rebase to report
  // oldHeadSha === newHeadSha so BuildAgent's push gate skips. Models
  // the truly-no-op case (already current, nothing to rewrite).
  setNextRebaseHeadUnchanged(value: boolean): void {
    this.nextRebaseHeadUnchanged = value;
  }

  // Test-only inspection.
  branchHistory(): readonly GitBranchArgs[] {
    return this.branchCalls;
  }
  commitHistory(): readonly GitCommitArgs[] {
    return this.commitCalls;
  }
  pushHistory(): readonly GitPushArgs[] {
    return this.pushCalls;
  }
  rebaseHistory(): readonly GitRebaseArgs[] {
    return this.rebaseCalls;
  }
}
