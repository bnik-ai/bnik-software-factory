import { afterEach, describe, expect, test } from 'vitest';
import { resolveAuditLedgerFromEnv, resolveEventQueueFromEnv } from '../src/app.js';

// Env branching for the ca-webhook boot: in-memory with no backend env,
// Service Bus / Postgres impls when the respective env is set. The SB and
// Postgres impls construct lazily (no socket / no credential at build time),
// so these assertions never touch the network.
const ENV_KEYS = [
  'SERVICE_BUS_CONNECTION_STRING',
  'SERVICE_BUS_NAMESPACE',
  'SERVICE_BUS_PRODUCE_QUEUE',
  'POSTGRES_HOST',
  'POSTGRES_USER',
];

// Unset via a variable key (delete on a literal member trips noDelete +
// useLiteralKeys at once; the variable form is how app.test.ts unsets env).
function unsetEnv(key: string): void {
  delete process.env[key];
}
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveEventQueueFromEnv', () => {
  test('in-memory when no SB env is set', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(resolveEventQueueFromEnv().impl).toBe('in-memory');
  });

  test('service-bus connection-string when SERVICE_BUS_CONNECTION_STRING set', () => {
    process.env.SERVICE_BUS_CONNECTION_STRING = 'Endpoint=sb://x';
    const { impl } = resolveEventQueueFromEnv();
    expect(impl).toContain('service-bus(connection-string');
  });

  test('service-bus managed-identity when only SERVICE_BUS_NAMESPACE set', () => {
    unsetEnv('SERVICE_BUS_CONNECTION_STRING');
    process.env.SERVICE_BUS_NAMESPACE = 'sfac-dev-region-sb-main.servicebus.windows.net';
    const { impl } = resolveEventQueueFromEnv();
    expect(impl).toContain('service-bus(managed-identity');
    expect(impl).toContain('validator-events');
  });
});

describe('resolveAuditLedgerFromEnv', () => {
  test('in-memory when POSTGRES_HOST is unset', () => {
    unsetEnv('POSTGRES_HOST');
    expect(resolveAuditLedgerFromEnv().impl).toBe('in-memory');
  });

  test('postgres when POSTGRES_HOST is set', () => {
    process.env.POSTGRES_HOST = 'sfac-dev-region-pg-main.postgres.database.azure.com';
    process.env.POSTGRES_USER = 'sfac-dev-region-id-main';
    const { impl } = resolveAuditLedgerFromEnv();
    expect(impl).toContain('postgres(');
  });
});
