import { createHash } from 'node:crypto';
import { DEFAULT_APP_BOT_LOGINS } from './actorResolution.js';
import { parseStructuralComment, resolveActorFromComment } from './attributionStamp.js';
import type { Kind } from './kinds.js';
import type { Actor } from './types.js';

// Spec: docs/design/validator-bot.md (substrate event ingestion) +
// docs/design/github-app.md:107-122 (subscribed event types) +
// ADR 0009 §1, §D (single SF App, attribution-in-record).
// Invariants:
//   - parsePayload is pure: no I/O, no clock except the caller-supplied
//     receivedAt for determinism.
//   - This PR ships ONLY the envelope: deliveryId, eventType, kind,
//     actor, recordType, recordKind, recordId, payloadHash, statusLabel,
//     action. fromState / toState require substrate lookup (previous
//     label set or audit_ledger history) and ship in a later PR.
//   - Unknown event types or unparseable payloads return a ParseFailure
//     with a typed reason. The consumer deadletters on failure.
//   - Sender → Actor mapping under ADR 0009 §1 (single SF App):
//       * `User` sender → `human` (the only path that resolves cleanly today).
//       * SF App login (the documented slugs per docs/design/github-app.md:38,214
//         — `softwarefactory[bot]` / `sf-platform[bot]` / `sf-example[bot]`
//         — plus any `<slug>[bot]` configured via GITHUB_APP_SLUG; the live
//         App is `example-factory[bot]`). Under ADR 0009 §1+§D the App login
//         covers ALL agent + system writes; the real actor lives in the
//         structural-comment marker (`sf:agent=<role@model>`), NOT in
//         `sender.login`. Resolution (ADR 0009 §D, the first implementation
//         task after ratification — now implemented):
//           1. PRIMARY in-parser: the marker on the record's BODY (`issue.body`
//              on `issues` events) — pure, no I/O. SpecAgent's created Spec
//              body carries `<!-- sf:structural sf:agent=spec@... run=... -->`.
//           2. When the body has no marker, the envelope is emitted with
//              `appActorUnresolved=true` (ok:true) and a non-authorizing
//              placeholder actor; the transitionResolver then reads recent
//              structural COMMENTS via the substrate and applies the
//              single-agent FSM fallback (services/validator/src/
//              actorResolution.ts). Only if BOTH fail does the transition
//              defer (`actor_unresolved_app_sender`) — never a silent accept.
//       * Documented agent bot logins → their Actor. Forward-compatible
//         with ADR 0009 Option B (per-role Apps); GitHub does NOT
//         currently send these logins under Option A+D.
//       * Every other bot login (issue #183) → non-App bot: NO actor is
//         resolved (no silent `system` fallback — that would be a privilege
//         escalation since `system` authorizes Goal `in_progress → achieved`
//         and similar system-only edges). VISIBLE-BY-DEFAULT (codex P2 on PR
//         #186): only a provably-INERT action (`isBenignThirdPartyBotEvent` —
//         PR synchronize + assignment churn, or a cosmetic (non-status/kind/policy) label) settles
//         OBSERVATIONALLY (`third_party_bot_observational`, observational:true);
//         every TRANSITION-CAPABLE action (status/kind mutation, close/reopen,
//         review submission, deployment_status, PR open/close, …) stays a VISIBLE
//         failure (`untrusted_bot_event`, dead-letters) so an untrusted actor can
//         never silently drive SF state. Does NOT relax the App-impersonation
//         guard: an App-login sender takes the App path (appActorUnresolved →
//         resolver `actor_unresolved_app_sender`).

const KIND_LABEL_PREFIX = 'kind:';
const STATUS_LABEL_PREFIX = 'status:';
// Validator-only enforcement label (Decision/Deployment FSM policy:violation).
// A non-App bot writing it is an untrusted forgery of validator state (issue
// #183 codex P2 round 5) — never inert.
const POLICY_LABEL_PREFIX = 'policy:';

// The recognized SF App `<slug>[bot]` logins. Default set (the three
// documented slugs per github-app.md:38,214) lives in actorResolution.ts;
// a deployment whose slug differs (an explicitly configured App is `example-factory`) adds its
// `<slug>[bot]` via GITHUB_APP_SLUG, threaded into parsePayload as
// options.appBotLogins. The parser stays pure (no env read) — the caller
// resolves the set from env via appBotLoginsFromEnv().

// Forward-compatible with ADR 0009 Option B (per-role Apps). GitHub does
// NOT currently send these logins under Option A+D; the map shape is
// ready for if/when per-role Apps land.
const BOT_LOGIN_TO_ACTOR: ReadonlyMap<string, Actor> = new Map([
  ['spec-agent[bot]', 'SpecAgent'],
  ['design-agent[bot]', 'DesignAgent'],
  ['planner-agent[bot]', 'PlannerAgent'],
  ['build-agent[bot]', 'BuildAgent'],
  ['review-agent[bot]', 'ReviewAgent'],
  ['ops-agent[bot]', 'OpsAgent'],
  ['sre-agent[bot]', 'SREAgent'],
]);

// github-actions[bot] is the standard GitHub Actions runner identity.
// validator-bot.md calls deployment events from CI runners "system
// (CI / runner reports)". The mapping is SCOPED to deployment_status
// events only — applying it broadly (PR #40 rev2's original) lets
// ANY workflow with issues:write permission apply status:* labels and
// be FSM-accepted as system, bypassing the closed allow-list for
// system-only transitions like Goal in_progress → achieved (PR #47
// review caught this). For issue/PR/review events, github-actions[bot]
// gets no actor and is treated like any other non-App bot (issue #183) —
// never `system`: only provably-inert actions settle observationally, every
// transition-capable action stays a visible failure (untrusted_bot_event).
const GITHUB_ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const GITHUB_ACTIONS_TRUSTED_EVENT_TYPES: ReadonlySet<string> = new Set(['deployment_status']);

