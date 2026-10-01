// Spec: docs/architecture.md (L3 OpsAgent merges approved PRs) + ADR 0002
// (trunk-based main; merges land directly to main) + ADR 0012
// (review-loop re-sync — pre-merge stale-base check is the code-path
// mitigation).
// Invariants:
//   - Triggered by routing key `pr:in_review→approved`. Defensive guard
//     returns typed wrong_transition failure if mis-routed.
//   - **Pre-merge stale-base gate.** ADR 0012 item 1
//     requires the feeder branch be current with main BEFORE the
//     approved verdict; the orchestrator's pre-review gate (branchSyncChecker.ts)
//     covers review-trigger transitions but NOT pr:in_review→approved,
//     and the substrate-edge mitigation (GitHub ruleset's
//     strict_required_status_checks_policy) is INACTIVE in v0 because
//     CI hasn't been wired yet. OpsAgent therefore re-checks sync via
//     pulls.getSyncStatus(recordId) right before pulls.merge() — if
//     behind, returns typed ops_agent_stale_base_at_merge:<head>...<base>
//     and does NOT merge. The orchestrator deadletters and the
//     resulting BuildAgent rebase + re-review re-fires the loop. Once
//     CI lands and substrate's required_status_checks is populated,
//     the GitHub-edge enforcement gives belt-and-suspenders.
//   - **Idempotent merge (at-least-once delivery).** Before the stale-base
//     gate, OpsAgent reads the PR: state='merged' (redelivered approved
//     event, or replay-recovery for a merged PR whose Task was never
//     bookkept) skips the gate + merge + merge note and proceeds straight
//     to the post-merge Task bookkeeping, reporting merge=already_merged.
//     state='closed' (unmerged) is a typed ops_agent_pr_closed_unmerged
//     failure. A pre-read failure falls through to the normal merge path.
//   - v0 minimum (post-gate): squash-merge the PR. The repo rulesets
//     allow squash; the real impl surfaces any
//     GraphQL rejection from branch protection as a typed
//     pull_merge_failed reason.
//   - Posts a structural comment on the PR per ADR 0009 §D naming the
//     merge SHA. The Deployment FSM is fired by GitHub's
//     workflow_run / deployment_status events on the merge commit; this
//     agent has no direct deployment responsibility.
//   - **Post-merge Task bookkeeping.** After a successful merge,
//     OpsAgent resolves the paired Task from the PR body's `task-ref:` line
//     (BuildAgent writes `task-ref: <Task recordId>` — buildAgent.ts). The
//     pairing is bidirectional and ENFORCED: the Task body
//     MUST carry a `pr-ref:` backlink pointing at THIS PR (BuildAgent writes
//     it at PR-open — buildAgent.ts writePrRefBacklink); a missing or
//     mismatched backlink is a typed skip, because `task-ref:` alone rides
//     the mutable PR body. Verified, OpsAgent drives the Task FSM to `done`
//     via status labels: structural-marker
//     comment FIRST (`sf:agent=ops@none run=<ulid>`, ADR 0009 §D), then
//     APPLY `status:done`, then REMOVE the prior status label — apply-then-
//     remove so a failure can never strand the Task with no status label
//     (the validator tolerates the dual-label window; the swap-cleanup
//     removal is observational per transitionResolver.ts). The
//     FSM path: v0 BuildAgent never claims the Task (no ready→in_progress→
//     in_review label drives), so at merge time the Task sits at `ready` —
//     taskFsm.ts admits OpsAgent on ready→done and on the
//     existing in_review→done. The emitted task:{ready|in_review}→done is
//     routingTable.ts's PlannerAgent dep-clear re-plan trigger (ADR 0013 §4),
//     which cascades blocked decomposed Tasks to `ready`.
//   - Bookkeeping failures NEVER un-merge: the merge is the load-bearing
//     outcome. Every bookkeeping outcome (done / skipped / failed) lands as
//     a typed `task_bookkeeping=...` token in the ok:true result string so
//     the gap is operator-visible in the audit ledger; a missing `task-ref:`
//     is a typed skip, not a failure.
//   - **Any-merge bookkeeping.** Post-merge bookkeeping must run
//     on ANY merge, not only the autonomous in_review→approved→merge path. A
//     human merge (e.g. at the request-changes gate) arrives as
//     pull_request.closed merged:true → pr:<from>→merged; the orchestrator
//     dispatches OpsAgent for this transition (processMessage.ts). The PR is
//     ALREADY merged on the substrate, so the merged branch SKIPS the merge /
//     stale-base gate / merge note and runs the SAME completePairedTask the
//     autonomous path runs. Idempotent: completePairedTask's internal guards
//     no-op an already-done Task (skipped_already_done), so the autonomous
//     path's own pr:approved→merged event reconciles harmlessly.
//   - **Close the Task issue on done.** When bookkeeping drives a
//     Task to status:done, also close the GitHub issue with reason=completed
//     (a status:done Task must not linger OPEN — the board would show
//     open-but-done records). Like the swap-cleanup removal this is
//     post-transition hygiene: the ready|in_review→done edge already landed
//     with the apply, so a close failure does not un-do it (appended token).
//     Idempotent — GitHub returns 200 closing an already-closed issue.

