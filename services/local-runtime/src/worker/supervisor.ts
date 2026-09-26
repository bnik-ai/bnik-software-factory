import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { LeaseGuard } from '../lease.js';
import { PostgresQueue, type QueueOptions } from '../queue.js';
import { Docker, WorkerFailure, cleanupRun, executeIsolated } from './docker.js';
import { type CodingJob, type CodingOutcome, parseJob } from './protocol.js';

export type Executor = typeof executeIsolated;
export interface SupervisorOptions {
  pool: Pool;
  repository: string;
  mode: 'demo' | 'live';
  image: string;
  modelKey?: string;
  signal: AbortSignal;
  queue?: Partial<QueueOptions>;
  execute?: Executor;
  docker?: Docker;
}
export class CodingSupervisor {
  readonly queue: PostgresQueue;
  private readonly docker: Docker;
  constructor(private readonly options: SupervisorOptions) {
    this.queue = new PostgresQueue(options.pool, 'CodingJob', { ...options.queue, maxAttempts: 1 });
    this.docker = options.docker ?? new Docker();
  }
  // Native operator invocation is the activation boundary. No webhook starts this.
  async submit(value: unknown): Promise<string> {
    const job = parseJob(value);
    if (
      job.mode !== this.options.mode ||
      job.repository.toLowerCase() !== this.options.repository.toLowerCase()
    )
      throw new Error('unconfigured_coding_job');
    return this.queue.enqueue(job.id, job.repository.toLowerCase(), job);
  }
  private async lock(): Promise<PoolClient> {
    const client = await this.options.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,607)) AS locked',
        [`CodingRepository:${this.options.repository.toLowerCase()}`],
      );
      if (!result.rows[0]?.locked) throw new Error('coding_job_already_supervised');
      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  }
  private async unlock(client: PoolClient): Promise<void> {
    await client
      .query('SELECT pg_advisory_unlock(hashtextextended($1,607))', [
        `CodingRepository:${this.options.repository.toLowerCase()}`,
      ])
      .catch(() => undefined);
    client.release();
  }
  private async recoverLocked(): Promise<void> {
    const runs = await this.options.pool.query<{ run_id: string; active: boolean }>(
      "SELECT r.run_id,(w.state='running' AND w.lease_until>clock_timestamp()) AS active FROM factory_worker_runs r JOIN factory_work w ON w.id=r.work_id WHERE w.queue_name='CodingJob' AND w.record_key=$1 AND r.state IN ('preparing','running','cleanup_failed')",
      [this.options.repository.toLowerCase()],
    );
    for (const row of runs.rows) {
      if (row.active) throw new Error('coding_job_lease_still_active');
      await cleanupRun(this.docker, row.run_id);
      await this.options.pool.query(
        "UPDATE factory_worker_runs SET state='failed',reason='supervisor_interrupted_resources_removed',ended_at=clock_timestamp() WHERE run_id=$1",
        [row.run_id],
      );
    }
  }
  async recover(): Promise<void> {
    const lock = await this.lock();
    try {
      await this.recoverLocked();
    } finally {
      await this.unlock(lock);
    }
  }
  async cancel(id: string): Promise<number> {
    const result = await this.options.pool.query(
      "UPDATE factory_worker_runs r SET cancel_requested=true FROM factory_work w WHERE r.work_id=w.id AND w.queue_name='CodingJob' AND w.delivery_key=$1 AND w.record_key=$2 AND r.state IN ('preparing','running')",
      [id, this.options.repository.toLowerCase()],
    );
    return result.rowCount ?? 0;
  }
  async run(
    id: string,
    archive: Buffer,
  ): Promise<{ workId: string; runId?: string; outcome: CodingOutcome; cached: boolean }> {
    const { pool } = this.options;
    const lock = await this.lock();
    const controller = new AbortController();
    // Losing the controller's DB session also loses the execution mutex.
    const connectionLost = () => controller.abort(new Error('supervisor_database_lost'));
    lock.on('error', connectionLost);
    let guard: LeaseGuard | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: Promise<void> = Promise.resolve();
    let stopped = false;
    let runId: string | undefined;
    let token: string | undefined;
    try {
      await this.recoverLocked();
      const existing = (
        await pool.query<{ id: string; body: unknown; state: string; result: CodingOutcome }>(
          "SELECT id,body,state,result FROM factory_work WHERE queue_name='CodingJob' AND delivery_key=$1 AND record_key=$2",
          [id, this.options.repository.toLowerCase()],
        )
      ).rows[0];
      if (!existing) throw new Error('coding_job_not_found');
      if (existing.state === 'done') {
        if (!existing.result) throw new Error('coding_artifact_compacted');
        return { workId: existing.id, outcome: existing.result, cached: true };
      }
      const job = parseJob(existing.body);
      if (
        job.mode !== this.options.mode ||
        job.repository.toLowerCase() !== this.options.repository.toLowerCase()
      )
        throw new Error('unconfigured_coding_job');
      const work = await this.queue.claim(id);
      if (!work) throw new Error('coding_job_not_claimable');
      token = work.lease_token;
      guard = new LeaseGuard(this.queue, token);
      runId = randomUUID();
      await pool.query(
        "INSERT INTO factory_worker_runs(run_id,work_id,lease_token,state) VALUES($1,$2,$3,'preparing')",
        [runId, work.id, token],
      );
      const signal = AbortSignal.any([guard.signal, controller.signal, this.options.signal]);
      const schedule = () => {
        timer = setTimeout(() => {
          poll = pool
            .query<{ cancel_requested: boolean }>(
              'SELECT cancel_requested FROM factory_worker_runs WHERE run_id=$1',
              [runId],
            )
            .then((r) => {
              if (r.rows[0]?.cancel_requested) controller.abort(new Error('operator_cancelled'));
              if (!stopped && !controller.signal.aborted) schedule();
            })
            .catch(() => controller.abort(new Error('supervisor_database_lost')));
        }, 200);
        timer.unref();
      };
      schedule();
      const result = await (this.options.execute ?? executeIsolated)({
        job,
        archive,
        runId,
        image: this.options.image,
        signal,
        modelKey: this.options.modelKey,
        docker: this.docker,
        onStarted: async (imageId) => {
          signal.throwIfAborted();
          await pool.query(
            "UPDATE factory_worker_runs SET state='running',image_id=$2 WHERE run_id=$1",
            [runId, imageId],
          );
        },
      });
      signal.throwIfAborted();
      // Docker cleanup has completed before any ACK. No BuildAgent/Task is settled.
      if (result.outcome.ok) {
        await this.queue.complete(token, result.outcome, async (client) => {
          await client.query(
            "UPDATE factory_worker_runs SET state='succeeded',reason='execution_completed',ended_at=clock_timestamp() WHERE run_id=$1",
            [runId],
          );
        });
      } else {
        await pool.query(
          "UPDATE factory_worker_runs SET state='failed',reason=$2,ended_at=clock_timestamp() WHERE run_id=$1",
          [runId, result.outcome.reason],
        );
        // Store failure artifacts before settlement; they are diagnostic, not acceptance.
        await pool.query(
          "UPDATE factory_work SET result=$2::jsonb WHERE lease_token=$1 AND state='running' AND lease_until>clock_timestamp()",
          [token, JSON.stringify(result.outcome)],
        );
        await this.queue.deadletter(token, result.outcome.reason);
      }
      return { workId: work.id, runId, outcome: result.outcome, cached: false };
    } catch (error) {
      if (runId && token) {
        const reason =
          error instanceof WorkerFailure && error.reason === 'worker_cleanup_failed'
            ? 'worker_cleanup_failed'
            : guard?.signal.aborted ||
                controller.signal.reason?.message === 'supervisor_database_lost'
              ? 'worker_lease_lost'
              : error instanceof WorkerFailure
                ? error.reason
                : this.options.signal.aborted || controller.signal.aborted
                  ? 'worker_cancelled'
                  : 'worker_execution_failed';
        const state =
          reason === 'worker_cleanup_failed'
            ? 'cleanup_failed'
            : reason === 'worker_timed_out'
              ? 'timed_out'
              : reason === 'worker_cancelled'
                ? 'cancelled'
                : reason === 'worker_lease_lost'
                  ? 'lease_lost'
                  : 'failed';
        await pool
          .query(
            'UPDATE factory_worker_runs SET state=$2,reason=$3,ended_at=clock_timestamp() WHERE run_id=$1',
            [runId, state, reason],
          )
          .catch(() => undefined);
        // Leave uncertain cleanup/ownership to explicit recovery; never retry paid work.
        if (state !== 'cleanup_failed' && state !== 'lease_lost')
          await this.queue.deadletter(token, reason).catch(() => undefined);
        throw new WorkerFailure(reason);
      }
      throw error;
    } finally {
      stopped = true;
      clearTimeout(timer);
      await poll;
      await guard?.stop();
      lock.removeListener('error', connectionLost);
      await this.unlock(lock);
    }
  }
}
