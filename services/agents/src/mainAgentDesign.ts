// Spec: docs/decisions/0011-agent-dispatch-topology.md — `caj-agent-design`
// Container Apps Job consumes `agent-runs-design`. Shape mirrors
// mainAgentSpec.ts.

import { buildAgentDeps } from './agentDeps.js';
import { runDesignAgent } from './agents/designAgent.js';
import { startAgentConsumer } from './consumerLoop.js';
import { mintRunId } from './runId.js';

const ROLE = 'DesignAgent' as const;
const DEFAULT_QUEUE_NAME = 'agent-runs-design';

export function startDesignAgentConsumer(): ReturnType<typeof startAgentConsumer> {
  return startAgentConsumer({
    role: ROLE,
    defaultQueueName: DEFAULT_QUEUE_NAME,
    handler: (message) => {
      // Per-run ULID per ADR 0008 §2 (see runId.ts).
      const runId = mintRunId();
      const deps = buildAgentDeps({ env: process.env, runId });
      return runDesignAgent(message, {
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
  startDesignAgentConsumer();
}
