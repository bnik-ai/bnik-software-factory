import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  buildAgentDeps,
  buildIssueTool,
  buildOpsDeps,
  isGithubAppMode,
  isRealMode,
  resolveRepo,
} from '../src/agentDeps.js';
import { StubGitTool } from '../src/tools/gitTool.js';
import { GithubGitTool } from '../src/tools/githubGitTool.js';
import { GithubIssueTool } from '../src/tools/githubIssueTool.js';
import { GithubPullTool } from '../src/tools/githubPullTool.js';
import { StubIssueTool } from '../src/tools/issueTool.js';
import { StubPullTool } from '../src/tools/pullTool.js';

const { privateKey: TEST_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const REAL_ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: TEST_PEM,
  AGENT_DEFAULT_REPO: 'example-org/software-factory',
};

describe('isRealMode', () => {
  test('true only when all three secrets are present and non-empty', () => {
    expect(isRealMode(REAL_ENV)).toBe(true);
    expect(isRealMode({ ...REAL_ENV, ANTHROPIC_API_KEY: '' })).toBe(false);
    expect(isRealMode({ ...REAL_ENV, GITHUB_APP_ID: undefined })).toBe(false);
    expect(isRealMode({ ...REAL_ENV, GITHUB_APP_PRIVATE_KEY: undefined })).toBe(false);
    expect(isRealMode({ AGENT_DEFAULT_REPO: 'o/r' })).toBe(false);
  });
});

describe('isGithubAppMode', () => {
  test('true when GitHub App secrets present, independent of ANTHROPIC_API_KEY', () => {
    expect(isGithubAppMode(REAL_ENV)).toBe(true);
    // GitHub creds present but no Anthropic key → still true (OpsAgent's gate).
    expect(isGithubAppMode({ ...REAL_ENV, ANTHROPIC_API_KEY: undefined })).toBe(true);
    expect(isGithubAppMode({ ...REAL_ENV, ANTHROPIC_API_KEY: '' })).toBe(true);
  });
  test('false when either GitHub App secret is missing or empty', () => {
    expect(isGithubAppMode({ ...REAL_ENV, GITHUB_APP_ID: undefined })).toBe(false);
    expect(isGithubAppMode({ ...REAL_ENV, GITHUB_APP_ID: '' })).toBe(false);
    expect(isGithubAppMode({ ...REAL_ENV, GITHUB_APP_PRIVATE_KEY: undefined })).toBe(false);
    expect(isGithubAppMode({ AGENT_DEFAULT_REPO: 'o/r' })).toBe(false);
  });
});

describe('buildOpsDeps — GitHub-only gate', () => {
  test('GitHub creds present + Anthropic ABSENT → REAL GithubPullTool (never a stub)', () => {
    // The exact regression: GitHub App secrets set, ANTHROPIC_API_KEY missing.
    // isRealMode() would be false → buildAgentDeps would hand back a stub
    // merge. buildOpsDeps MUST still wire the real GithubPullTool so the
    // approved-PR is actually merged on GitHub before the message is acked.
    const { ANTHROPIC_API_KEY: _omitted, ...githubOnlyEnv } = REAL_ENV;
    expect(isRealMode(githubOnlyEnv)).toBe(false);

    const deps = buildOpsDeps({ env: githubOnlyEnv, runId: '01HZXYZ123456789ABCDEFGHJK' });
    expect(deps.pulls).toBeInstanceOf(GithubPullTool);
    expect(deps.pulls).not.toBeInstanceOf(StubPullTool);
    // The post-merge Task bookkeeping needs the REAL IssueTool on
    // the same GitHub-only gate (buildIssueTool seam) — no Anthropic key needed.
    expect(deps.issues).toBeInstanceOf(GithubIssueTool);
    expect(deps.issues).not.toBeInstanceOf(StubIssueTool);
    expect(deps.repoSlug).toBe('example-org/software-factory');
  });

  test('all secrets present → REAL GithubPullTool + GithubIssueTool', () => {
    const deps = buildOpsDeps({ env: REAL_ENV, runId: '01HZXYZ123456789ABCDEFGHJK' });
    expect(deps.pulls).toBeInstanceOf(GithubPullTool);
    expect(deps.issues).toBeInstanceOf(GithubIssueTool);
  });

  test('GitHub creds ABSENT (CI / in-memory boot) → StubPullTool + StubIssueTool', () => {
    const deps = buildOpsDeps({
      env: { AGENT_DEFAULT_REPO: 'example-org/SF' },
      runId: '01HZXYZ123456789ABCDEFGHJK',
    });
    expect(deps.pulls).toBeInstanceOf(StubPullTool);
    expect(deps.issues).toBeInstanceOf(StubIssueTool);
    expect(deps.repoSlug).toBe('example-org/SF');
  });

  test('requires AGENT_DEFAULT_REPO (throws at boot when missing)', () => {
    expect(() => buildOpsDeps({ env: {}, runId: '01HZXYZ123456789ABCDEFGHJK' })).toThrow(
      /AGENT_DEFAULT_REPO/,
    );
  });
});