// kind:* label → validator Kind. The label name is canonical per ADR 0006;
// the Kind union (services/validator/src/kinds.ts) is the validator's
// internal representation.
const KIND_LABEL_TO_KIND: ReadonlyMap<string, Kind> = new Map([
  ['kind:goal', 'goal'],
  ['kind:spec', 'spec'],
  ['kind:design', 'design'],
  ['kind:task', 'task'],
  ['kind:decision', 'decision'],
]);

// Record kind = capitalized form for the audit_ledger record_kind column.
const KIND_TO_RECORD_KIND: ReadonlyMap<Kind, string> = new Map([
  ['goal', 'Goal'],
  ['spec', 'Spec'],
  ['design', 'Design'],
  ['task', 'Task'],
  ['pr', 'PullRequest'],
  ['deployment', 'Deployment'],
  ['decision', 'Decision'],
]);

export interface RawWebhookDelivery {
  // Header values from the github-app webhook ingestion (constants live
  // in services/github-app/src/constants.ts; the validator just receives
  // the values).
  deliveryId: string;
  eventType: string;
  // The exact raw bytes received. payloadHash is computed over these so
  // any in-transit mutation is detected by the hash chain.
  rawBody: Buffer;
  // Parsed JSON. The caller (Service Bus consumer in B7) is responsible
  // for JSON-decoding the body; this parser inspects the structure.
  parsedBody: unknown;
  receivedAt: Date;
}

export interface ParsedWebhookEnvelope {
  deliveryId: string;
  eventType: string;
  kind: Kind;
  actor: Actor;
  recordType: 'Issue' | 'PullRequest' | 'Deployment';
  recordKind: string;
  recordId: string;
  payloadHash: Buffer;
  // The status:* label name on the just-applied label (for `issues.labeled`
  // events). Absent for actions where no status label was applied.
  statusLabel?: string;
  // The GitHub webhook `action` field (e.g. 'opened', 'labeled', 'closed';
  // 'created' for deployment_status). Verbatim from the webhook body.
  action: string;
  receivedAt: Date;
  // Pull-request-specific fields (set only for `pull_request` events; absent
  // for `issues`). Kept as flat optional fields rather than a discriminated
  // union to avoid premature abstraction — the resolver narrows on action +
  // these flags. `draft` reflects PR.draft on every PR action; `merged`
  // reflects PR.merged on `closed` actions (true = merged, false = closed
  // without merge).
  draft?: boolean;
  merged?: boolean;
  // Deployment-status-specific field (set only for `deployment_status`
  // events). Verbatim from body.deployment_status.state per GitHub's
  // webhook spec — values include error/failure/in_progress/inactive/
  // pending/queued/success/waiting. The resolver maps these to the
  // DeploymentState union (pending/in_progress/awaiting_approval/success/
  // failure/error) per the deployment FSM.
  deploymentState?: string;
  // The issue's label names verbatim from `body.issue.labels` AT WEBHOOK
  // FIRE TIME (only set for `issues` events). The resolver uses this for
  // issues.opened resolution rather than substrate.getCurrentLabels(),
  // which returns the substrate-at-decision-time view and can be stale
  // (the queue consumer can be delayed; agents can apply labels in the
  // meantime). PR #43 rev1 codex finding.
  labels?: readonly string[];
  // GitHub's issue.state_reason verbatim — only set for `issues` events
  // that have a state_reason field on the issue. Values include
  // 'completed', 'not_planned', 'reopened', or null/undefined. The
  // resolver uses this for `issues.closed` actions to disambiguate per-kind
  // terminal-success vs `abandoned`.
  issueStateReason?: string;
  // The just-REMOVED label name verbatim from `body.label.name` — only
  // set for `issues.unlabeled` events. Distinct from `statusLabel`
  // (which is the just-APPLIED label for `issues.labeled`). The
  // resolver uses this to classify status:* vs kind:* removals for
  // policy:violation routing.
  removedLabel?: string;
  // The review verdict verbatim from `body.review.state` — only set
  // for `pull_request_review.submitted` events. Values include
  // 'approved', 'changes_requested', 'commented', 'dismissed'. The
  // resolver maps these to PR FSM transitions.
  reviewState?: string;
  // PR head/base branch names verbatim from `body.pull_request.head.ref`
  // / `body.pull_request.base.ref` — only set for `pull_request` and
  // `pull_request_review` events. ADR 0012 §"Activation status"
  // activation gate (a): the orchestrator's pre-review branch-sync gate
  // (PR #101) reads these fields off the republished message; without
  // population the gate skips for real traffic and the re-sync
  // protection is inert. The orchestrator-side wire-deserializer (PR
  // #110) already accepts both fields and propagates them on the
  // synthetic BuildAgent rebase-intent message. Non-PR webhooks
  // (Goal/Spec/Design/Task/Decision issues, Deployment status) leave
  // these undefined — the orchestrator gate skips when absent.
  headBranch?: string;
  baseBranch?: string;
  // (`repository.full_name`, e.g. "example-org/software-factory") +
  // GitHub App installation id (`installation.id`) verbatim from the
  // webhook body. The validator's read-only GithubSubstrateClient mints an
  // installation token from `installationId` to re-read the record's current
  // labels at decision time (the "canonical state is always re-read from
  // substrate" contract). Optional — non-issue events or pre-M2 payloads may
  // lack an `installation` block; the consumer falls back to the in-memory
  // substrate and the resolver dead-letters as before. Threaded onward to the
  // orchestrator + agents so multi-repo dispatch targets the right repo.
  repoFullName?: string;
  installationId?: number;
  // ADR 0009 §D: set true when the sender is the SF App but the per-agent
  // actor could NOT be resolved from the record body marker in the (pure)
  // parser. `actor` then carries the non-authorizing placeholder
  // (UNRESOLVED_APP_ACTOR) and the transitionResolver MUST resolve the real
  // actor — from recent structural comments (substrate) or the single-agent
  // FSM fallback — before building the transition, or defer. Absent/false on
  // every human, agent-login, and body-marker-resolved path.
  appActorUnresolved?: boolean;
}

