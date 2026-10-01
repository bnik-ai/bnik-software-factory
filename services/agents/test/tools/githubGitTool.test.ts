import { describe, expect, test } from 'vitest';
import { type ExecFn, GithubGitTool } from '../../src/tools/githubGitTool.js';

// A fake exec that records every git invocation and answers rev-parse /
// other queries from a programmable map. Default: empty stdout.
interface ExecCall {
  args: ReadonlyArray<string>;
  cwd?: string;
}

function makeExec(
  responder?: (args: ReadonlyArray<string>) => string,
  failOn?: (args: ReadonlyArray<string>) => Error | undefined,
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (_file, args, options) => {
    calls.push({ args, cwd: options?.cwd });
    const failure = failOn?.(args);
    if (failure !== undefined) throw failure;
    return { stdout: responder?.(args) ?? '', stderr: '' };
  };
  return { exec, calls };
}

const TOKEN = 'ghs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const getToken = async () => TOKEN;

function gitTool(exec: ExecFn) {
  return new GithubGitTool({
    getToken,
    owner: 'example-org',
    repo: 'sample-app',
    workdir: '/tmp/work',
    exec,
  });
}

describe('GithubGitTool', () => {
  test('clone embeds the token in the remote URL and sets identity', async () => {
    const { exec, calls } = makeExec();
    const tool = gitTool(exec);
    const r = await tool.clone();
    expect(r.ok).toBe(true);
    const cloneCall = calls.find((c) => c.args[0] === 'clone');
    expect(cloneCall).toBeDefined();
    const url = cloneCall?.args.find((a) => a.startsWith('https://'));
    expect(url).toBe(`https://x-access-token:${TOKEN}@github.com/example-org/sample-app.git`);
    // Identity configured.
    expect(calls.some((c) => c.args.includes('user.name'))).toBe(true);
    expect(calls.some((c) => c.args.includes('user.email'))).toBe(true);
  });

  test('branch uses switch -c with workdir', async () => {
    const { exec, calls } = makeExec();
    const tool = gitTool(exec);
    const r = await tool.branch({ name: 'sf/T-1/01HV6/build@opus-4-8' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('sf/T-1/01HV6/build@opus-4-8');
    expect(calls[0]?.args).toEqual([
      '-C',
      '/tmp/work',
      'switch',
      '-c',
      'sf/T-1/01HV6/build@opus-4-8',
    ]);
  });

  test('branch from a ref passes fromRef', async () => {
    const { exec, calls } = makeExec();
    const tool = gitTool(exec);
    await tool.branch({ name: 'sf/x', fromRef: 'origin/main' });
    expect(calls[0]?.args).toContain('origin/main');
  });

  test('commit stages all, stamps ADR 0009 trailers, returns HEAD sha', async () => {
    const { exec, calls } = makeExec((args) =>
      args[args.length - 1] === 'HEAD' ? 'abc123def\n' : '',
    );
    const tool = gitTool(exec);
    const r = await tool.commit({
      message: 'add: healthz endpoint',
      authorAgent: 'build@opus-4-8',
      authorRun: '01HV6XXXX',
      authorTask: 'T-42',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sha).toBe('abc123def');
    const commitCall = calls.find((c) => c.args.includes('commit'));
    const msgIndex = (commitCall?.args.indexOf('-m') ?? -1) + 1;
    const msg = commitCall?.args[msgIndex] ?? '';
    expect(msg).toContain('add: healthz endpoint');
    expect(msg).toContain('SF-Agent: build@opus-4-8');
    expect(msg).toContain('SF-Run: 01HV6XXXX');
    expect(msg).toContain('SF-Task: T-42');
    // staged all
    expect(calls.some((c) => c.args.includes('add') && c.args.includes('-A'))).toBe(true);
  });

  test('commit omits SF-Task trailer when no task in scope', async () => {
    const { exec, calls } = makeExec(() => 'sha\n');
    const tool = gitTool(exec);
    await tool.commit({ message: 'fix: y', authorAgent: 'build@opus', authorRun: '01HV6' });
    const commitCall = calls.find((c) => c.args.includes('commit'));
    const msg = commitCall?.args[(commitCall.args.indexOf('-m') ?? -1) + 1] ?? '';
    expect(msg).not.toContain('SF-Task');
  });

  test('commit with explicit paths stages only those', async () => {
    const { exec, calls } = makeExec(() => 'sha\n');
    const tool = gitTool(exec);
    await tool.commit({
      message: 'm',
      authorAgent: 'a',
      authorRun: 'r',
      paths: ['src/a.ts', 'src/b.ts'],
    });
    const addCall = calls.find((c) => c.args.includes('add'));
    expect(addCall?.args).toContain('src/a.ts');
    expect(addCall?.args).toContain('src/b.ts');
    expect(addCall?.args).not.toContain('-A');
  });

  test('push adds --force-with-lease and --set-upstream when requested', async () => {
    const { exec, calls } = makeExec();
    const tool = gitTool(exec);
    await tool.push({ branch: 'sf/x', forceWithLease: true, setUpstream: true });
    const pushCall = calls.find((c) => c.args.includes('push'));
    expect(pushCall?.args).toContain('--force-with-lease');
    expect(pushCall?.args).toContain('--set-upstream');
    expect(pushCall?.args.slice(-2)).toEqual(['origin', 'sf/x']);
  });

  test('push refreshes origin URL with a freshly-minted token first', async () => {
    // getToken returns a different token each call, modeling installation
    // token rotation; push must set-url with the *fresh* token before push.
    let n = 0;
    const rotating = async () => {
      n += 1;
      return `ghs_ROTATE${n.toString().padStart(28, '0')}`;
    };
    const { exec, calls } = makeExec();
    const tool = new GithubGitTool({
      getToken: rotating,
      owner: 'example-org',
      repo: 'sample-app',
      workdir: '/tmp/work',
      exec,
    });
    await tool.push({ branch: 'sf/x' });
    const setUrl = calls.find((c) => c.args.includes('set-url'));
    expect(setUrl).toBeDefined();
    const url = setUrl?.args.find((a) => a.startsWith('https://'));
    // The fresh token (rotation #1) is in the new origin URL.
    expect(url).toContain('x-access-token:ghs_ROTATE');
    // set-url precedes the push.
    const setUrlIdx = calls.findIndex((c) => c.args.includes('set-url'));
    const pushIdx = calls.findIndex((c) => c.args.includes('push'));
    expect(setUrlIdx).toBeLessThan(pushIdx);
  });

  test('rebase refreshes origin URL before fetch', async () => {
    const { exec, calls } = makeExec(() => 'sha\n');
    const tool = gitTool(exec);
    await tool.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    const setUrlIdx = calls.findIndex((c) => c.args.includes('set-url'));
    const fetchIdx = calls.findIndex((c) => c.args.includes('fetch'));
    expect(setUrlIdx).toBeGreaterThanOrEqual(0);
    expect(setUrlIdx).toBeLessThan(fetchIdx);
  });

  test('rebase returns distinct old/new heads and treeChanged from tree diff', async () => {
    // Sequence of rev-parse answers: HEAD(old), tree(old), HEAD(new), tree(new)
    const answers = ['oldhead', 'oldtree', 'newhead', 'newtree'];
    let i = 0;
    const { exec } = makeExec((args) => {
      if (args.includes('rev-parse')) {
        const ans = answers[i] ?? '';
        i += 1;
        return `${ans}\n`;
      }
      return '';
    });
    const tool = gitTool(exec);
    const r = await tool.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.oldHeadSha).toBe('oldhead');
      expect(r.value.newHeadSha).toBe('newhead');
      expect(r.value.treeChanged).toBe(true);
    }
  });

  test('rebase reports treeChanged=false when tree sha is identical', async () => {
    const answers = ['oldhead', 'sametree', 'newhead', 'sametree'];
    let i = 0;
    const { exec } = makeExec((args) => {
      if (args.includes('rev-parse')) {
        const ans = answers[i] ?? '';
        i += 1;
        return `${ans}\n`;
      }
      return '';
    });
    const tool = gitTool(exec);
    const r = await tool.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    if (r.ok) {
      expect(r.value.oldHeadSha).not.toBe(r.value.newHeadSha);
      expect(r.value.treeChanged).toBe(false);
    }
  });

  test('a conflicted rebase aborts the rebase before returning the failure', async () => {
    const { exec, calls } = makeExec(
      (args) => (args.includes('rev-parse') ? 'sha\n' : ''),
      (args) =>
        args.includes('rebase') && !args.includes('--abort')
          ? new Error('CONFLICT (content): merge conflict in a.ts')
          : undefined,
    );
    const tool = gitTool(exec);
    const r = await tool.rebase({ headBranch: 'sf/x', baseBranch: 'main' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith('rebase_failed:')).toBe(true);
    // Cleanup ran: a `rebase --abort` was issued so the workdir stays usable.
    expect(calls.some((c) => c.args.includes('rebase') && c.args.includes('--abort'))).toBe(true);
  });

  test('hasChanges: dirty worktree, NO self-commit → changed=true, worktreeDirty=true, committedAhead=false', async () => {
    const { exec, calls } = makeExec((args) => {
      if (args.includes('status')) return ' M src/loader.ts\n?? new.ts\n';
      if (args.includes('rev-list')) return '0\n'; // no commits ahead
      return '';
    });
    const r = await gitTool(exec).hasChanges('main');
    expect(r).toEqual({
      ok: true,
      value: { changed: true, worktreeDirty: true, committedAhead: false },
    });
    const statusCall = calls.find((c) => c.args.includes('status'));
    expect(statusCall?.args).toContain('--porcelain');
    expect(statusCall?.args).toContain('--untracked-files=all');
    // committedAhead is computed even on a dirty worktree.
    expect(calls.find((c) => c.args.includes('rev-list'))).toBeDefined();
  });

  test('hasChanges: dirty worktree AND self-commit (mixed) → committedAhead=true', async () => {
    const { exec } = makeExec((args) => {
      if (args.includes('status')) return ' M leftover.ts\n';
      if (args.includes('rev-list')) return '1\n'; // agent also committed
      return '';
    });
    const r = await gitTool(exec).hasChanges('main');
    expect(r).toEqual({
      ok: true,
      value: { changed: true, worktreeDirty: true, committedAhead: true },
    });
  });

  test('hasChanges: clean tree, at base tip (no commits ahead, no tree diff) → changed=false', async () => {
    // rev-list count 0 AND diff --name-only empty → HEAD == base → already satisfied.
    const { exec } = makeExec((args) => (args.includes('rev-list') ? '0\n' : ''));
    const r = await gitTool(exec).hasChanges('main');
    expect(r).toEqual({
      ok: true,
      value: { changed: false, worktreeDirty: false, committedAhead: false },
    });
  });

  test('hasChanges: clean tree BEHIND an advanced base (no commits ahead, tree DIFFERS) → changed=true, committedAhead=false (never a false already-satisfied)', async () => {
    const { exec } = makeExec((args) => {
      if (args.includes('rev-list')) return '0\n';
      if (args.includes('diff')) return 'src/loader.ts\n'; // base advanced → tree differs
      return '';
    });
    const r = await gitTool(exec).hasChanges('main');
    expect(r).toEqual({
      ok: true,
      value: { changed: true, worktreeDirty: false, committedAhead: false },
    });
  });

  test('hasChanges: clean tree BUT commits ahead of base (agent ran git commit) → changed=true, worktreeDirty=false', async () => {
    // A clean worktree does NOT prove an empty diff — the
    // coding agent committed its work, so rev-list origin/main..HEAD > 0.
    const { exec, calls } = makeExec((args) => (args.includes('rev-list') ? '2\n' : ''));
    const r = await gitTool(exec).hasChanges('main');
    expect(r).toEqual({
      ok: true,
      value: { changed: true, worktreeDirty: false, committedAhead: true },
    });
    const revListCall = calls.find((c) => c.args.includes('rev-list'));
    expect(revListCall?.args).toContain('origin/main..HEAD');
    expect(revListCall?.args).toContain('--count');
  });

  test('hasChanges: git failure → typed status_failed', async () => {
    const { exec } = makeExec(undefined, (args) =>
      args.includes('status') ? new Error('not a git repository') : undefined,
    );
    const r = await gitTool(exec).hasChanges('main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith('status_failed:')).toBe(true);
  });

  test('a failing git op returns a typed reason with the token redacted', async () => {
    const { exec } = makeExec(undefined, (args) => {
      if (args.includes('clone')) {
        const err = new Error(
          `fatal: could not read from https://x-access-token:${TOKEN}@github.com/o/r.git`,
        ) as Error & { stderr: string };
        err.stderr = `auth failed for ${TOKEN}`;
        return err;
      }
      return undefined;
    });
    const tool = gitTool(exec);
    const r = await tool.clone();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith('clone_failed:')).toBe(true);
      expect(r.reason).not.toContain(TOKEN);
      expect(r.reason).toContain('***');
    }
  });

  test('headSha runs `rev-parse HEAD` in the workdir and trims the sha', async () => {
    const { exec, calls } = makeExec((args) =>
      args.includes('rev-parse') ? 'abc123def456\n' : '',
    );
    const tool = gitTool(exec);
    const r = await tool.headSha();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sha).toBe('abc123def456');
    expect(calls[0]?.args).toEqual(['-C', '/tmp/work', 'rev-parse', 'HEAD']);
  });

  test('headSha → typed head_sha_failed (redacted) when rev-parse throws', async () => {
    const { exec } = makeExec(undefined, (args) =>
      args.includes('rev-parse') ? new Error(`boom ${TOKEN}`) : undefined,
    );
    const tool = gitTool(exec);
    const r = await tool.headSha();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith('head_sha_failed:')).toBe(true);
      expect(r.reason).not.toContain(TOKEN);
    }
  });
});
