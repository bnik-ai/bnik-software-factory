import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { type CloneFn, runBuildAgent } from '../src/agents/buildAgent.js';
import { StubGitTool } from '../src/tools/gitTool.js';
import { StubIssueTool } from '../src/tools/issueTool.js';
import { StubPullTool } from '../src/tools/pullTool.js';
import type { ParsedTransitionMessage } from '../src/types.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.labeled',
    kind: 'task',
    actor: 'PlannerAgent',
    recordType: 'Issue',
    recordKind: 'Task',
    recordId: 'I_kwAOA_task_99',
    fromState: 'proposed',
    toState: 'ready',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

function makeDeps(seedBody = 'parent-goal: I_x\ndesign-ref: I_y\n\nImplement webhook endpoint') {
  const issues = new StubIssueTool();
  issues.seedRecord({
    recordId: 'I_kwAOA_task_99',
    labels: ['kind:task', 'status:ready'],
    body: seedBody,
  });
  return {
    issues,
    git: new StubGitTool(),
    pulls: new StubPullTool(),
    runId: '01HZXYZ123456789ABCDEFGHJK',
    repo: 'example-org/software-factory',
    model: 'opus-4-7',
  };
}

describe('runBuildAgent — happy path on task:proposed→ready', () => {
  test('end-to-end sequence: branch → commit → push → open draft PR', async () => {
    const deps = makeDeps();
    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(deps.git.branchHistory()).toHaveLength(1);
    expect(deps.git.commitHistory()).toHaveLength(1);
    expect(deps.git.pushHistory()).toHaveLength(1);
    expect(deps.pulls.openHistory()).toHaveLength(1);

    const opened = deps.pulls.openHistory()[0];
    expect(opened?.draft).toBe(true);
    expect(opened?.title).toBe('Build: Implement webhook endpoint');
  });

  test('branch name matches ADR 0008 grammar sf/T-<id>/<ulid>/build@<model>', async () => {
    const deps = makeDeps();
    await runBuildAgent(makeMessage(), deps);

    const branchName = deps.git.branchHistory()[0]?.name ?? '';
    expect(branchName).toMatch(/^sf\/T-\d+\/[0-9A-HJKMNP-TV-Z]{26}\/build@[a-z0-9.-]+$/);
    expect(branchName).toContain('/build@opus-4-7');
    expect(branchName).toContain('/01HZXYZ123456789ABCDEFGHJK/');
  });

  test('commit carries SF-Agent/SF-Run/SF-Task trailers per ADR 0009', async () => {
    const deps = makeDeps();
    await runBuildAgent(makeMessage(), deps);

    const commit = deps.git.commitHistory()[0];
    expect(commit?.authorAgent).toBe('BuildAgent');
    expect(commit?.authorRun).toBe('01HZXYZ123456789ABCDEFGHJK');
    expect(commit?.authorTask).toMatch(/^T-\d+$/);
    expect(commit?.message).toMatch(/^add\(build\): scaffold T-\d+/);
    expect(commit?.message).toContain('SF-Agent: BuildAgent');
    expect(commit?.message).toContain('SF-Run: 01HZXYZ123456789ABCDEFGHJK');
    expect(commit?.message).toMatch(/SF-Task: T-\d+/);
  });

  test('push sets upstream on the new branch', async () => {
    const deps = makeDeps();
    await runBuildAgent(makeMessage(), deps);

    const push = deps.git.pushHistory()[0];
    expect(push?.setUpstream).toBe(true);
  });

  test('PR carries task-ref + branch + commit context in body', async () => {
    const deps = makeDeps();
    await runBuildAgent(makeMessage(), deps);

    const opened = deps.pulls.openHistory()[0];
    expect(opened?.taskRecordId).toBe('I_kwAOA_task_99');
    expect(opened?.baseBranch).toBe('main');
    expect(opened?.body).toContain('task-ref: I_kwAOA_task_99');
    expect(opened?.body).toMatch(/Branch: `sf\/T-/);
    expect(opened?.body).toMatch(/Commit: `stub-sha-/);
  });

  test('baseBranch override is respected', async () => {
    const deps = { ...makeDeps(), baseBranch: 'stgx' };
    await runBuildAgent(makeMessage(), deps);

    expect(deps.pulls.openHistory()[0]?.baseBranch).toBe('stgx');
  });

  test('writes the pr-ref backlink onto the Task body after PR-open (codex round 3 bidirectional pairing)', async () => {
    const deps = makeDeps();
    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // StubPullTool mints PR_stub_1 for the first open.
    expect(deps.issues.appendHistory()).toEqual([
      { recordId: 'I_kwAOA_task_99', line: 'pr-ref: PR_stub_1' },
    ]);
    const task = await deps.issues.read('I_kwAOA_task_99');
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.value.body).toContain('pr-ref: PR_stub_1');
    expect(result.result).toContain('pr_ref_backlink=written:I_kwAOA_task_99');
  });

  test('backlink-write failure → build still ok (PR is the load-bearing outcome) with typed pr_ref_backlink=failed token', async () => {
    const deps = makeDeps();
    deps.issues.appendToBody = async () => ({ ok: false as const, reason: 'patch_api_502' });
    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.pulls.openHistory()).toHaveLength(1);
    expect(result.result).toMatch(/^BuildAgent: opened draft PR PR_stub_1/);
    expect(result.result).toContain('pr_ref_backlink=failed:patch_api_502');
  });
});

