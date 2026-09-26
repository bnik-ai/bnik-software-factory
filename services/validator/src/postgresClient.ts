// Entra-ID (Azure AD) token auth to Postgres Flexible Server.
// Invariants:
//   - Auth is managed-identity only (no password): the pg `password`
//     field is an ASYNC CALLBACK so the token is re-fetched per new
//     connection. Managed-identity AAD tokens expire ~1h; pg invokes the
//     callback each time it opens a backend connection, so a long-lived
//     pool naturally refreshes on reconnect (idle timeout / new client).
//   - Scope is the Postgres-Flexible-Server OSS AAD audience
//     `https://ossrdbms-aad.database.windows.net/.default`.
//   - TLS is REQUIRED by Flexible Server; rejectUnauthorized:true validates
//     the server cert against the system trust store.
//   - resolvePoolConfig() returns undefined when POSTGRES_HOST is unset so
//     the validator boot falls back to the in-memory ledger (no real I/O
//     in unit tests / v0 boot without env).

import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { Pool, type PoolConfig } from 'pg';

const POSTGRES_AAD_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_POSTGRES_DATABASE = 'software_factory';

export interface ResolvedPoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
}

// Reads the POSTGRES_* env. Returns undefined when POSTGRES_HOST is unset
// — the signal the validator boot uses to fall back to the in-memory
// ledger. Throws when POSTGRES_HOST is set but POSTGRES_USER is missing
// (a half-configured deployment is a misconfiguration, not a fallback).
export function resolvePoolConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPoolConfig | undefined {
  const host = env.POSTGRES_HOST;
  if (host === undefined || host === '') return undefined;

  const user = env.POSTGRES_USER;
  if (user === undefined || user === '') {
    throw new Error('POSTGRES_HOST is set but POSTGRES_USER is missing');
  }

  const portRaw = env.POSTGRES_PORT;
  let port = DEFAULT_POSTGRES_PORT;
  if (portRaw !== undefined && portRaw !== '') {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`POSTGRES_PORT env var "${portRaw}" is not a valid TCP port`);
    }
    port = parsed;
  }

  const database = env.POSTGRES_DATABASE ?? DEFAULT_POSTGRES_DATABASE;
  return { host, port, database, user };
}

// Subset of the pg.Pool surface the ledger writer + migrate runner share.
// Lets tests inject a fake pool without depending on a live connection.
export interface PgQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

export interface PgClient {
  query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<R>>;
  release(): void;
}

export interface PgPool {
  query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<R>>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

export interface CreatePoolOptions {
  config?: ResolvedPoolConfig;
  // Test seam: inject a credential so unit tests don't reach Azure IMDS.
  credential?: TokenCredential;
}

// Builds a pg Pool that authenticates each backend connection with a fresh
// Entra-ID access token. Throws if no config is resolvable (caller must
// gate on resolvePoolConfig() returning a value before constructing the
// real pool).
export function createPool(options: CreatePoolOptions = {}): PgPool {
  const config = options.config ?? resolvePoolConfig();
  if (config === undefined) {
    throw new Error('createPool: POSTGRES_HOST is unset — no Postgres config to build a pool from');
  }
  const credential = options.credential ?? new DefaultAzureCredential();

  const poolConfig: PoolConfig = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    // Async password callback: pg awaits this on every new backend
    // connection, so each reconnect picks up a fresh (non-expired) token.
    password: async (): Promise<string> => {
      const token = await credential.getToken(POSTGRES_AAD_SCOPE);
      if (token === null) {
        throw new Error('DefaultAzureCredential returned no token for Postgres AAD scope');
      }
      return token.token;
    },
    ssl: { rejectUnauthorized: true },
  };

  return new Pool(poolConfig) as unknown as PgPool;
}
