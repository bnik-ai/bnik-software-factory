// Env-gated real-vs-stub tool + brain factory.
// entrypoint calls buildAgentDeps() to get the tools + brains its handler
// needs. The gate:
//   - REAL when ANTHROPIC_API_KEY + GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY
//     are all set → GithubIssueTool / GithubGitTool / GithubPullTool bound
//     to a per-repo getToken closure (createTokenProvider curried with
//     owner/repo) + the real brains (generateContent / runCodingAgent).
//   - STUB otherwise → StubIssueTool / StubGitTool / StubPullTool + no
//     brains (handlers fall back to their templated placeholders). This
//     keeps CI (no API key, no git creds) + the in-memory boot green.
// owner/repo resolution: from the dispatch message if it carries repo info
// (it does not in M1c — see types.ts; installation_id threading is M2),
// else parse AGENT_DEFAULT_REPO ('owner/repo'). installation_id itself is
// resolved by the token provider via the repo lookup — NOT from the webhook.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { Anthropic } from '@anthropic-ai/sdk';
import type { CloneFn, RunCodingAgentFn } from './agents/buildAgent.js';
import type { GenerateContentFn } from './agents/specAgent.js';
import { type RepoTokenProvider, createTokenProvider } from './auth/installationToken.js';
import { type QueryFn, runCodingAgent as runRealCodingAgent } from './runtime/codingAgent.js';
import {
  type ContentClientLike,
  generateContent as runGenerateContent,
} from './runtime/contentAgent.js';
import type { GitTool } from './tools/gitTool.js';
import { StubGitTool } from './tools/gitTool.js';
import { GithubGitTool } from './tools/githubGitTool.js';
import { GithubIssueTool } from './tools/githubIssueTool.js';
import { GithubPullTool } from './tools/githubPullTool.js';
import type { IssueTool } from './tools/issueTool.js';
import { StubIssueTool } from './tools/issueTool.js';
import { StubPullTool } from './tools/pullTool.js';
import type { PullTool } from './tools/pullTool.js';

export interface AgentDepsEnv {
  ANTHROPIC_API_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  AGENT_DEFAULT_REPO?: string;
  ANTHROPIC_MODEL?: string;
  // App slug (e.g. example-factory). Threaded to GithubIssueTool as the trusted
  // structural-marker author: listComments only honors markers from this Bot,
  // so forged comment markers can't drive the #182 revision loop. Same env the
  // validator/webhook already set (GITHUB_APP_SLUG).
  GITHUB_APP_SLUG?: string;
}

export interface ResolvedAgentDeps {
  issues: IssueTool;
  git: GitTool;
  pulls: PullTool;
  repo: { owner: string; repo: string };
  // Repo slug 'owner/repo' for IssueTool.create's args.repo.
  repoSlug: string;
  // Present only on the real path; handlers gate on definedness.
  generateContent?: GenerateContentFn;
  runCodingAgent?: RunCodingAgentFn;
  // Clone closure for BuildAgent's real path (delegates to the real GitTool).
  clone?: CloneFn;
  // The coding workdir BuildAgent's clone targets (real path only).
  workdir?: string;
  // Configured App slug (GITHUB_APP_SLUG), echoed for BuildAgent's #191
  // auto-revision ownership guard (PR author must match the App bot). Same env
  // threaded to GithubIssueTool as appBotLogin. Undefined when unset.
  appBotLogin?: string;
}

export interface BuildAgentDepsArgs {
  env: AgentDepsEnv;
  // ULID per ADR 0008 — used as the build workdir suffix so concurrent runs
  // don't collide.
  runId: string;
}

// True iff the real-tools gate is satisfied (all three secrets present).
export function isRealMode(env: AgentDepsEnv): boolean {
  return (
    env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== '' && isGithubAppMode(env)
  );
}

// True iff the GitHub-App credentials alone are present — INDEPENDENT of
// ANTHROPIC_API_KEY. Tools that talk only to GitHub (the planner's IssueTool
// for the decompose read+create) gate on this so they bind the REAL GitHub
// client whenever GitHub creds exist, even when no content brain is configured
// (#177 P2: GitHub-creds-present + no-Anthropic must NOT downgrade the planner
// to a StubIssueTool that reads an empty Design and deadletters; the no-brain
// path is a separate, correct single-Task fallback). generateContent stays
// gated on ANTHROPIC_API_KEY via isRealMode.
export function isGithubAppMode(env: AgentDepsEnv): boolean {
  return (
    env.GITHUB_APP_ID !== undefined &&
    env.GITHUB_APP_ID !== '' &&
    env.GITHUB_APP_PRIVATE_KEY !== undefined &&
    env.GITHUB_APP_PRIVATE_KEY !== ''
  );
}

// Build an IssueTool gated on GitHub creds ALONE (see isGithubAppMode). Real
// GithubIssueTool when GitHub creds present (regardless of ANTHROPIC_API_KEY);
// StubIssueTool only when GitHub creds are truly absent (CI/in-memory boot).
// Used by the planner entrypoint so decompose reads + creates against real
// GitHub whenever creds exist; reuses the same resolveRepo + token-provider +
// GithubIssueTool plumbing as buildAgentDeps' real path.
export function buildIssueTool(env: AgentDepsEnv): IssueTool {
  if (!isGithubAppMode(env)) {
    return new StubIssueTool();
  }
  const { owner, repo } = resolveRepo(env);
  const tokenProvider: RepoTokenProvider = createTokenProvider({
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  });
  const getToken = (): Promise<string> => tokenProvider(owner, repo);
  return new GithubIssueTool({ getToken, owner, repo, appBotLogin: env.GITHUB_APP_SLUG });
}

