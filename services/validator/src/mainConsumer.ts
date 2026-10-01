import { DefaultAzureCredential } from '@azure/identity';
import { appBotLoginsFromEnv } from './actorResolution.js';
import { InMemoryAuditLedgerWriter } from './auditLedger.js';
import type { AuditLedgerReader, AuditLedgerWriter } from './auditLedger.js';
import { evaluateTransition } from './dispatcher.js';
import { createGithubSubstrateClient } from './githubSubstrateClient.js';
import {
  InMemoryOutgoingPublisher,
  type OutgoingPublisher,
  ServiceBusOutgoingPublisher,
  resolveOutgoingPublisherBootConfig,
} from './outgoingPublisher.js';
import { PostgresAuditLedgerWriter } from './postgresAuditLedgerWriter.js';
import { createPool, resolvePoolConfig } from './postgresClient.js';
import { processMessage } from './processMessage.js';
import { type EventQueueConsumer, InMemoryEventQueueConsumer } from './queueConsumer.js';
import {
  ServiceBusEventQueueConsumer,
  isTransientServiceBusErrorStrict,
  resolveEventQueueConsumerBootConfig,
} from './serviceBusEventQueueConsumer.js';
import { InMemorySubstrateClient, type SubstrateClient } from './substrateClient.js';

// Spec: docs/design/validator-bot.md (session-locked Container Apps Job
// consumer) + Concurrency model (per-session ordering).
// Invariants:
//   - Long-running event loop: receive batch → process each → ack |
//     deadletter | leave-locked (so SB redelivers).
//   - Per-session ordering: messages from one Service Bus session
//     (keyed by record_node_id) MUST be processed in order. On a
//     per-message failure, the loop ENDS THE JOB EXECUTION (returns,
//     not just breaks the inner batch). A real SB session receiver
//     would otherwise hold the session lock through subsequent
//     `receive()` calls in the same execution and pull more messages
//     from the same session — defeating session ordering. Returning
//     releases the lock; KEDA spawns a fresh execution which gets the
//     redelivered failed message first.
//   - Unrecoverable per-message error is logged + left without ack;
//     the SB lock times out and the message redelivers. Validator
//     never crashes the whole loop on one bad message.
//   - SIGTERM / SIGINT → AbortController aborts the loop. In-flight
//     messages finish processing; receive() returns its pending batch
//     and the loop exits cleanly.
//   - Container Apps Job lifecycle: after `idleExitAfterEmptyPolls`
//     consecutive empty receives, the loop exits cleanly (status 0).
//     KEDA spawns a new execution when messages arrive. This matches
//     the Container Apps Job model (vs Container Apps with HTTP ingress).
//   - The Container Apps Job runs this entrypoint. Without Service Bus /
//     Postgres env it wires in-memory deps so the binary boots without
//     external services; with it, the Service Bus + Postgres impls sit
//     behind the same interfaces.

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_BATCH_SIZE = 10;
const DEFAULT_IDLE_EXIT_AFTER_EMPTY_POLLS = 5;
const POLL_MIN_MS = 50;
const POLL_MAX_MS = 60_000;
const BATCH_MIN = 1;
const BATCH_MAX = 256;
const IDLE_EXIT_MIN = 1;
const IDLE_EXIT_MAX = 60;

