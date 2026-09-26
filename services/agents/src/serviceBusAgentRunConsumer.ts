// Spec: docs/decisions/0011-agent-dispatch-topology.md (Option B). The
// orchestrator's ServiceBusAgentDispatcher publishes one message per dispatch
// to `agent-runs-<role>`; this consumer is the per-role agent Container Apps
// Job side that pulls from it.
// Invariants:
//   - The `agent-runs-<role>` queues are NON-SESSION (requiresSession: false,
//     verified live). Use a plain receiver (client.createReceiver(queueName))
//     in peekLock mode and receiveMessages() — NOT acceptNextSession. There is
//     no session lock to leak, so the receiver is long-lived for the consumer's
//     lifetime (created lazily on first receive(), closed by close()).
//   - Wire format MUST match the orchestrator's serializeMessage output:
//     JSON body `{ agent, transition_key, message: {...} }`. We deserialize via
//     consumerLoop's parseEnvelopeFromWire (which wraps the agents'
//     parseAgentRunPayload), so the SAME tested parser settles wire shape on
//     both ends. The SB SDK delivers an application/json body as either an
//     object OR a JSON string; we normalize to a string before parsing.
//   - The raw SB message is stored keyed by lockToken so ack()/deadletter()
//     settle the EXACT message the SDK handed us (completeMessage /
//     deadLetterMessage require the original message object, not a copy).
//   - Empty queue → receiveMessages returns [] within maxWaitTimeInMs; receive()
//     returns [] (the loop's idle-drain counter advances). No crash.
//   - Wire-parse failure → deadletter immediately (a malformed message never
//     parses; redelivery loops are pointless) and exclude from the batch.
//   - Auth union mirrors the orchestrator's dispatcher: connectionString OR
//     { fullyQualifiedNamespace, credential }; a receiverFactory test seam
//     bypasses the SDK entirely.
//   - Message-lock survival (codex PR #144 P1): agent handlers run real
//     Claude/GitHub work that can exceed the queue's lock duration. The SDK's
//     receiver auto-renews each received message's lock up to
//     maxAutoLockRenewalDurationInMs (default 5 min); we raise it to
//     DEFAULT_MAX_AUTO_LOCK_RENEWAL_MS so a long handler doesn't lose its lock
//     and cause a MessageLockLost on completeMessage → duplicate dispatch run.
//   - Transient receive resilience (codex PR #144 P2, mirrors validator PR
//     #142): a transient receiveMessages rejection (ServiceBusy / ServiceTimeout
//     / network blip) must NOT crash the loop — runAgentConsumerLoop has no
//     catch around receive(). We classify transient SB errors here and return
//     [] (empty poll) so the loop retries on the next tick. Non-transient errors
//     still propagate (a structural fault should surface, not silently spin).
//   - NEVER log message bodies — they may carry installation context.

import { parseEnvelopeFromWire } from './consumerLoop.js';
import type { AgentRunMessage, AgentRunQueueConsumer } from './queueConsumer.js';

export const SERVICE_BUS_CONNECTION_STRING_ENV = 'SERVICE_BUS_CONNECTION_STRING';
export const SERVICE_BUS_NAMESPACE_ENV = 'SERVICE_BUS_NAMESPACE';
export const AGENT_QUEUE_NAME_ENV = 'AGENT_QUEUE_NAME';

const DEFAULT_RECEIVE_WAIT_MS = 5000;
// Agent handlers can run for many minutes (real coding/content agents). Renew
// each received message's lock for up to 30 minutes so completeMessage doesn't
// hit MessageLockLost mid-run. The SDK renews until the message is settled.
const DEFAULT_MAX_AUTO_LOCK_RENEWAL_MS = 30 * 60 * 1000;

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
  // Releases the lock and makes the message immediately available for
  // redelivery (increments delivery count). Used on close() to hand back any
  // batch messages the loop pulled but never settled (end_execution path).
  abandonMessage(message: ReceivedMessageLike): Promise<void>;
  deadLetterMessage(
    message: ReceivedMessageLike,
    options?: { deadLetterReason?: string; deadLetterErrorDescription?: string },
  ): Promise<void>;
  close(): Promise<void>;
}

