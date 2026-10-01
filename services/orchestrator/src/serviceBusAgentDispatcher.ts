// Spec: docs/decisions/0011-agent-dispatch-topology.md (Option B, ratified
// 2026-05-30). The infrastructure repository provisions one
// `agent-runs-<role>` Service Bus queue per role; per-role caj-agent-*
// Container Apps Jobs consume them.
// Invariants:
//   - dispatch() enqueues one message to `agent-runs-<role>` and returns
//     ok:true with the messageId we set on the outgoing message. The
//     orchestrator's SB lock releases as soon as enqueue acks (sub-second);
//     the agent runtime is decoupled.
//   - Wire format MUST match what per-role consumers expect: JSON body
//     `{agent, transition_key, message: serializeMessage(...)}` where
//     payloadHash is hex and receivedAt is ISO 8601. Identical to what the
//     deprecated HttpAgentDispatcher produced — per-role consumers reuse
//     the same parser.
//   - Failure modes are typed `enqueue_failed:*` reasons (ADR 0011
//     §"Five-Question Substrate Test" — structural verbs).
//   - Test seam: `senderFactory` lets tests inject a fake sender without
//     opening an AMQP connection. Defaults to
//     `ServiceBusClient.createSender(queueName)`.
//   - Auth shapes: connection-string (dev / shared-key) OR
//     fullyQualifiedNamespace + TokenCredential (managed identity in
//     prod). Exactly one is required.
//   - Per-role queue names default to `agent-runs-<role>` (lowercased
//     agent suffix stripped: SpecAgent → spec). Env overrides supported
//     via resolveServiceBusAgentDispatcherConfig().

import { randomUUID } from 'node:crypto';
import type { TokenCredential } from '@azure/core-auth';
import {
  ServiceBusClient,
  type ServiceBusMessage,
  type ServiceBusSender,
} from '@azure/service-bus';
import type { AgentDispatcher, DispatchRequest, DispatchResult } from './agentDispatcher.js';
import type { AgentRole } from './types.js';

// Classify a thrown error as transient vs deterministic for retry-vs-ack
// semantics. @azure/service-bus surfaces transient
// conditions via `ServiceBusError.code`:
//   - 'ServiceBusy' / 'ServerBusy' — namespace throttling
//   - 'ServiceTimeout' / 'OperationCanceled' — network/timeout
//   - 'ServiceCommunicationProblem' — transient AMQP transport
//   - 'GeneralError' (when the underlying retryable flag is set)
// Auth/authorization/quota-exceeded/message-too-large are deterministic.
// When the err shape is unknown (non-SB error), default to deterministic
// (the conservative choice — better to surface as audit signal than to
// loop on what might be a structural bug).
const TRANSIENT_SB_CODES: ReadonlySet<string> = new Set([
  'ServiceBusy',
  'ServerBusy',
  'ServiceTimeout',
  'OperationCanceled',
  'ServiceCommunicationProblem',
]);

function classifyTransient(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  // ServiceBusError carries .code; some retry-flag carriers also set .retryable.
  const e = err as { code?: unknown; retryable?: unknown; name?: unknown };
  if (typeof e.code === 'string' && TRANSIENT_SB_CODES.has(e.code)) return true;
  if (e.retryable === true) return true;
  // ECONNREFUSED / ECONNRESET / ETIMEDOUT at the socket layer (the SDK
  // sometimes surfaces these unwrapped under `code`).
  if (
    typeof e.code === 'string' &&
    /^E(?:CONNREFUSED|CONNRESET|TIMEDOUT|HOSTUNREACH)$/.test(e.code)
  ) {
    return true;
  }
  return false;
}

// Per-role queue names. Per ADR 0011 the infrastructure repository
// provisions agent-runs-{spec,design,planner,build,review,ops,sre} (ADR 0013
// names the planner queue `planner`, formerly `project`).
export const DEFAULT_QUEUE_NAMES: Readonly<Record<AgentRole, string>> = {
  SpecAgent: 'agent-runs-spec',
  DesignAgent: 'agent-runs-design',
  PlannerAgent: 'agent-runs-planner',
  BuildAgent: 'agent-runs-build',
  ReviewAgent: 'agent-runs-review',
  OpsAgent: 'agent-runs-ops',
  SREAgent: 'agent-runs-sre',
};

export type QueueNameMap = Readonly<Record<AgentRole, string>>;

export type SenderFactory = (queueName: string) => ServiceBusSender;

