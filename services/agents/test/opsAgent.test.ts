import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { runOpsAgent } from '../src/agents/opsAgent.js';
import { StubIssueTool } from '../src/tools/issueTool.js';
import { StubPullTool } from '../src/tools/pullTool.js';
import type { ParsedTransitionMessage } from '../src/types.js';

const TASK_RECORD_ID = 'I_kwTask_219';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:pull_request_review.submitted',
    kind: 'pr',
    actor: 'ReviewAgent',
    recordType: 'PullRequest',
    recordKind: 'PR',
    recordId: 'PR_kwAOA_77',
    fromState: 'in_review',
    toState: 'approved',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

// Default fixture is the live post-merge shape: the PR body carries
// BuildAgent's `task-ref:` line, the Task body carries the REQUIRED `pr-ref:`
// backlink pointing back at this PR (BuildAgent writes it at PR-open —
// bidirectional-pairing enforcement), and the paired Task still sits
// at status:ready (v0 BuildAgent never claims it), so the post-merge
// bookkeeping drives ready→done.
// `null` seeds the Task with NO status label (implicit `proposed`).
function makeDeps(taskStatusLabel: string | null = 'status:ready') {
  const pulls = new StubPullTool();
  pulls.seedRecord({
    recordId: 'PR_kwAOA_77',
    number: 77,
    state: 'open',
    headBranch: 'sf/T-219/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
    baseBranch: 'main',
    body: `task-ref: ${TASK_RECORD_ID}\n\n## Summary\nBuildAgent PR.`,
  });
  const issues = new StubIssueTool();
  issues.seedRecord({
    recordId: TASK_RECORD_ID,
    labels: taskStatusLabel === null ? ['kind:task'] : ['kind:task', taskStatusLabel],
    body: 'Task body\npr-ref: PR_kwAOA_77',
  });
  return {
    pulls,
    issues,
    runId: '01HZXYZ123456789ABCDEFGHJK',
  };
}

