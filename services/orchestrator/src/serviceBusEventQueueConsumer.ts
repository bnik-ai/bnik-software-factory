// Spec: docs/design/validator-bot.md "Service Bus session-keyed consumer" +
// docs/decisions/0011-agent-dispatch-topology.md. Real EventQueueConsumer
// backed by the `agent-runs-dispatch` queue the validator's outgoingPublisher
// feeds (services/validator/src/outgoingPublisher.ts).
// Invariants:
//   - The `agent-runs-dispatch` queue is NON-session (VHQ TF
//     requiresSession:false). Each receive() pulls a batch via a single
//     long-lived plain receiver (createReceiver, peekLock) — NO
//     acceptNextSession, so none of the validator consumer's session-lock /
//     session-timeout machinery applies. An empty queue resolves to [] from
//     receiveMessages(maxWaitTimeInMs) rather than throwing, so the loop's
//     idle-drain exit fires naturally.
//   - The validator's outgoingPublisher.serializePublishedMessage emits the SB
//     body as { message: WireParsedTransitionMessage, verdict: {...} } where
//     `message` carries payloadHash as a hex string and receivedAt as an ISO
//     8601 string, and `message.verdict` is the FSM outcome. This consumer
//     deserializes that body back into a ParsedTransitionMessage (hex→Buffer,
//     ISO→Date), stitches lockToken = msg.lockToken, and returns it. The wire
//     `verdict` is read off message.verdict (the canonical per-message field
//     processMessage gates on); the sibling top-level `verdict` object is the
//     validator's reason envelope and is not needed downstream.
//   - The raw SB message is stored keyed by lockToken in an internal Map so
//     ack()/deadletter() settle the SAME message on the shared receiver. The
//     caller (runConsumerLoop) settles each message BEFORE the next receive().
//   - Messages whose body can't be deserialized to a ParsedTransitionMessage
//     are dead-lettered inside receive() (a malformed dispatch has no message
//     to hand the loop) and excluded from the returned batch.
//   - Auth union mirrors outgoingPublisher: connectionString OR
//     { fullyQualifiedNamespace, credential }; a receiverFactory test seam
//     bypasses the real SDK entirely.
//   - Transient SB errors on receiveMessages are normalized to an empty poll
//     ([]) so a transport blip does not crash the loop; non-transient errors
//     propagate (the loop's catch ends the execution for redelivery). The
//     non-session receiver has no acceptNextSession dangling-rejection risk, so
//     no process-wide guard is needed here (cf. validator PR #142).

import type { ParsedTransitionMessage, TransitionVerdict } from './types.js';

// Matches the validator's outgoingPublisher DEFAULT_DISPATCH_QUEUE_NAME and the
// orchestrator dispatcher's SERVICE_BUS_DISPATCH_QUEUE_ENV.
export const DEFAULT_DISPATCH_QUEUE_NAME = 'agent-runs-dispatch';
export const SERVICE_BUS_CONNECTION_STRING_ENV = 'SERVICE_BUS_CONNECTION_STRING';
export const SERVICE_BUS_NAMESPACE_ENV = 'SERVICE_BUS_NAMESPACE';
export const SERVICE_BUS_DISPATCH_QUEUE_ENV = 'SERVICE_BUS_DISPATCH_QUEUE';

const DEFAULT_RECEIVE_WAIT_MS = 5000;

// Minimal subset of @azure/service-bus's ServiceBusReceivedMessage we read.
export interface ReceivedMessageLike {
  body: unknown;
  lockToken?: string;
}

// Minimal subset of the (non-session) receiver surface we use, so unit tests
// can inject a fake without importing the SDK.
export interface ReceiverLike {
  receiveMessages(
    maxMessageCount: number,
    options?: { maxWaitTimeInMs?: number },
  ): Promise<ReceivedMessageLike[]>;
  completeMessage(message: ReceivedMessageLike): Promise<void>;
  deadLetterMessage(
    message: ReceivedMessageLike,
    options?: { deadLetterReason?: string; deadLetterErrorDescription?: string },
  ): Promise<void>;
  close(): Promise<void>;
}

// One receiver for the consumer lifetime (a plain non-session receiver can be
// reused across every poll, unlike the validator's per-session receiver).
export type ReceiverFactory = () => Promise<ReceiverLike>;

export interface ServiceBusDispatchQueueConsumerConfig {
  receiverFactory?: ReceiverFactory;
  auth?: { connectionString: string } | { fullyQualifiedNamespace: string; credential: unknown };
  queueName?: string;
  receiveWaitMs?: number;
}

export class ServiceBusDispatchQueueConsumer {
  private readonly queueName: string;
  private readonly receiveWaitMs: number;
  private readonly receiverFactory: ReceiverFactory;
  // lockToken → raw SB message, populated in receive(), consumed in
  // ack()/deadletter() to settle on the shared receiver.
  private readonly inflight = new Map<string, ReceivedMessageLike>();
  // One ServiceBusClient + one receiver for the consumer lifetime. Reused
  // across every receive() poll (NOT re-created per poll, which would leak SDK
  // connection handles). Closed by close().
  private sbClient: { close(): Promise<void> } | null = null;
  private receiver: ReceiverLike | null = null;

