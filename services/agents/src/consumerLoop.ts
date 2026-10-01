// Spec: docs/design/validator-bot.md (Service Bus session-locked Container
// Apps Job consumer pattern — mirrored here for per-role agent consumers per
// ADR 0011) + docs/decisions/0011-agent-dispatch-topology.md.
// Invariants:
//   - Long-running event loop: receive batch → handle each → ack / deadletter.
//   - Per-message handler failure ENDS THE JOB EXECUTION (returns, not
//     just breaks the inner batch). A real Service Bus session receiver
//     would otherwise hold the session lock through subsequent receive()
//     calls in the same execution and pull more messages from the same
//     session — defeating session ordering. Returning releases the lock;
//     KEDA spawns a fresh execution which gets the redelivered failed
//     message first.
//   - Wire-format parse failure → deadletter (the message will never parse,
//     so redelivery loops are pointless); the loop continues to the next
//     message. This is DIFFERENT from runtime handler errors.
//   - Agent-role mismatch (the envelope's `agent` field doesn't match this
//     entrypoint's role) → deadletter. The orchestrator should never publish
//     to the wrong queue, but if it does we surface the bug instead of
//     silently running the wrong handler.
//   - SIGTERM / SIGINT → AbortController aborts the loop. In-flight messages
//     finish processing; receive() returns its pending batch and the loop
//     exits cleanly.
//   - Container Apps Job lifecycle: after `idleExitAfterEmptyPolls`
//     consecutive empty receives, the loop exits cleanly (status 0). KEDA
//     spawns a new execution when messages arrive.

import { DefaultAzureCredential } from '@azure/identity';
import { parseAgentRunPayload } from './payloadParser.js';
import {
  type AgentRunMessage,
  type AgentRunQueueConsumer,
  InMemoryAgentRunQueueConsumer,
} from './queueConsumer.js';
import {
  ServiceBusAgentRunQueueConsumer,
  resolveAgentRunConsumerBootConfig,
} from './serviceBusAgentRunConsumer.js';
import type { AgentRole, ParsedTransitionMessage } from './types.js';

export type AgentRunResult = { ok: true; result: string } | { ok: false; reason: string };

export type AgentRunHandler = (message: ParsedTransitionMessage) => Promise<AgentRunResult>;

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_BATCH_SIZE = 10;
const DEFAULT_IDLE_EXIT_AFTER_EMPTY_POLLS = 5;
export const POLL_MIN_MS = 50;
export const POLL_MAX_MS = 60_000;
export const BATCH_MIN = 1;
export const BATCH_MAX = 256;
export const IDLE_EXIT_MIN = 1;
export const IDLE_EXIT_MAX = 60;

export interface AgentConsumerLoopDeps {
  consumer: AgentRunQueueConsumer;
  // The role this entrypoint owns. Used to defensively reject messages
  // whose envelope.agent doesn't match (deadletter, not crash).
  role: AgentRole;
  // The per-role agent handler — runSpecAgent / runDesignAgent / etc.
  handler: AgentRunHandler;
  signal: AbortSignal;
  pollIntervalMs?: number;
  maxBatchSize?: number;
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

// Run one envelope through: defensive role check → handler → ack/deadletter.
// Returns 'continue' (proceed to next message) or 'end_execution' (return
// from the loop to release the session lock per ordering discipline).
async function processOneEnvelope(
  envelope: AgentRunMessage,
  deps: AgentConsumerLoopDeps,
): Promise<'continue' | 'end_execution'> {
  if (envelope.agent !== deps.role) {
    // Mis-routed by the orchestrator. Deadletter — the orchestrator should
    // never publish to the wrong queue, but if it does, surfacing it is
    // better than silently running the wrong handler.
    await deps.consumer.deadletter(
      envelope.lockToken,
      `wrong_role:expected=${deps.role}:got=${envelope.agent}`,
    );
    return 'continue';
  }

  try {
    const result = await deps.handler(envelope.message);
    if (result.ok) {
      await deps.consumer.ack(envelope.lockToken);
      return 'continue';
    }
    // Handler returned a typed failure: this is an expected outcome (e.g.
    // wrong_transition defensive guard). Deadletter with the reason so the
    // operator can see it without redelivery looping forever.
    await deps.consumer.deadletter(envelope.lockToken, result.reason);
    return 'continue';
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    deps.onError?.(envelope.message.deliveryId, error);
    // Per-session ordering: END THE EXECUTION. Returning here releases the
    // session lock so KEDA can spawn a fresh execution that redelivers the
    // failed message first.
    console.log(
      `[agents:${deps.role}] ending execution after handler failure to preserve session order`,
    );
    return 'end_execution';
  }
}

export async function runAgentConsumerLoop(deps: AgentConsumerLoopDeps): Promise<void> {
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
          `[agents:${deps.role}] queue drained (${emptyPollCount} consecutive empty polls); exiting`,
        );
        return;
      }
      await sleepWithAbort(pollMs, deps.signal);
      continue;
    }
    emptyPollCount = 0;
    for (const envelope of batch) {
      const outcome = await processOneEnvelope(envelope, deps);
      if (outcome === 'end_execution') return;
    }
  }
}

