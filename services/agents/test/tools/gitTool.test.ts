import { describe, expect, test } from 'vitest';
import { StubGitTool } from '../../src/tools/gitTool.js';

describe('StubGitTool', () => {
  test('branch records args + returns the requested name', async () => {
    const tool = new StubGitTool();
    const result = await tool.branch({ name: 'sf/T-42/01HV6/build@opus-4-7' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('sf/T-42/01HV6/build@opus-4-7');
    expect(tool.branchHistory()).toHaveLength(1);
  });

  test('commit records ADR 0009 trailer args + returns monotonic sha', async () => {
    const tool = new StubGitTool();
    const r1 = await tool.commit({
      message: 'feat: foo',
      authorAgent: 'BuildAgent',
      authorRun: '01HV6XXXXXXXXXXXXXXXXXXXXX',
      authorTask: 'T-42',
    });
    const r2 = await tool.commit({
      message: 'fix: bar',
      authorAgent: 'BuildAgent',
      authorRun: '01HV6XXXXXXXXXXXXXXXXXXXXX',
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.sha).toMatch(/^stub-sha-[0-9a-f]{8}$/);
      expect(r2.value.sha).not.toBe(r1.value.sha);
    }
    expect(tool.commitHistory()).toHaveLength(2);
  });

  test('push records branch + setUpstream', async () => {
    const tool = new StubGitTool();
    await tool.push({ branch: 'sf/T-42/01HV6/build@opus-4-7', setUpstream: true });
    expect(tool.pushHistory()[0]?.setUpstream).toBe(true);
  });

  test('push records forceWithLease for rebase-and-force-push flow (ADR 0012)', async () => {
    const tool = new StubGitTool();
    await tool.push({ branch: 'sf/T-42/01HV6/build@opus-4-7', forceWithLease: true });
    expect(tool.pushHistory()[0]?.forceWithLease).toBe(true);
  });

  test('rebase records args + returns distinct old/new head SHAs (default treeChanged=false, head changes)', async () => {
    const tool = new StubGitTool();
    const r = await tool.rebase({
      headBranch: 'sf/T-42/01HV6/build@opus-4-7',
      baseBranch: 'main',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.oldHeadSha).toMatch(/^stub-pre-rebase-sha-[0-9a-f]{8}$/);
      expect(r.value.newHeadSha).toMatch(/^stub-rebase-sha-[0-9a-f]{8}$/);
      // Default: head SHA changes every rebase (models the common case
      // where main advanced and the rebase rewrote commits). treeChanged
      // defaults false (tree-equality is independent of head-equality).
      expect(r.value.oldHeadSha).not.toBe(r.value.newHeadSha);
      expect(r.value.treeChanged).toBe(false);
    }
    expect(tool.rebaseHistory()).toHaveLength(1);
    expect(tool.rebaseHistory()[0]?.baseBranch).toBe('main');
  });

  test('setNextRebaseTreeChanged toggles the next rebase result (one-shot)', async () => {
    const tool = new StubGitTool();
    tool.setNextRebaseTreeChanged(true);
    const r1 = await tool.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    const r2 = await tool.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    if (r1.ok) expect(r1.value.treeChanged).toBe(true);
    if (r2.ok) expect(r2.value.treeChanged).toBe(false); // one-shot
  });

  test('setNextRebaseHeadUnchanged forces oldHeadSha === newHeadSha (one-shot)', async () => {
    // BuildAgent's push gate is HEAD-equality. The stub
    // defaults to head-changed (push fires); this setter models the
    // truly-no-op rebase (already current, nothing to rewrite).
    const tool = new StubGitTool();
    tool.setNextRebaseHeadUnchanged(true);
    const r1 = await tool.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    const r2 = await tool.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    if (r1.ok) expect(r1.value.oldHeadSha).toBe(r1.value.newHeadSha);
    if (r2.ok) expect(r2.value.oldHeadSha).not.toBe(r2.value.newHeadSha); // one-shot
  });

  test('hasChanges defaults true; setNextHasChanges(false) models an empty diff', async () => {
    const tool = new StubGitTool();
    expect(await tool.hasChanges('main')).toEqual({
      ok: true,
      value: { changed: true, worktreeDirty: true, committedAhead: false },
    });
    tool.setNextHasChanges(false);
    expect(await tool.hasChanges('main')).toEqual({
      ok: true,
      value: { changed: false, worktreeDirty: false, committedAhead: false },
    });
    // records the base branch BuildAgent threads
    expect(tool.hasChangesBaseBranches).toEqual(['main', 'main']);
  });

  test('stub head SHAs are deterministic across runs (no timestamps / randomness)', async () => {
    const a = new StubGitTool();
    const b = new StubGitTool();
    const ra = await a.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    const rb = await b.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    if (ra.ok && rb.ok) {
      expect(ra.value.oldHeadSha).toBe(rb.value.oldHeadSha);
      expect(ra.value.newHeadSha).toBe(rb.value.newHeadSha);
    }
  });

  test('headSha returns a stable default; setNextHeadShas enqueues pre/post values', async () => {
    const tool = new StubGitTool();
    // Default: the same head before/after (no self-commit in the revision path).
    expect((await tool.headSha()).ok).toBe(true);
    const a = await tool.headSha();
    const b = await tool.headSha();
    if (a.ok && b.ok) expect(a.value.sha).toBe(b.value.sha);
    // Enqueued distinct values model a coding-agent self-commit (HEAD moved).
    tool.setNextHeadShas(['pre', 'post']);
    const pre = await tool.headSha();
    const post = await tool.headSha();
    if (pre.ok && post.ok) {
      expect(pre.value.sha).toBe('pre');
      expect(post.value.sha).toBe('post');
    }
  });
});
