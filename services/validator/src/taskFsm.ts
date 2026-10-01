import { deepFreeze } from './freeze.js';
import type { Actor, FsmRejectReason, Verdict } from './types.js';

// Spec: docs/design/validator-bot.md "Issue(Task)" table + line 209
// (Task = soft-flag).
// Invariants:
//   - TASK_TRANSITIONS is deep-frozen.
//   - Off-policy transitions emit `flag`.
//   - "any → abandoned" covers proposed / ready / in_progress / in_review,
//     by human OR PlannerAgent (with documented reason — the validator
//     does not enforce the documentation requirement here; it is a
//     field-level check, not an FSM rule).
//   - in_review → in_progress is the "review requested changes" loop. Under
//     structural review (single GitHub App identity, ADR 0009),
//     ReviewAgent DRIVES this Task transition (applies status:in_progress on the
//     paired Task) to bounce the work back so the orchestrator dispatches
//     BuildAgent off `task:in_review→in_progress` (routingTable.ts). So the edge
//     admits BOTH ReviewAgent (the driver of the label) and BuildAgent (legacy/
//     self-restart). Multi-agent edge → the validator's App-actor resolver uses
//     ReviewAgent's structural-comment marker to attribute the transition.
//   - ready → done admits TWO agents:
//       (a) OpsAgent's post-merge completion: v0 BuildAgent never drives
//           ready→in_progress→in_review (it scaffolds the PR without touching
//           Task status labels), so the paired Task still sits at `ready` when
//           OpsAgent merges the approved PR. Without a terminal edge from
//           `ready` the merge leaves the Task stranded and the orchestrator's
//           `task:*→done` PlannerAgent re-plan trigger (ADR 0013 §4 dep-clear)
//           never fires — decomposed dependents never cascade to `ready`.
//       (b) BuildAgent's already-satisfied completion: a well-formed Task whose
//           work is ALREADY present in the code yields an empty diff. That is a
//           legitimate TERMINAL outcome (already-done), not a build failure —
//           BuildAgent settles `ready→done` with a structural-marker comment as
//           the audit evidence (no PR to review/merge), instead of dead-
//           lettering on `nothing to commit`.
//     Multi-agent edge → the App-actor resolver uses the per-run structural
//     comment marker (both agents post one before the apply) to attribute the
//     transition; the single-agent FSM fallback no longer applies here.
//     in_progress→done stays illegal (a future label-driving BuildAgent passes
//     through in_review, whose →done edge already admits OpsAgent).
//   - done and abandoned are terminal.

export type TaskState = 'proposed' | 'ready' | 'in_progress' | 'in_review' | 'done' | 'abandoned';

// See goalFsm.ts header for __initial__ rationale. Tasks are typically
// fanned out by PlannerAgent from a ratified Design; humans can also
// create Tasks directly.
export type TaskFromState = TaskState | '__initial__';

interface AllowedTransition {
  readonly allowedActors: ReadonlyArray<Actor>;
}

const HUMAN_OR_PLANNER_AGENT: ReadonlyArray<Actor> = ['human', 'PlannerAgent'];

export const TASK_TRANSITIONS: Readonly<
  Record<TaskFromState, Readonly<Record<string, AllowedTransition>>>
> = deepFreeze({
  __initial__: {
    proposed: { allowedActors: HUMAN_OR_PLANNER_AGENT },
  },
  proposed: {
    ready: { allowedActors: ['PlannerAgent'] },
    abandoned: { allowedActors: HUMAN_OR_PLANNER_AGENT },
  },
  ready: {
    in_progress: { allowedActors: ['BuildAgent'] },
    // OpsAgent post-merge completion (v0 BuildAgent never claims the
    // Task, so it is still `ready` when the paired PR merges) AND BuildAgent
    // already-satisfied completion (an empty diff for a Task already met by
    // existing code is terminal, settled with a structural marker — no PR).
    done: { allowedActors: ['OpsAgent', 'BuildAgent'] },
    abandoned: { allowedActors: HUMAN_OR_PLANNER_AGENT },
  },
  in_progress: {
    in_review: { allowedActors: ['BuildAgent'] },
    abandoned: { allowedActors: HUMAN_OR_PLANNER_AGENT },
  },
  in_review: {
    done: { allowedActors: ['OpsAgent'] },
    // ReviewAgent drives the structural-review "request changes" bounce;
    // BuildAgent retained for the legacy self-restart path.
    in_progress: { allowedActors: ['ReviewAgent', 'BuildAgent'] },
    abandoned: { allowedActors: HUMAN_OR_PLANNER_AGENT },
  },
  done: {},
  abandoned: {},
});

const TERMINAL_STATES: ReadonlySet<string> = new Set(['done', 'abandoned']);

export interface EvaluateTaskTransitionArgs {
  fromState: TaskFromState;
  toState: TaskState;
  actor: Actor;
}

function flag(reason: FsmRejectReason): Verdict {
  return { verdict: 'flag', reason };
}

export function evaluateTaskTransition(args: EvaluateTaskTransitionArgs): Verdict {
  const fromTable = TASK_TRANSITIONS[args.fromState];
  if (fromTable === undefined) return flag('unknown_from_state');
  if (TERMINAL_STATES.has(args.fromState)) return flag('terminal_state');
  const allowed = fromTable[args.toState];
  if (allowed === undefined) return flag('illegal_transition');
  if (!allowed.allowedActors.includes(args.actor)) return flag('actor_not_authorized');
  return { verdict: 'accept' };
}
