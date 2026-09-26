import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { AgentDispatcher, DispatchRequest } from '../../orchestrator/src/agentDispatcher.js';
import type { BranchSyncChecker } from '../../orchestrator/src/branchSyncChecker.js';
import { processMessage as orchestrate } from '../../orchestrator/src/processMessage.js';
import { routeTransition } from '../../orchestrator/src/routingTable.js';
import type { SubstrateClient as OrchestratorSubstrate } from '../../orchestrator/src/substrateClient.js';
import type { AgentRole } from '../../orchestrator/src/types.js';
import { type AppendArgs, InMemoryAuditLedgerWriter } from '../../validator/src/auditLedger.js';
import { evaluateTransition } from '../../validator/src/dispatcher.js';
import { serializePublishedMessage } from '../../validator/src/outgoingPublisher.js';
import { processMessage as validate } from '../../validator/src/processMessage.js';
import {
  AGENT_ROLES,
  DISPATCH_QUEUE,
  PostgresAgentDispatcher,
  PostgresAgentRunConsumer,
  PostgresDispatchConsumer,
  PostgresOutgoingPublisher,
  PostgresValidatorConsumer,
  RAW_QUEUE,
  type ValidatorSubstrateFactory,
  dispatchKey,
} from './adapters.js';
import type { RuntimeConfig } from './config.js';
import { ledgerClient } from './database.js';
import { PostgresQueue } from './queue.js';

export type Checkpoint =
  | 'validator-evaluated'
  | 'audit-inserted'
  | 'validator-published'
  | 'validator-committed'
  | 'agent-enqueued'
  | 'orchestrator-committed'
  | 'demo-effect-inserted'
  | 'demo-committed';
export interface RuntimeDependencies {
  validatorSubstrate: ValidatorSubstrateFactory;
  orchestratorSubstrate: (signal: AbortSignal) => {
    substrate: OrchestratorSubstrate;
    branchSyncChecker: BranchSyncChecker;
  };
  // Fault-injection/observation seam; the production CLI supplies none.
  checkpoint?: (point: Checkpoint) => Promise<void>;
}

export class LocalRuntime {
  readonly validator: PostgresValidatorConsumer;
  readonly orchestrator: PostgresDispatchConsumer;
  readonly workers: ReadonlyMap<AgentRole, PostgresAgentRunConsumer>;
  private readonly dispatchQueue: PostgresQueue;
  constructor(
    readonly pool: Pool,
    readonly config: RuntimeConfig,
    private readonly deps: RuntimeDependencies,
  ) {
    this.validator = new PostgresValidatorConsumer(
      new PostgresQueue(pool, RAW_QUEUE, config.queue),
      new Set([`${config.appSlug}[bot]`]),
      deps.validatorSubstrate,
    );
    this.dispatchQueue = new PostgresQueue(pool, DISPATCH_QUEUE, config.queue);
    this.orchestrator = new PostgresDispatchConsumer(this.dispatchQueue);
    this.workers = new Map(
      AGENT_ROLES.map((role) => [
        role,
        new PostgresAgentRunConsumer(new PostgresQueue(pool, role, config.queue), role),
      ]),
    );
  }
  private async checkpoint(point: Checkpoint): Promise<void> {
    await this.deps.checkpoint?.(point);
  }

  async validatorStep(): Promise<boolean> {
    const [message] = await this.validator.receive({ maxMessages: 1 });
    if (!message) return false;
    try {
      let append: AppendArgs | undefined;
      const scratchLedger = new InMemoryAuditLedgerWriter();
      // Evaluate existing FSM and assertions without holding a DB transaction.
      // The in-memory row is only a calculation result, never an accepted receipt.
      const decision = await validate(message, {
        dispatcher: evaluateTransition,
        ledger: {
          append: async (args) => {
            append = args;
            return scratchLedger.append(args);
          },
        },
        substrate: this.validator.substrates.get(message.lockToken),
        appBotLogins: this.validator.appBotLogins,
      });
      if (decision.action === 'deadletter') {
        await this.validator.deadletter(message.lockToken, decision.reason);
        return true;
      }
      if (!append) throw new Error('missing_audit_decision');
      const acceptedRow = append;
      await this.checkpoint('validator-evaluated');
      this.validator.signal(message.lockToken).throwIfAborted();
      const pinned = serializePublishedMessage(
        { ...message, lockToken: 'persisted' },
        decision.verdict,
      );
      // The queue's next stage is the transactional outbox: an audit row cannot
      // commit without the exact verdict-bearing message and incoming settlement.
      await this.validator.queue.complete(message.lockToken, pinned, async (client) => {
        await this.validator.ledger.appendInTransaction(ledgerClient(client), acceptedRow);
        await this.checkpoint('audit-inserted');
        await new PostgresOutgoingPublisher(this.dispatchQueue, client).publish(
          message,
          decision.verdict,
        );
        await this.checkpoint('validator-published');
      });
      await this.checkpoint('validator-committed');
      return true;
    } catch (error) {
      await this.validator
        .retry(message.lockToken, 'validator_processing_failed')
        .catch(() => undefined);
      throw error;
    } finally {
      await this.validator.forget(message.lockToken);
    }
  }

