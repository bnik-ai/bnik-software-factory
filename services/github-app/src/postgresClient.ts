// Shared `pg` Pool wired for Entra-ID (Azure AD) auth against the Postgres
// Flexible Server (`software_factory`). Managed-identity tokens expire ~1 hour;
// pg's async `password` callback re-fetches a fresh token per new
// connection, so the pool survives token rotation without recycling.
//
// Duplicate-by-package with the validator's postgresClient is intentional
// for v0 (the two packages don't share a module graph). Do NOT import the
// validator's copy.

import { DefaultAzureCredential } from '@azure/identity';
import { Pool, type PoolConfig } from 'pg';

export const POSTGRES_HOST_ENV = 'POSTGRES_HOST';
export const POSTGRES_PORT_ENV = 'POSTGRES_PORT';
export const POSTGRES_DATABASE_ENV = 'POSTGRES_DATABASE';
export const POSTGRES_USER_ENV = 'POSTGRES_USER';

const DEFAULT_PORT = 5432;
const DEFAULT_DATABASE = 'software_factory';

// Azure Database for PostgreSQL Entra-ID token scope.
const POSTGRES_AAD_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

export interface ResolvedPoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
}

// Reads connection coords from env. Throws a clear error when POSTGRES_HOST
// or POSTGRES_USER is missing so boot fails fast rather than at first query.
export function resolvePoolConfig(): ResolvedPoolConfig {
  const host = process.env[POSTGRES_HOST_ENV];
  if (host === undefined || host === '') {
    throw new Error(`${POSTGRES_HOST_ENV} is not set; refusing to build a Postgres pool.`);
  }
  const user = process.env[POSTGRES_USER_ENV];
  if (user === undefined || user === '') {
    throw new Error(`${POSTGRES_USER_ENV} is not set; refusing to build a Postgres pool.`);
  }
  const rawPort = process.env[POSTGRES_PORT_ENV];
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${POSTGRES_PORT_ENV} env var "${rawPort}" is not a valid TCP port`);
  }
  const database = process.env[POSTGRES_DATABASE_ENV] || DEFAULT_DATABASE;
  return { host, port, database, user };
}

// Builds a Pool whose per-connection password is a freshly-minted Entra-ID
// access token. `credential` is injectable for tests (any object with a
// `getToken(scope)` method); production uses DefaultAzureCredential (the
// container's managed identity).
export interface BuildPoolDeps {
  credential?: { getToken(scope: string): Promise<{ token: string } | null> };
  poolConfig?: ResolvedPoolConfig;
}

export function buildPostgresPool(deps: BuildPoolDeps = {}): Pool {
  const { host, port, database, user } = deps.poolConfig ?? resolvePoolConfig();
  const credential = deps.credential ?? new DefaultAzureCredential();

  const config: PoolConfig = {
    host,
    port,
    database,
    user,
    ssl: { rejectUnauthorized: true },
    // Async password callback: pg invokes this for each new connection, so a
    // long-lived pool always presents a non-expired token.
    password: async () => {
      const accessToken = await credential.getToken(POSTGRES_AAD_SCOPE);
      if (accessToken === null) {
        throw new Error(
          'Failed to acquire Entra-ID access token for Postgres (getToken returned null).',
        );
      }
      return accessToken.token;
    },
  };
  return new Pool(config);
}
