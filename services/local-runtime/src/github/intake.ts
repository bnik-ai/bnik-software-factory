import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { LeasedConsumer } from '../adapters.js';
import type { RuntimeConfig } from '../config.js';
import { transaction } from '../database.js';
import { PostgresQueue, canonicalJson } from '../queue.js';
import type { CodingJob } from '../worker/protocol.js';
import { type ActivationProof, approvedJob, verifyActivation } from './activation.js';
import { GitHubFailure, type GitHubReads, INTAKE_EVENTS } from './client.js';

export const LIVE_EVENTS = new Set<string>([
  ...INTAKE_EVENTS,
  'ping',
  'installation',
  'installation_repositories',
]);
export interface IntakeEnvelope {
  event: string;
  payload: string;
  repositoryId: number;
  installationId: number;
}
export class GitHubIntake extends LeasedConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly config: RuntimeConfig,
    private readonly github: GitHubReads,
  ) {
    super(new PostgresQueue(pool, 'GitHubIntake', config.queue));
    if (config.mode !== 'live') throw new Error('github_intake_requires_live_mode');
  }
  async accept(deliveryId: string, event: string, payload: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId))
      throw new GitHubFailure('delivery_id_invalid');
    if (!LIVE_EVENTS.has(event)) throw new GitHubFailure('event_not_supported');
    let body: {
      installation?: { id: number; app_id?: number };
      repository?: { id: number; full_name: string };
    };
    try {
      body = JSON.parse(payload);
    } catch {
      throw new GitHubFailure('payload_not_json');
    }
    if (!body || typeof body !== 'object') throw new GitHubFailure('payload_not_json');
    // Ping is signed App liveness only. Installation events never authorize work.
    if (event !== 'ping') {
      if (body.installation?.id !== this.config.installationId)
        throw new GitHubFailure('installation_not_configured');
      if (
        !event.startsWith('installation') &&
        (body.repository?.id !== this.config.repositoryId ||
          body.repository?.full_name?.toLowerCase() !== this.config.repository.toLowerCase())
      )
        throw new GitHubFailure('repository_not_configured');
    }
    const envelope: IntakeEnvelope = {
      event,
      payload,
      repositoryId: this.config.repositoryId ?? 0,
      installationId: this.config.installationId,
    };
    return transaction(this.pool, async (client) => {
      await this.queue.enqueue(deliveryId, this.config.repository.toLowerCase(), envelope, client);
      const receipt = await client.query<{ seq: string }>(
        'INSERT INTO webhook_deliveries(delivery_id,event_type,enqueued) VALUES($1,$2,true) ON CONFLICT(delivery_id) DO NOTHING RETURNING seq',
        [deliveryId, event],
      );
      return {
        accepted: true,
        idempotent: receipt.rows.length === 0,
        mode: 'live',
        paidWorkDispatched: false,
      };
    });
  }
  async step(): Promise<boolean> {
    const work = await this.take();
    if (!work) return false;
    try {
      const envelope = work.body as IntakeEnvelope;
      if (
        envelope.repositoryId !== this.config.repositoryId ||
        envelope.installationId !== this.config.installationId
      )
        throw new GitHubFailure('queued_configuration_changed');
      const body = JSON.parse(envelope.payload) as { action?: string; comment?: { body?: string } };
      if (
        envelope.event !== 'issue_comment' ||
        body.action !== 'created' ||
        !body.comment?.body?.trim().startsWith('/factory activate')
      ) {
        await this.queue.complete(work.lease_token, {
          decision: 'observed_no_activation',
          paidWorkDispatched: false,
        });
        return true;
      }
      const proof = await verifyActivation(this.config, this.github, body);
      this.signal(work.lease_token).throwIfAborted();
      let activationId: string = randomUUID();
      const receipt = {
        decision: 'authorized_for_manual_execution',
        activationId,
        paidWorkDispatched: false,
      };
      await this.queue.complete(work.lease_token, receipt, async (client) => {
        const row = await client.query<{ id: string }>(
          `INSERT INTO factory_task_activations(id,delivery_id,repository_id,repository,installation_id,issue_number,issue_id,comment_id,actor_id,actor_login,source_commit,task_hash,proof)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT(repository_id,comment_id) DO NOTHING RETURNING id`,
          [
            activationId,
            work.delivery_key,
            this.config.repositoryId,
            this.config.repository.toLowerCase(),
            this.config.installationId,
            proof.issue.number,
            proof.issue.id,
            proof.comment.id,
            proof.actorId,
            proof.actorLogin,
            proof.sourceCommit,
            proof.taskHash,
            JSON.stringify(proof),
          ],
        );
        if (!row.rows[0]) {
          const previous = await client.query<{ id: string }>(
            'SELECT id FROM factory_task_activations WHERE repository_id=$1 AND comment_id=$2',
            [this.config.repositoryId, proof.comment.id],
          );
          if (!previous.rows[0]) throw new Error('activation_receipt_missing');
          activationId = previous.rows[0].id;
        }
        // Authorization and intake settlement are in the same transaction.
        receipt.activationId = activationId;
      });
      return true;
    } catch (error) {
      if (error instanceof GitHubFailure && !error.retryable)
        await this.queue.deadletter(work.lease_token, error.reason);
      else
        await this.queue.retry(
          work.lease_token,
          error instanceof GitHubFailure ? error.reason : 'activation_verification_failed',
        );
      return true;
    } finally {
      await this.forget(work.lease_token);
    }
  }
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        if (await this.step()) continue;
      } catch {
        console.error('github_intake_step_failed');
      }
      await delay(this.config.pollMs, undefined, { signal }).catch(() => undefined);
    }
  }
}
export async function loadActivation(
  pool: Pool,
  config: RuntimeConfig,
  id: string,
): Promise<ActivationProof> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new GitHubFailure('activation_id_invalid');
  const row = await pool.query<{ proof: ActivationProof }>(
    'SELECT proof FROM factory_task_activations WHERE id=$1 AND repository_id=$2 AND repository=$3 AND installation_id=$4',
    [id, config.repositoryId, config.repository.toLowerCase(), config.installationId],
  );
  if (!row.rows[0]) throw new GitHubFailure('activation_not_found');
  return row.rows[0].proof;
}

export async function authorizeApprovedJob(
  pool: Pool,
  config: RuntimeConfig,
  github: GitHubReads,
  job: CodingJob,
): Promise<void> {
  if (config.mode !== 'live' || config.execution !== 'manual')
    throw new GitHubFailure('execution_disabled');
  const id = job.id.replace(/^activation-/, '');
  const proof = await loadActivation(pool, config, id);
  const fresh = await verifyActivation(config, github, {
    action: 'created',
    sender: proof.comment.user,
    comment: proof.comment,
    issue: proof.issue,
  });
  if (canonicalJson(job) !== canonicalJson(approvedJob(config, id, fresh, job.archiveSha256)))
    throw new GitHubFailure('job_differs_from_authorized_task');
}
