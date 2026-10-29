import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo, connect } from 'node:net';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
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
    // 401 is the handler's missing-signature answer; an unrouted POST would be 404.
    assert.equal((await post(app, LIMIT)).status, 401);
    assert.equal((await post(app, LIMIT, true)).status, 401);
  });
}

// Raw request bytes in, response bytes out; the server may close before the whole request is
// written (an early 413), so write errors are not failures. A server still waiting for a body
// that is never sent answers nothing within the deadline.
function exchange(port: number, request: Buffer): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    const deadline = setTimeout(() => finish(), 5_000);
    const finish = () => {
      clearTimeout(deadline);
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('latin1'));
    };
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', finish);
    socket.on('error', finish);
  });
}

function webhookRequest(secret: string, body: Buffer, framing: 'length' | 'declared' | 'chunked') {
  const head = [
    'POST /webhook HTTP/1.1',
    'Host: 127.0.0.1',
    'X-GitHub-Event: ping',
    'X-GitHub-Delivery: delivery-over-http',
    `X-Hub-Signature-256: sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    framing === 'chunked' ? 'Transfer-Encoding: chunked' : `Content-Length: ${body.length}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  if (framing === 'declared') return Buffer.from(head);
  if (framing === 'length') return Buffer.concat([Buffer.from(head), body]);
  const half = Math.ceil(body.length / 2);
  const chunk = (part: Buffer) => [
    Buffer.from(`${part.length.toString(16)}\r\n`),
    part,
    Buffer.from('\r\n'),
  ];
  return Buffer.concat([
    Buffer.from(head),
    ...chunk(body.subarray(0, half)),
    ...chunk(body.subarray(half)),
    Buffer.from('0\r\n\r\n'),
  ]);
}

// src/main.ts serves localApp through @hono/node-server: the bound holds for the declared length
// and for a streamed body, and the signed raw bytes reach intake unchanged.
test('live over HTTP: the 1 MiB bound and the raw signed bytes hold through the Node adapter', async () => {
  const config = liveConfig();
  const received: string[] = [];
  const recording = {
    accept: async (_deliveryId: string, _event: string, payload: string) => {
      received.push(payload);
      return { accepted: true };
    },
  } as unknown as GitHubIntake;
  const server = serve({
    fetch: localApp(pool, config, recording).fetch,
    hostname: '127.0.0.1',
    port: 0,
  });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const over = Buffer.alloc(LIMIT + 1, 0x61);
    for (const framing of ['declared', 'chunked'] as const) {
      const response = await exchange(port, webhookRequest(config.webhookSecret, over, framing));
      assert.match(response, /^HTTP\/1\.1 413 /, framing);
    }
    // Exactly at the bound, including bytes that are not valid UTF-8: the signature is checked
    // over the raw bytes, so any re-encoding by the adapter would turn this into a 401.
    const atLimit = Buffer.alloc(LIMIT, 0x61);
    atLimit.set([0x7b, 0xff, 0xfe, 0xc3, 0x28], 0);
    for (const framing of ['length', 'chunked'] as const) {
      const response = await exchange(port, webhookRequest(config.webhookSecret, atLimit, framing));
      assert.match(response, /^HTTP\/1\.1 202 /, framing);
    }
    assert.deepEqual(received, [atLimit.toString('utf8'), atLimit.toString('utf8')]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
