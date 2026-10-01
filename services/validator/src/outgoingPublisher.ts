// Spec: docs/design/azure-adapter.md (per-role SB topology) + ADR 0011
// (orchestrator → agents dispatch via per-role queues).
// Invariants:
//   - The validator publishes ONE outbound message per inbound message
//     it acks. The outbound payload is the same ParsedTransitionMessage
//     it consumed, with `verdict` populated from the FSM evaluation
//     result. caj-orchestrator consumes this queue (per VHQ
//     factory/dev/application: `agent-runs-dispatch`).
//   - Wire format: JSON. Buffer (`payloadHash`) → hex string; Date
//     (`receivedAt`) → ISO 8601. Matches the shape the orchestrator's
//     ServiceBusAgentDispatcher uses for downstream per-role queues.
//   - Publish must succeed BEFORE the inbound message is acked. If
//     publish fails, the caller throws so the SB lock times out, SB
//     redelivers, the validator re-processes (audit ledger sees a
//     duplicate, returns idempotent), and the publish retries. This is
//     the at-least-once delivery discipline that lets the downstream
//     orchestrator never see a flagged/rejected validator outcome
//     without the corresponding audit row already on disk.
//   - Two real impls: SB connection-string OR managed identity. v0 boot
//     uses InMemoryOutgoingPublisher (records published messages for
//     tests). Construction is gated by env vars resolved via
//     resolveOutgoingPublisherBootConfig.
//   - Real SB SDK calls happen via a `senderFactory` test seam so unit
//     tests can assert wire shape without opening a real connection.

import type { ParsedTransitionMessage } from './queueConsumer.js';
import type { Verdict } from './types.js';

// The downstream queue name. Matches the platform-overlay Terraform
// (factory/dev/application caj-orchestrator service_bus_queue_name).
export const DEFAULT_DISPATCH_QUEUE_NAME = 'agent-runs-dispatch';

export const SERVICE_BUS_CONNECTION_STRING_ENV = 'SERVICE_BUS_CONNECTION_STRING';
export const SERVICE_BUS_NAMESPACE_ENV = 'SERVICE_BUS_NAMESPACE';
export const SERVICE_BUS_DISPATCH_QUEUE_ENV = 'SERVICE_BUS_DISPATCH_QUEUE';

export interface PublishedMessageWire {
  message: WireParsedTransitionMessage;
  verdict: { verdict: Verdict['verdict']; reason?: string };
}

export interface WireParsedTransitionMessage {
  lockToken: string;
  deliveryId: string;
  eventType: string;
  kind: ParsedTransitionMessage['kind'];
  actor: ParsedTransitionMessage['actor'];
  recordType: string;
  recordKind?: string;
  recordId: string;
  fromState: string;
  toState: string;
  payloadHash: string;
  receivedAt: string;
  verdict: Verdict['verdict'];
  // ADR 0012 §"Activation status" activation gate (a). Optional on the
  // wire: emitted only for PR-kind transitions where the parser
  // populated them from `pull_request.head.ref` / `pull_request.base.ref`.
  // The orchestrator-side wire-deserializer (sister
  // serviceBusAgentDispatcher) accepts both fields and feeds
  // them to the BranchSyncChecker via processMessage.
  headBranch?: string;
  baseBranch?: string;
  // GitHub App installation id, threaded off the webhook. Optional on the
  // wire (emitted only when the parser populated them). The orchestrator's
  // ServiceBusAgentDispatcher forwards both onto the agent-dispatch message
  // so a multi-repo agent run authenticates as the right installation.
  // Without emitting them HERE, the orchestrator never receives them and the
  // downstream serialize additions have nothing to forward.
  repoFullName?: string;
  installationId?: number;
}

export interface OutgoingPublisher {
  publish(message: ParsedTransitionMessage, verdict: Verdict): Promise<void>;
  // Release any underlying transport handles (the SB sender + its
  // ServiceBusClient). The consumer-loop boot MUST call this when the loop
  // ends — an open AMQP connection keeps the Node event loop alive, so a
  // drained Container Apps Job execution never exits and is killed at the
  // replica timeout → 'Failed' despite correct processing. Optional: the
  // in-memory impl holds no handles.
  close?(): Promise<void>;
}

export function serializePublishedMessage(
  message: ParsedTransitionMessage,
  verdict: Verdict,
): PublishedMessageWire {
  // headBranch/baseBranch are emitted only when defined so non-PR
  // transitions keep the unchanged wire shape and the orchestrator's
  // existing skip-when-absent gate governs them. Matches the
  // orchestrator's sister serializer in serviceBusAgentDispatcher.ts.
  const wireMessage: WireParsedTransitionMessage = {
    lockToken: message.lockToken,
    deliveryId: message.deliveryId,
    eventType: message.eventType,
    kind: message.kind,
    actor: message.actor,
    recordType: message.recordType,
    recordKind: message.recordKind,
    recordId: message.recordId,
    fromState: message.fromState,
    toState: message.toState,
    payloadHash: message.payloadHash.toString('hex'),
    receivedAt: message.receivedAt.toISOString(),
    verdict: verdict.verdict,
  };
  if (message.headBranch !== undefined) wireMessage.headBranch = message.headBranch;
  if (message.baseBranch !== undefined) wireMessage.baseBranch = message.baseBranch;
  // Emit repo slug + installation id when present (omitted otherwise so
  // the wire shape is unchanged for transitions lacking them).
  if (message.repoFullName !== undefined) wireMessage.repoFullName = message.repoFullName;
  if (message.installationId !== undefined) wireMessage.installationId = message.installationId;
  return {
    message: wireMessage,
    verdict:
      verdict.verdict === 'accept'
        ? { verdict: 'accept' }
        : { verdict: verdict.verdict, reason: verdict.reason },
  };
}