// Parse a JSON-wire payload + wrap it as an AgentRunMessage. Used by the
// real Service Bus adapter — the in-memory consumer skips the wire
// step and accepts AgentRunMessage directly. Exposed here so the parser
// boundary stays inside the agents package.
export function parseEnvelopeFromWire(
  raw: string,
  lockToken: string,
): { ok: true; value: AgentRunMessage } | { ok: false; reason: string } {
  const parsed = parseAgentRunPayload(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return {
    ok: true,
    value: {
      lockToken,
      agent: parsed.value.agent,
      transitionKey: parsed.value.transitionKey,
      message: parsed.value.message,
    },
  };
}

// Env-resolution helpers shared by every entrypoint. Each mainAgent*.ts
// calls these at startup so the per-role binaries all honor the same
// overrides (matches the validator's mainConsumer.ts contract).

export function resolvePollIntervalMs(): number {
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

export function resolveMaxBatchSize(): number {
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

export function resolveIdleExitAfterEmptyPolls(): number {
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

export function resolveQueueName(defaultQueueName: string): string {
  const raw = process.env.AGENT_QUEUE_NAME;
  if (raw === undefined || raw === '') return defaultQueueName;
  return raw;
}

// Per-entrypoint boot shape. Boot env-gates the AgentRunQueueConsumer: the
// Service Bus adapter when SB env is set, else the in-memory consumer so the
// binary boots without an external Service Bus.
export interface StartAgentConsumerOpts {
  role: AgentRole;
  defaultQueueName: string;
  handler: AgentRunHandler;
  // Factory so tests can inject an InMemoryAgentRunQueueConsumer with seeded
  // messages. Real boot uses the default (a fresh in-memory consumer).
  makeConsumer?: () => AgentRunQueueConsumer;
}

export interface StartAgentConsumerHandle {
  shutdown: () => Promise<void>;
}

export function startAgentConsumer(opts: StartAgentConsumerOpts): StartAgentConsumerHandle {
  const pollIntervalMs = resolvePollIntervalMs();
  const maxBatchSize = resolveMaxBatchSize();
  const idleExitAfterEmptyPolls = resolveIdleExitAfterEmptyPolls();
  const queueName = resolveQueueName(opts.defaultQueueName);

  // Tests inject a seeded in-memory consumer via opts.makeConsumer. Real boot
  // env-gates: Service Bus consumer when a namespace/connection-string is set,
  // else in-memory (preserves CI + the existing agent tests with no SB).
  const makeConsumer = opts.makeConsumer ?? (() => resolveAgentRunConsumer(opts.role, queueName));
  const consumer = makeConsumer();
  const controller = new AbortController();

  const onError = (deliveryId: string, err: Error): void => {
    console.error(`[agents:${opts.role}] handler failed`, {
      deliveryId,
      error: err.message,
    });
  };

  // Close the consumer's transport after the loop resolves — on idle-drain exit
  // (loop returns on its own) AND on shutdown. A real Service Bus consumer holds
  // an open ServiceBusClient that would otherwise keep the Container Apps Job
  // process alive past the drain. The in-memory consumer has no close().
  const loop = runAgentConsumerLoop({
    consumer,
    role: opts.role,
    handler: opts.handler,
    signal: controller.signal,
    pollIntervalMs,
    maxBatchSize,
    idleExitAfterEmptyPolls,
    onError,
  }).finally(() => closeConsumerIfPossible(consumer));

  const shutdown = async (signal?: NodeJS.Signals): Promise<void> => {
    if (signal !== undefined) {
      console.log(`[agents:${opts.role}] received ${signal}, draining`);
    }
    controller.abort();
    await loop;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[agents:${opts.role}] shutdown failed`, err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  console.log(
    `[agents:${opts.role}] consumer loop started (queue=${queueName}, pollIntervalMs=${pollIntervalMs}, maxBatchSize=${maxBatchSize}, idleExitAfterEmptyPolls=${idleExitAfterEmptyPolls})`,
  );

  return { shutdown };
}

// Closes a consumer's transport if it exposes an async close() (the Service Bus
// consumer does; the in-memory consumer doesn't). Best-effort: a close failure
// must not crash the drain.
async function closeConsumerIfPossible(consumer: AgentRunQueueConsumer): Promise<void> {
  const maybeClosable = consumer as { close?: () => Promise<void> };
  if (typeof maybeClosable.close === 'function') {
    await maybeClosable.close().catch(() => undefined);
  }
}

// Env-gated consumer selection for real boot. Service Bus when the env names a
// namespace (managed identity) or connection string; in-memory otherwise so
// dev/CI boot with no Service Bus still works. queueName is the already-resolved
// per-role queue (AGENT_QUEUE_NAME override applied). Logs the chosen impl
// (queue name only — never message bodies / secrets).
function resolveAgentRunConsumer(role: AgentRole, queueName: string): AgentRunQueueConsumer {
  const boot = resolveAgentRunConsumerBootConfig();
  if (boot.kind === 'connection-string') {
    console.log(
      `[agents:${role}] consumer impl: ServiceBusAgentRunQueueConsumer (auth=connection-string, queue=${queueName})`,
    );
    return new ServiceBusAgentRunQueueConsumer({
      auth: { connectionString: boot.connectionString },
      queueName,
    });
  }
  if (boot.kind === 'managed-identity') {
    console.log(
      `[agents:${role}] consumer impl: ServiceBusAgentRunQueueConsumer (auth=managed-identity, namespace=${boot.fullyQualifiedNamespace}, queue=${queueName})`,
    );
    return new ServiceBusAgentRunQueueConsumer({
      auth: {
        fullyQualifiedNamespace: boot.fullyQualifiedNamespace,
        // DefaultAzureCredential resolves the Container App's managed identity.
        credential: new DefaultAzureCredential(),
      },
      queueName,
    });
  }
  console.log(`[agents:${role}] consumer impl: InMemoryAgentRunQueueConsumer (no Service Bus env)`);
  return new InMemoryAgentRunQueueConsumer();
}

export const __test = {
  processOneEnvelope,
  sleepWithAbort,
  resolveAgentRunConsumer,
};
