// Spec: ADR 0009 §1 (single SF GitHub App identity for all L1 actions) + §D
// (the real agent is carried in a structural-comment marker
// `<!-- sf:structural sf:agent=<role@model> run=<ulid> ... -->`, NOT in
// `sender.login`) + docs/design/validator-bot.md (the structural-comment
// carve-out + per-kind FSM "Actor" columns).
//
// This module is the actor-resolution surface for App-sent webhooks. Under
// ADR 0009 §1 every agent acts as the single GitHub App `<slug>[bot]`, so
// `sender.login` cannot distinguish SpecAgent from BuildAgent. The real
// actor is recovered here in two stages:
//
//   PRIMARY — read the most recent `sf:agent=<role@model>` structural marker
//   on the record (issue body and/or recent structural comments) and map its
//   role to the validator Actor (attributionStamp.resolveActorFromComment).
//
//   FALLBACK — when NO marker is found, infer the agent from the transition's
//   FSM `allowedActors` IFF exactly one agent actor (non-human, non-system)
//   is allowed. Trust assumption: the App's private key is factory-only (ADR
//   0009 §1, architecture.md L5 — the one identity in L5), so an App-sent
//   transition is genuinely the factory acting; when the FSM admits exactly
//   one agent for that edge the attribution is unambiguous. If the edge is
//   ambiguous (multiple agents) the actor stays UNRESOLVED and the caller
//   flags/defers rather than guessing — never silently accept an ambiguous
//   actor.

import { resolveActorFromComment } from './attributionStamp.js';
import { DECISION_TRANSITIONS } from './decisionFsm.js';
import { DEPLOYMENT_TRANSITIONS } from './deploymentFsm.js';
import { DESIGN_TRANSITIONS } from './designFsm.js';
import { GOAL_TRANSITIONS } from './goalFsm.js';
import type { Kind } from './kinds.js';
import { PR_TRANSITIONS } from './prFsm.js';
import { SPEC_TRANSITIONS } from './specFsm.js';
import { TASK_TRANSITIONS } from './taskFsm.js';
import type { Actor } from './types.js';

// docs/design/github-app.md:38,214 — the SF App's slug is `softwarefactory`
// with fallbacks `sf-platform` / `sf-example` pending GitHub global
// availability. GitHub serializes the sender login as `<slug>[bot]`. These
// three are the default recognized App logins; a deployment whose App slug
// differs (an explicitly configured App is `example-factory`) sets GITHUB_APP_SLUG to add its
// own `<slug>[bot]` to the recognized set (back-compat: the defaults are
// always recognized too).
const DEFAULT_APP_SLUGS: ReadonlyArray<string> = ['softwarefactory', 'sf-platform', 'sf-example'];

// Build the recognized App `<slug>[bot]` login set. The env slug (when set)
// is added to the defaults. A bare slug or an already-suffixed `<slug>[bot]`
// are both accepted so the env value is forgiving.
export function appBotLoginsFromEnv(
  env: { GITHUB_APP_SLUG?: string } = process.env,
): ReadonlySet<string> {
  const logins = new Set<string>(DEFAULT_APP_SLUGS.map((slug) => `${slug}[bot]`));
  const configured = env.GITHUB_APP_SLUG?.trim();
  if (configured !== undefined && configured.length > 0) {
    const login = configured.endsWith('[bot]') ? configured : `${configured}[bot]`;
    logins.add(login);
  }
  return logins;
}

// The default recognized App logins, exposed so the pure parser has a
// back-compat default when no explicit set is threaded in.
export const DEFAULT_APP_BOT_LOGINS: ReadonlySet<string> = new Set(
  DEFAULT_APP_SLUGS.map((slug) => `${slug}[bot]`),
);

// Agent actors (non-human, non-system) — the closed set the single-agent
// fallback may infer. `system` is excluded by design: inferring `system`
// would authorize system-only FSM edges (e.g. Goal in_progress → achieved),
// a privilege escalation. `human` is excluded because the App never acts as
// a human.
const AGENT_ACTORS: ReadonlySet<Actor> = new Set<Actor>([
  'SpecAgent',
  'DesignAgent',
  'PlannerAgent',
  'BuildAgent',
  'ReviewAgent',
  'OpsAgent',
  'SREAgent',
]);

interface AllowedTransition {
  readonly allowedActors: ReadonlyArray<Actor>;
}

type TransitionTable = Readonly<Record<string, Readonly<Record<string, AllowedTransition>>>>;

// Per-kind transition tables, keyed by Kind. The single canonical source the
// FSMs already export; this map is the read-only join the fallback uses to
// recover an edge's allowedActors WITHOUT re-implementing the FSM.
const KIND_TRANSITIONS: ReadonlyMap<Kind, TransitionTable> = new Map<Kind, TransitionTable>([
  ['goal', GOAL_TRANSITIONS as TransitionTable],
  ['spec', SPEC_TRANSITIONS as TransitionTable],
  ['design', DESIGN_TRANSITIONS as TransitionTable],
  ['task', TASK_TRANSITIONS as TransitionTable],
  ['pr', PR_TRANSITIONS as TransitionTable],
  ['deployment', DEPLOYMENT_TRANSITIONS as TransitionTable],
  ['decision', DECISION_TRANSITIONS as TransitionTable],
]);