export interface ConsumerLoopDeps {
  consumer: EventQueueConsumer;
  ledger: AuditLedgerWriter;
  dispatcher: typeof evaluateTransition;
  // Per ADR 0011: validator republishes the FSM-evaluated message (with
  // verdict populated) onto the downstream dispatch queue that the
  // orchestrator consumes. Publishing happens AFTER the audit ledger
  // append + BEFORE the inbound SB ack — if publish fails, the inbound
  // message is not acked, SB redelivers, the audit ledger returns
  // idempotent on the duplicate, and publish retries. This is the
  // at-least-once delivery discipline that prevents a flagged or
  // accepted transition from being recorded but never propagated.
  publisher: OutgoingPublisher;
  // ACTIVATES the cross-record + review-loop assertions in processMessage
  // (they only run when substrate is wired; without it the review-required
  // gate is dormant).
  substrate?: SubstrateClient;
  // The per-installation substrate factory — the SAME one
  // the event consumer resolves with. In live mode the boot `substrate` is an
  // empty InMemorySubstrateClient (resolveSubstrateFromEnv) and the real
  // GithubSubstrateClient exists only per message; without this, the review
  // assertions read an empty substrate, see no verdict=approve marker, and
  // falsely flag every structural approval (OpsAgent never dispatched).
  substrateFactory?: (installationId: number) => SubstrateClient;
  // The configured App-bot login set (GITHUB_APP_SLUG) — threaded so the
  // review assertions trust the SAME logins the parser/resolver trust.
  appBotLogins?: ReadonlySet<string>;
  signal: AbortSignal;
  pollIntervalMs?: number;
  maxBatchSize?: number;
  // KEDA-triggered Container Apps Jobs are supposed to exit after the
  // queue is drained. After this many consecutive empty receives, the
  // loop exits cleanly. KEDA spawns a new execution when messages arrive.
  idleExitAfterEmptyPolls?: number;
  // Optional callback fired on per-message unrecoverable error (for
  // metrics in production; tests assert via this).
  onError?: (deliveryId: string, err: Error) => void;
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runConsumerLoop(deps: ConsumerLoopDeps): Promise<void> {
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const batchSize = deps.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const idleExitAfter = deps.idleExitAfterEmptyPolls ?? DEFAULT_IDLE_EXIT_AFTER_EMPTY_POLLS;
  let emptyPollCount = 0;

  while (!deps.signal.aborted) {
    const batch = await deps.consumer.receive({ maxMessages: batchSize });
    if (batch.length === 0) {
      emptyPollCount += 1;
      if (emptyPollCount >= idleExitAfter) {
        console.log(
          `[validator] queue drained (${emptyPollCount} consecutive empty polls); exiting`,
        );
        return;
      }
      await sleepWithAbort(pollMs, deps.signal);
      continue;
    }
    emptyPollCount = 0;
    for (const message of batch) {
      try {
        // Per-message substrate — the factory wins when the message
        // carries an installationId (mirrors serviceBusEventQueueConsumer's
        // resolution substrate selection); boot substrate is the fallback.
        const assertionSubstrate =
          message.installationId !== undefined && deps.substrateFactory !== undefined
            ? deps.substrateFactory(message.installationId)
            : deps.substrate;
        const decision = await processMessage(message, {
          dispatcher: deps.dispatcher,
          ledger: deps.ledger,
          ...(assertionSubstrate !== undefined ? { substrate: assertionSubstrate } : {}),
          ...(deps.appBotLogins !== undefined ? { appBotLogins: deps.appBotLogins } : {}),
        });
        if (decision.action === 'ack') {
          // Publish AFTER audit-row commit, BEFORE the inbound ack. If
          // publish throws, the inbound message is not acked, SB
          // redelivers, and we re-process (audit ledger returns
          // idempotent on the duplicate row, so we re-publish only —
          // no double-write to the ledger).
          await deps.publisher.publish(message, decision.verdict);
          await deps.consumer.ack(message.lockToken);
        } else {
          await deps.consumer.deadletter(message.lockToken, decision.reason);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        deps.onError?.(message.deliveryId, error);
        // Per-session ordering: END THE JOB EXECUTION. Just breaking
        // the inner loop is insufficient — the outer while would
        // immediately receive() again, and a real Service Bus session
        // receiver still holds the session lock, so the next batch
        // would pull MORE messages from the SAME session (potentially
        // later transitions of the same record). Returning from the
        // loop ends the execution, releases the session lock, and lets
        // KEDA spawn a fresh execution which redelivers the failed
        // message first in session order.
        console.log('[validator] ending execution after message failure to preserve session order');
        return;
      }
    }
  }
}

// Env-resolution helpers exposed for tests via __test below.

function resolvePollIntervalMs(): number {
  const raw = process.env.POLL_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < POLL_MIN_MS || parsed > POLL_MAX_MS) {
    throw new Error(
      `POLL_INTERVAL_MS env var "${raw}" is not a valid integer in [${POLL_MIN_MS}, ${POLL_MAX_MS}]`,
    );
  }
  return parsed;
}

function resolveMaxBatchSize(): number {
  const raw = process.env.MAX_BATCH_SIZE;
  if (raw === undefined || raw === '') return DEFAULT_MAX_BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < BATCH_MIN || parsed > BATCH_MAX) {
    throw new Error(
      `MAX_BATCH_SIZE env var "${raw}" is not a valid integer in [${BATCH_MIN}, ${BATCH_MAX}]`,
    );
  }
  return parsed;
}

