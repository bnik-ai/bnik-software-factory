import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { runCrossRecordAssertions } from '../src/crossRecordAssertions.js';
import type { ParsedTransitionMessage } from '../src/queueConsumer.js';
import { InMemorySubstrateClient } from '../src/substrateClient.js';

// Spec: docs/decisions/0003-cross-repo-delivery.md "Linking model" + ADR 0007
// (v0 carrier = Issue body input fields). Three v0 assertions:
//   1. spec/design/task with `parent-goal:` field → referenced Goal exists + kind:goal
//   2. design with `spec-ref:` field → referenced Spec exists + kind:spec
//   3. task with `design-ref:` field → referenced Design exists + kind:design
// Failure surface: { ok: false; assertion; detail } typed result. The
// processMessage wiring downgrades verdict accept→flag on failure;
// these tests pin the pure function only.

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.transitioned',
    kind: 'task',
    actor: 'BuildAgent',
    recordType: 'Issue',
    recordKind: 'Task',
    recordId: 'I_task_1',
    fromState: 'proposed',
    toState: 'ready',
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-29T18:00:00Z'),
    ...overrides,
  };
}

describe('runCrossRecordAssertions — kinds without body refs are silent', () => {
  test.each(['goal', 'pr', 'deployment', 'decision'] as const)(
    '%s message: ok=true even with no substrate seeding',
    async (kind) => {
      const substrate = new InMemorySubstrateClient();
      const result = await runCrossRecordAssertions(
        makeMessage({ kind, recordId: `I_${kind}_1` }),
        substrate,
      );
      expect(result).toEqual({ ok: true });
    },
  );
});

describe('runCrossRecordAssertions — message record not in substrate', () => {
  test('task message with no substrate view → ok=true (upstream resolver gap, not a violation)', async () => {
    const substrate = new InMemorySubstrateClient();
    const result = await runCrossRecordAssertions(makeMessage(), substrate);
    expect(result).toEqual({ ok: true });
  });
});

