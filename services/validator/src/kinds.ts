// Spec: docs/design/validator-bot.md (per-kind FSM tables).
// V0 kind set: seven FSMs. Decision added in B3-PR22 (hard-reject FSM for
// the ADR lifecycle). Incident / Release remain deferred per the umbrella
// plan — both are also hard-reject when shipped.

export type Kind = 'goal' | 'spec' | 'design' | 'task' | 'pr' | 'deployment' | 'decision';

export const SOFT_FLAG_KINDS: ReadonlySet<Kind> = new Set(['goal', 'spec', 'design', 'task', 'pr']);

export const HARD_REJECT_KINDS: ReadonlySet<Kind> = new Set(['deployment', 'decision']);