  async orchestratorStep(): Promise<boolean> {
    const [message] = await this.orchestrator.receive({ maxMessages: 1 });
    if (!message) return false;
    try {
      const pending: DispatchRequest[] = [];
      const staged: AgentDispatcher = {
        dispatch: async (request) => {
          pending.push(request);
          return {
            ok: true,
            agent: request.agent,
            dispatchId: dispatchKey(request),
          };
        },
      };
      const remote = this.deps.orchestratorSubstrate(this.orchestrator.signal(message.lockToken));
      const decision = await orchestrate(message, {
        router: routeTransition,
        dispatcher: staged,
        branchSyncChecker: remote.branchSyncChecker,
        substrateClient: remote.substrate,
        targetRepoAllowlist: new Set([this.config.repository]),
      });
      if (decision.action === 'retry') {
        await this.orchestrator.retry(message.lockToken, 'orchestrator_requested_retry');
        return true;
      }
      if (decision.action === 'deadletter') {
        await this.orchestrator.deadletter(message.lockToken, decision.reason);
        return true;
      }
      this.orchestrator.signal(message.lockToken).throwIfAborted();
      await this.dispatchQueue.complete(message.lockToken, decision, async (client) => {
        const dispatcher = new PostgresAgentDispatcher(this.pool, this.config.queue, client);
        for (const request of pending) {
          const dispatched = await dispatcher.dispatch(request);
          if (!dispatched.ok) throw new Error('agent_dispatch_failed');
        }
        await this.checkpoint('agent-enqueued');
      });
      await this.checkpoint('orchestrator-committed');
      return true;
    } catch (error) {
      await this.orchestrator
        .retry(message.lockToken, 'orchestrator_processing_failed')
        .catch(() => undefined);
      throw error;
    } finally {
      await this.orchestrator.forget(message.lockToken);
    }
  }

  async demoWorkerStep(role: AgentRole): Promise<boolean> {
    if (this.config.mode !== 'demo') throw new Error('demo_worker_requires_demo_mode');
    const consumer = this.workers.get(role);
    if (!consumer) throw new Error('unknown_agent_role');
    const [envelope] = await consumer.receive({ maxMessages: 1 });
    if (!envelope) return false;
    try {
      consumer.signal(envelope.lockToken).throwIfAborted();
      await consumer.queue.complete(
        envelope.lockToken,
        { mode: 'demo', result: 'fixture_completed_no_external_effect' },
        async (client) => {
          await client.query(
            `INSERT INTO factory_demo_effects(work_id,agent,result)
          SELECT id,$2,'fixture_completed_no_external_effect' FROM factory_work WHERE lease_token=$1
          ON CONFLICT(work_id) DO NOTHING`,
            [envelope.lockToken, role],
          );
          await this.checkpoint('demo-effect-inserted');
        },
      );
      await this.checkpoint('demo-committed');
      return true;
    } catch (error) {
      await consumer.retry(envelope.lockToken, 'demo_processing_failed').catch(() => undefined);
      throw error;
    } finally {
      await consumer.forget(envelope.lockToken);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const loop = async (name: string, step: () => Promise<boolean>) => {
      let failed = false;
      while (!signal.aborted) {
        let busy = false;
        try {
          busy = await step();
          failed = false;
        } catch {
          if (!failed) console.error(`${name}_step_failed`);
          failed = true;
        }
        if (!busy || failed)
          await delay(this.config.pollMs, undefined, { signal }).catch(() => undefined);
      }
    };
    const loops = [
      loop('validator', () => this.validatorStep()),
      loop('orchestrator', () => this.orchestratorStep()),
    ];
    // Live control-plane mode persists agent work for a separately isolated worker.
    // It never invokes the old in-process coding/merge/deploy bootstrap.
    if (this.config.mode === 'demo')
      loops.push(
        loop('demo_worker', async () => {
          for (const role of AGENT_ROLES) if (await this.demoWorkerStep(role)) return true;
          return false;
        }),
      );
    await Promise.all(loops);
  }
  async close(): Promise<void> {
    await Promise.all([
      this.validator.close(),
      this.orchestrator.close(),
      ...[...this.workers.values()].map((worker) => worker.close()),
    ]);
  }
}
