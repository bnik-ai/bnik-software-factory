import { describe, expect, test } from 'vitest';
import { StubIssueTool } from '../../src/tools/issueTool.js';

describe('StubIssueTool', () => {
  test('read returns seeded record + defensive copy of labels', async () => {
    const tool = new StubIssueTool();
    tool.seedRecord({
      recordId: 'I_kwAOA',
      labels: ['kind:goal', 'status:proposed'],
      body: 'goal body',
    });
    const r = await tool.read('I_kwAOA');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.labels).toEqual(['kind:goal', 'status:proposed']);
      (r.value.labels as string[]).push('mutated');
      const r2 = await tool.read('I_kwAOA');
      if (r2.ok) expect(r2.value.labels).toEqual(['kind:goal', 'status:proposed']);
    }
  });

  test('read returns typed failure for unknown recordId', async () => {
    const tool = new StubIssueTool();
    const r = await tool.read('I_missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('record_not_found:I_missing');
  });

  test('applyLabel + removeLabel record args', async () => {
    const tool = new StubIssueTool();
    await tool.applyLabel({ recordId: 'I_1', label: 'status:accepted' });
    await tool.removeLabel({ recordId: 'I_1', label: 'status:proposed' });
    expect(tool.labelApplyHistory()[0]?.label).toBe('status:accepted');
    expect(tool.labelRemoveHistory()[0]?.label).toBe('status:proposed');
  });

  test('comment with structural marker records role + run', async () => {
    const tool = new StubIssueTool();
    await tool.comment({
      recordId: 'PR_1',
      body: 'request changes: missing test',
      structural: { role: 'ReviewAgent', run: '01HV6XXXXXXXXXXXXXXXXXXXXX' },
    });
    const c = tool.commentHistory()[0];
    expect(c?.structural?.role).toBe('ReviewAgent');
    expect(c?.body).toBe('request changes: missing test');
  });

  test('create issues an auto-incremented number + node_id and auto-seeds for read', async () => {
    const tool = new StubIssueTool();
    const created = await tool.create({
      repo: 'example-org/software-factory',
      title: 'Spec: New thing',
      body: 'parent-goal: I_kwAOA_goal_42\n\nbody',
      labels: ['kind:spec'],
      structural: { role: 'SpecAgent', run: '01HV6XXXXXXXXXXXXXXXXXXXXX' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.number).toBe(1);
    expect(created.value.recordId).toMatch(/^I_stub_example_org_software_factory_1$/);

    // Second create increments.
    const created2 = await tool.create({
      repo: 'example-org/software-factory',
      title: 'Spec: Another thing',
      body: 'body',
      labels: ['kind:spec'],
    });
    if (created2.ok) expect(created2.value.number).toBe(2);

    // Auto-seed: subsequent read returns the synthetic record.
    const readBack = await tool.read(created.value.recordId);
    expect(readBack.ok).toBe(true);
    if (readBack.ok) {
      expect(readBack.value.labels).toEqual(['kind:spec']);
      expect(readBack.value.body).toContain('parent-goal');
    }

    expect(tool.createHistory()).toHaveLength(2);
    expect(tool.createHistory()[0]?.title).toBe('Spec: New thing');
  });

  test('listComments returns comment() writes + seedComment seeds, both with structural', async () => {
    const tool = new StubIssueTool();
    // Pre-seed a ReviewAgent request-changes findings comment on a PR.
    tool.seedComment('PR_1', {
      commentId: 'c-seed',
      body: 'Missing tests.',
      structural: { role: 'review@opus-4-7', run: '01HRUN', verdict: 'request-changes' },
    });
    // A subsequent comment() write also lands in the per-record store.
    await tool.comment({
      recordId: 'PR_1',
      body: 'BuildAgent revision marker.',
      structural: { role: 'build@opus-4-7', run: '01HBUILD' },
    });

    const listed = await tool.listComments('PR_1');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(2);
    expect(listed.value[0]?.structural).toMatchObject({ verdict: 'request-changes' });
    expect(listed.value[1]?.body).toBe('BuildAgent revision marker.');

    // A record with no comments returns an empty list (not a failure).
    const none = await tool.listComments('PR_unseen');
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.value).toHaveLength(0);
  });
});