// Non-authorizing placeholder for an App sender whose real actor the parser
// could not resolve from the body marker. `system` would falsely authorize
// system-only FSM edges, so the placeholder is `human`: it cannot satisfy any
// AGENT-only edge (every agent transition the App drives requires an agent
// actor), so an unresolved App actor that somehow reached the FSM would
// FLAG (actor_not_authorized) rather than silently pass. In practice the
// resolver always overwrites it (or defers) — see resolveAppActorOrDefer.
export const UNRESOLVED_APP_ACTOR: Actor = 'human';

export interface ParsePayloadOptions {
  // The recognized SF App `<slug>[bot]` logins. Defaults to the three
  // documented slugs (DEFAULT_APP_BOT_LOGINS); the consumer threads
  // appBotLoginsFromEnv(process.env) to honor GITHUB_APP_SLUG.
  appBotLogins?: ReadonlySet<string>;
}

export type ParseFailureReason =
  | 'unknown_event_type'
  | 'unknown_action'
  | 'missing_field'
  | 'unknown_kind'
  | 'ambiguous_kind'
  | 'unknown_actor_shape'
  // Issue #183: a genuinely third-party bot author (dependabot[bot] and any
  // other non-App, non-agent `[bot]` login). Benign — it can NEVER drive a
  // target-repo transition (no resolved actor) — so it SETTLES observationally
  // (observational:true) instead of dead-lettering, removing validator-events
  // DLQ noise so a non-zero DLQ keeps meaning "real defect". This is NOT the
  // forgery guard: an App-login sender (appBotLogins) still routes to the App
  // path → resolver `actor_unresolved_app_sender` (fail-closed), unchanged.
  | 'third_party_bot_observational'
  // Issue #183 (codex P2): a non-App bot (github-actions[bot] off-scope,
  // renovate, any installed App) on a TRANSITION-CAPABLE event — a status:/kind:
  // label mutation, a close/reopen, a review submission, a deployment_status, a
  // PR open/close, anything NOT on the provably-inert allowlist. Stays VISIBLE
  // (dead-letters), never silently settled. Only inert bot events use
  // third_party_bot_observational above.
  | 'untrusted_bot_event'
  | 'malformed_body'
  // Issue #178 rev5: a recognized event type that carries NO FSM transition
  // (issue_comment — structural attribution markers ride it; actor resolution
  // reads markers via the substrate, never from comment webhooks). The
  // consumer settles these cleanly (completeMessage) instead of dead-lettering
  // one row per agent comment.
  | 'observational_event_type'
  // Issue #178 rev6: an App/agent-sent issue_comment WITHOUT the leading
  // sf:structural marker — an agent used comments as a channel (validator-bot
  // hard rule). Dead-letters visibly for policy handling; never observational.
  | 'nonstructural_agent_comment';

export interface ParseFailure {
  ok: false;
  reason: ParseFailureReason;
  detail?: string;
  // Mirrors ResolveResult.observational: benign non-transition delivery —
  // settle cleanly, never dead-letter. Absent on real parse failures.
  observational?: true;
}

export type ParseResult = { ok: true; envelope: ParsedWebhookEnvelope } | ParseFailure;

// Narrowing helpers — typed JSON traversal without using `any`.
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// M2: extract `repository.full_name` + `installation.id` from any webhook
// body. Both top-level on every GitHub webhook delivery for an installed App.
// Returns undefined fields when absent/wrong-typed (the substrate falls back
// to in-memory). Shared across every event parser.
function extractRepoAndInstallation(body: Record<string, unknown>): {
  repoFullName: string | undefined;
  installationId: number | undefined;
} {
  const repository = asObject(body.repository);
  const fullName = repository !== null ? asString(repository.full_name) : null;
  // Empty-string full_name is treated as absent (it can't authenticate a repo).
  const repoFullName = fullName !== null && fullName.length > 0 ? fullName : undefined;
  const installation = asObject(body.installation);
  const installationId =
    installation !== null ? (asNumber(installation.id) ?? undefined) : undefined;
  return { repoFullName, installationId };
}

function asArrayOfObjects(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const result: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    const obj = asObject(entry);
    if (obj === null) return null;
    result.push(obj);
  }
  return result;
}

type KindExtraction =
  | { tag: 'none' }
  | { tag: 'one'; kind: Kind }
  | { tag: 'ambiguous'; names: ReadonlyArray<string> };

