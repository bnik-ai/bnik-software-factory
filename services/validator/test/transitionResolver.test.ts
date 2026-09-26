import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { InMemoryAuditLedgerWriter } from '../src/auditLedger.js';
import type { ParsedWebhookEnvelope } from '../src/payloadParser.js';
import { InMemorySubstrateClient } from '../src/substrateClient.js';
import { resolveTransition } from '../src/transitionResolver.js';

function makeDeps(substrate?: InMemorySubstrateClient, ledger?: InMemoryAuditLedgerWriter) {
  return {
    substrate: substrate ?? new InMemorySubstrateClient(),
    ledger: ledger ?? new InMemoryAuditLedgerWriter(),
  };
}

// Seed a prior ledger row so getLastTransitionForRecord resolves toState —
// the unlabeled branches' LEDGER-CONVERGING rule (issue #180 codex round 3)
// keys observational-vs-violation off the ledgered state's label.
async function seedLedgerRow(
  ledger: InMemoryAuditLedgerWriter,
  recordId: string,
  toState: string,
  recordKind = 'Task',
): Promise<void> {
  await ledger.append({
    deliveryId: `d-prior-${recordId}-${toState}`,
    eventType: 'issues',
    actor: 'human',
    recordType: 'Issue',
    recordKind,
    recordId,
    fromState: '__initial__',
    toState,
    verdict: 'accept',
    payloadHash: createHash('sha256').update('prior').digest(),
    receivedAt: new Date('2026-05-30T17:00:00Z'),
  });
}

function makeEnvelope(overrides: Partial<ParsedWebhookEnvelope> = {}): ParsedWebhookEnvelope {
  return {
    deliveryId: 'd-1',
    eventType: 'issues',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA',
    payloadHash: createHash('sha256').update('p').digest(),
    statusLabel: 'status:accepted',
    action: 'labeled',
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

describe('resolveTransition — issues mid-replacement window (substrate sees both labels)', () => {
  test('labeled with old + new status:* coexisting → fromState from substrate', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['kind:goal', 'status:proposed', 'status:accepted']);

    const result = await resolveTransition(makeEnvelope(), makeDeps(substrate));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('proposed');
      expect(result.transition.toState).toBe('accepted');
    }
  });

  test('non-status labels in the substrate are ignored', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', [
      'kind:goal',
      'priority:p1',
      'area:platform',
      'status:proposed',
      'status:accepted',
    ]);
    const result = await resolveTransition(makeEnvelope(), makeDeps(substrate));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.fromState).toBe('proposed');
  });

  test('all envelope passthrough fields preserved', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['status:proposed', 'status:accepted']);
    const envelope = makeEnvelope({
      deliveryId: 'd-XYZ',
      kind: 'task',
      actor: 'PlannerAgent',
      recordKind: 'Task',
    });
    const result = await resolveTransition(envelope, makeDeps(substrate));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.deliveryId).toBe('d-XYZ');
      expect(result.transition.kind).toBe('task');
      expect(result.transition.actor).toBe('PlannerAgent');
      expect(result.transition.recordKind).toBe('Task');
      expect(result.transition.payloadHash).toEqual(envelope.payloadHash);
      expect(result.transition.receivedAt).toEqual(envelope.receivedAt);
    }
  });
});

describe('resolveTransition — issues steady-state single-status-label (ledger-resolved)', () => {
  test('substrate has only the just-applied label + ledger has prior accepted transition → fromState=prior.toState', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['kind:goal', 'status:accepted']);
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'issues',
      actor: 'human',
      recordType: 'Issue',
      recordKind: 'Goal',
      recordId: 'I_kwAOA',
      fromState: '__initial__',
      toState: 'proposed',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(makeEnvelope(), makeDeps(substrate, ledger));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('proposed');
      expect(result.transition.toState).toBe('accepted');
    }
  });

  test('substrate has only the just-applied label + no prior in ledger → fromState=per-kind initial (Goal → proposed; issue #176)', async () => {
    // KIND-AWARE FALLBACK (issue #176 / #177 P1): an absent prior ledger row
    // on a labeled steady-state event resolves to the kind's initial state,
    // NOT the synthetic __initial__. For a Goal that is `proposed` (the
    // goal:proposed→accepted promote edge), so an agent/human status-label
    // write that races the issues.opened ledger row still resolves a
    // legitimate FSM edge instead of an FSM-flagged __initial__→accepted.
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['kind:goal', 'status:accepted']);

    const result = await resolveTransition(makeEnvelope(), makeDeps(substrate));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('proposed');
      expect(result.transition.toState).toBe('accepted');
    }
  });

  test('Task status:ready labeled with NO prior ledger row → task:proposed→ready (NOT __initial__→ready; closes #176, #177 P1)', async () => {
    // PlannerAgent's in-run root promotion applies status:ready to a freshly-
    // created Task immediately after issues.create — before the
    // issues.opened→proposed ledger row is guaranteed written. The kind-aware
    // fallback resolves the absent prior to the Task initial state `proposed`,
    // so the FSM sees the valid promote edge task:proposed→ready and dispatches
    // BuildAgent (the old __initial__→ready would be FSM-flagged + verdict-gated).
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_task_new', ['kind:task', 'status:ready']);

    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        recordId: 'I_task_new',
        actor: 'PlannerAgent',
        statusLabel: 'status:ready',
      }),
      makeDeps(substrate),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('proposed');
      expect(result.transition.toState).toBe('ready');
    }
  });
});

describe('resolveTransition — issues.labeled transition no-op (issue #181 close-race symmetry)', () => {
  test('status:done re-applied to an already-done Task → transition_no_op, observational (no self-loop flag)', async () => {
    // The post-merge completion path: OpsAgent applied status:done (ledger
    // already has *→done) AND closed the Task; the labeled half landing after
    // the close resolves fromState=done === toState=done. Settle observationally
    // instead of emitting task:done→done (which the FSM would flag terminal).
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_task_done', ['kind:task', 'status:done']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'I_task_done', 'done');

    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        recordId: 'I_task_done',
        actor: 'OpsAgent',
        statusLabel: 'status:done',
      }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('transition_no_op');
      expect(result.detail).toBe('task:done');
      expect(result.observational).toBe(true);
    }
  });

  test('close-completed on a Task already labeled status:done, ledger STALL ready (same-batch race) → issue_close_completed_observational, no duplicate transition', async () => {
    // Issue #178/#181 batch race: OpsAgent applied status:done then closed the
    // Task; both webhooks resolve in one validator batch, so the close reads the
    // ledger fromState BEFORE the label's →done row lands (stale `ready`). The
    // fromState===toState guard would MISS this (ready !== done) and emit a
    // DUPLICATE task:ready→done + PlannerAgent dispatch. The live label proves
    // the state is already done → observational.
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_task_closed', ['kind:task', 'status:done']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'I_task_closed', 'ready'); // stale: →done not yet appended

    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        recordId: 'I_task_closed',
        actor: 'OpsAgent',
        action: 'closed',
        issueStateReason: 'completed',
      }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('issue_close_completed_observational');
      expect(result.detail).toBe('task:done');
      expect(result.observational).toBe(true);
    }
  });

  test('close-completed on a Task NOT yet labeled done (human closed without status:done) → resolves the real transition', async () => {
    // The guard only fires on a live terminal label. A close-completed with no
    // status:done label is a genuine completion signal and must resolve normally.
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_task_raw', ['kind:task', 'status:in_review']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'I_task_raw', 'in_review');

    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        recordId: 'I_task_raw',
        actor: 'OpsAgent',
        action: 'closed',
        issueStateReason: 'completed',
      }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.toState).toBe('done');
    }
  });

  test('a genuine status change is NOT treated as a no-op (ready→done still resolves)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_task_x', ['kind:task', 'status:done']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'I_task_x', 'ready');

    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        recordId: 'I_task_x',
        actor: 'OpsAgent',
        statusLabel: 'status:done',
      }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('ready');
      expect(result.transition.toState).toBe('done');
    }
  });
});