// In-memory impl for tests + v0 boot. Records every publish so tests
// can assert ordering, payload shape, verdict propagation.
export class InMemoryOutgoingPublisher implements OutgoingPublisher {
  private readonly published: PublishedMessageWire[] = [];

  async publish(message: ParsedTransitionMessage, verdict: Verdict): Promise<void> {
    this.published.push(serializePublishedMessage(message, verdict));
  }

  publishedMessages(): readonly PublishedMessageWire[] {
    return this.published;
  }
  publishCount(): number {
    return this.published.length;
  }
}

// Minimal subset of @azure/service-bus's ServiceBusSender we use, so the
// real SDK doesn't need to be imported in unit tests.
export interface SenderLike {
  sendMessages(messages: { body: unknown; sessionId?: string }): Promise<void>;
  close?(): Promise<void>;
}

export interface ServiceBusOutgoingPublisherConfig {
  // EITHER pass a senderFactory directly (test seam) OR pass the SB
  // connection coords and let the publisher construct ServiceBusClient.
  senderFactory?: () => SenderLike | Promise<SenderLike>;
  auth?: { connectionString: string } | { fullyQualifiedNamespace: string; credential: unknown };
  queueName?: string;
}

export class ServiceBusOutgoingPublisher implements OutgoingPublisher {
  private readonly queueName: string;
  private sender: SenderLike | null = null;
  private readonly senderFactory: () => SenderLike | Promise<SenderLike>;
  // The lazily-created ServiceBusClient behind the sender (auth mode only;
  // null in senderFactory test-seam mode). Closed by close() — see the
  // OutgoingPublisher.close contract (idle-exit leak).
  private sbClient: { close(): Promise<void> } | null = null;

  constructor(config: ServiceBusOutgoingPublisherConfig) {
    this.queueName = config.queueName ?? DEFAULT_DISPATCH_QUEUE_NAME;
    if (config.senderFactory !== undefined) {
      this.senderFactory = config.senderFactory;
    } else if (config.auth !== undefined) {
      const auth = config.auth;
      this.senderFactory = async () => {
        // Lazy-load @azure/service-bus so unit tests that pass
        // senderFactory directly don't depend on the runtime SDK.
        const { ServiceBusClient } = (await import('@azure/service-bus')) as {
          ServiceBusClient: new (
            ...args: unknown[]
          ) => { createSender: (q: string) => SenderLike; close(): Promise<void> };
        };
        const client =
          'connectionString' in auth
            ? new ServiceBusClient(auth.connectionString)
            : new ServiceBusClient(auth.fullyQualifiedNamespace, auth.credential);
        this.sbClient = client;
        return client.createSender(this.queueName);
      };
    } else {
      throw new Error(
        'ServiceBusOutgoingPublisher requires either senderFactory or auth in config',
      );
    }
  }

  // Closes the sender + its ServiceBusClient (when this publisher created
  // one). Idempotent; close errors are swallowed (the loop already finished
  // its work — a failed transport teardown must not turn a clean drain into
  // a failed execution).
  async close(): Promise<void> {
    const sender = this.sender;
    this.sender = null;
    if (sender?.close !== undefined) {
      await sender.close().catch(() => undefined);
    }
    const client = this.sbClient;
    this.sbClient = null;
    if (client !== null) {
      await client.close().catch(() => undefined);
    }
  }

  async publish(message: ParsedTransitionMessage, verdict: Verdict): Promise<void> {
    if (this.sender === null) {
      this.sender = await this.senderFactory();
    }
    const wire = serializePublishedMessage(message, verdict);
    // Session-keyed by recordId so the orchestrator's per-session
    // ordering discipline (validator-bot.md "Service Bus session-keyed
    // consumer") carries across the bridge.
    await this.sender.sendMessages({ body: wire, sessionId: message.recordId });
  }
}

export type OutgoingPublisherBootConfig =
  | { kind: 'in-memory' }
  | { kind: 'connection-string'; connectionString: string; queueName: string }
  | {
      kind: 'managed-identity';
      fullyQualifiedNamespace: string;
      queueName: string;
    };

// Env-driven boot resolution. Mirrors the orchestrator's dispatcher
// resolution shape so operators set the same env on both
// sides for the same auth mode.
export function resolveOutgoingPublisherBootConfig(): OutgoingPublisherBootConfig {
  const queueName = process.env[SERVICE_BUS_DISPATCH_QUEUE_ENV] ?? DEFAULT_DISPATCH_QUEUE_NAME;
  const connStr = process.env[SERVICE_BUS_CONNECTION_STRING_ENV];
  if (connStr !== undefined && connStr !== '') {
    return { kind: 'connection-string', connectionString: connStr, queueName };
  }
  const namespace = process.env[SERVICE_BUS_NAMESPACE_ENV];
  if (namespace !== undefined && namespace !== '') {
    return { kind: 'managed-identity', fullyQualifiedNamespace: namespace, queueName };
  }
  return { kind: 'in-memory' };
}
