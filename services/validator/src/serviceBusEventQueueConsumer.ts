// Spec: docs/design/validator-bot.md "Service Bus session-keyed consumer" +
// the session-enabled `validator-events` queue.
// Invariants:
//   - The queue is SESSION-ENABLED (VHQ TF). Each receive() opens ONE
//     session via acceptNextSession(), drains up to maxMessages, and the
//     session receiver is close()'d in a finally so the session lock is
//     released before the next receive(). Leaving a session receiver open
//     across receive() calls leaks session locks (plan risk B2).
//   - The github-app B1 producer serializes the SB body as
//     { deliveryId, event, payload } where `payload` is the raw webhook
//     body JSON string. The consumer rebuilds a RawWebhookDelivery, runs
//     payloadParser → transitionResolver, stitches lockToken = msg.lockToken,
//     and returns ParsedTransitionMessage[].
//   - The raw SB message is stored keyed by lockToken in an internal Map so
//     ack()/deadletter() can settle it on the SAME session receiver. The
//     caller (runConsumerLoop) settles each message BEFORE the next
//     receive() — matching mainConsumer's "return on error to release the
//     session" discipline.
//   - Messages that fail to parse/resolve are dead-lettered inside receive()
//     (a malformed/unsupported delivery has no ParsedTransitionMessage to
//     hand the loop) and excluded from the returned batch.
//   - Auth union mirrors outgoingPublisher: connectionString OR
//     { fullyQualifiedNamespace, credential }; a receiverFactory test seam
//     bypasses the real SDK entirely.

import { InMemoryAuditLedgerWriter } from './auditLedger.js';
import type { AuditLedgerReader, AuditLedgerRow } from './auditLedger.js';
import {
  type ParsedWebhookEnvelope,
  type RawWebhookDelivery,
  parsePayload,
} from './payloadParser.js';
import type { ParsedTransitionMessage } from './queueConsumer.js';
import { InMemorySubstrateClient, type SubstrateClient } from './substrateClient.js';
import { resolveTransition } from './transitionResolver.js';

export const DEFAULT_CONSUME_QUEUE_NAME = 'validator-events';
export const SERVICE_BUS_CONNECTION_STRING_ENV = 'SERVICE_BUS_CONNECTION_STRING';
export const SERVICE_BUS_NAMESPACE_ENV = 'SERVICE_BUS_NAMESPACE';
export const SERVICE_BUS_CONSUME_QUEUE_ENV = 'SERVICE_BUS_CONSUME_QUEUE';

const DEFAULT_SESSION_WAIT_MS = 5000;

// Issue #178 P2: sentinel returned by toTransitionMessage for a benign,
// non-transition event (e.g. a PR status-label removal — the cleanup half of
// ReviewAgent's status:in_review→status:approved label swap). The receive loop
// completeMessage()s it cleanly instead of dead-lettering: it is "nothing to
// record", not a substrate-invariant violation.
const OBSERVATIONAL_SETTLE = Symbol('observational_settle');

// Typed dead-letter detail (M5 finding): the generic
// 'unparseable_or_unresolvable' reason erased WHICH parse/resolve failure
// occurred, costing live debugging time. toTransitionMessage now returns the
// typed reason; the receive loop threads it into deadLetterErrorDescription.
interface ResolutionFailure {
  failureDetail: string;
}
function isResolutionFailure(value: unknown): value is ResolutionFailure {
  return typeof value === 'object' && value !== null && 'failureDetail' in value;
}

// Minimal subset of @azure/service-bus's ServiceBusReceivedMessage we read.
export interface ReceivedMessageLike {
  body: unknown;
  lockToken?: string;
}