import type { AgentResult } from '../agentRegistry.js';
import type { IssueTool } from '../tools/issueTool.js';
import type { PullTool } from '../tools/pullTool.js';
import type { ParsedTransitionMessage } from '../types.js';

export interface OpsAgentDeps {
  pulls: PullTool;
  // GitHub-only IssueTool (buildIssueTool seam) for the post-merge Task
  // bookkeeping — gated on the App credentials ALONE, never ANTHROPIC_API_KEY
  // (OpsAgent calls no LLM; see buildOpsDeps).
  issues: IssueTool;
  // Backlink-race retry knobs: the review/merge chain can
  // outrun BuildAgent's post-open backlink PATCH; on an sf/-branch PR a
  // missing backlink is re-read up to `backlinkRetryAttempts` times with
  // `backlinkRetryDelayMs` between reads before the typed skip. Defaults
  // 3 × 4000ms; tests override.
  backlinkRetryAttempts?: number;
  backlinkRetryDelayMs?: number;
  runId: string;
}

const ROLE = 'OpsAgent' as const;

// ADR 0009 §D structural attribute `sf:agent=<role@model>`. OpsAgent is a
// deterministic merge agent — no LLM, so no real model segment; `none`
// satisfies the ADR 0008 model grammar (`[a-z0-9.-]+`) so the validator's
// attributionStamp parser resolves role=ops → OpsAgent instead of rejecting a
// bare-role marker as malformed_agent_spec. in_review→done is single-agent so
// its FSM fallback is authoritative; ready→done is multi-agent (OpsAgent +
// BuildAgent's already-satisfied path) so the App-actor resolver REQUIRES this
// comment marker to attribute OpsAgent — posting it first (below) is load-
// bearing there, and the run=<ulid> joins agent_runs on both edges.
const ROLE_ATTR_SPEC = 'ops@none' as const;

// BuildAgent writes `task-ref: <Task recordId>` as the first line of the PR
// body (buildAgent.ts renderPrBody). Mirrors reviewAgent.ts's PR_REF_PREFIX
// line-scan convention (PR→Task direction).
const TASK_REF_PREFIX = 'task-ref: ';

const STATUS_LABEL_PREFIX = 'status:';
const STATUS_DONE_LABEL = 'status:done';

