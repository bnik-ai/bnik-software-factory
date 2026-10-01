// Azure Service Bus implementation of the webhook's EventQueue contract.
//
// Spec: services/github-app/src/eventQueue.ts (the EventQueue interface +
// its header invariant that `sessionId` defaults to the delivery id when a
// caller does not supply a per-record session). Mirrors the validator's
// services/validator/src/outgoingPublisher.ts auth-union shape:
//   - pass `senderFactory` directly (unit-test seam), OR
//   - pass `auth` coords and let this class lazily construct ServiceBusClient.
//
// Produces to the session-enabled `validator-events` queue. The consumer
// (caj-validator) dedupes on `deliveryId`, so this is at-least-once.

import type { EnqueueArgs, EventQueue } from './eventQueue.js';

export const DEFAULT_PRODUCE_QUEUE_NAME = 'validator-events';

export const SERVICE_BUS_CONNECTION_STRING_ENV = 'SERVICE_BUS_CONNECTION_STRING';
export const SERVICE_BUS_NAMESPACE_ENV = 'SERVICE_BUS_NAMESPACE';
export const SERVICE_BUS_PRODUCE_QUEUE_ENV = 'SERVICE_BUS_PRODUCE_QUEUE';

// Minimal subset of @azure/service-bus's ServiceBusSender we use, so the
// real SDK doesn't need to be imported in unit tests.
export interface SenderLike {
  sendMessages(message: {
    body: unknown;
    sessionId?: string;
    contentType?: string;
    messageId?: string;
  }): Promise<void>;
  close?(): Promise<void>;
}

export interface ServiceBusEventQueueConfig {
  // EITHER pass a senderFactory directly (test seam) OR pass the SB
  // connection coords and let the queue construct ServiceBusClient.
  senderFactory?: () => SenderLike | Promise<SenderLike>;
  auth?: { connectionString: string } | { fullyQualifiedNamespace: string; credential: unknown };
  queueName?: string;
}

export class ServiceBusEventQueue implements EventQueue {
  private readonly queueName: string;
  private sender: SenderLike | null = null;
  private readonly senderFactory: () => SenderLike | Promise<SenderLike>;

  constructor(config: ServiceBusEventQueueConfig) {
    this.queueName = config.queueName ?? DEFAULT_PRODUCE_QUEUE_NAME;
    if (config.senderFactory !== undefined) {
      this.senderFactory = config.senderFactory;
    } else if (config.auth !== undefined) {
      const auth = config.auth;
      this.senderFactory = async () => {
        // Lazy-load @azure/service-bus so unit tests that pass
        // senderFactory directly don't depend on the runtime SDK.
        const { ServiceBusClient } = (await import('@azure/service-bus')) as {
          ServiceBusClient: new (...args: unknown[]) => { createSender: (q: string) => SenderLike };
        };
        const client =
          'connectionString' in auth
            ? new ServiceBusClient(auth.connectionString)
            : new ServiceBusClient(auth.fullyQualifiedNamespace, auth.credential);
        return client.createSender(this.queueName);
      };
    } else {
      throw new Error('ServiceBusEventQueue requires either senderFactory or auth in config');
    }
  }

  async enqueue(args: EnqueueArgs): Promise<void> {
    if (this.sender === null) {
      this.sender = await this.senderFactory();
    }
    // `sessionId ?? deliveryId` fallback is REQUIRED by the EventQueue
    // contract (eventQueue.ts header): callers that need per-record
    // serialization supply sessionId; otherwise each delivery is its own
    // session. messageId = deliveryId lets the queue/consumer dedupe.
    await this.sender.sendMessages({
      body: {
        deliveryId: args.deliveryId,
        event: args.event,
        payload: args.payload,
        // Repo slug + installation id (when present on the delivery).
        // Omitted from the body when undefined so the wire shape is
        // unchanged for deliveries lacking an `installation` block.
        ...(args.repoFullName !== undefined ? { repoFullName: args.repoFullName } : {}),
        ...(args.installationId !== undefined ? { installationId: args.installationId } : {}),
      },
      sessionId: args.sessionId ?? args.deliveryId,
      contentType: 'application/json',
      messageId: args.deliveryId,
    });
  }
}

export type EventQueueBootConfig =
  | { kind: 'in-memory' }
  | { kind: 'connection-string'; connectionString: string; queueName: string }
  | { kind: 'managed-identity'; fullyQualifiedNamespace: string; queueName: string };

// Env-driven boot resolution. Prefers an explicit connection string; else
// falls back to managed-identity against the namespace FQDN; else in-memory
// (keeps the v0 boot + existing test suite working with no SB env set).
export function resolveEventQueueBootConfig(): EventQueueBootConfig {
  // Treat a set-but-empty SERVICE_BUS_PRODUCE_QUEUE as unset (consistent with
  // the connection-string / namespace reads below); `??` alone would keep ''
  // and hand the SB sender an invalid queue name.
  const rawQueue = process.env[SERVICE_BUS_PRODUCE_QUEUE_ENV];
  const queueName =
    rawQueue === undefined || rawQueue === '' ? DEFAULT_PRODUCE_QUEUE_NAME : rawQueue;
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
