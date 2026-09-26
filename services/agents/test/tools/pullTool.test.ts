import { describe, expect, test } from 'vitest';
import { StubPullTool } from '../../src/tools/pullTool.js';

describe('StubPullTool', () => {
  test('open returns monotonic PR numbers + draft state passthrough', async () => {
    const tool = new StubPullTool();
    const r1 = await tool.open({
      headBranch: 'sf/T-42/01HV6/build@opus-4-7',
      baseBranch: 'main',
      title: 'feat: x',
      body: '',
      taskRecordId: 'I_task',
    });
    const r2 = await tool.open({
      headBranch: 'sf/T-43/01HV7/build@opus-4-7',
      baseBranch: 'main',
      title: 'feat: y',
      body: '',
      draft: true,
    });
    if (r1.ok && r2.ok) {
      expect(r1.value.number).toBe(1);
      expect(r1.value.state).toBe('open');
      expect(r2.value.number).toBe(2);
      expect(r2.value.state).toBe('draft');
    }
  });

  test('close records reason', async () => {
    const tool = new StubPullTool();
    await tool.close({ recordId: 'PR_1', reason: 'replaced by #42' });
    expect(tool.closeHistory()[0]?.reason).toBe('replaced by #42');
  });

  test('submitReview preserves findings array per ADR 0010 schema', async () => {
    const tool = new StubPullTool();
    const r = await tool.submitReview({
      recordId: 'PR_1',
      state: 'request-changes',
      body: 'see findings',
      findings: [
        {
          severity: 'P1',
          file: 'src/auth.ts',
          line: 42,
          claim: 'missing CSRF check',
          suggestedFix: 'wrap with csrfMiddleware',
          verdict: 'fix',
        },
        {
          severity: 'P3',
          file: 'README.md',
          line: 10,
          claim: 'typo',
          verdict: 'pass',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.reviewId).toMatch(/^stub-review-\d+$/);
    expect(tool.reviewHistory()[0]?.findings).toHaveLength(2);
  });

  test('read resolves a previously opened PR record', async () => {
    const tool = new StubPullTool();
    const opened = await tool.open({
      headBranch: 'sf/T-42/01HV6/build@opus-4-7',
      baseBranch: 'main',
      title: 'feat: x',
      body: '',
      taskRecordId: 'I_task',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const r = await tool.read(opened.value.recordId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.recordId).toBe(opened.value.recordId);
    expect(r.value.number).toBe(1);
    expect(r.value.state).toBe('open');
    expect(r.value.headBranch).toBe('sf/T-42/01HV6/build@opus-4-7');
  });

  test('read resolves a seeded PR record (test setup path)', async () => {
    const tool = new StubPullTool();
    tool.seedRecord({
      recordId: 'PR_seeded',
      number: 77,
      state: 'open',
      headBranch: 'sf/T-99/01HV7/build@opus-4-7',
      baseBranch: 'main',
    });
    const r = await tool.read('PR_seeded');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.number).toBe(77);
  });

  test('read returns typed failure when record is not found', async () => {
    const tool = new StubPullTool();
    const r = await tool.read('PR_does_not_exist');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('pr_record_not_found:PR_does_not_exist');
  });

  test('merge records method + returns synthetic merge SHA', async () => {
    const tool = new StubPullTool();
    const r = await tool.merge({ recordId: 'PR_1', method: 'squash' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recordId).toBe('PR_1');
      expect(r.value.mergeSha).toMatch(/^stub-merge-[0-9a-f]{8}$/);
    }
    const r2 = await tool.merge({ recordId: 'PR_2' });
    if (r2.ok) expect(r2.value.mergeSha).not.toBe(r.ok ? r.value.mergeSha : '');
    expect(tool.mergeHistory()).toHaveLength(2);
    expect(tool.mergeHistory()[0]?.method).toBe('squash');
    expect(tool.mergeHistory()[1]?.method).toBeUndefined();
  });

  test('readBaseFile: seeded path → found with contents; unseeded → clean not-found (issue #179)', async () => {
    const tool = new StubPullTool();
    tool.seedBaseFile('PR_1', 'tests/api/conftest.py', 'def auth(): ...');
    const present = await tool.readBaseFile('PR_1', 'tests/api/conftest.py');
    expect(present.ok).toBe(true);
    if (present.ok) {
      expect(present.value.found).toBe(true);
      expect(present.value.content).toContain('def auth');
      expect(present.value.truncated).toBe(false);
    }
    // Unseeded path is a clean not-found at base (NOT a transport failure).
    const absent = await tool.readBaseFile('PR_1', 'tests/api/missing.py');
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.value.found).toBe(false);
      expect(absent.value.content).toBeUndefined();
    }
  });

  test('readBaseFile: failNextBaseFileRead surfaces a transport failure once', async () => {
    const tool = new StubPullTool();
    tool.seedBaseFile('PR_1', 'a.py', 'x');
    tool.failNextBaseFileRead('network_error:boom');
    const failed = await tool.readBaseFile('PR_1', 'a.py');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toBe('network_error:boom');
    // Only the next call fails; the one after succeeds.
    const ok = await tool.readBaseFile('PR_1', 'a.py');
    expect(ok.ok).toBe(true);
  });

  test('getSyncStatus defaults to current; setSyncStatus overrides', async () => {
    const tool = new StubPullTool();
    const r1 = await tool.getSyncStatus('PR_1');
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.value.status).toBe('current');
      expect(r1.value.recordId).toBe('PR_1');
    }

    tool.setSyncStatus('PR_2', { recordId: 'PR_2', status: 'behind', behindBy: 7 });
    const r2 = await tool.getSyncStatus('PR_2');
    if (r2.ok) {
      expect(r2.value.status).toBe('behind');
      expect(r2.value.behindBy).toBe(7);
    }

    // PR_1 still returns current — override is per-PR.
    const r3 = await tool.getSyncStatus('PR_1');
    if (r3.ok) expect(r3.value.status).toBe('current');

    expect(tool.syncStatusHistory()).toEqual(['PR_1', 'PR_2', 'PR_1']);
  });

  test('issue #191: open() defaults to App-authored same-repo ownership; read() echoes it', async () => {
    const tool = new StubPullTool();
    const opened = await tool.open({
      headBranch: 'sf/T-42/01HV6/build@opus-4-7',
      baseBranch: 'main',
      title: 'feat: x',
      body: '',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.author).toEqual({ login: 'sfac-app[bot]', isBot: true });
    expect(opened.value.isCrossRepository).toBe(false);

    const read = await tool.read(opened.value.recordId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.author?.isBot).toBe(true);
    expect(read.value.isCrossRepository).toBe(false);
  });

  test('issue #191: setDefaultOwnership stamps human / fork ownership on opened PRs', async () => {
    const tool = new StubPullTool();
    tool.setDefaultOwnership({ login: 'a-human', isBot: false }, true);
    const opened = await tool.open({
      headBranch: 'sf/T-42/01HV6/build@opus-4-7',
      baseBranch: 'main',
      title: 'feat: x',
      body: '',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.author).toEqual({ login: 'a-human', isBot: false });
    expect(opened.value.isCrossRepository).toBe(true);
  });

  test('issue #191: seedRecord round-trips explicit author + isCrossRepository through read()', async () => {
    const tool = new StubPullTool();
    tool.seedRecord({
      recordId: 'PR_seed',
      number: 9,
      state: 'open',
      headBranch: 'sf/T-1/01HV6/build@opus-4-7',
      baseBranch: 'main',
      author: { login: 'example-factory', isBot: true },
      isCrossRepository: false,
    });
    const read = await tool.read('PR_seed');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.author).toEqual({ login: 'example-factory', isBot: true });
    expect(read.value.isCrossRepository).toBe(false);
  });
});
