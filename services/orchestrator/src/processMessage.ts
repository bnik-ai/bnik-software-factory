// Spec: docs/architecture.md (L4 orchestrator path) — orchestrates one
// transition message: gate-on-verdict → branch-sync-gate (review only)
// → route → dispatch (or no-op) → ack/deadletter.
// Invariants:
//   - Verdict gate: dispatch only on verdict==='accept'. `flag` / `reject`
//     mean the validator HARD-REJECTed or SOFT-FLAGed the transition; the
//     audit ledger already recorded the outcome and the orchestrator MUST
//     NOT turn a policy violation into agent work.
//     A missing verdict is treated as accept for v0 wire compatibility
//     (in-memory tests and older callers don't populate the field); the
//     accept-default avoids silently dropping legitimate work from a
//     producer that omits it.
//   - Rebase-dispatch transient/deterministic split:
//     when the branch-sync gate fires but the BuildAgent rebase dispatch
//     itself fails, distinguish transient (SB throttling, network) from
//     deterministic (auth, shape). Transient → `action: 'retry'` so
//     mainConsumer leaves the inbound unsettled; SB redelivers and the
//     rebase retries on a fresh execution. (`action: 'deadletter'` is
//     one-way to DLQ — does not redeliver — so it is wrong for
//     transient.) Deterministic → ack with rebaseDispatchError so
//     operators see the gap without an infinite redelivery loop.
//     Classification lives at the dispatcher boundary
//     (DispatchResult.transient).
//   - Branch-sync gate (ADR 0010 §"Re-sync onto main" / ADR 0012):
//     for the review-trigger routing keys (pr:open→in_review and friends),
//     the orchestrator checks that the feeder branch is current with the
//     base branch before dispatching ReviewAgent. If the branch is behind,
//     a stale-base review can pass yet break on merge — so the gate
//     **dispatches BuildAgent with a synthetic rebase-intent message**
//     (kind='pr', toState='needs_sync_for_review' — BuildAgent's
//     runRebaseForReview handler recognizes it) instead of dispatching
//     ReviewAgent, and returns `review_blocked_by_stale_base` with the
//     rebase dispatch id. BuildAgent rebases + force-pushes the ephemeral
//     feeder branch (ADR 0008); the resulting PR push event re-triggers
//     the review-trigger transition, the gate re-checks (now 'current'),
//     and ReviewAgent dispatches normally. v0 default checker
//     (AlwaysCurrentBranchSyncChecker) is pass-through so existing
//     tests + in-memory boot are unchanged.
//   - Routing failures (`unknown_kind`, `unknown_transition`) deadletter
//     so humans investigate. The orchestrator never silently no-ops on
//     an unrecognized transition.
//   - Routing-no-dispatch results ACK cleanly (the validator already
//     recorded the transition; orchestrator confirms no agent action
//     needed). Distinct from deadletter — no error, just nothing to do.
//   - Dispatch failures bubble up so the consumer's lock times out and
//     the message redelivers (per the same session-order discipline the
//     validator uses).
//   - This module knows nothing about Service Bus or audit ledger — it
//     receives a parsed message and returns a Processing Decision the
//     caller acts on.

import type { AgentDispatcher } from './agentDispatcher.js';
import {
  AlwaysCurrentBranchSyncChecker,
  type BranchSyncChecker,
  isReviewTriggerTransition,
} from './branchSyncChecker.js';
import type { routeTransition } from './routingTable.js';
import type { SubstrateClient } from './substrateClient.js';
import type { ParsedTransitionMessage, TransitionVerdict } from './types.js';

const DEFAULT_BASE_BRANCH = 'main';

// BuildAgent's rebase handler matches on this synthetic toState (see
// services/agents/src/agents/buildAgent.ts REBASE_FOR_REVIEW_TO_STATE).
const REBASE_FOR_REVIEW_TO_STATE = 'needs_sync_for_review';

// AgentRole used for the rebase dispatch — same role that does the
// original build, just a different message intent.
const REBASE_AGENT_ROLE = 'BuildAgent' as const;