// Per ADR 0006:27-29, exactly one kind:* label is a validator-enforced
// invariant. The exactly-one count is over EVERY label that starts with
// `kind:` — recognized or not. An issue with `kind:goal` + `kind:typo`
// is ambiguous even though only one maps to a Kind; the substrate's
// invariant doesn't care which one happens to be in our recognized set.
function extractKindFromLabels(labels: Array<Record<string, unknown>>): KindExtraction {
  const kindLabelNames: string[] = [];
  for (const label of labels) {
    const name = asString(label.name);
    if (name === null) continue;
    if (name.startsWith(KIND_LABEL_PREFIX)) kindLabelNames.push(name);
  }
  if (kindLabelNames.length === 0) return { tag: 'none' };
  if (kindLabelNames.length >= 2) return { tag: 'ambiguous', names: kindLabelNames };
  // Exactly one kind:* label. Resolve it against the recognized map; an
  // unrecognized name still fails parsing but as unknown_kind (the caller's
  // existing branch handles that via tag: 'none' below).
  // biome-ignore lint/style/noNonNullAssertion: length checked above.
  const onlyName = kindLabelNames[0]!;
  const kind = KIND_LABEL_TO_KIND.get(onlyName);
  if (kind === undefined) return { tag: 'none' };
  return { tag: 'one', kind };
}

function extractStatusLabel(label: Record<string, unknown> | undefined): string | undefined {
  if (label === undefined) return undefined;
  const name = asString(label.name);
  if (name === null) return undefined;
  return name.startsWith(STATUS_LABEL_PREFIX) ? name : undefined;
}

type ActorResolution =
  | { ok: true; actor: Actor }
  // App sender whose actor wasn't resolvable from the body marker; the
  // resolver finishes resolution (comments + single-agent fallback) or defers.
  | { ok: true; actor: Actor; appActorUnresolved: true }
  | { ok: false; reason: 'unknown_actor_shape' }
  // Issue #183: a non-App bot (dependabot[bot], renovate[bot], github-actions[bot]
  // off its trusted scope, any installed App) on a BENIGN non-mutating event.
  // Carried up as an observational settle — see resolveSenderOrFail.
  | { ok: false; reason: 'third_party_bot_observational'; login: string }
  // Issue #183 (codex P2): a non-App bot on a TRANSITION-CAPABLE event (anything
  // not on the provably-inert allowlist — a status:/kind: label mutation, a
  // close/reopen, a review submission, a deployment_status, …). VISIBLE failure
  // (dead-letters); an untrusted actor can never silently drive SF state.
  | { ok: false; reason: 'untrusted_bot_event'; login: string };

function resolveActorFromSender(
  sender: Record<string, unknown>,
  eventType: string,
  appBotLogins: ReadonlySet<string>,
  recordBody: string | null,
  benignBotEvent: boolean,
): ActorResolution {
  const type = asString(sender.type);
  if (type === 'User') return { ok: true, actor: 'human' };
  if (type !== 'Bot') return { ok: false, reason: 'unknown_actor_shape' };
  const login = asString(sender.login);
  if (login === null) return { ok: false, reason: 'unknown_actor_shape' };
  // Issue #183 (codex P2): VISIBLE-by-default for a non-App bot. Only an
  // explicitly INERT action (isBenignThirdPartyBotEvent — PR synchronize,
  // assignment churn, a non-status/kind label) settles observationally; every
  // TRANSITION-CAPABLE action (status/kind mutation, close/reopen, review
  // submission, deployment_status, PR open/close, …) stays a visible failure so
  // an untrusted actor can never silently drive SF state. The App path
  // (appBotLogins, handled below) is never reached here — forgery guard intact.
  const nonAppBotOutcome = (botLogin: string): ActorResolution =>
    benignBotEvent
      ? { ok: false, reason: 'third_party_bot_observational', login: botLogin }
      : { ok: false, reason: 'untrusted_bot_event', login: botLogin };
  if (appBotLogins.has(login)) {
    // ADR 0009 §1+§D: the App identity is shared by ALL agents; the real actor
    // for THIS transition is the most-recent structural marker, which needs the
    // edge + recent comments — NOT just the record body. The body marker is the
    // CREATOR's standing stamp and would misattribute a later transition (e.g. a
    // SpecAgent-authored Spec later ratified by the App as ReviewAgent would
    // resolve to SpecAgent → actor_not_authorized; a BuildAgent-authored PR
    // merged by OpsAgent → BuildAgent). So ALWAYS defer to resolveAppActor
    // (transitionResolver), which reads body+comments (most-recent-wins) then
    // the single-agent edge fallback. The placeholder actor is non-authorizing
    // (see UNRESOLVED_APP_ACTOR). (codex PR #152)
    return { ok: true, actor: UNRESOLVED_APP_ACTOR, appActorUnresolved: true };
  }
  if (login === GITHUB_ACTIONS_BOT_LOGIN) {
    // Scoped to specific event types — see GITHUB_ACTIONS_BOT_LOGIN
    // header. Unscoped mapping is a privilege escalation (PR #47 review).
    if (GITHUB_ACTIONS_TRUSTED_EVENT_TYPES.has(eventType)) {
      return { ok: true, actor: 'system' };
    }
    // Off its trusted (deployment_status) scope github-actions[bot] is just
    // another non-App bot: NO actor (no privilege escalation; PR #47 invariant),
    // visible iff it mutates a status:/kind: label, else observational.
    return nonAppBotOutcome(login);
  }
  const actor = BOT_LOGIN_TO_ACTOR.get(login);
  // Issue #183: any other bot login (dependabot[bot], renovate[bot], a near-App
  // look-alike, …) is genuinely third-party — NOT the App (handled above) and
  // not a recognized agent — so it cannot drive a transition. Benign events
  // settle observationally (DLQ-noise removal); a status:/kind: label mutation
  // stays visible (untrusted substrate-state write; codex P2).
  if (actor === undefined) return nonAppBotOutcome(login);
  return { ok: true, actor };
}

