import { deepFreeze } from './freeze.js';
import type { Actor, FsmRejectReason, Verdict } from './types.js';

// Spec: docs/design/validator-bot.md "Issue(Decision)" table (line 138-154)
// + line 245 (Decision is HARD-REJECT — alongside Incident, Release,
// Deployment).
// Invariants:
//   - DECISION_TRANSITIONS is deep-frozen.
//   - Off-policy transitions emit `reject` (NOT `flag`). Per
//     validator-bot.md:245, reject triggers substrate revert + the
//     policy:violation label + an Incident escalation + agent throttling.
//   - proposed → approved: human OR ReviewAgent ("App as designated
//     reviewer"); NEVER the proposing agent. Self-approval guard mirrors
//     the Spec/Design proposing-agent-cannot-ratify rule.
//   - proposed → rejected: human only (rejection is a substantive
//     editorial call, not a routine agent action).
//   - approved → superseded: system only (fires when a later Decision
//     marks `supersedes` on this one).
//   - rejected / superseded / abandoned are terminal.

export type DecisionState =
  | 'drafting'
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'abandoned';

// See goalFsm.ts header for __initial__ rationale. Decision authoring is
// driven by an agent that's documenting a substantive architectural
// choice (typically SpecAgent or DesignAgent during the
// drafting/design phase). Humans can also propose Decisions directly.
export type DecisionFromState = DecisionState | '__initial__';

interface AllowedTransition {
  readonly allowedActors: ReadonlyArray<Actor>;
}

// Author allow-list for Decision records. Per validator-bot.md:245,
// hard-reject mode itself OPENS a Decision issue — so `system` MUST be
// in the list. Per the "any agent can author a Decision" ownership
// model, all agents EXCEPT ReviewAgent are included (OpsAgent for infra
// Decisions, SREAgent for incident retros, etc.), plus humans for direct
// authoring.
// ReviewAgent is EXCLUDED here because it's the designated reviewer
// (the only agent in APPROVAL_ACTORS); per validator-bot.md:152
// "never the proposing agent". Excluding ReviewAgent from authoring
// enforces no-self-approval at the FSM layer (without requiring a
// cross-record audit-ledger lookup). Decisions about review-process
// are authored by SpecAgent or humans instead.
const AUTHOR_ACTORS: ReadonlyArray<Actor> = [
  'human',
  'system',
  'SpecAgent',
  'DesignAgent',
  'PlannerAgent',
  'BuildAgent',
  'OpsAgent',
  'SREAgent',
];

// The proposing agent CANNOT self-approve. ReviewAgent is the designated
// reviewer agent (per validator-bot.md:152 "App as designated
// reviewer"); humans can also approve directly. Excluding ReviewAgent
// from AUTHOR_ACTORS (see above) is what makes the "never the proposing
// agent" rule FSM-enforceable without a cross-record check.
const APPROVAL_ACTORS: ReadonlyArray<Actor> = ['human', 'ReviewAgent'];

export const DECISION_TRANSITIONS: Readonly<
  Record<DecisionFromState, Readonly<Record<string, AllowedTransition>>>
> = deepFreeze({
  __initial__: {
    drafting: { allowedActors: AUTHOR_ACTORS },
  },
  drafting: {
    proposed: { allowedActors: AUTHOR_ACTORS },
    // drafting → abandoned per validator-bot.md:142-147 (visual diagram
    // shows the abandon arrow only on drafting). Human only — abandoning
    // a drafted decision is a substantive editorial call.
    abandoned: { allowedActors: ['human'] },
  },
  proposed: {
    // Per spec table at validator-bot.md:149-154, proposed has EXACTLY
    // two outgoing edges: approved or rejected. Abandoned is NOT in the
    // proposed row: admitting it would let "human closes as not_planned"
    // slip in as abandon instead of the documented reject path, weakening
    // hard-reject lifecycle enforcement.
    approved: { allowedActors: APPROVAL_ACTORS },
    rejected: { allowedActors: ['human'] },
  },
  approved: {
    superseded: { allowedActors: ['system'] },
  },
  rejected: {},
  superseded: {},
  abandoned: {},
});

// Widened to ReadonlySet<string> so `.has(args.fromState)` accepts the
// __initial__ pseudo-state without a cast.
const TERMINAL_STATES: ReadonlySet<string> = new Set(['rejected', 'superseded', 'abandoned']);

export interface EvaluateDecisionTransitionArgs {
  fromState: DecisionFromState;
  toState: DecisionState;
  actor: Actor;
}

function reject(reason: FsmRejectReason): Verdict {
  return { verdict: 'reject', reason };
}

export function evaluateDecisionTransition(args: EvaluateDecisionTransitionArgs): Verdict {
  const fromTable = DECISION_TRANSITIONS[args.fromState];
  if (fromTable === undefined) return reject('unknown_from_state');
  if (TERMINAL_STATES.has(args.fromState)) return reject('terminal_state');
  const allowed = fromTable[args.toState];
  if (allowed === undefined) return reject('illegal_transition');
  if (!allowed.allowedActors.includes(args.actor)) return reject('actor_not_authorized');
  return { verdict: 'accept' };
}
