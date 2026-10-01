// Spec: docs/decisions/0013-planner-agent.md §Decision items 1, 3, 4 +
// runPlannerAgent handler invariants.
// Coverage:
//   - Empty backlog → ok, promoted=0, no transitionTask calls.
//   - All-blocked backlog → ok, promoted=0, blocked count = backlog size,
//     no transitionTask calls.
//   - Mixed backlog: cleared Tasks promote, blocked Tasks don't.
//   - Ordering: cleared Tasks promote in priority → committed_* → target_*
//     → createdAt order.
//   - Abandoned blockers clear deps (ADR 0013 §4 "any →abandoned").
//   - Blocker record_not_found leaves the Task in proposed with a typed
//     surface in the result (substrate-shape problem the human owns).
//   - PROMOTE triggers: every key EXCEPT design:ratified (2 intake + 5
//     dep-clear) dispatches the same backlog scan.
//   - DECOMPOSE trigger (design:ready_for_review→ratified): reads
//     the ratified Design + fans out kind:task Issues with parent/spec/design
//     links; brain path (N Tasks + intra-Design blocked-by), no-brain stub
//     fallback (1 Task), typed failures (no-issues-tool / parse / content /
//     read / partial-failure). Unblocked ROOTS are promoted proposed→ready
//     IN the decompose run against the created recordIds (App-authored Tasks
//     get no orchestrator promote-dispatch); blocked Tasks stay proposed. A
//     failed BLOCKER create skips its dependents (not materialized without
//     the dependency) and surfaces a typed partial-failure.
//   - Mis-routed transition → planner_agent_wrong_transition, NO
//     substrate writes.

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  type GenerateContentFn,
  compareForPromotion,
  runPlannerAgent,
} from '../src/agents/plannerAgent.js';
import type { ContentResult } from '../src/runtime/contentAgent.js';
import { StubIssueTool } from '../src/tools/issueTool.js';
import {
  type PlannerTaskMetadata,
  StubPlannerSubstrateClient,
} from '../src/tools/plannerSubstrateClient.js';
import type { ParsedTransitionMessage } from '../src/types.js';

// Fake content brain returning a fixed JSON Task array — exercises the
// decompose path without the real Anthropic client (CI has no API key).
function fakeBrain(jsonResponse: string, ok = true): GenerateContentFn {
  return async (): Promise<ContentResult> => ({ ok, text: ok ? jsonResponse : '' });
}

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.labeled',
    kind: 'task',
    actor: 'OpsAgent',
    recordType: 'Issue',
    recordKind: 'Task',
    recordId: 'I_kwAOA_task_done',
    fromState: 'in_review',
    toState: 'done',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

function makeDeps() {
  return {
    substrate: new StubPlannerSubstrateClient(),
    runId: '01HZXYZ123456789ABCDEFGHJK',
    repo: 'example-org/software-factory',
  };
}

describe('runPlannerAgent — empty backlog', () => {
  test('empty backlog: ok, promoted=0, zero substrate writes', async () => {
    const deps = makeDeps();
    const result = await runPlannerAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^PlannerAgent: backlog empty/);
    expect(result.result).toContain('trigger=task:in_review→done');
    expect(result.result).toContain('promoted=0');
    expect(deps.substrate.transitionHistory()).toHaveLength(0);
  });
});

describe('runPlannerAgent — all-blocked backlog (no promotions this round)', () => {
  test('every backlog Task has an in_progress blocker → promoted=0, blocked=2, no writes', async () => {
    const deps = makeDeps();
    deps.substrate.seedTask({
      recordId: 'I_blocker',
      state: 'in_progress',
      blockedBy: [],
      createdAt: '2026-05-29T08:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_t1',
      state: 'proposed',
      priority: 'P1',
      blockedBy: ['I_blocker'],
      createdAt: '2026-05-30T08:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_t2',
      state: 'proposed',
      priority: 'P0',
      blockedBy: ['I_blocker'],
      createdAt: '2026-05-30T09:00:00Z',
    });

    const result = await runPlannerAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('backlog=2');
    expect(result.result).toContain('promoted=0');
    expect(result.result).toContain('blocked=2');
    expect(deps.substrate.transitionHistory()).toHaveLength(0);
  });
});