// Auth shape A: connection string (dev + shared-key prod). Auth shape B:
// fully-qualified namespace + TokenCredential (managed identity).
// Exactly one must be provided; the boot helper enforces this.
export type ServiceBusAuth =
  | { connectionString: string }
  | { fullyQualifiedNamespace: string; credential: TokenCredential };

export interface ServiceBusAgentDispatcherConfig {
  auth: ServiceBusAuth;
  // Per-role queue mapping. Defaults to DEFAULT_QUEUE_NAMES; callers can
  // override individual entries for unusual deployments.
  queueNames?: Partial<QueueNameMap>;
  // Test seam — when present, used instead of constructing a
  // ServiceBusClient. Lets tests assert enqueue behavior without opening
  // an AMQP connection.
  senderFactory?: SenderFactory;
}

export class ServiceBusAgentDispatcher implements AgentDispatcher {
  private readonly queueNames: QueueNameMap;
  private readonly senderFactory: SenderFactory;
  // Sender pool: one sender per role. Reused across dispatches.
  private readonly senders = new Map<AgentRole, ServiceBusSender>();
  // Retained so close() can release the AMQP handles on idle-drain/shutdown
  // (an open client keeps the Container Apps Job process alive). null when a
  // senderFactory test seam is injected (the caller owns that lifecycle).
  private readonly client: ServiceBusClient | null;

  constructor(config: ServiceBusAgentDispatcherConfig) {
    this.queueNames = { ...DEFAULT_QUEUE_NAMES, ...config.queueNames };
    if (config.senderFactory !== undefined) {
      this.senderFactory = config.senderFactory;
      this.client = null;
    } else {
      const client =
        'connectionString' in config.auth
          ? new ServiceBusClient(config.auth.connectionString)
          : new ServiceBusClient(config.auth.fullyQualifiedNamespace, config.auth.credential);
      this.client = client;
      this.senderFactory = (queueName: string) => client.createSender(queueName);
    }
  }

  // Close pooled senders + the ServiceBusClient so the Container Apps Job can
  // exit cleanly after the idle-drain (open AMQP handles otherwise keep the
  // process alive). No-op for the senderFactory test seam.
  async close(): Promise<void> {
    for (const sender of this.senders.values()) {
      await sender.close().catch(() => undefined);
    }
    this.senders.clear();
    if (this.client !== null) {
      await this.client.close().catch(() => undefined);
    }
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const queueName = this.queueNames[request.agent];
    const body = {
      agent: request.agent,
      transition_key: request.transitionKey,
      message: serializeMessage(request.message),
    };
    const messageId = randomUUID();
    const sbMessage: ServiceBusMessage = {
      messageId,
      contentType: 'application/json',
      body,
    };

    let sender: ServiceBusSender;
    try {
      sender = this.getOrCreateSender(request.agent);
    } catch (err) {
      return {
        ok: false,
        agent: request.agent,
        reason: `enqueue_failed:sender_create:${errorMessage(err)}`,
        transient: classifyTransient(err),
      };
    }

    try {
      await sender.sendMessages(sbMessage);
      return { ok: true, agent: request.agent, dispatchId: messageId };
    } catch (err) {
      return {
        ok: false,
        agent: request.agent,
        reason: `enqueue_failed:${queueName}:${errorMessage(err)}`,
        transient: classifyTransient(err),
      };
    }
  }

  queueNameFor(role: AgentRole): string {
    return this.queueNames[role];
  }

  private getOrCreateSender(role: AgentRole): ServiceBusSender {
    const existing = this.senders.get(role);
    if (existing !== undefined) return existing;
    const sender = this.senderFactory(this.queueNames[role]);
    this.senders.set(role, sender);
    return sender;
  }
}

// In-memory variant for tests + v0 boot. Mirrors InMemoryAgentDispatcher's
// shape but records the (role, queueName, body) triple per ADR 0011's
// per-role-queue model.
export interface InMemoryEnqueueAttempt {
  role: AgentRole;
  queueName: string;
  body: {
    agent: AgentRole;
    transition_key: string;
    message: ReturnType<typeof serializeMessage>;
  };
}

export class InMemoryServiceBusAgentDispatcher implements AgentDispatcher {
  private readonly queueNames: QueueNameMap;
  readonly enqueueAttempts: InMemoryEnqueueAttempt[] = [];
  private nextDispatchId = 1;

  constructor(queueNames?: Partial<QueueNameMap>) {
    this.queueNames = { ...DEFAULT_QUEUE_NAMES, ...queueNames };
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const queueName = this.queueNames[request.agent];
    const body = {
      agent: request.agent,
      transition_key: request.transitionKey,
      message: serializeMessage(request.message),
    };
    this.enqueueAttempts.push({ role: request.agent, queueName, body });
    const dispatchId = `disp-sb-${this.nextDispatchId}`;
    this.nextDispatchId += 1;
    return { ok: true, agent: request.agent, dispatchId };
  }

