// Spec: docs/architecture.md (L3 agent — SpecAgent decomposes Goals).
// Invariants:
//   - Triggered by routing key `goal:proposed→accepted` (orchestrator's
//     routingTable.ts). The handler MUST be tolerant of receiving other
//     transitions if mis-routed and return a typed failure rather than
//     attempting work — defensive guard, not normal path.
//   - v0 minimum: creates ONE Spec issue per accepted Goal, body
//     placeholder ("TODO: SpecAgent v0+ will author real spec content").
//     Multi-spec decomposition + real content authoring (Anthropic model
//     calls) ship in B5-PR9+ once a SpecAgent-LLM adapter exists.
//   - Spec issue gets kind:spec label at creation. status:* labels are
//     NOT applied by the agent — the validator's transitionResolver maps
//     issues.opened (no status:* label) to per-kind default (Spec →
//     drafting) per its ISSUE_KIND_INITIAL_STATE map.
//   - Spec body carries the parent-goal linkage field per ADR 0003
//     (issue-form input field carries the relationship — Projects v2 is
//     deferred per ADR 0007). Field name `parent-goal:` mirrors the
//     spec.yml issue template field.
//   - After creating the Spec, posts a structural comment on the Goal
//     with the sf:structural marker per ADR 0009 §D, naming the new
//     Spec record so the audit trail joins.
//   - AUTO-ADVANCE (hands-off FSM): after creating the Spec (which the
//     validator records as `drafting` via the per-kind default), SpecAgent
//     ALSO drives spec:drafting→ready_for_review — the transition whose
//     allowedActor is SpecAgent (specFsm.ts) and which dispatches
//     ReviewAgent. Mechanism: apply `status:ready_for_review` via
//     issues.applyLabel + post a structural comment carrying the SAME
//     `sf:agent=SpecAgent` marker the agent emits on creation, so the
//     validator's actor-resolution attributes the labeled transition to
//     SpecAgent (else it flags an unattributed agent write). The created
//     Spec carries no `status:*` label (only kind:spec), so there is no
//     `status:drafting` label to remove — the validator's labeled-resolver
//     reads the prior `drafting` state from the audit ledger (per-kind
//     default), yielding a clean drafting→ready_for_review transition.
//   - Repo target for the Spec issue: same repo the Goal lives in
//     (ADR 0003: planning records co-locate with the application repo
//     that owns the Goal). v0 inputs include repo via ParsedTransitionMessage
//     in a follow-up; for now the message doesn't carry repo so the
//     agent uses 'SAME_REPO_AS_GOAL' as a sentinel the real impl
//     resolves via the validator's substrate client (B5-PR9+ replaces
//     this with a real repo string).

import type { AgentResult } from '../agentRegistry.js';
import type { ContentRequest, ContentResult } from '../runtime/contentAgent.js';
import type { IssueTool } from '../tools/issueTool.js';
import type { ParsedTransitionMessage } from '../types.js';

// Injectable content brain. Real path binds runtime/contentAgent.generateContent
// (curried with a model); the stub path leaves it undefined so the templated
// placeholder body is used (preserves the existing test suite + in-memory boot).
export type GenerateContentFn = (req: ContentRequest) => Promise<ContentResult>;

export interface SpecAgentDeps {
  issues: IssueTool;
  // ULID for the agent run, per ADR 0008. The mainConsumer mints this at
  // dispatch time and threads it through so the same ULID lands in the
  // branch name (BuildAgent), the structural comment (here), and the
  // audit ledger row.
  runId: string;
  // Repo where the new Spec issue lands. v0 = same repo as the Goal
  // (ADR 0003: planning records co-locate with the app repo). Caller
  // resolves this from the validator's substrate before dispatch.
  repo: string;
  // Real content brain. When present, the Spec body is model-authored from
  // the Goal; when absent, the templated TODO placeholder is used.
  generateContent?: GenerateContentFn;
}

const ROLE = 'SpecAgent' as const;
const READY_FOR_REVIEW_LABEL = 'status:ready_for_review';

const SPEC_AUTHOR_SYSTEM =
  'You are SpecAgent, a software-factory spec author. Given a Goal, produce a ' +
  'concise, implementable Spec in markdown with an explicit "## Acceptance ' +
  'criteria" section (checkbox list of testable, unambiguous criteria). Keep ' +
  'scope minimal and focused on the Goal. Do not include preamble or sign-off. ' +
  'CAPABILITY VS ACTIVATION: when the Goal says a system "supports", "adds", ' +
  '"integrates", or "enables" some capability X, the acceptance criteria MUST ' +
  'separate (a) capability — the code can do X (plumbing, schema, tests) — from ' +
  '(b) activation — X is turned on and observable to a user by default (e.g. ' +
  'enabled in config, surfaced in the UI/API response a user sees). State which ' +
  'the Goal requires. Default to BOTH (capability shipped AND activated/visible) ' +
  'unless the Goal explicitly scopes to support-only; a capability that exists ' +
  'but stays dark by default is rarely what "supports X" means. If the intended ' +
  'scope is genuinely ambiguous, add a "## Open question" line naming the ' +
  'capability-vs-activation choice so the human ratification gate resolves it.';

