import { deepFreeze } from './freeze.js';
import type { Actor, FsmRejectReason, Verdict } from './types.js';

// Spec: docs/design/validator-bot.md "Issue(Design)" — same FSM shape as Spec
// but written by DesignAgent (the proposing agent for Design records).
// Field-level policy at line 209: soft-flag enforcement.
// Invariants:
//   - DESIGN_TRANSITIONS is deep-frozen.
//   - Off-policy transitions emit `flag`.
//   - ready_for_review → ratified: human OR ReviewAgent. NEVER DesignAgent
//     (proposing agent cannot self-ratify; same rule as Spec→SpecAgent).
//   - "any → abandoned" covers drafting / ready_for_review / ratified;
//     superseded and abandoned are terminal.

export type DesignState = 'drafting' | 'ready_for_review' | 'ratified' | 'superseded' | 'abandoned';

// See goalFsm.ts header for __initial__ rationale.
export type DesignFromState = DesignState | '__initial__';

interface AllowedTransition {
  readonly allowedActors: ReadonlyArray<Actor>;
}

export const DESIGN_TRANSITIONS: Readonly<
  Record<DesignFromState, Readonly<Record<string, AllowedTransition>>>
> = deepFreeze({
  __initial__: {
    drafting: { allowedActors: ['DesignAgent', 'human'] },
  },
  drafting: {
    ready_for_review: { allowedActors: ['DesignAgent'] },
    abandoned: { allowedActors: ['human'] },
  },
  ready_for_review: {
    ratified: { allowedActors: ['human', 'ReviewAgent'] },
    drafting: { allowedActors: ['DesignAgent'] },
    abandoned: { allowedActors: ['human'] },
  },
  ratified: {
    superseded: { allowedActors: ['system'] },
    abandoned: { allowedActors: ['human'] },
  },
  superseded: {},
  abandoned: {},
});

const TERMINAL_STATES: ReadonlySet<string> = new Set(['superseded', 'abandoned']);

export interface EvaluateDesignTransitionArgs {
  fromState: DesignFromState;
  toState: DesignState;
  actor: Actor;
}

function flag(reason: FsmRejectReason): Verdict {
  return { verdict: 'flag', reason };
}

export function evaluateDesignTransition(args: EvaluateDesignTransitionArgs): Verdict {
  const fromTable = DESIGN_TRANSITIONS[args.fromState];
  if (fromTable === undefined) return flag('unknown_from_state');
  if (TERMINAL_STATES.has(args.fromState)) return flag('terminal_state');
  const allowed = fromTable[args.toState];
  if (allowed === undefined) return flag('illegal_transition');
  if (!allowed.allowedActors.includes(args.actor)) return flag('actor_not_authorized');
  return { verdict: 'accept' };
}
