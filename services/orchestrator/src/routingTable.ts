// Spec: docs/architecture.md (L4 routing) + docs/design/validator-bot.md
// (per-kind FSMs that produce the transitions).
// Invariants:
//   - Pure: takes a transition shape, returns an AgentRole or a typed
//     failure. No I/O, no clock, no env reads.
//   - The routing key is `${kind}:${fromState}→${toState}` for the main
//     table. The transition ACTOR is normally NOT part of the key — routing
//     is "what happens next given this transition," not "who did it".
//   - EXCEPTION for `__initial__` transitions where humans + agents are
//     both allowed creators (spec/design/task per their FSM __initial__
//     rows): the orchestrator special-cases actor=human → dispatch the
//     owner agent. Agent-created records have the agent already running
//     (no dispatch). Without the actor branch, human-created records would
//     silently strand because no one advances them.
//   - Routes only legitimate, FSM-accepted transitions. processMessage()
//     enforces this with the verdict gate: messages with
//     verdict==='flag' or 'reject' never reach routeTransition; only
//     verdict==='accept' (or undefined for v0 wire compatibility) does.
//   - Many transitions have NO downstream agent (terminal states,
//     human-only acknowledgements, deployment success). Those return
//     ok:false with `no_dispatch_needed` — distinct from
//     `unknown_transition` (the routing table has nothing for this).

import type { AgentRole, Kind, ParsedTransitionMessage } from './types.js';

export type RouteFailureReason = 'unknown_kind' | 'unknown_transition' | 'no_dispatch_needed';

export type RouteResult =
  | { ok: true; agent: AgentRole; transitionKey: string }
  | { ok: false; reason: RouteFailureReason; transitionKey: string };

type TransitionKey = string;