describe('resolveTransition — issues.opened', () => {
  test('opened Goal with no initial status:* label → __initial__ → proposed (per-kind default)', async () => {
    const result = await resolveTransition(
      makeEnvelope({ action: 'opened', statusLabel: undefined, labels: ['kind:goal'] }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('__initial__');
      expect(result.transition.toState).toBe('proposed');
    }
  });

  test('opened Spec with no initial status:* label → __initial__ → drafting', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'opened',
        statusLabel: undefined,
        kind: 'spec',
        recordKind: 'Spec',
        recordId: 'S_kwAOA',
        actor: 'SpecAgent',
        labels: ['kind:spec'],
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('drafting');
  });

  test('opened Design with no initial status:* label → drafting', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'opened',
        statusLabel: undefined,
        kind: 'design',
        recordKind: 'Design',
        recordId: 'D_kwAOA',
        labels: ['kind:design'],
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('drafting');
  });

  test('opened Task with no initial status:* label → proposed', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'opened',
        statusLabel: undefined,
        kind: 'task',
        recordKind: 'Task',
        recordId: 'T_kwAOA',
        labels: ['kind:task'],
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('proposed');
  });

  test('opened Goal WITH initial status:proposed label → __initial__ → proposed (toState from label)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'opened',
        statusLabel: undefined,
        labels: ['kind:goal', 'status:proposed'],
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('__initial__');
      expect(result.transition.toState).toBe('proposed');
    }
  });

  test('opened with two status:* labels at creation → multiple_prior_status_labels (ADR-0006 violation; envelope.labels avoids the substrate-race window)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'opened',
        statusLabel: undefined,
        labels: ['kind:goal', 'status:proposed', 'status:accepted'],
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('multiple_prior_status_labels');
  });

  test('opened with prior transition in ledger (defensive — GitHub fires "reopened" not "opened") → uses prior.toState as fromState', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'issues',
      actor: 'human',
      recordType: 'Issue',
      recordKind: 'Goal',
      recordId: 'I_kwAOA',
      fromState: 'in_progress',
      toState: 'abandoned',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makeEnvelope({ action: 'opened', statusLabel: undefined, labels: ['kind:goal'] }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('abandoned');
      expect(result.transition.toState).toBe('proposed');
    }
  });

  test('opened with envelope.labels omitted → defaults to no status; uses per-kind initial', async () => {
    const result = await resolveTransition(
      makeEnvelope({ action: 'opened', statusLabel: undefined }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('proposed');
  });
});

describe('resolveTransition — issues.closed', () => {
  test('Goal closed with state_reason=completed → prior → achieved', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'issues',
      actor: 'human',
      recordType: 'Issue',
      recordKind: 'Goal',
      recordId: 'I_kwAOA',
      fromState: 'accepted',
      toState: 'in_progress',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        issueStateReason: 'completed',
      }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('in_progress');
      expect(result.transition.toState).toBe('achieved');
    }
  });

  test('Goal closed with state_reason=not_planned → abandoned', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        issueStateReason: 'not_planned',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('abandoned');
  });

  test('Task closed with state_reason=completed → done (per-kind terminal-success)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        kind: 'task',
        recordKind: 'Task',
        issueStateReason: 'completed',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('done');
  });

  test('Task closed with state_reason=not_planned → abandoned', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        kind: 'task',
        recordKind: 'Task',
        issueStateReason: 'not_planned',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('abandoned');
  });

  test('Spec closed with state_reason=not_planned → abandoned (uniform across kinds)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        kind: 'spec',
        recordKind: 'Spec',
        issueStateReason: 'not_planned',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('abandoned');
  });

  test('Decision closed with state_reason=completed → approved (PR #56 review fix: Decision template says ADR PR closes the issue; close-completed maps to the approved terminal per DECISION_TRANSITIONS)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'issues',
      actor: 'ReviewAgent',
      recordType: 'Issue',
      recordKind: 'Decision',
      recordId: 'I_kwAOA',
      fromState: 'drafting',
      toState: 'proposed',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        kind: 'decision',
        recordKind: 'Decision',
        issueStateReason: 'completed',
      }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('proposed');
      expect(result.transition.toState).toBe('approved');
    }
  });

  test('Decision close-completed when prior=approved → transition_no_op (PR #60 codex: ADR PR auto-close after ReviewAgent already approved; close is observational, not a transition)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'issues',
      actor: 'ReviewAgent',
      recordType: 'Issue',
      recordKind: 'Decision',
      recordId: 'I_kwAOA',
      fromState: 'proposed',
      toState: 'approved',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        kind: 'decision',
        recordKind: 'Decision',
        issueStateReason: 'completed',
        actor: 'OpsAgent', // The PR merger; not the original approver
      }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('transition_no_op');
      expect(result.detail).toBe('decision:approved');
      // Issue #181: a close that no-ops against the ledger settles cleanly,
      // not DLQ — OpsAgent now closes every completed Task on the success path.
      expect(result.observational).toBe(true);
    }
  });

  test('Decision closed with state_reason=not_planned → abandoned (uniform across kinds)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        kind: 'decision',
        recordKind: 'Decision',
        issueStateReason: 'not_planned',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('abandoned');
  });

  test('Spec closed with state_reason=completed → unsupported_close_state_reason (Spec ratification path is ready_for_review → ratified, not close)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        kind: 'spec',
        recordKind: 'Spec',
        issueStateReason: 'completed',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_close_state_reason');
      expect(result.detail).toBe('spec:completed');
    }
  });

  test('Design closed with state_reason=completed → unsupported_close_state_reason (same as Spec)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        kind: 'design',
        recordKind: 'Design',
        issueStateReason: 'completed',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_close_state_reason');
  });

  test('closed with no state_reason → unsupported_close_state_reason (cannot classify safely)', async () => {
    const result = await resolveTransition(
      makeEnvelope({ action: 'closed', statusLabel: undefined }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_close_state_reason');
  });

  test('closed without prior in ledger → __initial__ → abandoned (FSM will flag illegal_transition — we missed prior events)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'closed',
        statusLabel: undefined,
        issueStateReason: 'not_planned',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('__initial__');
      expect(result.transition.toState).toBe('abandoned');
    }
  });
});

