// Spec: docs/architecture.md (L4 dispatches to L3 agents).
// Invariants:
//   - dispatch() returns a typed result (success/failure) — the caller
//     decides whether to ack the source message or deadletter it.
//   - The transport is hidden behind this interface. The production impl
//     is ServiceBusAgentDispatcher (one queue per agent role, ADR 0011);
//     InMemoryAgentDispatcher just records attempts so tests + the
//     consumer loop can exercise the full path.

import type { AgentRole, ParsedTransitionMessage } from './types.js';

export interface DispatchRequest {
  // The agent to invoke for this transition.
  agent: AgentRole;
  // The transition that caused the dispatch (full message, not just
  // the routing key, so the agent has the audit context it needs).
  message: ParsedTransitionMessage;
  // Set by the router; opaque to the dispatcher itself but recorded for
  // observability.
  transitionKey: string;
}

export type DispatchResult =
  | { ok: true; agent: AgentRole; dispatchId: string }
  | {
      ok: false;
      agent: AgentRole;
      reason: string;
      // `transient: true` means the dispatch failed for a reason that's
      // likely to resolve on retry (SB throttling, transient network,
      // upstream temporarily unavailable). The consumer should NOT ack
      // the inbound message so SB redelivers and the loop retries.
      // `transient: false` (or undefined for backward compat) means the
      // failure is deterministic — retrying produces the same result —
      // so the consumer acks with an audit signal instead of looping.
      // The ServiceBusAgentDispatcher classifies SB SDK errors at the
      // dispatcher boundary; in-memory + test stubs default to undefined
      // (treated as deterministic) so existing behavior is preserved.
      transient?: boolean;
    };

export interface AgentDispatcher {
  dispatch(request: DispatchRequest): Promise<DispatchResult>;
  // Optional resource cleanup. The real ServiceBusAgentDispatcher pools
  // senders + a ServiceBusClient whose open AMQP handles keep the Container
  // Apps Job process alive; mainConsumer calls this on idle-drain/shutdown so
  // the Job exits cleanly. In-memory/test impls hold no handles and omit it.
  close?(): Promise<void>;
}

// In-memory dispatcher for tests + v0 boot. Records every dispatch
// attempt; never fails (ServiceBusAgentDispatcher surfaces real enqueue
// failures).
export class InMemoryAgentDispatcher implements AgentDispatcher {
  private readonly attempts: DispatchRequest[] = [];
  private nextDispatchId = 1;

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    this.attempts.push(request);
    const dispatchId = `disp-${this.nextDispatchId}`;
    this.nextDispatchId += 1;
    return { ok: true, agent: request.agent, dispatchId };
  }

  // Test-only inspection.
  dispatchAttempts(): readonly DispatchRequest[] {
    return this.attempts;
  }
  attemptCount(): number {
    return this.attempts.length;
  }
}