  constructor(config: ServiceBusDispatchQueueConsumerConfig) {
    this.queueName = config.queueName ?? DEFAULT_DISPATCH_QUEUE_NAME;
    this.receiveWaitMs = config.receiveWaitMs ?? DEFAULT_RECEIVE_WAIT_MS;

    if (config.receiverFactory !== undefined) {
      this.receiverFactory = config.receiverFactory;
    } else if (config.auth !== undefined) {
      const auth = config.auth;
      const queueName = this.queueName;
      this.receiverFactory = async (): Promise<ReceiverLike> => {
        const client = await this.getOrCreateClient(auth);
        // peekLock (the SDK default) so messages stay locked until we
        // completeMessage / deadLetterMessage them.
        return client.createReceiver(queueName);
      };
    } else {
      throw new Error(
        'ServiceBusDispatchQueueConsumer requires either receiverFactory or auth in config',
      );
    }
  }

  private async getOrCreateClient(
    auth: { connectionString: string } | { fullyQualifiedNamespace: string; credential: unknown },
  ): Promise<{ createReceiver: (q: string) => ReceiverLike }> {
    const { ServiceBusClient } = (await import('@azure/service-bus')) as {
      ServiceBusClient: new (
        ...args: unknown[]
      ) => { createReceiver: (q: string) => ReceiverLike; close(): Promise<void> };
    };
    if (this.sbClient === null) {
      this.sbClient =
        'connectionString' in auth
          ? new ServiceBusClient(auth.connectionString)
          : new ServiceBusClient(auth.fullyQualifiedNamespace, auth.credential);
    }
    return this.sbClient as unknown as { createReceiver: (q: string) => ReceiverLike };
  }

  private async getReceiver(): Promise<ReceiverLike> {
    if (this.receiver === null) {
      this.receiver = await this.receiverFactory();
    }
    return this.receiver;
  }

  async receive(opts: { maxMessages: number }): Promise<ParsedTransitionMessage[]> {
    const receiver = await this.getReceiver();
    let raw: ReceivedMessageLike[];
    try {
      raw = await receiver.receiveMessages(opts.maxMessages, {
        maxWaitTimeInMs: this.receiveWaitMs,
      });
    } catch (err) {
      // A non-session receiver returns [] on an empty queue, so a throw here is
      // a transport condition, not "empty poll". Normalize the transient ones
      // to an empty poll so a blip doesn't crash the loop; re-throw genuine
      // faults so the loop's catch ends the execution for redelivery.
      if (isTransientServiceBusError(err)) return [];
      throw err;
    }

    const parsed: ParsedTransitionMessage[] = [];
    for (const sbMessage of raw) {
      const lockToken = sbMessage.lockToken;
      if (lockToken === undefined) {
        // peekLock guarantees a lock token; defensively deadletter an
        // unsettleable message rather than silently dropping it.
        await receiver
          .deadLetterMessage(sbMessage, { deadLetterReason: 'missing_lock_token' })
          .catch(() => undefined);
        continue;
      }
      const message = deserializeDispatchMessage(sbMessage.body, lockToken);
      if (message === undefined) {
        await receiver
          .deadLetterMessage(sbMessage, { deadLetterReason: 'unparseable_dispatch_message' })
          .catch(() => undefined);
        continue;
      }
      this.inflight.set(lockToken, sbMessage);
      parsed.push(message);
    }
    return parsed;
  }

  async ack(lockToken: string): Promise<void> {
    const sbMessage = this.inflight.get(lockToken);
    if (sbMessage === undefined) {
      throw new Error(`ack: unknown lock token "${lockToken}"`);
    }
    const receiver = await this.getReceiver();
    try {
      await receiver.completeMessage(sbMessage);
    } finally {
      this.inflight.delete(lockToken);
    }
  }

  async deadletter(lockToken: string, reason: string): Promise<void> {
    const sbMessage = this.inflight.get(lockToken);
    if (sbMessage === undefined) {
      throw new Error(`deadletter: unknown lock token "${lockToken}"`);
    }
    const receiver = await this.getReceiver();
    try {
      await receiver.deadLetterMessage(sbMessage, { deadLetterReason: reason });
    } finally {
      this.inflight.delete(lockToken);
    }
  }

  // Closes the receiver + the long-lived ServiceBusClient. The consumer-loop
  // boot calls this on shutdown so the Container Apps Job can exit cleanly
  // after the idle-drain return (an open client keeps the process alive).
  async close(): Promise<void> {
    if (this.receiver !== null) {
      const receiver = this.receiver;
      this.receiver = null;
      await receiver.close().catch(() => undefined);
    }
    if (this.sbClient !== null) {
      const client = this.sbClient;
      this.sbClient = null;
      await client.close().catch(() => undefined);
    }
  }

  // Test-only inspection.
  inflightCount(): number {
    return this.inflight.size;
  }
}

