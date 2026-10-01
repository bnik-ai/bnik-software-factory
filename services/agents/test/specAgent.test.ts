import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { runSpecAgent } from '../src/agents/specAgent.js';
import { StubIssueTool } from '../src/tools/issueTool.js';
import type { ParsedTransitionMessage } from '../src/types.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.labeled',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA_goal_42',
    fromState: 'proposed',
    toState: 'accepted',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

function makeDeps(seedBody: string) {
  const issues = new StubIssueTool();
  issues.seedRecord({
    recordId: 'I_kwAOA_goal_42',
    labels: ['kind:goal', 'status:accepted'],
    body: seedBody,
  });
  return {
    issues,
    runId: '01HZXYZ123456789ABCDEFGHJK',
    repo: 'example-org/software-factory',
  };
}

describe('runSpecAgent — happy path on goal:proposed→accepted', () => {
  test('reads goal, creates one Spec issue with kind:spec label + structural attribution', async () => {
    const deps = makeDeps('Deploy sample-app as Azure-hosted API\n\nMore detail here.');
    const result = await runSpecAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const creates = deps.issues.createHistory();
    expect(creates).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const create = creates[0]!;
    expect(create.repo).toBe('example-org/software-factory');
    expect(create.title).toBe('Spec: Deploy sample-app as Azure-hosted API');
    expect(create.labels).toEqual(['kind:spec']);
    expect(create.structural?.role).toBe('SpecAgent');
    expect(create.structural?.run).toBe('01HZXYZ123456789ABCDEFGHJK');
  });

  test('spec body carries parent-goal field per ADR 0003 + ADR 0007', async () => {
    const deps = makeDeps('Goal title here\n\nbody body body');
    await runSpecAgent(makeMessage(), deps);

    // biome-ignore lint/style/noNonNullAssertion: create order is fixed by the agent.
    const create = deps.issues.createHistory()[0]!;
    expect(create.body).toMatch(/^parent-goal: I_kwAOA_goal_42/m);
    expect(create.body).toContain('Decomposed from parent Goal: Goal title here');
  });

  test('posts a structural comment on the Goal naming the new Spec', async () => {
    const deps = makeDeps('Goal title here');
    await runSpecAgent(makeMessage(), deps);

    // The link comment lands on the Goal; a second marker comment lands on
    // the new Spec during auto-advance (asserted separately).
    const comment = deps.issues.commentHistory().find((c) => c.recordId === 'I_kwAOA_goal_42');
    expect(comment).toBeDefined();
    expect(comment?.body).toContain('SpecAgent created Spec');
    expect(comment?.structural?.role).toBe('SpecAgent');
    expect(comment?.structural?.run).toBe('01HZXYZ123456789ABCDEFGHJK');
  });

  test('auto-advances the created Spec to ready_for_review with a structural marker', async () => {
    const deps = makeDeps('Some goal');
    const result = await runSpecAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The created Spec's recordId — the auto-advance target.
    const created = deps.issues.createHistory()[0];
    expect(created).toBeDefined();
    const specRecordId = deps.issues
      .labelApplyHistory()
      .find((apply) => apply.label === 'status:ready_for_review')?.recordId;
    expect(specRecordId).toBeDefined();

    // applyLabel applied status:ready_for_review on the Spec (not the Goal).
    const applies = deps.issues.labelApplyHistory();
    expect(applies).toHaveLength(1);
    expect(applies[0]?.label).toBe('status:ready_for_review');
    expect(applies[0]?.recordId).not.toBe('I_kwAOA_goal_42');

    // A structural marker comment on the Spec attributes the transition to
    // SpecAgent (so the validator's actor-resolution doesn't flag it).
    const markerComment = deps.issues
      .commentHistory()
      .find((c) => c.recordId === applies[0]?.recordId);
    expect(markerComment).toBeDefined();
    expect(markerComment?.structural?.role).toBe('SpecAgent');
    expect(markerComment?.structural?.run).toBe('01HZXYZ123456789ABCDEFGHJK');
    expect(markerComment?.body).toContain('ready_for_review');

    expect(result.result).toContain('advanced to ready_for_review');
  });

  test('result envelope names both the Spec and Goal records', async () => {
    const deps = makeDeps('Some goal');
    const result = await runSpecAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^SpecAgent: created Spec I_stub_/);
    expect(result.result).toContain('linked to Goal I_kwAOA_goal_42');
  });

  test('empty goal body → spec title falls back to "(empty goal body)" placeholder', async () => {
    const deps = makeDeps('');
    const result = await runSpecAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: result is ok ⇒ create occurred.
    const create = deps.issues.createHistory()[0]!;
    expect(create.title).toBe('Spec: (empty goal body)');
  });
});