// Minimal subset of the session receiver surface we use, so unit tests can
// inject a fake without importing the SDK.
export interface SessionReceiverLike {
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

// Returns null when no session is available within the wait window (empty
// poll) — mirrors acceptNextSession throwing a timeout, normalized here so
// receive() can return [] cleanly.
export type ReceiverFactory = () => Promise<SessionReceiverLike | null>;

export interface ServiceBusEventQueueConsumerConfig {
  receiverFactory?: ReceiverFactory;
  auth?: { connectionString: string } | { fullyQualifiedNamespace: string; credential: unknown };
  queueName?: string;
  sessionWaitMs?: number;
  // Resolver deps. Default to in-memory impls so the consumer is
  // constructible in tests; production wiring injects the real substrate +
  // the same Postgres ledger used for appends (so fromState lookups read
  // committed rows).
  substrate?: SubstrateClient;
  ledgerReader?: AuditLedgerReader;
  // factory. The installation id varies per delivery, so the real read-only
  // GithubSubstrateClient is constructed per message from the envelope's
  // installationId. When set AND the parsed envelope carries an installationId,
  // the resolver uses substrateFactory(installationId); otherwise it falls
  // back to `substrate` (in-memory for tests/boot, preserving the dead-letter
  // posture for installation-less deliveries). mainConsumer injects this when
  // GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are set.
  substrateFactory?: (installationId: number) => SubstrateClient;
  // ADR 0009 §D: the recognized SF App `<slug>[bot]` logins. Defaults to the
  // documented slugs; mainConsumer injects appBotLoginsFromEnv(process.env)
  // so a deployment whose App slug differs (an explicitly configured App is `example-factory`)
  // is recognized via GITHUB_APP_SLUG. Threaded into parsePayload.
  appBotLogins?: ReadonlySet<string>;
}

export class ServiceBusEventQueueConsumer {
  private readonly queueName: string;
  private readonly sessionWaitMs: number;
  private readonly receiverFactory: ReceiverFactory;
  private readonly substrate: SubstrateClient;
  private readonly substrateFactory: ((installationId: number) => SubstrateClient) | undefined;
  private readonly ledgerReader: AuditLedgerReader;
  private readonly appBotLogins: ReadonlySet<string> | undefined;
  // lockToken → { receiver that holds the lock, raw SB message }. Populated
  // in receive(), consumed in ack()/deadletter().
  private readonly inflight = new Map<
    string,
    { receiver: SessionReceiverLike; message: ReceivedMessageLike }
  >();
  // One ServiceBusClient for the consumer lifetime — reused across every
  // receive() poll (NOT re-created per poll, which would leak SDK
  // connection handles on empty polls). Closed by close().
  private sbClient: { close(): Promise<void> } | null = null;

  constructor(config: ServiceBusEventQueueConsumerConfig) {
    this.queueName = config.queueName ?? DEFAULT_CONSUME_QUEUE_NAME;
    this.sessionWaitMs = config.sessionWaitMs ?? DEFAULT_SESSION_WAIT_MS;
    this.substrate = config.substrate ?? new InMemorySubstrateClient();
    this.substrateFactory = config.substrateFactory;
    this.ledgerReader = config.ledgerReader ?? new InMemoryAuditLedgerWriter();
    this.appBotLogins = config.appBotLogins;

    if (config.receiverFactory !== undefined) {
      this.receiverFactory = config.receiverFactory;
    } else if (config.auth !== undefined) {
      const auth = config.auth;
      const queueName = this.queueName;
      const sessionWaitMs = this.sessionWaitMs;
      this.receiverFactory = async (): Promise<SessionReceiverLike | null> => {
        const client = await this.getOrCreateClient(auth);
        try {
          // acceptNextSession blocks until a session is free; bound the
          // wait with an abort timeout so an empty queue returns null
          // (empty poll) instead of hanging the loop.
          return await client.acceptNextSession(queueName, {
            abortSignal: AbortSignal.timeout(sessionWaitMs),
          });
        } catch (err) {
          // No session available within the window → empty poll.
          if (isSessionUnavailable(err)) return null;
          throw err;
        }
      };
    } else {
      throw new Error(
        'ServiceBusEventQueueConsumer requires either receiverFactory or auth in config',
      );
    }
  }

