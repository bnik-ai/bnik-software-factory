import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { resolveConfig } from '../src/config.js';
import type { GitHubIntake } from '../src/github/intake.js';
import { localApp } from '../src/main.js';
import { liveConfig } from './github-fixtures.js';

// src/main.ts: every /webhook request is bounded at 1 MiB before the handler reads it.
const LIMIT = 1_048_576;
const demoConfig = () =>
  resolveConfig({
    FACTORY_MODE: 'demo',
    FACTORY_REPOSITORY: 'example/factory-demo',
    GITHUB_INSTALLATION_ID: '1',
    GITHUB_APP_SLUG: 'factory-demo',
    GITHUB_WEBHOOK_SECRET: 'synthetic-demo-webhook-key-00000000',
    POSTGRES_HOST: '127.0.0.1',
    POSTGRES_TLS: 'disable',
    POSTGRES_DATABASE: 'software_factory',
    POSTGRES_USER: 'factory_runtime',
    POSTGRES_PASSWORD: 'synthetic-database-key',
  });
const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
const intake = {
  accept: async () => {
    throw new Error('not reached');
  },
} as unknown as GitHubIntake;

function post(app: ReturnType<typeof localApp>, bytes: number, chunked = false) {
  const body = new Uint8Array(bytes).fill(0x61);
  return app.request('http://localhost/webhook', {
    method: 'POST',
    headers: chunked
      ? { 'content-type': 'application/json' }
      : { 'content-type': 'application/json', 'content-length': String(bytes) },
    body: chunked
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        })
      : body,
    ...(chunked ? { duplex: 'half' } : {}),
  } as RequestInit);
}

for (const [mode, app] of [
  ['live', localApp(pool, liveConfig(), intake)],
  ['demo', localApp(pool, demoConfig())],
] as const) {
  test(`${mode}: a webhook body over 1 MiB is refused with 413 before the handler`, async () => {
    assert.equal((await post(app, LIMIT + 1)).status, 413);
    assert.equal((await post(app, LIMIT + 1, true)).status, 413);
  });
  test(`${mode}: a webhook body of exactly 1 MiB reaches the handler (refused there for its signature)`, async () => {
    const response = await post(app, LIMIT);
    assert.notEqual(response.status, 413);
    assert.ok(response.status >= 400 && response.status < 500, String(response.status));
  });
}