describe('runPlannerAgent — cleared deps promote, blocked deps do not', () => {
  test('mixed: 2 of 3 backlog Tasks have deps cleared → promote those 2 in priority order', async () => {
    const deps = makeDeps();
    deps.substrate.seedTask({
      recordId: 'I_blocker_done',
      state: 'done',
      blockedBy: [],
      createdAt: '2026-05-29T08:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_blocker_active',
      state: 'in_progress',
      blockedBy: [],
      createdAt: '2026-05-29T09:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_t_cleared_p1',
      state: 'proposed',
      priority: 'P1',
      blockedBy: ['I_blocker_done'],
      createdAt: '2026-05-30T10:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_t_blocked',
      state: 'proposed',
      priority: 'P0',
      blockedBy: ['I_blocker_active'],
      createdAt: '2026-05-30T10:15:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_t_cleared_p0',
      state: 'proposed',
      priority: 'P0',
      blockedBy: [],
      createdAt: '2026-05-30T11:00:00Z',
    });

    const result = await runPlannerAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('backlog=3');
    expect(result.result).toContain('promoted=2');
    expect(result.result).toContain('blocked=1');

    const history = deps.substrate.transitionHistory();
    expect(history).toHaveLength(2);
    // P0 promoted before P1 (ordering invariant).
    expect(history[0]?.taskId).toBe('I_t_cleared_p0');
    expect(history[0]?.fromState).toBe('proposed');
    expect(history[0]?.toState).toBe('ready');
    expect(history[0]?.actor).toBe('PlannerAgent');
    expect(history[1]?.taskId).toBe('I_t_cleared_p1');
    expect(history[1]?.toState).toBe('ready');
  });
});

describe('runPlannerAgent — ordering by priority / committed_* / target_* / createdAt', () => {
  test('cleared Tasks promote in full ordering chain (priority dominates, then committed, then target, then createdAt)', async () => {
    const deps = makeDeps();
    // All cleared (no blockers). Cover every comparator:
    //  - p3_old: P3 priority, oldest createdAt (sorts last by priority).
    //  - p2_committed: P2, has committed_start_at (mid-priority, but
    //    committed bunches it before p2_target).
    //  - p2_target: P2, has target_start_at only.
    //  - p2_unset: P2, no committed/target (sorts after p2_target).
    //  - p1_recent: P1 priority (sorts second after p0).
    //  - p0_first: P0 priority (sorts first).
    deps.substrate.seedTask({
      recordId: 'I_p3_old',
      state: 'proposed',
      priority: 'P3',
      blockedBy: [],
      createdAt: '2026-05-01T00:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_p2_committed',
      state: 'proposed',
      priority: 'P2',
      committedStartAt: '2026-06-01T00:00:00Z',
      blockedBy: [],
      createdAt: '2026-05-30T11:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_p2_target',
      state: 'proposed',
      priority: 'P2',
      targetStartAt: '2026-06-02T00:00:00Z',
      blockedBy: [],
      createdAt: '2026-05-30T12:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_p2_unset',
      state: 'proposed',
      priority: 'P2',
      blockedBy: [],
      createdAt: '2026-05-30T10:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_p1_recent',
      state: 'proposed',
      priority: 'P1',
      blockedBy: [],
      createdAt: '2026-05-30T14:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_p0_first',
      state: 'proposed',
      priority: 'P0',
      blockedBy: [],
      createdAt: '2026-05-30T15:00:00Z',
    });

    const result = await runPlannerAgent(makeMessage(), deps);
    expect(result.ok).toBe(true);

    const order = deps.substrate.transitionHistory().map((t) => t.taskId);
    expect(order).toEqual([
      'I_p0_first',
      'I_p1_recent',
      'I_p2_committed', // committed bunched before others at P2
      'I_p2_target', // target bunched before unset at P2
      'I_p2_unset',
      'I_p3_old',
    ]);
  });

  test('compareForPromotion — unit-level tiebreaker chain', () => {
    const base: PlannerTaskMetadata = {
      recordId: 'I_base',
      state: 'proposed',
      blockedBy: [],
      createdAt: '2026-05-30T10:00:00Z',
    };
    // Priority dominates createdAt.
    expect(
      compareForPromotion(
        { ...base, recordId: 'a', priority: 'P0' },
        { ...base, recordId: 'b', priority: 'P1', createdAt: '2026-01-01T00:00:00Z' },
      ),
    ).toBeLessThan(0);
    // Unset priority sorts AFTER P3.
    expect(
      compareForPromotion({ ...base, recordId: 'a' }, { ...base, recordId: 'b', priority: 'P3' }),
    ).toBeGreaterThan(0);
    // Equal priority + committed defined vs undefined → defined comes first.
    expect(
      compareForPromotion(
        { ...base, recordId: 'a', priority: 'P1' },
        {
          ...base,
          recordId: 'b',
          priority: 'P1',
          committedStartAt: '2026-06-01T00:00:00Z',
        },
      ),
    ).toBeGreaterThan(0);
    // Equal everything → createdAt FIFO tiebreaker.
    expect(
      compareForPromotion(
        { ...base, recordId: 'a', priority: 'P1', createdAt: '2026-05-30T09:00:00Z' },
        { ...base, recordId: 'b', priority: 'P1', createdAt: '2026-05-30T10:00:00Z' },
      ),
    ).toBeLessThan(0);
  });
});