// Applies resolveActorFromSender's result: a typed ParseFailure on the
// failure branches, or the resolved actor + the appActorUnresolved flag on
// success. Shared by every event parser so the sender→actor contract is one
// place (ADR 0009: one canonical actor resolver).
type ResolvedSender =
  | { ok: true; actor: Actor; appActorUnresolved: boolean }
  | { ok: false; failure: ParseFailure };

// Issue #183 (codex P2): provably-INERT webhook actions — they carry NO FSM
// transition AND do not touch a trusted attribution surface, so a non-App bot
// performing one is genuinely benign (dependabot pushing to its PR, assignment
// churn). EVERYTHING ELSE a non-App bot does is transition-capable / trust-
// affecting and stays a VISIBLE failure (untrusted_bot_event) — visible-by-
// default is the safe posture for an untrusted actor. labeled/unlabeled is inert
// ONLY when the label is not a status:/kind: state label (in
// isBenignThirdPartyBotEvent). EXCLUSIONS (each a codex P2 round): `edited`
// (round 4 — a body edit alters the structural-marker attribution surface);
// `review_requested`/`review_request_removed` (round 5 — resolvePullRequest maps
// review_requested on an open/draft PR to a real →in_review transition). The
// inert set is intentionally tiny: pushes + assignment churn only.
const INERT_BOT_ACTIONS: ReadonlySet<string> = new Set(['synchronize', 'assigned', 'unassigned']);

// True iff this event is provably inert for a non-App bot (→ observational
// settle). A status:/kind:/policy: label mutation is NEVER inert (all three are
// validator-relevant — status/kind drive the FSM, policy:violation is the
// validator's own enforcement label); a cosmetic label (e.g. dependabot's
// `dependencies`) IS inert. Shared by the issues + PR parsers; deployment_status
// / pull_request_review pass false (transition-capable).
function isBenignThirdPartyBotEvent(body: Record<string, unknown>): boolean {
  const action = asString(body.action);
  if (action === null) return false;
  if (action === 'labeled' || action === 'unlabeled') {
    const label = asObject(body.label);
    const name = label !== null ? asString(label.name) : null;
    return (
      name !== null &&
      !name.startsWith(STATUS_LABEL_PREFIX) &&
      !name.startsWith(KIND_LABEL_PREFIX) &&
      !name.startsWith(POLICY_LABEL_PREFIX)
    );
  }
  return INERT_BOT_ACTIONS.has(action);
}

function resolveSenderOrFail(
  sender: Record<string, unknown>,
  eventType: string,
  appBotLogins: ReadonlySet<string>,
  recordBody: string | null,
  benignBotEvent: boolean,
): ResolvedSender {
  const resolution = resolveActorFromSender(
    sender,
    eventType,
    appBotLogins,
    recordBody,
    benignBotEvent,
  );
  if (!resolution.ok) {
    if (resolution.reason === 'untrusted_bot_event') {
      // Issue #183 (codex P2): VISIBLE failure — NO observational flag, so the
      // consumer dead-letters it. A non-App bot on a transition-capable event
      // (state mutation, close/reopen, review submission, …) must never be
      // silently hidden.
      return {
        ok: false,
        failure: {
          ok: false,
          reason: 'untrusted_bot_event',
          detail: resolution.login,
        },
      };
    }
    if (resolution.reason === 'third_party_bot_observational') {
      // Issue #183: benign non-App bot (dependabot[bot] et al.) — mirror the
      // #178/#182 observational-settle contract (observational:true → the
      // consumer completeMessage's instead of dead-lettering). Forgery guard
      // intact: an App-login sender never reaches here (App path returns
      // appActorUnresolved above → resolver `actor_unresolved_app_sender`).
      return {
        ok: false,
        failure: {
          ok: false,
          reason: 'third_party_bot_observational',
          detail: resolution.login,
          observational: true,
        },
      };
    }
    return { ok: false, failure: { ok: false, reason: 'unknown_actor_shape' } };
  }
  return {
    ok: true,
    actor: resolution.actor,
    appActorUnresolved: 'appActorUnresolved' in resolution,
  };
}