// Marker-comment descriptors passed to completePairedTask (the human-readable
// merge phrasing inserted into the Task's structural-marker comment).
//   - autonomous path: `squash-merged as <sha>` (computed at the call site).
//   - already-merged replay (idempotent redelivery of the approved event).
const IDEMPOTENT_REPLAY_NOTE = 'previously squash-merged (idempotent replay of the approved event)';
//   - any-merge bookkeeping (human/non-App merge — no fresh
//     merge() result, and the squash SHA isn't carried through the close event).
const MERGED_BOOKKEEPING_NOTE = 'merged (post-merge bookkeeping)';
// The Task states OpsAgent may legally complete from (taskFsm.ts allowedActors
// evidence: ready→done = [OpsAgent, BuildAgent], in_review→done =
// [OpsAgent]). in_progress→done is NOT in the FSM — a Task found there (or in
// any other state) yields a typed failed token instead of an off-policy write.
const COMPLETABLE_STATUS_LABELS: ReadonlySet<string> = new Set([
  'status:ready',
  'status:in_review',
]);

export async function runOpsAgent(
  message: ParsedTransitionMessage,
  deps: OpsAgentDeps,
): Promise<AgentResult> {
  if (message.kind !== 'pr') {
    return {
      ok: false,
      reason: `ops_agent_wrong_transition:${message.kind}:${message.fromState}→${message.toState}`,
    };
  }

  // Any-merge bookkeeping. A merge that already landed on the
  // substrate (pull_request.closed merged:true → pr:<from>→merged — human or
  // App) needs ONLY the paired-Task → done bookkeeping; the merge / stale-base
  // gate / merge note are all moot (the PR is already on main). Run the SAME
  // completePairedTask the autonomous path runs — idempotent via its internal
  // guards (an already-done Task → skipped_already_done), so the autonomous
  // path's own pr:approved→merged event reconciles without double-applying.
  if (message.toState === 'merged') {
    const bookkeeping = await completePairedTask(message.recordId, MERGED_BOOKKEEPING_NOTE, deps);
    return {
      ok: true,
      result: `OpsAgent: PR ${message.recordId} post-merge bookkeeping (${message.fromState}→merged); ${bookkeeping}`,
    };
  }

  if (message.fromState !== 'in_review' || message.toState !== 'approved') {
    return {
      ok: false,
      reason: `ops_agent_wrong_transition:${message.kind}:${message.fromState}→${message.toState}`,
    };
  }

  // Idempotent-merge gate (at-least-once delivery). A redelivered
  // pr:in_review→approved AFTER a successful merge must not fail typed at the
  // merge call (GitHub 405 on an already-merged PR) with the post-merge Task
  // bookkeeping never running — it must treat already-merged as success and
  // proceed to bookkeeping (live recovery shape: replaying the approved event
  // for a merged PR whose Task was never bookkept). state='merged' → skip the
  // stale-base gate + merge + merge note (no duplicate comment), run
  // completePairedTask (its internal guards make the bookkeeping idempotent
  // too), and report merge=already_merged. state='closed' (unmerged) → typed
  // failure (merging a closed PR is off-policy). A read FAILURE falls through
  // to the normal merge path — this gate is an idempotency check, not a new
  // pre-merge failure mode; merge() surfaces real failures typed as before.
  const preRead = await deps.pulls.read(message.recordId);
  if (preRead.ok && preRead.value.state === 'merged') {
    const bookkeeping = await completePairedTask(message.recordId, IDEMPOTENT_REPLAY_NOTE, deps);
    return {
      ok: true,
      result: `OpsAgent: PR ${message.recordId} merge=already_merged; ${bookkeeping}`,
    };
  }
  if (preRead.ok && preRead.value.state === 'closed') {
    return { ok: false, reason: `ops_agent_pr_closed_unmerged:${message.recordId}` };
  }

  // Pre-merge stale-base gate (ADR 0012 §Risks code-path
  // mitigation). Re-check sync status RIGHT BEFORE merging — main may
  // have advanced between approval and now. On 'behind', return typed
  // failure; the orchestrator deadletters and BuildAgent's rebase loop
  // re-fires the review-trigger transition, which after
  // re-review eventually re-emits pr:in_review→approved against a
  // current base. On checker failure, fail-closed (safer than
  // merging against an unknown sync state).
  const sync = await deps.pulls.getSyncStatus(message.recordId);
  if (!sync.ok) {
    return { ok: false, reason: `ops_agent_sync_check_failed:${sync.reason}` };
  }
  if (sync.value.status === 'behind') {
    const behindBy = sync.value.behindBy ?? '?';
    return {
      ok: false,
      reason: `ops_agent_stale_base_at_merge:${message.recordId}:behindBy=${behindBy}`,
    };
  }

  const merged = await deps.pulls.merge({
    recordId: message.recordId,
    method: 'squash',
  });
  if (!merged.ok) {
    return { ok: false, reason: `ops_agent_pull_merge_failed:${merged.reason}` };
  }

  // submitReview with state='comment' is the substrate-compatible way to
  // post a comment on a PR (PullTool doesn't expose a generic PR comment
  // verb separate from the Review primitive). The note is purely
  // informational; the audit ledger row for the merge transition is the
  // authoritative trail.
  // Post-merge Task bookkeeping runs BEFORE the informational
  // merge note: a note failure returns ok:false (dead-letter,
  // no retry), and bookkeeping must not be hostage to it — the merge already
  // happened and dependents replan off the Task's done transition.
  const bookkeeping = await completePairedTask(
    message.recordId,
    `squash-merged as \`${merged.value.mergeSha}\``,
    deps,
  );

  const reviewNote = await deps.pulls.submitReview({
    recordId: message.recordId,
    state: 'comment',
    body: `OpsAgent squash-merged this PR. Merge commit: \`${merged.value.mergeSha}\`. (Run ${deps.runId})`,
  });
  if (!reviewNote.ok) {
    // The dead-letter reason carries the bookkeeping token so the operator
    // sees the Task outcome even on the note-failure path.
    return { ok: false, reason: `ops_agent_merge_note_failed:${reviewNote.reason};${bookkeeping}` };
  }

  return {
    ok: true,
    result: `OpsAgent: merged PR ${message.recordId} as ${merged.value.mergeSha}; ${bookkeeping}`,
  };
}

