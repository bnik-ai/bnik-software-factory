// Spec: docs/decisions/0011-agent-dispatch-topology.md (per-role Service Bus
// fan-out — one queue per agent role; the orchestrator's
// ServiceBusAgentDispatcher publishes to `agent-runs-<role>`, this consumer
// pulls from it).
// Invariants:
//   - Symmetric to the validator's EventQueueConsumer / ParsedTransitionMessage
//     contract — the agents service owns its consumer interface so the wire
//     boundary is explicit. Deployed, validator and agents share one Service
//     Bus namespace; tests use the in-memory impls.
//   - Per-role queue ordering: a single Container Apps Job execution drains
//     one role-scoped queue (`agent-runs-spec` etc.). Session-locking at the
//     SB layer keeps per-record ordering when the dispatcher uses a session
//     id (record_node_id).
//   - On per-message handler failure, the consumer loop ENDS THE EXECUTION
//     (mirroring the validator's session-ordering discipline). KEDA spawns a
//     fresh execution that redelivers the failed message first.
//   - `AgentRunMessage` is the deserialized envelope the orchestrator's
//     ServiceBusAgentDispatcher publishes (see payloadParser.ts). The wire
//     format is JSON; this type is what the entrypoint sees after parsing.

import type { AgentRole, ParsedTransitionMessage } from './types.js';

// One unit of work the per-role agent Container Apps Job processes. The
// outer envelope carries the dispatch targeting (agent role + transition
// key); the inner `message` is the validator's ParsedTransitionMessage that
// triggered the dispatch.
export interface AgentRunMessage {
  // SB lock token — the consumer needs it to ack / deadletter.
  lockToken: string;
  // Per-message envelope: which role the orchestrator targeted (defensive —
  // should match this entrypoint's role; mismatch is deadlettered) and the
  // routing key that selected this role (for audit + diagnostics).
  agent: AgentRole;
  transitionKey: string;
  // The validator's parsed transition message. The entrypoint passes this
  // through to the per-role agent runner.
  message: ParsedTransitionMessage;
}

export interface AgentRunQueueConsumer {
  receive(opts: { maxMessages: number }): Promise<AgentRunMessage[]>;
  ack(lockToken: string): Promise<void>;
  deadletter(lockToken: string, reason: string): Promise<void>;
}

// In-memory consumer for tests and v0 boot. Enqueue messages via `enqueue`
// (test helper); the entrypoint main loop calls `receive`. The real Service
// Bus impl (serviceBusAgentRunConsumer.ts) implements the same interface.
export class InMemoryAgentRunQueueConsumer implements AgentRunQueueConsumer {
  private readonly pending: AgentRunMessage[] = [];
  private readonly inflight: Map<string, AgentRunMessage> = new Map();
  private readonly acked: AgentRunMessage[] = [];
  private readonly deadlettered: Array<{ message: AgentRunMessage; reason: string }> = [];

  enqueue(message: AgentRunMessage): void {
    this.pending.push(message);
  }

  async receive(opts: { maxMessages: number }): Promise<AgentRunMessage[]> {
    const batch = this.pending.splice(0, Math.max(0, opts.maxMessages));
    for (const message of batch) this.inflight.set(message.lockToken, message);
    return batch;
  }

  async ack(lockToken: string): Promise<void> {
    const message = this.inflight.get(lockToken);
    if (message === undefined) {
      throw new Error(`ack: unknown lock token "${lockToken}"`);
    }
    this.inflight.delete(lockToken);
    this.acked.push(message);
  }

  async deadletter(lockToken: string, reason: string): Promise<void> {
    const message = this.inflight.get(lockToken);
    if (message === undefined) {
      throw new Error(`deadletter: unknown lock token "${lockToken}"`);
    }
    this.inflight.delete(lockToken);
    this.deadlettered.push({ message, reason });
  }

  // Test-only inspection.
  ackedMessages(): readonly AgentRunMessage[] {
    return this.acked;
  }
  deadletteredMessages(): readonly { message: AgentRunMessage; reason: string }[] {
    return this.deadlettered;
  }
  inflightCount(): number {
    return this.inflight.size;
  }
  pendingCount(): number {
    return this.pending.length;
  }
}
