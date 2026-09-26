import { Pool, type PoolClient } from 'pg';
import type { PgClient, PgPool } from '../../validator/src/postgresClient.js';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: false | { rejectUnauthorized: true; ca?: string };
  max: number;
}

export function createLocalPool(config: DatabaseConfig): Pool {
  const pool = new Pool({
    ...config,
    application_name: 'software-factory-local',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  // Idle connection failures must not become unhandled process exceptions.
  // In-flight queries still reject; loops recover or terminate without logging secrets.
  pool.on('error', () => console.error('database_idle_connection_error'));
  // A server restart may also terminate a checked-out client between queries.
  pool.on('connect', (client) => {
    client.on('error', () => console.error('database_connection_error'));
  });
  return pool;
}

export function ledgerClient(client: PoolClient): PgClient {
  return {
    async query<R>(sql: string, values?: readonly unknown[]) {
      const result = await client.query(sql, values === undefined ? undefined : [...values]);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    },
    release() {},
  };
}

export function ledgerPool(pool: Pool): PgPool {
  return {
    async query<R>(sql: string, values?: readonly unknown[]) {
      const result = await pool.query(sql, values === undefined ? undefined : [...values]);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    },
    async connect() {
      const client = await pool.connect();
      return { ...ledgerClient(client), release: () => client.release() };
    },
    end: () => pool.end(),
  };
}

export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