  private async getOrCreateClient(
    auth: { connectionString: string } | { fullyQualifiedNamespace: string; credential: unknown },
  ): Promise<{
    acceptNextSession: (
      q: string,
      opts?: { abortSignal?: AbortSignal },
    ) => Promise<SessionReceiverLike>;
  }> {
    const { ServiceBusClient } = (await import('@azure/service-bus')) as {
      ServiceBusClient: new (
        ...args: unknown[]
      ) => {
        acceptNextSession: (
          q: string,
          opts?: { abortSignal?: AbortSignal },
        ) => Promise<SessionReceiverLike>;
        close(): Promise<void>;
      };
    };
    if (this.sbClient === null) {
      this.sbClient =
        'connectionString' in auth
          ? new ServiceBusClient(auth.connectionString)
          : new ServiceBusClient(auth.fullyQualifiedNamespace, auth.credential);
    }
    return this.sbClient as unknown as {
      acceptNextSession: (
        q: string,
        opts?: { abortSignal?: AbortSignal },
      ) => Promise<SessionReceiverLike>;
    };
  }

  // Closes the long-lived ServiceBusClient. The consumer-loop boot should
  // call this on shutdown so the Container Apps Job can exit cleanly after
  // the idle-drain return (an open client keeps the process alive).
  async close(): Promise<void> {
    if (this.sbClient !== null) {
      const client = this.sbClient;
      this.sbClient = null;
      await client.close().catch(() => undefined);
    }
  }

  async receive(opts: { maxMessages: number }): Promise<ParsedTransitionMessage[]> {
    const receiver = await this.receiverFactory();
    if (receiver === null) return [];

    let keepOpen = false;
    try {
      const raw = await receiver.receiveMessages(opts.maxMessages, {
        maxWaitTimeInMs: this.sessionWaitMs,
      });
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
        let message:
          | ParsedTransitionMessage
          | typeof OBSERVATIONAL_SETTLE
          | ResolutionFailure
          | undefined;
        try {
          message = await this.toTransitionMessage(sbMessage, lockToken);
        } catch (err) {
          // M2: the real GithubSubstrateClient throws on transient GitHub
          // failures (token mint / GraphQL 5xx / network). Containing the
          // throw HERE is critical: it happens inside receive(), BEFORE
          // runConsumerLoop's per-message try, so an uncaught throw would
          // reject the whole receive() and crash the consumer loop on an
          // ordinary upstream blip. A transient failure must NOT deadletter
          // (one-way to DLQ, no redelivery) — leave the message UNSETTLED so
          // the SB lock times out and SB redelivers it. Stop draining the
          // rest of this batch + keep the receiver open so the session lock
          // is held through the in-flight messages already settled-pending,
          // matching the loop's "preserve session order on failure"
          // discipline (the unsettled message redelivers first next session).
          console.warn(
            `[validator] substrate resolution failed for delivery; leaving unsettled for redelivery: ${asMessage(err)}`,
          );
          keepOpen = parsed.length > 0;
          return parsed;
        }
        if (message === OBSERVATIONAL_SETTLE) {
          // Issue #178 P2: benign non-transition event (PR status-label
          // removal) — settle cleanly, never dead-letter.
          await receiver.completeMessage(sbMessage);
          continue;
        }
        if (message === undefined || isResolutionFailure(message)) {
          await receiver.deadLetterMessage(sbMessage, {
            deadLetterReason: 'unparseable_or_unresolvable',
            ...(isResolutionFailure(message)
              ? { deadLetterErrorDescription: message.failureDetail.slice(0, 4096) }
              : {}),
          });
          continue;
        }
        this.inflight.set(lockToken, { receiver, message: sbMessage });
        parsed.push(message);
      }
      // Keep the receiver open ONLY when there are inflight messages the
      // caller still has to ack/deadletter on it. When the batch produced
      // no inflight work, close now.
      keepOpen = parsed.length > 0;
      return parsed;
    } finally {
      // CRITICAL (plan risk B2): release the session lock unless the caller
      // still has inflight messages to settle on this receiver. ack()/
      // deadletter() close the receiver once its last message is settled.
      if (!keepOpen) {
        await receiver.close().catch(() => undefined);
      }
    }
  }

