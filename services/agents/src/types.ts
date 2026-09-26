// Spec: docs/architecture.md L3 (the seven SF agents). Local mirrors of
// the validator's and orchestrator's shared types — services don't share
// a workspace yet; consolidate into a shared package in B6+ when the
// workspace shape is final.

// Mirror of validator's Kind union.
export type Kind = 'goal' | 'spec' | 'design' | 'task' | 'pr' | 'deployment' | 'decision';

// Mirror of validator's Actor union.
export type Actor =
  | 'human'
  | 'SpecAgent'
  | 'DesignAgent'
  | 'PlannerAgent'
  | 'BuildAgent'
  | 'ReviewAgent'
  | 'OpsAgent'
  | 'SREAgent'
  | 'system';

// Mirror of orchestrator's AgentRole — the seven L3 dispatch targets.
// Excludes human/system since they aren't agent roles.
export type AgentRole =
  | 'SpecAgent'
  | 'DesignAgent'
  | 'PlannerAgent'
  | 'BuildAgent'
  | 'ReviewAgent'
  | 'OpsAgent'
  | 'SREAgent';

// Mirror of validator's ParsedTransitionMessage shape. `verdict` is set by
// the validator post-FSM-evaluation; orchestrator gates dispatch on it
// (B4-PR4). Agents always observe verdict==='accept' because they only run
// for dispatched transitions, but the field is mirrored for shape parity.
export type TransitionVerdict = 'accept' | 'flag' | 'reject';

export interface ParsedTransitionMessage {
  lockToken: string;
  deliveryId: string;
  eventType: string;
  kind: Kind;
  actor: Actor;
  recordType: string;
  recordKind?: string;
  recordId: string;
  fromState: string;
  toState: string;
  payloadHash: Buffer;
  receivedAt: Date;
  verdict?: TransitionVerdict;
  // PR-specific transport fields used by the orchestrator's pre-review
  // branch-sync gate (B4-PR8) + BuildAgent's rebase-for-review handler
  // (B4-PR9). Optional; populated by the validator/orchestrator on PR-kind
  // transitions and on the synthetic 'needs_sync_for_review' rebase dispatch.
  // Mirror of services/orchestrator/src/types.ts ParsedTransitionMessage.
  headBranch?: string;
  baseBranch?: string;
  // Issue #192/#119: on the rebase-for-review message, 'bounce' (PR ledger at
  // in_review → drive the syncing micro-state) vs 'claim' (PR unclaimed at open →
  // apply status:in_review). Set by the orchestrator from the original trigger.
  reReviewMode?: 'bounce' | 'claim';
}