// owner/repo from AGENT_DEFAULT_REPO. installation_id is resolved by the
// token provider's repo lookup (M2 threads it from the webhook; M1c does not).
export function resolveRepo(env: AgentDepsEnv): { owner: string; repo: string } {
  const raw = env.AGENT_DEFAULT_REPO;
  if (raw === undefined || raw === '') {
    throw new Error('AGENT_DEFAULT_REPO env var is required (e.g. example-org/software-factory)');
  }
  const [owner, repo, ...rest] = raw.split('/');
  if (owner === undefined || owner === '' || repo === undefined || repo === '' || rest.length > 0) {
    throw new Error(`AGENT_DEFAULT_REPO must be 'owner/repo', got '${raw}'`);
  }
  return { owner, repo };
}

// Resolve the model segment for content brains (short ADR-0008 label;
// contentAgent normalizes to a full API id). BuildAgent's branch model
// segment is threaded separately via AgentDeps.model.
function resolveModel(env: AgentDepsEnv): string {
  return env.ANTHROPIC_MODEL !== undefined && env.ANTHROPIC_MODEL !== ''
    ? env.ANTHROPIC_MODEL
    : 'opus-4-7';
}

// Build the per-dispatch deps bundle, env-gated. Used by every entrypoint;
// the per-role binder picks the subset its handler needs.
export function buildAgentDeps(args: BuildAgentDepsArgs): ResolvedAgentDeps {
  const { env, runId } = args;
  const { owner, repo } = resolveRepo(env);
  const repoSlug = `${owner}/${repo}`;

  if (!isRealMode(env)) {
    // Stub path — no secrets. Tools record in-memory; no brains so handlers
    // use their templated placeholders. CI + in-memory boot stay green.
    // appBotLogin is deliberately NOT threaded here (codex #195): StubPullTool
    // stamps a FIXED Bot author that won't equal a configured GITHUB_APP_SLUG, so
    // the #191 author-login ownership check would reject the stub's own PRs and
    // park every revision. The login-match is a real-substrate forgery guard; in
    // stub mode the fixed Bot author already satisfies isAppAuthor (undefined
    // appBotLogin → any Bot author passes). The real path (below) keeps it.
    return {
      issues: new StubIssueTool(),
      git: new StubGitTool(),
      pulls: new StubPullTool(),
      repo: { owner, repo },
      repoSlug,
    };
  }

  // Real path. One token provider per dispatch, caching the installation
  // token per-repo in-process. getToken(owner,repo) curried per-tool.
  const tokenProvider: RepoTokenProvider = createTokenProvider({
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  });
  const getToken = (): Promise<string> => tokenProvider(owner, repo);

  // Per-run clone dir so concurrent build runs don't collide.
  const workdir = `/tmp/sf-build/${runId}`;
  const gitTool = new GithubGitTool({ getToken, owner, repo, workdir });

  const model = resolveModel(env);
  const anthropicClient = new Anthropic() as unknown as ContentClientLike;
  const generateContent: GenerateContentFn = (req) =>
    runGenerateContent({ ...req, model: req.model ?? model }, anthropicClient);

  const runCodingAgent: RunCodingAgentFn = (req) =>
    runRealCodingAgent(req, sdkQuery as unknown as QueryFn);

  // GithubGitTool.clone is not on the GitTool interface — bind it directly.
  // Ensure the workdir's parent exists first (defensive: git clone creates
  // the destination + its leading dirs, but mkdir -p is a free no-op when
  // present and removes any dependency on that git behavior on a fresh job).
  const clone: CloneFn = (cloneArgs) => {
    mkdirSync(dirname(workdir), { recursive: true });
    return gitTool.clone(cloneArgs);
  };

  return {
    issues: new GithubIssueTool({ getToken, owner, repo, appBotLogin: env.GITHUB_APP_SLUG }),
    git: gitTool,
    pulls: new GithubPullTool({ getToken, owner, repo }),
    repo: { owner, repo },
    repoSlug,
    generateContent,
    runCodingAgent,
    clone,
    workdir,
    ...(env.GITHUB_APP_SLUG !== undefined ? { appBotLogin: env.GITHUB_APP_SLUG } : {}),
  };
}

// GitHub-only deps for OpsAgent. OpsAgent merges PRs + posts a structural
// comment via PullTool, drives the paired Task to done via IssueTool (issue
// #180 post-merge bookkeeping), and NEVER calls an LLM — so its real-vs-stub
// gate must depend on the GitHub App credentials ALONE — decoupled from
// ANTHROPIC_API_KEY (issue #179 review P1). Returns the same real
// GithubPullTool buildAgentDeps wires in full real mode, but reachable
// whenever GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are present even if the
// Anthropic key is absent. `issues` rides the existing buildIssueTool seam
// (the planner's GitHub-only gate — same isGithubAppMode predicate). Falls
// back to stubs only when the GitHub creds are truly absent (CI / in-memory
// boot), so a missing Anthropic key can never downgrade a real merge — or its
// Task bookkeeping — to a silent stub no-op.
export function buildOpsDeps(args: BuildAgentDepsArgs): {
  pulls: PullTool;
  issues: IssueTool;
  repoSlug: string;
} {
  const { env } = args;
  const { owner, repo } = resolveRepo(env);
  const repoSlug = `${owner}/${repo}`;
  const issues = buildIssueTool(env);

  if (!isGithubAppMode(env)) {
    return { pulls: new StubPullTool(), issues, repoSlug };
  }

  const tokenProvider: RepoTokenProvider = createTokenProvider({
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  });
  const getToken = (): Promise<string> => tokenProvider(owner, repo);

  return { pulls: new GithubPullTool({ getToken, owner, repo }), issues, repoSlug };
}