  async ack(lockToken: string): Promise<void> {
    const entry = this.inflight.get(lockToken);
    if (entry === undefined) {
      throw new Error(`ack: unknown lock token "${lockToken}"`);
    }
    try {
      await entry.receiver.completeMessage(entry.message);
    } finally {
      this.settle(lockToken, entry.receiver);
    }
  }

  async deadletter(lockToken: string, reason: string): Promise<void> {
    const entry = this.inflight.get(lockToken);
    if (entry === undefined) {
      throw new Error(`deadletter: unknown lock token "${lockToken}"`);
    }
    try {
      await entry.receiver.deadLetterMessage(entry.message, { deadLetterReason: reason });
    } finally {
      this.settle(lockToken, entry.receiver);
    }
  }

  // Drop the settled message; close the receiver once it holds no more
  // inflight messages so the session lock is released.
  private settle(lockToken: string, receiver: SessionReceiverLike): void {
    this.inflight.delete(lockToken);
    let stillHolds = false;
    for (const entry of this.inflight.values()) {
      if (entry.receiver === receiver) {
        stillHolds = true;
        break;
      }
    }
    if (!stillHolds) {
      void receiver.close().catch(() => undefined);
    }
  }

  // Rebuild a RawWebhookDelivery from the SB body, parse + resolve, stitch
  // the lockToken. Returns:
  //   - a ParsedTransitionMessage on a resolvable transition (caller processes),
  //   - OBSERVATIONAL_SETTLE for a benign non-transition event (issue #178 P2:
  //     a PR status-label removal) — the caller completeMessage()s it cleanly,
  //   - undefined when the delivery is unparseable / unresolvable (caller
  //     dead-letters).
  private async toTransitionMessage(
    sbMessage: ReceivedMessageLike,
    lockToken: string,
  ): Promise<
    ParsedTransitionMessage | typeof OBSERVATIONAL_SETTLE | ResolutionFailure | undefined
  > {
    const envelopeBody = parseBody(sbMessage.body);
    if (envelopeBody === undefined) return { failureDetail: 'malformed_sb_body' };

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(envelopeBody.payload);
    } catch {
      return { failureDetail: 'payload_not_json' };
    }

    const raw: RawWebhookDelivery = {
      deliveryId: envelopeBody.deliveryId,
      eventType: envelopeBody.event,
      rawBody: Buffer.from(envelopeBody.payload, 'utf8'),
      parsedBody,
      receivedAt: new Date(),
    };

    const parseResult = parsePayload(
      raw,
      this.appBotLogins !== undefined ? { appBotLogins: this.appBotLogins } : undefined,
    );
    if (!parseResult.ok) {
      // Issue #178 rev5: observational parse outcomes (issue_comment — the
      // structural-marker carrier) settle cleanly; real parse failures
      // dead-letter as before, carrying the typed reason.
      return parseResult.observational === true
        ? OBSERVATIONAL_SETTLE
        : { failureDetail: `parse:${parseResult.reason}:${parseResult.detail ?? ''}` };
    }
    const envelope = parseResult.envelope;

    // At-least-once redelivery guard: if this delivery_id already committed a
    // ledger row, replay the ALREADY-RECORDED transition verbatim instead of
    // re-resolving. Re-running resolveTransition now would read a ledger that
    // contains this very row, potentially deriving a different fromState (a
    // no-op / unresolvable) and wrongly dead-lettering an already-accepted
    // delivery. processMessage will hit DuplicateLedgerEntryError on the
    // append and idempotent-ack, republishing the recorded verdict.
    const recorded = await this.ledgerReader.getByDeliveryId(envelope.deliveryId);
    if (recorded !== undefined) {
      return this.replayRecorded(envelope, recorded, lockToken);
    }