describe('resolveTransition — issues.reopened', () => {
  test('Goal reopened with prior=achieved in ledger → achieved → proposed (FSM will flag illegal_transition since achieved is terminal)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'issues',
      actor: 'system',
      recordType: 'Issue',
      recordKind: 'Goal',
      recordId: 'I_kwAOA',
      fromState: 'in_progress',
      toState: 'achieved',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makeEnvelope({ action: 'reopened', statusLabel: undefined }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('achieved');
      expect(result.transition.toState).toBe('proposed');
    }
  });

  test('Task reopened → prior.toState → proposed (Task per-kind initial)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'issues',
      actor: 'OpsAgent',
      recordType: 'Issue',
      recordKind: 'Task',
      recordId: 'T_kwAOA',
      fromState: 'in_review',
      toState: 'done',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makeEnvelope({
        action: 'reopened',
        statusLabel: undefined,
        kind: 'task',
        recordKind: 'Task',
        recordId: 'T_kwAOA',
      }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('done');
      expect(result.transition.toState).toBe('proposed');
    }
  });

  test('reopened with no prior in ledger → __initial__ → proposed (still emits; FSM flags)', async () => {
    const result = await resolveTransition(
      makeEnvelope({ action: 'reopened', statusLabel: undefined }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.fromState).toBe('__initial__');
  });
});

describe('resolveTransition — issues.unlabeled', () => {
  test('unlabeled status:proposed → status_label_removed (substrate invariant violation; Decision FSM v0+ consumes)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'unlabeled',
        statusLabel: undefined,
        removedLabel: 'status:proposed',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('status_label_removed');
      expect(result.detail).toBe('status:proposed');
    }
  });

  test('unlabeled status:ready with LEDGERED status:done remaining → observational ledger-converging cleanup (issue #180: OpsAgent post-merge apply-then-remove)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['kind:task', 'status:done']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'I_kwAOA', 'done');
    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        action: 'unlabeled',
        statusLabel: undefined,
        removedLabel: 'status:ready',
      }),
      makeDeps(substrate, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('status_label_removed_observational');
      expect(result.detail).toBe('status:ready');
      expect(result.observational).toBe(true);
    }
  });

  test('REVERSAL: unlabeled the LEDGERED status:done while a leftover status:ready remains → status_label_removed violation (codex round 3 — the old remaining-label rule acked this)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['kind:task', 'status:ready']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'I_kwAOA', 'done');
    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        action: 'unlabeled',
        statusLabel: undefined,
        removedLabel: 'status:done',
      }),
      makeDeps(substrate, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('status_label_removed');
      expect(result.detail).toBe('status:done');
      expect(result.observational).toBeUndefined();
    }
  });

  test('same-batch swap (codex round 4 P2b): ledger stale at ready, unlabeled status:ready with status:done remaining → observational (legal task edge ready→done)', async () => {
    // The apply+remove pair arrived in ONE Service Bus batch: the consumer
    // resolves the whole batch BEFORE processMessage appends rows, so the
    // removal still sees ledger=ready while status:done was applied earlier
    // in the same batch. The remaining status:done is one legal task FSM edge
    // forward from the removed state → FSM-forward swap, observational.
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['kind:task', 'status:done']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'I_kwAOA', 'ready');
    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        action: 'unlabeled',
        statusLabel: undefined,
        removedLabel: 'status:ready',
      }),
      makeDeps(substrate, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('status_label_removed_observational');
      expect(result.detail).toBe('status:ready');
      expect(result.observational).toBe(true);
    }
  });

  test('status removal with NO prior ledger row → status_label_removed violation even when another status label remains (conservative — no ledgered state to converge toward)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['kind:task', 'status:done']);
    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        action: 'unlabeled',
        statusLabel: undefined,
        removedLabel: 'status:ready',
      }),
      makeDeps(substrate),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('status_label_removed');
      expect(result.observational).toBeUndefined();
    }
  });

  test('unlabeled the ONLY status label on an issue → status_label_removed violation, NOT observational (issue #180)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['kind:task', 'priority:p1']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'I_kwAOA', 'ready');
    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        action: 'unlabeled',
        statusLabel: undefined,
        removedLabel: 'status:ready',
      }),
      makeDeps(substrate, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('status_label_removed');
      expect(result.observational).toBeUndefined();
    }
  });

  test('unlabeled kind:goal → kind_label_removed (ADR-0006 invariant violation)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'unlabeled',
        statusLabel: undefined,
        removedLabel: 'kind:goal',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('kind_label_removed');
      expect(result.detail).toBe('kind:goal');
    }
  });

  test('unlabeled non-substrate label (priority:p1) → unsupported_action (not a policy event)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        action: 'unlabeled',
        statusLabel: undefined,
        removedLabel: 'priority:p1',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_action');
      expect(result.detail).toBe('unlabeled:priority:p1');
    }
  });

  test('unlabeled with no label name in envelope → unsupported_action (defensive)', async () => {
    const result = await resolveTransition(
      makeEnvelope({ action: 'unlabeled', statusLabel: undefined }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_action');
  });
});