// Drive the paired Task to `done` after the merge. Returns a typed
// `task_bookkeeping=...` token — NEVER throws and NEVER fails the merge
// result. Ordering mirrors reviewAgent.ts: structural-marker comment FIRST
// (actor attribution per ADR 0009 §D — and never a label transition without
// its audit comment), then APPLY status:done, then REMOVE the prior status
// label (apply-then-remove: an apply failure leaves the Task with its prior
// label, recoverable; the validator tolerates the dual-label window and
// settles the swap-cleanup removal as observational).
// mergeDescriptor is the human-readable merge phrasing inserted into the Task's
// structural-marker comment: `squash-merged as <sha>` on the autonomous merge,
// the idempotent-replay note on the already-merged path, and the any-merge note
// on a human/non-App merge — none of those last two carry a fresh
// squash SHA through the close event / PR read.
// ADR 0008 branch grammar prefix — identifies BuildAgent-authored PRs (the
// only ones whose backlink can be mid-write when the merge lands).
function isSfBranch(headBranch: string | undefined): boolean {
  return headBranch?.startsWith('sf/') ?? false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function completePairedTask(
  prRecordId: string,
  mergeDescriptor: string,
  deps: OpsAgentDeps,
): Promise<string> {
  const pr = await deps.pulls.read(prRecordId);
  if (!pr.ok) {
    return `task_bookkeeping=failed:pr_read:${pr.reason}`;
  }

  const taskRef = extractTaskRef(pr.value.body ?? '');
  if (taskRef === undefined) {
    // No `task-ref:` line (human-opened PR, legacy/seeded record). Typed skip
    // — the merge is complete; there is no Task to bookkeep.
    return 'task_bookkeeping=skipped_no_task_ref';
  }

  const task = await deps.issues.read(taskRef);
  if (!task.ok) {
    return `task_bookkeeping=failed:task_read:${task.reason}`;
  }

  // Target validation: `task-ref:` rides the MUTABLE PR
  // body — a human-edited body could point at any issue. Require the target to
  // be a real Task AND require its `pr-ref:` backlink (BuildAgent writes it
  // onto the Task body at PR-open — buildAgent.ts writePrRefBacklink) to point
  // back at THIS PR. The pairing is bidirectional and ENFORCED: a missing or
  // mismatched backlink skips typed — never status-write an unverified record.
  if (!task.value.labels.includes('kind:task')) {
    return `task_bookkeeping=skipped_not_a_task:${taskRef}`;
  }
  // A Task can carry MULTIPLE pr-ref lines (a replacement
  // PR appends a second backlink — writePrRefBacklink appends, never
  // replaces). The NEWEST (last) backlink is the active PR everywhere
  // (reviewAgent claim, orchestrator branch-sync) — and only the ACTIVE PR's
  // merge may complete the Task: an obsolete PR merging later must not mark
  // the Task done while its replacement is still in flight.
  let backRefs = extractPrRefs(task.value.body ?? '');
  let newestBackRef = backRefs[backRefs.length - 1];
  if (newestBackRef === undefined && isSfBranch(pr.value.headBranch)) {
    // The review/merge chain can outrun BuildAgent's
    // post-open backlink PATCH — on an sf/-branch (BuildAgent) PR a missing
    // backlink is most likely the seconds-wide write race, and skipping is
    // SILENT-PERMANENT (the late issues.edited settles observationally and
    // never re-runs bookkeeping). Bounded re-read before the typed skip.
    const attempts = deps.backlinkRetryAttempts ?? 3;
    const delayMs = deps.backlinkRetryDelayMs ?? 4000;
    for (let i = 0; i < attempts && newestBackRef === undefined; i++) {
      await sleep(delayMs);
      const reread = await deps.issues.read(taskRef);
      if (!reread.ok) break;
      backRefs = extractPrRefs(reread.value.body ?? '');
      newestBackRef = backRefs[backRefs.length - 1];
    }
  }
  if (newestBackRef === undefined) {
    return `task_bookkeeping=skipped_no_pr_ref_backlink:${taskRef}`;
  }
  if (newestBackRef !== prRecordId) {
    return `task_bookkeeping=skipped_pr_ref_mismatch:${taskRef}`;
  }

  const statusLabels = task.value.labels.filter((name) => name.startsWith(STATUS_LABEL_PREFIX));
  if (statusLabels.includes(STATUS_DONE_LABEL)) {
    // Idempotent re-delivery / parallel completion — the →done transition
    // already landed, nothing to drive. STILL retry the close: a prior run
    // may have applied status:done but FAILED the close,
    // leaving an open-but-done Task — and this early-return is the ONLY path a
    // replay reaches (it short-circuits before the close below). Retrying here
    // (idempotent: already-closed = 200 no-op) lets any redelivery — the
    // at-least-once duplicate of the approved/merged event, or a manual
    // re-trigger — converge the issue to closed instead of stranding it open.
    const closed = await deps.issues.close({ recordId: taskRef, reason: 'completed' });
    return closed.ok
      ? `task_bookkeeping=skipped_already_done:${taskRef}`
      : `task_bookkeeping=skipped_already_done:${taskRef}:close_failed:${closed.reason}`;
  }
  const priorStatusLabel = statusLabels[0];
  if (priorStatusLabel === undefined || statusLabels.length > 1) {
    // No status label (Task still implicit-`proposed` — a merge without a
    // ready Task is off-policy) or an ambiguous multi-label state. Surface
    // typed instead of guessing a fromState.
    return `task_bookkeeping=failed:ambiguous_status:${statusLabels.join('+') || 'none'}`;
  }
  if (!COMPLETABLE_STATUS_LABELS.has(priorStatusLabel)) {
    // taskFsm.ts admits OpsAgent→done only from ready / in_review. Driving
    // status:done from any other state would be an off-policy (FSM-flagged)
    // transition the orchestrator never dispatches on — surface typed.
    return `task_bookkeeping=failed:unsupported_from_status:${priorStatusLabel}`;
  }

  // 1. Structural-marker comment FIRST (ADR 0009 §D) so the validator's actor
  //    resolver can attribute the labeled transition from the comment marker.
  //    REQUIRED on the multi-agent ready→done edge (OpsAgent + BuildAgent);
  //    the single-agent FSM fallback still covers in_review→done.
  const marker = await deps.issues.comment({
    recordId: taskRef,
    body: `OpsAgent: paired PR ${prRecordId} ${mergeDescriptor}; completing this Task (status:done). (Run ${deps.runId})`,
    structural: { role: ROLE_ATTR_SPEC, run: deps.runId },
  });
  if (!marker.ok) {
    return `task_bookkeeping=failed:marker_comment:${marker.reason}`;
  }

  // 2. APPLY status:done — this label write IS the FSM transition
  //    (task:{ready|in_review}→done → PlannerAgent dep-clear re-plan).
  const applied = await deps.issues.applyLabel({ recordId: taskRef, label: STATUS_DONE_LABEL });
  if (!applied.ok) {
    return `task_bookkeeping=failed:apply_done:${applied.reason}`;
  }

  const fromState = priorStatusLabel.slice(STATUS_LABEL_PREFIX.length);

  // 3. REMOVE the prior status label (observational swap cleanup; removeLabel
  //    is 404-tolerant). The transition already landed with the apply — a
  //    removal failure leaves only label hygiene, reported but still done.
  const removed = await deps.issues.removeLabel({ recordId: taskRef, label: priorStatusLabel });

  // 4. CLOSE the Task issue — a status:done Task must not linger
  //    OPEN. reason=completed; idempotent (already-closed = 200 no-op). Same
  //    post-transition-hygiene class as the swap-cleanup removal: the
  //    {ready|in_review}→done edge already landed with the apply, so neither a
  //    remove nor a close failure un-does it — both surface as appended tokens.
  const closed = await deps.issues.close({ recordId: taskRef, reason: 'completed' });

  const removeNote = removed.ok ? '' : `:remove_prior_failed:${removed.reason}`;
  const closeNote = closed.ok ? '' : `:close_failed:${closed.reason}`;
  return `task_bookkeeping=done:${taskRef}:${fromState}→done${removeNote}${closeNote}`;
}

// Mirror of reviewAgent.ts extractPrRef, PR→Task direction: scan the PR body
// for the first `task-ref: ` line.
const PR_REF_PREFIX = 'pr-ref:';

// The Task body's `pr-ref: <PR recordId>` back-reference (BuildAgent appends
// it at PR-open — writePrRefBacklink; same carrier reviewAgent's paired-Task
// route reads). REQUIRED here: bookkeeping proceeds only when the backlink
// exists and points at THIS PR (bidirectional-pairing enforcement).
function extractPrRefs(body: string): string[] {
  const refs: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith(PR_REF_PREFIX)) {
      const ref = line.slice(PR_REF_PREFIX.length).trim();
      if (ref.length > 0) refs.push(ref);
    }
  }
  return refs;
}

function extractTaskRef(body: string): string | undefined {
  for (const line of body.split('\n')) {
    if (line.startsWith(TASK_REF_PREFIX)) {
      const ref = line.slice(TASK_REF_PREFIX.length).trim();
      return ref.length > 0 ? ref : undefined;
    }
  }
  return undefined;
}

// ROLE retained for parity with other agents (used in audit-log attribution
// once the orchestrator threads agent identity into the ledger). The
// structural-comment marker uses ROLE_ATTR_SPEC (`sf:agent=ops@none`, ADR
// 0009 §D) — the `role@model` form the validator's comment parser requires.
void ROLE;
