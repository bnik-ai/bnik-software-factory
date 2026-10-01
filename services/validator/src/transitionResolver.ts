// Spec: docs/design/validator-bot.md "Service Bus session-keyed consumer"
// + :292 (re-read substrate at decision time).
// Invariants:
//   - resolveTransition takes a ParsedWebhookEnvelope (from payloadParser)
//     and produces a ResolvedTransition (= ParsedTransitionMessage without
//     the Service Bus lockToken; that gets assigned at the SB enqueue or
//     dequeue boundary per the SDK's contract — the resolver has no SB
//     dependency).
//   - Dispatch on envelope.eventType: issues / pull_request / deployment_status
//     each have their own resolver branch. Every other action / event shape
//     returns a typed failure (dead-lettered by the consumer unless
//     observational).
//   - For issues.opened: toState comes from any status:* label in the
//     issue's initial label set; if none, the per-kind default initial
//     state (Goal/Task → proposed, Spec/Design → drafting). fromState
//     comes from the ledger (typically `__initial__` for new issues).
//   - For issues.closed: GitHub's issue.state_reason disambiguates.
//     'not_planned' → 'abandoned' uniformly. 'completed' → per-kind
//     terminal-success (Goal → achieved, Task → done). Spec/Design have
//     no completed-via-close path and defer. fromState via ledger lookup.
//   - For issues.reopened: emits prior.toState → per-kind initial. FSM
//     will flag illegal_transition since terminal rows are empty — the
//     correct v0 audit posture for non-standard reopens.
//   - For issues.unlabeled: classifies envelope.removedLabel. status:*
//     removal is observational (status_label_removed_observational) ONLY
//     when it CONVERGES the substrate:
//     fresh-ledger cleanup (removed ≠ ledgered label, ledgered label
//     remains) OR FSM-forward stale-ledger swap (removed = ledgered label,
//     gone, and a remaining status label is one legal per-kind FSM edge
//     forward) — see isConvergingStatusRemoval. Anything else (true
//     reversal, lone removal, no prior ledger row) →
//     status_label_removed (Decision FSM policy:violation in v0+). kind:*
//     removal → kind_label_removed (ADR 0006 violation). Other label
//     families → unsupported_action.
//   - For issues.edited: observational (issue_edited_observational) — body/
//     title edits carry no FSM transition (state is label-driven); agent
//     appendToBody writes and human edits settle cleanly instead of DLQing.
//   - For issues.labeled: fromState comes from substrate.getCurrentLabels()
//     minus the just-applied label. When the substrate shows ONLY the just-
//     applied label (steady-state single-status-label after enforcer cleanup
//     OR first-labeling case), fall back to ledger.getLastTransitionForRecord
//     to derive fromState; if no prior transition exists, use the synthetic
//     '__initial__' fromState.
//   - For pull_request: ledger lookup is authoritative for fromState (we
//     cannot infer from action alone — an admin-bypass merge of an
//     unapproved PR must not read as compliant). `opened` uses '__initial__'
//     directly since the FSM has explicit creation rules. `labeled`
//     resolves a status:* label applied to the PR —
//     a PR is an Issue, so ReviewAgent's status:in_review / status:approved
//     labels fire pull_request action='labeled' carrying body.label, NOT
//     issues.labeled — mirroring the issues.labeled branch (toState from the
//     label, fromState from the substrate's other status label or the
//     ledger). `unlabeled` classifies status:* removal as a substrate-
//     invariant violation for parity with the issues path.
//   - For pull_request_review.submitted: state=approved → prior → approved
//     (FSM will flag if prior wasn't in_review). state=changes_requested +
//     prior=approved → approved → in_review (the changes-after-approval
//     loop per PR_TRANSITIONS). state=commented and other admin actions
//     defer (informational).
//   - For deployment_status: ledger lookup → prior.toState if found.
//     If no prior AND deploymentState is pending/in_progress → __initial__
//     (legitimate creation). If no prior AND deploymentState is terminal
//     (success/failure/error) → defer with deployment_no_prior_terminal —
//     we missed the creation event; deferring beats writing a phantom
//     transition under HARD-REJECT.

import {
  appBotLoginsFromEnv,
  inferSingleAgentActor,
  resolveActorFromBody,
  resolveActorFromMarkers,
} from './actorResolution.js';
import type { AuditLedgerReader } from './auditLedger.js';
import { DECISION_TRANSITIONS } from './decisionFsm.js';
import { DEPLOYMENT_TRANSITIONS } from './deploymentFsm.js';
import { DESIGN_TRANSITIONS } from './designFsm.js';
import { GOAL_TRANSITIONS } from './goalFsm.js';
import type { Kind } from './kinds.js';
import type { ParsedWebhookEnvelope } from './payloadParser.js';
import { PR_TRANSITIONS } from './prFsm.js';
import type { ParsedTransitionMessage } from './queueConsumer.js';
import { SPEC_TRANSITIONS } from './specFsm.js';
import type { SubstrateClient } from './substrateClient.js';
import { TASK_TRANSITIONS } from './taskFsm.js';
import type { Actor } from './types.js';

const STATUS_LABEL_PREFIX = 'status:';
const INITIAL_STATE = '__initial__';

// Per-kind default initial state, used by the `issues.opened` branch when
// the issue's initial label set has no `status:*` label. Mirrors the
// __initial__ row of each per-kind FSM (see {goal,spec,design,task}Fsm.ts).
// PR + Deployment kinds are NOT here — they ship their own event types
// (pull_request, deployment_status), so they never hit this map via the
// issues branch.
const ISSUE_KIND_INITIAL_STATE: ReadonlyMap<Kind, string> = new Map([
  ['goal', 'proposed'],
  ['spec', 'drafting'],
  ['design', 'drafting'],
  ['task', 'proposed'],
  ['decision', 'drafting'],
]);