describe('resolveRepo', () => {
  test('parses owner/repo from AGENT_DEFAULT_REPO', () => {
    expect(resolveRepo({ AGENT_DEFAULT_REPO: 'example-org/SF' })).toEqual({
      owner: 'example-org',
      repo: 'SF',
    });
  });
  test('throws on missing or malformed slug', () => {
    expect(() => resolveRepo({})).toThrow(/AGENT_DEFAULT_REPO/);
    expect(() => resolveRepo({ AGENT_DEFAULT_REPO: 'noslash' })).toThrow(/owner\/repo/);
    expect(() => resolveRepo({ AGENT_DEFAULT_REPO: 'a/b/c' })).toThrow(/owner\/repo/);
  });
});

describe('buildAgentDeps — stub path (secrets absent)', () => {
  test('returns Stub tool classes and no brains', () => {
    const deps = buildAgentDeps({
      env: { AGENT_DEFAULT_REPO: 'example-org/SF' },
      runId: '01HZXYZ123456789ABCDEFGHJK',
    });
    expect(deps.issues).toBeInstanceOf(StubIssueTool);
    expect(deps.git).toBeInstanceOf(StubGitTool);
    expect(deps.pulls).toBeInstanceOf(StubPullTool);
    expect(deps.generateContent).toBeUndefined();
    expect(deps.runCodingAgent).toBeUndefined();
    expect(deps.clone).toBeUndefined();
    expect(deps.repoSlug).toBe('example-org/SF');
    expect(deps.repo).toEqual({ owner: 'example-org', repo: 'SF' });
  });

  test('GITHUB_APP_SLUG set in stub mode → appBotLogin NOT threaded (else stub PRs fail the auto-revision ownership check and park)', () => {
    const deps = buildAgentDeps({
      env: { AGENT_DEFAULT_REPO: 'example-org/SF', GITHUB_APP_SLUG: 'example-factory' },
      runId: '01HZXYZ123456789ABCDEFGHJK',
    });
    expect(deps.pulls).toBeInstanceOf(StubPullTool);
    // Undefined appBotLogin → isAppAuthor accepts the StubPullTool's fixed Bot
    // author, so a stub PR revises rather than parking on its own ownership check.
    expect(deps.appBotLogin).toBeUndefined();
  });
});

describe('buildAgentDeps — real path (all secrets present)', () => {
  test('returns Github tool classes + real brains + clone/workdir', () => {
    const deps = buildAgentDeps({ env: REAL_ENV, runId: '01HZXYZ123456789ABCDEFGHJK' });
    expect(deps.issues).toBeInstanceOf(GithubIssueTool);
    expect(deps.git).toBeInstanceOf(GithubGitTool);
    expect(deps.pulls).toBeInstanceOf(GithubPullTool);
    expect(typeof deps.generateContent).toBe('function');
    expect(typeof deps.runCodingAgent).toBe('function');
    expect(typeof deps.clone).toBe('function');
    expect(deps.workdir).toBe('/tmp/sf-build/01HZXYZ123456789ABCDEFGHJK');
  });
});
