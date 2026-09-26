// Spec: docs/decisions/0011-agent-dispatch-topology.md (per-role Service Bus
// fan-out — `caj-agent-spec` Container Apps Job consumes `agent-runs-spec`).
// Invariants:
//   - One entrypoint per role; the four roles with provisioned per-role Jobs
//     (spec, design, build, review) each have a sibling main*.ts. PlannerAgent
//     stays a stub in ADR 0013 PR1 (mechanical rename); the real handler +
//     mainAgentPlanner land in PR2. OpsAgent/SREAgent run inline today (no
//     per-role Job provisioned in VHQ Terraform).
//   - Reads from the queue named by env AGENT_QUEUE_NAME, defaulting to
//     `agent-runs-spec` (the SB queue the orchestrator's
//     ServiceBusAgentDispatcher publishes SpecAgent dispatches to).
//   - Handler is bound at boot. v0 wires StubIssueTool so the binary boots
//     without a substrate; B5-PR9+ swaps in the real GitHub-app-backed
//     IssueTool implementation.
//   - SB SDK swap (in-memory → @azure/service-bus) is a runtime concern; the
//     consumer interface stays the same. See ADR 0011 for the queue
//     topology and B7 for the SDK swap.

import { buildAgentDeps } from './agentDeps.js';
import { runSpecAgent } from './agents/specAgent.js';
import { startAgentConsumer } from './consumerLoop.js';
import { mintRunId } from './runId.js';

const ROLE = 'SpecAgent' as const;
const DEFAULT_QUEUE_NAME = 'agent-runs-spec';

export function startSpecAgentConsumer(): ReturnType<typeof startAgentConsumer> {
  return startAgentConsumer({
    role: ROLE,
    defaultQueueName: DEFAULT_QUEUE_NAME,
    handler: (message) => {
      // Per-run ULID per ADR 0008 §2. Validator's attributionStamp parser
      // requires `run` to match /^[0-9A-HJKMNP-TV-Z]{26}$/, so we mint a
      // fresh ULID here (issue #109 P1; wire-envelope run-id is a future fix).
      const runId = mintRunId();
      // Env-gated: real tools + content brain when secrets present, else
      // stub tools + templated placeholder (CI / in-memory boot).
      const deps = buildAgentDeps({ env: process.env, runId });
      return runSpecAgent(message, {
        issues: deps.issues,
        runId,
        repo: deps.repoSlug,
        ...(deps.generateContent !== undefined ? { generateContent: deps.generateContent } : {}),
      });
    },
  });
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startSpecAgentConsumer();
}
