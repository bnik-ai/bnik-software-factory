// Spec: docs/architecture.md (L3 agent — DesignAgent realizes ratified
// Specs into Designs) + ADR 0003 (parent-goal + spec-ref linkage fields).
// Invariants:
//   - Triggered by routing key `spec:ready_for_review→ratified`. Defensive
//     guard returns typed wrong_transition failure if mis-routed.
//   - v0 minimum: creates ONE Design issue per ratified Spec, body
//     placeholder. Multi-design decomposition + real content authoring
//     via model invocation ship in B5-PR9+.
//   - Design issue gets kind:design label at creation. status:* labels
//     are NOT applied — the validator's transitionResolver maps
//     issues.opened to per-kind default (Design → drafting) per
//     ISSUE_KIND_INITIAL_STATE.
//   - Design body carries BOTH parent-goal (forwarded from the Spec) and
//     spec-ref (the Spec being realized) fields per design.yml issue
//     template. parent-goal is extracted from the Spec body using the
//     same `^parent-goal: <recordId>` line SpecAgent writes — symmetric
//     producer/consumer pattern.
//   - After creating the Design, posts a structural comment on the Spec
//     with the sf:structural marker per ADR 0009 §D, naming the new
//     Design record.
//   - AUTO-ADVANCE (hands-off FSM): after creating the Design (recorded as
//     `drafting` via the per-kind default), DesignAgent ALSO drives
//     design:drafting→ready_for_review (designFsm allowedActor DesignAgent
//     → dispatches ReviewAgent). Same mechanism as SpecAgent: apply
//     `status:ready_for_review` + post the sf:agent=DesignAgent structural
//     marker so the validator attributes the labeled transition. No
//     `status:drafting` label exists to remove (the Design carries only
//     kind:design); the validator reads the prior drafting state from the
//     ledger.

import type { AgentResult } from '../agentRegistry.js';
import type { ContentRequest, ContentResult } from '../runtime/contentAgent.js';
import type { IssueTool } from '../tools/issueTool.js';
import type { ParsedTransitionMessage } from '../types.js';

export type GenerateContentFn = (req: ContentRequest) => Promise<ContentResult>;

export interface DesignAgentDeps {
  issues: IssueTool;
  runId: string;
  repo: string;
  // Real content brain. When present, the Design body (infra-delta +
  // service-delta) is model-authored from the Spec; when absent, the
  // templated TODO placeholder is used.
  generateContent?: GenerateContentFn;
}

const ROLE = 'DesignAgent' as const;
const READY_FOR_REVIEW_LABEL = 'status:ready_for_review';
const PARENT_GOAL_PREFIX = 'parent-goal: ';
const UNKNOWN_PARENT_GOAL = '(unknown — Spec body missing parent-goal field)';

const DESIGN_AUTHOR_SYSTEM =
  'You are DesignAgent, a software-factory design author. Given a ratified ' +
  'Spec, produce a concise Design in markdown with an "## Infra delta" section ' +
  '(infrastructure changes) and a "## Service delta" section (service/code ' +
  'changes), plus a "## Risks and mitigations" section. Keep it minimal and ' +
  'focused on realizing the Spec. Do not include preamble or sign-off. ' +
  'If the Spec requires ACTIVATION (a capability turned on and observable to a ' +
  'user by default, not just code that can do it), the Service delta MUST ' +
  'include the activation step explicitly — the config flag flipped on, the ' +
  'default that surfaces it, the env/secret the operator must supply — and the ' +
  'acceptance must be checkable from what a user observes, not only that the ' +
  'code path exists. Do not leave a shipped capability dark by default when the ' +
  'Spec asked for it to be live.';