describe('resolveTransition — issues.edited (codex round 4 P2a: observational, never DLQ)', () => {
  test('human-sent body edit → issue_edited_observational, settled cleanly (state is label-driven; an edit is not a transition)', async () => {
    const result = await resolveTransition(
      makeEnvelope({ action: 'edited', statusLabel: undefined, actor: 'human' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('issue_edited_observational');
      expect(result.observational).toBe(true);
    }
  });

  test('agent-sent edit (BuildAgent appendToBody pr-ref backlink PATCH) → issue_edited_observational, settled cleanly (no DLQ row per backlink write)', async () => {
    const result = await resolveTransition(
      makeEnvelope({
        kind: 'task',
        recordKind: 'Task',
        action: 'edited',
        statusLabel: undefined,
        actor: 'BuildAgent',
      }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('issue_edited_observational');
      expect(result.detail).toBe('BuildAgent');
      expect(result.observational).toBe(true);
    }
  });
});

describe('resolveTransition — issues typed failures', () => {
  test('issues with unsupported action (milestoned/etc — closed/opened/reopened/unlabeled/edited have their own branches) → unsupported_action', async () => {
    const result = await resolveTransition(
      makeEnvelope({ action: 'milestoned', statusLabel: undefined }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_action');
      expect(result.detail).toBe('milestoned');
    }
  });

  test('labeled with non-status label → no_status_label', async () => {
    const result = await resolveTransition(
      makeEnvelope({ action: 'labeled', statusLabel: undefined }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_status_label');
  });

  test('race: just-applied statusLabel removed before substrate read → applied_label_no_longer_present', async () => {
    const substrate = new InMemorySubstrateClient();
    // status:accepted is gone (removed mid-flight); only status:proposed survived.
    substrate.setLabels('I_kwAOA', ['kind:goal', 'status:proposed']);
    const result = await resolveTransition(makeEnvelope(), makeDeps(substrate));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('applied_label_no_longer_present');
      expect(result.detail).toBe('status:accepted');
    }
  });

  test('substrate has ≥2 prior status:* labels → multiple_prior_status_labels (ADR-0006 invariant violation)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', [
      'kind:goal',
      'status:proposed',
      'status:in_progress',
      'status:accepted',
    ]);
    const result = await resolveTransition(makeEnvelope(), makeDeps(substrate));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('multiple_prior_status_labels');
      const detail = result.detail ?? '';
      expect(detail).toContain('status:proposed');
      expect(detail).toContain('status:in_progress');
    }
  });

  test('unknown recordId in substrate → applied_label_no_longer_present (race guard fires first)', async () => {
    const substrate = new InMemorySubstrateClient();
    const result = await resolveTransition(makeEnvelope(), makeDeps(substrate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('applied_label_no_longer_present');
  });
});

function makePrEnvelope(overrides: Partial<ParsedWebhookEnvelope> = {}): ParsedWebhookEnvelope {
  return {
    deliveryId: 'd-pr-1',
    eventType: 'pull_request',
    kind: 'pr',
    actor: 'BuildAgent',
    recordType: 'PullRequest',
    recordKind: 'PullRequest',
    recordId: 'PR_kwAOA',
    payloadHash: createHash('sha256').update('p').digest(),
    action: 'opened',
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    draft: false,
    ...overrides,
  };
}

describe('resolveTransition — pull_request', () => {
  test('opened (draft=false) → __initial__ → open', async () => {
    const result = await resolveTransition(makePrEnvelope(), makeDeps());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('__initial__');
      expect(result.transition.toState).toBe('open');
    }
  });

  test('opened (draft=true) → __initial__ → draft', async () => {
    const result = await resolveTransition(makePrEnvelope({ draft: true }), makeDeps());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.toState).toBe('draft');
  });

  test('ready_for_review with prior=draft in ledger → draft → open', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: '__initial__',
      toState: 'draft',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makePrEnvelope({ action: 'ready_for_review' }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('draft');
      expect(result.transition.toState).toBe('open');
    }
  });

  test('closed with merged=true + prior=approved in ledger → approved → merged', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request_review',
      actor: 'ReviewAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'in_review',
      toState: 'approved',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makePrEnvelope({ action: 'closed', merged: true, actor: 'OpsAgent' }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('approved');
      expect(result.transition.toState).toBe('merged');
    }
  });

  test('closed with merged=true + prior=open in ledger → open → merged (FSM will flag admin-bypass merge of unapproved PR; the resolver no longer launders it as approved → merged)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: '__initial__',
      toState: 'open',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makePrEnvelope({ action: 'closed', merged: true }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('open');
      expect(result.transition.toState).toBe('merged');
    }
  });

  test('closed with merged=false + prior=in_review → in_review → closed', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'system',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'open',
      toState: 'in_review',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makePrEnvelope({ action: 'closed', merged: false }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('in_review');
      expect(result.transition.toState).toBe('closed');
    }
  });

  test('closed with no prior in ledger → __initial__ → closed (we missed the opened event; FSM will flag illegal_transition)', async () => {
    const result = await resolveTransition(
      makePrEnvelope({ action: 'closed', merged: false }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('__initial__');
      expect(result.transition.toState).toBe('closed');
    }
  });

  test('converted_to_draft → unsupported_action', async () => {
    const result = await resolveTransition(
      makePrEnvelope({ action: 'converted_to_draft' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_action');
  });

  test('synchronize → pr_event_observational, settled cleanly (fires on EVERY push to the PR branch, BuildAgent pushes included — issue #182)', async () => {
    const result = await resolveTransition(makePrEnvelope({ action: 'synchronize' }), makeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pr_event_observational');
      expect(result.detail).toBe('synchronize');
      expect(result.observational).toBe(true);
    }
  });

  test('edited → pr_event_observational, settled cleanly (PR body/title edits carry no FSM transition; state is native-event + status-label driven — issue #182)', async () => {
    const result = await resolveTransition(makePrEnvelope({ action: 'edited' }), makeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pr_event_observational');
      expect(result.detail).toBe('edited');
      expect(result.observational).toBe(true);
    }
  });

  test('review_requested with no prior → unsupported_action (we missed the opened event; prior=__initial__ is not a legit review-entry state per PR #46 rev3)', async () => {
    const result = await resolveTransition(
      makePrEnvelope({ action: 'review_requested' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_action');
  });

  test('review_requested with prior=in_review → unsupported_action (additional reviewer requested on already-reviewing PR; not a state transition — PR #46 rev3)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'human',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'open',
      toState: 'in_review',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makePrEnvelope({ action: 'review_requested', actor: 'human' }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_action');
  });

  test('review_requested with prior=approved → unsupported_action (cannot regress an approved PR back to in_review via a routine reviewer-add)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request_review',
      actor: 'ReviewAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'in_review',
      toState: 'approved',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makePrEnvelope({ action: 'review_requested', actor: 'human' }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_action');
      expect(result.detail).toBe('review_requested with prior=approved');
    }
  });

  test('review_requested with prior=open → open → in_review', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: '__initial__',
      toState: 'open',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makePrEnvelope({ action: 'review_requested', actor: 'human' }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('open');
      expect(result.transition.toState).toBe('in_review');
    }
  });
});

describe('resolveTransition — pull_request labeled (issue #178 structural review)', () => {
  const REVIEW_MARKER =
    '<!-- sf:structural sf:agent=review@opus-4-7 run=006F92T1MF2FBRG8T9Q321YMHN -->';

  async function ledgerWithPrState(toState: string): Promise<InMemoryAuditLedgerWriter> {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: '__initial__',
      toState,
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    return ledger;
  }

  test('labeled status:in_review on an open PR → open → in_review, actor=ReviewAgent (resolved from the comment marker on the multi-agent edge)', async () => {
    const substrate = new InMemorySubstrateClient();
    // The PR currently carries only the just-applied label (race guard sees it).
    substrate.setLabels('PR_kwAOA', ['status:in_review']);
    // ReviewAgent's structural findings comment authenticates the actor on the
    // REVIEW_REQUESTERS (multi-agent) edge where the single-agent fallback is
    // ambiguous.
    substrate.setComments('PR_kwAOA', [REVIEW_MARKER]);
    const ledger = await ledgerWithPrState('open');

    const result = await resolveTransition(
      makePrEnvelope({
        action: 'labeled',
        statusLabel: 'status:in_review',
        appActorUnresolved: true,
        actor: 'human', // the parser's non-authorizing placeholder
      }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('open');
      expect(result.transition.toState).toBe('in_review');
      expect(result.transition.actor).toBe('ReviewAgent');
    }
  });

  test('labeled status:approved on an in_review PR → in_review → approved, actor=ReviewAgent (single-agent FSM fallback, no marker needed)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('PR_kwAOA', ['status:approved']);
    const ledger = await ledgerWithPrState('in_review');

    const result = await resolveTransition(
      makePrEnvelope({
        action: 'labeled',
        statusLabel: 'status:approved',
        appActorUnresolved: true,
        actor: 'human',
      }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('in_review');
      expect(result.transition.toState).toBe('approved');
      // pr:in_review→approved admits exactly {human, ReviewAgent} → the single
      // agent (ReviewAgent) is resolved without any comment marker.
      expect(result.transition.actor).toBe('ReviewAgent');
    }
  });

  test('labeled status:changes_requested on an in_review PR → in_review → changes_requested, actor=ReviewAgent (issue #182, single-agent FSM fallback)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('PR_kwAOA', ['status:changes_requested']);
    const ledger = await ledgerWithPrState('in_review');

    const result = await resolveTransition(
      makePrEnvelope({
        action: 'labeled',
        statusLabel: 'status:changes_requested',
        appActorUnresolved: true,
        actor: 'human',
      }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('in_review');
      expect(result.transition.toState).toBe('changes_requested');
      // pr:in_review→changes_requested admits exactly {ReviewAgent} → resolved via
      // the single-agent FSM fallback, no comment marker needed.
      expect(result.transition.actor).toBe('ReviewAgent');
    }
  });

  test('labeled status:in_review on a changes_requested PR → changes_requested → in_review, actor=BuildAgent (issue #182 revision pushed)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('PR_kwAOA', ['status:in_review']);
    const ledger = await ledgerWithPrState('changes_requested');

    const result = await resolveTransition(
      makePrEnvelope({
        action: 'labeled',
        statusLabel: 'status:in_review',
        appActorUnresolved: true,
        actor: 'human',
      }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('changes_requested');
      expect(result.transition.toState).toBe('in_review');
      // pr:changes_requested→in_review admits exactly {BuildAgent} → single-agent
      // FSM fallback.
      expect(result.transition.actor).toBe('BuildAgent');
    }
  });

  test('unlabeled status:in_review with status:changes_requested remaining (ReviewAgent swap) → observational FSM-forward swap (issue #182)', async () => {
    const substrate = new InMemorySubstrateClient();
    // ReviewAgent applied status:changes_requested then removed status:in_review;
    // the ledger is still at in_review (same-batch window) and the remaining label
    // is a LEGAL pr edge forward from in_review → observational, not a violation.
    substrate.setLabels('PR_kwAOA', ['status:changes_requested']);
    const ledger = await ledgerWithPrState('in_review');

    const result = await resolveTransition(
      makePrEnvelope({ action: 'unlabeled', removedLabel: 'status:in_review' }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pr_status_label_removed_observational');
      expect(result.observational).toBe(true);
    }
  });

  test('unlabeled status:changes_requested with status:in_review remaining (BuildAgent swap) → observational FSM-forward swap (issue #182)', async () => {
    const substrate = new InMemorySubstrateClient();
    // BuildAgent applied status:in_review then removed status:changes_requested;
    // ledger still at changes_requested, remaining status:in_review is a legal pr
    // edge forward → observational.
    substrate.setLabels('PR_kwAOA', ['status:in_review']);
    const ledger = await ledgerWithPrState('changes_requested');

    const result = await resolveTransition(
      makePrEnvelope({ action: 'unlabeled', removedLabel: 'status:changes_requested' }),
      makeDeps(substrate, ledger),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pr_status_label_removed_observational');
      expect(result.observational).toBe(true);
    }
  });

  test('labeled status:approved mid-replacement (status:in_review still present) → fromState from the substrate prior label', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('PR_kwAOA', ['status:in_review', 'status:approved']);
    const result = await resolveTransition(
      makePrEnvelope({
        action: 'labeled',
        statusLabel: 'status:approved',
        appActorUnresolved: true,
        actor: 'human',
      }),
      makeDeps(substrate),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('in_review');
      expect(result.transition.toState).toBe('approved');
      expect(result.transition.actor).toBe('ReviewAgent');
    }
  });

  test('labeled but the applied label is no longer on the PR → applied_label_no_longer_present (race guard)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('PR_kwAOA', []); // label was removed before the resolver ran
    const result = await resolveTransition(
      makePrEnvelope({ action: 'labeled', statusLabel: 'status:in_review' }),
      makeDeps(substrate),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('applied_label_no_longer_present');
  });

  test('labeled with a non-status label (no statusLabel on the envelope) → no_status_label', async () => {
    const result = await resolveTransition(
      makePrEnvelope({ action: 'labeled', statusLabel: undefined }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_status_label');
  });

  test('unlabeled status:in_review with LEDGERED status:approved remaining → observational ledger-converging cleanup (issue #178 rev5 + codex round 3)', async () => {
    const substrate = new InMemorySubstrateClient();
    // The swap window: ReviewAgent applied status:approved BEFORE removing
    // status:in_review, the approved transition is already ledgered, so the
    // removal converges substrate toward the ledger.
    substrate.setLabels('PR_kwAOA', ['status:approved']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'PR_kwAOA', 'approved', 'PullRequest');
    const result = await resolveTransition(
      makePrEnvelope({ action: 'unlabeled', removedLabel: 'status:in_review' }),
      makeDeps(substrate, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pr_status_label_removed_observational');
      expect(result.detail).toBe('status:in_review');
      expect(result.observational).toBe(true);
    }
  });

  test('PR nuance (codex round 4): unlabeled the LEDGERED status:approved with status:in_review remaining → observational (prFsm HAS approved→in_review, changes-after-approval)', async () => {
    // Round 3 flagged this shape as a reversal violation; round 4's
    // FSM-forward case recognizes approved→in_review as a genuinely LEGAL
    // regression direction for PRs — and the labeled half of the same swap
    // ledgers the actual approved→in_review transition.
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('PR_kwAOA', ['status:in_review']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'PR_kwAOA', 'approved', 'PullRequest');
    const result = await resolveTransition(
      makePrEnvelope({ action: 'unlabeled', removedLabel: 'status:approved' }),
      makeDeps(substrate, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pr_status_label_removed_observational');
      expect(result.detail).toBe('status:approved');
      expect(result.observational).toBe(true);
    }
  });

  test('same-batch swap (codex round 4 P2b): ledger stale at in_review, unlabeled status:in_review with status:approved remaining → observational (legal pr edge in_review→approved)', async () => {
    // The apply+remove pair arrived in ONE Service Bus batch — the removal is
    // resolved before the apply's approved ledger row lands, so the ledger
    // still says in_review. status:approved remains, one legal pr FSM edge
    // forward from the removed state → FSM-forward swap, observational.
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('PR_kwAOA', ['status:approved']);
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'PR_kwAOA', 'in_review', 'PullRequest');
    const result = await resolveTransition(
      makePrEnvelope({ action: 'unlabeled', removedLabel: 'status:in_review' }),
      makeDeps(substrate, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pr_status_label_removed_observational');
      expect(result.detail).toBe('status:in_review');
      expect(result.observational).toBe(true);
    }
  });

  test('PR status removal with NO prior ledger row → status_label_removed violation even with another status label remaining (conservative)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('PR_kwAOA', ['status:approved']);
    const result = await resolveTransition(
      makePrEnvelope({ action: 'unlabeled', removedLabel: 'status:in_review' }),
      makeDeps(substrate),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('status_label_removed');
      expect(result.detail).toBe('status:in_review');
      expect(result.observational).toBeUndefined();
    }
  });

  test('unlabeled the ONLY status label on a PR → status_label_removed violation, NOT observational (issue #178 rev5)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('PR_kwAOA', ['area:webhook']); // no status:* remains
    const ledger = new InMemoryAuditLedgerWriter();
    await seedLedgerRow(ledger, 'PR_kwAOA', 'approved', 'PullRequest');
    const result = await resolveTransition(
      makePrEnvelope({ action: 'unlabeled', removedLabel: 'status:approved' }),
      makeDeps(substrate, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('status_label_removed');
      expect(result.detail).toBe('status:approved');
      expect(result.observational).toBeUndefined();
    }
  });

  test('unlabeled non-status label (area:webhook) → unsupported_action', async () => {
    const result = await resolveTransition(
      makePrEnvelope({ action: 'unlabeled', removedLabel: 'area:webhook' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_action');
  });
});

function makePrReviewEnvelope(
  overrides: Partial<ParsedWebhookEnvelope> = {},
): ParsedWebhookEnvelope {
  return {
    deliveryId: 'd-rev-1',
    eventType: 'pull_request_review',
    kind: 'pr',
    actor: 'ReviewAgent',
    recordType: 'PullRequest',
    recordKind: 'PullRequest',
    recordId: 'PR_kwAOA',
    payloadHash: createHash('sha256').update('p').digest(),
    action: 'submitted',
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    reviewState: 'approved',
    ...overrides,
  };
}

describe('resolveTransition — pull_request_review', () => {
  test('submitted state=approved with prior=in_review → in_review → approved', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'system',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'open',
      toState: 'in_review',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(makePrReviewEnvelope(), makeDeps(undefined, ledger));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('in_review');
      expect(result.transition.toState).toBe('approved');
    }
  });

  test('HUMAN native review (actor=human, no appActorUnresolved) approving the App PR still resolves in_review → approved (issue #178: humans CAN approve via native review)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'system',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'open',
      toState: 'in_review',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    // A human reviewer's native pull_request_review.submitted — the parser
    // resolves actor=human directly (no appActorUnresolved), so the native
    // path is untouched by the structural-label additions.
    const result = await resolveTransition(
      makePrReviewEnvelope({ actor: 'human' }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('in_review');
      expect(result.transition.toState).toBe('approved');
      expect(result.transition.actor).toBe('human');
    }
  });

  test('submitted state=changes_requested with prior=approved → approved → in_review (loop)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request_review',
      actor: 'ReviewAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'in_review',
      toState: 'approved',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makePrReviewEnvelope({ reviewState: 'changes_requested' }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('approved');
      expect(result.transition.toState).toBe('in_review');
    }
  });

  test('submitted state=changes_requested with prior=in_review → DEFERRED unsupported_review_state (issue #198: needs the downstream label+findings bridge, else the PR strands)', async () => {
    // A native CHANGES_REQUESTED review on an in_review PR is intentionally NOT
    // advanced: pr:in_review→changes_requested is a legal edge, but the #182
    // revision loop is label+findings-driven and a native review supplies
    // neither — accepting it would dispatch BuildAgent (which then skips/fails)
    // and strand the PR. Deferring leaves the record cleanly at in_review.
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'system',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'open',
      toState: 'in_review',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makePrReviewEnvelope({ reviewState: 'changes_requested', actor: 'human' }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_review_state');
      expect(result.detail).toBe('changes_requested');
    }
  });

  test('submitted state=changes_requested with prior=open → unsupported_review_state (no legal edge from open)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: '__initial__',
      toState: 'open',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makePrReviewEnvelope({ reviewState: 'changes_requested' }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_review_state');
      expect(result.detail).toBe('changes_requested');
    }
  });

  test('submitted state=commented → unsupported_review_state', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'system',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'open',
      toState: 'in_review',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makePrReviewEnvelope({ reviewState: 'commented' }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_review_state');
  });

  test('submitted with no prior in ledger → review_no_prior_pr_state (we missed the opened event)', async () => {
    const result = await resolveTransition(makePrReviewEnvelope(), makeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('review_no_prior_pr_state');
      expect(result.detail).toBe('approved');
    }
  });

  test('submitted state=approved with prior=open (ad-hoc review without review_requested) → review_not_in_review (defer; v0+ design gap for single-event-two-transition bridge)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: '__initial__',
      toState: 'open',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(makePrReviewEnvelope(), makeDeps(undefined, ledger));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('review_not_in_review');
      expect(result.detail).toBe('approved with prior=open');
    }
  });

  test('edited action → unsupported_action (only submitted carries transitions)', async () => {
    const result = await resolveTransition(makePrReviewEnvelope({ action: 'edited' }), makeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_action');
  });
});

function makeDeploymentEnvelope(
  overrides: Partial<ParsedWebhookEnvelope> = {},
): ParsedWebhookEnvelope {
  return {
    deliveryId: 'd-dep-1',
    eventType: 'deployment_status',
    kind: 'deployment',
    actor: 'system',
    recordType: 'Deployment',
    recordKind: 'Deployment',
    recordId: 'DE_kwAOA',
    payloadHash: createHash('sha256').update('p').digest(),
    action: 'created',
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    deploymentState: 'success',
    ...overrides,
  };
}

describe('resolveTransition — deployment_status (HARD-REJECT kind; ledger-resolved fromState)', () => {
  test('pending (first event, no prior in ledger) → __initial__ → pending', async () => {
    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'pending' }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('__initial__');
      expect(result.transition.toState).toBe('pending');
    }
  });

  test('in_progress (first event) → __initial__ → in_progress', async () => {
    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'in_progress' }),
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('__initial__');
      expect(result.transition.toState).toBe('in_progress');
    }
  });

  test('success with prior=in_progress in ledger → in_progress → success', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'deployment_status',
      actor: 'system',
      recordType: 'Deployment',
      recordKind: 'Deployment',
      recordId: 'DE_kwAOA',
      fromState: '__initial__',
      toState: 'in_progress',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'success' }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('in_progress');
      expect(result.transition.toState).toBe('success');
    }
  });

  test('failure with prior=in_progress in ledger → in_progress → failure', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'deployment_status',
      actor: 'system',
      recordType: 'Deployment',
      recordKind: 'Deployment',
      recordId: 'DE_kwAOA',
      fromState: '__initial__',
      toState: 'in_progress',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });

    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'failure' }),
      makeDeps(undefined, ledger),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('in_progress');
      expect(result.transition.toState).toBe('failure');
    }
  });

  test('success with NO prior in ledger → deployment_no_prior_terminal (defer rather than phantom-write under HARD-REJECT)', async () => {
    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'success' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('deployment_no_prior_terminal');
      expect(result.detail).toBe('success→success');
    }
  });

  test('failure with NO prior in ledger → deployment_no_prior_terminal', async () => {
    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'failure' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('deployment_no_prior_terminal');
  });

  test('error with NO prior in ledger → deployment_no_prior_terminal', async () => {
    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'error' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('deployment_no_prior_terminal');
  });

  test('deploymentState=queued → unsupported_deployment_state', async () => {
    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'queued' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_deployment_state');
      expect(result.detail).toBe('queued');
    }
  });

  test('deploymentState=waiting → awaiting_approval (env-approval gate; pending → awaiting_approval per deploymentFsm.ts)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'deployment_status',
      actor: 'system',
      recordType: 'Deployment',
      recordKind: 'Deployment',
      recordId: 'DE_kwAOA',
      fromState: '__initial__',
      toState: 'pending',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'waiting' }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('pending');
      expect(result.transition.toState).toBe('awaiting_approval');
    }
  });

  test('deploymentState=waiting with NO prior in ledger → deployment_no_prior_terminal (defer rather than phantom-write __initial__ → awaiting_approval, which HARD-REJECT FSM would treat as illegal_transition and trigger false policy violation)', async () => {
    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'waiting' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('deployment_no_prior_terminal');
      expect(result.detail).toBe('waiting→awaiting_approval');
    }
  });

  test('deploymentState=inactive → unsupported_deployment_state', async () => {
    const result = await resolveTransition(
      makeDeploymentEnvelope({ deploymentState: 'inactive' }),
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_deployment_state');
  });
});