// Per-kind terminal state when GitHub's issue.state_reason is 'completed'
// on close. Spec/Design have NO direct completed-via-close path — their
// natural success route is `ready_for_review → ratified` via labeled
// events, not closing. So Spec/Design closes with state_reason=completed
// defer with unsupported_close_state_reason (the human/agent who closed
// the issue without going through ratification is doing something
// outside the documented FSM flow). Decision DOES have a closed-completed
// path: the Decision issue template says the ADR authoring PR may close
// the issue, and the natural close-completed mapping is to `approved`
// per the DECISION_TRANSITIONS table.
// The dispatcher routes the resulting transition through the
// HARD-REJECT decisionFsm — invalid prior states (e.g. closing a
// `proposed` Decision without going through `drafting → proposed →
// approved`) will hard-reject, which is the right enforcement posture.
const ISSUE_CLOSED_COMPLETED_TO_STATE: ReadonlyMap<Kind, string> = new Map([
  ['goal', 'achieved'],
  ['task', 'done'],
  ['decision', 'approved'],
]);

// The lockToken comes from Service Bus on dequeue (or is assigned by the
// in-memory test enqueue), so the resolver returns the message MINUS
// that field. The SB-boundary code stitches it in.
export type ResolvedTransition = Omit<ParsedTransitionMessage, 'lockToken'>;

export type ResolutionFailureReason =
  | 'unsupported_action'
  | 'no_status_label'
  | 'applied_label_no_longer_present'
  | 'multiple_prior_status_labels'
  | 'unsupported_deployment_state'
  | 'deployment_no_prior_terminal'
  | 'unsupported_close_state_reason'
  | 'status_label_removed'
  | 'kind_label_removed'
  | 'unsupported_review_state'
  | 'review_no_prior_pr_state'
  | 'review_not_in_review'
  // A status:* label/close that resolves fromState === toState (no FSM
  // transition). Observational: settled cleanly, NOT dead-lettered
  // — OpsAgent's post-merge close fires this on every completed Task, and the
  // close/label whose session-FIFO order lands second is benign bookkeeping.
  | 'transition_no_op'
  // A status:* label REMOVED from a PR, observational ONLY under the
  // converging rule in isConvergingStatusRemoval (fresh-ledger cleanup OR
  // FSM-forward stale-ledger swap). Settled cleanly
  // (the consumer completeMessage()s rather than dead-lettering). Anything
  // else — true reversal with no legal FSM edge, ledgered label absent with
  // no forward edge, no prior ledger row — stays the status_label_removed
  // violation.
  | 'pr_status_label_removed_observational'
  // The same converging tolerance for ISSUES (OpsAgent's
  // post-merge apply-then-remove Task swap is the driving case; see
  // isConvergingStatusRemoval for the full rule). A removal that would let
  // the planner re-derive a REVERSED state (e.g. ready over a done ledger,
  // no legal done→ready edge) stays the status_label_removed violation.
  | 'status_label_removed_observational'
  // issues action='edited'. Body/title edits
  // carry NO FSM transition — SF state is label-driven (status:*). Every
  // agent appendToBody PATCH (BuildAgent's `pr-ref:` backlink write) and
  // every human body edit fires it; without this reason each one would
  // dead-letter as unsupported_action. Observational — settled cleanly.
  | 'issue_edited_observational'
  // pull_request actions `synchronize` + `edited` carry NO FSM
  // transition — PR state is native-event (opened/closed/ready_for_review) +
  // status-label driven. `synchronize` fires on EVERY push to a PR branch
  // (including BuildAgent's own pushes) and `edited` on every PR body/title
  // edit; without this reason each one dead-letters as unsupported_action.
  // Observational — settled cleanly. detail = the action.
  | 'pr_event_observational'
  // issues.closed(state_reason=completed) on a record that
  // ALREADY carries its terminal status:<toState> label. OpsAgent's post-merge
  // bookkeeping applies status:done THEN closes the issue; the close webhook can
  // resolve in the SAME validator batch as the label apply (the batch reads every
  // message's fromState BEFORE appending rows), so the ledger fromState is stale
  // (pre-`done`) and the fromState===toState no-op guard would MISS it — emitting
  // a DUPLICATE terminal transition + PlannerAgent dispatch. The live label proves
  // the FSM already reached toState, so the close is observational. Settled cleanly.
  | 'issue_close_completed_observational'
  // ADR 0009 §D: an App-sent transition whose real agent actor could be
  // resolved neither from a structural marker (body/comments) NOR from the
  // single-agent FSM fallback (the edge admits multiple agents → ambiguous).
  // Deferring beats guessing — never silently accept an ambiguous actor.
  | 'actor_unresolved_app_sender';

export type ResolveResult =
  | { ok: true; transition: ResolvedTransition }
  // `observational: true` marks a benign, non-transition event that must be
  // settled cleanly (completeMessage) rather than dead-lettered — it is not a
  // failure, just "nothing to record." Absent/false on real resolution failures.
  | { ok: false; reason: ResolutionFailureReason; detail?: string; observational?: true };

export interface ResolveDependencies {
  substrate: SubstrateClient;
  ledger: AuditLedgerReader;
  // The recognized App `<slug>[bot]` login set used to authenticate structural
  // markers during App-actor resolution. MUST be the SAME set the parser used to
  // recognize the App sender (ServiceBusEventQueueConsumerConfig.appBotLogins) —
  // otherwise a deployment that configures its slug via config rather than
  // GITHUB_APP_SLUG would parse the sender but reject its own markers.
  // Falls back to appBotLoginsFromEnv() when omitted (tests/boot).
  appBotLogins?: ReadonlySet<string>;
}