export async function runDesignAgent(
  message: ParsedTransitionMessage,
  deps: DesignAgentDeps,
): Promise<AgentResult> {
  if (message.kind !== 'spec' || message.toState !== 'ratified') {
    return {
      ok: false,
      reason: `design_agent_wrong_transition:${message.kind}:${message.fromState}→${message.toState}`,
    };
  }

  const spec = await deps.issues.read(message.recordId);
  if (!spec.ok) {
    return { ok: false, reason: `design_agent_spec_read_failed:${spec.reason}` };
  }

  const parentGoal = extractParentGoal(spec.value.body);
  const specSummary = extractFirstLine(spec.value.body);

  // Real path: model-author the Design from the Spec. Stub path (no brain):
  // the templated placeholder so the loop stays exercisable.
  let designBody: string;
  if (deps.generateContent !== undefined) {
    const generated = await deps.generateContent({
      system: DESIGN_AUTHOR_SYSTEM,
      prompt: `Spec:\n\n${spec.value.body}\n\nProduce a Design (infra-delta + service-delta).`,
    });
    if (!generated.ok) {
      return {
        ok: false,
        reason: `design_agent_content_failed:${generated.stopReason ?? 'empty'}`,
      };
    }
    // Prepend the linkage fields so the validator can join Design → Spec → Goal.
    designBody = `parent-goal: ${parentGoal}\nspec-ref: ${message.recordId}\n\n${generated.text}`;
  } else {
    designBody = renderDesignBody({ parentGoal, specRecordId: message.recordId, specSummary });
  }

  const created = await deps.issues.create({
    repo: deps.repo,
    title: `Design: ${specSummary}`,
    body: designBody,
    labels: ['kind:design'],
    structural: { role: ROLE, run: deps.runId },
  });
  if (!created.ok) {
    return { ok: false, reason: `design_agent_design_create_failed:${created.reason}` };
  }

  const linkComment = await deps.issues.comment({
    recordId: message.recordId,
    body: `DesignAgent created Design record \`${created.value.recordId}\` (issue #${created.value.number}) realizing this Spec.`,
    structural: { role: ROLE, run: deps.runId },
  });
  if (!linkComment.ok) {
    return { ok: false, reason: `design_agent_spec_comment_failed:${linkComment.reason}` };
  }

  // Auto-advance drafting→ready_for_review so the FSM flows hands-off
  // (designFsm: drafting→ready_for_review allowedActor DesignAgent →
  // dispatches ReviewAgent). Idempotent: re-applying the label is a no-op.
  const advance = await advanceToReadyForReview({
    issues: deps.issues,
    recordId: created.value.recordId,
    runId: deps.runId,
  });
  if (!advance.ok) {
    return { ok: false, reason: `design_agent_ready_for_review_failed:${advance.reason}` };
  }

  return {
    ok: true,
    result: `DesignAgent: created Design ${created.value.recordId} (advanced to ready_for_review) realizing Spec ${message.recordId}`,
  };
}

// Drive drafting→ready_for_review: apply the status label, then post a
// structural comment carrying the sf:agent=DesignAgent marker so the
// validator attributes the labeled transition to DesignAgent (ADR 0009 §D).
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
    body: `${ROLE} advanced this Design to \`ready_for_review\`.`,
    structural: { role: ROLE, run: args.runId },
  });
  if (!markerComment.ok) {
    return { ok: false, reason: `marker_comment:${markerComment.reason}` };
  }
  return { ok: true };
}

function extractParentGoal(body: string): string {
  for (const line of body.split('\n')) {
    if (line.startsWith(PARENT_GOAL_PREFIX)) {
      return line.slice(PARENT_GOAL_PREFIX.length).trim();
    }
  }
  return UNKNOWN_PARENT_GOAL;
}

function extractFirstLine(body: string): string {
  // Skip the parent-goal: line if present so the summary is the spec's
  // human-readable title, not the linkage metadata.
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith(PARENT_GOAL_PREFIX)) continue;
    if (trimmed.startsWith('##')) continue;
    return trimmed;
  }
  return '(empty spec body)';
}

function renderDesignBody(args: {
  parentGoal: string;
  specRecordId: string;
  specSummary: string;
}): string {
  return [
    `parent-goal: ${args.parentGoal}`,
    `spec-ref: ${args.specRecordId}`,
    '',
    '## Summary',
    `Realizing Spec: ${args.specSummary}`,
    '',
    '## Infra delta',
    'TODO: DesignAgent v0+ will populate from model-driven analysis.',
    '',
    '## Service delta',
    'TODO: DesignAgent v0+ will populate from model-driven analysis.',
    '',
    '## Risks and mitigations',
    'TODO: DesignAgent v0+ will populate from model-driven analysis.',
  ].join('\n');
}