describe('resolveTransition — headBranch/baseBranch passthrough (ADR 0012 §"Activation status" gate (a))', () => {
  // makeTransition must propagate the parser-extracted head/base from the
  // envelope onto the resolved transition; otherwise the orchestrator
  // never sees them and its branch-sync gate stays inert.

  test('PR opened envelope with head/base → transition carries both fields', async () => {
    const envelope = makePrEnvelope({
      headBranch: 'sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
      baseBranch: 'main',
    });
    const result = await resolveTransition(envelope, makeDeps());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.headBranch).toBe(
        'sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
      );
      expect(result.transition.baseBranch).toBe('main');
    }
  });

  test('PR envelope without head/base (e.g. missing from webhook) → transition fields undefined', async () => {
    const result = await resolveTransition(makePrEnvelope(), makeDeps());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.headBranch).toBeUndefined();
      expect(result.transition.baseBranch).toBeUndefined();
    }
  });

  test('issues envelope (Goal/Spec/Design/Task) → transition fields undefined (no PR semantics)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_kwAOA', ['kind:goal', 'status:proposed', 'status:accepted']);
    const result = await resolveTransition(makeEnvelope(), makeDeps(substrate));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.headBranch).toBeUndefined();
      expect(result.transition.baseBranch).toBeUndefined();
    }
  });
});