function makeTransition(
  envelope: ParsedWebhookEnvelope,
  fromState: string,
  toState: string,
): ResolvedTransition {
  return {
    deliveryId: envelope.deliveryId,
    eventType: envelope.eventType,
    kind: envelope.kind,
    actor: envelope.actor,
    recordType: envelope.recordType,
    recordKind: envelope.recordKind,
    recordId: envelope.recordId,
    fromState,
    toState,
    payloadHash: envelope.payloadHash,
    receivedAt: envelope.receivedAt,
    // ADR 0012 §"Activation status" activation gate (a): propagate
    // head/base branch names from the parser envelope onto the
    // resolved transition message so the orchestrator's pre-review
    // branch-sync gate can resolve sync state for real traffic.
    // Undefined for non-PR envelopes (parser does not populate).
    ...(envelope.headBranch !== undefined ? { headBranch: envelope.headBranch } : {}),
    ...(envelope.baseBranch !== undefined ? { baseBranch: envelope.baseBranch } : {}),
    // Propagate the target repo slug + installation id so the
    // orchestrator + agents authenticate as the right installation.
    ...(envelope.repoFullName !== undefined ? { repoFullName: envelope.repoFullName } : {}),
    ...(envelope.installationId !== undefined ? { installationId: envelope.installationId } : {}),
  };
}

async function priorToStateOrInitial(ledger: AuditLedgerReader, recordId: string): Promise<string> {
  const prior = await ledger.getLastTransitionForRecord(recordId);
  return prior?.toState ?? INITIAL_STATE;
}

// Kind-aware fromState fallback for the issues.labeled STEADY-STATE branch.
// When an agent (PlannerAgent's in-run root promotion)
// applies `status:ready` to a freshly-created Task before its
// issues.opened→proposed ledger row has landed, the plain
// priorToStateOrInitial would fall back to __initial__ → yielding
// `task:__initial__→ready`, which the Task FSM flags (verdict-gated →
// BuildAgent never dispatched). Resolving the ABSENT prior to the per-kind
// initial state instead yields `task:proposed→ready` — the legitimate
// promote edge — so the in-run promote is safe even before the proposed row
// is written. Falls back to __initial__ for kinds outside ISSUE_KIND_INITIAL_STATE.
async function priorToStateOrKindDefault(
  ledger: AuditLedgerReader,
  recordId: string,
  kind: Kind,
): Promise<string> {
  const prior = await ledger.getLastTransitionForRecord(recordId);
  return prior?.toState ?? ISSUE_KIND_INITIAL_STATE.get(kind) ?? INITIAL_STATE;
}

async function resolveIssuesOpenedTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  // issues.opened has no statusLabel on the envelope (parser only sets it
  // for labeled events). Use envelope.labels — the webhook-fire-time
  // label set passed through by the parser. Reading substrate at decision
  // time would race against any labels applied between webhook fire and
  // validator run.
  const initialLabels = envelope.labels ?? [];
  const statusLabels = initialLabels.filter((name) => name.startsWith(STATUS_LABEL_PREFIX));
  if (statusLabels.length >= 2) {
    return {
      ok: false,
      reason: 'multiple_prior_status_labels',
      detail: statusLabels.join(','),
    };
  }

  let toState: string;
  if (statusLabels.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: length checked above.
    toState = statusLabels[0]!.slice(STATUS_LABEL_PREFIX.length);
  } else {
    // No status:* label on the new issue — use the per-kind default initial
    // state (validator-bot.md FSM tables). Goal/Task → proposed, Spec/Design
    // → drafting.
    const defaultInitial = ISSUE_KIND_INITIAL_STATE.get(envelope.kind);
    if (defaultInitial === undefined) {
      // Kinds outside the issue-event surface (pr, deployment) shouldn't
      // hit this branch; defensive — the parser wouldn't emit an issues
      // event for those kinds.
      return { ok: false, reason: 'unsupported_action', detail: envelope.action };
    }
    toState = defaultInitial;
  }

  // fromState via ledger lookup. For a brand-new issue this is __initial__;
  // for a re-opened issue (which GitHub fires as `reopened`, not `opened`,
  // but defensive coverage costs nothing) it would be the prior toState.
  const fromState = await priorToStateOrInitial(deps.ledger, envelope.recordId);

  return { ok: true, transition: makeTransition(envelope, fromState, toState) };
}

