import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { AGENT_REGISTRY, runAgent } from '../src/agentRegistry.js';
import type { AgentRole, ParsedTransitionMessage } from '../src/types.js';

function makeMessage(): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.labeled',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA',
    fromState: 'proposed',
    toState: 'accepted',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
  };
}

describe('AGENT_REGISTRY — all seven L3 roles registered', () => {
  const roles: AgentRole[] = [
    'SpecAgent',
    'DesignAgent',
    'PlannerAgent',
    'BuildAgent',
    'ReviewAgent',
    'OpsAgent',
    'SREAgent',
  ];
  for (const role of roles) {
    test(`${role} has a handler in the registry`, () => {
      expect(AGENT_REGISTRY.has(role)).toBe(true);
    });
  }
  test('registry size is exactly 7', () => {
    expect(AGENT_REGISTRY.size).toBe(7);
  });
});

describe('runAgent — stub handlers return tagged success', () => {
  test.each([
    'SpecAgent',
    'DesignAgent',
    'PlannerAgent',
    'BuildAgent',
    'ReviewAgent',
    'OpsAgent',
    'SREAgent',
  ] as const)('%s returns { ok: true, result: "<role>: stub" }', async (role) => {
    const result = await runAgent(role, makeMessage());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toBe(`${role}: stub`);
  });
});

describe('runAgent — unknown role typed failure', () => {
  test('returns { ok: false, reason } instead of throwing', async () => {
    const result = await runAgent('NotARole' as AgentRole, makeMessage());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_agent_role:NotARole');
  });
});