function resolveIdleExitAfterEmptyPolls(): number {
  const raw = process.env.IDLE_EXIT_AFTER_EMPTY_POLLS;
  if (raw === undefined || raw === '') return DEFAULT_IDLE_EXIT_AFTER_EMPTY_POLLS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < IDLE_EXIT_MIN || parsed > IDLE_EXIT_MAX) {
    throw new Error(
      `IDLE_EXIT_AFTER_EMPTY_POLLS env var "${raw}" is not a valid integer in [${IDLE_EXIT_MIN}, ${IDLE_EXIT_MAX}]`,
    );
  }
  return parsed;
}

export interface StartConsumerHandle {
  shutdown: () => Promise<void>;
}

function resolvePublisher(): OutgoingPublisher {
  const bootConfig = resolveOutgoingPublisherBootConfig();
  if (bootConfig.kind === 'in-memory') {
    console.log('[validator] publisher: InMemoryOutgoingPublisher (v0/test boot)');
    return new InMemoryOutgoingPublisher();
  }
  if (bootConfig.kind === 'connection-string') {
    console.log(
      `[validator] publisher: ServiceBusOutgoingPublisher (auth=connection-string, queue=${bootConfig.queueName})`,
    );
    return new ServiceBusOutgoingPublisher({
      auth: { connectionString: bootConfig.connectionString },
      queueName: bootConfig.queueName,
    });
  }
  console.log(
    `[validator] publisher: ServiceBusOutgoingPublisher (auth=managed-identity, namespace=${bootConfig.fullyQualifiedNamespace}, queue=${bootConfig.queueName})`,
  );
  return new ServiceBusOutgoingPublisher({
    auth: {
      fullyQualifiedNamespace: bootConfig.fullyQualifiedNamespace,
      credential: new DefaultAzureCredential(),
    },
    queueName: bootConfig.queueName,
  });
}

// Returns a Postgres-backed ledger when POSTGRES_HOST is set, else the
// in-memory ledger. Both impls satisfy AuditLedgerWriter AND
// AuditLedgerReader; the consumer's transition resolver reads committed
// rows through the reader half, so the SAME instance is shared with the
// loop's writer half.
type AuditLedger = AuditLedgerWriter & AuditLedgerReader;

function resolveAuditLedgerFromEnv(): AuditLedger {
  const config = resolvePoolConfig();
  if (config === undefined) {
    console.log('[validator] ledger: InMemoryAuditLedgerWriter (v0/test boot)');
    return new InMemoryAuditLedgerWriter();
  }
  console.log(
    `[validator] ledger: PostgresAuditLedgerWriter (host=${config.host}, database=${config.database})`,
  );
  return new PostgresAuditLedgerWriter(createPool({ config }));
}

