// Spec: docs/architecture.md (L3 SREAgent observes Deployment failures).
// Invariants:
//   - Triggered by routing keys `deployment:in_progress→failure` and
//     `deployment:in_progress→error`. Defensive guard returns typed
//     wrong_transition failure on anything else.
//   - v0 minimum: observe and acknowledge. The validator's audit ledger
//     already recorded the failure transition; SREAgent's run-row in the
//     ledger is the "an SRE was paged" evidence. No tool calls — real
//     alerting (PagerDuty / Slack / Log Analytics rules) wires in
//     B5-PR9+ when an alerting adapter exists.
//   - The result envelope names the deployment failure mode (failure vs
//     error) and the recordId so the audit ledger row carries enough
//     context for post-incident analysis without joining other rows.

import type { AgentResult } from '../agentRegistry.js';
import type { ParsedTransitionMessage } from '../types.js';

export interface SreAgentDeps {
  runId: string;
}

type FailureMode = 'failure' | 'error';
const FAILURE_MODES: ReadonlySet<string> = new Set(['failure', 'error']);

export async function runSreAgent(
  message: ParsedTransitionMessage,
  deps: SreAgentDeps,
): Promise<AgentResult> {
  if (message.kind !== 'deployment') {
    return {
      ok: false,
      reason: `sre_agent_wrong_transition:${message.kind}:${message.fromState}→${message.toState}`,
    };
  }
  if (message.fromState !== 'in_progress' || !FAILURE_MODES.has(message.toState)) {
    return {
      ok: false,
      reason: `sre_agent_not_failure_state:${message.fromState}→${message.toState}`,
    };
  }

  const failureMode = message.toState as FailureMode;
  return {
    ok: true,
    result: `SREAgent: observed deployment ${failureMode} on ${message.recordId} (run ${deps.runId}); alerting deferred to B5-PR9+ adapter`,
  };
}
