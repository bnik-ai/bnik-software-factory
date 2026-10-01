// Integration: wire-format JSON → parser → consumer loop → runOpsAgent → ack.
// Mirrors mainAgentDesign.test.ts / mainAgentPlanner.test.ts. Confirms the
// ops entrypoint plumbing is end-to-end exercisable: an approved-PR envelope
// on the `agent-runs-ops` queue routes through the OpsAgent role, drives
// runOpsAgent (stale-base re-check → squash-merge → structural comment →
// post-merge Task bookkeeping), and acks. Also asserts the stamp
// uses a ULID (NOT deliveryId).

import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { runOpsAgent } from '../src/agents/opsAgent.js';
import { parseEnvelopeFromWire, runAgentConsumerLoop } from '../src/consumerLoop.js';
import { InMemoryAgentRunQueueConsumer } from '../src/queueConsumer.js';
import { ULID_REGEX, mintRunId } from '../src/runId.js';
import { StubIssueTool } from '../src/tools/issueTool.js';
import { StubPullTool } from '../src/tools/pullTool.js';

function makeWirePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent: 'OpsAgent',
    transition_key: 'pr:in_review→approved',
    message: {
      lockToken: 'lt-inner',
      deliveryId: 'd-inner',
      eventType: 'webhook:pull_request_review.submitted',
      kind: 'pr',
      actor: 'ReviewAgent',
      recordType: 'PullRequest',
      recordId: 'PR_kwAOA_pr_77',
      fromState: 'in_review',
      toState: 'approved',
      payloadHash: createHash('sha256').update('p').digest('hex'),
      receivedAt: '2026-05-30T18:00:00.000Z',
      verdict: 'accept',
      ...overrides,
    },
  });
}

describe('mainAgentOps — wire-format → parser → loop → runOpsAgent → ack', () => {
  test('happy path: approved-PR envelope is parsed, dispatched to runOpsAgent, merged, then acked', async () => {
    const wire = makeWirePayload();
    const parsed = parseEnvelopeFromWire(wire, 'sb-lock-token-1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue(parsed.value);

    // StubPullTool's default getSyncStatus is 'current', so the stale-base
    // gate passes and runOpsAgent proceeds to squash-merge + comment. Seed
    // the PR (with BuildAgent's task-ref line) + the paired Task at
    // status:ready carrying the REQUIRED `pr-ref:` backlink (bidirectional
    // pairing) so the post-merge bookkeeping is
    // exercised end-to-end through the entrypoint wiring.
    const pulls = new StubPullTool();
    pulls.seedRecord({
      recordId: 'PR_kwAOA_pr_77',
      number: 77,
      state: 'open',
      headBranch: 'sf/T-219/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
      baseBranch: 'main',
      body: 'task-ref: I_kwTask_219\n\nBuildAgent PR.',
    });
    const issues = new StubIssueTool();
    issues.seedRecord({
      recordId: 'I_kwTask_219',
      labels: ['kind:task', 'status:ready'],
      body: 'Task body\npr-ref: PR_kwAOA_pr_77',
    });

    // Mint a fresh ULID exactly as the entrypoint does — proves the boot
    // path's stamp parses against the validator's ULID_RE.
    const runId = mintRunId();
    expect(ULID_REGEX.test(runId)).toBe(true);

    const handler = vi.fn(async (m: Parameters<typeof runOpsAgent>[0]) =>
      runOpsAgent(m, { pulls, issues, runId }),
    );

    const controller = new AbortController();
    const loop = runAgentConsumerLoop({
      consumer,
      role: 'OpsAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await loop;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(consumer.ackedMessages().map((m) => m.lockToken)).toEqual(['sb-lock-token-1']);
    // Merge side-effect: the approved PR was squash-merged under OpsAgent.
    expect(pulls.mergeHistory()).toHaveLength(1);
    expect(pulls.mergeHistory()[0]?.recordId).toBe('PR_kwAOA_pr_77');
    expect(pulls.mergeHistory()[0]?.method).toBe('squash');
    // Structural merge-note comment posted on the PR.
    expect(pulls.reviewHistory()).toHaveLength(1);
    expect(pulls.reviewHistory()[0]?.state).toBe('comment');
    // Post-merge bookkeeping: marker comment on the Task, then
    // the status:done apply (drives task:ready→done → PlannerAgent re-plan),
    // then the status:ready swap cleanup.
    expect(issues.commentHistory()).toHaveLength(1);
    expect(issues.commentHistory()[0]?.recordId).toBe('I_kwTask_219');
    expect(issues.commentHistory()[0]?.structural).toEqual({ role: 'ops@none', run: runId });
    expect(issues.labelApplyHistory()).toEqual([
      { recordId: 'I_kwTask_219', label: 'status:done' },
    ]);
    expect(issues.labelRemoveHistory()).toEqual([
      { recordId: 'I_kwTask_219', label: 'status:ready' },
    ]);
  });

  test('mis-routed envelope (BuildAgent on ops queue) is deadlettered by the loop', async () => {
    const consumer = new InMemoryAgentRunQueueConsumer();
    consumer.enqueue({
      lockToken: 'lt-misroute',
      agent: 'BuildAgent',
      transitionKey: 'pr:in_review→approved',
      message: {
        lockToken: 'lt-misroute',
        deliveryId: 'd-misroute',
        eventType: 'webhook:pull_request_review.submitted',
        kind: 'pr',
        actor: 'ReviewAgent',
        recordType: 'PullRequest',
        recordId: 'PR_kwAOA',
        fromState: 'in_review',
        toState: 'approved',
        payloadHash: createHash('sha256').update('p').digest(),
        receivedAt: new Date('2026-05-30T18:00:00.000Z'),
      },
    });
    const handler = vi.fn();
    const controller = new AbortController();
    const loop = runAgentConsumerLoop({
      consumer,
      role: 'OpsAgent',
      handler,
      signal: controller.signal,
      pollIntervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await loop;

    expect(handler).not.toHaveBeenCalled();
    expect(consumer.deadletteredMessages()).toHaveLength(1);
  });
});
