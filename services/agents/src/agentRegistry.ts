// Spec: docs/architecture.md (L3 agent definitions).
// Invariants:
//   - Pure registry: maps AgentRole → AgentHandler. No I/O at registration
//     time; handlers may do I/O when invoked.
//   - Every role in the AgentRole union MUST have a handler. The
//     `runAgent` dispatcher returns a typed failure if the role isn't
//     in the registry — never throws — so the orchestrator can route
//     the failure cleanly.
//   - The registry returns *bound* handlers: the per-agent runner needs
//     IssueTool / GitTool / PullTool plus a per-run ULID. The factory
//     binds them at registry-construction time so the AgentHandler
//     signature remains (message) → Promise<AgentResult>.
//   - v0 ships REAL handlers for SpecAgent (B5-PR3), DesignAgent (B5-PR4),
//     BuildAgent (B5-PR5), OpsAgent (B5-PR6), SREAgent (B5-PR7),
//     ReviewAgent (B5-PR10 — v0 placeholder verdict per design-doc §7;
//     real multi-model loop in B5-PR11+ once codex O3 resolves), and
//     PlannerAgent (ADR 0013 PR2 — continuous triage / dependency-order /
//     ready-gate engine over a live Task backlog; SubstrateClient stub
//     boot, GitHub-backed impl follows in B5-PR11+).
//   - Handlers are async even for stubs so the contract matches the real
//     impl (every real agent will do I/O — API calls, git operations,
//     substrate writes).

import { type CloneFn, type RunCodingAgentFn, runBuildAgent } from './agents/buildAgent.js';
import { runDesignAgent } from './agents/designAgent.js';
import { runOpsAgent } from './agents/opsAgent.js';
import { runPlannerAgent } from './agents/plannerAgent.js';
import { runReviewAgent } from './agents/reviewAgent.js';
import { type GenerateContentFn, runSpecAgent } from './agents/specAgent.js';
import { runSreAgent } from './agents/sreAgent.js';
import type { GitTool } from './tools/gitTool.js';
import type { IssueTool } from './tools/issueTool.js';
import type { PlannerSubstrateClient } from './tools/plannerSubstrateClient.js';
import type { PullTool } from './tools/pullTool.js';
import type { AgentRole, ParsedTransitionMessage } from './types.js';

export type AgentResult = { ok: true; result: string } | { ok: false; reason: string };

export type AgentHandler = (message: ParsedTransitionMessage) => Promise<AgentResult>;

// Per-dispatch context the orchestrator-side caller supplies when
// building the registry. v0 stubs ignore most of these; real agents
// use them.
export interface AgentDeps {
  issues: IssueTool;
  git: GitTool;
  pulls: PullTool;
  // PlannerAgent's backlog-aware substrate seam (ADR 0013 PR2). v0 wires
  // StubPlannerSubstrateClient; real GitHub-app-backed impl in B5-PR11+.
  plannerSubstrate: PlannerSubstrateClient;
  // Per-run ULID, per ADR 0008. The mainConsumer mints this at dispatch
  // time and threads it through so the same ULID lands in the branch
  // name (BuildAgent), structural comments (every agent), and the audit
  // ledger row.
  runId: string;
  // Repo where new substrate records the agent creates land. v0 = same
  // repo as the triggering record per ADR 0003 (planning records co-
  // locate with the app repo).
  repo: string;
  // Anthropic model identifier for the dispatching agent (e.g. 'opus-4-7').
  // Lowercase, hyphenated, matches the ADR 0008 branch-grammar regex
  // `[a-z0-9.-]+`. BuildAgent uses it as the model segment of the ref.
  // Other agents may use it for attribution but don't structurally require
  // it. Orchestrator boot reads ANTHROPIC_MODEL env.
  model: string;
  // Optional real brains (M1c). Present on the env-gated real path, absent
  // on the stub path so handlers fall back to their templated placeholders.
  // generateContent feeds Spec/Design/Review; runCodingAgent + clone feed
  // BuildAgent's real implementation flow.
  generateContent?: GenerateContentFn;
  runCodingAgent?: RunCodingAgentFn;
  clone?: CloneFn;
  // Coding workdir BuildAgent's clone targets (real path only).
  workdir?: string;
  // Configured App slug (GITHUB_APP_SLUG) for BuildAgent's #191 auto-revision
  // ownership guard (the PR author must match the App bot). Undefined when unset.
  appBotLogin?: string;
}

