import { deepFreeze } from './freeze.js';
import type { Actor, FsmRejectReason, Verdict } from './types.js';

// Spec: docs/design/validator-bot.md "Issue(Goal)" table + field-level
// policy table at line 209 (Goal status = soft-flag enforcement).
// Invariants:
//   - GOAL_TRANSITIONS is deep-frozen; nested transition entries cannot be
//     reassigned at runtime (Object.freeze on its own is shallow).
//   - Goal off-policy transitions emit `flag`, NOT `reject`. The hard-reject
//     FSMs (Deployment / Decision; Incident / Release when shipped) emit
//     `reject`.
//   - No self-loops; the audit-ledger 2-phase contract handles
//     duplicate-delivery idempotency one layer up.
//   - Pure function: no I/O, no clock, no env reads.

export type GoalState = 'proposed' | 'accepted' | 'in_progress' | 'achieved' | 'abandoned';

// fromState in the rule table covers GoalState plus the synthetic
// `__initial__` row that represents record creation (no prior state). The
// resolver emits fromState='__initial__' for `issues.opened` and PR-creation
// webhooks per transitionResolver.ts; the FSM treats it as a legal source
// for the first-state-after-creation transitions documented here.
export type GoalFromState = GoalState | '__initial__';

interface AllowedTransition {
  readonly allowedActors: ReadonlyArray<Actor>;
}

export const GOAL_TRANSITIONS: Readonly<
  Record<GoalFromState, Readonly<Record<string, AllowedTransition>>>
> = deepFreeze({
  __initial__: {
    proposed: { allowedActors: ['human'] },
  },
  proposed: {
    accepted: { allowedActors: ['human'] },
    abandoned: { allowedActors: ['human'] },
  },
  accepted: {
    in_progress: { allowedActors: ['SpecAgent'] },
    abandoned: { allowedActors: ['human'] },
  },
  in_progress: {
    achieved: { allowedActors: ['system'] },
    abandoned: { allowedActors: ['human'] },
  },
  achieved: {},
  abandoned: {},
});

// Widened to ReadonlySet<string> so `.has(args.fromState)` accepts the
// __initial__ pseudo-state without a cast. `__initial__` is never terminal;
// the runtime check returns false naturally.
const TERMINAL_STATES: ReadonlySet<string> = new Set(['achieved', 'abandoned']);

export interface EvaluateGoalTransitionArgs {
  fromState: GoalFromState;
  toState: GoalState;
  actor: Actor;
}

function flag(reason: FsmRejectReason): Verdict {
  return { verdict: 'flag', reason };
}

export function evaluateGoalTransition(args: EvaluateGoalTransitionArgs): Verdict {
  const fromTable = GOAL_TRANSITIONS[args.fromState];
  if (fromTable === undefined) return flag('unknown_from_state');
  if (TERMINAL_STATES.has(args.fromState)) return flag('terminal_state');
  const allowed = fromTable[args.toState];
  if (allowed === undefined) return flag('illegal_transition');
  if (!allowed.allowedActors.includes(args.actor)) return flag('actor_not_authorized');
  return { verdict: 'accept' };
}