describe('runOpsAgent — happy path on pr:in_review→approved', () => {
  test('squash-merges the PR and posts a structural merge note', async () => {
    const deps = makeDeps();
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const merges = deps.pulls.mergeHistory();
    expect(merges).toHaveLength(1);
    expect(merges[0]?.recordId).toBe('PR_kwAOA_77');
    expect(merges[0]?.method).toBe('squash');

    const notes = deps.pulls.reviewHistory();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.state).toBe('comment');
    expect(notes[0]?.body).toMatch(/^OpsAgent squash-merged this PR\. Merge commit: `stub-merge-/);
    expect(notes[0]?.body).toContain('Run 01HZXYZ123456789ABCDEFGHJK');
  });

  test('result envelope names PR + merge SHA', async () => {
    const deps = makeDeps();
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^OpsAgent: merged PR PR_kwAOA_77 as stub-merge-/);
  });
});

describe('runOpsAgent — pre-merge stale-base gate (ADR 0012)', () => {
  test('happy path consults pulls.getSyncStatus before merging (default current → merge proceeds)', async () => {
    const deps = makeDeps();
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    // The gate was actually called (the default StubPullTool reports
    // 'current' so the merge proceeds).
    expect(deps.pulls.syncStatusHistory()).toEqual(['PR_kwAOA_77']);
    expect(deps.pulls.mergeHistory()).toHaveLength(1);
  });

  test('behind → typed ops_agent_stale_base_at_merge with behindBy; NO merge call', async () => {
    const deps = makeDeps();
    deps.pulls.setSyncStatus('PR_kwAOA_77', {
      recordId: 'PR_kwAOA_77',
      status: 'behind',
      behindBy: 5,
    });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ops_agent_stale_base_at_merge:PR_kwAOA_77:behindBy=5');
    expect(deps.pulls.mergeHistory()).toHaveLength(0); // <-- the key assertion
  });

  test('behind without behindBy → uses ? in the typed reason (real GH API edge case)', async () => {
    const deps = makeDeps();
    deps.pulls.setSyncStatus('PR_kwAOA_77', {
      recordId: 'PR_kwAOA_77',
      status: 'behind',
    });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ops_agent_stale_base_at_merge:PR_kwAOA_77:behindBy=?');
  });

  test('sync check failure → ops_agent_sync_check_failed; NO merge (fail-closed)', async () => {
    const pulls = new StubPullTool();
    // Patch the getSyncStatus on this instance to fail; everything else
    // (read, open, submitReview, merge, close) stays the full interface.
    pulls.getSyncStatus = async () => ({
      ok: false as const,
      reason: 'compare_api_500',
    });
    const result = await runOpsAgent(makeMessage(), {
      pulls,
      issues: new StubIssueTool(),
      runId: 'r',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ops_agent_sync_check_failed:compare_api_500');
    expect(pulls.mergeHistory()).toHaveLength(0);
  });

  test('sync check happens AFTER the wrong_transition guard (no sync call on guard fail)', async () => {
    const deps = makeDeps();
    await runOpsAgent(makeMessage({ kind: 'task' }), deps);
    expect(deps.pulls.syncStatusHistory()).toHaveLength(0);
  });
});

describe('runOpsAgent — defensive guards', () => {
  test('non-pr kind → typed wrong_transition failure (no merge attempted)', async () => {
    const deps = makeDeps();
    const result = await runOpsAgent(makeMessage({ kind: 'task' }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^ops_agent_wrong_transition:task:/);
    expect(deps.pulls.mergeHistory()).toHaveLength(0);
  });

  test('pr but not in_review→approved → typed wrong_transition', async () => {
    const deps = makeDeps();
    const result = await runOpsAgent(makeMessage({ fromState: 'draft', toState: 'open' }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ops_agent_wrong_transition:pr:draft→open');
    expect(deps.pulls.mergeHistory()).toHaveLength(0);
  });
});

describe('runOpsAgent — post-merge Task bookkeeping', () => {
  test('happy path: task-ref resolved → marker comment, then status:done applied, then status:ready removed', async () => {
    const deps = makeDeps();
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=done:${TASK_RECORD_ID}:ready→done`);

    // Structural-marker comment on the TASK, ADR 0009 §D `role@model` form
    // (a bare `OpsAgent` would parse as malformed_agent_spec).
    const comments = deps.issues.commentHistory();
    expect(comments).toHaveLength(1);
    expect(comments[0]?.recordId).toBe(TASK_RECORD_ID);
    expect(comments[0]?.structural).toEqual({
      role: 'ops@none',
      run: '01HZXYZ123456789ABCDEFGHJK',
    });
    expect(comments[0]?.body).toContain('PR_kwAOA_77');
    expect(comments[0]?.body).toMatch(/stub-merge-/);

    // APPLY-then-REMOVE label swap (apply drives task:ready→done; removal is
    // the observational swap cleanup).
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: TASK_RECORD_ID, label: 'status:done' },
    ]);
    expect(deps.issues.labelRemoveHistory()).toEqual([
      { recordId: TASK_RECORD_ID, label: 'status:ready' },
    ]);

    // The status:done Task is also CLOSED with reason=completed so
    // the board never shows open-but-done records.
    expect(deps.issues.closeHistory()).toEqual([{ recordId: TASK_RECORD_ID, reason: 'completed' }]);
  });

  test('task at status:in_review → drives in_review→done (the pre-existing OpsAgent FSM edge)', async () => {
    const deps = makeDeps('status:in_review');
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=done:${TASK_RECORD_ID}:in_review→done`);
    expect(deps.issues.labelRemoveHistory()).toEqual([
      { recordId: TASK_RECORD_ID, label: 'status:in_review' },
    ]);
  });

  test('missing task-ref in PR body → merge still ok with typed skip; no issue calls', async () => {
    const deps = makeDeps();
    deps.pulls.seedRecord({
      recordId: 'PR_kwAOA_77',
      number: 77,
      state: 'open',
      headBranch: 'feat/manual',
      baseBranch: 'main',
      body: 'A human-authored PR body without the ref line.',
    });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.pulls.mergeHistory()).toHaveLength(1);
    expect(result.result).toContain('task_bookkeeping=skipped_no_task_ref');
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('PR record unreadable → merge still ok with typed failed token', async () => {
    const deps = makeDeps();
    deps.pulls.read = async () => ({ ok: false as const, reason: 'graphql_500' });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.pulls.mergeHistory()).toHaveLength(1);
    expect(result.result).toContain('task_bookkeeping=failed:pr_read:graphql_500');
  });

  test('task read failure → merge still ok with typed failed token; no label writes', async () => {
    const deps = makeDeps();
    deps.issues.read = async () => ({ ok: false as const, reason: 'record_not_found:x' });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('task_bookkeeping=failed:task_read:record_not_found:x');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('marker comment failure → merge still ok; NO label writes (marker-before-label ordering)', async () => {
    const deps = makeDeps();
    deps.issues.comment = async () => ({ ok: false as const, reason: 'comment_api_502' });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('task_bookkeeping=failed:marker_comment:comment_api_502');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.labelRemoveHistory()).toHaveLength(0);
  });

  test('apply status:done failure → merge still ok with typed failed token; prior label NOT removed (apply-then-remove)', async () => {
    const deps = makeDeps();
    deps.issues.applyLabel = async () => ({ ok: false as const, reason: 'label_api_502' });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.pulls.mergeHistory()).toHaveLength(1);
    expect(result.result).toContain('task_bookkeeping=failed:apply_done:label_api_502');
    // The Task keeps status:ready (recoverable) — never stranded label-less.
    expect(deps.issues.labelRemoveHistory()).toHaveLength(0);
  });

  test('remove prior label failure AFTER successful apply → done with cleanup-gap token (transition already landed)', async () => {
    const deps = makeDeps();
    deps.issues.removeLabel = async () => ({ ok: false as const, reason: 'label_api_502' });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(
      `task_bookkeeping=done:${TASK_RECORD_ID}:ready→done:remove_prior_failed:label_api_502`,
    );
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: TASK_RECORD_ID, label: 'status:done' },
    ]);
  });

  test('task already status:done → typed idempotent skip; no comment, no label writes', async () => {
    const deps = makeDeps('status:done');
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=skipped_already_done:${TASK_RECORD_ID}`);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('task with NO status label (implicit proposed) → typed failed token, no off-policy label write', async () => {
    const deps = makeDeps(null);
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('task_bookkeeping=failed:ambiguous_status:none');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('task at status:in_progress → typed failed token (taskFsm has no in_progress→done edge for OpsAgent)', async () => {
    const deps = makeDeps('status:in_progress');
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(
      'task_bookkeeping=failed:unsupported_from_status:status:in_progress',
    );
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('bookkeeping runs only AFTER a successful merge (stale-base failure → no issue calls)', async () => {
    const deps = makeDeps();
    deps.pulls.setSyncStatus('PR_kwAOA_77', {
      recordId: 'PR_kwAOA_77',
      status: 'behind',
      behindBy: 2,
    });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runOpsAgent — idempotent merge (at-least-once redelivery / replay recovery)', () => {
  // Re-seed the default PR as already merged (same body/branches).
  function reseedMerged(deps: ReturnType<typeof makeDeps>): void {
    deps.pulls.seedRecord({
      recordId: 'PR_kwAOA_77',
      number: 77,
      state: 'merged',
      headBranch: 'sf/T-219/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
      baseBranch: 'main',
      body: `task-ref: ${TASK_RECORD_ID}\n\n## Summary\nBuildAgent PR.`,
    });
  }

  test('redelivered approved event on a MERGED PR → ok with merge=already_merged; bookkeeping runs (marker + labels); no second merge / note / sync check', async () => {
    const deps = makeDeps();
    reseedMerged(deps);
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^OpsAgent: PR PR_kwAOA_77 merge=already_merged; /);
    expect(result.result).toContain(`task_bookkeeping=done:${TASK_RECORD_ID}:ready→done`);

    // The merge path is fully skipped: no merge call, no duplicate merge
    // note, no stale-base sync check (the PR is already on main).
    expect(deps.pulls.mergeHistory()).toHaveLength(0);
    expect(deps.pulls.reviewHistory()).toHaveLength(0);
    expect(deps.pulls.syncStatusHistory()).toHaveLength(0);

    // Bookkeeping ran exactly as on a fresh merge: marker comment naming the
    // replay (no fresh merge SHA exists), then the status-label swap.
    const comments = deps.issues.commentHistory();
    expect(comments).toHaveLength(1);
    expect(comments[0]?.recordId).toBe(TASK_RECORD_ID);
    expect(comments[0]?.body).toContain('previously squash-merged');
    expect(comments[0]?.structural).toEqual({
      role: 'ops@none',
      run: '01HZXYZ123456789ABCDEFGHJK',
    });
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: TASK_RECORD_ID, label: 'status:done' },
    ]);
    expect(deps.issues.labelRemoveHistory()).toEqual([
      { recordId: TASK_RECORD_ID, label: 'status:ready' },
    ]);
  });

  test('redelivery on a merged PR whose Task is ALREADY done → ok with idempotent skipped_already_done (full replay no-op)', async () => {
    const deps = makeDeps('status:done');
    reseedMerged(deps);
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('merge=already_merged');
    expect(result.result).toContain(`task_bookkeeping=skipped_already_done:${TASK_RECORD_ID}`);
    expect(deps.pulls.mergeHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    // The approved-event redelivery is the autonomous close-retry path: no
    // transition re-driven, but the close is retried (idempotent).
    expect(deps.issues.closeHistory()).toEqual([{ recordId: TASK_RECORD_ID, reason: 'completed' }]);
  });

  test('CLOSED (unmerged) PR → typed ops_agent_pr_closed_unmerged failure; no merge, no bookkeeping', async () => {
    const deps = makeDeps();
    deps.pulls.seedRecord({
      recordId: 'PR_kwAOA_77',
      number: 77,
      state: 'closed',
      headBranch: 'sf/T-219/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
      baseBranch: 'main',
      body: `task-ref: ${TASK_RECORD_ID}\n\n## Summary\nBuildAgent PR.`,
    });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ops_agent_pr_closed_unmerged:PR_kwAOA_77');
    expect(deps.pulls.mergeHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runOpsAgent — task-ref target validation', () => {
  test('task-ref pointing at a non-Task record → typed skip, no writes', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: TASK_RECORD_ID,
      labels: ['kind:goal', 'status:accepted'], // re-seed the ref target as a non-Task
      body: '',
    });
    const result = await runOpsAgent(makeMessage(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=skipped_not_a_task:${TASK_RECORD_ID}`);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('Task with NO pr-ref backlink → typed skipped_no_pr_ref_backlink, no writes (backlink is REQUIRED)', async () => {
    const deps = { ...makeDeps(), backlinkRetryAttempts: 0, backlinkRetryDelayMs: 0 };
    deps.issues.seedRecord({
      recordId: TASK_RECORD_ID,
      labels: ['kind:task', 'status:ready'],
      body: 'Task body without the BuildAgent-written backlink',
    });
    const result = await runOpsAgent(makeMessage(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(
      `task_bookkeeping=skipped_no_pr_ref_backlink:${TASK_RECORD_ID}`,
    );
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.labelRemoveHistory()).toHaveLength(0);
  });

  test('Task whose pr-ref points at a DIFFERENT PR → typed pairing skip, no writes', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: TASK_RECORD_ID,
      labels: ['kind:task', 'status:ready'],
      body: 'pr-ref: PR_kwAOA_OTHER',
    });
    const result = await runOpsAgent(makeMessage(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=skipped_pr_ref_mismatch:${TASK_RECORD_ID}`);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('Task pr-ref pointing back at THIS PR → bookkeeping proceeds', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: TASK_RECORD_ID,
      labels: ['kind:task', 'status:ready'],
      body: 'pr-ref: PR_kwAOA_77',
    });
    const result = await runOpsAgent(makeMessage(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=done:${TASK_RECORD_ID}:ready→done`);
  });
});

describe('runOpsAgent — multiple pr-ref backlinks: newest wins', () => {
  test('merged PR IS the newest pr-ref (replacement-PR shape) → bookkeeping proceeds', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: TASK_RECORD_ID,
      labels: ['kind:task', 'status:ready'],
      body: 'pr-ref: PR_kwAOA_STALE\npr-ref: PR_kwAOA_77',
    });
    const result = await runOpsAgent(makeMessage(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=done:${TASK_RECORD_ID}:ready→done`);
  });

  test('merged PR is a STALE backlink (newer replacement exists) → mismatch skip, no writes', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: TASK_RECORD_ID,
      labels: ['kind:task', 'status:ready'],
      body: 'pr-ref: PR_kwAOA_77\npr-ref: PR_kwAOA_REPLACEMENT',
    });
    const result = await runOpsAgent(makeMessage(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=skipped_pr_ref_mismatch:${TASK_RECORD_ID}`);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runOpsAgent — bookkeeping survives merge-note failure', () => {
  test('note submitReview fails after merge → Task still driven to done; reason carries the token', async () => {
    const deps = makeDeps();
    deps.pulls.failNextSubmitReview('boom');
    const result = await runOpsAgent(makeMessage(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('ops_agent_merge_note_failed:');
    expect(result.reason).toContain(`task_bookkeeping=done:${TASK_RECORD_ID}:ready→done`);
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toContain('status:done');
  });
});

describe('runOpsAgent — backlink write race', () => {
  test('missing backlink on an sf/ PR is re-read; backlink appearing on retry → bookkeeping proceeds', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: TASK_RECORD_ID,
      labels: ['kind:task', 'status:ready'],
      body: 'Task body', // no backlink yet — mid-PATCH race
    });
    let reads = 0;
    const realRead = deps.issues.read.bind(deps.issues);
    deps.issues.read = async (recordId: string) => {
      reads += 1;
      if (recordId === TASK_RECORD_ID && reads >= 2) {
        deps.issues.seedRecord({
          recordId: TASK_RECORD_ID,
          labels: ['kind:task', 'status:ready'],
          body: 'Task body\npr-ref: PR_kwAOA_77',
        });
      }
      return realRead(recordId);
    };
    const result = await runOpsAgent(makeMessage(), {
      ...deps,
      backlinkRetryAttempts: 3,
      backlinkRetryDelayMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=done:${TASK_RECORD_ID}:ready→done`);
  });

  test('backlink never appears after retries → typed skip (genuinely unpaired)', async () => {
    const deps = makeDeps();
    deps.issues.seedRecord({
      recordId: TASK_RECORD_ID,
      labels: ['kind:task', 'status:ready'],
      body: 'Task body',
    });
    const result = await runOpsAgent(makeMessage(), {
      ...deps,
      backlinkRetryAttempts: 2,
      backlinkRetryDelayMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(
      `task_bookkeeping=skipped_no_pr_ref_backlink:${TASK_RECORD_ID}`,
    );
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});

describe('runOpsAgent — close the Task issue on done', () => {
  test('close failure AFTER the transition landed → done with close-gap token; Task still done', async () => {
    const deps = makeDeps();
    deps.issues.close = async () => ({ ok: false as const, reason: 'close_api_502' });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The {ready}→done edge already landed (apply succeeded); the open issue is
    // board hygiene only, surfaced as an appended token.
    expect(result.result).toContain(
      `task_bookkeeping=done:${TASK_RECORD_ID}:ready→done:close_failed:close_api_502`,
    );
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: TASK_RECORD_ID, label: 'status:done' },
    ]);
  });

  test('remove AND close both fail → both gap tokens appended, in order', async () => {
    const deps = makeDeps();
    deps.issues.removeLabel = async () => ({ ok: false as const, reason: 'rm_502' });
    deps.issues.close = async () => ({ ok: false as const, reason: 'cl_502' });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(
      `task_bookkeeping=done:${TASK_RECORD_ID}:ready→done:remove_prior_failed:rm_502:close_failed:cl_502`,
    );
  });

  test('a skipped (already-done) Task STILL retries the close (recovers a prior close failure on replay)', async () => {
    const deps = makeDeps('status:done');
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=skipped_already_done:${TASK_RECORD_ID}`);
    // The early-return is the only path a replay reaches; it must retry the
    // (idempotent) close so a prior run's close failure converges.
    expect(deps.issues.closeHistory()).toEqual([{ recordId: TASK_RECORD_ID, reason: 'completed' }]);
    // No transition is re-driven — close only, no marker/label writes.
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('skipped (already-done) close failure → close_failed token (recoverable on a further replay)', async () => {
    const deps = makeDeps('status:done');
    deps.issues.close = async () => ({ ok: false as const, reason: 'close_api_502' });
    const result = await runOpsAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(
      `task_bookkeeping=skipped_already_done:${TASK_RECORD_ID}:close_failed:close_api_502`,
    );
  });
});

describe('runOpsAgent — any-merge bookkeeping', () => {
  // A human merge (e.g. at the request-changes gate) arrives as
  // pull_request.closed merged:true → pr:<from>→merged. The orchestrator
  // dispatches OpsAgent for THIS transition; OpsAgent runs bookkeeping-only.
  function mergedMessage(fromState: string): ParsedTransitionMessage {
    return makeMessage({ fromState, toState: 'merged' });
  }

  test('human merge from in_review → paired Task reaches status:done AND is closed; no merge/sync/note calls', async () => {
    const deps = makeDeps();
    const result = await runOpsAgent(mergedMessage('in_review'), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(
      /^OpsAgent: PR PR_kwAOA_77 post-merge bookkeeping \(in_review→merged\); /,
    );
    expect(result.result).toContain(`task_bookkeeping=done:${TASK_RECORD_ID}:ready→done`);

    // The PR is already merged on the substrate — OpsAgent does NOT re-merge,
    // re-check sync, or post a merge note.
    expect(deps.pulls.mergeHistory()).toHaveLength(0);
    expect(deps.pulls.syncStatusHistory()).toHaveLength(0);
    expect(deps.pulls.reviewHistory()).toHaveLength(0);

    // Full bookkeeping: marker comment + label swap + issue close.
    expect(deps.issues.commentHistory()).toHaveLength(1);
    expect(deps.issues.commentHistory()[0]?.body).toContain('merged (post-merge bookkeeping)');
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: TASK_RECORD_ID, label: 'status:done' },
    ]);
    expect(deps.issues.labelRemoveHistory()).toEqual([
      { recordId: TASK_RECORD_ID, label: 'status:ready' },
    ]);
    expect(deps.issues.closeHistory()).toEqual([{ recordId: TASK_RECORD_ID, reason: 'completed' }]);
  });

  test('App merge (approved→merged) routed here → same bookkeeping path (no re-merge)', async () => {
    const deps = makeDeps();
    const result = await runOpsAgent(mergedMessage('approved'), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=done:${TASK_RECORD_ID}:ready→done`);
    expect(deps.pulls.mergeHistory()).toHaveLength(0);
  });

  test('idempotent: merged transition on a Task ALREADY done → skipped_already_done, no transition re-driven (close retried)', async () => {
    const deps = makeDeps('status:done');
    const result = await runOpsAgent(mergedMessage('approved'), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`task_bookkeeping=skipped_already_done:${TASK_RECORD_ID}`);
    // No transition re-driven (no marker comment, no label apply)...
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    // ...but the close IS retried so a prior close failure converges.
    expect(deps.issues.closeHistory()).toEqual([{ recordId: TASK_RECORD_ID, reason: 'completed' }]);
  });

  test('merged with no task-ref in PR body → typed skip, merge stays load-bearing', async () => {
    const deps = makeDeps();
    deps.pulls.seedRecord({
      recordId: 'PR_kwAOA_77',
      number: 77,
      state: 'merged',
      headBranch: 'feat/manual',
      baseBranch: 'main',
      body: 'A human-authored PR body without the ref line.',
    });
    const result = await runOpsAgent(mergedMessage('in_review'), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('task_bookkeeping=skipped_no_task_ref');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });
});
