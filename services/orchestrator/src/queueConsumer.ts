// Spec: docs/design/validator-bot.md "Service Bus session-keyed consumer"
// (the same session-keyed model the validator uses, since the orchestrator
// and validator are SYMMETRIC consumers of the same audit-record/transition
// queue stream — different downstream actions, same per-session ordering
// guarantees).
// Invariants:
//   - This package defines its OWN consumer contract. Mirror of validator's
//     services/validator/src/queueConsumer.ts; each service is independent
//     at the source level (no shared package).
//   - Messages are pulled in batches; consumer is responsible for ACKing
//     or dead-lettering each one by lock token.
//   - Order is per-session (record_node_id). The orchestrator MUST
//     dispatch agent actions in the same per-record order the validator
//     records transitions — otherwise BuildAgent could revise before
//     ReviewAgent flags, etc.

import type { ParsedTransitionMessage } from './types.js';

export interface EventQueueConsumer {
  receive(opts: { maxMessages: number }): Promise<ParsedTransitionMessage[]>;
  ack(lockToken: string): Promise<void>;
  deadletter(lockToken: string, reason: string): Promise<void>;
}

// In-memory consumer for tests and v0 boot. The Service Bus impl is
// ServiceBusDispatchQueueConsumer (serviceBusEventQueueConsumer.ts).
export class InMemoryEventQueueConsumer implements EventQueueConsumer {
  private readonly pending: ParsedTransitionMessage[] = [];
  private readonly inflight: Map<string, ParsedTransitionMessage> = new Map();
  private readonly acked: ParsedTransitionMessage[] = [];
  private readonly deadlettered: Array<{ message: ParsedTransitionMessage; reason: string }> = [];

  enqueue(message: ParsedTransitionMessage): void {
    this.pending.push(message);
  }

  async receive(opts: { maxMessages: number }): Promise<ParsedTransitionMessage[]> {
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
  ackedMessages(): readonly ParsedTransitionMessage[] {
    return this.acked;
  }
  deadletteredMessages(): readonly { message: ParsedTransitionMessage; reason: string }[] {
    return this.deadlettered;
  }
  inflightCount(): number {
    return this.inflight.size;
  }
  pendingCount(): number {
    return this.pending.length;
  }
}
