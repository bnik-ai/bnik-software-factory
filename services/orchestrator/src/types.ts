// Spec: docs/architecture.md L4 (Orchestrator) — routes substrate transitions
// to L3 agents.
// Invariants:
//   - These types MUST stay in sync with services/validator/src/{kinds,types,
//     queueConsumer}.ts. v0 keeps them duplicated; a shared services/_shared
//     package can consolidate them in B6+ when the workspace shape is final.
//   - The orchestrator NEVER mutates the transition; it only consumes it to
//     pick the next L3 agent to invoke.

// Mirror of validator's Kind union (services/validator/src/kinds.ts).
// Keep in sync; B6+ extracts to a shared package.
export type Kind = 'goal' | 'spec' | 'design' | 'task' | 'pr' | 'deployment' | 'decision';

// Mirror of validator's Actor union (services/validator/src/types.ts).
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

// The seven L3 agent roles per architecture.md. Excludes 'human' and
// 'system' (validator-level Actor values that are NOT dispatch targets).
export type AgentRole =
  | 'SpecAgent'
  | 'DesignAgent'
  | 'PlannerAgent'
  | 'BuildAgent'
  | 'ReviewAgent'
  | 'OpsAgent'
  | 'SREAgent';

// Mirror of validator's ParsedTransitionMessage shape (services/validator/
// src/queueConsumer.ts). The Service Bus consumer wraps this with its own
// lockToken / receivedAt fields; the orchestrator only needs the policy
// inputs (kind + transition shape) plus the validator's FSM verdict to
// gate dispatch (B4-PR4).
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
  // branch-sync gate (B4-PR8, ADR 0010 §"Re-sync onto main"). Populated
  // by the validator on PR-kind transitions via SubstrateClient lookup;
  // optional on the wire so non-PR transitions remain unaffected and
  // pre-B4-PR8 messages still parse. When absent on a review-trigger
  // transition the gate skips the check (pass-through) — wired in B5-PR11+.
  headBranch?: string;
  baseBranch?: string;
  // Issue #192/#119: on the synthetic rebase-for-review message, how BuildAgent
  // re-dispatches review after rebasing. 'bounce' — the PR ledger is already at
  // in_review (a pr:*→in_review trigger), so drive the syncing micro-state bounce.
  // 'claim' — the PR is unclaimed (a pr:*→open / task claim trigger, ledger at
  // open), so claim it (apply status:in_review). The orchestrator computes this
  // from the ORIGINAL trigger because the bounce path's labels alone can't tell a
  // native review-request (ledger in_review, no label) from an unclaimed PR.
  reReviewMode?: 'bounce' | 'claim';
  // (`repository.full_name`) + GitHub App installation id, threaded
  // webhook→validator→orchestrator. Forwarded to agents on the dispatch
  // message so a multi-repo BuildAgent targets the right repo + installation
  // (agents currently fall back to AGENT_DEFAULT_REPO). Optional — non-PR/
  // issue transitions and pre-M2 wire messages lack them. Mirrors the
  // validator's ParsedTransitionMessage (services/validator/src/queueConsumer.ts).
  repoFullName?: string;
  installationId?: number;
}