// The routing table for the SF v0 dogfood path. Each row maps an FSM
// transition to the L3 agent that should be dispatched next. Coverage
// is intentionally narrow — transitions not in this table return
// `unknown_transition` so the consumer deadletters cleanly rather than
// silently no-op'ing. Add rows as new agent triggers are designed.
const ROUTING_TABLE: ReadonlyMap<TransitionKey, AgentRole> = new Map([
  // Goal lifecycle:
  //  - human CREATES a Goal (__initial__→proposed) → PlannerAgent triages
  //    it into the live backlog per ADR 0013 §Decision item 4 (Goal is
  //    one of the three intake kinds; PlannerAgent re-evaluates the
  //    ready-frontier whenever new intake lands). goalFsm.ts restricts
  //    __initial__→proposed to actor='human', so this routing key always
  //    means "human created a Goal" — no actor branch needed.
  //  - human ACCEPTS a Goal (proposed→accepted) → SpecAgent decomposes
  //    into Spec(s).
  ['goal:__initial__→proposed', 'PlannerAgent'],
  ['goal:proposed→accepted', 'SpecAgent'],

  // Spec lifecycle: drafted spec ready → ReviewAgent reviews it;
  // ratified spec → DesignAgent produces the corresponding Design(s).
  ['spec:drafting→ready_for_review', 'ReviewAgent'],
  ['spec:ready_for_review→ratified', 'DesignAgent'],

  // Design lifecycle: same shape as Spec — DesignAgent drafts, ReviewAgent
  // reviews, ratification dispatches PlannerAgent to fan out into Tasks.
  ['design:drafting→ready_for_review', 'ReviewAgent'],
  ['design:ready_for_review→ratified', 'PlannerAgent'],

  // Task lifecycle: PlannerAgent marks ready → BuildAgent implements;
  // BuildAgent opens PR (in_review) → ReviewAgent reviews; OpsAgent
  // merges and the merge fires the Deployment flow.
  // The in_review→in_progress cycle is the AUTHORITATIVE dispatch trigger
  // for the revision loop per ADR 0010 (Review record drives Task
  // FSM cycle; orchestrator dispatches BuildAgent on the Task transition,
  // not on the parallel pr:approved→in_review event which would be
  // redundant).
  ['task:proposed→ready', 'BuildAgent'],
  ['task:in_progress→in_review', 'ReviewAgent'],
  ['task:in_review→in_progress', 'BuildAgent'],
  // ADR 0013 §Decision item 4 dep-clear triggers: a Task reaching `done`
  // or `abandoned` may unblock other proposed Tasks whose `blocked-by`
  // list cites it. Dispatch PlannerAgent to re-evaluate the ready-
  // frontier. The post-merge bookkeeping role of task:in_review→done is
  // preserved (the validator already recorded it; PlannerAgent does NOT
  // re-trigger merge work — see runPlannerAgent for the intake-agnostic
  // handler shape). Every →abandoned path is also a dep-clear trigger
  // per ADR 0013 §4 ("any →abandoned" — abandonment removes the block on
  // dependents the same way completion does).
  ['task:in_review→done', 'PlannerAgent'],
  // The Task reaches `done` straight from `ready` two ways —
  // OpsAgent's post-merge bookkeeping (v0 BuildAgent never claims the Task, so
  // it still sits at `ready` when the PR merges) AND BuildAgent's already-
  // satisfied settle (an empty diff for a Task already met by existing code —
  // no PR). taskFsm.ts admits BOTH on ready→done; the routing key is actor-
  // agnostic, so either fires the SAME dep-clear re-plan as task:in_review→done.
  ['task:ready→done', 'PlannerAgent'],
  ['task:proposed→abandoned', 'PlannerAgent'],
  ['task:ready→abandoned', 'PlannerAgent'],
  ['task:in_progress→abandoned', 'PlannerAgent'],
  ['task:in_review→abandoned', 'PlannerAgent'],

  // PR lifecycle: a newly-opened PR needs review; draft→in_review and
  // open→in_review both dispatch ReviewAgent (loop runs WITHIN in_review
  // per ADR 0010). in_review→approved is OpsAgent driving the merge.
  ['pr:__initial__→open', 'ReviewAgent'],
  ['pr:draft→open', 'ReviewAgent'],
  ['pr:draft→in_review', 'ReviewAgent'],
  ['pr:open→in_review', 'ReviewAgent'],
  ['pr:in_review→approved', 'OpsAgent'],
  // Changes-requested revision loop on the PR FSM: ReviewAgent's
  // request-changes drives pr:in_review→changes_requested → dispatch BuildAgent
  // to revise the same branch; BuildAgent drives pr:changes_requested→in_review
  // → re-dispatch ReviewAgent for re-review. The loop runs on the PR FSM (not the
  // Task FSM): in v0 the paired Task stays status:ready through review, so a
  // Task-FSM bounce (task:in_review→in_progress) never fires for an ordinary build.
  ['pr:in_review→changes_requested', 'BuildAgent'],
  ['pr:changes_requested→in_review', 'ReviewAgent'],
  // Re-sync re-review bounce, TWO dispatches so the syncing state is durably
  // ledgered between them (a same-execution swap races the async webhook
  // resolution). Step 1: BuildAgent rebases + drives the
  // PR to syncing → pr:in_review→syncing routes back to BuildAgent to finish.
  // Step 2: BuildAgent drives syncing→in_review → routes to ReviewAgent (the gate
  // re-checks first; the branch is current post-rebase → ReviewAgent, not another
  // rebase).
  ['pr:in_review→syncing', 'BuildAgent'],
  ['pr:syncing→in_review', 'ReviewAgent'],

  // Deployment lifecycle: SREAgent observes failures and errors;
  // success / in_progress / pending have no agent dispatch (no-op
  // observability — the validator already records them).
  ['deployment:in_progress→failure', 'SREAgent'],
  ['deployment:in_progress→error', 'SREAgent'],
]);

