// Spec: docs/decisions/0011-agent-dispatch-topology.md (per-role Service
// Bus fan-out — `caj-agent-planner` Container Apps Job consumes
// `agent-runs-planner` queue) + docs/decisions/0013-planner-agent.md
// §Decision items 1, 4, 6 (continuous triage / dependency-order / ready-
// gate engine; opus-4-7's lane).
// Invariants:
//   - One entrypoint per role; shape mirrors mainAgentSpec / mainAgentDesign
//     / mainAgentBuild / mainAgentReview. Per-role Job names match the
//     VHQ-provisioned `caj-agent-<role>` + `agent-runs-<role>` topology
//     (ADR 0011); the physical names are unchanged by the role rename per ADR
//     0013 §6 (only the role identifier moved — infra names follow on
//     the VHQ-side migration).
//   - Reads from the queue named by env AGENT_QUEUE_NAME, defaulting to
//     `agent-runs-planner`.
//   - PlannerAgent's substrate seam is PlannerSubstrateClient — NOT the
//     per-record IssueTool every other agent uses — because the planner
//     needs a backlog query (list-by-state) the IssueTool does not
//     expose. Env-gated: when GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY +
//     AGENT_DEFAULT_REPO are all present, wires the real GitHub-app-backed
//     GithubPlannerSubstrateClient (REST search + GraphQL reads + label
//     writes); otherwise StubPlannerSubstrateClient so the binary boots +
//     CI (no GitHub creds) stays green.
//   - Per-run ULID per ADR 0008 §2 (validator's attributionStamp parser
//     requires `run` to match /^[0-9A-HJKMNP-TV-Z]{26}$/). We mint via
//     mintRunId() — DO NOT use message.deliveryId (it isn't ULID-shaped,
//     so the validator rejects the stamp).

import { buildAgentDeps, buildIssueTool } from './agentDeps.js';
import { runPlannerAgent } from './agents/plannerAgent.js';
import { createTokenProvider } from './auth/installationToken.js';
import { startAgentConsumer } from './consumerLoop.js';
import { mintRunId } from './runId.js';
import {
  GithubPlannerSubstrateClient,
  type PlannerSubstrateClient,
  StubPlannerSubstrateClient,
} from './tools/plannerSubstrateClient.js';

const ROLE = 'PlannerAgent' as const;
const DEFAULT_QUEUE_NAME = 'agent-runs-planner';

// AGENT_DEFAULT_REPO is the home repo the planner reads + writes Tasks
// against ('owner/repo'). Required for both stub (repo context for the
// result envelope) and real (search/label scope) paths.
function resolveRepo(): { slug: string; owner: string; repo: string } {
  const raw = process.env.AGENT_DEFAULT_REPO;
  if (raw === undefined || raw === '') {
    throw new Error('AGENT_DEFAULT_REPO env var is required (e.g. example-org/software-factory)');
  }
  const [owner, repo, ...rest] = raw.split('/');
  if (owner === undefined || owner === '' || repo === undefined || repo === '' || rest.length > 0) {
    throw new Error(`AGENT_DEFAULT_REPO must be 'owner/repo', got '${raw}'`);
  }
  return { slug: raw, owner, repo };
}

// True iff the real-substrate gate is satisfied (App secrets present). The
// repo comes from AGENT_DEFAULT_REPO (required either way).
function isRealMode(): boolean {
  const appId = process.env.GITHUB_APP_ID;
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  return appId !== undefined && appId !== '' && pem !== undefined && pem !== '';
}

// Build the substrate seam for one dispatch. The GitHub-backed client
// carries the per-run ULID (stamped into the structural marker on each
// proposed→ready comment), so it is constructed per-message.
function buildPlannerSubstrate(
  runId: string,
  repo: { owner: string; repo: string },
): PlannerSubstrateClient {
  if (!isRealMode()) {
    return new StubPlannerSubstrateClient();
  }
  const tokenProvider = createTokenProvider({
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
  });
  return new GithubPlannerSubstrateClient({
    getToken: () => tokenProvider(repo.owner, repo.repo),
    owner: repo.owner,
    repo: repo.repo,
    runId,
  });
}

export function startPlannerAgentConsumer(): ReturnType<typeof startAgentConsumer> {
  return startAgentConsumer({
    role: ROLE,
    defaultQueueName: DEFAULT_QUEUE_NAME,
    handler: (message) => {
      // Per-run ULID per ADR 0008 §2, minted here because message.deliveryId
      // is not ULID-shaped (see runId.ts).
      const runId = mintRunId();
      const repo = resolveRepo();
      const substrate = buildPlannerSubstrate(runId, repo);
      // The PROMOTE path uses `substrate` (backlog query). The DECOMPOSE path
      // (design:ratified → Tasks) needs the per-record IssueTool +
      // content brain. These gate INDEPENDENTLY:
      //   - issues: GitHub creds ALONE (buildIssueTool / isGithubAppMode) — a
      //     real GithubIssueTool whenever GitHub creds exist, even with no
      //     ANTHROPIC_API_KEY. Otherwise decompose would read an empty Design
      //     from a StubIssueTool and deadletter instead of running the no-brain
      //     single-Task fallback against real GitHub.
      //   - generateContent: ANTHROPIC_API_KEY (via buildAgentDeps' isRealMode).
      //     Absent → no brain → decompose's single-Task fallback (correct).
      const issues = buildIssueTool(process.env);
      const deps = buildAgentDeps({ env: process.env, runId });
      return runPlannerAgent(message, {
        substrate,
        runId,
        repo: repo.slug,
        issues,
        ...(deps.generateContent !== undefined ? { generateContent: deps.generateContent } : {}),
      });
    },
  });
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startPlannerAgentConsumer();
}