describe('runSpecAgent — defensive guards', () => {
  test('non-goal kind → typed wrong_transition failure (no I/O)', async () => {
    const deps = makeDeps('x');
    const result = await runSpecAgent(makeMessage({ kind: 'spec' }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^spec_agent_wrong_transition:spec:/);
    expect(deps.issues.createHistory()).toHaveLength(0);
    expect(deps.issues.commentHistory()).toHaveLength(0);
  });

  test('goal but toState !== accepted → typed wrong_transition failure', async () => {
    const deps = makeDeps('x');
    const result = await runSpecAgent(makeMessage({ toState: 'in_progress' }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^spec_agent_wrong_transition:goal:proposed→in_progress$/);
  });

  test('applyLabel failure on auto-advance → typed spec_agent_ready_for_review_failed', async () => {
    const deps = makeDeps('A goal');
    // Wrap the stub so applyLabel fails; create/read/comment still succeed.
    const failingIssues = {
      ...deps.issues,
      read: deps.issues.read.bind(deps.issues),
      create: deps.issues.create.bind(deps.issues),
      comment: deps.issues.comment.bind(deps.issues),
      removeLabel: deps.issues.removeLabel.bind(deps.issues),
      close: deps.issues.close.bind(deps.issues),
      appendToBody: deps.issues.appendToBody.bind(deps.issues),
      listComments: deps.issues.listComments.bind(deps.issues),
      applyLabel: async () => ({ ok: false as const, reason: 'apply_label_failed:403' }),
    };
    const result = await runSpecAgent(makeMessage(), { ...deps, issues: failingIssues });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      'spec_agent_ready_for_review_failed:apply_label:apply_label_failed:403',
    );
  });

  test('goal read failure surfaces as typed failure (no further tool calls)', async () => {
    const issues = new StubIssueTool();
    // No seedRecord — read will return record_not_found.
    const deps = {
      issues,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
    };
    const result = await runSpecAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^spec_agent_goal_read_failed:record_not_found:/);
    expect(issues.createHistory()).toHaveLength(0);
  });
});

describe('runSpecAgent — real content brain (env-gated path)', () => {
  test('calls generateContent then issues.create with the model-authored body', async () => {
    const deps = makeDeps('Add a /healthz endpoint\n\ndetail');
    const calls: Array<{ system?: string; prompt: string }> = [];
    const generateContent = async (req: { system?: string; prompt: string }) => {
      calls.push(req);
      return { ok: true as const, text: '## Acceptance criteria\n- [ ] returns 200' };
    };

    const result = await runSpecAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(true);
    // generateContent ran before create, with the Goal body in the prompt.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toMatch(/spec author/i);
    expect(calls[0]?.prompt).toContain('Add a /healthz endpoint');

    // biome-ignore lint/style/noNonNullAssertion: create occurred (result ok).
    const create = deps.issues.createHistory()[0]!;
    expect(create.body).toContain('## Acceptance criteria');
    // Linkage field is still prepended so the validator can join Spec→Goal.
    expect(create.body).toMatch(/^parent-goal: I_kwAOA_goal_42/m);
    expect(create.labels).toEqual(['kind:spec']);
  });

  test('content failure → typed spec_agent_content_failed; no issue created', async () => {
    const deps = makeDeps('A goal');
    const generateContent = async () => ({
      ok: false as const,
      text: '',
      stopReason: 'max_tokens',
    });

    const result = await runSpecAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('spec_agent_content_failed:max_tokens');
    expect(deps.issues.createHistory()).toHaveLength(0);
  });
});