async function resolveIssuesClosedTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  // GitHub's issue.state_reason disambiguates the close intent:
  //   - 'not_planned' → 'abandoned' for ALL kinds (uniform per FSM tables)
  //   - 'completed'   → per-kind terminal-success (achieved/done); Spec
  //                     and Design have no natural completed-via-close
  //                     path so they defer
  //   - undefined/other → defer (can't classify safely)
  // fromState comes from the ledger; if no prior, __initial__ → terminal
  // will FSM-flag (we missed the create/label events).
  const reason = envelope.issueStateReason;
  let toState: string | undefined;
  if (reason === 'not_planned') {
    toState = 'abandoned';
  } else if (reason === 'completed') {
    toState = ISSUE_CLOSED_COMPLETED_TO_STATE.get(envelope.kind);
  }
  if (toState === undefined) {
    return {
      ok: false,
      reason: 'unsupported_close_state_reason',
      detail: reason === undefined ? `kind=${envelope.kind}` : `${envelope.kind}:${reason}`,
    };
  }
  // Batch-stale-ledger guard. If the record ALREADY carries its
  // terminal status:<toState> label, the close is observational bookkeeping
  // regardless of ledger timing — robust where the fromState===toState guard
  // below (which trusts the ledger) misses the same-batch apply+close race.
  // Mirrors isConvergingStatusRemoval's live-label check.
  const terminalLabel = `${STATUS_LABEL_PREFIX}${toState}`;
  const currentLabels = await deps.substrate.getCurrentLabels(envelope.recordId);
  if (currentLabels.includes(terminalLabel)) {
    return {
      ok: false,
      reason: 'issue_close_completed_observational',
      detail: `${envelope.kind}:${toState}`,
      observational: true,
    };
  }
  const fromState = await priorToStateOrInitial(deps.ledger, envelope.recordId);
  // Transition no-op guard: when fromState already equals toState (e.g.
  // the ADR PR's "closes #N" auto-closes a Decision issue that was
  // already moved to `approved` by ReviewAgent), the close is observational
  // bookkeeping — there's no FSM transition to record. Without the guard
  // the dispatcher emits `approved → approved` which the (HARD-REJECT)
  // Decision FSM treats as illegal_transition.
  // The same guard helps any future kind where close-completed races with
  // the documented success-path transition.
  if (fromState === toState) {
    return {
      ok: false,
      reason: 'transition_no_op',
      detail: `${envelope.kind}:${fromState}`,
      // Observational: a close that no-ops against an
      // already-terminal ledger is benign bookkeeping, not a transition — and
      // OpsAgent closes EVERY completed Task (reason=completed), so this
      // fires on the normal success path. Settle cleanly instead of DLQ-ing.
      observational: true,
    };
  }
  return { ok: true, transition: makeTransition(envelope, fromState, toState) };
}

// Per-kind FSM transition tables, keyed by the resolver's Kind. Imported from
// the same FSM modules the dispatcher consumes (no import cycle — FSM files
// import nothing from this resolver). Value type erases each table's
// kind-specific FromState key union + AllowedTransition payload; only edge
// EXISTENCE is consulted here (actor authorization stays the dispatcher's job).
type StateTransitionTable = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const KIND_TRANSITION_TABLES: ReadonlyMap<Kind, StateTransitionTable> = new Map<
  Kind,
  StateTransitionTable
>([
  ['goal', GOAL_TRANSITIONS],
  ['spec', SPEC_TRANSITIONS],
  ['design', DESIGN_TRANSITIONS],
  ['task', TASK_TRANSITIONS],
  ['pr', PR_TRANSITIONS],
  ['deployment', DEPLOYMENT_TRANSITIONS],
  ['decision', DECISION_TRANSITIONS],
]);

// True iff the per-kind FSM has a legal edge fromState→toState (states, not
// labels — callers strip the 'status:' prefix).
function hasLegalEdge(kind: Kind, fromState: string, toState: string): boolean {
  return KIND_TRANSITION_TABLES.get(kind)?.[fromState]?.[toState] !== undefined;
}

// CONVERGING-REMOVAL rule for status:* label removals, shared by the issues +
// PR unlabeled branches.
// A removal is observational (benign swap cleanup; settled, not dead-lettered)
// iff one of:
//   (A) FRESH-LEDGER CLEANUP: the removed label is NOT the ledgered state's
//       label AND the ledgered state's label remains — cleanup converging the
//       substrate toward the ledger (OpsAgent / ReviewAgent apply-then-remove
//       where the apply's ledger row already landed).
//   (B) FSM-FORWARD SWAP (stale-ledger window): the removed label IS the
//       ledgered state's label, it no longer remains, AND some remaining
//       status label is a LEGAL per-kind FSM edge away from the removed state
//       (hasLegalEdge). Covers the apply+remove pair arriving in ONE Service
//       Bus batch: the whole batch is resolved BEFORE processMessage appends
//       any ledger rows, so the removal half still sees the ledger at the
//       PRIOR state (e.g. ledger=ready while status:done was applied earlier
//       in the same batch). Must hold regardless of MAX_BATCH_SIZE — live
//       runs batch=1 today, but the code must not depend on an env setting.
//       PR nuance: prFsm HAS approved→in_review (changes-after-approval), so
//       removing status:approved with status:in_review remaining is
//       FSM-forward-legal → observational. That is a genuinely LEGAL
//       regression direction for PRs, and the ledger records the actual
//       approved→in_review transition from the labeled half of the same swap.
// Anything else — a true REVERSAL with no legal edge (task done→ready), a
// lone removal, or NO prior ledger row (conservative) — is the
// status_label_removed violation (its PR variant on the PR branch).
async function isConvergingStatusRemoval(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
  removed: string,
): Promise<boolean> {
  const prior = await deps.ledger.getLastTransitionForRecord(envelope.recordId);
  if (prior === undefined) return false;
  const ledgeredLabel = `${STATUS_LABEL_PREFIX}${prior.toState}`;
  const currentLabels = await deps.substrate.getCurrentLabels(envelope.recordId);
  // (A) fresh-ledger cleanup.
  if (removed !== ledgeredLabel && currentLabels.includes(ledgeredLabel)) {
    return true;
  }
  // (B) FSM-forward swap resolved before the apply's ledger row landed.
  if (removed === ledgeredLabel && !currentLabels.includes(ledgeredLabel)) {
    const removedState = removed.slice(STATUS_LABEL_PREFIX.length);
    return currentLabels.some(
      (name) =>
        name.startsWith(STATUS_LABEL_PREFIX) &&
        hasLegalEdge(envelope.kind, removedState, name.slice(STATUS_LABEL_PREFIX.length)),
    );
  }
  return false;
}

async function resolveIssuesUnlabeledTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  // Classifies the just-removed label. A LONE status:* removal is a substrate
  // invariant violation — every active record must carry a status label;
  // removing it puts the record in a stateless limbo that the Decision
  // FSM (v0+) handles via policy:violation. kind:* removal removes the
  // record from the substrate entirely (ADR 0006), also a violation.
  // Other label removals (priority, area, etc.) are not transitions.
  const removed = envelope.removedLabel;
  if (removed === undefined) {
    return { ok: false, reason: 'unsupported_action', detail: 'unlabeled (no label name)' };
  }
  if (removed.startsWith(STATUS_LABEL_PREFIX)) {
    // Observational iff the removal converges the substrate (fresh-ledger
    // cleanup OR FSM-forward stale-ledger swap) — full rule + rationale on
    // isConvergingStatusRemoval. Everything else (true reversal, lone
    // removal, no prior ledger row) is the violation.
    if (await isConvergingStatusRemoval(envelope, deps, removed)) {
      return {
        ok: false,
        reason: 'status_label_removed_observational',
        detail: removed,
        observational: true,
      };
    }
    return { ok: false, reason: 'status_label_removed', detail: removed };
  }
  if (removed.startsWith('kind:')) {
    return { ok: false, reason: 'kind_label_removed', detail: removed };
  }
  return { ok: false, reason: 'unsupported_action', detail: `unlabeled:${removed}` };
}

async function resolveIssuesReopenedTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  // GitHub fires `reopened` when a previously-closed issue is re-opened.
  // The ledger should have a prior terminal-state transition (abandoned /
  // achieved / done) for this record. SF FSM rules don't allow reopening
  // from terminal states (every kind's terminal row is empty), so the
  // dispatcher will flag illegal_transition — correct v0 audit posture
  // (humans / agents reopening terminal records is non-standard).
  const fromState = await priorToStateOrInitial(deps.ledger, envelope.recordId);
  const toState = ISSUE_KIND_INITIAL_STATE.get(envelope.kind);
  if (toState === undefined) {
    return { ok: false, reason: 'unsupported_action', detail: 'reopened (unknown kind)' };
  }
  return { ok: true, transition: makeTransition(envelope, fromState, toState) };
}

async function resolveIssuesTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  if (envelope.action === 'opened') {
    return resolveIssuesOpenedTransition(envelope, deps);
  }
  if (envelope.action === 'closed') {
    return resolveIssuesClosedTransition(envelope, deps);
  }
  if (envelope.action === 'reopened') {
    return resolveIssuesReopenedTransition(envelope, deps);
  }
  if (envelope.action === 'unlabeled') {
    return resolveIssuesUnlabeledTransition(envelope, deps);
  }
  if (envelope.action === 'edited') {
    // Body/title edits carry NO FSM
    // transition — SF state is label-driven (status:*). Every agent
    // appendToBody PATCH (BuildAgent's `pr-ref:` backlink write) and every
    // human issue edit fires issues.edited; settling observationally keeps
    // each one out of the DLQ (instead of unsupported_action → dead-letter).
    return {
      ok: false,
      reason: 'issue_edited_observational',
      detail: envelope.actor,
      observational: true,
    };
  }
  if (envelope.action !== 'labeled') {
    return { ok: false, reason: 'unsupported_action', detail: envelope.action };
  }
  if (envelope.statusLabel === undefined) {
    return { ok: false, reason: 'no_status_label' };
  }
  const toState = envelope.statusLabel.slice(STATUS_LABEL_PREFIX.length);

  const currentLabels = await deps.substrate.getCurrentLabels(envelope.recordId);
  // Race guard: between the webhook firing and this resolver running, an
  // agent / human could have removed or replaced the just-applied label.
  // If statusLabel is absent from the substrate's current view, the
  // transition the envelope describes never durably landed — defer rather
  // than write a phantom entry to the audit ledger.
  if (!currentLabels.includes(envelope.statusLabel)) {
    return {
      ok: false,
      reason: 'applied_label_no_longer_present',
      detail: envelope.statusLabel,
    };
  }
  const otherStatusLabels = currentLabels.filter(
    (name) => name.startsWith(STATUS_LABEL_PREFIX) && name !== envelope.statusLabel,
  );
  if (otherStatusLabels.length >= 2) {
    return {
      ok: false,
      reason: 'multiple_prior_status_labels',
      detail: otherStatusLabels.join(','),
    };
  }
  let fromState: string;
  if (otherStatusLabels.length === 1) {
    // Mid-replacement window: both old + new status:* labels coexist.
    // biome-ignore lint/style/noNonNullAssertion: length checked above.
    const priorStatusLabel = otherStatusLabels[0]!;
    fromState = priorStatusLabel.slice(STATUS_LABEL_PREFIX.length);
  } else {
    // Substrate is in single-status steady state (or this is the
    // first-labeling case). Consult the audit ledger; an ABSENT prior row
    // resolves to the per-kind initial state (NOT __initial__) so an agent's
    // status-label write that races ahead of the issues.opened ledger row
    // still resolves the legitimate `<kind-initial>→<to>` edge (e.g.
    // PlannerAgent's in-run root promotion of a freshly-created Task).
    fromState = await priorToStateOrKindDefault(deps.ledger, envelope.recordId, envelope.kind);
  }

  // Transition no-op guard (symmetry with resolveIssuesClosedTransition):
  // a status:* label re-applied with no state change (fromState === toState)
  // carries no FSM transition. This arises on the post-merge completion path —
  // OpsAgent BOTH applies status:done AND closes the Task (state_reason=completed),
  // and both events map to task:*→done. Whichever the session-FIFO orders SECOND
  // resolves against the now-`done` ledger; without the guard the labeled half
  // would emit task:done→done, which the FSM flags as a terminal self-loop (a
  // false policy:violation on a normal successful merge). Settle observationally.
  if (fromState === toState) {
    return {
      ok: false,
      reason: 'transition_no_op',
      detail: `${envelope.kind}:${fromState}`,
      observational: true,
    };
  }

  return { ok: true, transition: makeTransition(envelope, fromState, toState) };
}