// Stub factory: produces a handler that returns a constant success
// envelope tagged with the role name. Used for the six L3 agents that
// haven't been built out yet (B5-PR4..B5-PR9).
function makeStubHandler(role: AgentRole): AgentHandler {
  return async (_message: ParsedTransitionMessage): Promise<AgentResult> => ({
    ok: true,
    result: `${role}: stub`,
  });
}

// Build the registry for a single dispatch. The orchestrator-side caller
// constructs a fresh registry per message so the per-run ULID + repo are
// scoped to that dispatch. Cheap — handlers are closures over deps; no
// I/O at construction.
export function buildAgentRegistry(deps: AgentDeps): ReadonlyMap<AgentRole, AgentHandler> {
  return new Map<AgentRole, AgentHandler>([
    [
      'SpecAgent',
      (message: ParsedTransitionMessage) =>
        runSpecAgent(message, {
          issues: deps.issues,
          runId: deps.runId,
          repo: deps.repo,
          ...(deps.generateContent !== undefined ? { generateContent: deps.generateContent } : {}),
        }),
    ],
    [
      'DesignAgent',
      (message: ParsedTransitionMessage) =>
        runDesignAgent(message, {
          issues: deps.issues,
          runId: deps.runId,
          repo: deps.repo,
          ...(deps.generateContent !== undefined ? { generateContent: deps.generateContent } : {}),
        }),
    ],
    [
      'PlannerAgent',
      (message: ParsedTransitionMessage) =>
        runPlannerAgent(message, {
          substrate: deps.plannerSubstrate,
          runId: deps.runId,
          repo: deps.repo,
        }),
    ],
    [
      'BuildAgent',
      (message: ParsedTransitionMessage) =>
        runBuildAgent(message, {
          issues: deps.issues,
          git: deps.git,
          pulls: deps.pulls,
          runId: deps.runId,
          repo: deps.repo,
          model: deps.model,
          ...(deps.runCodingAgent !== undefined ? { runCodingAgent: deps.runCodingAgent } : {}),
          ...(deps.clone !== undefined ? { clone: deps.clone } : {}),
          ...(deps.workdir !== undefined ? { workdir: deps.workdir } : {}),
          ...(deps.appBotLogin !== undefined ? { appBotLogin: deps.appBotLogin } : {}),
        }),
    ],
    [
      'ReviewAgent',
      (message: ParsedTransitionMessage) =>
        runReviewAgent(message, {
          issues: deps.issues,
          pulls: deps.pulls,
          runId: deps.runId,
          repo: deps.repo,
          model: deps.model,
          ...(deps.generateContent !== undefined ? { generateContent: deps.generateContent } : {}),
        }),
    ],
    [
      'OpsAgent',
      (message: ParsedTransitionMessage) =>
        runOpsAgent(message, { pulls: deps.pulls, issues: deps.issues, runId: deps.runId }),
    ],
    ['SREAgent', (message: ParsedTransitionMessage) => runSreAgent(message, { runId: deps.runId })],
  ]);
}

// Legacy stub-only registry retained for callers that don't (yet) thread
// deps. B5-PR4+ migrates the orchestrator boot to buildAgentRegistry();
// once all callers are migrated this constant is removed.
export const AGENT_REGISTRY: ReadonlyMap<AgentRole, AgentHandler> = new Map([
  ['SpecAgent', makeStubHandler('SpecAgent')],
  ['DesignAgent', makeStubHandler('DesignAgent')],
  ['PlannerAgent', makeStubHandler('PlannerAgent')],
  ['BuildAgent', makeStubHandler('BuildAgent')],
  ['ReviewAgent', makeStubHandler('ReviewAgent')],
  ['OpsAgent', makeStubHandler('OpsAgent')],
  ['SREAgent', makeStubHandler('SREAgent')],
]);

export async function runAgent(
  role: AgentRole,
  message: ParsedTransitionMessage,
  registry: ReadonlyMap<AgentRole, AgentHandler> = AGENT_REGISTRY,
): Promise<AgentResult> {
  const handler = registry.get(role);
  if (handler === undefined) {
    return { ok: false, reason: `unknown_agent_role:${role}` };
  }
  return handler(message);
}