function parseIssuesEvent(
  raw: RawWebhookDelivery,
  body: Record<string, unknown>,
  appBotLogins: ReadonlySet<string>,
): ParseResult {
  const action = asString(body.action);
  if (action === null) return { ok: false, reason: 'missing_field', detail: 'action' };

  const issue = asObject(body.issue);
  if (issue === null) return { ok: false, reason: 'missing_field', detail: 'issue' };

  const recordId = asString(issue.node_id);
  if (recordId === null) return { ok: false, reason: 'missing_field', detail: 'issue.node_id' };

  const sender = asObject(body.sender);
  if (sender === null) return { ok: false, reason: 'missing_field', detail: 'sender' };

  // ADR 0009 §D PRIMARY (pure): the structural marker on the issue body. The
  // webhook carries issue.body verbatim, so an App-sent transition whose
  // authoring agent stamped the body resolves here with no substrate read.
  const issueBody = asString(issue.body);
  const sent = resolveSenderOrFail(
    sender,
    raw.eventType,
    appBotLogins,
    issueBody,
    isBenignThirdPartyBotEvent(body),
  );
  if (!sent.ok) return sent.failure;
  const actor = sent.actor;

  const labels = asArrayOfObjects(issue.labels);
  if (labels === null) return { ok: false, reason: 'missing_field', detail: 'issue.labels' };

  const kindExtraction = extractKindFromLabels(labels);
  // ADR 0006 invariant-violation case: issues.unlabeled where the just-
  // removed label IS a kind:* label AND post-removal labels have none.
  // The resolver's kind_label_removed branch (B3-PR19) needs envelope.kind
  // to fire, so derive it from the REMOVED label rather than failing
  // unknown_kind here. Without this hook the typed policy signal never
  // reaches the consumer (PR #45 rev0 codex P2).
  let kind: Kind | undefined;
  if (kindExtraction.tag === 'one') {
    kind = kindExtraction.kind;
  } else if (action === 'unlabeled' && kindExtraction.tag === 'none') {
    const removedLabelObject = asObject(body.label);
    const removedName = removedLabelObject !== null ? asString(removedLabelObject.name) : null;
    if (removedName?.startsWith(KIND_LABEL_PREFIX)) {
      kind = KIND_LABEL_TO_KIND.get(removedName);
    }
  }
  if (kind === undefined) {
    if (kindExtraction.tag === 'ambiguous') {
      return {
        ok: false,
        reason: 'ambiguous_kind',
        detail: kindExtraction.names.join(','),
      };
    }
    return { ok: false, reason: 'unknown_kind' };
  }

  const recordKind = KIND_TO_RECORD_KIND.get(kind);
  if (recordKind === undefined) {
    return { ok: false, reason: 'unknown_kind', detail: `no record_kind mapping for ${kind}` };
  }

  // statusLabel is the just-APPLIED status:* label. GitHub sends `label`
  // on both `labeled` and `unlabeled` events; gating on `labeled` keeps
  // the envelope contract honest (a later resolver computing toState
  // from statusLabel would otherwise treat a removal as an application).
  const statusLabel =
    action === 'labeled' ? extractStatusLabel(asObject(body.label) ?? undefined) : undefined;
  // removedLabel mirrors statusLabel for the `unlabeled` direction —
  // verbatim label name (no status:* gating) so the resolver can
  // classify status:* / kind:* / other removals.
  const removedLabelObject = action === 'unlabeled' ? asObject(body.label) : null;
  const removedLabel = removedLabelObject !== null ? asString(removedLabelObject.name) : null;
  const payloadHash = createHash('sha256').update(raw.rawBody).digest();

  // Pass through the issue's label set as-of webhook fire so the resolver
  // can derive opened-event state without re-reading the substrate (which
  // may have moved on by decision time).
  const labelNames: string[] = [];
  for (const label of labels) {
    const name = asString(label.name);
    if (name !== null) labelNames.push(name);
  }

  // GitHub issue.state_reason — used by the closed-event resolver branch.
  const issueStateReason = asString(issue.state_reason);

  const { repoFullName, installationId } = extractRepoAndInstallation(body);

  return {
    ok: true,
    envelope: {
      deliveryId: raw.deliveryId,
      eventType: raw.eventType,
      kind,
      actor,
      recordType: 'Issue',
      recordKind,
      recordId,
      payloadHash,
      ...(statusLabel !== undefined ? { statusLabel } : {}),
      action,
      receivedAt: raw.receivedAt,
      labels: labelNames,
      ...(issueStateReason !== null ? { issueStateReason } : {}),
      ...(removedLabel !== null ? { removedLabel } : {}),
      ...(repoFullName !== undefined ? { repoFullName } : {}),
      ...(installationId !== undefined ? { installationId } : {}),
      ...(sent.appActorUnresolved ? { appActorUnresolved: true } : {}),
    },
  };
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parsePullRequestEvent(
  raw: RawWebhookDelivery,
  body: Record<string, unknown>,
  appBotLogins: ReadonlySet<string>,
): ParseResult {
  const action = asString(body.action);
  if (action === null) return { ok: false, reason: 'missing_field', detail: 'action' };

  const pullRequest = asObject(body.pull_request);
  if (pullRequest === null) {
    return { ok: false, reason: 'missing_field', detail: 'pull_request' };
  }

  const recordId = asString(pullRequest.node_id);
  if (recordId === null) {
    return { ok: false, reason: 'missing_field', detail: 'pull_request.node_id' };
  }

  const sender = asObject(body.sender);
  if (sender === null) return { ok: false, reason: 'missing_field', detail: 'sender' };

  // ADR 0009 §D PRIMARY (pure): a structural marker on the PR body. The PR FSM
  // edges are single-agent (BuildAgent authors; ReviewAgent/OpsAgent on
  // dedicated edges), so even when the PR body has no marker the resolver's
  // single-agent fallback covers most edges.
  const prBody = asString(pullRequest.body);
  const sent = resolveSenderOrFail(
    sender,
    raw.eventType,
    appBotLogins,
    prBody,
    isBenignThirdPartyBotEvent(body),
  );
  if (!sent.ok) return sent.failure;
  const actor = sent.actor;

  // PRs have implicit kind='pr' (no kind:* label gating; the recordType
  // disambiguates). recordKind matches the audit_ledger column convention.
  const draft = asBoolean(pullRequest.draft);
  if (draft === null) {
    return { ok: false, reason: 'missing_field', detail: 'pull_request.draft' };
  }
  // merged is the load-bearing field for `closed` actions (disambiguates
  // approved → merged from any-state → closed in the PR FSM). For closed
  // actions it MUST be present; missing → fail fast at parse so the
  // resolver can't silently downgrade a merged PR to a closed transition
  // (PR #44 rev0 codex finding). For non-closed actions GitHub still
  // ships the field but its value is informational; we parse it
  // optimistically and only require it for closed.
  const merged = asBoolean(pullRequest.merged);
  if (action === 'closed' && merged === null) {
    return { ok: false, reason: 'missing_field', detail: 'pull_request.merged' };
  }

  // ADR 0012 §"Activation status" activation gate (a): populate
  // head/base branch names from the webhook so the orchestrator's
  // pre-review branch-sync gate (PR #101) can resolve sync state for
  // real traffic. Both refs are present on every standard
  // `pull_request` action per GitHub's webhook spec
  // (docs.github.com/.../webhook-events-and-payloads#pull_request).
  // Missing/non-string values fall through to undefined — the gate
  // skips when absent rather than failing parse (lenient on a non-
  // load-bearing field; the gate's pass-through is the v0 posture
  // until the real GitHub-API checker lands).
  const { headBranch, baseBranch } = extractHeadBaseBranches(pullRequest);
  const { repoFullName, installationId } = extractRepoAndInstallation(body);

  // Issue #178 structural review: a PR is an Issue in GitHub's API, so
  // applying a `status:*` label to a PR fires `pull_request` action='labeled'
  // (NOT issues.labeled) carrying `body.label`. ReviewAgent drives the PR
  // review FSM by labels (status:in_review / status:approved), so the parser
  // surfaces the just-applied status:* label as statusLabel — symmetric with
  // the issues.labeled path — for the resolver's labeled branch. removedLabel
  // mirrors it for the `unlabeled` direction (verbatim, no status:* gating).
  const statusLabel =
    action === 'labeled' ? extractStatusLabel(asObject(body.label) ?? undefined) : undefined;
  const removedLabelObject = action === 'unlabeled' ? asObject(body.label) : null;
  const removedLabel = removedLabelObject !== null ? asString(removedLabelObject.name) : null;

  const payloadHash = createHash('sha256').update(raw.rawBody).digest();

  return {
    ok: true,
    envelope: {
      deliveryId: raw.deliveryId,
      eventType: raw.eventType,
      kind: 'pr',
      actor,
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId,
      payloadHash,
      action,
      receivedAt: raw.receivedAt,
      draft,
      ...(merged !== null ? { merged } : {}),
      ...(statusLabel !== undefined ? { statusLabel } : {}),
      ...(removedLabel !== null ? { removedLabel } : {}),
      ...(headBranch !== undefined ? { headBranch } : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(repoFullName !== undefined ? { repoFullName } : {}),
      ...(installationId !== undefined ? { installationId } : {}),
      ...(sent.appActorUnresolved ? { appActorUnresolved: true } : {}),
    },
  };
}

// Helper shared by parsePullRequestEvent + parsePullRequestReviewEvent —
// both event bodies carry `pull_request.head.ref` / `pull_request.base.ref`
// per GitHub's webhook spec. Returns undefined for missing/non-string
// values; the orchestrator's branch-sync gate (ADR 0012) skips when either
// is absent.
function extractHeadBaseBranches(pullRequest: Record<string, unknown>): {
  headBranch: string | undefined;
  baseBranch: string | undefined;
} {
  const head = asObject(pullRequest.head);
  const base = asObject(pullRequest.base);
  const headRef = head !== null ? asString(head.ref) : null;
  const baseRef = base !== null ? asString(base.ref) : null;
  return {
    headBranch: headRef ?? undefined,
    baseBranch: baseRef ?? undefined,
  };
}

function parseDeploymentStatusEvent(
  raw: RawWebhookDelivery,
  body: Record<string, unknown>,
  appBotLogins: ReadonlySet<string>,
): ParseResult {
  const action = asString(body.action);
  if (action === null) return { ok: false, reason: 'missing_field', detail: 'action' };

  const deployment = asObject(body.deployment);
  if (deployment === null) {
    return { ok: false, reason: 'missing_field', detail: 'deployment' };
  }

  const recordId = asString(deployment.node_id);
  if (recordId === null) {
    return { ok: false, reason: 'missing_field', detail: 'deployment.node_id' };
  }

  const deploymentStatus = asObject(body.deployment_status);
  if (deploymentStatus === null) {
    return { ok: false, reason: 'missing_field', detail: 'deployment_status' };
  }

  const deploymentState = asString(deploymentStatus.state);
  if (deploymentState === null) {
    return { ok: false, reason: 'missing_field', detail: 'deployment_status.state' };
  }

  const sender = asObject(body.sender);
  if (sender === null) return { ok: false, reason: 'missing_field', detail: 'sender' };

  // deployment_status carries no marker-bearing body; an App-sent deployment
  // event resolves via the single-agent FSM fallback (deployment edges are
  // system-or-OpsAgent), or defers if ambiguous.
  const sent = resolveSenderOrFail(sender, raw.eventType, appBotLogins, null, false);
  if (!sent.ok) return sent.failure;
  const actor = sent.actor;

  const payloadHash = createHash('sha256').update(raw.rawBody).digest();
  const { repoFullName, installationId } = extractRepoAndInstallation(body);

  return {
    ok: true,
    envelope: {
      deliveryId: raw.deliveryId,
      eventType: raw.eventType,
      kind: 'deployment',
      actor,
      recordType: 'Deployment',
      recordKind: 'Deployment',
      recordId,
      payloadHash,
      action,
      receivedAt: raw.receivedAt,
      deploymentState,
      ...(repoFullName !== undefined ? { repoFullName } : {}),
      ...(installationId !== undefined ? { installationId } : {}),
      ...(sent.appActorUnresolved ? { appActorUnresolved: true } : {}),
    },
  };
}

function parsePullRequestReviewEvent(
  raw: RawWebhookDelivery,
  body: Record<string, unknown>,
  appBotLogins: ReadonlySet<string>,
): ParseResult {
  const action = asString(body.action);
  if (action === null) return { ok: false, reason: 'missing_field', detail: 'action' };

  const review = asObject(body.review);
  if (review === null) return { ok: false, reason: 'missing_field', detail: 'review' };

  const reviewState = asString(review.state);
  if (reviewState === null) {
    return { ok: false, reason: 'missing_field', detail: 'review.state' };
  }

  const pullRequest = asObject(body.pull_request);
  if (pullRequest === null) {
    return { ok: false, reason: 'missing_field', detail: 'pull_request' };
  }

  const recordId = asString(pullRequest.node_id);
  if (recordId === null) {
    return { ok: false, reason: 'missing_field', detail: 'pull_request.node_id' };
  }

  const sender = asObject(body.sender);
  if (sender === null) return { ok: false, reason: 'missing_field', detail: 'sender' };

  // ADR 0009 §D PRIMARY (pure): the structural marker on the review body
  // (review:in_review→approved is the ReviewAgent edge per the FSM).
  const reviewBody = asString(review.body);
  const sent = resolveSenderOrFail(sender, raw.eventType, appBotLogins, reviewBody, false);
  if (!sent.ok) return sent.failure;
  const actor = sent.actor;

  // ADR 0012 activation gate (a): pull_request_review events also carry
  // the full `pull_request` body — populate head/base so a review-
  // submission can re-fire the branch-sync gate via the resolver's
  // pr:in_review→approved (or paired changes-requested) path.
  const { headBranch, baseBranch } = extractHeadBaseBranches(pullRequest);
  const { repoFullName, installationId } = extractRepoAndInstallation(body);

  const payloadHash = createHash('sha256').update(raw.rawBody).digest();

  return {
    ok: true,
    envelope: {
      deliveryId: raw.deliveryId,
      eventType: raw.eventType,
      kind: 'pr',
      actor,
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId,
      payloadHash,
      action,
      receivedAt: raw.receivedAt,
      reviewState,
      ...(headBranch !== undefined ? { headBranch } : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(repoFullName !== undefined ? { repoFullName } : {}),
      ...(installationId !== undefined ? { installationId } : {}),
      ...(sent.appActorUnresolved ? { appActorUnresolved: true } : {}),
    },
  };
}

export function parsePayload(raw: RawWebhookDelivery, options?: ParsePayloadOptions): ParseResult {
  const body = asObject(raw.parsedBody);
  if (body === null) return { ok: false, reason: 'malformed_body' };

  // Default to the documented App slugs; the consumer threads
  // appBotLoginsFromEnv(process.env) to honor GITHUB_APP_SLUG.
  const appBotLogins = options?.appBotLogins ?? DEFAULT_APP_BOT_LOGINS;

  if (raw.eventType === 'issues') return parseIssuesEvent(raw, body, appBotLogins);
  if (raw.eventType === 'pull_request') return parsePullRequestEvent(raw, body, appBotLogins);
  if (raw.eventType === 'pull_request_review') {
    return parsePullRequestReviewEvent(raw, body, appBotLogins);
  }
  if (raw.eventType === 'deployment_status') {
    return parseDeploymentStatusEvent(raw, body, appBotLogins);
  }

  // issue_comment (issue #178 rev6): three sender/shape classes —
  //   * App-sent STRUCTURAL marker comment (ADR 0009 §D — ReviewAgent
  //     claim/findings, agent attribution stamps): carries no FSM transition
  //     (markers are read via substrate.getStructuralMarkers during actor
  //     resolution, not from webhooks) → observational, settled cleanly.
  //   * App-sent NON-structural comment: an agent used comments as a channel
  //     (validator-bot.md hard rule: agents communicate via records, not
  //     chat) → typed violation, dead-letters VISIBLY for policy handling.
  //   * Human-sent comment: humans may discuss freely → observational.
  if (raw.eventType === 'issue_comment') {
    const senderLogin = asString(asObject(body.sender)?.login);
    const appSent = senderLogin !== null && appBotLogins.has(senderLogin);
    if (appSent) {
      const commentBody = asString(asObject(body.comment)?.body) ?? '';
      if (!parseStructuralComment(commentBody).isStructural) {
        return {
          ok: false,
          reason: 'nonstructural_agent_comment',
          detail: senderLogin ?? raw.eventType,
        };
      }
    }
    return {
      ok: false,
      reason: 'observational_event_type',
      detail: raw.eventType,
      observational: true,
    };
  }

  // installation + installation_repositories (issue #182): App-installation
  // lifecycle events — the un-suspended installation fires them on install /
  // suspend / repo-scope changes. The github-app allowlist forwards both
  // (services/github-app/src/eventAllowlist.ts); neither carries an FSM
  // transition (no SF record is involved). Observational — settled cleanly,
  // same posture as issue_comment above (#178 rev5).
  if (raw.eventType === 'installation' || raw.eventType === 'installation_repositories') {
    return {
      ok: false,
      reason: 'observational_event_type',
      detail: raw.eventType,
      observational: true,
    };
  }

  // Other event types (push, create, etc.) ship in later PRs; until
  // then return a typed failure so the consumer deadletters cleanly.
  return { ok: false, reason: 'unknown_event_type', detail: raw.eventType };
}
