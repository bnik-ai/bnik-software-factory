import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { type RuntimeConfig, resolveConfig, secret } from '../src/config.js';
import { createLocalPool } from '../src/database.js';
import { localApp } from '../src/main.js';
import { migrate } from '../src/migrate.js';
import { type Checkpoint, LocalRuntime } from '../src/runtime.js';
import { runtimeDependencies } from '../src/substrate.js';

export function config(): RuntimeConfig {
  return resolveConfig({
    ...process.env,
    FACTORY_MODE: 'demo',
    FACTORY_REPOSITORY: 'example/factory-demo',
    GITHUB_INSTALLATION_ID: '1',
    GITHUB_APP_SLUG: 'factory-demo',
    GITHUB_WEBHOOK_SECRET: 'synthetic-demo-webhook-key-00000000',
    GITHUB_WEBHOOK_SECRET_FILE: undefined,
    POSTGRES_USER: 'factory_runtime',
    POSTGRES_PASSWORD: secret(process.env, 'FACTORY_DB_PASSWORD'),
    POSTGRES_PASSWORD_FILE: undefined,
    FACTORY_LEASE_MS: '1000',
    FACTORY_RETRY_MS: '10',
    FACTORY_MAX_RETRY_MS: '20',
    FACTORY_MAX_ATTEMPTS: '3',
  });
}
export function runtime(pool: Pool, checkpoint?: (point: Checkpoint) => Promise<void>) {
  const settings = config();
  return new LocalRuntime(pool, settings, {
    ...runtimeDependencies(settings),
    checkpoint,
  });
}
export function payload(record = 'I_DEMO_TASK', human = false) {
  return {
    action: 'labeled',
    label: { name: 'status:ready' },
    sender: {
      type: human ? 'User' : 'Bot',
      login: human ? 'example-maintainer' : 'factory-demo[bot]',
    },
    installation: { id: 1 },
    repository: { full_name: 'example/factory-demo' },
    issue: {
      node_id: record,
      number: 1,
      body: human
        ? ''
        : '<!-- sf:structural sf:agent=planner@fixture run=01ARZ3NDEKTSV4RRFFQ69G5FAV -->',
      user: { login: 'factory-demo[bot]' },
      labels: [{ name: 'kind:task' }, { name: 'status:proposed' }, { name: 'status:ready' }],
    },
  };
}
export async function send(
  pool: Pool,
  body: unknown = payload(),
  id: string = randomUUID(),
  valid = true,
) {
  const settings = config();
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', settings.webhookSecret)
    .update(valid ? raw : 'incorrect')
    .digest('hex');
  return localApp(pool, settings).request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'x-github-delivery': id,
      'x-github-event': 'issues',
      'x-hub-signature-256': `sha256=${signature}`,
    },
    body: raw,
  });
}
export async function initialize(): Promise<{ admin: Pool; pool: Pool }> {
  const admin = createLocalPool({
    ...config().database,
    user: process.env.POSTGRES_USER ?? '',
    password: secret(process.env, 'POSTGRES_PASSWORD'),
  });
  await migrate(admin, secret(process.env, 'FACTORY_DB_PASSWORD'));
  const pool = createLocalPool(config().database);
  return { admin, pool };
}
export async function reset(admin: Pool) {
  await admin.query(
    'TRUNCATE factory_demo_effects,factory_work,audit_ledger,webhook_deliveries RESTART IDENTITY CASCADE',
  );
}