    // M2: select the per-message substrate. When the envelope carries an
    // installationId AND a factory is wired (GITHUB_APP env present), build a
    // real GithubSubstrateClient that mints a token for that installation;
    // otherwise fall back to the boot substrate (in-memory). Construction is
    // cheap (no I/O until getCurrentLabels is called); the token is minted
    // lazily inside the client.
    const substrate =
      envelope.installationId !== undefined && this.substrateFactory !== undefined
        ? this.substrateFactory(envelope.installationId)
        : this.substrate;

    const resolveResult = await resolveTransition(envelope, {
      substrate,
      ledger: this.ledgerReader,
      // Authenticate markers against the SAME App-bot login set used to parse
      // the sender, so a config-supplied slug isn't rejected by the resolver
      // (codex PR #152). undefined → resolver falls back to env.
      ...(this.appBotLogins !== undefined ? { appBotLogins: this.appBotLogins } : {}),
    });
    if (!resolveResult.ok) {
      // Issue #178 P2: observational events (PR status-label removal) settle
      // cleanly — signal the receive loop to completeMessage rather than
      // dead-letter. All other failures dead-letter as before.
      return resolveResult.observational === true
        ? OBSERVATIONAL_SETTLE
        : { failureDetail: `resolve:${resolveResult.reason}:${resolveResult.detail ?? ''}` };
    }

    return { ...resolveResult.transition, lockToken };
  }

  // Rebuilds the ParsedTransitionMessage from a committed ledger row so a
  // redelivery replays the original outcome. fromState/toState/recordId/
  // verdict come from the authoritative row; kind / branch fields come from
  // the re-parsed envelope (parser is pure over the raw body, unaffected by
  // ledger state).
  private replayRecorded(
    envelope: ParsedWebhookEnvelope,
    recorded: AuditLedgerRow,
    lockToken: string,
  ): ParsedTransitionMessage {
    return {
      lockToken,
      deliveryId: recorded.deliveryId,
      eventType: recorded.eventType,
      kind: envelope.kind,
      // Use the AUTHORITATIVE actor from the committed ledger row, not the
      // re-parsed envelope: for App-sent deliveries envelope.actor is the
      // non-authorizing placeholder (resolveTransition replaces it on the first
      // pass, but this replay path short-circuits before that). Using the
      // placeholder would re-evaluate an agent-only transition as `human` and
      // republish a spurious actor_not_authorized flag. (codex PR #152)
      actor: recorded.actor as ParsedTransitionMessage['actor'],
      recordType: recorded.recordType,
      ...(recorded.recordKind !== undefined ? { recordKind: recorded.recordKind } : {}),
      recordId: recorded.recordId,
      fromState: recorded.fromState ?? '',
      toState: recorded.toState ?? '',
      payloadHash: recorded.payloadHash,
      receivedAt: recorded.receivedAt,
      ...(envelope.headBranch !== undefined ? { headBranch: envelope.headBranch } : {}),
      ...(envelope.baseBranch !== undefined ? { baseBranch: envelope.baseBranch } : {}),
      // M2: re-derived from the re-parsed envelope (parser is pure over the
      // raw body, unaffected by ledger state).
      ...(envelope.repoFullName !== undefined ? { repoFullName: envelope.repoFullName } : {}),
      ...(envelope.installationId !== undefined ? { installationId: envelope.installationId } : {}),
    };
  }

  // Test-only inspection.
  inflightCount(): number {
    return this.inflight.size;
  }
}

// The B1 producer body contract: { deliveryId, event, payload }. The SB SDK
// JSON-deserializes a message sent with applicationProperties content-type
// application/json, so `body` may arrive as an object OR a JSON string —
// handle both.
interface EventQueueBody {
  deliveryId: string;
  event: string;
  payload: string;
}

