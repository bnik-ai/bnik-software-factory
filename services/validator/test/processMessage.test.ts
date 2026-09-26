import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { InMemoryAuditLedgerWriter } from '../src/auditLedger.js';
import { evaluateTransition } from '../src/dispatcher.js';
import { processMessage } from '../src/processMessage.js';
import type { ParsedTransitionMessage } from '../src/queueConsumer.js';
import { InMemorySubstrateClient } from '../src/substrateClient.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.transitioned',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA',
    fromState: 'proposed',
    toState: 'accepted',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-29T18:00:00Z'),
    ...overrides,
  };
}

describe('processMessage — accept verdict', () => {
  test('Goal proposed → accepted by human: ack + ledger row with verdict accept + seq=1', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const result = await processMessage(makeMessage(), {
      dispatcher: evaluateTransition,
      ledger,
    });
    expect(result.action).toBe('ack');
    expect((result as { verdict: { verdict: string } }).verdict).toEqual({ verdict: 'accept' });
    expect((result as { rowSeq?: number }).rowSeq).toBe(1);
    expect(ledger.size()).toBe(1);
    expect(ledger.snapshot()[0]?.verdict).toBe('accept');
  });
});

describe('processMessage — soft-flag verdict', () => {
  test('Goal proposed → in_progress (illegal) by human: ack + ledger row with verdict flag', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const result = await processMessage(makeMessage({ toState: 'in_progress' }), {
      dispatcher: evaluateTransition,
      ledger,
    });
    expect(result.action).toBe('ack');
    expect((result as { verdict: { verdict: string } }).verdict.verdict).toBe('flag');
    expect(ledger.size()).toBe(1);
    expect(ledger.snapshot()[0]?.verdict).toBe('flag');
  });
});

describe('processMessage — hard-reject verdict', () => {
  test('Deployment illegal: ack + ledger row with verdict reject', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const message = makeMessage({
      kind: 'deployment',
      fromState: 'pending',
      toState: 'success',
      actor: 'system',
    });
    const result = await processMessage(message, { dispatcher: evaluateTransition, ledger });
    expect(result.action).toBe('ack');
    expect((result as { verdict: { verdict: string } }).verdict.verdict).toBe('reject');
    expect(ledger.snapshot()[0]?.verdict).toBe('reject');
  });
});

describe('processMessage — duplicate delivery', () => {
  test('second call with same delivery_id: ack + idempotent=true + ledger size unchanged', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const message = makeMessage();
    const first = await processMessage(message, { dispatcher: evaluateTransition, ledger });
    expect((first as { idempotent: boolean }).idempotent).toBe(false);
    const second = await processMessage(message, { dispatcher: evaluateTransition, ledger });
    expect(second.action).toBe('ack');
    expect((second as { idempotent: boolean }).idempotent).toBe(true);
    expect(ledger.size()).toBe(1);
  });
});

describe('processMessage — non-duplicate ledger errors propagate', () => {
  test('a thrown error other than DuplicateDeliveryError bubbles out', async () => {
    const ledger: import('../src/auditLedger.js').AuditLedgerWriter = {
      append: async () => {
        throw new Error('database is down');
      },
    };
    await expect(
      processMessage(makeMessage(), { dispatcher: evaluateTransition, ledger }),
    ).rejects.toThrow(/database is down/);
  });
});

