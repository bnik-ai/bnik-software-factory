// Real git-backed GitTool. Spec: ADR 0008 (branch grammar) + ADR 0009
// (SF-Agent/SF-Run/SF-Task commit trailers).
// Invariants:
//   - The installation token authenticates git-over-https. It is injected
//     into the *remote URL* (https://x-access-token:<token>@github.com/...)
//     at clone time and persists in .git/config. SECURITY: the token MUST
//     NEVER be logged or surface in an error — clone is run with the URL as
//     an argv element (not echoed), and all child_process output is passed
//     through redact() before it lands in a result.reason.
//   - commit() stamps the ADR 0009 §2 trailers (SF-Agent/SF-Run/SF-Task)
//     onto the message body; agents never hand-author them.
//   - rebase() returns { oldHeadSha, newHeadSha, treeChanged } — the two
//     independent signals issue #112 + ADR 0012 item 4 require.
//   - exec is injected (default real execFile) so tests use a fake — CI has
//     no git creds and no network.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GitBranchArgs,
  GitCommitArgs,
  GitPushArgs,
  GitRebaseArgs,
  GitTool,
  GitToolResult,
} from './gitTool.js';
import { redact } from './githubIssueTool.js';

const execFileAsync = promisify(execFile);

// Injected exec contract: run a program with args, never via a shell (no
// shell-injection surface), return stdout. Matches the shape of the real
// promisified execFile.
export type ExecFn = (
  file: string,
  args: ReadonlyArray<string>,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (file, args, options) => {
  // encoding: 'utf8' forces string (not Buffer) stdout/stderr.
  const result = await execFileAsync(file, [...args], { ...options, encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr };
};

export interface GithubGitToolConfig {
  getToken: () => Promise<string>;
  owner: string;
  repo: string;
  // Local path the repo is/will be cloned to. All git ops run with -C here.
  workdir: string;
  // Host for the git remote; defaults to github.com (overridable for GHES).
  gitHost?: string;
  // Identity stamped via git config + ADR 0009 trailers. Defaults to the
  // single SF App identity (ADR 0009 rule 1).
  authorName?: string;
  authorEmail?: string;
  exec?: ExecFn;
}

const DEFAULT_GIT_HOST = 'github.com';
const DEFAULT_AUTHOR_NAME = 'software-factory';
const DEFAULT_AUTHOR_EMAIL = 'sfac-agent@users.noreply.github.com';

export class GithubGitTool implements GitTool {
  private readonly getToken: () => Promise<string>;
  private readonly owner: string;
  private readonly repo: string;
  private readonly workdir: string;
  private readonly gitHost: string;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly exec: ExecFn;

  constructor(config: GithubGitToolConfig) {
    this.getToken = config.getToken;
    this.owner = config.owner;
    this.repo = config.repo;
    this.workdir = config.workdir;
    this.gitHost = config.gitHost ?? DEFAULT_GIT_HOST;
    this.authorName = config.authorName ?? DEFAULT_AUTHOR_NAME;
    this.authorEmail = config.authorEmail ?? DEFAULT_AUTHOR_EMAIL;
    this.exec = config.exec ?? defaultExec;
  }

  // Run git with args, redacting any token from a thrown error. Never wraps
  // the token-bearing URL into the error message (the caller passes the URL
  // as a plain argv element; if git fails, its message may echo the remote,
  // so redact() scrubs it).
  private async git(
    args: ReadonlyArray<string>,
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return this.exec('git', args, cwd !== undefined ? { cwd } : undefined);
  }

  // Build the token-bearing https remote. SECURITY: callers must keep this
  // value out of logs; it embeds the installation token.
  private async remoteUrl(): Promise<string> {
    const token = await this.getToken();
    return `https://x-access-token:${token}@${this.gitHost}/${this.owner}/${this.repo}.git`;
  }

  // Re-mint the installation token and rewrite origin's URL before any
  // network op. Installation tokens expire (~1h), so a workdir reused after
  // expiry would otherwise push/fetch with the stale token baked into origin
  // at clone time. SECURITY: the fresh token-bearing URL is passed as an
  // argv element (set-url), never echoed.
  private async refreshRemote(): Promise<void> {
    const url = await this.remoteUrl();
    await this.git(['-C', this.workdir, 'remote', 'set-url', 'origin', url]);
  }

  // Clone the repo into workdir with token auth baked into the remote URL.
  // Not part of the GitTool interface (BuildAgent calls it before branch()),
  // exposed as a public helper.
  async clone(args?: { ref?: string; depth?: number }): Promise<
    GitToolResult<{ workdir: string }>
  > {
    const url = await this.remoteUrl();
    const cloneArgs = ['clone'];
    if (args?.depth !== undefined) cloneArgs.push('--depth', String(args.depth));
    if (args?.ref !== undefined) cloneArgs.push('--branch', args.ref);
    cloneArgs.push(url, this.workdir);
    try {
      await this.git(cloneArgs);
      // Pin the committer/author identity for all subsequent commits.
      await this.git(['-C', this.workdir, 'config', 'user.name', this.authorName]);
      await this.git(['-C', this.workdir, 'config', 'user.email', this.authorEmail]);
      return { ok: true, value: { workdir: this.workdir } };
    } catch (err) {
      return { ok: false, reason: `clone_failed:${redact(errMessage(err))}` };
    }
  }

  async branch(args: GitBranchArgs): Promise<GitToolResult<{ name: string }>> {
    try {
      if (args.fromRef !== undefined) {
        await this.git(['-C', this.workdir, 'switch', '-c', args.name, args.fromRef]);
      } else {
        await this.git(['-C', this.workdir, 'switch', '-c', args.name]);
      }
      return { ok: true, value: { name: args.name } };
    } catch (err) {
      return { ok: false, reason: `branch_failed:${redact(errMessage(err))}` };
    }
  }

  async commit(args: GitCommitArgs): Promise<GitToolResult<{ sha: string }>> {
    try {
      // Stage: specific paths if given, else everything.
      if (args.paths !== undefined && args.paths.length > 0) {
        await this.git(['-C', this.workdir, 'add', '--', ...args.paths]);
      } else {
        await this.git(['-C', this.workdir, 'add', '-A']);
      }
      const message = buildCommitMessage(args);
      await this.git(['-C', this.workdir, 'commit', '-m', message]);
      const { stdout } = await this.git(['-C', this.workdir, 'rev-parse', 'HEAD']);
      return { ok: true, value: { sha: stdout.trim() } };
    } catch (err) {
      return { ok: false, reason: `commit_failed:${redact(errMessage(err))}` };
    }
  }

  // `git rev-parse HEAD` (issue #182): the revision path captures HEAD before
  // and after the coding run to detect a coding-agent self-commit (see GitTool).
  async headSha(): Promise<GitToolResult<{ sha: string }>> {
    try {
      const { stdout } = await this.git(['-C', this.workdir, 'rev-parse', 'HEAD']);
      return { ok: true, value: { sha: stdout.trim() } };
    } catch (err) {
      return { ok: false, reason: `head_sha_failed:${redact(errMessage(err))}` };
    }
  }

  async push(args: GitPushArgs): Promise<GitToolResult<{ branch: string }>> {
    const pushArgs = ['-C', this.workdir, 'push'];
    if (args.forceWithLease === true) pushArgs.push('--force-with-lease');
    if (args.setUpstream === true) pushArgs.push('--set-upstream');
    pushArgs.push('origin', args.branch);
    try {
      await this.refreshRemote();
      await this.git(pushArgs);
      return { ok: true, value: { branch: args.branch } };
    } catch (err) {
      return { ok: false, reason: `push_failed:${redact(errMessage(err))}` };
    }
  }

  // Issue #180: whether the branch carries ANY change relative to its base.
  // BuildAgent calls this after the coding run to distinguish an already-
  // satisfied Task (empty diff → settle done) from real work / a genuine commit
  // failure. TWO signals, because the coding agent has a Bash tool and may run
  // `git commit` ITSELF (codex P1): a clean worktree alone does NOT prove an
  // empty diff — the branch could be ahead of base with committed work that
  // settling-as-done would silently drop.
  //   (1) worktree dirt: `git status --porcelain --untracked-files=all`.
  //   (2) committed-ahead: `git rev-list --count origin/<base>..HEAD` > 0.
  // The branch was created at origin/<base> (clone(ref=base) + checkout -b), so
  // origin/<base> is the correct fork point.
  async hasChanges(
    baseBranch: string,
  ): Promise<GitToolResult<{ changed: boolean; worktreeDirty: boolean; committedAhead: boolean }>> {
    try {
      const { stdout: status } = await this.git([
        '-C',
        this.workdir,
        'status',
        '--porcelain',
        '--untracked-files=all',
      ]);
      const worktreeDirty = status.trim().length > 0;
      // Decide against the FRESHLY-fetched base (codex P2 #180): the base can
      // advance during a long coding run, so refresh + fetch (like rebase()).
      // committedAhead is computed UNCONDITIONALLY — even a DIRTY worktree must
      // surface an agent self-commit, else a mixed (committed + dirty) run would
      // commit the leftovers and publish the un-attributed commit (codex P2 r6).
      await this.refreshRemote();
      await this.git(['-C', this.workdir, 'fetch', 'origin']);
      const { stdout: ahead } = await this.git([
        '-C',
        this.workdir,
        'rev-list',
        '--count',
        `origin/${baseBranch}..HEAD`,
      ]);
      const committedAhead = Number.parseInt(ahead.trim(), 10) > 0;
      if (worktreeDirty) {
        return { ok: true, value: { changed: true, worktreeDirty: true, committedAhead } };
      }
      if (committedAhead) {
        return { ok: true, value: { changed: true, worktreeDirty: false, committedAhead: true } };
      }
      // Clean + no own commits: `changed` iff the branch's tree DIFFERS from the
      // live base (codex P1 r5). HEAD exactly at base → no diff → already
      // satisfied. HEAD behind a freshly-advanced base → diff present → changed
      // (stale checkout; BuildAgent fails closed for a re-run, never settles done).
      // `git diff --name-only` (not --quiet, which exits non-zero and throws).
      const { stdout: diffNames } = await this.git([
        '-C',
        this.workdir,
        'diff',
        '--name-only',
        `origin/${baseBranch}`,
        'HEAD',
      ]);
      const treeDiffers = diffNames.trim().length > 0;
      return {
        ok: true,
        value: { changed: treeDiffers, worktreeDirty: false, committedAhead: false },
      };
    } catch (err) {
      return { ok: false, reason: `status_failed:${redact(errMessage(err))}` };
    }
  }

  // Rebase headBranch onto baseBranch (ADR 0012 strategy: rebase, not
  // merge-in). Fetches origin first so baseBranch is current, then computes
  // the two independent signals (issue #112):
  //   - oldHeadSha vs newHeadSha → head-equality (drives the push gate)
  //   - treeChanged → tree-equality (drives full-vs-delta review, ADR 0012)
  async rebase(
    args: GitRebaseArgs,
  ): Promise<GitToolResult<{ oldHeadSha: string; newHeadSha: string; treeChanged: boolean }>> {
    try {
      await this.refreshRemote();
      await this.git(['-C', this.workdir, 'fetch', 'origin']);
      await this.git(['-C', this.workdir, 'checkout', args.headBranch]);
      const oldHeadSha = (await this.git(['-C', this.workdir, 'rev-parse', 'HEAD'])).stdout.trim();
      const oldTree = (
        await this.git(['-C', this.workdir, 'rev-parse', 'HEAD^{tree}'])
      ).stdout.trim();
      // Rebase onto the remote-tracking base so the comparison is against
      // the freshly-fetched tip, not a possibly-stale local ref.
      await this.git(['-C', this.workdir, 'rebase', `origin/${args.baseBranch}`]);
      const newHeadSha = (await this.git(['-C', this.workdir, 'rev-parse', 'HEAD'])).stdout.trim();
      const newTree = (
        await this.git(['-C', this.workdir, 'rev-parse', 'HEAD^{tree}'])
      ).stdout.trim();
      return {
        ok: true,
        value: { oldHeadSha, newHeadSha, treeChanged: oldTree !== newTree },
      };
    } catch (err) {
      // A conflicted rebase leaves the workdir mid-rebase; any later
      // checkout/commit/rebase on the reused workdir would fail until it's
      // aborted. Best-effort cleanup so the workdir stays usable. Ignore the
      // abort's own error (e.g. no rebase in progress).
      try {
        await this.git(['-C', this.workdir, 'rebase', '--abort']);
      } catch {
        // no-op: nothing to abort, or abort itself failed — surface the
        // original rebase error regardless.
      }
      return { ok: false, reason: `rebase_failed:${redact(errMessage(err))}` };
    }
  }
}

// Assemble the commit message with ADR 0009 §2 trailers. Trailers are
// RFC-822-style key/value lines after a blank line at the end of the body;
// SF-Task is omitted when no Task is in scope.
function buildCommitMessage(args: GitCommitArgs): string {
  const trailers = [`SF-Agent: ${args.authorAgent}`, `SF-Run: ${args.authorRun}`];
  if (args.authorTask !== undefined) {
    trailers.push(`SF-Task: ${args.authorTask}`);
  }
  // Single blank line separates subject/body from the trailer block.
  return `${args.message.trimEnd()}\n\n${trailers.join('\n')}\n`;
}

// Extract a child_process error's combined message (stderr + message) for
// the result.reason. Always passed through redact() at the call site.
function errMessage(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const candidate = err as { stderr?: unknown; message?: unknown };
    const stderr = typeof candidate.stderr === 'string' ? candidate.stderr : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    const combined = `${message} ${stderr}`.trim();
    if (combined !== '') return combined.slice(0, 500);
  }
  return String(err).slice(0, 500);
}