// Test seam: constructs the (single, long-lived) receiver. Production wiring
// builds it from a ServiceBusClient.createReceiver(queueName). Async so the
// real factory can dynamic-import @azure/service-bus (keeping dev/test boot,
// which uses the in-memory consumer, free of the SDK).
export type ReceiverFactory = () => ReceiverLike | Promise<ReceiverLike>;

export type ServiceBusAuth =
  | { connectionString: string }
  | { fullyQualifiedNamespace: string; credential: unknown };

export interface ServiceBusAgentRunConsumerConfig {
  receiverFactory?: ReceiverFactory;
  auth?: ServiceBusAuth;
  queueName?: string;
  receiveWaitMs?: number;
  // Lock auto-renewal window for the real SDK receiver (P1). Defaults to
  // DEFAULT_MAX_AUTO_LOCK_RENEWAL_MS. Ignored by injected test receivers.
  maxAutoLockRenewalDurationInMs?: number;
}

export class ServiceBusAgentRunQueueConsumer implements AgentRunQueueConsumer {
  private readonly queueName: string;
  private readonly receiveWaitMs: number;
  private readonly maxAutoLockRenewalDurationInMs: number;
  private readonly receiverFactory: ReceiverFactory;
  // lockToken → raw SB message. Populated in receive(), consumed in
  // ack()/deadletter() so the SDK settles the exact message it delivered.
  private readonly inflight = new Map<string, ReceivedMessageLike>();
  // One receiver for the consumer lifetime (non-session: no lock to leak).
  // Created lazily on first receive(), closed by close().
  private receiver: ReceiverLike | null = null;
  // One ServiceBusClient for the consumer lifetime; closed by close().
  private sbClient: { close(): Promise<void> } | null = null;

  constructor(config: ServiceBusAgentRunConsumerConfig) {
    // queueName defaults to AGENT_QUEUE_NAME (per-role injection, e.g.
    // agent-runs-spec). Required: a Service Bus consumer with no queue to pull
    // from is a boot bug, so surface it loudly rather than receiving from "".
    const envQueue = process.env[AGENT_QUEUE_NAME_ENV];
    const resolvedQueue =
      config.queueName ?? (envQueue !== undefined && envQueue !== '' ? envQueue : undefined);
    if (resolvedQueue === undefined) {
      throw new Error(
        `ServiceBusAgentRunQueueConsumer requires a queueName (pass config.queueName or set ${AGENT_QUEUE_NAME_ENV})`,
      );
    }
    this.queueName = resolvedQueue;
    this.receiveWaitMs = config.receiveWaitMs ?? DEFAULT_RECEIVE_WAIT_MS;
    this.maxAutoLockRenewalDurationInMs =
      config.maxAutoLockRenewalDurationInMs ?? DEFAULT_MAX_AUTO_LOCK_RENEWAL_MS;

    if (config.receiverFactory !== undefined) {
      this.receiverFactory = config.receiverFactory;
    } else if (config.auth !== undefined) {
      const auth = config.auth;
      const queueName = this.queueName;
      this.receiverFactory = (): Promise<ReceiverLike> => this.createSdkReceiver(auth, queueName);
    } else {
      throw new Error(
        'ServiceBusAgentRunQueueConsumer requires either receiverFactory or auth in config',
      );
    }
  }

  private async getReceiver(): Promise<ReceiverLike> {
    if (this.receiver === null) {
      this.receiver = await this.receiverFactory();
    }
    return this.receiver;
  }

