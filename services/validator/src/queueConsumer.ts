// Spec: docs/design/validator-bot.md "Service Bus session-keyed consumer".
// Invariants:
//   - The validator package defines its OWN consumer contract. The
//     producer-side interface lives in services/github-app/src/eventQueue.ts
//     and is symmetric but independent. B7 wires both to one Service Bus
//     namespace; tests use in-memory impls.
//   - Messages are pulled in batches; the consumer is responsible for
//     ACKing or dead-lettering each one by lock token.
//   - Order is per-session (record_node_id) per the design's session-lock
//     contract. In-memory impl preserves FIFO insertion order, which is
//     a strict superset of the session-order guarantee.

import type { Kind } from './kinds.js';
import type { Actor } from './types.js';

// One unit of work the validator processes. Constructed by the
// payloadParser (B3-PR11) + transitionResolver (B3-PR12) from a raw
// GitHub webhook delivery, with the lockToken stitched in at the
// Service Bus boundary.
//
// `verdict` is optional and populated by the validator AFTER FSM evaluation,
// before the message is re-published for downstream consumers (orchestrator).
// At the resolver/dequeue boundary the field is absent (the validator hasn't
// run the FSM yet); at the orchestrator-input boundary the field is present.
// Orchestrator MUST gate dispatch on verdict==='accept' — flagged/rejected
// transitions were recorded by the validator but do not authorize agent work
// (B4-PR4 codex finding: routingTable claimed FSM-accepted-only without an
// actual filter, so a HARD-REJECT outcome could still trigger an agent run).
export type TransitionVerdict = 'accept' | 'flag' | 'reject';

export interface ParsedTransitionMessage {
  lockToken: string;
  deliveryId: string;
  eventType: string;
  kind: Kind;
  actor: Actor;
  recordType: string;
  recordKind?: string;
  recordId: string;
  fromState: string;
  toState: string;
  payloadHash: Buffer;
  receivedAt: Date;
  verdict?: TransitionVerdict;
  // PR-specific transport fields used by the orchestrator's pre-review
  // branch-sync gate (ADR 0012 §"Activation status" activation gate (a)).
  // Populated by payloadParser from `pull_request.head.ref` /
  // `pull_request.base.ref` on `pull_request` + `pull_request_review`
  // events. Undefined for non-PR kinds — the orchestrator gate skips
  // when absent (services/orchestrator/src/processMessage.ts:169).
  headBranch?: string;
  baseBranch?: string;
  // (`repository.full_name`) + GitHub App installation id from the webhook,
  // populated by payloadParser. Threaded onward to the orchestrator + agents
  // so multi-repo dispatch authenticates as the right installation. Optional
  // — non-issue/PR events or pre-M2 messages lack them.
  repoFullName?: string;
  installationId?: number;
}

export interface EventQueueConsumer {
  receive(opts: { maxMessages: number }): Promise<ParsedTransitionMessage[]>;
  ack(lockToken: string): Promise<void>;
  deadletter(lockToken: string, reason: string): Promise<void>;
}

// In-memory consumer for tests and v0 boot. Enqueue messages via
// `enqueue` (test helper); the validator main loop calls `receive`.
// Real Service Bus impl ships in B7.
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
