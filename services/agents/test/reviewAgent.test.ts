// Spec: docs/design/review-agent.md (PR code-review loop) +
// docs/decisions/0010-multi-model-review-loop.md. Structural review: drive the
// PR review FSM via status labels + a findings comment instead of the
// 422-blocked native review-approval API.
// Coverage (two-phase split — one status-label transition per
// run; no apply+remove race; verdict run never self-dispatches):
//   - CLAIM phase (`→open`: pr:__initial__→open, pr:draft→open): applies
//     status:in_review ONLY (+ claim comment). No approval, no remove.
//   - VERDICT phase (`→in_review`: pr:open→in_review, pr:draft→in_review):
//     posts the structural findings comment, then on approve swaps
//     status:in_review→status:approved; NEVER applies status:in_review.
//   - Paired-Task route task:in_progress→in_review (VERDICT phase): reads the
//     Task body for `pr-ref: <PR_recordId>` and runs the verdict on that PR.
//   - Missing pr-ref → typed review_agent_no_pr_ref (no label/comment writes).
//   - Spec/Design ratification + defensive-guard routes → typed failures with
//     NO tool calls.
//   - Real-brain path (verdict phase): APPROVE → status:approved (in_review
//     removed); REQUEST_CHANGES → drives the PR in_review→changes_requested
//     (apply status:changes_requested + remove status:in_review on the
//     PR) so the orchestrator dispatches BuildAgent's revision; unparseable verdict
//     fails closed to request-changes.
//   - Hard invariant: ReviewAgent NEVER calls submitReview with state
//     approve/request-changes (the GitHub 422 path under single App identity).

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { runReviewAgent } from '../src/agents/reviewAgent.js';
import { StubIssueTool } from '../src/tools/issueTool.js';
import { StubPullTool } from '../src/tools/pullTool.js';
import type { ParsedTransitionMessage } from '../src/types.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:pull_request.ready_for_review',
    kind: 'pr',
    actor: 'BuildAgent',
    recordType: 'PullRequest',
    recordKind: 'PR',
    recordId: 'PR_kwAOA_77',
    fromState: 'open',
    toState: 'in_review',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

// prLabels defaults to ['status:in_review'] — the PR's state DURING a verdict run
// (the claim phase applied it), which the verdict idempotency guard
// requires. CLAIM-phase tests pass [] so the claim proceeds (the claim guard
// skips when status:in_review is already present).
function makeDeps(prLabels: string[] = ['status:in_review']) {
  const issues = new StubIssueTool();
  const pulls = new StubPullTool();
  // Pre-seed the PR record so the agent's pullTool.read() resolves.
  pulls.seedRecord({
    recordId: 'PR_kwAOA_77',
    number: 77,
    state: 'open',
    headBranch: 'sf/T-99/01HV6/build@opus-4-7',
    baseBranch: 'main',
  });
  issues.seedRecord({ recordId: 'PR_kwAOA_77', labels: prLabels, body: '' });
  return {
    issues,
    pulls,
    runId: '01HZXYZ123456789ABCDEFGHJK',
    repo: 'example-org/software-factory',
    model: 'opus-4-7',
  };
}

// The structural marker the validator's resolveActorFromComment requires:
// `sf:agent=review@<model> run=<ulid>` (role@model grammar, NOT bare role).
const REVIEW_MARKER_ROLE = 'review@opus-4-7';
const RUN_ID = '01HZXYZ123456789ABCDEFGHJK';