// OpsAgent runs the post-merge Task bookkeeping for ANY merge.
const MERGE_BOOKKEEPING_AGENT = 'OpsAgent' as const;

export interface ProcessMessageDeps {
  router: typeof routeTransition;
  dispatcher: AgentDispatcher;
  // Optional for v0 wire compatibility. Defaults to
  // AlwaysCurrentBranchSyncChecker (pass-through) when omitted, so
  // callers without a checker get no gate. Real impl is wired by
  // mainConsumer.startConsumer() once a SubstrateClient is available
  // for branch-compare queries against GitHub.
  branchSyncChecker?: BranchSyncChecker;
  // Required for the paired-Task review-trigger path:
  // resolves task body → pr-ref → PR's headBranch/baseBranch so the
  // existing branch-sync gate applies. Absent in v0 (the gate is
  // skipped on the task path when no SubstrateClient is configured —
  // matches the same "skip when we can't see headBranch" rule the
  // pr:* path uses for backward-compat). Wired by mainConsumer at
  // boot when env-driven GitHub config is present.
  substrateClient?: SubstrateClient;
  // Default base branch for the sync check when the message doesn't
  // carry one explicitly. ADR 0002 sets trunk-based main; this is the
  // seam for non-main bases in future ADRs.
  defaultBaseBranch?: string;
  // Optional repo-targeting allowlist (AGENT_TARGET_REPOS,
  // comma-separated owner/repo — parsed in mainConsumer). The un-suspended
  // installation streams non-target-repo events (SF / sample-console PRs)
  // end-to-end: the validator RECORDS them (correct — full audit), but
  // dispatching agents for repos they aren't pinned to fails typed
  // cross-repo reads (review_agent_pr_read_failed; agents are pinned via
  // AGENT_DEFAULT_REPO). When configured AND the message carries a
  // repoFullName NOT in the set, processMessage acks `repo_not_targeted`
  // BEFORE routing. Unset allowlist OR missing repoFullName (installation-
  // lifecycle messages) → no filtering (backward compat).
  targetRepoAllowlist?: ReadonlySet<string>;
}

export type ProcessingDecision =
  | { action: 'ack'; outcome: 'dispatched'; agent: string; dispatchId: string }
  | { action: 'ack'; outcome: 'no_dispatch'; transitionKey: string }
  // The message targets a repo outside AGENT_TARGET_REPOS.
  // Clean ack (the validator already recorded the transition); no agent
  // routing/dispatch. mainConsumer treats this like no_dispatch.
  | { action: 'ack'; outcome: 'repo_not_targeted'; repoFullName: string; transitionKey: string }
  | {
      action: 'ack';
      outcome: 'verdict_gated';
      verdict: Exclude<TransitionVerdict, 'accept'>;
      transitionKey: string;
    }
  | {
      action: 'ack';
      outcome: 'review_blocked_by_stale_base';
      transitionKey: string;
      headBranch: string;
      baseBranch: string;
      behindBy?: number;
      // Populated when the gate successfully dispatched BuildAgent to
      // rebase (the common case). Absent when the gate fired but the
      // rebase dispatch itself failed deterministically — in which case
      // `rebaseDispatchError` is populated and the operator sees the gap
      // without redelivery looping. Transient rebase-dispatch failures
      // use `action: 'retry'` instead so SB redelivers.
      rebaseDispatchId?: string;
      rebaseDispatchError?: string;
    }
  // Transient failures: the consumer MUST leave the inbound unsettled so SB
  // redelivers. The `deadletter` action calls consumer.deadletter()
  // which is one-way to DLQ — no redelivery. So transient signals use a
  // dedicated `retry` action; mainConsumer.ts logs the reason and exits
  // the loop without settling, matching the same session-order
  // discipline as a thrown error (SB redelivers on the next job
  // execution).
  | { action: 'retry'; reason: string }
  | { action: 'deadletter'; reason: string };

const TRANSITION_KEY_DELIM = '→';

