// Spec: docs/design/validator-bot.md (session-locked Container Apps Job
// consumer — same shape as validator's mainConsumer; orchestrator runs
// in its own Container App Job per docs/design/azure-adapter.md).
// Invariants:
//   - Long-running loop: receive batch → process each → ack |
//     deadletter | leave-locked-for-redelivery.
//   - Per-session ordering: on per-message failure END THE JOB EXECUTION
//     (return, don't break). Mirrors the validator's discipline —
//     breaking would let the next receive() pull MORE messages from the
//     same session lock and process them out of order.
//   - SIGTERM/SIGINT → AbortController aborts the loop. In-flight
//     messages finish; receive() returns its pending batch; clean exit.
//   - Container Apps Job lifecycle: after `idleExitAfterEmptyPolls`
//     consecutive empty receives, exit cleanly (status 0). KEDA spawns
//     a fresh execution on queue arrival.

import type { AgentDispatcher } from './agentDispatcher.js';
import { GithubCompareBranchSyncChecker } from './branchSyncChecker.js';
import { processMessage } from './processMessage.js';
import { type EventQueueConsumer, InMemoryEventQueueConsumer } from './queueConsumer.js';
import { routeTransition } from './routingTable.js';
import {
  InMemoryServiceBusAgentDispatcher,
  ServiceBusAgentDispatcher,
  resolveServiceBusAgentDispatcherBootConfig,
} from './serviceBusAgentDispatcher.js';
import {
  ServiceBusDispatchQueueConsumer,
  resolveDispatchConsumerBootConfig,
} from './serviceBusEventQueueConsumer.js';
import { GithubSubstrateClient, type SubstrateClient } from './substrateClient.js';

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
  dispatcher: AgentDispatcher;
  router: typeof routeTransition;
  signal: AbortSignal;
  pollIntervalMs?: number;
  maxBatchSize?: number;
  idleExitAfterEmptyPolls?: number;
  // Optional callback fired on per-message unrecoverable error (for
  // metrics in production; tests assert via this).
  onError?: (deliveryId: string, err: Error) => void;
  // Forwarded to processMessage (branch-sync gate per ADR 0010/0012).
  // Defaults to the pass-through AlwaysCurrentBranchSyncChecker inside
  // processMessage when omitted (no branch-sync check).
  branchSyncChecker?: import('./branchSyncChecker.js').BranchSyncChecker;
  // SubstrateClient is forwarded to processMessage so the paired-Task
  // review-trigger path can resolve head/base via task body → pr-ref →
  // PR. When omitted, the task-path gate skips (matches the
  // pr:* path's "skip when headBranch missing" v0 posture).
  substrateClient?: SubstrateClient;
  defaultBaseBranch?: string;
  // Repo-targeting allowlist (AGENT_TARGET_REPOS), forwarded to
  // processMessage. Undefined → no filtering (backward compat; v0 boots and
  // single-repo deploys without the env var behave exactly as before).
  targetRepoAllowlist?: ReadonlySet<string>;
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
          `[orchestrator] queue drained (${emptyPollCount} consecutive empty polls); exiting`,
        );
        return;
      }
      await sleepWithAbort(pollMs, deps.signal);
      continue;
    }
    emptyPollCount = 0;
    for (const message of batch) {
      try {
        const decision = await processMessage(message, {
          router: deps.router,
          dispatcher: deps.dispatcher,
          branchSyncChecker: deps.branchSyncChecker,
          substrateClient: deps.substrateClient,
          defaultBaseBranch: deps.defaultBaseBranch,
          targetRepoAllowlist: deps.targetRepoAllowlist,
        });
        if (decision.action === 'ack') {
          await deps.consumer.ack(message.lockToken);
        } else if (decision.action === 'retry') {
          // Transient failure — leave the message
          // unsettled and END THE JOB EXECUTION. SB redelivers on a
          // fresh execution. Same session-order discipline as the
          // catch-error path; the explicit log distinguishes "we chose
          // not to settle" from "we crashed".
          console.log(`[orchestrator] ending execution to redeliver transient: ${decision.reason}`);
          return;
        } else {
          await deps.consumer.deadletter(message.lockToken, decision.reason);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        deps.onError?.(message.deliveryId, error);
        // Per-session ordering — END THE JOB EXECUTION. See validator
        // mainConsumer.ts header for the full rationale.
        console.log(
          '[orchestrator] ending execution after message failure to preserve session order',
        );
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

// Dispatcher selection per ADR 0011 (per-role Service Bus fan-out):
//   - SERVICE_BUS_CONNECTION_STRING set → ServiceBusAgentDispatcher
//     (dev / shared-key prod auth).
//   - SERVICE_BUS_NAMESPACE set → ServiceBusAgentDispatcher with
//     DefaultAzureCredential (managed identity, the prod Container Apps
//     Job path).
//   - Neither set → InMemoryServiceBusAgentDispatcher (records enqueue
//     attempts; v0 + test boot).
async function resolveDispatcher(): Promise<AgentDispatcher> {
  const bootConfig = resolveServiceBusAgentDispatcherBootConfig();
  if (bootConfig === null) {
    console.log('[orchestrator] dispatcher: InMemoryServiceBusAgentDispatcher (v0/test boot)');
    return new InMemoryServiceBusAgentDispatcher();
  }
  if (bootConfig.kind === 'connection-string') {
    console.log('[orchestrator] dispatcher: ServiceBusAgentDispatcher (auth=connection-string)');
    return new ServiceBusAgentDispatcher({
      auth: { connectionString: bootConfig.connectionString },
      queueNames: bootConfig.queueNames,
    });
  }
  // Managed identity path. Dynamic-import @azure/identity so dev/test
  // boots don't require the package to be installed.
  const { DefaultAzureCredential } = await import('@azure/identity');
  console.log(
    `[orchestrator] dispatcher: ServiceBusAgentDispatcher (auth=managed-identity, namespace=${bootConfig.fullyQualifiedNamespace})`,
  );
  return new ServiceBusAgentDispatcher({
    auth: {
      fullyQualifiedNamespace: bootConfig.fullyQualifiedNamespace,
      credential: new DefaultAzureCredential(),
    },
    queueNames: bootConfig.queueNames,
  });
}

// Consumer selection mirrors resolveDispatcher (ADR 0011 auth modes):
//   - SERVICE_BUS_CONNECTION_STRING set → ServiceBusDispatchQueueConsumer
//     (dev / shared-key prod auth).
//   - SERVICE_BUS_NAMESPACE set → ServiceBusDispatchQueueConsumer with
//     DefaultAzureCredential (managed identity, the prod Container Apps Job
//     path).
//   - Neither set → InMemoryEventQueueConsumer (v0 / test boot — preserves
//     CI, which never sets SB env).
// The `agent-runs-dispatch` queue is NON-session, so the consumer uses a plain
// createReceiver (no acceptNextSession). Returns the chosen consumer plus an
// optional close() the boot calls on shutdown (the in-memory consumer has none).
async function resolveConsumer(): Promise<{
  consumer: EventQueueConsumer;
  close?: () => Promise<void>;
}> {
  const bootConfig = resolveDispatchConsumerBootConfig();
  if (bootConfig.kind === 'in-memory') {
    console.log('[orchestrator] consumer: InMemoryEventQueueConsumer (v0/test boot)');
    return { consumer: new InMemoryEventQueueConsumer() };
  }
  if (bootConfig.kind === 'connection-string') {
    console.log(
      `[orchestrator] consumer: ServiceBusDispatchQueueConsumer (auth=connection-string, queue=${bootConfig.queueName})`,
    );
    const consumer = new ServiceBusDispatchQueueConsumer({
      auth: { connectionString: bootConfig.connectionString },
      queueName: bootConfig.queueName,
    });
    return { consumer, close: () => consumer.close() };
  }
  // Managed identity path. Dynamic-import @azure/identity so dev/test boots
  // don't require the package to be installed.
  const { DefaultAzureCredential } = await import('@azure/identity');
  console.log(
    `[orchestrator] consumer: ServiceBusDispatchQueueConsumer (auth=managed-identity, namespace=${bootConfig.fullyQualifiedNamespace}, queue=${bootConfig.queueName})`,
  );
  const consumer = new ServiceBusDispatchQueueConsumer({
    auth: {
      fullyQualifiedNamespace: bootConfig.fullyQualifiedNamespace,
      credential: new DefaultAzureCredential(),
    },
    queueName: bootConfig.queueName,
  });
  return { consumer, close: () => consumer.close() };
}

// AGENT_TARGET_REPOS — optional comma-separated owner/repo
// allowlist (e.g. "example-owner/sample-app,example-org/software-factory"). When set,
// processMessage acks messages targeting any OTHER repo as
// `repo_not_targeted` instead of dispatching agents that are pinned to
// AGENT_DEFAULT_REPO and would fail typed cross-repo reads. Unset/empty →
// undefined → no filtering (backward compat). Malformed entries (not
// owner/repo) throw at boot so a typo'd deploy fails loudly rather than
// silently filtering everything (mirrors the other env resolvers' posture).
function resolveTargetRepoAllowlist(): ReadonlySet<string> | undefined {
  const raw = process.env.AGENT_TARGET_REPOS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) return undefined;
  for (const entry of entries) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(entry)) {
      throw new Error(
        `AGENT_TARGET_REPOS entry "${entry}" is not a valid owner/repo slug (full value: "${raw}")`,
      );
    }
  }
  return new Set(entries);
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

// Resolves the SubstrateClient + GithubCompareBranchSyncChecker wiring per
// ADR 0012 item 5 "Activation status" (b). Boot rule:
//   GITHUB_TOKEN + GITHUB_OWNER + GITHUB_REPO all set
//     → real GithubSubstrateClient + GithubCompareBranchSyncChecker;
//   otherwise (v0 / test boot)
//     → undefined SubstrateClient + undefined checker (processMessage
//       falls back to the pass-through AlwaysCurrentBranchSyncChecker).
//
// Failing soft (return undefined) rather than throwing keeps existing v0
// boots unaffected; an operator who wants the real wire MUST set all three
// env vars together. Partial config is a programmer error and is rejected
// loudly so an incomplete deploy doesn't silently degrade to pass-through.
export interface BranchSyncWiring {
  substrateClient: SubstrateClient | undefined;
  branchSyncChecker: import('./branchSyncChecker.js').BranchSyncChecker | undefined;
}

export function resolveBranchSyncWiring(): BranchSyncWiring {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const anySet = Boolean(token) || Boolean(owner) || Boolean(repo);
  const allSet = Boolean(token) && Boolean(owner) && Boolean(repo);
  if (!anySet) {
    return { substrateClient: undefined, branchSyncChecker: undefined };
  }
  if (!allSet) {
    throw new Error(
      'GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO must be set together (or all unset for v0 boot)',
    );
  }
  // token / owner / repo are all set; assertion narrows for ts.
  const tokenValue = token as string;
  const substrateClient = new GithubSubstrateClient({
    getToken: () => tokenValue,
  });
  const branchSyncChecker = new GithubCompareBranchSyncChecker({
    substrateClient,
    owner: owner as string,
    repo: repo as string,
  });
  return { substrateClient, branchSyncChecker };
}

export interface StartConsumerHandle {
  shutdown: () => Promise<void>;
}

export async function startConsumer(): Promise<StartConsumerHandle> {
  // Consumer + dispatcher both pick their impl from env per ADR 0011:
  //   - SERVICE_BUS_CONNECTION_STRING set → real SB (connection-string auth)
  //   - SERVICE_BUS_NAMESPACE set → real SB (managed-identity auth via
  //     DefaultAzureCredential)
  //   - neither → in-memory (v0 / test boot)
  // The consumer reads the `agent-runs-dispatch` queue the validator feeds.
  const { consumer, close: closeConsumer } = await resolveConsumer();
  const dispatcher = await resolveDispatcher();
  const { substrateClient, branchSyncChecker } = resolveBranchSyncWiring();
  const controller = new AbortController();

  const pollIntervalMs = resolvePollIntervalMs();
  const maxBatchSize = resolveMaxBatchSize();
  const idleExitAfterEmptyPolls = resolveIdleExitAfterEmptyPolls();
  const targetRepoAllowlist = resolveTargetRepoAllowlist();

  if (targetRepoAllowlist !== undefined) {
    console.log(
      `[orchestrator] repo-targeting filter: ${[...targetRepoAllowlist].join(', ')} (AGENT_TARGET_REPOS)`,
    );
  } else {
    console.log('[orchestrator] repo-targeting filter: disabled (AGENT_TARGET_REPOS unset)');
  }

  if (branchSyncChecker !== undefined) {
    console.log('[orchestrator] branch-sync gate: GithubCompareBranchSyncChecker (real)');
  } else {
    console.log(
      '[orchestrator] branch-sync gate: AlwaysCurrentBranchSyncChecker (v0 pass-through)',
    );
  }

  const onError = (deliveryId: string, err: Error): void => {
    console.error('[orchestrator] message processing failed', {
      deliveryId,
      error: err.message,
    });
  };

  // Close the SB consumer AND dispatcher handles so the Container Apps Job
  // process can exit (open AMQP clients keep the event loop alive). Idempotent
  // + called on BOTH exit paths: the normal idle-drain return (runConsumerLoop
  // resolves on its own, no signal) AND signal-triggered shutdown. No-op for
  // the in-memory consumer/dispatcher (no handles).
  let closed = false;
  const closeResourcesOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (closeConsumer !== undefined) {
      await closeConsumer().catch((err) => {
        console.error('[orchestrator] consumer close failed', err);
      });
    }
    // dispatcher.close is optional: only the real ServiceBusAgentDispatcher
    // holds AMQP handles. The InMemory dispatcher omits it (no-op).
    await dispatcher.close?.().catch((err: unknown) => {
      console.error('[orchestrator] dispatcher close failed', err);
    });
  };

  const loop = runConsumerLoop({
    consumer,
    dispatcher,
    router: routeTransition,
    signal: controller.signal,
    pollIntervalMs,
    maxBatchSize,
    idleExitAfterEmptyPolls,
    onError,
    branchSyncChecker,
    substrateClient,
    targetRepoAllowlist,
  })
    // Idle-drain exit: when the loop returns without a SIGTERM/SIGINT, close
    // the consumer + dispatcher here so the Job completes instead of the open
    // SB handles keeping the process alive.
    .then(closeResourcesOnce);

  const shutdown = async (signal?: NodeJS.Signals): Promise<void> => {
    if (signal !== undefined) {
      console.log(`[orchestrator] received ${signal}, draining`);
    }
    controller.abort();
    await loop;
    await closeResourcesOnce();
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[orchestrator] shutdown failed', err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  console.log(
    `[orchestrator] consumer loop started (pollIntervalMs=${pollIntervalMs}, maxBatchSize=${maxBatchSize}, idleExitAfterEmptyPolls=${idleExitAfterEmptyPolls})`,
  );

  return { shutdown };
}

// Bootstrap only when executed directly.
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startConsumer().catch((err) => {
    console.error('[orchestrator] startConsumer failed', err);
    process.exit(1);
  });
}

export const __test = {
  resolvePollIntervalMs,
  resolveMaxBatchSize,
  resolveIdleExitAfterEmptyPolls,
  sleepWithAbort,
  resolveBranchSyncWiring,
  resolveTargetRepoAllowlist,
};