  queueNameFor(role: AgentRole): string {
    return this.queueNames[role];
  }

  attemptCount(): number {
    return this.enqueueAttempts.length;
  }
}

// Wire-format-safe serialization: Buffer fields → hex strings; Date → ISO
// string. Per-role consumers MUST deserialize symmetrically. Identical to
// the deprecated HttpAgentDispatcher's serializeMessage so the same parser
// works on both sides during migration.
export function serializeMessage(message: DispatchRequest['message']): Record<string, unknown> {
  // Optional review-trigger fields. Emitted only when defined so the wire
  // shape stays unchanged for non-PR transitions (the agents' payloadParser
  // accepts string|undefined). The branch-sync gate (ADR 0010 / 0012)
  // populates these on the synthetic rebase-intent message dispatched to
  // BuildAgent; if dropped on the wire BuildAgent's runRebaseForReview
  // deadletters with build_agent_rebase_missing_head_branch.
  const out: Record<string, unknown> = {
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
    verdict: message.verdict,
  };
  if (message.headBranch !== undefined) out.headBranch = message.headBranch;
  if (message.baseBranch !== undefined) out.baseBranch = message.baseBranch;
  // Forward repo slug + installation id so agents authenticate as the
  // right installation (multi-repo dispatch). Emitted only when defined so
  // the wire shape is unchanged for transitions lacking them.
  if (message.repoFullName !== undefined) out.repoFullName = message.repoFullName;
  if (message.installationId !== undefined) out.installationId = message.installationId;
  if (message.reReviewMode !== undefined) out.reReviewMode = message.reReviewMode;
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Env vars for boot resolution. Either CONNECTION_STRING (dev / shared-key
// prod) OR NAMESPACE (managed identity — caller must supply credential
// separately, e.g. DefaultAzureCredential). Per-role queue overrides via
// AGENT_RUNS_QUEUE_<ROLE> (e.g. AGENT_RUNS_QUEUE_SPEC).
export const SERVICE_BUS_CONNECTION_STRING_ENV = 'SERVICE_BUS_CONNECTION_STRING';
export const SERVICE_BUS_NAMESPACE_ENV = 'SERVICE_BUS_NAMESPACE';

const ROLE_ENV_SUFFIX: Readonly<Record<AgentRole, string>> = {
  SpecAgent: 'SPEC',
  DesignAgent: 'DESIGN',
  PlannerAgent: 'PLANNER',
  BuildAgent: 'BUILD',
  ReviewAgent: 'REVIEW',
  OpsAgent: 'OPS',
  SREAgent: 'SRE',
};

export function resolveQueueNameOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<AgentRole, string>> {
  const overrides: Partial<Record<AgentRole, string>> = {};
  for (const role of Object.keys(ROLE_ENV_SUFFIX) as AgentRole[]) {
    const envKey = `AGENT_RUNS_QUEUE_${ROLE_ENV_SUFFIX[role]}`;
    const value = env[envKey];
    if (value !== undefined && value !== '') {
      overrides[role] = value;
    }
  }
  return overrides;
}

// Returns a partial config: auth + queueNames overrides. The caller is
// responsible for supplying a TokenCredential for managed-identity auth
// (mainConsumer wires DefaultAzureCredential when NAMESPACE is set
// without CONNECTION_STRING). Returns null when neither auth shape is
// configured — the orchestrator falls back to
// InMemoryServiceBusAgentDispatcher (v0 / test boot).
export type ResolvedServiceBusBootConfig =
  | {
      kind: 'connection-string';
      connectionString: string;
      queueNames: Partial<Record<AgentRole, string>>;
    }
  | {
      kind: 'namespace';
      fullyQualifiedNamespace: string;
      queueNames: Partial<Record<AgentRole, string>>;
    };

export function resolveServiceBusAgentDispatcherBootConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedServiceBusBootConfig | null {
  const connectionString = env[SERVICE_BUS_CONNECTION_STRING_ENV];
  const namespace = env[SERVICE_BUS_NAMESPACE_ENV];
  const queueNames = resolveQueueNameOverrides(env);

  if (connectionString !== undefined && connectionString !== '') {
    return { kind: 'connection-string', connectionString, queueNames };
  }
  if (namespace !== undefined && namespace !== '') {
    return { kind: 'namespace', fullyQualifiedNamespace: namespace, queueNames };
  }
  return null;
}