// The allowedActors for a (kind, fromState, toState) edge, or undefined when
// the edge is not in the FSM table (an illegal transition — the FSM will flag
// it regardless of actor, so the fallback declines to infer).
export function allowedActorsFor(
  kind: Kind,
  fromState: string,
  toState: string,
): ReadonlyArray<Actor> | undefined {
  return KIND_TRANSITIONS.get(kind)?.[fromState]?.[toState]?.allowedActors;
}

// FALLBACK: infer the single agent actor for an edge, or undefined when the
// edge admits zero or multiple agent actors (ambiguous → caller defers).
export function inferSingleAgentActor(
  kind: Kind,
  fromState: string,
  toState: string,
): Actor | undefined {
  const allowed = allowedActorsFor(kind, fromState, toState);
  if (allowed === undefined) return undefined;
  // `system` and `human` are stripped before the single-agent check. An edge
  // that admits `system` alongside exactly one agent (e.g. deployment
  // pending→in_progress = {system, OpsAgent}; PR approved→in_review = {human,
  // ReviewAgent, system}) still resolves to that agent. This is deliberate:
  // on such a co-authorized edge BOTH the agent and `system`
  // are FSM-authorized, so attributing the agent is never an authorization
  // escalation — at most an audit-precision nuance. Deferring instead would
  // dead-letter legitimate flows that have no other marker channel (Deployment
  // GraphQL nodes carry no comments; the review-loop's marker rides the review
  // body, not the PR record). The defer path is reserved for genuinely
  // AMBIGUOUS edges — two or more candidate AGENTS — where guessing one over
  // the other WOULD misattribute across agents.
  let single: Actor | undefined;
  for (const actor of allowed) {
    if (!AGENT_ACTORS.has(actor)) continue;
    if (single !== undefined && single !== actor) return undefined; // ambiguous
    single = actor;
  }
  return single;
}

// A record's marker-bearing surfaces in most-recent-first order: the issue
// body is the record's standing marker; structural comments are appended
// chronologically, so the LAST comment is the most recent action. The caller
// passes comments oldest-first (GraphQL natural order); we scan newest-first
// so the most recent structural marker wins.
// One marker-bearing comment: its body plus the GitHub login that authored it.
// Comments are human-writable, so a structural marker is trusted ONLY when its
// authorLogin is a recognized App-bot login — otherwise a user could plant
// `<!-- sf:structural sf:agent=ops@... -->` and steal attribution for the next
// App-sent transition. undefined login = unverifiable = untrusted.
export interface MarkerComment {
  body: string;
  authorLogin?: string;
}

export interface MarkerSurfaces {
  body: string;
  // Login that authored the record (issue/PR) body — authenticates the body
  // marker the same way MarkerComment.authorLogin authenticates a comment.
  bodyAuthorLogin?: string;
  // Oldest-first (GraphQL issue.comments natural order).
  comments: readonly MarkerComment[];
}

// PRIMARY (transition attribution): resolve the Actor from the most recent
// structural marker in the record's COMMENTS only, scanned newest-first
// (most-recent-wins). The record BODY is deliberately EXCLUDED — it carries the
// CREATOR's standing stamp (the sf:agent of whoever authored the record), which
// is the wrong actor for a *later* transition: a Spec authored by SpecAgent and
// later ratified by the App as ReviewAgent would mis-resolve to SpecAgent and
// flag as actor_not_authorized. Each transition's actor comes
// from the marker comment the acting agent posts on THAT action; when no such
// comment exists the caller's single-agent FSM fallback (inferSingleAgentActor)
// supplies it — every creation/transition edge admits exactly one agent, so the
// body is never needed. Returns undefined when no comment carries a parseable
// `sf:structural ... sf:agent=<role@model> run=<ulid>` marker.
export function resolveActorFromMarkers(
  surfaces: MarkerSurfaces,
  appBotLogins: ReadonlySet<string>,
): Actor | undefined {
  for (let i = surfaces.comments.length - 1; i >= 0; i--) {
    const comment = surfaces.comments[i];
    if (comment === undefined) continue;
    // Author authentication: only the SF App posts authentic structural markers
    // (ADR 0009 §D). A parseable marker in a human-authored (or unverifiable)
    // comment is forged → skip it rather than attribute the transition to it.
    if (comment.authorLogin === undefined || !appBotLogins.has(comment.authorLogin)) continue;
    const resolved = resolveActorFromComment(comment.body);
    if (resolved.ok) return resolved.actor;
  }
  return undefined;
}

// CREATION-edge attribution from the record BODY's creator stamp. Used by
// resolveAppActor ONLY for `__initial__→X` edges where the FSM admits MULTIPLE
// agent authors (e.g. Decision authoring) so inferSingleAgentActor is ambiguous
// — there the body IS the right actor (the agent that just created the record).
// NEVER used for a later transition: on a non-creation edge the
// body is the stale creator stamp.
export function resolveActorFromBody(
  surfaces: MarkerSurfaces,
  appBotLogins: ReadonlySet<string>,
): Actor | undefined {
  // Same author authentication as comments: a body marker counts only when the
  // record was authored by the App (an agent-created record). A human-opened
  // record's body marker is forged.
  if (surfaces.bodyAuthorLogin === undefined || !appBotLogins.has(surfaces.bodyAuthorLogin)) {
    return undefined;
  }
  const resolved = resolveActorFromComment(surfaces.body);
  return resolved.ok ? resolved.actor : undefined;
}