async function resolvePullRequestTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  switch (envelope.action) {
    case 'opened': {
      // GitHub's pull_request.opened fires once per PR creation; draft flag
      // disambiguates initial state. prFsm.ts has __initial__ → draft/open
      // rules with allowedActors=[BuildAgent, human], so this transition is
      // FSM-accept for the canonical authoring path.
      const toState = envelope.draft === true ? 'draft' : 'open';
      return { ok: true, transition: makeTransition(envelope, INITIAL_STATE, toState) };
    }
    case 'ready_for_review': {
      // PR_TRANSITIONS: only draft → open exists (no in_review/approved/merged → open).
      // Confirm via ledger; fall back to draft if no prior recorded (graceful).
      const prior = await deps.ledger.getLastTransitionForRecord(envelope.recordId);
      const fromState = prior?.toState ?? 'draft';
      return { ok: true, transition: makeTransition(envelope, fromState, 'open') };
    }
    case 'review_requested': {
      // Drives open → in_review (or draft → in_review if reviewer requested
      // on a draft, which GitHub allows). Only emit when prior is a
      // legitimate review-entry state — otherwise GitHub's review_requested
      // is just "add another reviewer" on an already-reviewing PR and
      // is NOT a state transition. Emitting prior → in_review for
      // prior=approved would regress an approved PR.
      const fromState = await priorToStateOrInitial(deps.ledger, envelope.recordId);
      if (fromState !== 'open' && fromState !== 'draft') {
        return {
          ok: false,
          reason: 'unsupported_action',
          detail: `review_requested with prior=${fromState}`,
        };
      }
      return { ok: true, transition: makeTransition(envelope, fromState, 'in_review') };
    }
    case 'closed': {
      // Ledger-resolved fromState: prior.toState is the actual PR state at
      // the moment of close. Without this, fabricated `approved → merged`
      // would silently launder admin-bypass merges as compliant.
      // No prior → __initial__ → {merged,closed}: FSM rules for __initial__
      // only allow draft/open, so the dispatcher will flag illegal_transition,
      // which is the right audit posture (we missed the opened event).
      const fromState = await priorToStateOrInitial(deps.ledger, envelope.recordId);
      const toState = envelope.merged === true ? 'merged' : 'closed';
      return { ok: true, transition: makeTransition(envelope, fromState, toState) };
    }
    case 'labeled':
      // ReviewAgent drives the PR review FSM by
      // applying status:* labels (status:in_review / status:approved) on the
      // PR. Because a PR is an Issue, this fires `pull_request` action='labeled'
      // carrying `body.label`. Resolution mirrors the issues.labeled branch:
      // toState from the status:* label, fromState from the substrate's other
      // status:* label (mid-replacement window) or the ledger. The App actor
      // (ReviewAgent) is finished by resolveAppActor — single-agent FSM
      // fallback on `pr:in_review→approved`, comment marker on the multi-agent
      // `pr:open→in_review` edge.
      return resolvePullRequestLabeledTransition(envelope, deps);
    case 'unlabeled':
      // A status:* removal on a PR is OBSERVATIONAL only under the converging
      // rule (isConvergingStatusRemoval: fresh-ledger cleanup OR FSM-forward
      // stale-ledger swap); anything else is the status_label_removed
      // violation, like the issues path.
      return resolvePullRequestUnlabeledTransition(envelope, deps);
    case 'synchronize':
    case 'edited':
      // Neither carries an FSM transition (PR state is native
      // events + status:* labels). `synchronize` fires on every push to the
      // PR branch — BuildAgent's own pushes included — and `edited` on every
      // PR body/title edit. Settle observationally instead of dead-lettering
      // (mirrors issue_edited_observational on the issues path).
      return {
        ok: false,
        reason: 'pr_event_observational',
        detail: envelope.action,
        observational: true,
      };
    default:
      // converted_to_draft / review_requested-extra / etc.
      // None map to a PR FSM transition without further context; defer.
      return { ok: false, reason: 'unsupported_action', detail: envelope.action };
  }
}

async function resolvePullRequestLabeledTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  if (envelope.statusLabel === undefined) {
    // A non-status label (area:*, priority:*, etc.) applied to a PR is not a
    // FSM transition — defer like any other unsupported PR action.
    return { ok: false, reason: 'no_status_label' };
  }
  const toState = envelope.statusLabel.slice(STATUS_LABEL_PREFIX.length);

  const currentLabels = await deps.substrate.getCurrentLabels(envelope.recordId);
  // Race guard (same as the issues.labeled branch): if the just-applied label
  // is no longer on the PR, the transition never durably landed — defer.
  if (!currentLabels.includes(envelope.statusLabel)) {
    return {
      ok: false,
      reason: 'applied_label_no_longer_present',
      detail: envelope.statusLabel,
    };
  }
  const otherStatusLabels = currentLabels.filter(
    (name) => name.startsWith(STATUS_LABEL_PREFIX) && name !== envelope.statusLabel,
  );
  if (otherStatusLabels.length >= 2) {
    return {
      ok: false,
      reason: 'multiple_prior_status_labels',
      detail: otherStatusLabels.join(','),
    };
  }
  let fromState: string;
  if (otherStatusLabels.length === 1) {
    // Mid-replacement window: prior + new status label coexist on the PR.
    // biome-ignore lint/style/noNonNullAssertion: length checked above.
    fromState = otherStatusLabels[0]!.slice(STATUS_LABEL_PREFIX.length);
  } else {
    // Steady state (single status label) or first labeling: consult the
    // ledger. A PR's native open/draft state is recorded there by the
    // pull_request.opened branch, so e.g. status:in_review on a just-opened
    // PR resolves fromState=open from the ledger.
    fromState = await priorToStateOrInitial(deps.ledger, envelope.recordId);
  }

  return { ok: true, transition: makeTransition(envelope, fromState, toState) };
}

async function resolvePullRequestUnlabeledTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  const removed = envelope.removedLabel;
  if (removed === undefined) {
    return { ok: false, reason: 'unsupported_action', detail: 'unlabeled (no label name)' };
  }
  if (removed.startsWith(STATUS_LABEL_PREFIX)) {
    // Same converging rule as the issues branch (fresh-ledger cleanup OR
    // FSM-forward stale-ledger swap) — full rule, the same-batch rationale,
    // and the PR approved→in_review nuance live on isConvergingStatusRemoval.
    // Everything else is the same status_label_removed violation as the
    // issues path — surface it so the operator sees the gap.
    if (await isConvergingStatusRemoval(envelope, deps, removed)) {
      return {
        ok: false,
        reason: 'pr_status_label_removed_observational',
        detail: removed,
        observational: true,
      };
    }
    return { ok: false, reason: 'status_label_removed', detail: removed };
  }
  return { ok: false, reason: 'unsupported_action', detail: `unlabeled:${removed}` };
}

// GitHub's deployment_status.state values vs the SF DeploymentState
// union (deploymentFsm.ts). 'inactive' is a marker on superseded
// deployments, not a state transition — defer. 'queued' is a pre-
// deployment GitHub-side state with no clean FSM mapping; defer until
// the deployment ingest design specifies it. 'waiting' maps to
// awaiting_approval per validator-bot.md's `pending → awaiting_approval
// → in_progress` path for GitHub Environments with required reviewers.
const DEPLOYMENT_STATE_MAP: ReadonlyMap<string, string> = new Map([
  ['pending', 'pending'],
  ['in_progress', 'in_progress'],
  ['waiting', 'awaiting_approval'],
  ['success', 'success'],
  ['failure', 'failure'],
  ['error', 'error'],
]);

// Non-creation states for the deployment FSM. The __initial__ row of
// deploymentFsm only includes pending and in_progress; any other toState
// emitted from __initial__ would hit FSM's illegal_transition branch →
// hard-reject (substrate revert + policy:violation + Decision Issue +
// agent throttling). When the ledger has no prior for these states, the
// resolver defers rather than phantom-writing. awaiting_approval is on
// this list because GitHub fires waiting (= awaiting_approval) before
// pending only in misconfigured environments; the legitimate path is
// pending → awaiting_approval.
const DEPLOYMENT_REQUIRES_PRIOR: ReadonlySet<string> = new Set([
  'awaiting_approval',
  'success',
  'failure',
  'error',
]);

async function resolveDeploymentStatusTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  if (envelope.deploymentState === undefined) {
    return { ok: false, reason: 'unsupported_action', detail: envelope.action };
  }
  const toState = DEPLOYMENT_STATE_MAP.get(envelope.deploymentState);
  if (toState === undefined) {
    return {
      ok: false,
      reason: 'unsupported_deployment_state',
      detail: envelope.deploymentState,
    };
  }

  const prior = await deps.ledger.getLastTransitionForRecord(envelope.recordId);
  if (prior !== undefined && prior.toState !== undefined) {
    return { ok: true, transition: makeTransition(envelope, prior.toState, toState) };
  }

  // No prior in the ledger. Two sub-cases:
  if (DEPLOYMENT_REQUIRES_PRIOR.has(toState)) {
    // Terminal state with no prior in_progress — we missed the creation.
    // Defer rather than phantom-write under HARD-REJECT.
    return {
      ok: false,
      reason: 'deployment_no_prior_terminal',
      detail: `${envelope.deploymentState}→${toState}`,
    };
  }
  // Legitimate creation event (pending or in_progress). Use the synthetic
  // __initial__ fromState; deploymentFsm has explicit rules for these.
  return { ok: true, transition: makeTransition(envelope, INITIAL_STATE, toState) };
}

async function resolvePullRequestReviewTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  // Only `submitted` carries a state transition; `edited`/`dismissed`
  // are administrative and don't move the PR FSM.
  if (envelope.action !== 'submitted') {
    return { ok: false, reason: 'unsupported_action', detail: envelope.action };
  }
  const reviewState = envelope.reviewState;
  if (reviewState === undefined) {
    return { ok: false, reason: 'unsupported_review_state', detail: '<missing>' };
  }
  if (reviewState === 'commented') {
    // Commented reviews are informational; they don't transition PR state.
    return { ok: false, reason: 'unsupported_review_state', detail: 'commented' };
  }

  const prior = await deps.ledger.getLastTransitionForRecord(envelope.recordId);
  if (prior === undefined || prior.toState === undefined) {
    // PR has no prior state in the ledger — we missed the opened event.
    // Deferring is safer than guessing in_review or open.
    return { ok: false, reason: 'review_no_prior_pr_state', detail: reviewState };
  }

  if (reviewState === 'approved') {
    // PR_TRANSITIONS: in_review → approved (human, ReviewAgent). Only emit
    // when prior.toState === 'in_review'; other priors (open without
    // review_requested first, draft, terminal states) defer rather than
    // emitting an FSM-illegal open → approved.
    // The bridge case where ad-hoc approval implies open → in_review →
    // approved is v0+ scope (single-event-two-transitions design gap).
    if (prior.toState !== 'in_review') {
      return {
        ok: false,
        reason: 'review_not_in_review',
        detail: `approved with prior=${prior.toState}`,
      };
    }
    return {
      ok: true,
      transition: makeTransition(envelope, 'in_review', 'approved'),
    };
  }
  if (reviewState === 'changes_requested') {
    // PR_TRANSITIONS: approved → in_review (system) is the changes-after-approval
    // loop. From in_review, a native CHANGES_REQUESTED review is DEFERRED:
    // although pr:in_review→changes_requested is a legal FSM edge, the
    // revision loop is driven by the status:changes_requested LABEL + a
    // structural verdict=request-changes findings comment (ReviewAgent's path).
    // A native review applies NEITHER, so accepting the edge here would advance
    // the ledger + dispatch BuildAgent while runRevision skips (no label) / fails
    // (no findings) — stranding the PR. Supporting human native request-changes
    // needs the downstream evidence bridge first; until then,
    // deferring leaves the record cleanly at in_review.
    if (prior.toState === 'approved') {
      return { ok: true, transition: makeTransition(envelope, 'approved', 'in_review') };
    }
    return { ok: false, reason: 'unsupported_review_state', detail: 'changes_requested' };
  }
  // Unknown review state (e.g. 'dismissed' on a re-review).
  return { ok: false, reason: 'unsupported_review_state', detail: reviewState };
}

