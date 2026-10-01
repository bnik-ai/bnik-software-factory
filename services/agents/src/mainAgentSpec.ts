// Spec: docs/decisions/0011-agent-dispatch-topology.md (per-role Service Bus
// fan-out — `caj-agent-spec` Container Apps Job consumes `agent-runs-spec`).
// Invariants:
//   - One entrypoint per role with a provisioned per-role Job (spec, design,
//     planner, build, review, ops), each a sibling main*.ts. SREAgent has no
//     per-role Job and no main*.ts entrypoint.
//   - Reads from the queue named by env AGENT_QUEUE_NAME, defaulting to
//     `agent-runs-spec` (the SB queue the orchestrator's
//     ServiceBusAgentDispatcher publishes SpecAgent dispatches to).
//   - Handler is bound at boot. Tools are env-gated via buildAgentDeps: the
//     GitHub-App-backed IssueTool when credentials are set, else StubIssueTool
//     so the binary boots without a substrate.
//   - SB SDK swap (in-memory → @azure/service-bus) is a runtime concern; the
//     consumer interface stays the same. See ADR 0011 for the queue
//     topology and serviceBusAgentRunConsumer.ts for the SDK adapter.

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
      // fresh ULID here (message.deliveryId is not ULID-shaped; see runId.ts).
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
