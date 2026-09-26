import { type DecisionState, evaluateDecisionTransition } from './decisionFsm.js';
import { type DeploymentState, evaluateDeploymentTransition } from './deploymentFsm.js';
import { type DesignState, evaluateDesignTransition } from './designFsm.js';
import { type GoalState, evaluateGoalTransition } from './goalFsm.js';
import type { Kind } from './kinds.js';
import { type PrState, evaluatePrTransition } from './prFsm.js';
import { type SpecState, evaluateSpecTransition } from './specFsm.js';
import { type TaskState, evaluateTaskTransition } from './taskFsm.js';
import type { Actor, Verdict } from './types.js';

// Spec: docs/design/validator-bot.md (per-kind dispatch).
// Invariants:
//   - Dispatches strictly by Kind; no state-shape inference across kinds.
//   - fromState / toState are typed as `string` because the dispatcher is
//     the boundary between the queue (raw GitHub event payload, unknown
//     states possible) and the per-kind FSM (typed state union). Each
//     per-kind FSM's `unknown_from_state` / `illegal_transition` checks
//     handle unknown strings safely.
//   - TS exhaustiveness check (`never`-typed default) catches missing
//     kinds at compile time; runtime throw catches them if the type is
//     bypassed via a cast.

export interface EvaluateTransitionArgs {
  kind: Kind;
  fromState: string;
  toState: string;
  actor: Actor;
}

export function evaluateTransition(args: EvaluateTransitionArgs): Verdict {
  switch (args.kind) {
    case 'goal':
      return evaluateGoalTransition({
        fromState: args.fromState as GoalState,
        toState: args.toState as GoalState,
        actor: args.actor,
      });
    case 'spec':
      return evaluateSpecTransition({
        fromState: args.fromState as SpecState,
        toState: args.toState as SpecState,
        actor: args.actor,
      });
    case 'design':
      return evaluateDesignTransition({
        fromState: args.fromState as DesignState,
        toState: args.toState as DesignState,
        actor: args.actor,
      });
    case 'task':
      return evaluateTaskTransition({
        fromState: args.fromState as TaskState,
        toState: args.toState as TaskState,
        actor: args.actor,
      });
    case 'pr':
      return evaluatePrTransition({
        fromState: args.fromState as PrState,
        toState: args.toState as PrState,
        actor: args.actor,
      });
    case 'deployment':
      return evaluateDeploymentTransition({
        fromState: args.fromState as DeploymentState,
        toState: args.toState as DeploymentState,
        actor: args.actor,
      });
    case 'decision':
      return evaluateDecisionTransition({
        fromState: args.fromState as DecisionState,
        toState: args.toState as DecisionState,
        actor: args.actor,
      });
    default: {
      const exhaustive: never = args.kind;
      throw new Error(`Unknown validator kind: ${exhaustive as string}`);
    }
  }
}