function transitionKeyOf(message: ParsedTransitionMessage): string {
  return `${message.kind}:${message.fromState}${TRANSITION_KEY_DELIM}${message.toState}`;
}

// Output envelope for resolveBranchSyncInputs:
//   resolved → run the gate with these head/base/prRecordId values
//   skip     → no inputs available (v0 pass-through); fall through to dispatch
//   deadletter → typed substrate failure on the task path; surface to operator
type BranchSyncInputs =
  | { kind: 'resolved'; headBranch: string; baseBranch: string; prRecordId: string }
  | { kind: 'skip' }
  | { kind: 'deadletter'; reason: string };

async function resolveBranchSyncInputs(
  message: ParsedTransitionMessage,
  deps: ProcessMessageDeps,
): Promise<BranchSyncInputs> {
  const baseDefault = deps.defaultBaseBranch ?? DEFAULT_BASE_BRANCH;

  // Task path: the message itself has no head/base; resolve
  // via SubstrateClient. If no SubstrateClient is wired (v0 boot), skip
  // — matches the pr:* path's "skip when we can't see headBranch" rule.
  if (
    message.kind === 'task' &&
    message.fromState === 'in_progress' &&
    message.toState === 'in_review'
  ) {
    if (deps.substrateClient === undefined) {
      return { kind: 'skip' };
    }
    const lookup = await deps.substrateClient.getTaskHeadBranch(message.recordId);
    if (!lookup.ok) {
      // Typed substrate failure — surface to operator (same posture as
      // a checker failure: don't risk dispatching ReviewAgent against an
      // unknown-state base, but also don't silently no-op).
      return {
        kind: 'deadletter',
        reason: `branch_sync_input_lookup_failed:${transitionKeyOf(message)}:${lookup.reason}`,
      };
    }
    return {
      kind: 'resolved',
      headBranch: lookup.value.headBranch,
      baseBranch: lookup.value.baseBranch,
      prRecordId: lookup.value.prRecordId,
    };
  }

  // PR path: head/base arrive on the message (validator-populated).
  // When absent, skip — the existing v0 wire stays unaffected.
  if (message.headBranch !== undefined && message.headBranch.length > 0) {
    return {
      kind: 'resolved',
      headBranch: message.headBranch,
      baseBranch: message.baseBranch ?? baseDefault,
      prRecordId: message.recordId,
    };
  }
  return { kind: 'skip' };
}