describe('buildAgentRegistry — bound handlers for real agents', () => {
  test('SpecAgent slot is the real handler bound to deps (not a stub)', async () => {
    const { buildAgentRegistry } = await import('../src/agentRegistry.js');
    const { StubIssueTool } = await import('../src/tools/issueTool.js');
    const { StubGitTool } = await import('../src/tools/gitTool.js');
    const { StubPullTool } = await import('../src/tools/pullTool.js');

    const issues = new StubIssueTool();
    issues.seedRecord({
      recordId: 'I_kwAOA',
      labels: ['kind:goal', 'status:accepted'],
      body: 'Some accepted goal',
    });
    const { StubPlannerSubstrateClient } = await import('../src/tools/plannerSubstrateClient.js');
    const registry = buildAgentRegistry({
      issues,
      git: new StubGitTool(),
      pulls: new StubPullTool(),
      plannerSubstrate: new StubPlannerSubstrateClient(),
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    });
    const result = await runAgent('SpecAgent', makeMessage(), registry);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Real SpecAgent prefixes with "SpecAgent: created Spec"; stub returns "SpecAgent: stub".
    expect(result.result).toMatch(/^SpecAgent: created Spec/);
    expect(issues.createHistory()).toHaveLength(1);
  });

  test('DesignAgent slot is the real handler bound to deps', async () => {
    const { buildAgentRegistry } = await import('../src/agentRegistry.js');
    const { StubIssueTool } = await import('../src/tools/issueTool.js');
    const { StubGitTool } = await import('../src/tools/gitTool.js');
    const { StubPullTool } = await import('../src/tools/pullTool.js');

    const issues = new StubIssueTool();
    issues.seedRecord({
      recordId: 'I_kwAOA_spec',
      labels: ['kind:spec', 'status:ratified'],
      body: 'parent-goal: I_kwAOA_goal\n\nSome ratified spec',
    });
    const { StubPlannerSubstrateClient } = await import('../src/tools/plannerSubstrateClient.js');
    const registry = buildAgentRegistry({
      issues,
      git: new StubGitTool(),
      pulls: new StubPullTool(),
      plannerSubstrate: new StubPlannerSubstrateClient(),
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    });
    const message = makeMessage();
    // Override to a spec:ready_for_review→ratified transition
    const designMessage = {
      ...message,
      kind: 'spec' as const,
      recordKind: 'Spec',
      recordId: 'I_kwAOA_spec',
      fromState: 'ready_for_review',
      toState: 'ratified',
    };
    const result = await runAgent('DesignAgent', designMessage, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^DesignAgent: created Design/);
    expect(issues.createHistory()).toHaveLength(1);
  });

  test('BuildAgent slot is the real handler bound to deps', async () => {
    const { buildAgentRegistry } = await import('../src/agentRegistry.js');
    const { StubIssueTool } = await import('../src/tools/issueTool.js');
    const { StubGitTool } = await import('../src/tools/gitTool.js');
    const { StubPullTool } = await import('../src/tools/pullTool.js');

    const issues = new StubIssueTool();
    issues.seedRecord({
      recordId: 'I_kwAOA_task_99',
      labels: ['kind:task', 'status:ready'],
      body: 'parent-goal: I_kwAOA_goal\ndesign-ref: I_kwAOA_design\n\nImplement webhook endpoint',
    });
    const git = new StubGitTool();
    const pulls = new StubPullTool();
    const { StubPlannerSubstrateClient } = await import('../src/tools/plannerSubstrateClient.js');
    const registry = buildAgentRegistry({
      issues,
      git,
      pulls,
      plannerSubstrate: new StubPlannerSubstrateClient(),
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    });
    const message = makeMessage();
    const buildMessage = {
      ...message,
      kind: 'task' as const,
      recordKind: 'Task',
      recordId: 'I_kwAOA_task_99',
      fromState: 'proposed',
      toState: 'ready',
    };
    const result = await runAgent('BuildAgent', buildMessage, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^BuildAgent: opened draft PR/);
    expect(git.branchHistory()).toHaveLength(1);
    expect(git.commitHistory()).toHaveLength(1);
    expect(git.pushHistory()).toHaveLength(1);
    expect(pulls.openHistory()).toHaveLength(1);
  });

  test('OpsAgent slot is the real handler bound to deps', async () => {
    const { buildAgentRegistry } = await import('../src/agentRegistry.js');
    const { StubIssueTool } = await import('../src/tools/issueTool.js');
    const { StubGitTool } = await import('../src/tools/gitTool.js');
    const { StubPullTool } = await import('../src/tools/pullTool.js');

    const pulls = new StubPullTool();
    const { StubPlannerSubstrateClient } = await import('../src/tools/plannerSubstrateClient.js');
    const registry = buildAgentRegistry({
      issues: new StubIssueTool(),
      git: new StubGitTool(),
      pulls,
      plannerSubstrate: new StubPlannerSubstrateClient(),
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    });
    const opsMessage = {
      ...makeMessage(),
      kind: 'pr' as const,
      recordKind: 'PR',
      recordId: 'PR_kwAOA_77',
      fromState: 'in_review',
      toState: 'approved',
    };
    const result = await runAgent('OpsAgent', opsMessage, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^OpsAgent: merged PR PR_kwAOA_77/);
    expect(pulls.mergeHistory()).toHaveLength(1);
  });

  test('SREAgent slot is the real handler bound to deps', async () => {
    const { buildAgentRegistry } = await import('../src/agentRegistry.js');
    const { StubIssueTool } = await import('../src/tools/issueTool.js');
    const { StubGitTool } = await import('../src/tools/gitTool.js');
    const { StubPullTool } = await import('../src/tools/pullTool.js');

    const { StubPlannerSubstrateClient } = await import('../src/tools/plannerSubstrateClient.js');
    const registry = buildAgentRegistry({
      issues: new StubIssueTool(),
      git: new StubGitTool(),
      pulls: new StubPullTool(),
      plannerSubstrate: new StubPlannerSubstrateClient(),
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    });
    const sreMessage = {
      ...makeMessage(),
      kind: 'deployment' as const,
      recordKind: 'Deployment',
      recordId: 'DEP_kwAOA_55',
      fromState: 'in_progress',
      toState: 'failure',
    };
    const result = await runAgent('SREAgent', sreMessage, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('observed deployment failure on DEP_kwAOA_55');
  });

  test('ReviewAgent slot is the real handler bound to deps', async () => {
    const { buildAgentRegistry } = await import('../src/agentRegistry.js');
    const { StubIssueTool } = await import('../src/tools/issueTool.js');
    const { StubGitTool } = await import('../src/tools/gitTool.js');
    const { StubPullTool } = await import('../src/tools/pullTool.js');

    const pulls = new StubPullTool();
    pulls.seedRecord({
      recordId: 'PR_kwAOA_77',
      number: 77,
      state: 'open',
      headBranch: 'sf/T-99/01HV6/build@opus-4-7',
      baseBranch: 'main',
    });
    const { StubPlannerSubstrateClient } = await import('../src/tools/plannerSubstrateClient.js');
    // Verdict runs on a PR at status:in_review (the verdict idempotency guard
    // reads the live label and fails closed if unreadable).
    const reviewIssues = new StubIssueTool();
    reviewIssues.seedRecord({ recordId: 'PR_kwAOA_77', labels: ['status:in_review'], body: '' });
    const registry = buildAgentRegistry({
      issues: reviewIssues,
      git: new StubGitTool(),
      pulls,
      plannerSubstrate: new StubPlannerSubstrateClient(),
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    });
    const reviewMessage = {
      ...makeMessage(),
      kind: 'pr' as const,
      recordKind: 'PR',
      recordId: 'PR_kwAOA_77',
      fromState: 'open',
      toState: 'in_review',
    };
    const result = await runAgent('ReviewAgent', reviewMessage, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Structural review: the handler drives the FSM via status
    // labels + a findings comment, NOT the 422-blocked native review API.
    expect(result.result).toMatch(
      /^ReviewAgent: emitted v0 placeholder approved structural review on PR/,
    );
    expect(pulls.reviewHistory()).toHaveLength(0);
  });

  test('PlannerAgent slot is the real handler bound to deps (ADR 0013)', async () => {
    const { buildAgentRegistry } = await import('../src/agentRegistry.js');
    const { StubIssueTool } = await import('../src/tools/issueTool.js');
    const { StubGitTool } = await import('../src/tools/gitTool.js');
    const { StubPullTool } = await import('../src/tools/pullTool.js');
    const { StubPlannerSubstrateClient } = await import('../src/tools/plannerSubstrateClient.js');

    const substrate = new StubPlannerSubstrateClient();
    substrate.seedTask({
      recordId: 'I_kwAOA_task_p1',
      state: 'proposed',
      priority: 'P1',
      blockedBy: [],
      createdAt: '2026-05-30T10:00:00Z',
    });
    const registry = buildAgentRegistry({
      issues: new StubIssueTool(),
      git: new StubGitTool(),
      pulls: new StubPullTool(),
      plannerSubstrate: substrate,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      model: 'opus-4-7',
    });
    // Use one of the dep-clear triggers as the re-plan event.
    const plannerMessage = {
      ...makeMessage(),
      kind: 'task' as const,
      recordKind: 'Task',
      recordId: 'I_kwAOA_task_done_99',
      fromState: 'in_review',
      toState: 'done',
    };
    const result = await runAgent('PlannerAgent', plannerMessage, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Real PlannerAgent prefixes with "PlannerAgent: trigger="; stub returned "PlannerAgent: stub".
    expect(result.result).toMatch(/^PlannerAgent: trigger=task:in_review→done /);
    expect(substrate.transitionHistory()).toHaveLength(1);
    expect(substrate.transitionHistory()[0]?.taskId).toBe('I_kwAOA_task_p1');
    expect(substrate.transitionHistory()[0]?.toState).toBe('ready');
    expect(substrate.transitionHistory()[0]?.actor).toBe('PlannerAgent');
  });
});