export async function runSpecAgent(
  message: ParsedTransitionMessage,
  deps: SpecAgentDeps,
): Promise<AgentResult> {
  // Defensive routing guard — orchestrator should only dispatch us on
  // goal:proposed→accepted, but if mis-routed, return typed failure so
  // the deadletter reason is specific.
  if (message.kind !== 'goal' || message.toState !== 'accepted') {
    return {
      ok: false,
      reason: `spec_agent_wrong_transition:${message.kind}:${message.fromState}→${message.toState}`,
    };
  }

  const goal = await deps.issues.read(message.recordId);
  if (!goal.ok) {
    return { ok: false, reason: `spec_agent_goal_read_failed:${goal.reason}` };
  }

  const goalSummary = extractFirstLine(goal.value.body);

  // Real path: model-author the Spec body from the Goal. Stub path (no
  // brain): the templated placeholder so the loop stays exercisable.
  let specBody: string;
  if (deps.generateContent !== undefined) {
    const generated = await deps.generateContent({
      system: SPEC_AUTHOR_SYSTEM,
      prompt: `Goal:\n\n${goal.value.body}\n\nProduce a Spec with acceptance criteria.`,
    });
    if (!generated.ok) {
      return { ok: false, reason: `spec_agent_content_failed:${generated.stopReason ?? 'empty'}` };
    }
    // Prepend the parent-goal linkage field so the validator can join the
    // Spec to its Goal (same field SpecAgent has always emitted).
    specBody = `parent-goal: ${message.recordId}\n\n${generated.text}`;
  } else {
    specBody = renderSpecBody({ parentGoalRecordId: message.recordId, goalSummary });
  }

  const created = await deps.issues.create({
    repo: deps.repo,
    title: `Spec: ${goalSummary}`,
    body: specBody,
    // Only the kind:* label at creation — status:* is derived by the
    // validator's transitionResolver from issues.opened (Spec → drafting),
    // per the issueTool.ts invariant. Applying status:drafting here would
    // double-write the state the validator already assigns.
    labels: ['kind:spec'],
    structural: { role: ROLE, run: deps.runId },
  });
  if (!created.ok) {
    return { ok: false, reason: `spec_agent_spec_create_failed:${created.reason}` };
  }

  const linkComment = await deps.issues.comment({
    recordId: message.recordId,
    body: `SpecAgent created Spec record \`${created.value.recordId}\` (issue #${created.value.number}) decomposing this Goal.`,
    structural: { role: ROLE, run: deps.runId },
  });
  if (!linkComment.ok) {
    return { ok: false, reason: `spec_agent_goal_comment_failed:${linkComment.reason}` };
  }

  // Auto-advance drafting→ready_for_review on the just-created Spec so the
  // FSM flows hands-off (specFsm: drafting→ready_for_review allowedActor
  // SpecAgent → dispatches ReviewAgent). Idempotent: applyLabel of an
  // already-present label is a no-op on GitHub's labels API, and the
  // validator's labeled-resolver defers a re-applied label that produced
  // no state change.
  const advance = await advanceToReadyForReview({
    issues: deps.issues,
    recordId: created.value.recordId,
    runId: deps.runId,
  });
  if (!advance.ok) {
    return { ok: false, reason: `spec_agent_ready_for_review_failed:${advance.reason}` };
  }

  return {
    ok: true,
    result: `SpecAgent: created Spec ${created.value.recordId} (advanced to ready_for_review) linked to Goal ${message.recordId}`,
  };
}

// Drive drafting→ready_for_review: apply the status label, then post a
// structural comment carrying the sf:agent=SpecAgent marker so the
// validator attributes the labeled transition to SpecAgent (ADR 0009 §D).
// Both writes use the agent's run ULID for ledger join.
async function advanceToReadyForReview(args: {
  issues: IssueTool;
  recordId: string;
  runId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const labelResult = await args.issues.applyLabel({
    recordId: args.recordId,
    label: READY_FOR_REVIEW_LABEL,
  });
  if (!labelResult.ok) {
    return { ok: false, reason: `apply_label:${labelResult.reason}` };
  }
  const markerComment = await args.issues.comment({
    recordId: args.recordId,
    body: `${ROLE} advanced this Spec to \`ready_for_review\`.`,
    structural: { role: ROLE, run: args.runId },
  });
  if (!markerComment.ok) {
    return { ok: false, reason: `marker_comment:${markerComment.reason}` };
  }
  return { ok: true };
}

function extractFirstLine(body: string): string {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 0 ? firstLine : '(empty goal body)';
}

function renderSpecBody(args: { parentGoalRecordId: string; goalSummary: string }): string {
  // Issue-template-compatible body per ADR 0003 + ADR 0007. The
  // parent-goal field mirrors spec.yml issue template's machine-readable
  // input field so the validator can extract it via GraphQL body parsing.
  return [
    `parent-goal: ${args.parentGoalRecordId}`,
    '',
    '## Summary',
    `Decomposed from parent Goal: ${args.goalSummary}`,
    '',
    '## Content',
    'TODO: SpecAgent v0+ will author real spec content via model invocation. v0 ships this',
    'placeholder so the orchestrator → SpecAgent → Spec-record → ReviewAgent loop is',
    'exercisable end-to-end against the substrate.',
  ].join('\n');
}
