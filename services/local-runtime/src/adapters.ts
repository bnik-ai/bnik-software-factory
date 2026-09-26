import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { parseAgentRunPayload } from '../../agents/src/payloadParser.js';
import type { AgentRunMessage, AgentRunQueueConsumer } from '../../agents/src/queueConsumer.js';
import type { AtomicDeliveryAcceptor } from '../../github-app/src/app.js';
import type { EnqueueArgs, EventQueue } from '../../github-app/src/eventQueue.js';
import type {
  AgentDispatcher,
  DispatchRequest,
  DispatchResult,
} from '../../orchestrator/src/agentDispatcher.js';
import type { EventQueueConsumer as DispatchConsumer } from '../../orchestrator/src/queueConsumer.js';
import { serializeMessage } from '../../orchestrator/src/serviceBusAgentDispatcher.js';
import { deserializeDispatchMessage } from '../../orchestrator/src/serviceBusEventQueueConsumer.js';
import type {
  AgentRole,
  ParsedTransitionMessage as DispatchMessage,
} from '../../orchestrator/src/types.js';
import type { OutgoingPublisher } from '../../validator/src/outgoingPublisher.js';
import { serializePublishedMessage } from '../../validator/src/outgoingPublisher.js';
import { parsePayload } from '../../validator/src/payloadParser.js';
import { PostgresAuditLedgerWriter } from '../../validator/src/postgresAuditLedgerWriter.js';
import type {
  EventQueueConsumer,
  ParsedTransitionMessage,
} from '../../validator/src/queueConsumer.js';
import type { SubstrateClient } from '../../validator/src/substrateClient.js';
import { resolveTransition } from '../../validator/src/transitionResolver.js';
import type { Verdict } from '../../validator/src/types.js';
import { ledgerPool, transaction } from './database.js';
import { LeaseGuard } from './lease.js';
import { PostgresQueue, type QueueOptions, type Work } from './queue.js';

export const RAW_QUEUE = 'validator';
export const DISPATCH_QUEUE = 'orchestrator';
export const AGENT_ROLES: readonly AgentRole[] = [
  'SpecAgent',
  'DesignAgent',
  'PlannerAgent',
  'BuildAgent',
  'ReviewAgent',
  'OpsAgent',
  'SREAgent',
];

export class PostgresEventQueue implements EventQueue {
  constructor(
    readonly queue: PostgresQueue,
    private readonly client?: PoolClient,
  ) {}
  async enqueue(args: EnqueueArgs): Promise<void> {
    await this.queue.enqueue(args.deliveryId, args.sessionId ?? args.deliveryId, args, this.client);
  }
}

export class PostgresDeliveryAcceptor implements AtomicDeliveryAcceptor {
  constructor(
    private readonly pool: Pool,
    private readonly queue: PostgresQueue,
    private readonly repository: string,
    private readonly installationId: number,
  ) {}
  async accept(args: EnqueueArgs): Promise<{ seq: number; idempotent: boolean }> {
    if (args.repoFullName?.toLowerCase() !== this.repository.toLowerCase())
      throw new Error('repository_not_configured');
    if (args.installationId !== this.installationId) throw new Error('installation_not_configured');
    return transaction(this.pool, async (client) => {
      // Always compare the queue receipt, even when the webhook was seen before.
      // A reused delivery ID with different bytes is a conflict, never a silent ACK.
      await new PostgresEventQueue(this.queue, client).enqueue(args);
      const inserted = await client.query<{ seq: string }>(
        `INSERT INTO webhook_deliveries(delivery_id,event_type,enqueued) VALUES($1,$2,true)
         ON CONFLICT(delivery_id) DO NOTHING RETURNING seq`,
        [args.deliveryId, args.event],
      );
      const row = inserted.rows[0];
      if (row) return { seq: Number(row.seq), idempotent: false };
      const existing = await client.query<{ seq: string }>(
        'SELECT seq FROM webhook_deliveries WHERE delivery_id=$1',
        [args.deliveryId],
      );
      if (!existing.rows[0]) throw new Error('receipt_missing');
      return { seq: Number(existing.rows[0].seq), idempotent: true };
    });
  }
}