// Transitions that ARE legitimate but have NO downstream agent dispatch
// (the next step is human or substrate-only). Listing them explicitly
// distinguishes "we know about this and nothing dispatches" from "we
// don't recognize this transition."
const NO_DISPATCH_TRANSITIONS: ReadonlySet<TransitionKey> = new Set([
  // Goal completion: system observed achievement; nothing to dispatch.
  'goal:in_progress→achieved',
  // Goal abandonment: human cleanup.
  'goal:proposed→abandoned',
  'goal:accepted→abandoned',
  'goal:in_progress→abandoned',
  // Goal acceptance to in_progress is driven BY SpecAgent (so the
  // dispatch already happened upstream when proposed→accepted fired).
  'goal:accepted→in_progress',
  // Task assignment to BuildAgent is the proposed→ready dispatch;
  // ready→in_progress is BuildAgent itself starting work (already
  // dispatched).
  'task:ready→in_progress',
  // NOTE: goal:__initial__→proposed, task:in_review→done, and the four
  // task:*→abandoned keys are in ROUTING_TABLE → PlannerAgent (ADR 0013),
  // not here. PlannerAgent treats them as re-plan triggers (new intake /
  // dependency-clear / abandon-as-dep-clear per ADR 0013 §Decision 4).
  // OpsAgent's merge work on task:in_review→done is already complete by
  // the time that transition fires (OpsAgent ran on pr:in_review→approved
  // upstream), so PlannerAgent treating it as a re-plan trigger does not
  // re-do that work — see runPlannerAgent for the intake-agnostic handler
  // that only ever touches `proposed`-state Tasks.
  // Record-creation transitions: SpecAgent/DesignAgent/PlannerAgent are
  // ALREADY running when they create their records (they were dispatched
  // by an upstream transition). No new dispatch needed; the validator
  // accepts the creation and the orchestrator simply acknowledges it.
  'spec:__initial__→drafting',
  'design:__initial__→drafting',
  'task:__initial__→proposed',
  // Review-rejected: SpecAgent/DesignAgent rework the doc. They're
  // already running (the rejection event came from ReviewAgent, but the
  // rework is driven by the proposing agent who's still in-loop).
  'spec:ready_for_review→drafting',
  'design:ready_for_review→drafting',
  // PR creation (__initial__ → draft): BuildAgent opened a draft;
  // dispatch happens on draft→open or draft→in_review.
  'pr:__initial__→draft',
  // PR merge fires the deployment flow separately; no PR-side dispatch from
  // the routing table. NOTE: processMessage intercepts a
  // NON-OpsAgent pr:*→merged BEFORE routing and dispatches OpsAgent for
  // post-merge Task bookkeeping. An autonomous (actor=OpsAgent)
  // pr:approved→merged is NOT intercepted — that run already bookkept inline —
  // so it falls through to this no-dispatch entry.
  'pr:approved→merged',
  // Changes-after-approval loop for AGENT-driven reviews: the PR-side
  // transition is informational; the authoritative dispatch trigger is
  // the paired task:in_review→in_progress transition (ADR 0010).
  // Human-driven changes-after-approval has NO paired Task transition
  // auto-fired (no agent is running to propagate), so the
  // HUMAN_PR_REGRESSION_DISPATCH branch below catches actor=human
  // separately.
  'pr:approved→in_review',
  // PR/Spec/Design/Task close-paths.
  'pr:draft→closed',
  'pr:open→closed',
  'pr:in_review→closed',
  // Closing a PR parked at changes_requested (revision state) — same
  // no-dispatch close path as the other PR states; without it a
  // normal abandon/close from changes_requested dead-letters as unknown_transition.
  'pr:changes_requested→closed',
  // Re-sync bounce escape: a PR closed mid-bounce. (pr:in_review→
  // syncing is DISPATCHED to BuildAgent for step two — see ROUTING_TABLE.)
  'pr:syncing→closed',
  'pr:approved→closed',
  'spec:drafting→abandoned',
  'spec:ready_for_review→abandoned',
  'spec:ratified→abandoned',
  'spec:ratified→superseded',
  'design:drafting→abandoned',
  'design:ready_for_review→abandoned',
  'design:ratified→abandoned',
  'design:ratified→superseded',
  // Deployment success / in_progress: observability; the validator
  // already records them. SREAgent only acts on failure / error.
  'deployment:__initial__→pending',
  'deployment:__initial__→in_progress',
  'deployment:pending→in_progress',
  'deployment:pending→awaiting_approval',
  'deployment:awaiting_approval→in_progress',
  'deployment:in_progress→success',
  // Decision (kind:decision) — the Decision FSM doesn't drive any agent
  // dispatch by itself. All transitions are either authored by an agent
  // already running (creation/proposal) or executed by humans/system
  // (approval/rejection/supersede). The validator records them; no
  // orchestrator action needed. The orchestrator must know every kind the
  // validator emits (Kind mirror in types.ts).
  'decision:__initial__→drafting',
  'decision:drafting→proposed',
  'decision:drafting→abandoned',
  'decision:proposed→approved',
  'decision:proposed→rejected',
  'decision:approved→superseded',
]);

