// Event-queue contract for the webhook's second action after the audit
// ledger insert succeeds.
//
// Per docs/design/azure-adapter.md, the real implementation in B7 will publish
// to Azure Service Bus with `SessionId = record_node_id` so that consumers
// process deliveries for the same substrate record serially. PR3 (this file)
// only defines the interface and an in-memory implementation used by tests
// and v0 boot; `sessionId` is optional here because extracting
// `record_node_id` requires per-event-kind payload parsing that doesn't
// land until a later PR. When omitted, the real Service Bus implementation
// will fall back to a per-delivery session (no per-record serialization);
// callers that need the serialization guarantee must supply `sessionId`.

export interface EnqueueArgs {
  deliveryId: string;
  event: string;
  payload: string;
  sessionId?: string;
  // from the raw webhook body (`repository.full_name` / `installation.id`).
  // Threaded webhook→validator→orchestrator→agents so the validator's
  // read-only SubstrateClient can mint an installation token for the target
  // repo (issue #164). Optional — non-issue/PR deliveries or pre-M2 GitHub
  // payloads may lack `installation`; the validator falls back to the
  // in-memory substrate when absent. The raw payload still carries these
  // fields, so they are also recoverable downstream from `payload`; carrying
  // them explicitly keeps the SB message self-describing.
  repoFullName?: string;
  installationId?: number;
}

export interface EventQueue {
  enqueue(args: EnqueueArgs): Promise<void>;
}

export class InMemoryEventQueue implements EventQueue {
  private readonly messages: EnqueueArgs[] = [];

  async enqueue(args: EnqueueArgs): Promise<void> {
    this.messages.push({ ...args });
  }

  // Test-only inspection helper — not part of the EventQueue contract.
  enqueuedMessages(): readonly EnqueueArgs[] {
    return this.messages;
  }
}