// The validator's outgoingPublisher wire body:
//   { message: WireParsedTransitionMessage, verdict: { verdict, reason? } }
// (services/validator/src/outgoingPublisher.ts serializePublishedMessage). The
// SB SDK JSON-deserializes a body sent as application/json, so `body` may
// arrive as an object OR a JSON string — handle both.
function deserializeDispatchMessage(
  body: unknown,
  lockToken: string,
): ParsedTransitionMessage | undefined {
  let obj: unknown = body;
  if (typeof body === 'string') {
    try {
      obj = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (typeof obj !== 'object' || obj === null) return undefined;
  const wire = (obj as Record<string, unknown>).message;
  if (typeof wire !== 'object' || wire === null) return undefined;
  const m = wire as Record<string, unknown>;

  // Required string fields (the validator always emits these).
  if (
    typeof m.lockToken !== 'string' ||
    typeof m.deliveryId !== 'string' ||
    typeof m.eventType !== 'string' ||
    typeof m.kind !== 'string' ||
    typeof m.actor !== 'string' ||
    typeof m.recordType !== 'string' ||
    typeof m.recordId !== 'string' ||
    typeof m.fromState !== 'string' ||
    typeof m.toState !== 'string' ||
    typeof m.payloadHash !== 'string' ||
    typeof m.receivedAt !== 'string'
  ) {
    return undefined;
  }

  const receivedAt = new Date(m.receivedAt);
  if (Number.isNaN(receivedAt.getTime())) return undefined;

  const message: ParsedTransitionMessage = {
    // Stitch the lockToken from the SB envelope (the wire body also carries a
    // lockToken field, but the SB-assigned one is authoritative for settling).
    lockToken,
    deliveryId: m.deliveryId,
    eventType: m.eventType,
    kind: m.kind as ParsedTransitionMessage['kind'],
    actor: m.actor as ParsedTransitionMessage['actor'],
    recordType: m.recordType,
    recordId: m.recordId,
    fromState: m.fromState,
    toState: m.toState,
    payloadHash: Buffer.from(m.payloadHash, 'hex'),
    receivedAt,
  };
  if (typeof m.recordKind === 'string') message.recordKind = m.recordKind;
  if (typeof m.verdict === 'string') {
    message.verdict = m.verdict as TransitionVerdict;
  }
  if (typeof m.headBranch === 'string') message.headBranch = m.headBranch;
  if (typeof m.baseBranch === 'string') message.baseBranch = m.baseBranch;
  // M2: target repo slug + installation id, forwarded to agents downstream.
  if (typeof m.repoFullName === 'string') message.repoFullName = m.repoFullName;
  if (typeof m.installationId === 'number') message.installationId = m.installationId;
  return message;
}

// The @azure/service-bus SDK's normalized `ServiceBusError.code` values that
// are transient (verified against node_modules/@azure/service-bus — cf.
// validator PR #142). These are post-normalization spellings (e.g.
// `ServiceBusy`, NOT the rhea-level `ServerBusy`).
const TRANSIENT_SB_CODES: ReadonlySet<string> = new Set([
  'ServiceTimeout',
  'ServiceBusy',
  'ServiceCommunicationProblem',
  'MessageLockLost',
]);

// A transient/retryable Service Bus condition on receiveMessages. The error is
// already known to originate from the @azure/service-bus call, so the generic
// retryable / AbortError / TimeoutError shapes are safe to treat as an empty
// poll in this local context.
export function isTransientServiceBusError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; retryable?: unknown; name?: unknown };
  if (e.retryable === true) return true;
  if (typeof e.code === 'string' && TRANSIENT_SB_CODES.has(e.code)) return true;
  return e.code === 'OperationTimeoutError' || e.name === 'AbortError' || e.name === 'TimeoutError';
}

export type DispatchConsumerBootConfig =
  | { kind: 'in-memory' }
  | { kind: 'connection-string'; connectionString: string; queueName: string }
  | { kind: 'managed-identity'; fullyQualifiedNamespace: string; queueName: string };

// Env-driven boot resolution. Mirrors resolveOutgoingPublisherBootConfig
// (validator) + resolveServiceBusAgentDispatcherBootConfig (orchestrator):
// connection string preferred, else managed-identity namespace, else
// in-memory. Reads SERVICE_BUS_DISPATCH_QUEUE for the queue name.
export function resolveDispatchConsumerBootConfig(
  env: NodeJS.ProcessEnv = process.env,
): DispatchConsumerBootConfig {
  const queueName = env[SERVICE_BUS_DISPATCH_QUEUE_ENV] ?? DEFAULT_DISPATCH_QUEUE_NAME;
  const connStr = env[SERVICE_BUS_CONNECTION_STRING_ENV];
  if (connStr !== undefined && connStr !== '') {
    return { kind: 'connection-string', connectionString: connStr, queueName };
  }
  const namespace = env[SERVICE_BUS_NAMESPACE_ENV];
  if (namespace !== undefined && namespace !== '') {
    return { kind: 'managed-identity', fullyQualifiedNamespace: namespace, queueName };
  }
  return { kind: 'in-memory' };
}
