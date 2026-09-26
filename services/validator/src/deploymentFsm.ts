import { deepFreeze } from './freeze.js';
import type { Actor, FsmRejectReason, Verdict } from './types.js';

// Spec: docs/design/validator-bot.md "Deployment" table + line 209
// (Deployment is HARD-REJECT — first FSM in this package where off-policy
// transitions trigger auto-revert + circuit-breaker rather than soft-flag).
// Invariants:
//   - DEPLOYMENT_TRANSITIONS is deep-frozen.
//   - Off-policy transitions emit `reject` (NOT `flag`). Per
//     validator-bot.md:224, reject triggers substrate revert + the
//     policy:violation label + a Decision Issue + agent throttling.
//   - awaiting_approval ONLY accepts the human env-approval transition;
//     agents cannot bypass GitHub Environments protection rules.
//   - success / failure / error are terminal.

export type DeploymentState =
  | 'pending'
  | 'in_progress'
  | 'awaiting_approval'
  | 'success'
  | 'failure'
  | 'error';

// See goalFsm.ts header for __initial__ rationale. Deployment creation
// comes from GitHub's deployment_status webhook in either pending (queued
// for environment approval) or in_progress (env approval not required, or
// dispatched directly). The deployment FSM is HARD-REJECT, so the
// initial transitions are scoped narrowly to system + OpsAgent.
export type DeploymentFromState = DeploymentState | '__initial__';

interface AllowedTransition {
  readonly allowedActors: ReadonlyArray<Actor>;
}

const SYSTEM_OR_OPS_AGENT: ReadonlyArray<Actor> = ['system', 'OpsAgent'];

export const DEPLOYMENT_TRANSITIONS: Readonly<
  Record<DeploymentFromState, Readonly<Record<string, AllowedTransition>>>
> = deepFreeze({
  __initial__: {
    pending: { allowedActors: SYSTEM_OR_OPS_AGENT },
    in_progress: { allowedActors: SYSTEM_OR_OPS_AGENT },
  },
  pending: {
    // system covers github-actions[bot] CI runner progress reports
    // (validator-bot.md "system (CI / runner reports)"); OpsAgent covers
    // explicit agent-driven deploys. Both are legitimate operational
    // paths into in_progress.
    in_progress: { allowedActors: ['OpsAgent', 'system'] },
    awaiting_approval: { allowedActors: ['system'] },
  },
  awaiting_approval: {
    // The env-approval GATE is enforced by GitHub Environments
    // (substrate-side; required_reviewers + can_admins_bypass=false per
    // substrate-terraform.md). Once a human approves, GitHub advances
    // the deployment and fires the next deployment_status under the
    // CI runner's identity — which the parser maps to system. The FSM
    // accepts both: 'human' for direct-API approvals, 'system' for the
    // runner-reported post-approval transition. Neither path lets an
    // agent bypass the gate (GitHub stops the deploy if no human
    // approves, so no webhook reaches this resolver in that case).
    in_progress: { allowedActors: ['human', 'system'] },
  },
  in_progress: {
    success: { allowedActors: ['system'] },
    failure: { allowedActors: ['system'] },
    error: { allowedActors: ['system'] },
  },
  success: {},
  failure: {},
  error: {},
});

const TERMINAL_STATES: ReadonlySet<string> = new Set(['success', 'failure', 'error']);

export interface EvaluateDeploymentTransitionArgs {
  fromState: DeploymentFromState;
  toState: DeploymentState;
  actor: Actor;
}

function reject(reason: FsmRejectReason): Verdict {
  return { verdict: 'reject', reason };
}

export function evaluateDeploymentTransition(args: EvaluateDeploymentTransitionArgs): Verdict {
  const fromTable = DEPLOYMENT_TRANSITIONS[args.fromState];
  if (fromTable === undefined) return reject('unknown_from_state');
  if (TERMINAL_STATES.has(args.fromState)) return reject('terminal_state');
  const allowed = fromTable[args.toState];
  if (allowed === undefined) return reject('illegal_transition');
  if (!allowed.allowedActors.includes(args.actor)) return reject('actor_not_authorized');
  return { verdict: 'accept' };
}
