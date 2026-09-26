import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './database.js';

export type WorkState = 'pending' | 'running' | 'done' | 'dead';
export interface Work {
  id: string;
  queue_name: string;
  delivery_key: string;
  record_key: string;
  body: unknown;
  state: WorkState;
  attempts: number;
  lease_token: string;
  lease_until: Date;
  created_at: Date;
  result: unknown;
}
export interface QueueOptions {
  leaseMs: number;
  maxAttempts: number;
  retryMs: number;
  maxRetryMs: number;
}
export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  leaseMs: 30_000,
  maxAttempts: 5,
  retryMs: 1_000,
  maxRetryMs: 60_000,
};
export class LeaseLostError extends Error {
  constructor() {
    super('work_lease_lost');
  }
}
export class DeliveryConflictError extends Error {
  constructor() {
    super('delivery_key_payload_conflict');
  }
}

// Match JSON's supported values but normalize object-key order for stable receipts.
export function canonicalJson(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value));
  function sort(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return input;
  }
  return JSON.stringify(sort(normalized));
}

export class PostgresQueue {
  readonly options: QueueOptions;
  constructor(
    readonly pool: Pool,
    readonly name: string,
    options: Partial<QueueOptions> = {},
  ) {
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options };
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('invalid_queue_name');
    const { leaseMs, maxAttempts, retryMs, maxRetryMs } = this.options;
    if (
      !Number.isInteger(leaseMs) ||
      leaseMs < 100 ||
      leaseMs > 3_600_000 ||
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 100 ||
      !Number.isInteger(retryMs) ||
      retryMs < 1 ||
      !Number.isInteger(maxRetryMs) ||
      maxRetryMs < retryMs ||
      maxRetryMs > 3_600_000
    )
      throw new Error('invalid_queue_options');
  }

  async enqueue(key: string, record: string, body: unknown, client?: PoolClient): Promise<string> {
    if (!key || !record || key.length > 512 || record.length > 1024)
      throw new Error('invalid_work_identity');
    const json = canonicalJson(body);
    if (Buffer.byteLength(json) > 2_097_152) throw new Error('work_payload_too_large');
    const hash = createHash('sha256').update(json).digest('hex');
    const insert = async (tx: PoolClient) => {
      // Enqueue and claim share this brief lock: commit order equals queue ID order.
      // No transaction or advisory lock is held during external work.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 606))', [this.name]);
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO factory_work(queue_name,delivery_key,record_key,body,body_hash,max_attempts)
         VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(queue_name,delivery_key) DO NOTHING RETURNING id`,
        [this.name, key, record, json, hash, this.options.maxAttempts],
      );
      if (inserted.rows[0]) return inserted.rows[0].id;
      const existing = await tx.query<{
        id: string;
        body_hash: string;
        record_key: string;
      }>(
        'SELECT id,body_hash,record_key FROM factory_work WHERE queue_name=$1 AND delivery_key=$2',
        [this.name, key],
      );
      const row = existing.rows[0];
      if (!row || row.body_hash !== hash || row.record_key !== record)
        throw new DeliveryConflictError();
      return row.id;
    };
    return client ? insert(client) : transaction(this.pool, insert);
  }

  async claim(): Promise<Work | undefined> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 606))', [this.name]);
      await client.query(
        `UPDATE factory_work SET state='dead',lease_token=NULL,lease_until=NULL,
         last_error='lease_attempts_exhausted',settled_at=clock_timestamp()
         WHERE queue_name=$1 AND state='running' AND lease_until<=clock_timestamp() AND attempts>=max_attempts`,
        [this.name],
      );
      const selected = await client.query<{ id: string }>(
        `SELECT w.id FROM factory_work w WHERE w.queue_name=$1 AND w.attempts<w.max_attempts
         AND ((w.state='pending' AND w.available_at<=clock_timestamp()) OR (w.state='running' AND w.lease_until<=clock_timestamp()))
         AND NOT EXISTS (SELECT 1 FROM factory_work earlier WHERE earlier.queue_name=w.queue_name
           AND earlier.record_key=w.record_key AND earlier.id<w.id AND earlier.state IN ('pending','running'))
         ORDER BY w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1`,
        [this.name],
      );
      if (!selected.rows[0]) return undefined;
      const result = await client.query<Work>(
        `UPDATE factory_work SET state='running',attempts=attempts+1,lease_token=$2,
         lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 RETURNING *`,
        [selected.rows[0].id, randomUUID(), this.options.leaseMs],
      );
      return result.rows[0];
    });
  }

  async renew(token: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE factory_work SET lease_until=clock_timestamp()+$3*interval '1 millisecond'
       WHERE queue_name=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()`,
      [this.name, token, this.options.leaseMs],
    );
    if (result.rowCount !== 1) throw new LeaseLostError();
  }

  async complete(
    token: string,
    result: unknown = null,
    effect?: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const owned = await client.query(
        `SELECT id FROM factory_work WHERE queue_name=$1 AND lease_token=$2 AND state='running'
         AND lease_until>clock_timestamp() FOR UPDATE`,
        [this.name, token],
      );
      if (owned.rowCount !== 1) throw new LeaseLostError();
      if (effect) await effect(client);
      const settled = await client.query(
        `UPDATE factory_work SET state='done',result=$3::jsonb,lease_token=NULL,lease_until=NULL,settled_at=clock_timestamp()
         WHERE queue_name=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()`,
        [this.name, token, JSON.stringify(result)],
      );
      // A lease expiring inside the transaction rolls back BOTH effects and ACK.
      if (settled.rowCount !== 1) throw new LeaseLostError();
    });
  }

  ack(token: string): Promise<void> {
    return this.complete(token);
  }

  async retry(token: string, reason: string): Promise<void> {
    await this.settleFailure(token, reason, false);
  }
  async deadletter(token: string, reason: string): Promise<void> {
    await this.settleFailure(token, reason, true);
  }
  private async settleFailure(token: string, reason: string, dead: boolean): Promise<void> {
    const result = await this.pool.query(
      `UPDATE factory_work SET state=CASE WHEN $3 OR attempts>=max_attempts THEN 'dead' ELSE 'pending' END,
       available_at=clock_timestamp()+LEAST($5*power(2,LEAST(attempts-1,16)),$6)*interval '1 millisecond',
       settled_at=CASE WHEN $3 OR attempts>=max_attempts THEN clock_timestamp() ELSE NULL END,
       lease_token=NULL,lease_until=NULL,last_error=$4
       WHERE queue_name=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()`,
      [this.name, token, dead, reason.slice(0, 256), this.options.retryMs, this.options.maxRetryMs],
    );
    if (result.rowCount !== 1) throw new LeaseLostError();
  }

  async compactDone(retainDays: number): Promise<number> {
    if (!Number.isInteger(retainDays) || retainDays < 1) throw new Error('invalid_retention_days');
    const result = await this.pool.query(
      `UPDATE factory_work SET body=NULL,result=NULL WHERE queue_name=$1 AND state='done' AND body IS NOT NULL
       AND settled_at<clock_timestamp()-$2*interval '1 day'`,
      [this.name, retainDays],
    );
    // Receipt/hash remains: a compacted delivery still deduplicates and conflicts visibly.
    return result.rowCount ?? 0;
  }
}