// Returns a Service-Bus-backed consumer when SERVICE_BUS_NAMESPACE (or a
// connection string) is set, else the in-memory consumer. The real consumer
// runs payloadParser + transitionResolver, so it needs both the ledger READER
// (to resolve fromState from committed rows) and a read-only SubstrateClient
// (issues.labeled resolution checks getCurrentLabels() to confirm the
// just-applied label durably landed).
function resolveEventQueueConsumerFromEnv(
  ledgerReader: AuditLedgerReader,
  substrate: SubstrateClient,
  substrateFactory?: (installationId: number) => SubstrateClient,
): EventQueueConsumer {
  const bootConfig = resolveEventQueueConsumerBootConfig();
  if (bootConfig.kind === 'in-memory') {
    console.log('[validator] consumer: InMemoryEventQueueConsumer (v0/test boot)');
    return new InMemoryEventQueueConsumer();
  }
  const factoryFields = substrateFactory !== undefined ? { substrateFactory } : {};
  // ADR 0009 §D: recognize the deployment's App `<slug>[bot]` (GITHUB_APP_SLUG)
  // in addition to the documented defaults so an explicitly configured App (example-factory[bot])
  // resolves to the App actor-resolution path instead of being treated as a
  // third-party bot (observational settle).
  const appBotLogins = appBotLoginsFromEnv(process.env);
  if (bootConfig.kind === 'connection-string') {
    console.log(
      `[validator] consumer: ServiceBusEventQueueConsumer (auth=connection-string, queue=${bootConfig.queueName})`,
    );
    return new ServiceBusEventQueueConsumer({
      auth: { connectionString: bootConfig.connectionString },
      queueName: bootConfig.queueName,
      ledgerReader,
      substrate,
      appBotLogins,
      ...factoryFields,
    });
  }
  console.log(
    `[validator] consumer: ServiceBusEventQueueConsumer (auth=managed-identity, namespace=${bootConfig.fullyQualifiedNamespace}, queue=${bootConfig.queueName})`,
  );
  return new ServiceBusEventQueueConsumer({
    auth: {
      fullyQualifiedNamespace: bootConfig.fullyQualifiedNamespace,
      credential: new DefaultAzureCredential(),
    },
    queueName: bootConfig.queueName,
    ledgerReader,
    substrate,
    appBotLogins,
    ...factoryFields,
  });
}

// Resolves the read-only substrate wiring. Returns:
//   - `substrate`: the boot fallback used when a delivery carries no
//     installation id (e.g. non-issue events) — always the
//     in-memory client (empty, so such deliveries still defer/dead-letter,
//     the honest posture).
//   - `substrateFactory`: when GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are set,
//     a per-installation factory that builds the real GraphQL
//     GithubSubstrateClient. The ServiceBus consumer calls it per message with
//     the webhook-threaded installationId, so issues.labeled events re-read
//     the issue's CURRENT labels from GitHub and resolve to a real FSM
//     evaluation + audit_ledger row instead of dead-lettering.
// When the App env is absent the factory is undefined and the in-memory
// fallback is used everywhere (CI / local boot with no App key).
function resolveSubstrateFromEnv(env: NodeJS.ProcessEnv = process.env): {
  substrate: SubstrateClient;
  substrateFactory?: (installationId: number) => SubstrateClient;
} {
  const appId = env.GITHUB_APP_ID ?? '';
  const pemKey = env.GITHUB_APP_PRIVATE_KEY ?? '';
  const appEnvPresent = appId !== '' && pemKey !== '';
  const sbWired =
    (env.SERVICE_BUS_NAMESPACE ?? '') !== '' || (env.SERVICE_BUS_CONNECTION_STRING ?? '') !== '';

  if (appEnvPresent) {
    console.log(
      '[validator] substrate: GithubSubstrateClient (real GraphQL read-only, per-installation) ' +
        'for deliveries carrying an installation id; InMemorySubstrateClient fallback otherwise',
    );
    return {
      substrate: new InMemorySubstrateClient(),
      substrateFactory: (installationId: number): SubstrateClient =>
        createGithubSubstrateClient({
          env: { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: pemKey },
          installationId,
        }),
    };
  }

  if (sbWired) {
    console.warn(
      '[validator] substrate: InMemorySubstrateClient (GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY not set) — ' +
        'issues.labeled events will dead-letter as applied_label_no_longer_present until the App key is wired',
    );
  }
  return { substrate: new InMemorySubstrateClient() };
}

// Installed once per process — the transient-SB unhandledRejection guard
// (see startConsumer). Module-scoped so repeated startConsumer() calls in
// the test suite don't stack process listeners.
let transientGuardInstalled = false;