describe('runCrossRecordAssertions — Spec happy + failure modes', () => {
  test('spec with valid parent-goal: pointing at Goal with kind:goal → ok', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'goal body', labels: ['kind:goal'] });
    substrate.setIssue('I_spec_1', {
      body: 'parent-goal: I_goal_42\n\nSome spec body',
      labels: ['kind:spec'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'spec', recordId: 'I_spec_1' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });

  test('spec with parent-goal: pointing at missing record → parent_goal_missing', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_spec_1', {
      body: 'parent-goal: I_missing\n\nSome spec body',
      labels: ['kind:spec'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'spec', recordId: 'I_spec_1' }),
      substrate,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('parent_goal_missing');
    expect(result.detail).toContain('I_missing');
  });

  test('spec with parent-goal: pointing at non-Goal (kind:spec) → parent_goal_missing', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_not_a_goal', { body: 'x', labels: ['kind:spec'] });
    substrate.setIssue('I_spec_1', {
      body: 'parent-goal: I_not_a_goal\n\nSome spec body',
      labels: ['kind:spec'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'spec', recordId: 'I_spec_1' }),
      substrate,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('parent_goal_missing');
    expect(result.detail).toContain('kind:goal');
  });

  test('spec body with NO parent-goal field → ok (form-level gate, not this layer)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_spec_1', { body: 'just freeform body', labels: ['kind:spec'] });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'spec', recordId: 'I_spec_1' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('runCrossRecordAssertions — Design happy + failure modes', () => {
  function seedHappyDesign(): InMemorySubstrateClient {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_spec_88', { body: 's', labels: ['kind:spec'] });
    substrate.setIssue('I_design_1', {
      body: 'parent-goal: I_goal_42\nspec-ref: I_spec_88\n\nDesign body',
      labels: ['kind:design'],
    });
    return substrate;
  }

  test('design with valid parent-goal + spec-ref → ok', async () => {
    const substrate = seedHappyDesign();
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'design', recordId: 'I_design_1' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });

  test('design with missing parent-goal target → parent_goal_missing', async () => {
    const substrate = seedHappyDesign();
    substrate.setIssue('I_design_1', {
      body: 'parent-goal: I_does_not_exist\nspec-ref: I_spec_88\n\nbody',
      labels: ['kind:design'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'design', recordId: 'I_design_1' }),
      substrate,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('parent_goal_missing');
  });

  test('design with spec-ref pointing at missing record → spec_ref_invalid', async () => {
    const substrate = seedHappyDesign();
    substrate.setIssue('I_design_1', {
      body: 'parent-goal: I_goal_42\nspec-ref: I_no_such_spec\n\nbody',
      labels: ['kind:design'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'design', recordId: 'I_design_1' }),
      substrate,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('spec_ref_invalid');
    expect(result.detail).toContain('I_no_such_spec');
  });

  test('design with spec-ref pointing at a Goal (wrong kind) → spec_ref_invalid', async () => {
    const substrate = seedHappyDesign();
    substrate.setIssue('I_design_1', {
      body: 'parent-goal: I_goal_42\nspec-ref: I_goal_42\n\nbody',
      labels: ['kind:design'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'design', recordId: 'I_design_1' }),
      substrate,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('spec_ref_invalid');
    expect(result.detail).toContain('kind:spec');
  });
});

describe('runCrossRecordAssertions — Task happy + failure modes', () => {
  function seedHappyTask(): InMemorySubstrateClient {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_design_99', { body: 'd', labels: ['kind:design'] });
    substrate.setIssue('I_task_1', {
      body: 'parent-goal: I_goal_42\ndesign-ref: I_design_99\n\nTask body',
      labels: ['kind:task'],
    });
    return substrate;
  }

  test('task with valid parent-goal + design-ref → ok', async () => {
    const substrate = seedHappyTask();
    const result = await runCrossRecordAssertions(makeMessage(), substrate);
    expect(result).toEqual({ ok: true });
  });

  test('task with parent-goal target missing → parent_goal_missing', async () => {
    const substrate = seedHappyTask();
    substrate.setIssue('I_task_1', {
      body: 'parent-goal: I_phantom_goal\ndesign-ref: I_design_99\n\nbody',
      labels: ['kind:task'],
    });
    const result = await runCrossRecordAssertions(makeMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('parent_goal_missing');
  });

  test('task with design-ref pointing at missing record → design_ref_invalid', async () => {
    const substrate = seedHappyTask();
    substrate.setIssue('I_task_1', {
      body: 'parent-goal: I_goal_42\ndesign-ref: I_nonexistent\n\nbody',
      labels: ['kind:task'],
    });
    const result = await runCrossRecordAssertions(makeMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('design_ref_invalid');
    expect(result.detail).toContain('I_nonexistent');
  });

  test('task with design-ref pointing at a Spec (wrong kind) → design_ref_invalid', async () => {
    const substrate = seedHappyTask();
    substrate.setIssue('I_some_spec', { body: 's', labels: ['kind:spec'] });
    substrate.setIssue('I_task_1', {
      body: 'parent-goal: I_goal_42\ndesign-ref: I_some_spec\n\nbody',
      labels: ['kind:task'],
    });
    const result = await runCrossRecordAssertions(makeMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('design_ref_invalid');
    expect(result.detail).toContain('kind:design');
  });
});

describe('runCrossRecordAssertions — field-extraction edge cases', () => {
  test('parent-goal: line preceded by other content is still found', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_spec_1', {
      body: '## Summary\n\nSome text\n\nparent-goal: I_goal_42\n\nmore body',
      labels: ['kind:spec'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'spec', recordId: 'I_spec_1' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });

  test('parent-goal: with extra whitespace around the value is trimmed', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_spec_1', {
      body: 'parent-goal:   I_goal_42   \n\nbody',
      labels: ['kind:spec'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'spec', recordId: 'I_spec_1' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });

  test('parent-goal: with empty value is treated as absent (no assertion)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_spec_1', {
      body: 'parent-goal: \n\nbody',
      labels: ['kind:spec'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'spec', recordId: 'I_spec_1' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('runCrossRecordAssertions — issue-form heading-rendered carrier (ADR 0007)', () => {
  test('spec from a form (### parent-goal heading) is parsed + validated', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_spec_1', {
      body: '### parent-goal\n\nI_goal_42\n\n### Acceptance criteria\n\n- x',
      labels: ['kind:spec'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'spec', recordId: 'I_spec_1' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });

  test('design from a form (### parent-goal + ### spec-ref) validates both', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_spec_88', { body: 's', labels: ['kind:spec'] });
    substrate.setIssue('I_design_1', {
      body: '### parent-goal\n\nI_goal_42\n\n### spec-ref\n\nI_spec_88\n\n### design-doc\n\ndocs/x.md',
      labels: ['kind:design'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'design', recordId: 'I_design_1' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });

  test('task from a form with ### design-ref at a missing record → design_ref_invalid', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_goal_42', { body: 'g', labels: ['kind:goal'] });
    substrate.setIssue('I_task_1', {
      body: '### parent-goal\n\nI_goal_42\n\n### design-ref\n\nI_nope\n\n### blocked-by\n\n_No response_',
      labels: ['kind:task'],
    });
    const result = await runCrossRecordAssertions(makeMessage(), substrate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.assertion).toBe('design_ref_invalid');
    expect(result.detail).toContain('I_nope');
  });

  test('form field left empty (_No response_) is treated as absent', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_spec_1', {
      body: '### parent-goal\n\n_No response_\n\n### Acceptance criteria\n\n- x',
      labels: ['kind:spec'],
    });
    const result = await runCrossRecordAssertions(
      makeMessage({ kind: 'spec', recordId: 'I_spec_1' }),
      substrate,
    );
    expect(result).toEqual({ ok: true });
  });
});