describe('resolveTransition — ADR 0009 §D App-actor resolution (appActorUnresolved)', () => {
  const SPEC_MARKER =
    '<!-- sf:structural sf:agent=spec@opus-4-8 run=006F92T1MF2FBRG8T9Q321YMHJ -->';
  const BUILD_MARKER =
    '<!-- sf:structural sf:agent=build@opus-4-8 run=006F92T1MF2FBRG8T9Q321YMHK -->';
  const REVIEW_MARKER =
    '<!-- sf:structural sf:agent=review@opus-4-8 run=006F92T1MF2FBRG8T9Q321YMHN -->';

  // Spec drafting → ready_for_review: SpecAgent is the ONLY allowed agent.
  function specEnvelope(): ParsedWebhookEnvelope {
    return makeEnvelope({
      kind: 'spec',
      recordKind: 'Spec',
      recordId: 'I_spec',
      statusLabel: 'status:ready_for_review',
      appActorUnresolved: true,
      actor: 'human', // the parser's non-authorizing placeholder
    });
  }

  // PR open → in_review (REVIEW_REQUESTERS = multi-agent) with a prior `open` row
  // — the ambiguous edge where comment-marker resolution actually runs.
  async function multiAgentPrEnvelope(
    substrate: InMemorySubstrateClient,
    comments: readonly string[],
  ): Promise<{ env: ParsedWebhookEnvelope; ledger: InMemoryAuditLedgerWriter }> {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-amb-prior',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_amb_marker',
      fromState: '__initial__',
      toState: 'open',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('amp').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    substrate.setComments('PR_amb_marker', comments);
    const env = makeEnvelope({
      eventType: 'pull_request',
      kind: 'pr',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_amb_marker',
      action: 'review_requested',
      statusLabel: undefined,
      appActorUnresolved: true,
      actor: 'human',
    });
    return { env, ledger };
  }

  test('AMBIGUOUS edge: most recent App-authored COMMENT marker wins over an older one', async () => {
    const substrate = new InMemorySubstrateClient();
    // Oldest-first: a review marker then a build marker — most recent (build) wins.
    const { env, ledger } = await multiAgentPrEnvelope(substrate, [REVIEW_MARKER, BUILD_MARKER]);
    const result = await resolveTransition(env, makeDeps(substrate, ledger));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.actor).toBe('BuildAgent');
  });

  test('SINGLE-AGENT edge ignores a stale unrelated comment marker → resolves via FSM (codex PR #152)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_spec', ['kind:spec', 'status:drafting', 'status:ready_for_review']);
    // A stale BuildAgent stamp lingers on the record from an earlier action; the
    // spec drafting→ready_for_review edge admits ONLY SpecAgent, so the stale
    // marker must NOT win — resolves SpecAgent via the unambiguous FSM fallback.
    substrate.setComments('I_spec', [BUILD_MARKER]);

    const result = await resolveTransition(specEnvelope(), makeDeps(substrate));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.actor).toBe('SpecAgent');
  });

  test('FALLBACK: no marker + single-agent edge → inferred agent (SpecAgent)', async () => {
    const substrate = new InMemorySubstrateClient();
    // Mid-replacement window so fromState=drafting is derived from the substrate;
    // no body, no comments → getStructuralMarkers returns undefined → fallback.
    substrate.setLabels('I_spec', ['kind:spec', 'status:drafting', 'status:ready_for_review']);

    const result = await resolveTransition(specEnvelope(), makeDeps(substrate));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.fromState).toBe('drafting');
      expect(result.transition.toState).toBe('ready_for_review');
      expect(result.transition.actor).toBe('SpecAgent');
    }
  });

  test('AMBIGUOUS: no marker + multi-agent edge → defer (actor_unresolved_app_sender)', async () => {
    // Spec ready_for_review → ratified allows human + ReviewAgent: zero single
    // agent (human excluded, ReviewAgent is the only agent → actually single).
    // Use a genuinely multi-agent edge: PR open → in_review (REVIEW_REQUESTERS:
    // BuildAgent, ReviewAgent, OpsAgent, ...). No marker → ambiguous → defer.
    const substrate = new InMemorySubstrateClient();
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_amb',
      fromState: '__initial__',
      toState: 'open',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('x').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    const env = makeEnvelope({
      eventType: 'pull_request',
      kind: 'pr',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_amb',
      action: 'review_requested',
      statusLabel: undefined,
      appActorUnresolved: true,
      actor: 'human',
    });
    const result = await resolveTransition(env, makeDeps(substrate, ledger));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('actor_unresolved_app_sender');
  });

  test('marker PRIMARY beats the single-agent fallback (an ambiguous edge still resolves via marker)', async () => {
    const substrate = new InMemorySubstrateClient();
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior2',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_marker',
      fromState: '__initial__',
      toState: 'open',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('y').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    substrate.setComments('PR_marker', [BUILD_MARKER]);
    const env = makeEnvelope({
      eventType: 'pull_request',
      kind: 'pr',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_marker',
      action: 'review_requested',
      statusLabel: undefined,
      appActorUnresolved: true,
      actor: 'human',
    });
    const result = await resolveTransition(env, makeDeps(substrate, ledger));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.actor).toBe('BuildAgent');
  });

  test('appActorUnresolved unset → actor passes through unchanged (human/agent paths intact)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_spec', ['kind:spec', 'status:drafting', 'status:ready_for_review']);
    // SpecAgent-login resolved in the parser; resolver must NOT touch it.
    const env = makeEnvelope({
      kind: 'spec',
      recordKind: 'Spec',
      recordId: 'I_spec',
      statusLabel: 'status:ready_for_review',
      actor: 'SpecAgent',
    });
    const result = await resolveTransition(env, makeDeps(substrate));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.actor).toBe('SpecAgent');
  });

  // codex PR #152 P2 — marker author authentication. Comments/bodies are
  // human-writable, so a structural marker is trusted ONLY when posted by the
  // App; a forged marker must NOT steal attribution.
  test('SECURITY: a marker in a NON-App-authored comment is forged → ignored → defer', async () => {
    const substrate = new InMemorySubstrateClient();
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-forged',
      eventType: 'pull_request',
      actor: 'BuildAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_forged',
      fromState: '__initial__',
      toState: 'open',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('z').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    // A human plants a build marker; the edge (PR open→in_review) is multi-agent
    // so there is no single-agent fallback. Forged marker ignored → defer.
    substrate.setComments('PR_forged', [BUILD_MARKER], 'mallory');
    const env = makeEnvelope({
      eventType: 'pull_request',
      kind: 'pr',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_forged',
      action: 'review_requested',
      statusLabel: undefined,
      appActorUnresolved: true,
      actor: 'human',
    });
    const result = await resolveTransition(env, makeDeps(substrate, ledger));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('actor_unresolved_app_sender');
  });

  // codex PR #152 — the resolver MUST authenticate markers against the same
  // configured App-bot login set the parser used (deps.appBotLogins), not just
  // the env-derived default; otherwise a config-supplied slug parses the sender
  // but its own markers are rejected.
  test('configured appBotLogins (deps) authenticates a non-default App-bot marker', async () => {
    const substrate = new InMemorySubstrateClient();
    // Comment authored by a configured (non-default) App login on a multi-agent
    // edge. The env default set does NOT include this login.
    const { env, ledger } = await multiAgentPrEnvelope(substrate, []);
    substrate.setComments('PR_amb_marker', [BUILD_MARKER], 'sfac-custom[bot]');

    // Without the configured set → marker rejected → defer.
    const noConfig = await resolveTransition(env, { substrate, ledger: ledger });
    expect(noConfig.ok).toBe(false);

    // With the configured set threaded into deps → marker trusted → BuildAgent.
    const withConfig = await resolveTransition(env, {
      substrate,
      ledger,
      appBotLogins: new Set(['sfac-custom[bot]']),
    });
    expect(withConfig.ok).toBe(true);
    if (withConfig.ok) expect(withConfig.transition.actor).toBe('BuildAgent');
  });

  // codex PR #152 — an unmarked App transition on a {system, single-agent} edge
  // RESOLVES that agent (it is NOT deferred): both actors are FSM-authorized, so
  // attributing the agent is no escalation, and the review-loop / deployment
  // flows that ride such edges have no other marker channel. Here PR
  // approved→in_review = {human, ReviewAgent, system} → ReviewAgent.
  test('unmarked App transition on a {system, ReviewAgent} edge resolves the agent (no defer)', async () => {
    const ledger = new InMemoryAuditLedgerWriter();
    await ledger.append({
      deliveryId: 'd-prior-loop',
      eventType: 'pull_request_review',
      actor: 'ReviewAgent',
      recordType: 'PullRequest',
      recordKind: 'PullRequest',
      recordId: 'PR_kwAOA',
      fromState: 'in_review',
      toState: 'approved',
      verdict: 'accept',
      payloadHash: createHash('sha256').update('prior-loop').digest(),
      receivedAt: new Date('2026-05-30T17:00:00Z'),
    });
    // changes_requested after approval = approved→in_review {human, ReviewAgent,
    // system}; the App is the non-authorizing placeholder, no marker → fallback.
    const result = await resolveTransition(
      makePrReviewEnvelope({
        reviewState: 'changes_requested',
        appActorUnresolved: true,
        actor: 'human',
      }),
      makeDeps(undefined, ledger),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.actor).toBe('ReviewAgent');
  });

  // The creation-edge body path is real for a MULTI-AGENT creation edge: Decision
  // __initial__→drafting = AUTHOR_ACTORS (many agents) → single-agent fallback is
  // ambiguous → the App-authored body's creator stamp resolves it.
  test('creation-edge body marker (App-authored) resolves a multi-agent Decision edge → SpecAgent', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_dec', {
      body: `${SPEC_MARKER}\nthe decision`,
      labels: ['kind:decision'],
    }); // authorLogin defaults to the App bot
    const env = makeEnvelope({
      action: 'opened',
      statusLabel: undefined,
      kind: 'decision',
      recordKind: 'Decision',
      recordId: 'I_dec',
      labels: ['kind:decision'],
      appActorUnresolved: true,
      actor: 'human',
    });
    const result = await resolveTransition(env, makeDeps(substrate));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.actor).toBe('SpecAgent');
  });

  // codex PR #152 P2 — the creation-edge body path is ALSO author-authenticated:
  // a human-opened Decision body marker is forged → must NOT resolve → defer.
  test('SECURITY: a creation-edge body marker from a NON-App author is forged → defer', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_dec_forged', {
      body: `${SPEC_MARKER}\nthe decision`,
      labels: ['kind:decision'],
      authorLogin: 'mallory',
    });
    const env = makeEnvelope({
      action: 'opened',
      statusLabel: undefined,
      kind: 'decision',
      recordKind: 'Decision',
      recordId: 'I_dec_forged',
      labels: ['kind:decision'],
      appActorUnresolved: true,
      actor: 'human',
    });
    const result = await resolveTransition(env, makeDeps(substrate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('actor_unresolved_app_sender');
  });
});