describe('runBuildAgent — real coding-brain path (M1c env-gated)', () => {
  // Records call order across clone / git / coding / pulls so we can assert
  // the clone→branch→runCodingAgent→commit→push→open sequence.
  function makeRealDeps(codingResult: {
    ok: boolean;
    subtype: string;
    summary: string;
    numTurns: number;
    costUsd: number;
  }) {
    const order: string[] = [];
    const issues = new StubIssueTool();
    issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task'],
      body: 'parent-goal: I_x\n\nImplement webhook endpoint',
    });
    const git = new StubGitTool();
    const pulls = new StubPullTool();
    // Wrap stub methods to record order without losing their behavior.
    const branch = git.branch.bind(git);
    git.branch = async (a) => {
      order.push('branch');
      return branch(a);
    };
    const commit = git.commit.bind(git);
    git.commit = async (a) => {
      order.push('commit');
      return commit(a);
    };
    const push = git.push.bind(git);
    git.push = async (a) => {
      order.push('push');
      return push(a);
    };
    const open = pulls.open.bind(pulls);
    pulls.open = async (a) => {
      order.push('open');
      return open(a);
    };
    const codingCalls: Array<{ cwd: string; prompt: string; maxTurns?: number; model?: string }> =
      [];
    const clone: CloneFn = async () => {
      order.push('clone');
      return { ok: true as const, value: { workdir: '/tmp/sf-build/run' } };
    };
    const runCodingAgent = async (req: {
      cwd: string;
      prompt: string;
      maxTurns?: number;
      model?: string;
    }) => {
      order.push('coding');
      codingCalls.push(req);
      return codingResult;
    };
    return {
      order,
      codingCalls,
      deps: {
        issues,
        git,
        pulls,
        runId: '01HZXYZ123456789ABCDEFGHJK',
        repo: 'example-org/software-factory',
        model: 'opus-4-7',
        clone,
        runCodingAgent,
        workdir: '/tmp/sf-build/run',
      },
    };
  }

  test('success: clone→branch→runCodingAgent→commit→push→open (non-draft PR)', async () => {
    const { order, codingCalls, deps } = makeRealDeps({
      ok: true,
      subtype: 'success',
      summary: 'Implemented /healthz with a test.',
      numTurns: 12,
      costUsd: 0.42,
    });
    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    expect(order).toEqual(['clone', 'branch', 'coding', 'commit', 'push', 'open']);

    // Coding agent runs against the cloned workdir with a bounded turn cap
    // and the configured model normalized to a full Agent-SDK id.
    expect(codingCalls[0]?.cwd).toBe('/tmp/sf-build/run');
    expect(codingCalls[0]?.prompt).toContain('Implement webhook endpoint');
    expect(codingCalls[0]?.maxTurns).toBe(60);
    expect(codingCalls[0]?.model).toBe('claude-opus-4-7');

    // PR is opened non-draft, body carries the coding summary.
    const opened = deps.pulls.openHistory()[0];
    expect(opened?.draft).toBe(false);
    expect(opened?.body).toContain('Implemented /healthz with a test.');

    // The real path ALSO writes the pr-ref backlink onto the Task after open
    // (codex round 3 — both open sites are covered).
    expect(deps.issues.appendHistory()).toEqual([
      { recordId: 'I_kwAOA_task_99', line: 'pr-ref: PR_stub_1' },
    ]);
    if (!result.ok) return;
    expect(result.result).toContain('pr_ref_backlink=written:I_kwAOA_task_99');
  });

  test('coding-agent failure (subtype!=success) → typed failure, NO push/open', async () => {
    const { order, deps } = makeRealDeps({
      ok: false,
      subtype: 'error_max_turns',
      summary: '',
      numTurns: 60,
      costUsd: 1.1,
    });
    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('build_agent_coding_failed:error_max_turns:turns=60');
    // Stopped after coding — no commit/push/open.
    expect(order).toEqual(['clone', 'branch', 'coding']);
    expect(deps.git.commitHistory()).toHaveLength(0);
    expect(deps.git.pushHistory()).toHaveLength(0);
    expect(deps.pulls.openHistory()).toHaveLength(0);
  });

  test('clone failure → typed build_agent_clone_failed, no branch', async () => {
    const { deps } = makeRealDeps({
      ok: true,
      subtype: 'success',
      summary: 's',
      numTurns: 1,
      costUsd: 0,
    });
    deps.clone = async () => ({ ok: false as const, reason: 'auth_failed' });
    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('build_agent_clone_failed:auth_failed');
    expect(deps.git.branchHistory()).toHaveLength(0);
  });

  // Issue #180: a converged coding run with an EMPTY diff (Task already
  // satisfied by existing code) is a terminal already-done outcome — settle the
  // Task ready→done with a structural marker, never commit/push/open a PR, never
  // dead-letter. A genuine commit failure (non-empty diff) still dead-letters.
  test('empty diff (already satisfied) → settle Task ready→done, no PR, no DLQ', async () => {
    const { order, deps } = makeRealDeps({
      ok: true,
      subtype: 'success',
      summary: '',
      numTurns: 3,
      costUsd: 0.01,
    });
    // The seeded Task is at status:ready (PlannerAgent's proposed→ready drive).
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:ready'],
      body: 'parent-goal: I_x\n\nExtend config loader to accept deepseek',
    });
    deps.git.setNextHasChanges(false);

    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('already-satisfied');
    expect(result.result).toContain('settled ready→done');

    // Stopped after the change check — NO commit / push / PR.
    expect(order).toEqual(['clone', 'branch', 'coding']);
    expect(deps.git.commitHistory()).toHaveLength(0);
    expect(deps.git.pushHistory()).toHaveLength(0);
    expect(deps.pulls.openHistory()).toHaveLength(0);

    // Marker comment FIRST, attributed build@<model> (resolves to BuildAgent).
    const comments = deps.issues.commentHistory();
    expect(comments).toHaveLength(1);
    expect(comments[0]?.structural).toEqual({ role: 'build@opus-4-7', run: deps.runId });
    expect(comments[0]?.body).toContain('empty diff');

    // FSM transition: apply status:done, remove status:ready, close completed.
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: 'I_kwAOA_task_99', label: 'status:done' },
    ]);
    expect(deps.issues.labelRemoveHistory()).toEqual([
      { recordId: 'I_kwAOA_task_99', label: 'status:ready' },
    ]);
    expect(deps.issues.closeHistory()).toEqual([
      { recordId: 'I_kwAOA_task_99', reason: 'completed' },
    ]);
  });

  test('agent committed its OWN work (clean tree + commits ahead) → FAIL CLOSED, no un-attributed PR, no false done (codex P1+P2 #180)', async () => {
    const { order, deps } = makeRealDeps({
      ok: true,
      subtype: 'success',
      summary: 'agent committed',
      numTurns: 3,
      costUsd: 0.01,
    });
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:ready'],
      body: 'parent-goal: I_x\n\nExtend config loader',
    });
    deps.git.setNextHasChanges(true); // changed=true: the branch is ahead of base
    deps.git.setNextWorktreeDirty(false); // worktree clean
    deps.git.setNextCommittedAhead(true); // → agent self-committed (commits ahead)

    const result = await runBuildAgent(makeMessage(), deps);

    // The agent's commits lack ADR 0009 trailers — fail closed rather than push
    // un-attributed commits (P2) or silently settle done / drop them (P1).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^build_agent_coding_agent_self_committed:sf\/T-/);
    // No commit, no push, no PR, no done bookkeeping — work is preserved on the branch.
    expect(deps.git.commitHistory()).toHaveLength(0);
    expect(deps.git.pushHistory()).toHaveLength(0);
    expect(deps.pulls.openHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(order).toEqual(['clone', 'branch', 'coding']);
  });

  test('MIXED: agent self-committed AND left dirty edits → FAIL CLOSED (self-commit checked before the dirty path; codex P2 r6)', async () => {
    const { order, deps } = makeRealDeps({
      ok: true,
      subtype: 'success',
      summary: '',
      numTurns: 3,
      costUsd: 0.01,
    });
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:ready'],
      body: 'parent-goal: I_x\n\nSome task',
    });
    deps.git.setNextHasChanges(true);
    deps.git.setNextWorktreeDirty(true); // dirty leftovers
    deps.git.setNextCommittedAhead(true); // AND an un-attributed self-commit

    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^build_agent_coding_agent_self_committed:sf\/T-/);
    // The dirty leftovers are NOT committed/pushed — the un-attributed commit never ships.
    expect(deps.git.commitHistory()).toHaveLength(0);
    expect(deps.git.pushHistory()).toHaveLength(0);
    expect(deps.pulls.openHistory()).toHaveLength(0);
    expect(order).toEqual(['clone', 'branch', 'coding']);
  });

  test('clean tree but BEHIND a base that advanced mid-build → FAIL CLOSED for re-run, never settle done (codex P1 #180 r5)', async () => {
    const { order, deps } = makeRealDeps({
      ok: true,
      subtype: 'success',
      summary: '',
      numTurns: 3,
      costUsd: 0.01,
    });
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:ready'],
      body: 'parent-goal: I_x\n\nSome task',
    });
    deps.git.setNextHasChanges(true); // tree differs from the live base
    deps.git.setNextWorktreeDirty(false); // clean worktree
    deps.git.setNextCommittedAhead(false); // NOT self-committed → behind base

    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^build_agent_base_advanced_during_build:sf\/T-/);
    // Never settled done off a stale checkout.
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.closeHistory()).toHaveLength(0);
    expect(deps.pulls.openHistory()).toHaveLength(0);
    expect(order).toEqual(['clone', 'branch', 'coding']);
  });

  test('empty diff but Task NOT at status:ready → typed failure (FSM guard, dead-letter)', async () => {
    const { deps } = makeRealDeps({
      ok: true,
      subtype: 'success',
      summary: '',
      numTurns: 3,
      costUsd: 0.01,
    });
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:in_progress'],
      body: 'parent-goal: I_x\n\nSome task',
    });
    deps.git.setNextHasChanges(false);

    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      'build_agent_already_satisfied_unexpected_status:status:in_progress',
    );
    // No off-policy label write.
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
  });

  test('Task RELABELED during the coding run (ready→abandoned) → settle re-reads live labels and refuses, no status:done (codex P2 #180 TOCTOU)', async () => {
    const { deps } = makeRealDeps({
      ok: true,
      subtype: 'success',
      summary: '',
      numTurns: 3,
      costUsd: 0.01,
    });
    // Seeded at status:ready (the initial read snapshot says ready).
    deps.issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:ready'],
      body: 'parent-goal: I_x\n\nSome task',
    });
    deps.git.setNextHasChanges(false);
    // Simulate a human/agent abandoning the Task WHILE the (long) coding run is
    // in flight: the FIRST read (pre-coding ctx snapshot) sees status:ready; the
    // SECOND read (the settle's live re-read) sees status:abandoned.
    let readCount = 0;
    const baseRead = deps.issues.read.bind(deps.issues);
    deps.issues.read = async (id: string) => {
      readCount += 1;
      const base = await baseRead(id);
      if (!base.ok || readCount === 1) return base;
      return {
        ok: true as const,
        value: { ...base.value, labels: ['kind:task', 'status:abandoned'] },
      };
    };

    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('build_agent_already_satisfied_unexpected_status:status:abandoned');
    // The settle did NOT drive a terminal status:done off the stale snapshot.
    expect(deps.issues.labelApplyHistory().some((a) => a.label === 'status:done')).toBe(false);
    expect(deps.issues.closeHistory()).toHaveLength(0);
  });

  test('non-empty diff that fails to commit → still dead-letters (genuine build failure)', async () => {
    const { deps } = makeRealDeps({
      ok: true,
      subtype: 'success',
      summary: 's',
      numTurns: 3,
      costUsd: 0.01,
    });
    // hasChanges defaults true → reaches commit; force a genuine commit error
    // (the change check passed, so this is NOT the already-satisfied path).
    deps.git.commit = async () => ({
      ok: false as const,
      reason: 'commit_failed:index.lock exists',
    });
    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('build_agent_commit_failed:commit_failed:index.lock exists');
    // The settle path did NOT run — no Task label writes, no push/open.
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.git.pushHistory()).toHaveLength(0);
    expect(deps.pulls.openHistory()).toHaveLength(0);
  });
});