describe('runPlannerAgent — abandoned blockers clear deps (ADR 0013 §4)', () => {
  test('blocker in `abandoned` is treated as cleared → dependent Task promotes', async () => {
    const deps = makeDeps();
    deps.substrate.seedTask({
      recordId: 'I_blocker_abandoned',
      state: 'abandoned',
      blockedBy: [],
      createdAt: '2026-05-28T00:00:00Z',
    });
    deps.substrate.seedTask({
      recordId: 'I_t_dep_on_abandoned',
      state: 'proposed',
      priority: 'P1',
      blockedBy: ['I_blocker_abandoned'],
      createdAt: '2026-05-30T10:00:00Z',
    });

    const result = await runPlannerAgent(
      makeMessage({ fromState: 'in_progress', toState: 'abandoned' }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('promoted=1');
    expect(deps.substrate.transitionHistory()).toHaveLength(1);
    expect(deps.substrate.transitionHistory()[0]?.taskId).toBe('I_t_dep_on_abandoned');
  });
});

describe('runPlannerAgent — substrate-shape gaps surface in result', () => {
  test('blocker record_not_found → Task stays in proposed, blocked counted, no transition', async () => {
    const deps = makeDeps();
    deps.substrate.seedTask({
      recordId: 'I_t_cites_missing',
      state: 'proposed',
      priority: 'P1',
      blockedBy: ['I_does_not_exist'],
      createdAt: '2026-05-30T10:00:00Z',
    });

    const result = await runPlannerAgent(makeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('backlog=1');
    expect(result.result).toContain('promoted=0');
    expect(result.result).toContain('blocked=1');
    expect(deps.substrate.transitionHistory()).toHaveLength(0);
  });

  test('transitionTask failure on one Task → ok:false partial_failure so consumer deadletters', async () => {
    // Substrate that lists two proposed Tasks but fails the transition
    // on one of them. The planner must NOT ack ok:true with the failure
    // hidden in the summary — that would lose the only retry signal for
    // the failed promotion.
    const flakySubstrate = {
      listTasks: async () => ({ ok: true as const, value: ['I_t_ok', 'I_t_flaky'] }) as const,
      getTaskMetadata: async (taskId: string) => ({
        ok: true as const,
        value: {
          recordId: taskId,
          state: 'proposed' as const,
          priority: 'P1' as const,
          blockedBy: [],
          createdAt: '2026-05-30T10:00:00Z',
        },
      }),
      transitionTask: async (args: { taskId: string }) => {
        if (args.taskId === 'I_t_flaky') {
          return { ok: false as const, reason: 'substrate_5xx' };
        }
        return { ok: true as const, value: { taskId: args.taskId, toState: 'ready' as const } };
      },
    };
    const result = await runPlannerAgent(makeMessage(), {
      substrate: flakySubstrate,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^planner_agent_partial_failure:/);
    expect(result.reason).toContain('transition:I_t_flaky:substrate_5xx');
    // Summary preserved in the reason so operators see both the
    // succeeded promotion AND the gap.
    expect(result.reason).toContain('promoted=1');
    expect(result.reason).toContain('ids=I_t_ok');
    expect(result.reason).toContain('promote_failures=1');
  });

  test('partial metadata fetch failure → ok:false partial_failure (some metadata loaded, some did not)', async () => {
    // listTasks returns 2 ids but only 1 resolves via getTaskMetadata.
    // The successful Task IS promoted (no all-or-nothing), but the
    // overall envelope is ok:false so the gap surfaces.
    const flakySubstrate = {
      listTasks: async () => ({ ok: true as const, value: ['I_resolves', 'I_missing'] }) as const,
      getTaskMetadata: async (taskId: string) => {
        if (taskId === 'I_missing') {
          return { ok: false as const, reason: 'record_not_found' };
        }
        return {
          ok: true as const,
          value: {
            recordId: taskId,
            state: 'proposed' as const,
            priority: 'P1' as const,
            blockedBy: [],
            createdAt: '2026-05-30T10:00:00Z',
          },
        };
      },
      transitionTask: async (args: { taskId: string }) =>
        ({ ok: true as const, value: { taskId: args.taskId, toState: 'ready' as const } }) as const,
    };
    const result = await runPlannerAgent(makeMessage(), {
      substrate: flakySubstrate,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^planner_agent_partial_failure:/);
    expect(result.reason).toContain('metadata_fetch:I_missing:record_not_found');
    expect(result.reason).toContain('promoted=1');
    expect(result.reason).toContain('ids=I_resolves');
  });

  test('listTasks failure → typed planner_agent_list_backlog_failed', async () => {
    const failingSubstrate = {
      listTasks: async () => ({ ok: false as const, reason: 'graphql_5xx' }),
      getTaskMetadata: async () => ({ ok: false as const, reason: 'unreached' }),
      transitionTask: async () => ({ ok: false as const, reason: 'unreached' }),
    };
    const result = await runPlannerAgent(makeMessage(), {
      substrate: failingSubstrate,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('planner_agent_list_backlog_failed:graphql_5xx');
  });
});

describe('runPlannerAgent — every recognized PROMOTE trigger dispatches the same scan', () => {
  // NOTE: design:ready_for_review→ratified is intentionally absent — that key
  // routes to the DECOMPOSE branch, covered by its own suite. The
  // remaining intake + dep-clear keys all run the promote-by-dep-order scan.
  test.each([
    // New intake.
    ['goal', '__initial__', 'proposed'],
    ['task', '__initial__', 'proposed'],
    // Dep-clear.
    ['task', 'in_review', 'done'],
    ['task', 'proposed', 'abandoned'],
    ['task', 'ready', 'abandoned'],
    ['task', 'in_progress', 'abandoned'],
    ['task', 'in_review', 'abandoned'],
  ] as const)('trigger %s:%s→%s runs the backlog scan', async (kind, fromState, toState) => {
    const deps = makeDeps();
    deps.substrate.seedTask({
      recordId: 'I_ready_to_go',
      state: 'proposed',
      priority: 'P0',
      blockedBy: [],
      createdAt: '2026-05-30T10:00:00Z',
    });

    const result = await runPlannerAgent(
      makeMessage({
        kind,
        fromState,
        toState,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain(`trigger=${kind}:${fromState}→${toState}`);
    expect(result.result).toContain('promoted=1');
    expect(deps.substrate.transitionHistory()).toHaveLength(1);
  });
});

describe('runPlannerAgent — defensive guard for mis-routed transitions', () => {
  test('unrecognized transition → typed planner_agent_wrong_transition, NO substrate writes', async () => {
    const deps = makeDeps();
    // Seed a promotable task to prove no scan happens on mis-route.
    deps.substrate.seedTask({
      recordId: 'I_should_not_promote',
      state: 'proposed',
      priority: 'P0',
      blockedBy: [],
      createdAt: '2026-05-30T10:00:00Z',
    });

    const result = await runPlannerAgent(
      makeMessage({ kind: 'pr', fromState: 'open', toState: 'in_review' }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('planner_agent_wrong_transition:pr:open→in_review');
    expect(deps.substrate.transitionHistory()).toHaveLength(0);
  });
});

describe('runPlannerAgent — DECOMPOSE: design:ratified fans out into Tasks', () => {
  function decomposeMessage(): ParsedTransitionMessage {
    return makeMessage({
      kind: 'design',
      recordId: 'I_design_ratified',
      fromState: 'ready_for_review',
      toState: 'ratified',
    });
  }

  // StubIssueTool.create mints deterministic recordIds in creation order:
  // `I_stub_<repo-sanitized>_<n>` (1-based). The decompose promote-roots pass
  // calls substrate.transitionTask on those exact ids — the StubPlanner-
  // SubstrateClient only honors transitions for tasks it knows, so pre-seed
  // them as `proposed`. (The real GithubPlannerSubstrateClient resolves the
  // issue number from the recordId via GraphQL and needs no pre-seeding; this
  // is purely a stub-substrate test seam.)
  function stubRecordId(creationIndex: number): string {
    return `I_stub_example_org_software_factory_${creationIndex}`;
  }
  function seedProposedTasks(substrate: StubPlannerSubstrateClient, count: number): void {
    for (let i = 1; i <= count; i++) {
      substrate.seedTask({
        recordId: stubRecordId(i),
        state: 'proposed',
        blockedBy: [],
        createdAt: '2026-05-30T10:00:00Z',
      });
    }
  }

  function seedDesign(issues: StubIssueTool): void {
    issues.seedRecord({
      recordId: 'I_design_ratified',
      labels: ['kind:design'],
      body: 'parent-goal: I_goal_7\nspec-ref: I_spec_3\n\n## Service delta\nBuild the thing.',
    });
  }

  test('with a brain: creates N kind:task issues carrying parent/spec/design links', async () => {
    const issues = new StubIssueTool();
    seedDesign(issues);
    const brain = fakeBrain(
      JSON.stringify([
        { title: 'Add API route', whatToBuild: 'Create the POST /things route.' },
        { title: 'Add DB migration', whatToBuild: 'Add the things table.' },
      ]),
    );
    const deps = { ...makeDeps(), issues, generateContent: brain };
    seedProposedTasks(deps.substrate, 2);

    const result = await runPlannerAgent(decomposeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatch(/^PlannerAgent: decomposed design=I_design_ratified/);
    expect(result.result).toContain('created_tasks=2');

    const creates = issues.createHistory();
    expect(creates).toHaveLength(2);
    for (const create of creates) {
      // kind:task ONLY — proposed is implicit (no status:* label).
      expect(create.labels).toEqual(['kind:task']);
      expect(create.body).toContain('parent-goal: I_goal_7');
      expect(create.body).toContain('spec-ref: I_spec_3');
      expect(create.body).toContain('design-ref: I_design_ratified');
      expect(create.body).toContain('## What to build');
      // No status:* label leaks into the body either.
      expect(create.body).not.toContain('status:');
    }
    expect(creates[0]?.title).toBe('Add API route');
    expect(creates[1]?.title).toBe('Add DB migration');
    // Both Tasks are roots (no blockers) → both promoted to ready IN THIS
    // run against the recordIds returned by create (NOT via listTasks). The
    // orchestrator would never promote App-authored Tasks otherwise.
    expect(result.result).toContain('created_tasks=2');
    expect(result.result).toContain('promoted_roots=2');
    const history = deps.substrate.transitionHistory();
    expect(history).toHaveLength(2);
    for (const transition of history) {
      expect(transition.fromState).toBe('proposed');
      expect(transition.toState).toBe('ready');
      expect(transition.actor).toBe('PlannerAgent');
    }
    // The promoted ids are exactly the created recordIds.
    const createdIds = creates.map((_c, i) => `I_stub_example_org_software_factory_${i + 1}`);
    expect(history.map((t) => t.taskId).sort()).toEqual(createdIds.sort());
  });

  test('intra-Design ordering: dependent gets blocked-by line + only the root is promoted', async () => {
    const issues = new StubIssueTool();
    seedDesign(issues);
    // Task 1 ("UI") blocks on Task 0 ("API").
    const brain = fakeBrain(
      JSON.stringify([
        { title: 'API', whatToBuild: 'Build the API.', blockedBy: [] },
        { title: 'UI', whatToBuild: 'Build the UI.', blockedBy: [0] },
      ]),
    );
    const deps = { ...makeDeps(), issues, generateContent: brain };
    seedProposedTasks(deps.substrate, 2);

    const result = await runPlannerAgent(decomposeMessage(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const creates = issues.createHistory();
    expect(creates).toHaveLength(2);
    const apiCreate = creates.find((c) => c.title === 'API');
    const uiCreate = creates.find((c) => c.title === 'UI');
    // API created first (blocker before dependent), with no blocked-by line.
    expect(apiCreate?.body).not.toContain('blocked-by:');
    // UI cites the API's created recordId (resolved from the index after the
    // blocker was created — the synthetic stub recordId shape).
    expect(uiCreate?.body).toMatch(/blocked-by: I_stub_/);
    // API is created before UI (dependency-respecting creation order).
    expect(creates[0]?.title).toBe('API');
    // Only the ROOT (API) is promoted now; the blocked UI stays proposed
    // and cascades to ready later via the task:in_review→done re-plan trigger.
    expect(result.result).toContain('promoted_roots=1');
    const history = deps.substrate.transitionHistory();
    expect(history).toHaveLength(1);
    // The promoted Task is the API root (created first → recordId #1).
    expect(history[0]?.taskId).toBe('I_stub_example_org_software_factory_1');
    expect(history[0]?.toState).toBe('ready');
  });

  test('no-brain path: falls back to a single templated Task, promoted as a root (stub/CI boot)', async () => {
    const issues = new StubIssueTool();
    seedDesign(issues);
    const deps = { ...makeDeps(), issues }; // no generateContent
    seedProposedTasks(deps.substrate, 1);

    const result = await runPlannerAgent(decomposeMessage(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('created_tasks=1');
    expect(result.result).toContain('promoted_roots=1');
    const creates = issues.createHistory();
    expect(creates).toHaveLength(1);
    expect(creates[0]?.labels).toEqual(['kind:task']);
    expect(creates[0]?.body).toContain('design-ref: I_design_ratified');
    expect(creates[0]?.body).toContain('## What to build');
    // The single Task (a root) is promoted to ready in the same run.
    expect(deps.substrate.transitionHistory()).toHaveLength(1);
    expect(deps.substrate.transitionHistory()[0]?.toState).toBe('ready');
  });

  test('no issues tool wired → typed planner_agent_decompose_no_issues_tool', async () => {
    const deps = makeDeps(); // no issues
    const result = await runPlannerAgent(decomposeMessage(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('planner_agent_decompose_no_issues_tool');
  });

  test('brain returns non-JSON → typed parse failure, no Tasks created', async () => {
    const issues = new StubIssueTool();
    seedDesign(issues);
    const deps = { ...makeDeps(), issues, generateContent: fakeBrain('not json at all') };
    const result = await runPlannerAgent(decomposeMessage(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^planner_agent_decompose_parse_failed:/);
    expect(issues.createHistory()).toHaveLength(0);
  });

  test('brain content failure → typed content_failed', async () => {
    const issues = new StubIssueTool();
    seedDesign(issues);
    const deps = { ...makeDeps(), issues, generateContent: fakeBrain('', false) };
    const result = await runPlannerAgent(decomposeMessage(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^planner_agent_decompose_content_failed:/);
  });

  test('code-fenced JSON from the brain is tolerated', async () => {
    const issues = new StubIssueTool();
    seedDesign(issues);
    const fenced = `\`\`\`json\n${JSON.stringify([{ title: 'X', whatToBuild: 'do X' }])}\n\`\`\``;
    const deps = { ...makeDeps(), issues, generateContent: fakeBrain(fenced) };
    seedProposedTasks(deps.substrate, 1);
    const result = await runPlannerAgent(decomposeMessage(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('created_tasks=1');
  });

  test('design body read failure → typed design_read_failed, no Tasks created', async () => {
    const issues = new StubIssueTool(); // design NOT seeded → read fails
    const deps = { ...makeDeps(), issues, generateContent: fakeBrain('[]') };
    const result = await runPlannerAgent(decomposeMessage(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^planner_agent_design_read_failed:/);
    expect(issues.createHistory()).toHaveLength(0);
  });
});

describe('runPlannerAgent — DECOMPOSE partial-failure surfacing', () => {
  function decomposeMsg(): ParsedTransitionMessage {
    return makeMessage({
      kind: 'design',
      recordId: 'I_design_ratified',
      fromState: 'ready_for_review',
      toState: 'ratified',
    });
  }

  function seededStub(): StubIssueTool {
    const stub = new StubIssueTool();
    stub.seedRecord({
      recordId: 'I_design_ratified',
      labels: ['kind:design'],
      body: 'parent-goal: I_goal_7\nspec-ref: I_spec_3\n\nbody',
    });
    return stub;
  }

  // Wrap a StubIssueTool, failing the create whose title is in `failTitles`.
  // biome-ignore lint/suspicious/noExplicitAny: narrow inline test double.
  function failingCreateIssues(stub: StubIssueTool, failTitles: ReadonlySet<string>): any {
    return {
      read: (recordId: string) => stub.read(recordId),
      applyLabel: (args: { recordId: string; label: string }) => stub.applyLabel(args),
      removeLabel: (args: { recordId: string; label: string }) => stub.removeLabel(args),
      comment: (args: { recordId: string; body: string }) => stub.comment(args),
      create: async (args: { repo: string; title: string; body: string }) => {
        if (failTitles.has(args.title)) {
          return { ok: false as const, reason: 'create_5xx' };
        }
        return stub.create({ ...args, labels: ['kind:task'] });
      },
    };
  }

  test('an independent create failure → ok:false decompose_partial_failure, roots still promoted', async () => {
    const stub = seededStub();
    const brain = fakeBrain(
      JSON.stringify([
        { title: 'T0', whatToBuild: 'a' }, // root, succeeds
        { title: 'T1', whatToBuild: 'b' }, // root, fails to create
      ]),
    );
    const substrate = new StubPlannerSubstrateClient();
    // T0 succeeds → recordId `..._1`; seed it so the promote-roots pass can
    // transition it (the real substrate resolves the id directly).
    substrate.seedTask({
      recordId: 'I_stub_example_org_software_factory_1',
      state: 'proposed',
      blockedBy: [],
      createdAt: '2026-05-30T10:00:00Z',
    });
    const result = await runPlannerAgent(decomposeMsg(), {
      substrate,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      issues: failingCreateIssues(stub, new Set(['T1'])),
      generateContent: brain,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^planner_agent_decompose_partial_failure:/);
    expect(result.reason).toContain('create:');
    expect(result.reason).toContain('create_5xx');
    // The one Task that DID get created is still promoted (T0 is a root).
    expect(result.reason).toContain('created_tasks=1');
    expect(result.reason).toContain('promoted_roots=1');
    expect(substrate.transitionHistory()).toHaveLength(1);
  });

  test('a failed BLOCKER create skips its dependent (not materialized) + surfaces typed failure', async () => {
    const stub = seededStub();
    // T0 is the blocker (fails). T1 depends on T0 (blockedBy [0]) → must be
    // SKIPPED, not created with the missing blocker silently dropped.
    const brain = fakeBrain(
      JSON.stringify([
        { title: 'T0_blocker', whatToBuild: 'blocker', blockedBy: [] },
        { title: 'T1_dependent', whatToBuild: 'dependent', blockedBy: [0] },
      ]),
    );
    const substrate = new StubPlannerSubstrateClient();
    const issues = failingCreateIssues(stub, new Set(['T0_blocker']));
    const result = await runPlannerAgent(decomposeMsg(), {
      substrate,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      issues,
      generateContent: brain,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^planner_agent_decompose_partial_failure:/);
    // The blocker's create failure is surfaced.
    expect(result.reason).toContain('create:');
    expect(result.reason).toContain('create_5xx');
    // The dependent was SKIPPED (auditable), not created.
    expect(result.reason).toContain('skipped:');
    expect(result.reason).toContain('blocker_0_not_created');
    // Nothing was successfully created → nothing promoted; the dependent was
    // never materialized as an apparently-unblocked Task.
    expect(stub.createHistory()).toHaveLength(0);
    expect(result.reason).toContain('created_tasks=0');
    expect(result.reason).toContain('promoted_roots=0');
    expect(substrate.transitionHistory()).toHaveLength(0);
  });

  test('promote failure on a root → ok:false decompose_partial_failure (promote: detail)', async () => {
    const stub = seededStub();
    const brain = fakeBrain(JSON.stringify([{ title: 'T0', whatToBuild: 'a' }]));
    // Substrate whose transitionTask always fails (root created but can't promote).
    const flakySubstrate = {
      listTasks: async () => ({ ok: true as const, value: [] as string[] }),
      getTaskMetadata: async () => ({ ok: false as const, reason: 'unreached' }),
      transitionTask: async () => ({ ok: false as const, reason: 'fsm_reject' }),
    };
    const result = await runPlannerAgent(decomposeMsg(), {
      substrate: flakySubstrate,
      runId: '01HZXYZ123456789ABCDEFGHJK',
      repo: 'example-org/software-factory',
      // biome-ignore lint/suspicious/noExplicitAny: full stub satisfies IssueTool.
      issues: stub as any,
      generateContent: brain,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^planner_agent_decompose_partial_failure:/);
    expect(result.reason).toContain('promote:');
    expect(result.reason).toContain('fsm_reject');
    // The Task WAS created; only the promotion failed.
    expect(result.reason).toContain('created_tasks=1');
    expect(result.reason).toContain('promoted_roots=0');
  });
});

describe('runPlannerAgent — task:ready→done is a dep-clear replan trigger', () => {
  test('ready→done replans the proposed backlog (cascade trigger)', async () => {
    const substrate = new StubPlannerSubstrateClient();
    const result = await runPlannerAgent(
      makeMessage({ kind: 'task', fromState: 'ready', toState: 'done' }),
      { substrate, runId: '01HZXYZ123456789ABCDEFGHJK', repo: 'example-org/software-factory' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('backlog empty');
  });
});
