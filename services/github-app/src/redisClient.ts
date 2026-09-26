// Lazy, process-shared ioredis client for Azure Cache for Redis (Basic C0,
// SSL on port 6380). The primary key is injected by the container-app module
// as REDIS_PRIMARY_KEY. A single client is shared per process so the
// installation-token cache reuses one connection pool.

import Redis from 'ioredis';

export const REDIS_HOST_ENV = 'REDIS_HOST';
export const REDIS_PORT_ENV = 'REDIS_PORT';
export const REDIS_PRIMARY_KEY_ENV = 'REDIS_PRIMARY_KEY';
export const REDIS_SSL_ENV = 'REDIS_SSL';

const DEFAULT_PORT = 6380;

export interface ResolvedRedisConfig {
  host: string;
  port: number;
  password: string | undefined;
  tls: boolean;
}

export function resolveRedisConfig(): ResolvedRedisConfig {
  const host = process.env[REDIS_HOST_ENV];
  if (host === undefined || host === '') {
    throw new Error(`${REDIS_HOST_ENV} is not set; refusing to build a Redis client.`);
  }
  const rawPort = process.env[REDIS_PORT_ENV];
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${REDIS_PORT_ENV} env var "${rawPort}" is not a valid TCP port`);
  }
  const password = process.env[REDIS_PRIMARY_KEY_ENV];
  // SSL defaults to on (Azure Cache for Redis non-SSL port is disabled by
  // default and we target 6380).
  const tls = (process.env[REDIS_SSL_ENV] ?? 'true') !== 'false';
  return { host, port, password: password === '' ? undefined : password, tls };
}

let sharedClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (sharedClient === null) {
    const { host, port, password, tls } = resolveRedisConfig();
    sharedClient = new Redis({
      host,
      port,
      password,
      ...(tls ? { tls: {} } : {}),
      // Don't connect until the first command so importing this module in
      // tests / non-Redis boots never opens a socket.
      lazyConnect: true,
    });
  }
  return sharedClient;
}

// Test-only reset so each test gets a clean module state.
export function __resetRedisClientForTests(): void {
  sharedClient = null;
}