describe('runBuildAgent — defensive guards', () => {
  test('non-task kind → typed wrong_transition failure (no I/O)', async () => {
    const deps = makeDeps();
    const result = await runBuildAgent(makeMessage({ kind: 'goal' }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^build_agent_wrong_transition:goal:/);
    expect(deps.git.branchHistory()).toHaveLength(0);
    expect(deps.pulls.openHistory()).toHaveLength(0);
  });

  test('task but other transition (e.g. ready→in_progress) → not_yet_supported', async () => {
    const deps = makeDeps();
    const result = await runBuildAgent(
      makeMessage({ fromState: 'ready', toState: 'in_progress' }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('build_agent_not_yet_supported:ready→in_progress');
    expect(deps.git.branchHistory()).toHaveLength(0);
  });

  test('task read failure surfaces as typed failure', async () => {
    const deps = {
      issues: new StubIssueTool(), // no seed
      git: new StubGitTool(),
      pulls: new StubPullTool(),
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    };
    const result = await runBuildAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^build_agent_task_read_failed:record_not_found:/);
    expect(deps.git.branchHistory()).toHaveLength(0);
  });
});

describe('runBuildAgent — rebase-for-review path (ADR 0012; B4-PR9)', () => {
  function makeRebaseMessage(
    overrides: Partial<ParsedTransitionMessage> = {},
  ): ParsedTransitionMessage {
    return {
      ...makeMessage(),
      eventType: 'synthetic:branch_sync_required',
      kind: 'pr',
      recordKind: 'PR',
      actor: 'system',
      recordId: 'PR_kwAOA_77',
      fromState: 'open',
      toState: 'needs_sync_for_review',
      deliveryId: 'd-pr-77:rebase',
      headBranch: 'sf/T-77/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
      baseBranch: 'main',
      ...overrides,
    };
  }

  // The bounce reads the PR's live status label (issue #192) — seed the PR-as-
  // issue at status:in_review (the state a gated review-trigger leaves it in).
  // The claim-phase path (codex #200 r3) also reads the PR's native state via
  // pulls, so seed the PR record too (default native open).
  function makeRebaseDeps(
    prStatusLabels: readonly string[] = ['status:in_review'],
    prNativeState: 'draft' | 'open' | 'merged' | 'closed' = 'open',
  ) {
    const issues = new StubIssueTool();
    issues.seedRecord({ recordId: 'PR_kwAOA_77', labels: [...prStatusLabels], body: '' });
    const pulls = new StubPullTool();
    pulls.seedRecord({
      recordId: 'PR_kwAOA_77',
      number: 77,
      state: prNativeState,
      headBranch: 'sf/T-77/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
      baseBranch: 'main',
    });
    return {
      issues,
      git: new StubGitTool(),
      pulls,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    };
  }

  // Step-two dispatch (pr:in_review→syncing → BuildAgent finishSyncBounce).
  function makeFinishSyncMessage(): ParsedTransitionMessage {
    return {
      ...makeRebaseMessage(),
      eventType: 'webhook:pull_request.labeled',
      fromState: 'in_review',
      toState: 'syncing',
    };
  }

  test('STEP 1 happy path: rebase + force-push, then drive PR to durable status:syncing (issue #192)', async () => {
    const deps = makeRebaseDeps();
    deps.git.setNextRebaseTreeChanged(true);
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^BuildAgent: rebase-for-review on sf\/T-77/);
    expect(result.result).toContain('rebased + force-pushed');
    expect(result.result).toContain('full re-review');
    // Step 1 ends the PR DURABLY at syncing (pr:in_review→syncing) — NOT a
    // synchronous bounce. Step 2 (dispatched off that transition) re-fires review.
    expect(result.result).toContain('re_sync=driven_to_syncing:PR_kwAOA_77');
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:syncing']);
    expect(deps.issues.labelRemoveHistory().map((e) => e.label)).toEqual(['status:in_review']);
    expect(deps.issues.commentHistory()).toHaveLength(0);
    expect(deps.git.rebaseHistory()).toHaveLength(1);
    expect(deps.git.pushHistory()).toHaveLength(1);
    expect(deps.git.pushHistory()[0]?.forceWithLease).toBe(true);
    expect(deps.git.branchHistory()).toHaveLength(0);
    expect(deps.git.commitHistory()).toHaveLength(0);
  });

  test('regression issue #112: treeChanged=false BUT head SHA changed → push MUST fire (delta re-review)', async () => {
    const deps = makeRebaseDeps();
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('rebased + force-pushed');
    expect(result.result).toContain('delta re-review');
    expect(deps.git.rebaseHistory()).toHaveLength(1);
    expect(deps.git.pushHistory()).toHaveLength(1);
    expect(deps.git.pushHistory()[0]?.forceWithLease).toBe(true);
  });

  test('truly-no-op rebase (head SHA unchanged) → no push, but STILL drives to syncing to re-fire review', async () => {
    const deps = makeRebaseDeps();
    deps.git.setNextRebaseHeadUnchanged(true);
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('no-op');
    expect(result.result).toContain('already current with main');
    expect(result.result).toContain('re_sync=driven_to_syncing:PR_kwAOA_77');
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:syncing']);
    expect(deps.git.rebaseHistory()).toHaveLength(1);
    expect(deps.git.pushHistory()).toHaveLength(0);
  });

  test('STEP 1 load-bearing: a drive-to-syncing label-op failure FAILS the rebase (a stranded bounce is the stall)', async () => {
    const deps = makeRebaseDeps();
    deps.git.setNextRebaseTreeChanged(true);
    deps.issues.applyLabel = async (args) =>
      args.label === 'status:syncing'
        ? { ok: false as const, reason: 'github_502' }
        : { ok: true as const, value: { recordId: args.recordId, label: args.label } };
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('build_agent_rebase_apply_syncing_failed:github_502');
    expect(deps.git.pushHistory()).toHaveLength(1); // rebase succeeded; redelivery resumes
  });

  test('STEP 1 redelivery: PR already at status:syncing → no-op (the pr:in_review→syncing already fired; step 2 is dispatched)', async () => {
    const deps = makeRebaseDeps(['status:syncing']);
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=already_syncing:PR_kwAOA_77');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.labelRemoveHistory()).toHaveLength(0);
  });

  test('STEP 1 redelivery: HALF-APPLIED dual-label [syncing, in_review] → resume the in_review removal, NO re-apply (codex #200 r2)', async () => {
    // A prior run applied status:syncing but the status:in_review removal failed →
    // both labels present. Resuming must complete the removal (not return
    // already_syncing, which would strand the bounce: step 2's in_review apply
    // would be a no-op).
    const deps = makeRebaseDeps();
    deps.issues.seedRecord({
      recordId: 'PR_kwAOA_77',
      labels: ['status:syncing', 'status:in_review'],
      body: '',
    });
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=driven_to_syncing:PR_kwAOA_77');
    // No re-apply of syncing (already present); just the in_review removal resumes.
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.labelRemoveHistory().map((e) => e.label)).toEqual(['status:in_review']);
  });

  test('STEP 1 skip: PR left the review surface (status:approved) → skip, no claim/label writes', async () => {
    const deps = makeRebaseDeps(['status:approved']);
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=skipped:PR_kwAOA_77');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
  });

  test('STEP 1 skip: PR already merged → skip (a stale rebase must not re-open a finished review)', async () => {
    const deps = makeRebaseDeps([], 'merged');
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=skipped:PR_kwAOA_77');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('CLAIM-mode REDELIVERY + TRUE no-op rebase (head unchanged) → already_claimed no-op (codex #200 r9 P1)', async () => {
    // Prior claim-mode rebase already claimed (status:in_review). On redelivery the
    // rebase is a no-op (head unchanged) so the prior ReviewAgent run still covers
    // the current head. Must NOT bounce (would race that verdict).
    const deps = makeRebaseDeps(['status:in_review'], 'open');
    deps.git.setNextRebaseHeadUnchanged(true);
    const result = await runBuildAgent(makeRebaseMessage({ reReviewMode: 'claim' }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=already_claimed:PR_kwAOA_77');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.labelRemoveHistory()).toHaveLength(0);
  });

  test('CLAIM-mode REDELIVERY + rebase CHANGED the head → bounce to re-review the new head (codex #202)', async () => {
    // The redelivery's rebase pushed a NEW head (base advanced again). The prior
    // claim reviewed the OLD head, so the new head still needs review → bounce, not
    // a no-op. (Stub default: rebase changes the head.)
    const deps = makeRebaseDeps(['status:in_review'], 'open');
    const result = await runBuildAgent(makeRebaseMessage({ reReviewMode: 'claim' }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=driven_to_syncing:PR_kwAOA_77');
    // Bounce: apply status:syncing, remove status:in_review (re-fires re-review).
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:syncing']);
    expect(deps.issues.labelRemoveHistory().map((e) => e.label)).toEqual(['status:in_review']);
    expect(deps.git.pushHistory()).toHaveLength(1); // the changed head was pushed
  });

  test('CLAIM-phase: gate fired on an UNCLAIMED open PR (e.g. pr:__initial__→open) → BuildAgent claims after rebase (codex #200 r3)', async () => {
    // No status:in_review label + native open → the gate fired on a claim trigger
    // before the PR was claimed. After rebasing, BuildAgent claims (status:in_review
    // + marker) so pr:open→in_review routes to ReviewAgent — NOT a silent skip.
    const deps = makeRebaseDeps([], 'open');
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=claimed:PR_kwAOA_77');
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:in_review']);
    // A structural marker attributes the multi-agent open→in_review edge to BuildAgent.
    const markers = deps.issues.commentHistory();
    expect(markers).toHaveLength(1);
    expect(markers[0]?.structural?.role).toBe('build@opus-4-7');
    expect(markers[0]?.body).toContain('claiming review');
    expect(deps.git.rebaseHistory()).toHaveLength(1); // rebased first
  });

  test('NATIVE review-request: no status:in_review label but reReviewMode=bounce (ledger at in_review) → drive the bounce, NOT a no-op claim (codex #200 r7)', async () => {
    // A native pr:open→in_review review-request leaves the ledger at in_review with
    // NO status label. Claiming would re-apply in_review as a no-op and never
    // re-dispatch. reReviewMode='bounce' (from the orchestrator) drives the syncing
    // bounce instead: apply status:syncing → pr:in_review→syncing (from the ledger).
    const deps = makeRebaseDeps([], 'open');
    const result = await runBuildAgent(makeRebaseMessage({ reReviewMode: 'bounce' }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=driven_to_syncing:PR_kwAOA_77');
    // Apply status:syncing only — NO in_review label to remove (native request).
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:syncing']);
    expect(deps.issues.labelRemoveHistory()).toHaveLength(0);
    // It did NOT take the claim path (no claim marker comment).
    expect(deps.issues.commentHistory()).toHaveLength(0);
  });

  test('BOUNCE-mode skip: redelivered bounce-mode rebase on a PR now at status:approved → skip, NO syncing applied (codex #200 r8)', async () => {
    // reReviewMode='bounce' but the PR already reached approved on a redelivery. The
    // terminal skip must fire BEFORE the bounce path — applying status:syncing here
    // would be an illegal approved→syncing transition + an orphan label.
    const deps = makeRebaseDeps(['status:approved'], 'open');
    const result = await runBuildAgent(makeRebaseMessage({ reReviewMode: 'bounce' }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=skipped:PR_kwAOA_77');
    expect(result.result).toContain('approved');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('BOUNCE-mode skip: redelivered bounce-mode rebase on a PR parked at changes_requested → skip, NO syncing applied (codex #200 r8)', async () => {
    const deps = makeRebaseDeps(['status:changes_requested'], 'open');
    const result = await runBuildAgent(makeRebaseMessage({ reReviewMode: 'bounce' }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=skipped:PR_kwAOA_77');
    expect(result.result).toContain('changes_requested');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('CLAIM-phase skip: redelivered rebase on a PR now parked at changes_requested → skip, no reclaim (codex #200 r4)', async () => {
    // No in_review/syncing label → falls into the claim path, but the PR is parked
    // at changes_requested awaiting a revision. Claiming would re-review with no
    // fix pushed — skip instead.
    const deps = makeRebaseDeps(['status:changes_requested'], 'open');
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('re_sync=skipped:PR_kwAOA_77');
    expect(result.result).toContain('changes_requested');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
  });

  test('STEP 2 terminal guard: PR closed between step 1 and step 2 (syncing label persists) → skip, no review on a closed PR (codex #200 r4)', async () => {
    const deps = makeRebaseDeps(['status:syncing'], 'closed');
    const result = await runBuildAgent(makeFinishSyncMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('finish_sync=skipped:PR_kwAOA_77');
    expect(result.result).toContain('closed');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('STEP 2 (pr:in_review→syncing → BuildAgent): drive syncing→in_review re-fires review', async () => {
    const deps = makeRebaseDeps(['status:syncing']);
    const result = await runBuildAgent(makeFinishSyncMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('finish_sync=done:PR_kwAOA_77');
    // apply status:in_review (re-fires pr:syncing→in_review), remove status:syncing.
    expect(deps.issues.labelApplyHistory().map((e) => e.label)).toEqual(['status:in_review']);
    expect(deps.issues.labelRemoveHistory().map((e) => e.label)).toEqual(['status:syncing']);
    // No rebase on step 2 — it's pure FSM drive.
    expect(deps.git.rebaseHistory()).toHaveLength(0);
  });

  test('STEP 2 redelivery: PR no longer at status:syncing (already finished) → no-op', async () => {
    const deps = makeRebaseDeps(['status:in_review']);
    const result = await runBuildAgent(makeFinishSyncMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('finish_sync=skipped:PR_kwAOA_77');
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('missing headBranch on the synthetic message → typed wire-bug failure', async () => {
    const deps = makeRebaseDeps();
    const msg = makeRebaseMessage();
    msg.headBranch = undefined;
    const result = await runBuildAgent(msg, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('build_agent_rebase_missing_head_branch:PR_kwAOA_77');
    expect(deps.git.rebaseHistory()).toHaveLength(0);
  });

  test('rebase short-circuits BEFORE the task-kind guard (kind=pr no longer wrong_transition)', async () => {
    const deps = makeRebaseDeps();
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^BuildAgent: rebase-for-review/);
    expect(result.result).not.toContain('wrong_transition');
  });

  test('rebase tool failure → typed build_agent_rebase_failed', async () => {
    const failingGit = {
      branch: async () => ({ ok: false as const, reason: 'unused' }),
      commit: async () => ({ ok: false as const, reason: 'unused' }),
      push: async () => ({ ok: false as const, reason: 'unused' }),
      rebase: async () => ({ ok: false as const, reason: 'merge_conflict_in_src/auth.ts' }),
      hasChanges: async () => ({
        ok: true as const,
        value: { changed: false, worktreeDirty: false, committedAhead: false },
      }),
      headSha: async () => ({ ok: true as const, value: { sha: 'stub-head' } }),
    };
    const deps = {
      issues: new StubIssueTool(),
      git: failingGit,
      pulls: new StubPullTool(),
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    };
    const result = await runBuildAgent(makeRebaseMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('build_agent_rebase_failed:merge_conflict_in_src/auth.ts');
  });
});

describe('runBuildAgent — revision loop on pr:in_review→changes_requested (issue #182)', () => {
  const HEAD_BRANCH = 'sf/T-99/01HV6/build@opus-4-7';
  const PR_ID = 'PR_stub_rev';
  // issue #191: the App bot login the ownership guard matches the PR author
  // against (GraphQL-normalized, no `[bot]` suffix — #161).
  const APP_BOT_LOGIN = 'example-factory';

  // The revision is dispatched with a pr-kind message (recordId = PR), mirroring
  // the rebase-for-review synthetic dispatch's kind='pr'.
  function makeRevisionMessage(
    overrides: Partial<ParsedTransitionMessage> = {},
  ): ParsedTransitionMessage {
    return makeMessage({
      eventType: 'webhook:pull_request.labeled',
      kind: 'pr',
      recordKind: 'PR',
      recordType: 'PullRequest',
      actor: 'ReviewAgent',
      recordId: PR_ID,
      fromState: 'in_review',
      toState: 'changes_requested',
      ...overrides,
    });
  }

  // Scaffold (no coding brain) deps: PR at in_review's changes_requested edge + N
  // recorded ReviewAgent request-changes rounds (the budget signal + findings
  // carrier). The PR body carries BuildAgent's `task-ref:` backlink (optional
  // prompt context). No Task labels are ever written by the revision path.
  function makeRevisionDeps(
    requestChangesRounds: number,
    opts: {
      prState?: 'open' | 'merged' | 'closed';
      prBody?: string;
      headBranch?: string;
      baseBranch?: string;
      prStatusLabel?: string;
      // issue #190: pre-seed N BuildAgent revision-pushed resume markers on the PR
      // (simulates a push that landed before a crash-before-drive redelivery).
      revisionPushedMarkers?: number;
      // issue #191 ownership overrides. Default App-authored same-repo so the
      // revision runs; override to simulate a human-opened or fork PR.
      author?: { login?: string; isBot: boolean };
      isCrossRepository?: boolean;
      appBotLogin?: string;
    } = {},
  ) {
    const issues = new StubIssueTool();
    // Optional Task context (read-only) the prompt enriches with.
    issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:ready'],
      body: 'parent-goal: I_x\n\nImplement webhook endpoint',
    });
    // The PR-as-issue carries the live status label the idempotency guard reads
    // (codex #189 r6). Default: still at changes_requested (the revision runs).
    issues.seedRecord({
      recordId: PR_ID,
      labels: [opts.prStatusLabel ?? 'status:changes_requested'],
      body: opts.prBody ?? 'task-ref: I_kwAOA_task_99',
    });
    const pulls = new StubPullTool();
    pulls.seedRecord({
      recordId: PR_ID,
      number: 77,
      state: opts.prState ?? 'open',
      headBranch: opts.headBranch ?? HEAD_BRANCH,
      baseBranch: opts.baseBranch ?? 'main',
      body: opts.prBody ?? 'task-ref: I_kwAOA_task_99',
      // issue #191: default App-authored same-repo so the ownership guard passes.
      author: opts.author ?? { login: APP_BOT_LOGIN, isBot: true },
      isCrossRepository: opts.isCrossRepository ?? false,
    });
    for (let round = 1; round <= requestChangesRounds; round += 1) {
      issues.seedComment(PR_ID, {
        commentId: `c-rc-${round}`,
        body: `Findings round ${round}: missing tests for the error path.`,
        structural: { role: 'review@opus-4-7', run: `run-${round}`, verdict: 'request-changes' },
      });
    }
    // issue #190: pre-seed BuildAgent revision-pushed resume markers (a prior
    // attempt pushed for that round but crashed before the FSM drive).
    for (let round = 1; round <= (opts.revisionPushedMarkers ?? 0); round += 1) {
      issues.seedComment(PR_ID, {
        commentId: `c-rp-${round}`,
        body: `BuildAgent: pushed a revision for request-changes round ${round} (resume marker).`,
        structural: { role: 'build@opus-4-7', run: `run-rp-${round}`, verdict: 'revision-pushed' },
      });
    }
    return {
      issues,
      git: new StubGitTool(),
      pulls,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
      // issue #191: the App slug the guard matches the PR author against.
      appBotLogin: opts.appBotLogin ?? APP_BOT_LOGIN,
    };
  }

  test('scaffold revision: reads findings → commit + push to SAME branch → drives PR changes_requested→in_review', async () => {
    const deps = makeRevisionDeps(1);
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('round 1/3');
    expect(result.result).toContain('drove PR changes_requested→in_review');
    // Existing branch reused (no new branch), single commit, push to head branch.
    expect(deps.git.branchHistory()).toHaveLength(0);
    expect(deps.git.commitHistory()).toHaveLength(1);
    expect(deps.git.pushHistory()).toEqual([{ branch: HEAD_BRANCH }]);
    // FSM drive on the PR: apply status:in_review, remove status:changes_requested.
    expect(deps.issues.labelApplyHistory()).toEqual([
      { recordId: PR_ID, label: 'status:in_review' },
    ]);
    expect(deps.issues.labelRemoveHistory()).toEqual([
      { recordId: PR_ID, label: 'status:changes_requested' },
    ]);
    // Two structural marker comments on the PR (build@model attribution): the
    // issue #190 revision-pushed resume marker, then the drive marker.
    const comments = deps.issues.commentHistory();
    expect(comments.map((c) => c.recordId)).toEqual([PR_ID, PR_ID]);
    expect(comments[0]?.structural).toMatchObject({
      role: 'build@opus-4-7',
      verdict: 'revision-pushed',
    });
    expect(comments[1]?.structural).toMatchObject({ role: 'build@opus-4-7' });
  });

  test('boundary: 3rd request-changes round still revises (cap is MAX_REVISION_ATTEMPTS=3)', async () => {
    const deps = makeRevisionDeps(3);
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('round 3/3');
    expect(deps.git.pushHistory()).toHaveLength(1);
  });

  test('bounded retries: 4th request-changes round → PARK for human, typed budget-exhausted, NO commit/push, NO FSM drive', async () => {
    const deps = makeRevisionDeps(4);
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`build_agent_revision_budget_exhausted:${PR_ID}`);
    expect(deps.git.commitHistory()).toHaveLength(0);
    expect(deps.git.pushHistory()).toHaveLength(0);
    // Parked, NOT driven: no status label writes (PR stays changes_requested).
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
    expect(deps.issues.labelRemoveHistory()).toHaveLength(0);
    // A single park marker on the PR (the human review surface).
    const parked = deps.issues.commentHistory();
    expect(parked.map((c) => c.recordId)).toEqual([PR_ID]);
    expect(parked[0]?.body).toContain('revision budget exhausted');
  });

  test('no recorded request-changes findings on the PR → fail closed build_agent_revision_no_findings', async () => {
    const deps = makeRevisionDeps(0);
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`build_agent_revision_no_findings:${PR_ID}`);
    expect(deps.git.commitHistory()).toHaveLength(0);
  });

  test('revision proceeds even when the PR body has no task-ref (Task context is optional)', async () => {
    const deps = makeRevisionDeps(1, { prBody: 'no backlink here' });
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('round 1/3');
    expect(deps.git.pushHistory()).toEqual([{ branch: HEAD_BRANCH }]);
  });

  test('redelivery after the PR was already revised (now status:in_review) → no-op, NO rebuild (codex #189 r6 idempotency)', async () => {
    // Same pr:in_review→changes_requested message redelivered after a prior
    // attempt drove the PR back to in_review: the request-changes comments are
    // unchanged, but the live PR label is no longer changes_requested → skip.
    const deps = makeRevisionDeps(1, { prStatusLabel: 'status:in_review' });
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('no longer status:changes_requested');
    expect(deps.git.commitHistory()).toHaveLength(0);
    expect(deps.git.pushHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('late changes-requested after the PR already merged → no-op ok (loop is over), no writes', async () => {
    const deps = makeRevisionDeps(1, { prState: 'merged' });
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('revision skipped');
    expect(deps.git.commitHistory()).toHaveLength(0);
    expect(deps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('real revision: clone(ref=headBranch) → coding(findings in prompt) → commit → push(same branch) → drive to review', async () => {
    const deps = makeRevisionDeps(1);
    const order: string[] = [];
    const codingCalls: Array<{ prompt: string; model?: string }> = [];
    const cloneCalls: Array<{ ref?: string; depth?: number } | undefined> = [];
    const clone: CloneFn = async (args) => {
      order.push('clone');
      cloneCalls.push(args);
      return { ok: true as const, value: { workdir: '/tmp/sf-build/rev' } };
    };
    const runCodingAgent = async (req: {
      cwd: string;
      prompt: string;
      maxTurns?: number;
      model?: string;
    }) => {
      order.push('coding');
      codingCalls.push(req);
      return {
        ok: true,
        subtype: 'success',
        summary: 'Added the missing error-path test.',
        numTurns: 5,
        costUsd: 0.1,
      };
    };
    const commit = deps.git.commit.bind(deps.git);
    deps.git.commit = async (a) => {
      order.push('commit');
      return commit(a);
    };
    const push = deps.git.push.bind(deps.git);
    deps.git.push = async (a) => {
      order.push('push');
      return push(a);
    };
    const realDeps = { ...deps, clone, runCodingAgent, workdir: '/tmp/sf-build/rev' };

    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Clone-at-existing-branch then coding → commit → push (no new branch, no open).
    expect(order).toEqual(['clone', 'coding', 'commit', 'push']);
    expect(cloneCalls[0]).toEqual({ ref: HEAD_BRANCH });
    // The revision prompt carries the findings text + the PR number under review.
    expect(codingCalls[0]?.prompt).toContain('Findings round 1');
    expect(codingCalls[0]?.prompt).toContain('REVISION of open PR #77');
    expect(codingCalls[0]?.model).toBe('claude-opus-4-7');
    // Pushed to the existing branch (no setUpstream).
    expect(realDeps.git.pushHistory()).toEqual([{ branch: HEAD_BRANCH }]);
    expect(result.result).toContain('coding turns=5');
  });

  test('real revision: coding run left a clean worktree (no new edits) → fail closed empty_diff, NO commit/push/drive', async () => {
    const deps = makeRevisionDeps(1);
    deps.git.setNextWorktreeDirty(false); // clean worktree after the coding run
    const clone: CloneFn = async () => ({
      ok: true as const,
      value: { workdir: '/tmp/sf-build/rev' },
    });
    const runCodingAgent = async () => ({
      ok: true,
      subtype: 'success',
      summary: 'no change',
      numTurns: 2,
      costUsd: 0.01,
    });
    const realDeps = { ...deps, clone, runCodingAgent, workdir: '/tmp/sf-build/rev' };

    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`build_agent_revision_empty_diff:${HEAD_BRANCH}`);
    expect(realDeps.git.commitHistory()).toHaveLength(0);
    expect(realDeps.git.pushHistory()).toHaveLength(0);
    expect(realDeps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('real revision: coding agent SELF-COMMITTED (HEAD moved) → fail closed, NO commit/push/drive (codex #189)', async () => {
    const deps = makeRevisionDeps(1);
    // HEAD differs before vs after the coding run → the agent committed itself;
    // those commits lack ADR 0009 trailers, so BuildAgent must not push them.
    deps.git.setNextHeadShas(['head-before', 'head-after-self-commit']);
    deps.git.setNextWorktreeDirty(true); // mixed case: self-commit + leftover edits
    const clone: CloneFn = async () => ({
      ok: true as const,
      value: { workdir: '/tmp/sf-build/rev' },
    });
    const runCodingAgent = async () => ({
      ok: true,
      subtype: 'success',
      summary: 'self-committed',
      numTurns: 4,
      costUsd: 0.02,
    });
    const realDeps = { ...deps, clone, runCodingAgent, workdir: '/tmp/sf-build/rev' };

    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`build_agent_revision_coding_agent_self_committed:${HEAD_BRANCH}`);
    // No un-attributed commit published, no FSM drive.
    expect(realDeps.git.commitHistory()).toHaveLength(0);
    expect(realDeps.git.pushHistory()).toHaveLength(0);
    expect(realDeps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('non-agent (human/fork) head branch → PARK, no clone/commit/push/drive (codex #189 r4)', async () => {
    // A human-opened PR (head branch is not sf/...) must never be auto-mutated.
    const deps = makeRevisionDeps(1, { headBranch: 'feature/human-patch' });
    let cloned = false;
    const realDeps = {
      ...deps,
      clone: (async () => {
        cloned = true;
        return { ok: true as const, value: { workdir: '/tmp/x' } };
      }) as CloneFn,
      runCodingAgent: async () => ({
        ok: true,
        subtype: 'success',
        summary: 'x',
        numTurns: 1,
        costUsd: 0,
      }),
      workdir: '/tmp/x',
    };
    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`build_agent_revision_not_agent_branch:${PR_ID}`);
    expect(cloned).toBe(false); // never touched the branch
    expect(realDeps.git.commitHistory()).toHaveLength(0);
    expect(realDeps.git.pushHistory()).toHaveLength(0);
    expect(realDeps.issues.labelApplyHistory()).toHaveLength(0);
    // A park marker on the PR (the human surface).
    const parked = realDeps.issues.commentHistory();
    expect(parked.map((c) => c.recordId)).toEqual([PR_ID]);
    expect(parked[0]?.body).toContain('not a BuildAgent-owned');
  });

  test('issue #191: human-authored PR on an sf/...-named branch → PARK (branch grammar alone is not ownership)', async () => {
    // A human crafts a branch matching the agent grammar (HEAD_BRANCH) but
    // authors the PR themselves (isBot:false). The grammar passes; the
    // App-author check must reject it → park, never auto-mutate.
    const deps = makeRevisionDeps(1, { author: { login: 'a-human', isBot: false } });
    const clone: CloneFn = async () => ({ ok: true as const, value: { workdir: '/tmp/x' } });
    let cloned = false;
    const realDeps = {
      ...deps,
      clone: (async () => {
        cloned = true;
        return { ok: true as const, value: { workdir: '/tmp/x' } };
      }) as CloneFn,
      runCodingAgent: async () => ({
        ok: true,
        subtype: 'success',
        summary: 'x',
        numTurns: 1,
        costUsd: 0,
      }),
      workdir: '/tmp/x',
    };
    void clone;
    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`build_agent_revision_not_agent_branch:${PR_ID}`);
    expect(cloned).toBe(false);
    expect(realDeps.git.commitHistory()).toHaveLength(0);
    expect(realDeps.git.pushHistory()).toHaveLength(0);
    expect(realDeps.issues.labelApplyHistory()).toHaveLength(0);
  });

  test('issue #191: PR authored by a DIFFERENT installed App (login mismatch) → PARK', async () => {
    // A Bot author, but not OUR App slug. The login match excludes other Apps.
    const deps = makeRevisionDeps(1, { author: { login: 'some-other-app', isBot: true } });
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`build_agent_revision_not_agent_branch:${PR_ID}`);
    expect(deps.git.commitHistory()).toHaveLength(0);
    expect(deps.git.pushHistory()).toHaveLength(0);
  });

  test('issue #191: fork PR (cross-repository) with a colliding sf/... ref → PARK, never clone/push the wrong base-repo branch', async () => {
    // App-authored AND grammar-matching, but the head lives in a FORK. Cloning/
    // pushing it would target the wrong base-repo branch → must park.
    const deps = makeRevisionDeps(1, { isCrossRepository: true });
    let cloned = false;
    const realDeps = {
      ...deps,
      clone: (async () => {
        cloned = true;
        return { ok: true as const, value: { workdir: '/tmp/x' } };
      }) as CloneFn,
      runCodingAgent: async () => ({
        ok: true,
        subtype: 'success',
        summary: 'x',
        numTurns: 1,
        costUsd: 0,
      }),
      workdir: '/tmp/x',
    };
    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`build_agent_revision_not_agent_branch:${PR_ID}`);
    expect(cloned).toBe(false);
    expect(realDeps.git.pushHistory()).toHaveLength(0);
  });

  test('issue #191: genuine App-authored same-repo sf/... PR revises (all three ownership signals hold)', async () => {
    // Grammar + App author (login match, suffix-normalized) + same-repo → revise.
    const deps = makeRevisionDeps(1, { author: { login: `${APP_BOT_LOGIN}[bot]`, isBot: true } });
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('round 1/3');
    expect(deps.git.pushHistory()).toEqual([{ branch: HEAD_BRANCH }]);
  });

  test('issue #191: appBotLogin unset → App-author check relaxes to the Bot floor (any Bot author same-repo grammar revises)', async () => {
    // With no configured slug the login match is skipped, but a non-Bot still
    // cannot pass. A Bot author + same-repo + grammar revises.
    const deps = makeRevisionDeps(1, {
      author: { login: 'any-bot', isBot: true },
      appBotLogin: undefined,
    });
    // Override the helper default (which sets appBotLogin) to genuinely-unset.
    const { appBotLogin: _drop, ...rest } = deps;
    void _drop;
    const result = await runBuildAgent(makeRevisionMessage(), rest);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('round 1/3');
  });

  test('revision empty-diff/self-commit checks compare against the PR base, not the default (codex #189 r4)', async () => {
    // PR based on a release branch, not main. hasChanges must be asked about that
    // base so the empty-diff/stale checks fetch origin/<that base>.
    const deps = makeRevisionDeps(1, { baseBranch: 'release/2.0' });
    const clone: CloneFn = async () => ({ ok: true as const, value: { workdir: '/tmp/rev' } });
    const runCodingAgent = async () => ({
      ok: true,
      subtype: 'success',
      summary: 'revised',
      numTurns: 3,
      costUsd: 0.02,
    });
    const realDeps = { ...deps, clone, runCodingAgent, workdir: '/tmp/rev' };

    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The change check used the PR's actual base, not DEFAULT_BASE_BRANCH/main.
    expect(realDeps.git.hasChangesBaseBranches).toEqual(['release/2.0']);
  });

  test('issue #190 redelivery after push-but-before-drive (revision-pushed marker present) → RESUMES the drive, NO rebuild', async () => {
    // A prior attempt pushed a revision for this single request-changes round but
    // crashed before driving to in_review, so the PR is still status:changes_requested
    // (cheap guard passes) AND a revision-pushed marker exists (markers >= rounds).
    const deps = makeRevisionDeps(1, { revisionPushedMarkers: 1 });
    let cloned = false;
    let coded = false;
    const realDeps = {
      ...deps,
      clone: (async () => {
        cloned = true;
        return { ok: true as const, value: { workdir: '/tmp/x' } };
      }) as CloneFn,
      runCodingAgent: async () => {
        coded = true;
        return { ok: true, subtype: 'success', summary: 'x', numTurns: 1, costUsd: 0 };
      },
      workdir: '/tmp/x',
    };
    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('resumed drive');
    expect(result.result).toContain('without rebuild');
    // No SECOND revision: the coding agent / commit / push never ran.
    expect(cloned).toBe(false);
    expect(coded).toBe(false);
    expect(realDeps.git.commitHistory()).toHaveLength(0);
    expect(realDeps.git.pushHistory()).toHaveLength(0);
    // The drive is resumed idempotently: apply status:in_review, remove changes_requested.
    expect(realDeps.issues.labelApplyHistory()).toEqual([
      { recordId: PR_ID, label: 'status:in_review' },
    ]);
    expect(realDeps.issues.labelRemoveHistory()).toEqual([
      { recordId: PR_ID, label: 'status:changes_requested' },
    ]);
    // Only the drive marker is written on resume (NO new revision-pushed marker).
    const written = realDeps.issues.commentHistory();
    expect(written).toHaveLength(1);
    expect(written[0]?.body).toContain('returning this PR to in_review');
  });

  test('issue #190 (codex #194): duplicate markers on an EARLIER round + a NEW request-changes → BUILDS, not false-resume', async () => {
    // Timeline: rc(round1), revision-pushed, revision-pushed (a duplicate from two
    // workers racing one delivery), THEN a NEW rc(round2) with no marker after it.
    // Count-based logic (markers 2 >= rounds 2) would falsely RESUME and skip the
    // newest findings; order-based logic sees no revision-pushed AFTER the latest
    // request-changes → must BUILD.
    const deps = makeRevisionDeps(0); // seed comments manually in timeline order
    deps.issues.seedComment(PR_ID, {
      commentId: 'c-rc-1',
      body: 'Findings round 1.',
      structural: { role: 'review@opus-4-7', run: 'run-1', verdict: 'request-changes' },
    });
    deps.issues.seedComment(PR_ID, {
      commentId: 'c-rp-1a',
      body: 'pushed (round 1).',
      structural: { role: 'build@opus-4-7', run: 'run-rp-1a', verdict: 'revision-pushed' },
    });
    deps.issues.seedComment(PR_ID, {
      commentId: 'c-rp-1b',
      body: 'pushed (round 1, duplicate).',
      structural: { role: 'build@opus-4-7', run: 'run-rp-1b', verdict: 'revision-pushed' },
    });
    deps.issues.seedComment(PR_ID, {
      commentId: 'c-rc-2',
      body: 'Findings round 2: still missing the error path.',
      structural: { role: 'review@opus-4-7', run: 'run-2', verdict: 'request-changes' },
    });
    let coded = false;
    const realDeps = {
      ...deps,
      clone: (async () => ({ ok: true as const, value: { workdir: '/tmp/x' } })) as CloneFn,
      runCodingAgent: async () => {
        coded = true;
        return { ok: true, subtype: 'success', summary: 'fixed round 2', numTurns: 2, costUsd: 0 };
      },
      workdir: '/tmp/x',
    };
    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The newest findings ARE addressed: the coding agent ran and a revision pushed.
    expect(coded).toBe(true);
    expect(realDeps.git.pushHistory()).toHaveLength(1);
    expect(result.result).not.toContain('resumed drive');
  });

  test('issue #190 (codex #194): post-push resume-marker comment failure does NOT strand the PR — still drives to in_review', async () => {
    const deps = makeRevisionDeps(1);
    // Fail ONLY the revision-pushed resume marker; all other comments succeed.
    const realComment = deps.issues.comment.bind(deps.issues);
    deps.issues.comment = async (args) => {
      if (args.structural?.verdict === 'revision-pushed') {
        return { ok: false as const, reason: 'comment_api_503' };
      }
      return realComment(args);
    };
    const realDeps = {
      ...deps,
      clone: (async () => ({ ok: true as const, value: { workdir: '/tmp/x' } })) as CloneFn,
      runCodingAgent: async () => ({
        ok: true,
        subtype: 'success',
        summary: 'revised',
        numTurns: 2,
        costUsd: 0,
      }),
      workdir: '/tmp/x',
    };
    const result = await runBuildAgent(makeRevisionMessage(), realDeps);

    // The push succeeded, so a marker failure must NOT deadletter — the PR is driven.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('drove PR changes_requested→in_review');
    expect(result.result).toContain('resume-marker write failed');
    expect(realDeps.issues.labelApplyHistory()).toEqual([
      { recordId: PR_ID, label: 'status:in_review' },
    ]);
  });

  test('issue #190 resume marker is NOT counted toward the request-changes budget', async () => {
    // 3 request-changes rounds (at the MAX_REVISION_ATTEMPTS=3 cap) plus 3
    // revision-pushed markers. If markers were miscounted as rounds the total
    // would be 6 > 3 and PARK; the marker must be inert for the budget. With
    // markers >= rounds the resume guard fires → drive resumed, NOT parked.
    const deps = makeRevisionDeps(3, { revisionPushedMarkers: 3 });
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Resumed at round 3/3, NOT budget-exhausted (markers did not inflate rounds).
    expect(result.result).toContain('round 3/3');
    expect(result.result).toContain('resumed drive');
    const parked = deps.issues.commentHistory().filter((c) => c.body.includes('budget exhausted'));
    expect(parked).toHaveLength(0);
    expect(deps.git.commitHistory()).toHaveLength(0);
    expect(deps.git.pushHistory()).toHaveLength(0);
  });

  test('issue #190 first delivery (no resume marker) still builds normally and posts the resume marker before the drive', async () => {
    // No revision-pushed marker yet (markers 0 < rounds 1) → the resume guard does
    // NOT fire; the revision builds, posts a revision-pushed marker, THEN drives.
    const deps = makeRevisionDeps(1);
    const result = await runBuildAgent(makeRevisionMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('round 1/3');
    expect(result.result).toContain('drove PR changes_requested→in_review');
    expect(deps.git.commitHistory()).toHaveLength(1);
    expect(deps.git.pushHistory()).toEqual([{ branch: HEAD_BRANCH }]);
    // Two structural comments in order: the revision-pushed resume marker FIRST
    // (before the drive), then the drive marker.
    const written = deps.issues.commentHistory();
    expect(written).toHaveLength(2);
    expect(written[0]?.structural).toMatchObject({
      role: 'build@opus-4-7',
      verdict: 'revision-pushed',
    });
    expect(written[0]?.body).toContain('pushed a revision for request-changes round 1');
    expect(written[1]?.structural).toMatchObject({ role: 'build@opus-4-7' });
    expect(written[1]?.structural?.verdict).toBeUndefined();
    expect(written[1]?.body).toContain('returning this PR to in_review');
  });
});