describe('processMessage — cross-record assertion verdict downgrade', () => {
  test('FSM-accept + cross-record OK → verdict stays accept', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_design_99', { body: 'd', labels: ['kind:design'] });
    substrate.setIssue('I_task_1', {
      body: 'parent-goal: I_goal_42\ndesign-ref: I_design_99\n\nbody',
      labels: ['kind:task'],
    });
    const message = makeMessage({
      kind: 'task',
      actor: 'PlannerAgent',
      recordId: 'I_task_1',
      recordKind: 'Task',
      fromState: 'proposed',
      toState: 'ready',
    });
    const result = await processMessage(message, {
      dispatcher: evaluateTransition,
      ledger,
      substrate,
    });
    expect(result.action).toBe('ack');
    expect((result as { verdict: { verdict: string } }).verdict).toEqual({ verdict: 'accept' });
    expect(ledger.snapshot()[0]?.verdict).toBe('accept');
  });

  test('FSM-accept + cross-record FAIL (parent-goal missing) → downgrade to flag', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_design_99', { body: 'd', labels: ['kind:design'] });
    substrate.setIssue('I_task_1', {
      body: 'parent-goal: I_missing_goal\ndesign-ref: I_design_99\n\nbody',
      labels: ['kind:task'],
    });
    const message = makeMessage({
      kind: 'task',
      actor: 'PlannerAgent',
      recordId: 'I_task_1',
      recordKind: 'Task',
      fromState: 'proposed',
      toState: 'ready',
    });
    const result = await processMessage(message, {
      dispatcher: evaluateTransition,
      ledger,
      substrate,
    });
    expect(result.action).toBe('ack');
    const verdict = (result as { verdict: { verdict: string; reason?: string } }).verdict;
    expect(verdict.verdict).toBe('flag');
    expect(verdict.reason).toBe('parent_goal_missing');
    expect(ledger.snapshot()[0]?.verdict).toBe('flag');
  });

  test('FSM-accept + cross-record FAIL (design-ref invalid kind) → downgrade to flag', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_design_99', { body: 'd', labels: ['kind:spec'] }); // wrong kind
    substrate.setIssue('I_task_1', {
      body: 'parent-goal: I_goal_42\ndesign-ref: I_design_99\n\nbody',
      labels: ['kind:task'],
    });
    const message = makeMessage({
      kind: 'task',
      actor: 'PlannerAgent',
      recordId: 'I_task_1',
      recordKind: 'Task',
      fromState: 'proposed',
      toState: 'ready',
    });
    const result = await processMessage(message, {
      dispatcher: evaluateTransition,
      ledger,
      substrate,
    });
    const verdict = (result as { verdict: { verdict: string; reason?: string } }).verdict;
    expect(verdict.verdict).toBe('flag');
    expect(verdict.reason).toBe('design_ref_invalid');
  });

  test('FSM-flag stays flag even if cross-record would pass (FSM signal is stronger)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_design_99', { body: 'd', labels: ['kind:design'] });
    substrate.setIssue('I_task_1', {
      body: 'parent-goal: I_goal_42\ndesign-ref: I_design_99\n\nbody',
      labels: ['kind:task'],
    });
    // Illegal task transition: proposed → in_progress (must go via ready)
    const message = makeMessage({
      kind: 'task',
      actor: 'BuildAgent',
      recordId: 'I_task_1',
      recordKind: 'Task',
      fromState: 'proposed',
      toState: 'in_progress',
    });
    const result = await processMessage(message, {
      dispatcher: evaluateTransition,
      ledger,
      substrate,
    });
    const verdict = (result as { verdict: { verdict: string; reason?: string } }).verdict;
    expect(verdict.verdict).toBe('flag');
    // FSM reason preserved, NOT overridden by cross-record (which would have
    // passed anyway in this seed)
    expect(verdict.reason).toBe('illegal_transition');
  });

  test('substrate dep absent → cross-record check skipped, verdict reflects FSM only', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const message = makeMessage({
      kind: 'task',
      actor: 'PlannerAgent',
      recordId: 'I_task_1',
      recordKind: 'Task',
      fromState: 'proposed',
      toState: 'ready',
    });
    // No substrate wired → assertions skip
    const result = await processMessage(message, {
      dispatcher: evaluateTransition,
      ledger,
    });
    expect((result as { verdict: { verdict: string } }).verdict).toEqual({ verdict: 'accept' });
  });
});

describe('processMessage — review-loop assertion verdict downgrade', () => {
  // Spec: docs/decisions/0010-multi-model-review-loop.md §"Substrate
  // constraints" + docs/design/review-agent.md §3 + §6. A failing review-
  // loop assertion downgrades verdict accept→flag, same shape as the
  // cross-record block above.

  const RUN_AUTHOR = '01HZX0000000000000000000AT';
  const RUN_REVIEWER = '01HZX0000000000000000000RV';
  const RUN_ADJUDICATOR = '01HZX0000000000000000000AJ';
  const TASK = 'T-42';

  function stamp(model: string, run: string): string {
    return `<!-- sf:structural sf:agent=review@${model} run=${run} -->`;
  }
  function reviewBody(reviewerModel: string, adjudicatorModel: string): string {
    return [
      stamp(reviewerModel, RUN_REVIEWER),
      'Reviewer findings.',
      stamp(adjudicatorModel, RUN_ADJUDICATOR),
      'Adjudicator verdicts.',
    ].join('\n\n');
  }

  function prApprovalMessage(): ParsedTransitionMessage {
    return makeMessage({
      kind: 'pr',
      actor: 'ReviewAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOPR_1',
      eventType: 'webhook:pull_request_review.submitted',
      fromState: 'in_review',
      toState: 'approved',
    });
  }

  test('FSM-accept + review-loop OK (three distinct models) → verdict stays accept', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@sonnet-4.5`,
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_1',
      state: 'approved',
      body: reviewBody('opus-4.7', 'haiku-4.5'),
    });
    const result = await processMessage(prApprovalMessage(), {
      dispatcher: evaluateTransition,
      ledger,
      substrate,
    });
    expect((result as { verdict: { verdict: string } }).verdict).toEqual({ verdict: 'accept' });
    expect(ledger.snapshot()[0]?.verdict).toBe('accept');
  });

  test('FSM-accept + review-loop FAIL (no approved Review) → downgrade to flag', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@sonnet-4.5`,
    });
    const result = await processMessage(prApprovalMessage(), {
      dispatcher: evaluateTransition,
      ledger,
      substrate,
    });
    const verdict = (result as { verdict: { verdict: string; reason?: string } }).verdict;
    expect(verdict.verdict).toBe('flag');
    expect(verdict.reason).toBe('pr_approved_without_review');
    expect(ledger.snapshot()[0]?.verdict).toBe('flag');
  });

  test('FSM-accept + review-loop FAIL (reviewer model == author) → downgrade to flag', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_kwAOPR_1', {
      headRef: `sf/${TASK}/${RUN_AUTHOR}/build@sonnet-4.5`,
    });
    substrate.seedReview('PR_kwAOPR_1', {
      recordId: 'REV_1',
      state: 'approved',
      body: reviewBody('sonnet-4.5', 'haiku-4.5'),
    });
    const result = await processMessage(prApprovalMessage(), {
      dispatcher: evaluateTransition,
      ledger,
      substrate,
    });
    const verdict = (result as { verdict: { verdict: string; reason?: string } }).verdict;
    expect(verdict.verdict).toBe('flag');
    expect(verdict.reason).toBe('reviewer_model_equals_author');
  });
});