function parseBody(body: unknown): EventQueueBody | undefined {
  let obj: unknown = body;
  if (typeof body === 'string') {
    try {
      obj = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (typeof obj !== 'object' || obj === null) return undefined;
  const record = obj as Record<string, unknown>;
  const { deliveryId, event, payload } = record;
  if (typeof deliveryId !== 'string' || typeof event !== 'string' || typeof payload !== 'string') {
    return undefined;
  }
  return { deliveryId, event, payload };
}

function isSessionUnavailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; name?: unknown };
  return (
    // ServiceTimeout / SessionCannotBeLocked are the SDK's normalized
    // ServiceBusError codes when the server-side receive window elapses with no
    // session available on an empty session-enabled queue (sync reject AND,
    // separately, an async link rejection — see the process guard in
    // mainConsumer.ts). OperationTimeoutError + AbortError/TimeoutError cover
    // the abortSignal.timeout path. All mean "empty poll", not a fault.
    (typeof e.code === 'string' && TRANSIENT_SB_CODES.has(e.code)) ||
    e.code === 'OperationTimeoutError' ||
    e.name === 'AbortError' ||
    e.name === 'TimeoutError'
  );
}

// The @azure/service-bus SDK's normalized `ServiceBusError.code` values that
// are transient (verified against node_modules/@azure/service-bus — codex PR
// #142). NOTE: these are the SDK's post-normalization spellings (e.g.
// `SessionCannotBeLocked`, NOT the rhea-level `SessionCannotBeLockedError`;
// `ServiceBusy`, NOT `ServerBusy`).
const TRANSIENT_SB_CODES: ReadonlySet<string> = new Set([
  'ServiceTimeout',
  'ServiceBusy',
  'ServiceCommunicationProblem',
  'SessionCannotBeLocked',
  'SessionLockLost',
  'MessageLockLost',
]);

// A transient/retryable Service Bus condition. Used by the consumer's OWN
// acceptNextSession catch, where the error is already known to originate from
// the @azure/service-bus call — so the generic shapes (retryable / AbortError /
// TimeoutError, plus the rhea-level OperationTimeoutError) are safe to treat as
// an empty poll in that local context.
export function isTransientServiceBusError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; retryable?: unknown; name?: unknown };
  if (e.retryable === true) return true;
  if (typeof e.code === 'string' && TRANSIENT_SB_CODES.has(e.code)) return true;
  return e.code === 'OperationTimeoutError' || e.name === 'AbortError' || e.name === 'TimeoutError';
}

// STRICT variant for the PROCESS-WIDE unhandledRejection guard in mainConsumer.
// A process-level handler must not mask unrelated rejections that merely happen
// to carry a generic `retryable`/`AbortError` shape, so this additionally
// requires the definitive @azure/service-bus error class signature
// (`name === 'ServiceBusError'`, which the SDK sets on every ServiceBusError)
// before swallowing. The dangling acceptNextSession 'ServiceTimeout' rejection
// that crash-looped the job IS a ServiceBusError, so it still matches; a stray
// AbortError from unrelated code does NOT. (codex PR #142 finding.)
export function isTransientServiceBusErrorStrict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name !== 'ServiceBusError') return false;
  if (typeof e.code === 'string' && TRANSIENT_SB_CODES.has(e.code)) return true;
  return (err as { retryable?: unknown }).retryable === true;
}

export type EventQueueConsumerBootConfig =
  | { kind: 'in-memory' }
  | { kind: 'connection-string'; connectionString: string; queueName: string }
  | { kind: 'managed-identity'; fullyQualifiedNamespace: string; queueName: string };

// Env-driven boot resolution. Mirrors resolveOutgoingPublisherBootConfig:
// connection string preferred, else managed-identity namespace, else
// in-memory.
export function resolveEventQueueConsumerBootConfig(
  env: NodeJS.ProcessEnv = process.env,
): EventQueueConsumerBootConfig {
  const queueName = env[SERVICE_BUS_CONSUME_QUEUE_ENV] ?? DEFAULT_CONSUME_QUEUE_NAME;
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

// Error → string without leaking secrets (the GithubSubstrateClient already
// scrubs token/PEM from its error messages; this is the safe message field).
function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