export async function processMessage(
  message: ParsedTransitionMessage,
  deps: ProcessMessageDeps,
): Promise<ProcessingDecision> {
  // Repo-targeting gate — BEFORE verdict/routing: agent work
  // only targets allowlisted repos. The validator already recorded the
  // transition for ALL repos the installation covers; this gate only stops
  // the orchestrator from dispatching agents pinned to AGENT_DEFAULT_REPO
  // against a foreign repo (typed review_agent_pr_read_failed DLQs).
  // Messages WITHOUT a repoFullName (installation lifecycle, older wire)
  // pass through unfiltered.
  if (
    deps.targetRepoAllowlist !== undefined &&
    message.repoFullName !== undefined &&
    !deps.targetRepoAllowlist.has(message.repoFullName)
  ) {
    return {
      action: 'ack',
      outcome: 'repo_not_targeted',
      repoFullName: message.repoFullName,
      transitionKey: transitionKeyOf(message),
    };
  }

  // Non-autonomous-merge Task bookkeeping — BEFORE the verdict
  // gate. A human merge (e.g. at the request-changes gate) arrives as
  // pull_request.closed merged:true → pr:<from>→merged, which the PR FSM FLAGS
  // (human is not an allowed merge actor; in_review→merged is not even a legal
  // edge) — so the verdict gate below would drop it and the paired Task would
  // stay status:ready, blocking dependents FOREVER. The merge is the substrate
  // of record (already landed on GitHub) and the validator already recorded
  // the honest flagged verdict in
  // the audit ledger; dispatch OpsAgent for bookkeeping-only regardless of
  // verdict so dependents replan.
  //
  // EXCLUDE actor=OpsAgent: an autonomous merge already ran completePairedTask
  // INLINE during its pr:in_review→approved run, so dispatching here would
  // enqueue a SECOND OpsAgent run that races the inline one on the non-session
  // agent-runs-ops queue (both read the Task as still `ready` → duplicate
  // marker comments / closes; the skipped_already_done guard only converges
  // AFTER one run's writes are visible). The autonomous path needs no
  // carve-out; its replay-recovery is the already_merged gate in opsAgent.ts.
  // After the repo-targeting gate (agents are pinned to AGENT_DEFAULT_REPO; a
  // foreign-repo merge must still ack repo_not_targeted above, not dispatch).
  if (message.kind === 'pr' && message.toState === 'merged' && message.actor !== 'OpsAgent') {
    const dispatch = await deps.dispatcher.dispatch({
      agent: MERGE_BOOKKEEPING_AGENT,
      message,
      transitionKey: transitionKeyOf(message),
    });
    if (!dispatch.ok) {
      return { action: 'deadletter', reason: `dispatch:${dispatch.agent}:${dispatch.reason}` };
    }
    return {
      action: 'ack',
      outcome: 'dispatched',
      agent: dispatch.agent,
      dispatchId: dispatch.dispatchId,
    };
  }

  // Verdict gate: validator already recorded flagged/rejected outcomes in
  // the audit ledger; orchestrator MUST NOT dispatch agent work on them.
  // Undefined verdict = accept-default (v0 wire compatibility; see header).
  if (message.verdict !== undefined && message.verdict !== 'accept') {
    return {
      action: 'ack',
      outcome: 'verdict_gated',
      verdict: message.verdict,
      transitionKey: transitionKeyOf(message),
    };
  }

  const route = deps.router(message);

  if (!route.ok) {
    if (route.reason === 'no_dispatch_needed') {
      return { action: 'ack', outcome: 'no_dispatch', transitionKey: route.transitionKey };
    }
    return {
      action: 'deadletter',
      reason: `route:${route.reason}:${route.transitionKey}`,
    };
  }

  // Branch-sync gate (ADR 0010 §"Re-sync onto main"; ReviewAgent design
  // §2 step 0). For review-trigger transitions ONLY, check that the
  // feeder branch is current with the base before dispatching ReviewAgent
  // — otherwise a stale-base review can pass yet break on merge as other
  // agents land changes.
  //
  // Two routes resolve the head/base inputs:
  //   PR path (pr:*→...) — headBranch arrives on the message itself
  //     (validator populates via SubstrateClient lookup).
  //     When absent the check is skipped (v0 pass-through).
  //   Task path (task:in_progress→in_review) — the task
  //     message carries no head/base; the orchestrator resolves them via
  //     SubstrateClient (task body's `pr-ref:` → PR's head/base ref).
  //     When SubstrateClient is unconfigured (v0 in-memory boot), skip
  //     the check — matches the pr:* path's skip-when-missing semantics.
  //     The synthetic rebase dispatch uses the resolved PR's recordId so
  //     BuildAgent's runRebaseForReview operates against the PR, not the
  //     task — kind on the synthetic message is therefore 'pr', overriding
  //     the source message's 'task' kind (BuildAgent's handler matches on
  //     kind='pr' + toState='needs_sync_for_review').
  if (isReviewTriggerTransition(message)) {
    const checker = deps.branchSyncChecker ?? new AlwaysCurrentBranchSyncChecker();
    const resolved = await resolveBranchSyncInputs(message, deps);
    if (resolved.kind === 'deadletter') {
      return { action: 'deadletter', reason: resolved.reason };
    }
    if (resolved.kind === 'skip') {
      // Either no headBranch on the wire (pr:* legacy path) or no
      // SubstrateClient configured (task:* v0 boot). Fall through to
      // normal dispatch without the gate.
    } else {
      const { headBranch, baseBranch, prRecordId } = resolved;
      const syncResult = await checker.checkSync({
        headBranch,
        baseBranch,
        prRecordId,
      });
      if (syncResult.ok && syncResult.status === 'behind') {
        // Dispatch BuildAgent with the synthetic rebase-intent message
        // (ADR 0012 item 5 Option B). The BuildAgent's runRebaseForReview
        // handler matches on kind='pr' + toState='needs_sync_for_review';
        // see services/agents/src/agents/buildAgent.ts.
        const rebaseMessage: ParsedTransitionMessage = {
          ...message,
          eventType: 'synthetic:branch_sync_required',
          actor: 'system',
          // Force kind='pr' so BuildAgent's handler matches even when the
          // source transition was task:in_progress→in_review.
          kind: 'pr',
          // Target the PR record — the rebase operates on PR's feeder
          // branch, not the task's record_node_id (task path) / PR record
          // (pr:* path coincide here).
          recordId: prRecordId,
          toState: REBASE_FOR_REVIEW_TO_STATE,
          // Preserve fromState so the audit ledger can join the rebase
          // run back to the original transition.
          deliveryId: `${message.deliveryId}:rebase`,
          headBranch,
          baseBranch,
          // Tell BuildAgent how to re-dispatch review after the
          // rebase. A PR-kind trigger to in_review means the PR ledger is already
          // at in_review (native review-request OR a status:in_review claim) →
          // 'bounce'; everything else (pr:*→open, task:in_progress→in_review) is a
          // claim trigger with the PR ledger at open → 'claim'.
          reReviewMode:
            message.kind === 'pr' && message.toState === 'in_review' ? 'bounce' : 'claim',
        };
        const rebaseDispatch = await deps.dispatcher.dispatch({
          agent: REBASE_AGENT_ROLE,
          message: rebaseMessage,
          transitionKey: `pr:${message.fromState}${TRANSITION_KEY_DELIM}${REBASE_FOR_REVIEW_TO_STATE}`,
        });
        if (rebaseDispatch.ok) {
          return {
            action: 'ack',
            outcome: 'review_blocked_by_stale_base',
            transitionKey: route.transitionKey,
            headBranch,
            baseBranch,
            behindBy: syncResult.behindBy,
            rebaseDispatchId: rebaseDispatch.dispatchId,
          };
        }
        // Rebase dispatch failed — distinguish transient
        // from deterministic. A transient SB error (throttling, network)
        // will likely succeed on the next attempt → return `retry` so
        // mainConsumer leaves the inbound unsettled and SB redelivers
        // on the next execution. A deterministic error (auth, shape)
        // won't change on retry → ack with rebaseDispatchError so
        // operators see the gap without an infinite redelivery loop.
        // The PR stays in in_review either way until the next push event
        // (a real rebase) or operator intervention.
        if (rebaseDispatch.transient === true) {
          return {
            action: 'retry',
            reason: `rebase_dispatch_transient:${route.transitionKey}:${rebaseDispatch.agent}:${rebaseDispatch.reason}`,
          };
        }
        return {
          action: 'ack',
          outcome: 'review_blocked_by_stale_base',
          transitionKey: route.transitionKey,
          headBranch,
          baseBranch,
          behindBy: syncResult.behindBy,
          rebaseDispatchError: `${rebaseDispatch.agent}:${rebaseDispatch.reason}`,
        };
      }
      if (!syncResult.ok) {
        // Treat checker failure as "don't know" — DON'T dispatch
        // ReviewAgent against potentially-stale base. Surface as a
        // typed deadletter so the operator can see the gap; safer
        // than dispatching and risking a stale-base approval.
        return {
          action: 'deadletter',
          reason: `branch_sync_check_failed:${route.transitionKey}:${syncResult.reason}`,
        };
      }
    }
  }

  const dispatch = await deps.dispatcher.dispatch({
    agent: route.agent,
    message,
    transitionKey: route.transitionKey,
  });

  if (!dispatch.ok) {
    return {
      action: 'deadletter',
      reason: `dispatch:${dispatch.agent}:${dispatch.reason}`,
    };
  }

  return {
    action: 'ack',
    outcome: 'dispatched',
    agent: dispatch.agent,
    dispatchId: dispatch.dispatchId,
  };
}