const KNOWN_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  'goal',
  'spec',
  'design',
  'task',
  'pr',
  'deployment',
  'decision',
]);

const INITIAL_STATE = '__initial__';

// Human-created record dispatch: when a human directly creates a Spec /
// Design / Task issue, the orchestrator dispatches the owner agent so the
// record can advance. Agent-created records hit the same transitions but
// fall through to NO_DISPATCH_TRANSITIONS (the agent is already running).
const HUMAN_CREATION_DISPATCH: ReadonlyMap<TransitionKey, AgentRole> = new Map([
  ['spec:__initial__→drafting', 'SpecAgent'],
  ['design:__initial__→drafting', 'DesignAgent'],
  ['task:__initial__→proposed', 'PlannerAgent'],
]);

// Human-driven transitions that normally rely on an agent-emitted paired
// transition to dispatch downstream work. When the actor is human, no
// agent is running to emit the paired event, so the orchestrator
// dispatches directly. Same shape as HUMAN_CREATION_DISPATCH — both
// instances of the actor-asymmetric pattern documented in the header
// invariants.
const HUMAN_PR_REGRESSION_DISPATCH: ReadonlyMap<TransitionKey, AgentRole> = new Map([
  // Human submitted changes_requested on an approved PR. The agent path
  // relies on the paired task:in_review→in_progress transition emitted
  // downstream; the human path has no such automation. Dispatch
  // BuildAgent directly so the revision loop progresses.
  ['pr:approved→in_review', 'BuildAgent'],
]);

function makeKey(kind: string, fromState: string, toState: string): TransitionKey {
  return `${kind}:${fromState}→${toState}`;
}

export function routeTransition(message: ParsedTransitionMessage): RouteResult {
  const transitionKey = makeKey(message.kind, message.fromState, message.toState);

  if (!KNOWN_KINDS.has(message.kind as Kind)) {
    return { ok: false, reason: 'unknown_kind', transitionKey };
  }

  const agent = ROUTING_TABLE.get(transitionKey);
  if (agent !== undefined) {
    return { ok: true, agent, transitionKey };
  }

  // Actor-asymmetric dispatches: certain transitions are no-dispatch for
  // agent actors (paired transitions or in-loop agents handle the work)
  // but need direct dispatch when a human is the actor (no agent is
  // running to propagate). Two instances today: human creation of Spec/
  // Design/Task records, and human changes-requested-after-approval on PRs.
  if (message.actor === 'human') {
    if (message.fromState === INITIAL_STATE) {
      const humanCreationAgent = HUMAN_CREATION_DISPATCH.get(transitionKey);
      if (humanCreationAgent !== undefined) {
        return { ok: true, agent: humanCreationAgent, transitionKey };
      }
    }
    const humanRegressionAgent = HUMAN_PR_REGRESSION_DISPATCH.get(transitionKey);
    if (humanRegressionAgent !== undefined) {
      return { ok: true, agent: humanRegressionAgent, transitionKey };
    }
  }

  if (NO_DISPATCH_TRANSITIONS.has(transitionKey)) {
    return { ok: false, reason: 'no_dispatch_needed', transitionKey };
  }

  return { ok: false, reason: 'unknown_transition', transitionKey };
}
