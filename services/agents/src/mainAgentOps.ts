// Spec: docs/decisions/0011-agent-dispatch-topology.md — `caj-agent-ops`
// Container Apps Job consumes `agent-runs-ops` (routing key
// `pr:in_review→approved → OpsAgent`). Shape mirrors mainAgentReview.ts /
// mainAgentDesign.ts.
//
// OpsAgent is the merge agent: it squash-merges approved PRs after a
// pre-merge stale-base re-check, then drives the paired Task to done
// (post-merge bookkeeping — see src/agents/opsAgent.ts header + ADR 0012).
// runOpsAgent's deps are `pulls` (PullTool) + `issues` (IssueTool, the
// Task status-label writes) + a per-run ULID; it does not touch
// generateContent / any LLM.
//
// We build the deps via buildOpsDeps — NOT buildAgentDeps — because
// buildAgentDeps' real gate (isRealMode) requires ALL THREE secrets
// including ANTHROPIC_API_KEY, and would silently fall back to StubPullTool
// when the Ops job has GitHub App creds but no Anthropic key, ack'ing the
// approved-PR message after a STUB (no-op) merge — silent data-loss in the
// merge path. buildOpsDeps gates the real
// GithubPullTool + GithubIssueTool on the GitHub App credentials ALONE.

import { buildOpsDeps, isGithubAppMode } from './agentDeps.js';
import { runOpsAgent } from './agents/opsAgent.js';
import { startAgentConsumer } from './consumerLoop.js';
import { mintRunId } from './runId.js';
import {
  SERVICE_BUS_CONNECTION_STRING_ENV,
  SERVICE_BUS_NAMESPACE_ENV,
} from './serviceBusAgentRunConsumer.js';

const ROLE = 'OpsAgent' as const;
const DEFAULT_QUEUE_NAME = 'agent-runs-ops';

// Fail closed: OpsAgent's only job is to MERGE via
// GitHub. If it is wired to a REAL Service Bus queue (live mode) but lacks the
// GitHub App credentials, buildOpsDeps would hand back a StubPullTool and every
// approved-PR message would be acked after a no-op stub merge — silent
// data-loss in the merge path. Boot must throw instead of consuming. The stub
// path stays valid only for the in-memory / CI boot where no real SB is wired.
function assertMergeCapableInLiveMode(env: NodeJS.ProcessEnv): void {
  const realServiceBus =
    (env[SERVICE_BUS_CONNECTION_STRING_ENV] ?? '') !== '' ||
    (env[SERVICE_BUS_NAMESPACE_ENV] ?? '') !== '';
  if (realServiceBus && !isGithubAppMode(env)) {
    throw new Error(
      'OpsAgent refuses to boot: a real Service Bus queue is configured but ' +
        'GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are missing. Merging requires ' +
        'GitHub App credentials; booting with a StubPullTool would ack approved ' +
        'PRs without merging them.',
    );
  }
}

export function startOpsAgentConsumer(): ReturnType<typeof startAgentConsumer> {
  assertMergeCapableInLiveMode(process.env);
  return startAgentConsumer({
    role: ROLE,
    defaultQueueName: DEFAULT_QUEUE_NAME,
    handler: (message) => {
      // Per-run ULID per ADR 0008 §2 — REQUIRED by the validator's
      // attributionStamp parser. Mint here; do NOT reuse
      // message.deliveryId (it isn't ULID-shaped).
      const runId = mintRunId();
      // GitHub-only gate: real GithubPullTool + GithubIssueTool whenever the
      // App secrets are present (decoupled from ANTHROPIC_API_KEY — OpsAgent
      // never calls an LLM), else stubs (CI / in-memory boot). `issues`
      // drives the post-merge Task bookkeeping.
      const deps = buildOpsDeps({ env: process.env, runId });
      return runOpsAgent(message, {
        pulls: deps.pulls,
        issues: deps.issues,
        runId,
      });
    },
  });
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startOpsAgentConsumer();
}
