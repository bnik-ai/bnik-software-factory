// Spec: docs/design/validator-bot.md (per-kind FSM tables, "Actor" columns;
// "Field-level policy" enforcement-modes table at lines 203-216, 222-227).
// Shared types across all kind-FSM modules.

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

// Soft-flag kinds (Goal / Spec / Design / Task / PR per validator-bot.md:209)
// emit `flag`; hard-reject kinds (Incident / Release / Deployment / Decision)
// emit `reject`. Reasons are shared because the same FSM logic (illegal
// transition, unauthorized actor, etc.) drives both; the per-kind module
// wraps the verdict envelope.
export type FsmRejectReason =
  | 'unknown_from_state'
  | 'illegal_transition'
  | 'actor_not_authorized'
  | 'terminal_state';

// Cross-record assertion failure names per
// services/validator/src/crossRecordAssertions.ts. Live in the same
// VerdictReason union so processMessage can downgrade accept→flag with a
// typed reason without widening every per-kind FSM signature.
export type CrossRecordAssertionReason =
  | 'parent_goal_missing'
  | 'spec_ref_invalid'
  | 'design_ref_invalid';

// Review-loop assertion failure names per
// services/validator/src/reviewLoopAssertions.ts. ADR 0010 §"Substrate
// constraints" (model-independence invariant) + docs/design/review-agent.md
// §3 (model-segment comparison) + §6 (Review-required-before-merge). Fires
// on `pr:in_review→approved` — the validator's only surface for ratifying a
// review outcome — and downgrades verdict accept→flag, same soft-flag posture
// as cross-record assertions (the upstream substrate write already happened).
export type ReviewLoopAssertionReason =
  | 'reviewer_model_equals_author'
  | 'adjudicator_model_equals_author'
  | 'adjudicator_model_equals_reviewer'
  | 'pr_approved_without_review'
  | 'pr_approved_with_noncompliant_review';

export type VerdictReason =
  | FsmRejectReason
  | CrossRecordAssertionReason
  | ReviewLoopAssertionReason;

export type Verdict =
  | { verdict: 'accept' }
  | { verdict: 'reject'; reason: VerdictReason }
  | { verdict: 'flag'; reason: VerdictReason };
