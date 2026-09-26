// Spec: docs/decisions/0003-cross-repo-delivery.md "Linking model" + ADR 0001
// ("substrate of record"). The per-kind FSMs verify single-record state
// transitions in isolation; the substrate's structural references
// (parent-goal, spec-ref, design-ref carried in the Issue body per
// ADR 0007's v0 carrier decision) must ALSO be enforced or ADR 0001's
// "substrate of record" claim is hollow.
//
// Invariants:
//   - Soft-flag only: failures here downgrade the dispatcher's verdict
//     accept→flag (and leave existing flag/reject untouched). The
//     upstream substrate write already happened by the time the
//     validator sees the event (webhook fires post-write), so a hard
//     reject can't undo it; the right posture is to record the audit
//     gap via the ledger row's verdict.
//   - Two carrier formats are parsed (ADR 0007), because both reach the
//     substrate body:
//       (a) agent-written: `<field-name>: <recordId>` on its own line
//           (services/agents/src/agents/{spec,design,build}Agent.ts).
//       (b) issue-form-rendered: GitHub renders a `type: input` field as a
//           markdown heading of its label followed by the value
//           (`### parent-goal\n\n<recordId>`); the form labels are exactly
//           the hyphenated field names (.github/ISSUE_TEMPLATE/{spec,design,
//           task}.yml). Without (b), Issues created from the FORMS — the human
//           intake path — would not be parsed, making ADR 0007's "forms →
//           body → validator reads" claim false.
//     Format (a) is tried first (agents always header-block it); (b) is the
//     fallback. First match wins. GitHub's empty-field sentinel `_No response_`
//     is treated as absent.
//   - getIssue returns undefined for unseen records — the assertion
//     fails with `parent_goal_missing` / `spec_ref_invalid` /
//     `design_ref_invalid` accordingly. We do NOT distinguish "ref
//     points at a missing record" from "ref points at a record of
//     the wrong kind" in the assertion name because the audit signal
//     is the same: the structural reference is broken.
//   - Scoped to issue messages with kinds {spec, design, task}. PR /
//     deployment / decision / goal messages skip cross-record checks
//     (goal is the root of the reference graph; PR closes a Task via
//     `Closes #N` not via a body field; deployment has no body refs;
//     decision references are not in v0 scope).

import type { Kind } from './kinds.js';
import type { ParsedTransitionMessage } from './queueConsumer.js';
import type { SubstrateClient } from './substrateClient.js';

// The three v0 assertion failure names. Each maps 1:1 to a body field
// per ADR 0003's linking model. `spec_ref_invalid` / `design_ref_invalid`
// cover BOTH the missing-record and wrong-kind cases because the audit
// signal is identical (broken structural ref); `detail` carries the
// distinction for human triage.
export type CrossRecordAssertionName =
  | 'parent_goal_missing'
  | 'spec_ref_invalid'
  | 'design_ref_invalid';

export type CrossRecordAssertionResult =
  | { ok: true }
  | { ok: false; assertion: CrossRecordAssertionName; detail: string };

const PARENT_GOAL_PREFIX = 'parent-goal:';
const SPEC_REF_PREFIX = 'spec-ref:';
const DESIGN_REF_PREFIX = 'design-ref:';

const KIND_GOAL_LABEL = 'kind:goal';
const KIND_SPEC_LABEL = 'kind:spec';
const KIND_DESIGN_LABEL = 'kind:design';

// Kinds whose Issue body carries cross-record refs per ADR 0003 v0 carrier.
// Goal is the root; PR/deployment/decision have no v0 body refs to check.
const KINDS_WITH_BODY_REFS: ReadonlySet<Kind> = new Set(['spec', 'design', 'task']);