  // Dynamic-import @azure/service-bus so dev/test boot (which uses the
  // in-memory consumer) never loads the SDK. Constructs ONE long-lived
  // ServiceBusClient + ONE non-session receiver for the consumer's lifetime.
  private async createSdkReceiver(auth: ServiceBusAuth, queueName: string): Promise<ReceiverLike> {
    type ReceiverOpts = { receiveMode?: string; maxAutoLockRenewalDurationInMs?: number };
    const { ServiceBusClient } = (await import('@azure/service-bus')) as {
      ServiceBusClient: new (
        ...args: unknown[]
      ) => {
        createReceiver: (q: string, opts?: ReceiverOpts) => ReceiverLike;
        close(): Promise<void>;
      };
    };
    if (this.sbClient === null) {
      this.sbClient =
        'connectionString' in auth
          ? new ServiceBusClient(auth.connectionString)
          : new ServiceBusClient(auth.fullyQualifiedNamespace, auth.credential);
    }
    const client = this.sbClient as unknown as {
      createReceiver: (q: string, opts?: ReceiverOpts) => ReceiverLike;
    };
    // peekLock (default) — the message stays locked until we completeMessage /
    // deadLetterMessage, so a crashed execution redelivers after lock timeout.
    // maxAutoLockRenewalDurationInMs (P1): the SDK auto-renews each received
    // message's lock for up to this window so a long agent handler doesn't lose
    // its lock and trigger MessageLockLost → duplicate dispatch.
    return client.createReceiver(queueName, {
      receiveMode: 'peekLock',
      maxAutoLockRenewalDurationInMs: this.maxAutoLockRenewalDurationInMs,
    });
  }

  async receive(opts: { maxMessages: number }): Promise<AgentRunMessage[]> {
    const receiver = await this.getReceiver();
    let raw: ReceivedMessageLike[];
    try {
      raw = await receiver.receiveMessages(opts.maxMessages, {
        maxWaitTimeInMs: this.receiveWaitMs,
      });
    } catch (err) {
      // P2: a transient SB condition (ServiceBusy / ServiceTimeout / network
      // blip) must NOT reject up into runAgentConsumerLoop (which has no catch
      // around receive()) and crash the job. Treat it as an empty poll so the
      // loop retries on the next tick (mirrors validator PR #142). A
      // non-transient error still propagates — a structural fault should
      // surface, not silently spin.
      if (isTransientServiceBusError(err)) {
        console.warn(
          `[agents] transient Service Bus receive error on ${this.queueName}; treating as empty poll: ${errorMessage(err)}`,
        );
        return [];
      }
      throw err;
    }
    // Defensive: an SDK that returns a non-array (should never happen) must not
    // crash the loop.
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const batch: AgentRunMessage[] = [];
    for (const sbMessage of raw) {
      const lockToken = sbMessage.lockToken;
      if (lockToken === undefined || lockToken === '') {
        // peekLock guarantees a lock token; defensively deadletter an
        // unsettleable message rather than silently dropping it.
        await receiver
          .deadLetterMessage(sbMessage, { deadLetterReason: 'missing_lock_token' })
          .catch(() => undefined);
        continue;
      }
      const wire = normalizeBody(sbMessage.body);
      if (wire === undefined) {
        await receiver
          .deadLetterMessage(sbMessage, { deadLetterReason: 'body_not_serializable' })
          .catch(() => undefined);
        continue;
      }
      const parsed = parseEnvelopeFromWire(wire, lockToken);
      if (!parsed.ok) {
        // Malformed/unsupported envelope — never parses, so deadletter now
        // rather than redeliver-loop. Reason is a structural code (no body).
        await receiver
          .deadLetterMessage(sbMessage, { deadLetterReason: parsed.reason })
          .catch(() => undefined);
        continue;
      }
      this.inflight.set(lockToken, sbMessage);
      batch.push(parsed.value);
    }
    return batch;
  }

  async ack(lockToken: string): Promise<void> {
    const message = this.inflight.get(lockToken);
    if (message === undefined) {
      throw new Error(`ack: unknown lock token "${lockToken}"`);
    }
    // A message is only inflight after receive() created the receiver, so it
    // is non-null here; settle on that exact receiver.
    const receiver = this.requireReceiver();
    try {
      await receiver.completeMessage(message);
    } finally {
      this.inflight.delete(lockToken);
    }
  }

  async deadletter(lockToken: string, reason: string): Promise<void> {
    const message = this.inflight.get(lockToken);
    if (message === undefined) {
      throw new Error(`deadletter: unknown lock token "${lockToken}"`);
    }
    const receiver = this.requireReceiver();
    try {
      await receiver.deadLetterMessage(message, { deadLetterReason: reason });
    } finally {
      this.inflight.delete(lockToken);
    }
  }

  private requireReceiver(): ReceiverLike {
    if (this.receiver === null) {
      throw new Error('settle called before receive() created a receiver');
    }
    return this.receiver;
  }

