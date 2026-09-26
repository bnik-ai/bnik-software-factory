// Spec: docs/decisions/0011-agent-dispatch-topology.md — `caj-agent-build`
// Container Apps Job consumes `agent-runs-build`. Shape mirrors
// mainAgentSpec.ts but threads the GitTool/PullTool deps BuildAgent needs
// per ADR 0008/ADR 0009.

import { buildAgentDeps } from './agentDeps.js';
import { runBuildAgent } from './agents/buildAgent.js';
import { startAgentConsumer } from './consumerLoop.js';
import { mintRunId } from './runId.js';

const ROLE = 'BuildAgent' as const;
const DEFAULT_QUEUE_NAME = 'agent-runs-build';
const DEFAULT_MODEL = 'opus-4-7';

function resolveModel(): string {
  const raw = process.env.ANTHROPIC_MODEL;
  if (raw === undefined || raw === '') return DEFAULT_MODEL;
  return raw;
}

export function startBuildAgentConsumer(): ReturnType<typeof startAgentConsumer> {
  return startAgentConsumer({
    role: ROLE,
    defaultQueueName: DEFAULT_QUEUE_NAME,
    handler: (message) => {
      // Per-run ULID per ADR 0008 §2 — also the {ulid} segment of the branch
      // ref sf/T-<id>/<ulid>/build@<model> (issue #109 P1).
      const runId = mintRunId();
      // Env-gated: real GitTool (clone+commit+push) + coding brain when
      // secrets present, else stub tools + scaffold-only path (CI / boot).
      const deps = buildAgentDeps({ env: process.env, runId });
      return runBuildAgent(message, {
        issues: deps.issues,
        git: deps.git,
        pulls: deps.pulls,
        runId,
        repo: deps.repoSlug,
        model: resolveModel(),
        ...(deps.runCodingAgent !== undefined ? { runCodingAgent: deps.runCodingAgent } : {}),
        ...(deps.clone !== undefined ? { clone: deps.clone } : {}),
        ...(deps.workdir !== undefined ? { workdir: deps.workdir } : {}),
        ...(deps.appBotLogin !== undefined ? { appBotLogin: deps.appBotLogin } : {}),
      });
    },
  });
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startBuildAgentConsumer();
}