// ADR 0009 §D: finish actor resolution for an App-sent transition whose actor
// the (pure) parser could not resolve from the record body marker. Runs AFTER
// fromState/toState are known (the single-agent fallback needs the edge):
//   1. PRIMARY — the most recent structural marker on the record's recent
//      comments (+ body) read via the substrate.
//   2. FALLBACK — the edge's single agent actor when unambiguous. Trust
//      assumption: the App key is factory-only (ADR 0009 §1), so an App-sent
//      transition is genuinely the factory; a single-agent edge is
//      unambiguous attribution.
// Returns the resolved actor, or undefined when both fail (ambiguous → defer).
async function resolveAppActor(
  transition: ResolvedTransition,
  substrate: SubstrateClient,
  appBotLogins: ReadonlySet<string>,
): Promise<Actor | undefined> {
  // 1. PRIMARY — the edge's single agent actor when exactly one agent is allowed
  //    (`system`/`human` co-authors are stripped). On a single-agent edge that
  //    agent is the ONLY FSM-valid actor, so this is authoritative AND immune to
  //    stale markers: an older App comment from a *different* action (e.g. the
  //    BuildAgent stamp left when the PR opened) must NOT win over a later
  //    review-loop transition whose edge admits exactly ReviewAgent. Resolving
  //    the edge first also skips a substrate read on the common path. A
  //    possibly-stale comment must never beat the unambiguous edge.
  const inferred = inferSingleAgentActor(transition.kind, transition.fromState, transition.toState);
  if (inferred !== undefined) return inferred;
  // The edge is ambiguous (≥2 candidate agents) or agent-less. Recover the
  // acting agent from App-authored markers (ADR 0009 §D); comments and
  // human-opened bodies are forgeable, so the resolver filters by author login.
  const surfaces = await substrate.getStructuralMarkers(transition.recordId);
  if (surfaces !== undefined) {
    // 2. The most recent App-authored COMMENT marker — the acting agent's stamp.
    const fromComments = resolveActorFromMarkers(surfaces, appBotLogins);
    if (fromComments !== undefined) return fromComments;
    // 3. CREATION-edge body — only for `__initial__→X` (record just created)
    //    where the edge admits multiple AGENT authors (e.g. Decision =
    //    AUTHOR_ACTORS) and no comment marker exists yet; there the App-authored
    //    body's creator stamp IS the actor. Never used for a later transition
    //    (the body would be the stale creator stamp).
    if (transition.fromState === '__initial__') {
      const fromBody = resolveActorFromBody(surfaces, appBotLogins);
      if (fromBody !== undefined) return fromBody;
    }
  }
  return undefined;
}

async function dispatchByEventType(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  if (envelope.eventType === 'pull_request') {
    return resolvePullRequestTransition(envelope, deps);
  }
  if (envelope.eventType === 'pull_request_review') {
    return resolvePullRequestReviewTransition(envelope, deps);
  }
  if (envelope.eventType === 'deployment_status') {
    return resolveDeploymentStatusTransition(envelope, deps);
  }
  // issues + any future event types fall through here. Today only
  // `issues` is handled in resolveIssuesTransition; payloadParser
  // returns unknown_event_type for anything else, so envelopes here
  // for a non-issues event are unreachable in the current pipeline.
  return resolveIssuesTransition(envelope, deps);
}

export async function resolveTransition(
  envelope: ParsedWebhookEnvelope,
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  const result = await dispatchByEventType(envelope, deps);
  if (!result.ok) return result;
  // ADR 0009 §D: the App-sent actor was deferred by the parser (no body
  // marker). Resolve it now from comments + the single-agent fallback; the
  // placeholder actor never reaches the FSM unless we resolve or defer here.
  if (envelope.appActorUnresolved === true) {
    // Use the SAME App-bot login set the parser used (deps.appBotLogins),
    // falling back to env only when the caller didn't thread one.
    const appBotLogins = deps.appBotLogins ?? appBotLoginsFromEnv();
    const actor = await resolveAppActor(result.transition, deps.substrate, appBotLogins);
    if (actor === undefined) {
      return {
        ok: false,
        reason: 'actor_unresolved_app_sender',
        detail: `${result.transition.kind}:${result.transition.fromState}→${result.transition.toState}`,
      };
    }
    return { ok: true, transition: { ...result.transition, actor } };
  }
  return result;
}