  // Closes the receiver + the long-lived ServiceBusClient so the Container
  // Apps Job can exit cleanly after the loop's idle-drain return (an open
  // client/receiver keeps the process alive).
  //
  // codex PR #144 P2: runAgentConsumerLoop returns on the first handler throw
  // (end_execution / session-order discipline) WITHOUT settling the rest of the
  // batch. close() is the end_execution hook (startAgentConsumer wires it as the
  // loop's .finally), so abandon any still-inflight messages here — releasing
  // their locks for IMMEDIATE redelivery instead of leaving them invisible until
  // the (auto-renewed, up to 30 min) lock expires. Abandon BEFORE closing the
  // receiver: the receiver must still be open to settle.
  async close(): Promise<void> {
    if (this.receiver !== null) {
      const receiver = this.receiver;
      const unsettled = [...this.inflight.values()];
      this.inflight.clear();
      for (const message of unsettled) {
        await receiver.abandonMessage(message).catch(() => undefined);
      }
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

// The @azure/service-bus SDK's normalized ServiceBusError.code values that are
// transient/retryable on a receive (verified against the validator's
// serviceBusEventQueueConsumer post-PR #142). These are the post-normalization
// spellings (e.g. `ServiceBusy`, not the rhea-level `ServerBusy`).
const TRANSIENT_SB_CODES: ReadonlySet<string> = new Set([
  'ServiceTimeout',
  'ServiceBusy',
  'ServiceCommunicationProblem',
  'MessageLockLost',
  'OperationTimeoutError',
]);

// True for a transient/retryable Service Bus receive condition: the SDK sets
// `retryable` on transient ServiceBusErrors, or one of the known transient
// codes, or an abort/timeout shape from the receive wait window. A transient
// receive must be treated as an empty poll, not a crash.
export function isTransientServiceBusError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; retryable?: unknown; name?: unknown };
  if (e.retryable === true) return true;
  if (typeof e.code === 'string' && TRANSIENT_SB_CODES.has(e.code)) return true;
  // Socket-layer transients the SDK sometimes surfaces unwrapped under `code`.
  if (
    typeof e.code === 'string' &&
    /^E(?:CONNREFUSED|CONNRESET|TIMEDOUT|HOSTUNREACH|PIPE)$/.test(e.code)
  ) {
    return true;
  }
  return e.name === 'AbortError' || e.name === 'TimeoutError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The SB SDK deserializes an application/json body to an object, but a body
// sent as a raw string arrives as a string. parseEnvelopeFromWire expects a
// JSON string, so stringify objects and pass strings through. Returns
// undefined when the body can't be serialized to a string (deadletter).
function normalizeBody(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'object') {
    try {
      return JSON.stringify(body);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export type AgentRunConsumerBootConfig =
  | { kind: 'in-memory' }
  | { kind: 'connection-string'; connectionString: string; queueName: string | undefined }
  | { kind: 'managed-identity'; fullyQualifiedNamespace: string; queueName: string | undefined };

// Env-driven boot resolution. Mirrors the orchestrator dispatcher + validator
// consumer: connection string preferred, else managed-identity namespace, else
// in-memory (preserves dev/test/CI boot with no Service Bus). queueName is read
// from AGENT_QUEUE_NAME (per-role injection, e.g. agent-runs-spec) only on the
// Service Bus branches; the in-memory branch never needs it. When a Service Bus
// branch is selected but AGENT_QUEUE_NAME is unset, queueName is undefined and
// the caller must supply the per-role default to the consumer constructor.
export function resolveAgentRunConsumerBootConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentRunConsumerBootConfig {
  const connStr = env[SERVICE_BUS_CONNECTION_STRING_ENV];
  const queueName = env[AGENT_QUEUE_NAME_ENV];
  const queue = queueName !== undefined && queueName !== '' ? queueName : undefined;
  if (connStr !== undefined && connStr !== '') {
    return { kind: 'connection-string', connectionString: connStr, queueName: queue };
  }
  const namespace = env[SERVICE_BUS_NAMESPACE_ENV];
  if (namespace !== undefined && namespace !== '') {
    return { kind: 'managed-identity', fullyQualifiedNamespace: namespace, queueName: queue };
  }
  return { kind: 'in-memory' };
}