// The consumer owns renewal from claim time, including slow parsing/substrate reads.
export class LeasedConsumer {
  private readonly claims = new Map<string, { work: Work; guard: LeaseGuard }>();
  constructor(readonly queue: PostgresQueue) {}
  async take(): Promise<Work | undefined> {
    const work = await this.queue.claim();
    if (work)
      this.claims.set(work.lease_token, {
        work,
        guard: new LeaseGuard(this.queue, work.lease_token),
      });
    return work;
  }
  signal(token: string): AbortSignal {
    const claim = this.claims.get(token);
    if (!claim) throw new Error('unknown_claim');
    return claim.guard.signal;
  }
  async forget(token: string): Promise<void> {
    const claim = this.claims.get(token);
    this.claims.delete(token);
    await claim?.guard.stop();
  }
  async ack(token: string): Promise<void> {
    try {
      this.signal(token).throwIfAborted();
      await this.queue.ack(token);
    } finally {
      await this.forget(token);
    }
  }
  async deadletter(token: string, reason: string): Promise<void> {
    try {
      await this.queue.deadletter(token, reason);
    } finally {
      await this.forget(token);
    }
  }
  async retry(token: string, reason: string): Promise<void> {
    try {
      await this.queue.retry(token, reason);
    } finally {
      await this.forget(token);
    }
  }
  async close(): Promise<void> {
    for (const claim of this.claims.values()) claim.guard.abort();
    await Promise.all([...this.claims.keys()].map((token) => this.forget(token)));
    // Do not unlock running external work early. Expiry recovers abandoned claims.
  }
}

export type ValidatorSubstrateFactory = (
  delivery: EnqueueArgs,
  signal: AbortSignal,
) => SubstrateClient;
export class PostgresValidatorConsumer extends LeasedConsumer implements EventQueueConsumer {
  readonly ledger: PostgresAuditLedgerWriter;
  readonly substrates = new Map<string, SubstrateClient>();
  constructor(
    queue: PostgresQueue,
    readonly appBotLogins: ReadonlySet<string>,
    private readonly substrateFactory: ValidatorSubstrateFactory,
  ) {
    super(queue);
    this.ledger = new PostgresAuditLedgerWriter(ledgerPool(queue.pool));
  }
  override async forget(token: string): Promise<void> {
    this.substrates.delete(token);
    await super.forget(token);
  }
  async receive(opts: { maxMessages: number }): Promise<ParsedTransitionMessage[]> {
    if (opts.maxMessages <= 0) return [];
    // Resolve one at a time: later events must observe committed predecessor state.
    const work = await this.take();
    if (!work) return [];
    try {
      const delivery = work.body as EnqueueArgs;
      if (
        typeof delivery?.payload !== 'string' ||
        typeof delivery.event !== 'string' ||
        delivery.deliveryId !== work.delivery_key
      ) {
        await this.deadletter(work.lease_token, 'invalid_delivery_envelope');
        return [];
      }
      let body: unknown;
      try {
        body = JSON.parse(delivery.payload);
      } catch {
        await this.deadletter(work.lease_token, 'payload_not_json');
        return [];
      }
      const parsed = parsePayload(
        {
          deliveryId: delivery.deliveryId,
          eventType: delivery.event,
          rawBody: Buffer.from(delivery.payload),
          parsedBody: body,
          receivedAt: work.created_at,
        },
        { appBotLogins: this.appBotLogins },
      );
      if (!parsed.ok) {
        await this.deadletter(work.lease_token, parsed.reason);
        return [];
      }
      const substrate = this.substrateFactory(delivery, this.signal(work.lease_token));
      const resolved = await resolveTransition(parsed.envelope, {
        substrate,
        ledger: this.ledger,
        appBotLogins: this.appBotLogins,
      });
      if (!resolved.ok) {
        if (resolved.observational) await this.ack(work.lease_token);
        else await this.deadletter(work.lease_token, resolved.reason);
        return [];
      }
      this.signal(work.lease_token).throwIfAborted();
      this.substrates.set(work.lease_token, substrate);
      return [{ ...resolved.transition, lockToken: work.lease_token }];
    } catch (error) {
      await this.retry(work.lease_token, 'delivery_resolution_failed').catch(() =>
        this.forget(work.lease_token),
      );
      throw error;
    }
  }
}

