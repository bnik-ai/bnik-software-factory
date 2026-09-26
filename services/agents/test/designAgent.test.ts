import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { runDesignAgent } from '../src/agents/designAgent.js';
import { StubIssueTool } from '../src/tools/issueTool.js';
import type { ParsedTransitionMessage } from '../src/types.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.labeled',
    kind: 'spec',
    actor: 'ReviewAgent',
    recordType: 'Issue',
    recordKind: 'Spec',
    recordId: 'I_kwAOA_spec_88',
    fromState: 'ready_for_review',
    toState: 'ratified',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

function makeDeps(seedBody: string) {
  const issues = new StubIssueTool();
  issues.seedRecord({
    recordId: 'I_kwAOA_spec_88',
    labels: ['kind:spec', 'status:ratified'],
    body: seedBody,
  });
  return {
    issues,
    runId: '01HZXYZ123456789ABCDEFGHJK',
    repo: 'example-org/software-factory',
  };
}

describe('runDesignAgent — happy path on spec:ready_for_review→ratified', () => {
  test('reads spec, creates Design with kind:design + structural attribution', async () => {
    const deps = makeDeps(
      'parent-goal: I_kwAOA_goal_42\n\nDeploy sample-app as Azure API\n\nspec body',
    );
    const result = await runDesignAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const creates = deps.issues.createHistory();
    expect(creates).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const create = creates[0]!;
    expect(create.repo).toBe('example-org/software-factory');
    expect(create.title).toBe('Design: Deploy sample-app as Azure API');
    expect(create.labels).toEqual(['kind:design']);
    expect(create.structural?.role).toBe('DesignAgent');
  });

  test('design body forwards parent-goal AND adds spec-ref to the Spec being realized', async () => {
    const deps = makeDeps('parent-goal: I_kwAOA_goal_42\n\nSome spec');
    await runDesignAgent(makeMessage(), deps);

    // biome-ignore lint/style/noNonNullAssertion: create order is fixed by the agent.
    const create = deps.issues.createHistory()[0]!;
    expect(create.body).toMatch(/^parent-goal: I_kwAOA_goal_42/m);
    expect(create.body).toMatch(/^spec-ref: I_kwAOA_spec_88/m);
  });

  test('spec body missing parent-goal → sentinel string preserved (not silent drop)', async () => {
    const deps = makeDeps('no parent-goal field\n\nSome spec content');
    await runDesignAgent(makeMessage(), deps);

    // biome-ignore lint/style/noNonNullAssertion: create order is fixed.
    const create = deps.issues.createHistory()[0]!;
    expect(create.body).toContain('parent-goal: (unknown — Spec body missing parent-goal field)');
  });

  test('posts structural comment on the Spec naming the new Design', async () => {
    const deps = makeDeps('parent-goal: I_kwAOA_goal_42\n\nSome spec');
    await runDesignAgent(makeMessage(), deps);

    // The first comment is the link note on the Spec; a second marker
    // comment lands on the new Design during auto-advance.
    const linkComment = deps.issues.commentHistory().find((c) => c.recordId === 'I_kwAOA_spec_88');
    expect(linkComment).toBeDefined();
    expect(linkComment?.body).toContain('DesignAgent created Design');
    expect(linkComment?.structural?.role).toBe('DesignAgent');
  });

  test('auto-advances the created Design to ready_for_review with a structural marker', async () => {
    const deps = makeDeps('parent-goal: I_kwAOA_goal_42\n\nSome spec');
    const result = await runDesignAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const applies = deps.issues.labelApplyHistory();
    expect(applies).toHaveLength(1);
    expect(applies[0]?.label).toBe('status:ready_for_review');
    // Applied on the new Design, not the parent Spec.
    expect(applies[0]?.recordId).not.toBe('I_kwAOA_spec_88');

    const markerComment = deps.issues
      .commentHistory()
      .find((c) => c.recordId === applies[0]?.recordId);
    expect(markerComment).toBeDefined();
    expect(markerComment?.structural?.role).toBe('DesignAgent');
    expect(markerComment?.structural?.run).toBe('01HZXYZ123456789ABCDEFGHJK');
    expect(markerComment?.body).toContain('ready_for_review');

    expect(result.result).toContain('advanced to ready_for_review');
  });

  test('summary extraction skips parent-goal line and markdown headers', async () => {
    const deps = makeDeps(
      'parent-goal: I_x\n\n## Summary\n\nReal human-readable title\n\n## Content\n…',
    );
    await runDesignAgent(makeMessage(), deps);

    // biome-ignore lint/style/noNonNullAssertion: create order is fixed.
    const create = deps.issues.createHistory()[0]!;
    expect(create.title).toBe('Design: Real human-readable title');
  });
});

describe('runDesignAgent — defensive guards', () => {
  test('non-spec kind → typed wrong_transition failure (no I/O)', async () => {
    const deps = makeDeps('x');
    const result = await runDesignAgent(makeMessage({ kind: 'goal' }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^design_agent_wrong_transition:goal:/);
    expect(deps.issues.createHistory()).toHaveLength(0);
  });

  test('spec but toState !== ratified → typed wrong_transition failure', async () => {
    const deps = makeDeps('x');
    const result = await runDesignAgent(makeMessage({ toState: 'drafting' }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^design_agent_wrong_transition:spec:ready_for_review→drafting$/);
  });

  test('spec read failure surfaces as typed failure', async () => {
    const issues = new StubIssueTool();
    const deps = {
      issues,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
    };
    const result = await runDesignAgent(makeMessage(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^design_agent_spec_read_failed:record_not_found:/);
    expect(issues.createHistory()).toHaveLength(0);
  });
});

describe('runDesignAgent — real content brain (M1c env-gated path)', () => {
  test('calls generateContent then issues.create with the model-authored body', async () => {
    const deps = makeDeps('parent-goal: I_kwAOA_goal_42\n\nDeploy sample-app\n\nbody');
    const calls: Array<{ system?: string; prompt: string }> = [];
    const generateContent = async (req: { system?: string; prompt: string }) => {
      calls.push(req);
      return {
        ok: true as const,
        text: '## Infra delta\n- none\n\n## Service delta\n- add healthz',
      };
    };

    const result = await runDesignAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toMatch(/design author/i);
    expect(calls[0]?.prompt).toContain('Deploy sample-app');

    // biome-ignore lint/style/noNonNullAssertion: create occurred (result ok).
    const create = deps.issues.createHistory()[0]!;
    expect(create.body).toContain('## Service delta');
    // Linkage fields prepended so the validator can join Design→Spec→Goal.
    expect(create.body).toMatch(/^parent-goal: I_kwAOA_goal_42/m);
    expect(create.body).toMatch(/^spec-ref: I_kwAOA_spec_88/m);
    expect(create.labels).toEqual(['kind:design']);
  });

  test('content failure → typed design_agent_content_failed; no issue created', async () => {
    const deps = makeDeps('parent-goal: I_x\n\nA spec');
    const generateContent = async () => ({ ok: false as const, text: '' });

    const result = await runDesignAgent(makeMessage(), { ...deps, generateContent });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('design_agent_content_failed:empty');
    expect(deps.issues.createHistory()).toHaveLength(0);
  });
});