export function startConsumer(): StartConsumerHandle {
  // Boot resolves each backend from env: Postgres ledger + Service Bus
  // consumer when their env vars are set, otherwise the in-memory impls so
  // the binary boots (and the unit suite runs) without external services.
  const ledger = resolveAuditLedgerFromEnv();
  const { substrate, substrateFactory } = resolveSubstrateFromEnv();
  const consumer = resolveEventQueueConsumerFromEnv(ledger, substrate, substrateFactory);
  const publisher = resolvePublisher();
  const controller = new AbortController();

  const pollIntervalMs = resolvePollIntervalMs();
  const maxBatchSize = resolveMaxBatchSize();
  const idleExitAfterEmptyPolls = resolveIdleExitAfterEmptyPolls();

  const onError = (deliveryId: string, err: Error): void => {
    console.error('[validator] message processing failed', {
      deliveryId,
      error: err.message,
    });
  };

  // Close the long-lived ServiceBusClients exactly once — the consumer's AND
  // the publisher's (an unclosed publisher client keeps an open AMQP
  // connection, the event loop never drains, and the Container Apps Job
  // execution is killed at the replica timeout → 'Failed' despite correct
  // processing). Runs
  // whenever the loop ENDS by any path — idle-drain return, per-message-
  // failure return (which must release the session lock), OR signal abort —
  // not only on SIGTERM/SIGINT.
  let closed = false;
  const closeResources = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const closable = consumer as { close?: () => Promise<void> };
    if (typeof closable.close === 'function') {
      await closable.close().catch((err) => {
        console.error('[validator] consumer close failed', err);
      });
    }
    // publisher.close is optional: only ServiceBusOutgoingPublisher holds
    // AMQP handles; the in-memory publisher omits it (no-op).
    await publisher.close?.().catch((err: unknown) => {
      console.error('[validator] publisher close failed', err);
    });
  };

  const loop = runConsumerLoop({
    consumer,
    ledger,
    dispatcher: evaluateTransition,
    publisher,
    substrate,
    ...(substrateFactory !== undefined ? { substrateFactory } : {}),
    appBotLogins: appBotLoginsFromEnv(process.env),
    signal: controller.signal,
    pollIntervalMs,
    maxBatchSize,
    idleExitAfterEmptyPolls,
    onError,
  }).finally(closeResources);

  const shutdown = async (signal?: NodeJS.Signals): Promise<void> => {
    if (signal !== undefined) {
      console.log(`[validator] received ${signal}, draining`);
    }
    controller.abort();
    await loop; // loop's .finally closes the consumer + publisher
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[validator] shutdown failed', err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // Process-level guard for transient Service Bus faults that escape the
  // consumer's try/catch. On an empty session-enabled queue, acceptNextSession's
  // server-side receive window elapses and the SDK rejects a *dangling* internal
  // AMQP operation (code 'ServiceTimeout', retryable) — an unhandledRejection no
  // local catch can reach, which by default crashes the job and (via redelivery)
  // dead-letters in-flight work. Swallow only transient/retryable SB conditions
  // (the next poll re-establishes the session); rethrow anything else so genuine
  // bugs still fail-fast. Idempotent guard so repeated startConsumer() calls in
  // tests don't stack listeners.
  if (!transientGuardInstalled) {
    transientGuardInstalled = true;
    process.on('unhandledRejection', (reason) => {
      // Strict: only a definitive @azure/service-bus ServiceBusError with a
      // transient code is swallowed — a process-wide handler must not mask
      // unrelated rejections.
      if (isTransientServiceBusErrorStrict(reason)) {
        const code = (reason as { code?: unknown })?.code ?? 'unknown';
        console.warn(
          `[validator] swallowed transient Service Bus error (code=${code}); continuing`,
        );
        return;
      }
      throw reason;
    });
  }

  console.log(
    `[validator] consumer loop started (pollIntervalMs=${pollIntervalMs}, maxBatchSize=${maxBatchSize}, idleExitAfterEmptyPolls=${idleExitAfterEmptyPolls})`,
  );

  return { shutdown };
}

// Bootstrap only when executed directly. Vitest can import this module
// to exercise the helpers in isolation without binding signals.
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startConsumer();
}

export const __test = {
  resolvePollIntervalMs,
  resolveMaxBatchSize,
  resolveIdleExitAfterEmptyPolls,
  sleepWithAbort,
  resolveAuditLedgerFromEnv,
  resolveEventQueueConsumerFromEnv,
  resolveSubstrateFromEnv,
};
