import { deepFreeze } from './freeze.js';
import type { Actor, FsmRejectReason, Verdict } from './types.js';

// Spec: docs/design/validator-bot.md "Pull Request" table + line 209
// (PR = soft-flag).
// Invariants:
//   - PR_TRANSITIONS is deep-frozen.
//   - Off-policy transitions emit `flag`.
//   - Native GitHub state owns draft/open/closed/merged; the in_review,
//     changes_requested, syncing, and approved refinements live in the Project
//     Status field per the design.
//   - "any → closed" covers draft / open / in_review / changes_requested /
//     syncing / approved (NOT merged — merged is terminal). Author OR human closes.
//   - "approved → in_review" loop is system-driven on new commits after approval.
//   - in_review ↔ changes_requested is the changes-requested REVISION loop
//     (issue #182), mirroring GitHub's native CHANGES_REQUESTED review state.
//   - in_review → syncing → in_review is the re-sync RE-REVIEW bounce (issue
//     #192/#119): BuildAgent rebases a behind PR before review, then bounces
//     through `syncing` so the status:in_review re-apply is a real labeled event
//     that re-fires the (now-current) review-trigger to ReviewAgent.
//     ReviewAgent drives in_review→changes_requested (a request-changes verdict);
//     BuildAgent drives changes_requested→in_review after pushing a revision to
//     the same branch (orchestrator dispatches it off pr:in_review→changes_requested
//     per routingTable.ts). Both edges are single-actor → the App-actor resolver
//     uses the single-agent FSM fallback (the agent also posts a structural
//     marker). The loop runs on the PR FSM because in v0 the paired Task stays at
//     status:ready through review (BuildAgent drives the PR draft→in_review, never
//     the Task), so the Task FSM never reaches in_review to bounce.

export type PrState =
  | 'draft'
  | 'open'
  | 'in_review'
  | 'changes_requested'
  | 'syncing'
  | 'approved'
  | 'merged'
  | 'closed';

// See goalFsm.ts header for __initial__ rationale. PR creations come from
// `pull_request.opened` webhooks; draft flag in the webhook payload
// disambiguates which first-state. BuildAgent is the canonical author;
// humans can also open PRs (e.g., maintainers patching directly).
export type PrFromState = PrState | '__initial__';

interface AllowedTransition {
  readonly allowedActors: ReadonlyArray<Actor>;
}

// "author or human" in the design. In the SF flow, BuildAgent is the
// canonical PR author; humans can also close their own PRs.
const AUTHOR_OR_HUMAN: ReadonlyArray<Actor> = ['human', 'BuildAgent'];

// open → in_review and draft → in_review both fire on pull_request.
// review_requested webhooks. GitHub allows requesting reviewers on
// draft PRs too, so the same actor list applies to both rows.
// Author + maintainer + any agent can request reviews.
const REVIEW_REQUESTERS: ReadonlyArray<Actor> = [
  'human',
  'BuildAgent',
  'ReviewAgent',
  'OpsAgent',
  'system',
];

export const PR_TRANSITIONS: Readonly<
  Record<PrFromState, Readonly<Record<string, AllowedTransition>>>
> = deepFreeze({
  __initial__: {
    draft: { allowedActors: AUTHOR_OR_HUMAN },
    open: { allowedActors: AUTHOR_OR_HUMAN },
  },
  draft: {
    open: { allowedActors: ['BuildAgent'] },
    // draft → in_review: requesting a review on a draft PR (GitHub
    // allows this). PR #47 review surfaced that prior code emitted
    // draft → in_review from the resolver but the FSM had no rule,
    // causing soft-flag on every draft-PR review request.
    in_review: { allowedActors: REVIEW_REQUESTERS },
    closed: { allowedActors: AUTHOR_OR_HUMAN },
  },
  open: {
    in_review: { allowedActors: REVIEW_REQUESTERS },
    closed: { allowedActors: AUTHOR_OR_HUMAN },
  },
  in_review: {
    approved: { allowedActors: ['human', 'ReviewAgent'] },
    // Changes-requested revision loop (issue #182): ReviewAgent's request-changes
    // verdict drives the PR to changes_requested; the orchestrator dispatches
    // BuildAgent off pr:in_review→changes_requested to revise. ReviewAgent-only:
    // a human native CHANGES_REQUESTED review is DEFERRED at the resolver (issue
    // #198 — the downstream revision loop needs the label + findings evidence a
    // native review doesn't produce), so `human` is intentionally NOT admitted
    // here until that bridge exists.
    changes_requested: { allowedActors: ['ReviewAgent'] },
    // Re-sync micro-state bounce (issue #192/#119). When the branch-sync gate
    // rebases a behind PR before review, the force-push's synchronize event is
    // observational, so it can't re-fire the review-trigger. BuildAgent bounces
    // in_review→syncing→in_review: the transient syncing state makes the
    // status:in_review re-apply a genuine labeled event (a swap, not a no-op
    // re-apply or a lone-removal violation), so the final syncing→in_review
    // routes back to ReviewAgent. Single-actor edge.
    syncing: { allowedActors: ['BuildAgent'] },
    closed: { allowedActors: AUTHOR_OR_HUMAN },
  },
  changes_requested: {
    // After pushing a revision to the same branch, BuildAgent drives the PR back
    // to in_review (re-dispatching ReviewAgent for re-review). Single-actor edge.
    in_review: { allowedActors: ['BuildAgent'] },
    closed: { allowedActors: AUTHOR_OR_HUMAN },
  },
  syncing: {
    // BuildAgent completes the re-sync bounce: apply status:in_review (removing
    // status:syncing) → emits pr:syncing→in_review, the now-current re-review
    // trigger the orchestrator routes to ReviewAgent (issue #192). Single-actor.
    in_review: { allowedActors: ['BuildAgent'] },
    closed: { allowedActors: AUTHOR_OR_HUMAN },
  },
  approved: {
    merged: { allowedActors: ['OpsAgent'] },
    // The approved → in_review loop is driven by a reviewer submitting
    // changes_requested AFTER an approval (per PR #46 rev1). system stays
    // in the list to cover programmatic dismissal flows; ReviewAgent /
    // human are the natural reviewer drivers.
    in_review: { allowedActors: ['human', 'ReviewAgent', 'system'] },
    closed: { allowedActors: AUTHOR_OR_HUMAN },
  },
  merged: {},
  closed: {},
});

const TERMINAL_STATES: ReadonlySet<string> = new Set(['merged', 'closed']);

export interface EvaluatePrTransitionArgs {
  fromState: PrFromState;
  toState: PrState;
  actor: Actor;
}

function flag(reason: FsmRejectReason): Verdict {
  return { verdict: 'flag', reason };
}

export function evaluatePrTransition(args: EvaluatePrTransitionArgs): Verdict {
  const fromTable = PR_TRANSITIONS[args.fromState];
  if (fromTable === undefined) return flag('unknown_from_state');
  if (TERMINAL_STATES.has(args.fromState)) return flag('terminal_state');
  const allowed = fromTable[args.toState];
  if (allowed === undefined) return flag('illegal_transition');
  if (!allowed.allowedActors.includes(args.actor)) return flag('actor_not_authorized');
  return { verdict: 'accept' };
}
