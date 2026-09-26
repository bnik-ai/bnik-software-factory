// Spec: docs/decisions/0011-agent-dispatch-topology.md — `caj-agent-review`
// Container Apps Job consumes `agent-runs-review`.
// Status (B5-PR10): the runner calls runReviewAgent directly so the v0
// placeholder `approved` Review per docs/design/review-agent.md §7 is
// actually emitted. The real multi-model adversarial loop (independent
// review → adjudicate → revision → re-review → convergence per ADR 0010)
// ships in B5-PR11+ once O3 resolves (codex CLI service-auth in the
// headless Container Apps Job). The placeholder Review body names the
// deferral explicitly so the audit ledger reads as a v0 placeholder
// verdict, not a real adjudication.
//
// Fix history: pre-PR-107 this entrypoint dispatched through
// runAgent('ReviewAgent', message), which routed via the LEGACY
// AGENT_REGISTRY stub (makeStubHandler) and never actually called
// runReviewAgent. Codex caught it on issue #105 as a P1
// header-vs-wiring mismatch. Now the entrypoint binds runReviewAgent
// directly with its real deps (issues + pulls + runId + repo), same
// shape as mainAgentSpec / mainAgentDesign / mainAgentBuild.

import { buildAgentDeps } from './agentDeps.js';
import { runReviewAgent } from './agents/reviewAgent.js';
import { startAgentConsumer } from './consumerLoop.js';
import { mintRunId } from './runId.js';

const ROLE = 'ReviewAgent' as const;
const DEFAULT_QUEUE_NAME = 'agent-runs-review';

// v0 default model identifier for the stamp segment per ADR 0009.
// Lowercase, hyphenated; matches the validator's regex `[a-z0-9.-]+`.
function resolveModel(): string {
  const raw = process.env.ANTHROPIC_MODEL;
  return raw !== undefined && raw !== '' ? raw : 'opus-4-7';
}

export function startReviewAgentConsumer(): ReturnType<typeof startAgentConsumer> {
  return startAgentConsumer({
    role: ROLE,
    defaultQueueName: DEFAULT_QUEUE_NAME,
    handler: (message) => {
      // Per-run ULID per ADR 0008 §2 — REQUIRED by the validator's
      // attributionStamp parser (ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/);
      // without it the Review's sf:agent=review@<model> run=<id> attribute
      // fails parsing and the loop breaks (issue #109 P1).
      const runId = mintRunId();
      // Env-gated: real PullTool + content review brain when secrets present,
      // else stub tools + v0 placeholder approve (CI / in-memory boot).
      const deps = buildAgentDeps({ env: process.env, runId });
      return runReviewAgent(message, {
        issues: deps.issues,
        pulls: deps.pulls,
        runId,
        repo: deps.repoSlug,
        model: resolveModel(),
        ...(deps.generateContent !== undefined ? { generateContent: deps.generateContent } : {}),
      });
    },
  });
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startReviewAgentConsumer();
}