describe('runReviewAgent — CLAIM phase (`→open` triggers): apply status:in_review ONLY', () => {
  // The claim run does exactly ONE label transition (status:in_review). It does
  // NOT post findings or apply status:approved — the emitted pr:open→in_review
  // re-dispatches ReviewAgent for the verdict run.
  test('pr:__initial__→open claims review: status:in_review only, claim comment, NO approval, NO remove', async () => {
    const deps = makeDeps([]); // label-less PR so the claim proceeds (pre-claim state)
    const result = await runReviewAgent(
      makeMessage({ fromState: '__initial__', toState: 'open' }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Hard invariant: NEVER the 422 native-review path.
    expect(deps.pulls.reviewHistory()).toHaveLength(0);

    // Exactly one label applied: status:in_review. No status:approved, no remove.
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:in_review']);
    expect(deps.issues.labelRemoveHistory()).toHaveLength(0);

    // A structural claim comment with the review@model marker on the PR (so the
    // multi-agent pr:open→in_review edge attributes the transition to ReviewAgent).
    const comments = deps.issues.commentHistory();
    expect(comments).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const comment = comments[0]!;
    expect(comment.recordId).toBe('PR_kwAOA_77');
    expect(comment.structural).toEqual({ role: REVIEW_MARKER_ROLE, run: RUN_ID });
    expect(comment.body).toContain('claimed');

    expect(result.result).toMatch(
      /^ReviewAgent: claimed review \(status:in_review\) on PR PR_kwAOA_77 \(#77\)$/,
    );
  });

  test('pr:draft→open also claims: status:in_review only', async () => {
    const deps = makeDeps([]); // label-less PR so the claim proceeds (pre-claim state)
    const result = await runReviewAgent(makeMessage({ fromState: 'draft', toState: 'open' }), deps);

    expect(result.ok).toBe(true);
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:in_review']);
    expect(deps.issues.labelRemoveHistory()).toHaveLength(0);
  });

  test('claim: typed failure when PR record cannot be read — no label/comment writes', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(
      makeMessage({ fromState: '__initial__', toState: 'open', recordId: 'PR_unknown_999' }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^review_agent_pr_read_failed:/);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — VERDICT phase (`→in_review` triggers): post findings + apply approved', () => {
  // The verdict run posts the structural findings comment, then swaps
  // status:in_review→status:approved. It NEVER applies status:in_review (that
  // would self-trigger ReviewAgent). The pr:in_review→approved it emits goes to
  // OpsAgent, not back to ReviewAgent.
  test('pr:open→in_review (stub) posts findings + swaps status:in_review→status:approved, NEVER re-applies in_review', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(deps.pulls.reviewHistory()).toHaveLength(0);

    // A structural findings comment with the review@model marker on the PR.
    const comments = deps.issues.commentHistory();
    expect(comments).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const comment = comments[0]!;
    expect(comment.recordId).toBe('PR_kwAOA_77');
    expect(comment.structural).toEqual({
      role: REVIEW_MARKER_ROLE,
      run: RUN_ID,
      verdict: 'approve',
    });
    expect(comment.body).toContain('v0 placeholder review');

    // Hard invariant: the verdict run NEVER applies status:in_review. It only
    // applies status:approved (removing the prior status:in_review the claim set).
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:approved']);
    expect(deps.issues.labelRemoveHistory().map((e) => e.label)).toEqual(['status:in_review']);
    for (const entry of deps.issues.labelApplyHistory()) {
      expect(entry.recordId).toBe('PR_kwAOA_77');
    }
  });

  test('pr:draft→in_review (native review_requested, no prior claim run) → status:approved only', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(
      makeMessage({ fromState: 'draft', toState: 'in_review' }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.pulls.reviewHistory()).toHaveLength(0);
    // Still never applies status:in_review; removeLabel is 404-tolerant when no
    // claim run preceded (the native draft→in_review path).
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:approved']);
  });

  test('verdict REDELIVERY after the PR already moved off in_review → no-op, no duplicate marker', async () => {
    // The PR is no longer status:in_review (a prior verdict already swapped it):
    // re-running must NOT post a second verdict marker (a request-changes dupe
    // would inflate BuildAgent's revision-round count).
    const deps = makeDeps(['status:changes_requested']);
    const result = await runReviewAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('no longer status:in_review');
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('pr:changes_requested→in_review (re-review after revision) runs the verdict — NOT a wrong_transition', async () => {
    // BuildAgent drove the revised PR back to in_review. The orchestrator routes
    // pr:changes_requested→in_review to ReviewAgent; it MUST be a verdict key or
    // every revised PR dead-letters review_agent_wrong_transition.
    const deps = makeDeps();
    const result = await runReviewAgent(
      makeMessage({ fromState: 'changes_requested', toState: 'in_review' }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A real verdict run: findings comment + status:approved swap (stub brain).
    expect(deps.issues.commentHistory()).toHaveLength(1);
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:approved']);
    expect(result.result).not.toMatch(/wrong_transition/);
  });

  test('pr:syncing→in_review (re-review after a gated rebase) runs the verdict — NOT a wrong_transition', async () => {
    // BuildAgent's syncing bounce drove the rebased PR back to in_review. The
    // orchestrator routes pr:syncing→in_review to ReviewAgent; it MUST be a verdict
    // key or every gated-rebase re-review dead-letters review_agent_wrong_transition.
    const deps = makeDeps();
    const result = await runReviewAgent(
      makeMessage({ fromState: 'syncing', toState: 'in_review' }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.issues.commentHistory()).toHaveLength(1);
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:approved']);
    expect(result.result).not.toMatch(/wrong_transition/);
  });

  test('result envelope names PR recordId and number', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(
      /^ReviewAgent: emitted v0 placeholder approved structural review on PR PR_kwAOA_77 \(#77\)$/,
    );
  });

  test('verdict: typed failure when PR record cannot be read — no label/comment writes', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(makeMessage({ recordId: 'PR_unknown_999' }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^review_agent_pr_read_failed:/);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — paired-Task route task:in_progress→in_review (in scope for v0)', () => {
  test('reads Task body for pr-ref then drives structural review on referenced PR', async () => {
    const deps = makeDeps([]); // label-less PR so the paired-Task claim proceeds
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:in_review'],
      body: 'parent-goal: I_goal\ndesign-ref: I_design\npr-ref: PR_kwAOA_77\n\nImplement webhook endpoint',
    });

    const result = await runReviewAgent(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        recordType: 'Issue',
        recordId: 'I_kwAOA_task_99',
        fromState: 'in_progress',
        toState: 'in_review',
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The paired-Task route is a CLAIM-only run — it resolves the PR
    // via the Task's pr-ref and applies status:in_review ONLY (claim comment +
    // status:in_review on the REFERENCED PR, never status:approved here).
    expect(deps.issues.commentHistory().map((c) => c.recordId)).toEqual(['PR_kwAOA_77']);
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:in_review']);
    expect(deps.issues.labelApplyHistory().map((e) => e.recordId)).toEqual(['PR_kwAOA_77']);
    expect(result.result).toContain('PR PR_kwAOA_77 (#77)');
  });

  test('missing pr-ref on paired-Task → typed review_agent_no_pr_ref failure, no writes', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_no_pr',
      labels: ['kind:task', 'status:in_review'],
      body: 'parent-goal: I_goal\n\nMissing pr-ref field — invariant violation upstream',
    });

    const result = await runReviewAgent(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        recordType: 'Issue',
        recordId: 'I_kwAOA_task_no_pr',
        fromState: 'in_progress',
        toState: 'in_review',
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('review_agent_no_pr_ref:I_kwAOA_task_no_pr');
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('Task read failure → typed review_agent_task_read_failed', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        recordType: 'Issue',
        recordId: 'I_kwAOA_task_missing',
        fromState: 'in_progress',
        toState: 'in_review',
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^review_agent_task_read_failed:/);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — Spec/Design ratification routes (OUT of v0 scope)', () => {
  test('spec:drafting→ready_for_review → typed not-in-v0-scope failure, NO tool calls', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(
      makeMessage({
        kind: 'spec',
        recordKind: 'Spec',
        recordType: 'Issue',
        recordId: 'I_kwAOA_spec',
        fromState: 'drafting',
        toState: 'ready_for_review',
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      'review_agent_spec_design_review_not_in_v0_scope:spec:drafting→ready_for_review',
    );
    expect(deps.pulls.reviewHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('design:drafting→ready_for_review → typed not-in-v0-scope failure, NO tool calls', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(
      makeMessage({
        kind: 'design',
        recordKind: 'Design',
        recordType: 'Issue',
        recordId: 'I_kwAOA_design',
        fromState: 'drafting',
        toState: 'ready_for_review',
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      'review_agent_spec_design_review_not_in_v0_scope:design:drafting→ready_for_review',
    );
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — defensive guards', () => {
  test('unrelated transition → typed review_agent_wrong_transition, NO tool calls', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(
      makeMessage({
        kind: 'goal',
        recordKind: 'Goal',
        recordType: 'Issue',
        recordId: 'I_kwAOA_goal',
        fromState: 'proposed',
        toState: 'accepted',
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('review_agent_wrong_transition:goal:proposed→accepted');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('pr:in_review→approved (OpsAgent territory) → typed wrong_transition, NO tool calls', async () => {
    const deps = makeDeps();
    const result = await runReviewAgent(
      makeMessage({ fromState: 'in_review', toState: 'approved' }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('review_agent_wrong_transition:pr:in_review→approved');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — real content-review brain (env-gated)', () => {
  test('APPROVE verdict → status:approved applied; findings comment carries the model verdict; NEVER submitReview', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff(
      'PR_kwAOA_77',
      'diff --git a/sample_app/api/app.py b/sample_app/api/app.py\n+    @app.get("/v1/readyz")',
    );
    const calls: Array<{ system?: string; prompt: string }> = [];
    const generateContent = async (req: { system?: string; prompt: string }) => {
      calls.push(req);
      return { ok: true as const, text: 'APPROVE\n\nLooks correct and tested.' };
    };

    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0]?.prompt).toContain('#77');
    // Hard invariant: no native review submission.
    expect(deps.pulls.reviewHistory()).toHaveLength(0);
    // Findings comment carries the model's verdict text + the review@model marker.
    // biome-ignore lint/style/noNonNullAssertion: comment posted (result ok).
    const comment = deps.issues.commentHistory()[0]!;
    expect(comment.body).toContain('Looks correct and tested.');
    expect(comment.structural).toEqual({
      role: REVIEW_MARKER_ROLE,
      run: RUN_ID,
      verdict: 'approve',
    });
    // approve (verdict run) → status:approved applied; status:in_review removed.
    // status:in_review is NEVER applied in the verdict run (the claim run set it).
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:approved']);
    expect(deps.issues.labelRemoveHistory().map((e) => e.label)).toEqual(['status:in_review']);
    expect(result.result).toMatch(/^ReviewAgent: structural approve on PR PR_kwAOA_77 \(#77\)$/);
  });

  test('REQUEST_CHANGES verdict → findings posted, PR swapped status:in_review→status:changes_requested, NO submitReview', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff(
      'PR_kwAOA_77',
      'diff --git a/sample_app/api/app.py b/sample_app/api/app.py\n+    @app.get("/v1/readyz")',
    );
    const generateContent = async () => ({
      ok: true as const,
      text: 'REQUEST_CHANGES\n\nMissing tests for the error path.',
    });

    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });

    // PR FSM: request-changes posts the findings on the PR, then
    // drives the PR in_review→changes_requested (apply status:changes_requested,
    // remove status:in_review) so the orchestrator dispatches BuildAgent's
    // revision. Never the 422 native-review path. No Task labels at all.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('status:changes_requested');
    expect(deps.pulls.reviewHistory()).toHaveLength(0);
    // Swap on the PR: apply status:changes_requested, then remove status:in_review.
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: 'PR_kwAOA_77', label: 'status:changes_requested' },
    ]);
    expect(deps.issues.labelRemoveHistory()).toEqual([
      { recordId: 'PR_kwAOA_77', label: 'status:in_review' },
    ]);
    // Exactly one structural comment: the findings on the PR (the marker for the
    // single-actor in_review→changes_requested edge), carrying verdict.
    const comments = deps.issues.commentHistory();
    expect(comments.map((c) => c.recordId)).toEqual(['PR_kwAOA_77']);
    expect(comments[0]?.structural).toMatchObject({ verdict: 'request-changes' });
  });

  test('unparseable verdict fails closed → request-changes (never auto-approve, no approval label)', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff(
      'PR_kwAOA_77',
      'diff --git a/sample_app/api/app.py b/sample_app/api/app.py\n+    @app.get("/v1/readyz")',
    );
    const generateContent = async () => ({ ok: true as const, text: 'hmm, not sure' });

    await runReviewAgent(makeMessage(), { ...deps, generateContent });

    // Fail-closed to request-changes: NEVER status:approved on an unparseable
    // verdict — instead the PR is driven to changes_requested.
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: 'PR_kwAOA_77', label: 'status:changes_requested' },
    ]);
  });

  test('content failure → typed review_agent_content_failed, no label/comment writes', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff(
      'PR_kwAOA_77',
      'diff --git a/sample_app/api/app.py b/sample_app/api/app.py\n+    @app.get("/v1/readyz")',
    );
    const generateContent = async () => ({
      ok: false as const,
      text: '',
      stopReason: 'max_tokens',
    });

    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('review_agent_content_failed:max_tokens');
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — claim guard on delayed paired-Task events', () => {
  test('task-route claim SKIPPED when the PR already carries status:approved — no writes', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:in_review'],
      body: 'pr-ref: PR_kwAOA_77',
    });
    deps.issues.seedRecord({
      recordId: 'PR_kwAOA_77',
      labels: ['status:approved'],
      body: 'task-ref: I_kwAOA_task_99',
    });
    const result = await runReviewAgent(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        recordType: 'Issue',
        recordId: 'I_kwAOA_task_99',
        fromState: 'in_progress',
        toState: 'in_review',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('claim skipped');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory().filter((c) => c.recordId === 'PR_kwAOA_77')).toHaveLength(
      0,
    );
  });

  test('task-route claim SKIPPED when the PR is at status:changes_requested — no in_review overwrite', async () => {
    // A late paired-Task event while the PR awaits BuildAgent's revision must NOT
    // apply status:in_review over status:changes_requested: the resolver would read
    // the resulting changes_requested→in_review as a BuildAgent revision and
    // dispatch a re-review with no revision pushed.
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:in_review'],
      body: 'pr-ref: PR_kwAOA_77',
    });
    deps.issues.seedRecord({
      recordId: 'PR_kwAOA_77',
      labels: ['status:changes_requested'],
      body: 'task-ref: I_kwAOA_task_99',
    });
    const result = await runReviewAgent(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        recordType: 'Issue',
        recordId: 'I_kwAOA_task_99',
        fromState: 'in_progress',
        toState: 'in_review',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('claim skipped');
    expect(result.result).toContain('status:changes_requested');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('claim SKIPPED when the PR is already merged — no writes', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:in_review'],
      body: 'pr-ref: PR_kwAOA_77',
    });
    deps.pulls.seedRecord({
      recordId: 'PR_kwAOA_77',
      number: 77,
      state: 'merged',
      headBranch: 'sf/T-99/01HV6/build@opus-4-7',
      baseBranch: 'main',
    });
    const result = await runReviewAgent(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        recordType: 'Issue',
        recordId: 'I_kwAOA_task_99',
        fromState: 'in_progress',
        toState: 'in_review',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('claim skipped');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('claim SKIPPED when status:in_review already present (idempotent, no duplicate claim comment)', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: 'PR_kwAOA_77',
      labels: ['status:in_review'],
      body: '',
    });
    const result = await runReviewAgent(
      makeMessage({ kind: 'pr', fromState: '__initial__', toState: 'open' }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('claim skipped');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — claim guard fails closed', () => {
  test('guard label-read failure → typed claim_guard failure, NO writes (never a blind claim)', async () => {
    // Fresh deps WITHOUT the PR issues-record seed: the guard's issues.read
    // fails while pulls.read succeeds — the exact blind-guard scenario.
    const issues = new StubIssueTool();
    const pulls = new StubPullTool();
    pulls.seedRecord({
      recordId: 'PR_kwAOA_77',
      number: 77,
      state: 'open',
      headBranch: 'sf/T-99/01HV6/build@opus-4-7',
      baseBranch: 'main',
    });
    const deps = {
      issues,
      pulls,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    };
    const result = await runReviewAgent(
      makeMessage({ kind: 'pr', fromState: '__initial__', toState: 'open' }),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^review_agent_claim_guard_read_failed:/);
    expect(issues.labelApplyHistory()).toHaveLength(0);
    expect(issues.commentHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — review surface carries the diff', () => {
  test('verdict prompt includes the unified diff', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff('PR_kwAOA_77', 'diff --git a/x b/x\n+added-line-marker');
    let seenPrompt = '';
    const generateContent = async (req: { system?: string; prompt: string }) => {
      seenPrompt = req.prompt;
      return { ok: true as const, text: 'APPROVE\n\nLooks good.' };
    };
    const result = await runReviewAgent(
      makeMessage({ kind: 'pr', fromState: 'open', toState: 'in_review' }),
      { ...deps, generateContent },
    );
    expect(result.ok).toBe(true);
    expect(seenPrompt).toContain('added-line-marker');
    // The diff rides between run-nonce markers (unpredictable to
    // the PR author), not a markdown fence escapable from inside a diff.
    expect(seenPrompt).toContain('-----BEGIN UNTRUSTED DIFF 01HZXYZ123456789ABCDEFGHJK-----');
    expect(seenPrompt).toContain('-----END UNTRUSTED DIFF 01HZXYZ123456789ABCDEFGHJK-----');
    expect(seenPrompt).toContain('UNTRUSTED DATA');
  });

  test('diff read failure → typed review_agent_diff_read_failed, fail closed, NO writes', async () => {
    const deps = makeDeps(); // no seedDiff → stub diff() fails
    const generateContent = async () => ({ ok: true as const, text: 'APPROVE' });
    const result = await runReviewAgent(
      makeMessage({ kind: 'pr', fromState: 'open', toState: 'in_review' }),
      { ...deps, generateContent },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^review_agent_diff_read_failed:/);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
  });

  test('placeholder (no-brain) path does NOT require a diff', async () => {
    const deps = makeDeps(); // no seedDiff, no generateContent
    const result = await runReviewAgent(
      makeMessage({ kind: 'pr', fromState: 'open', toState: 'in_review' }),
      deps,
    );
    expect(result.ok).toBe(true);
  });
});

describe('runReviewAgent — truncated diff fails closed', () => {
  test('truncated diff → typed review_agent_diff_truncated_v0, no verdict, no writes', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff('PR_kwAOA_77', 'diff --git a/x b/x\n+partial', true);
    const generateContent = async () => ({ ok: true as const, text: 'APPROVE' });
    const result = await runReviewAgent(
      makeMessage({ kind: 'pr', fromState: 'open', toState: 'in_review' }),
      { ...deps, generateContent },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('review_agent_diff_truncated_v0:PR_kwAOA_77');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — base-tree resolution refutes false missing-ref findings', () => {
  // A reference the diff cites but does not define may already live in the BASE
  // branch (from an earlier merged task). Pass 1 emits NEEDS-BASE lines; pass 2
  // gets the base file contents → a reference present in base is NOT a defect.
  test('reference present only in base → resolved, NOT flagged → PR approvable', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff(
      'PR_kwAOA_77',
      'diff --git a/tests/api/test_chat.py b/tests/api/test_chat.py\n+def test_x(auth, store): ...',
    );
    deps.pulls.seedBaseFile(
      'PR_kwAOA_77',
      'tests/api/conftest.py',
      'def auth():\n    return bearer_headers()\ndef store(): ...',
    );
    const prompts: string[] = [];
    let calls = 0;
    const generateContent = async (req: { system?: string; prompt: string }) => {
      prompts.push(req.prompt);
      calls += 1;
      if (calls === 1) {
        return {
          ok: true as const,
          text: 'REQUEST_CHANGES\n\nFixtures auth/store look missing.\nNEEDS-BASE: tests/api/conftest.py',
        };
      }
      return { ok: true as const, text: 'APPROVE\n\nFixtures defined in base conftest; resolved.' };
    };

    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(2);
    // Pass-2 prompt carries the base file contents, marked present + untrusted.
    expect(prompts[1]).toContain('PRESENT IN BASE');
    expect(prompts[1]).toContain('def auth');
    expect(prompts[1]).toContain('UNTRUSTED BASE FILES');
    // The SECOND-pass verdict (approve) is authoritative.
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:approved']);
    // biome-ignore lint/style/noNonNullAssertion: comment posted (result ok).
    const comment = deps.issues.commentHistory()[0]!;
    expect(comment.structural).toMatchObject({ verdict: 'approve' });
    expect(comment.body).toContain('resolved');
  });

  test('genuinely absent reference (not in base) → fail-closed REQUEST_CHANGES → PR status:changes_requested', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff('PR_kwAOA_77', 'diff --git a/t.py b/t.py\n+from ghost import x');
    // No seedBaseFile → readBaseFile returns a clean found:false (absent).
    const prompts: string[] = [];
    let calls = 0;
    const generateContent = async (req: { system?: string; prompt: string }) => {
      prompts.push(req.prompt);
      calls += 1;
      if (calls === 1) {
        return { ok: true as const, text: 'REQUEST_CHANGES\n\nMissing.\nNEEDS-BASE: ghost.py' };
      }
      return {
        ok: true as const,
        text: 'REQUEST_CHANGES\n\nNot in base either — genuinely missing.',
      };
    };

    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });

    // The pass-2 verdict is request-changes (genuinely absent ref) → drive the PR
    // in_review→changes_requested.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(2);
    expect(prompts[1]).toContain('NOT FOUND IN BASE');
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: 'PR_kwAOA_77', label: 'status:changes_requested' },
    ]);
    expect(deps.issues.commentHistory().map((c) => c.recordId)).toEqual(['PR_kwAOA_77']);
  });

  test('base read transport failure → typed hard-gate fail-closed, NO pass 2, NO writes', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff('PR_kwAOA_77', 'diff --git a/t.py b/t.py\n+from conftest import auth');
    deps.pulls.failNextBaseFileRead('network_error:boom');
    let calls = 0;
    const generateContent = async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true as const, text: 'REQUEST_CHANGES\nNEEDS-BASE: tests/api/conftest.py' };
      }
      // Even if the brain would APPROVE on pass 2, the hard gate fires first.
      return { ok: true as const, text: 'APPROVE\n\nshould never reach pass 2' };
    };

    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('review_agent_base_file_unreadable_v0:PR_kwAOA_77');
    // Deterministic gate before the brain re-verdicts: only pass 1 ran.
    expect(calls).toBe(1);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
  });

  test('truncated base file is NOT presented as proof of existence (fail-closed framing)', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff('PR_kwAOA_77', 'diff --git a/t.py b/t.py\n+from conftest import auth');
    // Present at base but truncated — the cited symbol could sit past the cap.
    deps.pulls.seedBaseFile('PR_kwAOA_77', 'tests/api/conftest.py', 'def other(): ...', true);
    const prompts: string[] = [];
    let calls = 0;
    const generateContent = async (req: { system?: string; prompt: string }) => {
      prompts.push(req.prompt);
      calls += 1;
      if (calls === 1) {
        return { ok: true as const, text: 'REQUEST_CHANGES\nNEEDS-BASE: tests/api/conftest.py' };
      }
      return {
        ok: true as const,
        text: 'REQUEST_CHANGES\n\nSymbol not visible in truncated excerpt.',
      };
    };

    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });

    // request-changes (truncated excerpt is not an existence proof) → drive the PR
    // to changes_requested.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The file header must mark it truncated (not a plain "(full)" existence
    // proof) and tell the brain it resolves only if the symbol is visible.
    expect(prompts[1]).toContain('PRESENT IN BASE BUT TRUNCATED');
    expect(prompts[1]).not.toContain('tests/api/conftest.py — PRESENT IN BASE (full)');
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: 'PR_kwAOA_77', label: 'status:changes_requested' },
    ]);
  });

  test('more than the cap of NEEDS-BASE lines → fail closed, no pass 2, NO writes', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff('PR_kwAOA_77', 'diff --git a/t.py b/t.py\n+x');
    // 21 unique cited paths (cap is 20): resolving only the first 20 would let
    // pass 2 verdict on an incomplete base set → must fail closed instead.
    const needsBase = Array.from({ length: 21 }, (_, i) => `NEEDS-BASE: f${i}.py`).join('\n');
    let calls = 0;
    const generateContent = async () => {
      calls += 1;
      return { ok: true as const, text: `REQUEST_CHANGES\n${needsBase}` };
    };

    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('review_agent_base_requests_overflow_v0:PR_kwAOA_77');
    // Pass 1 only; no second generateContent call, no findings/label writes.
    expect(calls).toBe(1);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('aggregate base content over the budget → fail closed, no pass 2, NO writes', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff('PR_kwAOA_77', 'diff --git a/t.py b/t.py\n+x');
    // 4 cited paths (within the 20-file cap), each 60KB present-in-base → 240KB
    // aggregate, over the 200KB pass-2 budget. Resolving them would build an
    // oversized pass-2 prompt → must fail closed instead of dead-lettering later.
    const big = 'x'.repeat(60_000);
    const paths = ['a.py', 'b.py', 'c.py', 'd.py'];
    for (const p of paths) deps.pulls.seedBaseFile('PR_kwAOA_77', p, big);
    const needsBase = paths.map((p) => `NEEDS-BASE: ${p}`).join('\n');
    let calls = 0;
    const generateContent = async () => {
      calls += 1;
      return { ok: true as const, text: `REQUEST_CHANGES\n${needsBase}` };
    };

    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('review_agent_base_context_overflow_v0:PR_kwAOA_77');
    // Pass 1 only — the budget gate fires before the second generateContent.
    expect(calls).toBe(1);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('no NEEDS-BASE line → single pass, no base round-trip (unchanged behavior)', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff('PR_kwAOA_77', 'diff --git a/x b/x\n+ok');
    let calls = 0;
    const generateContent = async () => {
      calls += 1;
      return { ok: true as const, text: 'APPROVE\n\nLooks correct.' };
    };
    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:approved']);
  });

  test('pass-2 content failure → typed review_agent_content_failed, fail closed, NO writes', async () => {
    const deps = makeDeps();
    deps.pulls.seedDiff('PR_kwAOA_77', 'diff --git a/t.py b/t.py\n+from conftest import auth');
    deps.pulls.seedBaseFile('PR_kwAOA_77', 'conftest.py', 'def auth(): ...');
    let calls = 0;
    const generateContent = async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true as const, text: 'REQUEST_CHANGES\nNEEDS-BASE: conftest.py' };
      }
      return { ok: false as const, text: '', stopReason: 'max_tokens' };
    };
    const result = await runReviewAgent(makeMessage(), { ...deps, generateContent });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('review_agent_content_failed:max_tokens');
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runReviewAgent — newest pr-ref wins on the paired-Task route', () => {
  test('Task with a stale + a newer pr-ref → the NEWER PR is claimed', async () => {
    const deps = makeDeps();
    deps.pulls.seedRecord({
      recordId: 'PR_kwAOA_NEW',
      number: 99,
      state: 'open',
      headBranch: 'sf/T-99/01HV7/build@opus-4-7',
      baseBranch: 'main',
    });
    deps.issues.seedRecord({ recordId: 'PR_kwAOA_NEW', labels: [], body: '' });
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:in_review'],
      body: 'pr-ref: PR_kwAOA_77\npr-ref: PR_kwAOA_NEW',
    });
    const result = await runReviewAgent(
      makeMessage({
        kind: 'task',
        recordKind: 'Task',
        recordType: 'Issue',
        recordId: 'I_kwAOA_task_99',
        fromState: 'in_progress',
        toState: 'in_review',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('PR_kwAOA_NEW');
    expect(deps.issues.labelApplyHistory().map((e) => e.recordId)).toEqual(['PR_kwAOA_NEW']);
  });
});
