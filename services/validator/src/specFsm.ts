import { deepFreeze } from './freeze.js';
import type { Actor, FsmRejectReason, Verdict } from './types.js';

// Spec: docs/design/validator-bot.md "Issue(Spec)" table + field-level
// policy at line 209 (Spec status = soft-flag enforcement).
// Invariants:
//   - SPEC_TRANSITIONS is deep-frozen.
//   - Off-policy transitions emit `flag` (Spec is soft-flag like Goal).
//   - ready_for_review → ratified: human OR ReviewAgent. Explicitly
//     NEVER SpecAgent (the proposing agent cannot self-ratify).
//   - "any → abandoned" in the design covers drafting / ready_for_review
//     / ratified. superseded and abandoned are terminal.
//   - Pure function: no I/O, no clock, no env reads.

export type SpecState = 'drafting' | 'ready_for_review' | 'ratified' | 'superseded' | 'abandoned';

// See goalFsm.ts header for __initial__ rationale. Specs are typically
// authored by SpecAgent decomposing a ratified Goal; humans may also draft.
export type SpecFromState = SpecState | '__initial__';

interface AllowedTransition {
  readonly allowedActors: ReadonlyArray<Actor>;
}

export const SPEC_TRANSITIONS: Readonly<
  Record<SpecFromState, Readonly<Record<string, AllowedTransition>>>
> = deepFreeze({
  __initial__: {
    drafting: { allowedActors: ['SpecAgent', 'human'] },
  },
  drafting: {
    ready_for_review: { allowedActors: ['SpecAgent'] },
    abandoned: { allowedActors: ['human'] },
  },
  ready_for_review: {
    ratified: { allowedActors: ['human', 'ReviewAgent'] },
    drafting: { allowedActors: ['SpecAgent'] },
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

export interface EvaluateSpecTransitionArgs {
  fromState: SpecFromState;
  toState: SpecState;
  actor: Actor;
}

function flag(reason: FsmRejectReason): Verdict {
  return { verdict: 'flag', reason };
}

export function evaluateSpecTransition(args: EvaluateSpecTransitionArgs): Verdict {
  const fromTable = SPEC_TRANSITIONS[args.fromState];
  if (fromTable === undefined) return flag('unknown_from_state');
  if (TERMINAL_STATES.has(args.fromState)) return flag('terminal_state');
  const allowed = fromTable[args.toState];
  if (allowed === undefined) return flag('illegal_transition');
  if (!allowed.allowedActors.includes(args.actor)) return flag('actor_not_authorized');
  return { verdict: 'accept' };
}