// Per-kind body refs that are REQUIRED-when-present. Spec only has
// parent-goal (per .github/ISSUE_TEMPLATE/spec.yml). Design has
// parent-goal + spec-ref. Task has parent-goal + design-ref. The
// runner only checks fields that appear in the body — absence of an
// optional field is silent (handled by the issue-form's required-field
// gate at substrate write time, not here).
interface FieldsForKind {
  parentGoal: boolean;
  specRef: boolean;
  designRef: boolean;
}
const FIELDS_BY_KIND: Record<'spec' | 'design' | 'task', FieldsForKind> = {
  spec: { parentGoal: true, specRef: false, designRef: false },
  design: { parentGoal: true, specRef: true, designRef: false },
  task: { parentGoal: true, specRef: false, designRef: true },
};

const FORM_EMPTY_SENTINEL = '_No response_';

function extractFieldValue(body: string, prefix: string): string | undefined {
  const lines = body.split('\n');

  // (a) agent-written carrier: `<field-name>: <value>` on its own line.
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    if (value.length === 0) continue;
    return value;
  }

  // (b) issue-form-rendered carrier: a markdown heading whose text is the
  // field name (the form `label`), then the value on the next non-empty line.
  const fieldName = prefix.replace(/:$/, '');
  const headingRe = new RegExp(
    `^#{1,6}\\s*${fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'i',
  );
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i]?.trim() ?? '')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const value = lines[j]?.trim() ?? '';
      if (value.length === 0) continue;
      if (value.startsWith('#')) break; // next heading — field had no value
      if (value === FORM_EMPTY_SENTINEL) break; // GitHub's empty-field sentinel
      return value;
    }
  }
  return undefined;
}

async function checkRef(
  substrate: SubstrateClient,
  ref: string,
  requiredKindLabel: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const issue = await substrate.getIssue(ref);
  if (issue === undefined) {
    return { ok: false, detail: `referenced record "${ref}" does not exist` };
  }
  if (!issue.labels.includes(requiredKindLabel)) {
    return {
      ok: false,
      detail: `referenced record "${ref}" is missing required label "${requiredKindLabel}"`,
    };
  }
  return { ok: true };
}

export async function runCrossRecordAssertions(
  message: ParsedTransitionMessage,
  substrate: SubstrateClient,
): Promise<CrossRecordAssertionResult> {
  if (!KINDS_WITH_BODY_REFS.has(message.kind)) return { ok: true };
  // Narrowed by KINDS_WITH_BODY_REFS membership; the cast is safe.
  const kind = message.kind as 'spec' | 'design' | 'task';

  const issue = await substrate.getIssue(message.recordId);
  // No body available — nothing to assert against. The per-kind FSM
  // already evaluated the transition; the absence of a body view is an
  // upstream resolver gap, not a cross-record violation. Stay silent.
  if (issue === undefined) return { ok: true };

  const fields = FIELDS_BY_KIND[kind];

  if (fields.parentGoal) {
    const parentGoalRef = extractFieldValue(issue.body, PARENT_GOAL_PREFIX);
    if (parentGoalRef !== undefined) {
      const result = await checkRef(substrate, parentGoalRef, KIND_GOAL_LABEL);
      if (!result.ok) {
        return { ok: false, assertion: 'parent_goal_missing', detail: result.detail };
      }
    }
  }

  if (fields.specRef) {
    const specRef = extractFieldValue(issue.body, SPEC_REF_PREFIX);
    if (specRef !== undefined) {
      const result = await checkRef(substrate, specRef, KIND_SPEC_LABEL);
      if (!result.ok) {
        return { ok: false, assertion: 'spec_ref_invalid', detail: result.detail };
      }
    }
  }

  if (fields.designRef) {
    const designRef = extractFieldValue(issue.body, DESIGN_REF_PREFIX);
    if (designRef !== undefined) {
      const result = await checkRef(substrate, designRef, KIND_DESIGN_LABEL);
      if (!result.ok) {
        return { ok: false, assertion: 'design_ref_invalid', detail: result.detail };
      }
    }
  }

  return { ok: true };
}