export class PostgresOutgoingPublisher implements OutgoingPublisher {
  constructor(
    private readonly queue: PostgresQueue,
    private readonly client: PoolClient,
  ) {}
  async publish(message: ParsedTransitionMessage, verdict: Verdict): Promise<void> {
    const wire = serializePublishedMessage({ ...message, lockToken: 'persisted' }, verdict);
    await this.queue.enqueue(message.deliveryId, message.recordId, wire, this.client);
  }
}

export class PostgresDispatchConsumer extends LeasedConsumer implements DispatchConsumer {
  async receive(opts: { maxMessages: number }): Promise<DispatchMessage[]> {
    if (opts.maxMessages <= 0) return [];
    const work = await this.take();
    if (!work) return [];
    const message = deserializeDispatchMessage(work.body, work.lease_token);
    const outer = (work.body as { verdict?: { verdict?: unknown } } | null)?.verdict?.verdict;
    if (
      !message ||
      !['accept', 'flag', 'reject'].includes(String(message.verdict)) ||
      outer !== message.verdict ||
      message.payloadHash.length !== 32
    ) {
      await this.deadletter(work.lease_token, 'invalid_dispatch_envelope');
      return [];
    }
    return [message];
  }
}

export function dispatchKey(request: DispatchRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([request.message.deliveryId, request.agent, request.transitionKey]))
    .digest('hex');
}
export class PostgresAgentDispatcher implements AgentDispatcher {
  constructor(
    private readonly pool: Pool,
    private readonly options: Partial<QueueOptions> = {},
    private readonly client?: PoolClient,
  ) {}
  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    if (!AGENT_ROLES.includes(request.agent))
      return { ok: false, agent: request.agent, reason: 'unknown_agent_role' };
    const wire = {
      agent: request.agent,
      transition_key: request.transitionKey,
      message: {
        ...serializeMessage({ ...request.message, lockToken: 'persisted' }),
        ...(request.message.reReviewMode ? { reReviewMode: request.message.reReviewMode } : {}),
      },
    };
    const id = dispatchKey(request);
    await new PostgresQueue(this.pool, request.agent, this.options).enqueue(
      id,
      request.message.recordId,
      wire,
      this.client,
    );
    return { ok: true, agent: request.agent, dispatchId: id };
  }
}
export class PostgresAgentRunConsumer extends LeasedConsumer implements AgentRunQueueConsumer {
  constructor(
    queue: PostgresQueue,
    readonly role: AgentRole,
  ) {
    super(queue);
  }
  async receive(opts: { maxMessages: number }): Promise<AgentRunMessage[]> {
    if (opts.maxMessages <= 0) return [];
    const work = await this.take();
    if (!work) return [];
    const parsed = parseAgentRunPayload(JSON.stringify(work.body));
    if (
      !parsed.ok ||
      parsed.value.agent !== this.role ||
      parsed.value.message.verdict !== 'accept'
    ) {
      await this.deadletter(work.lease_token, 'invalid_agent_envelope');
      return [];
    }
    return [
      {
        ...parsed.value,
        lockToken: work.lease_token,
        message: { ...parsed.value.message, lockToken: work.lease_token },
      },
    ];
  }
}
