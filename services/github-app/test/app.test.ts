import { createHmac } from 'node:crypto';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp, parseRepoAndInstallation, readWebhookSecretFromEnv } from '../src/app.js';
import { InMemoryAuditLedger } from '../src/auditLedger.js';
import { WEBHOOK_SECRET_ENV } from '../src/constants.js';
import { type EnqueueArgs, type EventQueue, InMemoryEventQueue } from '../src/eventQueue.js';

const TEST_SECRET = 'test-webhook-secret-do-not-use-in-prod';
const DELIVERY_ID = '7f3d0c4e-1234-1234-1234-abcdef012345';
const OTHER_DELIVERY_ID = 'aa11bb22-3333-4444-5555-666677778888';

function signatureFor(body: string): string {
  return `sha256=${createHmac('sha256', TEST_SECRET).update(body).digest('hex')}`;
}

function makeRequest(opts: { body: string; headers: Record<string, string> }): Request {
  return new Request('http://test.local/webhook', {
    method: 'POST',
    headers: opts.headers,
    body: opts.body,
  });
}

describe('buildApp — POST /webhook (default in-memory ledger + queue)', () => {
  let app: Hono;
  beforeEach(() => {
    app = buildApp({ webhookSecret: TEST_SECRET });
  });

  test('valid signature + ping event returns 200 with seq (GitHub sends ping on setup; allowlisted)', async () => {
    const body = '{"zen":"Speak like a human."}';
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'ping',
        },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      deliveryId: DELIVERY_ID,
      event: 'ping',
      seq: 1,
    });
  });

  test('valid signature + subscribed event returns 200 with seq + deliveryId + event', async () => {
    const body = '{"action":"opened"}';
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      deliveryId: DELIVERY_ID,
      event: 'issues',
      seq: 1,
    });
  });

  test('valid signature with event outside the allowlist returns 400 event_not_allowed', async () => {
    const body = '{"action":"some_unknown"}';
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'star',
        },
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: 'event_not_allowed' });
  });

  test('invalid signature returns 401 invalid_signature', async () => {
    const response = await app.fetch(
      makeRequest({
        body: '{}',
        headers: {
          'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: 'invalid_signature' });
  });

  test('missing X-GitHub-Delivery returns 400 missing_delivery_id', async () => {
    const body = '{}';
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Event': 'issues',
        },
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: 'missing_delivery_id' });
  });
});

describe('buildApp — POST /webhook (injected ledger + queue, ledger/queue side-effects)', () => {
  let app: Hono;
  let ledger: InMemoryAuditLedger;
  let queue: InMemoryEventQueue;

  beforeEach(() => {
    ledger = new InMemoryAuditLedger();
    queue = new InMemoryEventQueue();
    app = buildApp({ webhookSecret: TEST_SECRET, auditLedger: ledger, eventQueue: queue });
  });

  test('first valid delivery enqueues the event and records the delivery_id', async () => {
    const body = '{"action":"opened"}';
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      deliveryId: DELIVERY_ID,
      event: 'issues',
      seq: 1,
    });
    expect(ledger.recordedDeliveryIds()).toEqual([DELIVERY_ID]);
    expect(queue.enqueuedMessages()).toEqual([
      { deliveryId: DELIVERY_ID, event: 'issues', payload: body },
    ]);
  });

  test('duplicate delivery AFTER first succeeded returns 200 idempotent with same seq and does NOT re-enqueue', async () => {
    const body = '{"action":"opened"}';
    const buildRequest = () =>
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      });
    const firstResponse = await app.fetch(buildRequest());
    await expect(firstResponse.json()).resolves.toMatchObject({ ok: true, seq: 1 });
    const duplicateResponse = await app.fetch(buildRequest());
    expect(duplicateResponse.status).toBe(200);
    await expect(duplicateResponse.json()).resolves.toEqual({
      ok: true,
      deliveryId: DELIVERY_ID,
      event: 'issues',
      seq: 1,
      idempotent: true,
    });
    expect(queue.enqueuedMessages()).toHaveLength(1);
    expect(ledger.size()).toBe(1);
    expect(ledger.isEnqueued(DELIVERY_ID)).toBe(true);
  });

  test('two distinct deliveries each enqueue, ledger seq increments', async () => {
    const body = '{}';
    const sig = signatureFor(body);
    const firstResponse = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': sig,
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      }),
    );
    const secondResponse = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': sig,
          'X-GitHub-Delivery': OTHER_DELIVERY_ID,
          // `push` is noise-dropped at the allowlist; use a
          // second FSM-bearing event type.
          'X-GitHub-Event': 'pull_request',
        },
      }),
    );
    await expect(firstResponse.json()).resolves.toMatchObject({ seq: 1 });
    await expect(secondResponse.json()).resolves.toMatchObject({ seq: 2 });
    expect(queue.enqueuedMessages().map((m) => m.deliveryId)).toEqual([
      DELIVERY_ID,
      OTHER_DELIVERY_ID,
    ]);
  });

  test('invalid signature does NOT touch the ledger or the queue', async () => {
    const response = await app.fetch(
      makeRequest({
        body: '{}',
        headers: {
          'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      }),
    );
    expect(response.status).toBe(401);
    expect(ledger.size()).toBe(0);
    expect(queue.enqueuedMessages()).toHaveLength(0);
  });

  test('disallowed event does NOT touch the ledger or the queue', async () => {
    const body = '{}';
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'star',
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(ledger.size()).toBe(0);
    expect(queue.enqueuedMessages()).toHaveLength(0);
  });
});

describe('buildApp — dual-write resilience when the queue fails', () => {
  // If recordDelivery inserts but enqueue throws, the route returns 5xx and
  // GitHub redelivers; the redelivery must re-enqueue, not return 200
  // idempotent (which would silently drop the webhook). The 2-phase ledger +
  // 503-on-enqueue-failure pattern guarantees this.

  class FailingEventQueue implements EventQueue {
    public failuresRemaining: number;
    public readonly successfullyEnqueued: EnqueueArgs[] = [];
    constructor(failuresRemaining: number) {
      this.failuresRemaining = failuresRemaining;
    }
    async enqueue(args: EnqueueArgs): Promise<void> {
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        throw new Error('simulated Service Bus publish failure');
      }
      this.successfullyEnqueued.push({ ...args });
    }
  }

  test('first delivery: enqueue throws → 503 + ledger row left pending (NOT confirmed)', async () => {
    const ledger = new InMemoryAuditLedger();
    const queue = new FailingEventQueue(99);
    const app = buildApp({ webhookSecret: TEST_SECRET, auditLedger: ledger, eventQueue: queue });
    const body = '{"action":"opened"}';
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: 'enqueue_failed' });
    expect(ledger.size()).toBe(1);
    expect(ledger.isEnqueued(DELIVERY_ID)).toBe(false);
    expect(queue.successfullyEnqueued).toHaveLength(0);
  });

  test('retry after transient enqueue failure: second request re-enqueues, confirms, returns 200', async () => {
    const ledger = new InMemoryAuditLedger();
    const queue = new FailingEventQueue(1); // fail once, then succeed
    const app = buildApp({ webhookSecret: TEST_SECRET, auditLedger: ledger, eventQueue: queue });
    const body = '{"action":"opened"}';
    const buildRequest = () =>
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      });
    const firstResponse = await app.fetch(buildRequest());
    expect(firstResponse.status).toBe(503);
    expect(ledger.isEnqueued(DELIVERY_ID)).toBe(false);
    expect(queue.successfullyEnqueued).toHaveLength(0);

    const retryResponse = await app.fetch(buildRequest());
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({
      ok: true,
      deliveryId: DELIVERY_ID,
      event: 'issues',
      seq: 1,
    });
    expect(ledger.isEnqueued(DELIVERY_ID)).toBe(true);
    expect(queue.successfullyEnqueued).toHaveLength(1);
    expect(queue.successfullyEnqueued[0]).toMatchObject({
      deliveryId: DELIVERY_ID,
      event: 'issues',
    });
  });

  test('retry after FULLY-processed delivery returns 200 idempotent without re-enqueueing', async () => {
    const ledger = new InMemoryAuditLedger();
    const queue = new FailingEventQueue(0); // never fails
    const app = buildApp({ webhookSecret: TEST_SECRET, auditLedger: ledger, eventQueue: queue });
    const body = '{"action":"opened"}';
    const buildRequest = () =>
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      });
    const firstResponse = await app.fetch(buildRequest());
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({ ok: true, seq: 1 });
    expect(queue.successfullyEnqueued).toHaveLength(1);

    const retryResponse = await app.fetch(buildRequest());
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({
      ok: true,
      deliveryId: DELIVERY_ID,
      event: 'issues',
      seq: 1,
      idempotent: true,
    });
    expect(queue.successfullyEnqueued).toHaveLength(1);
  });
});

describe('buildApp — GET /admin/health', () => {
  let app: Hono;
  beforeEach(() => {
    app = buildApp({ webhookSecret: TEST_SECRET });
  });

  test('returns 200 with { ok: true }', async () => {
    const response = await app.fetch(new Request('http://test.local/admin/health'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe('buildApp — GET /healthz (liveness)', () => {
  let app: Hono;
  beforeEach(() => {
    app = buildApp({ webhookSecret: TEST_SECRET });
  });

  test('returns 200 with { status: "ok" }', async () => {
    const response = await app.fetch(new Request('http://test.local/healthz'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});

describe('readWebhookSecretFromEnv', () => {
  test('returns the secret when the env var is set', () => {
    const previous = process.env[WEBHOOK_SECRET_ENV];
    process.env[WEBHOOK_SECRET_ENV] = 'env-supplied-secret';
    try {
      expect(readWebhookSecretFromEnv()).toBe('env-supplied-secret');
    } finally {
      if (previous === undefined) {
        delete process.env[WEBHOOK_SECRET_ENV];
      } else {
        process.env[WEBHOOK_SECRET_ENV] = previous;
      }
    }
  });

  test('throws when the env var is unset', () => {
    const previous = process.env[WEBHOOK_SECRET_ENV];
    delete process.env[WEBHOOK_SECRET_ENV];
    try {
      expect(() => readWebhookSecretFromEnv()).toThrow(/is not set/);
    } finally {
      if (previous !== undefined) {
        process.env[WEBHOOK_SECRET_ENV] = previous;
      }
    }
  });

  test('throws when the env var is an empty string', () => {
    const previous = process.env[WEBHOOK_SECRET_ENV];
    process.env[WEBHOOK_SECRET_ENV] = '';
    try {
      expect(() => readWebhookSecretFromEnv()).toThrow(/is not set/);
    } finally {
      if (previous === undefined) {
        delete process.env[WEBHOOK_SECRET_ENV];
      } else {
        process.env[WEBHOOK_SECRET_ENV] = previous;
      }
    }
  });
});

describe('parseRepoAndInstallation — repo + installation extraction', () => {
  test('extracts repository.full_name + installation.id', () => {
    const raw = Buffer.from(
      JSON.stringify({
        action: 'labeled',
        repository: { full_name: 'example-org/software-factory' },
        installation: { id: 12345678 },
      }),
    );
    expect(parseRepoAndInstallation(raw)).toEqual({
      repoFullName: 'example-org/software-factory',
      installationId: 12345678,
    });
  });

  test('returns empty object when both absent', () => {
    expect(parseRepoAndInstallation(Buffer.from('{"action":"opened"}'))).toEqual({});
  });

  test('ignores non-integer installation.id and empty full_name', () => {
    const raw = Buffer.from(
      JSON.stringify({ repository: { full_name: '' }, installation: { id: 1.5 } }),
    );
    expect(parseRepoAndInstallation(raw)).toEqual({});
  });

  test('unparseable body returns empty object (never throws)', () => {
    expect(parseRepoAndInstallation(Buffer.from('not json'))).toEqual({});
  });

  // The record node id becomes the per-record SB session key.
  test('extracts issue.node_id as recordNodeId', () => {
    const raw = Buffer.from(JSON.stringify({ action: 'labeled', issue: { node_id: 'I_abc' } }));
    expect(parseRepoAndInstallation(raw)).toEqual({ recordNodeId: 'I_abc' });
  });

  test('extracts pull_request.node_id (covers pull_request + pull_request_review)', () => {
    const raw = Buffer.from(
      JSON.stringify({ action: 'submitted', pull_request: { node_id: 'PR_xyz' } }),
    );
    expect(parseRepoAndInstallation(raw)).toEqual({ recordNodeId: 'PR_xyz' });
  });

  test('extracts deployment.node_id', () => {
    const raw = Buffer.from(JSON.stringify({ deployment: { node_id: 'DE_1' } }));
    expect(parseRepoAndInstallation(raw)).toEqual({ recordNodeId: 'DE_1' });
  });

  test('prefers issue.node_id when both issue and pull_request are present', () => {
    const raw = Buffer.from(
      JSON.stringify({ issue: { node_id: 'I_first' }, pull_request: { node_id: 'PR_second' } }),
    );
    expect(parseRepoAndInstallation(raw)).toEqual({ recordNodeId: 'I_first' });
  });
});

describe('buildApp — enqueues repoFullName + installationId when present', () => {
  test('a delivery carrying repository + installation threads both onto EnqueueArgs', async () => {
    const ledger = new InMemoryAuditLedger();
    const queue = new InMemoryEventQueue();
    const app = buildApp({ webhookSecret: TEST_SECRET, auditLedger: ledger, eventQueue: queue });
    const body = JSON.stringify({
      action: 'labeled',
      repository: { full_name: 'example-org/software-factory' },
      installation: { id: 42 },
    });
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(queue.enqueuedMessages()).toEqual([
      {
        deliveryId: DELIVERY_ID,
        event: 'issues',
        payload: body,
        repoFullName: 'example-org/software-factory',
        installationId: 42,
      },
    ]);
  });

  // A record-bearing delivery sets sessionId to the record node
  // id so all of one record's deliveries serialize (FIFO) in the validator,
  // preventing the auto-advance creation race.
  test('a delivery carrying an issue node_id threads sessionId onto EnqueueArgs', async () => {
    const ledger = new InMemoryAuditLedger();
    const queue = new InMemoryEventQueue();
    const app = buildApp({ webhookSecret: TEST_SECRET, auditLedger: ledger, eventQueue: queue });
    const body = JSON.stringify({ action: 'labeled', issue: { node_id: 'I_spec_42' } });
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': DELIVERY_ID,
          'X-GitHub-Event': 'issues',
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(queue.enqueuedMessages()).toEqual([
      { deliveryId: DELIVERY_ID, event: 'issues', payload: body, sessionId: 'I_spec_42' },
    ]);
  });
});

describe('buildApp — POST /webhook noise drop', () => {
  test('subscribed noise event (push) → 202 acknowledged + dropped: no ledger row, no enqueue', async () => {
    const ledger = new InMemoryAuditLedger();
    const queue = new InMemoryEventQueue();
    const app = buildApp({ webhookSecret: TEST_SECRET, auditLedger: ledger, eventQueue: queue });
    const body = '{}';
    const response = await app.fetch(
      makeRequest({
        body,
        headers: {
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': 'noise-delivery-1',
          'X-GitHub-Event': 'push',
        },
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      dropped: 'noise_event',
    });
    expect(ledger.size()).toBe(0);
    expect(queue.enqueuedMessages()).toHaveLength(0);
  });

  test('noise event with a BAD signature is still rejected 401 (verification precedes the drop)', async () => {
    const app = buildApp({ webhookSecret: TEST_SECRET });
    const response = await app.fetch(
      makeRequest({
        body: '{}',
        headers: {
          'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
          'X-GitHub-Delivery': 'noise-delivery-2',
          'X-GitHub-Event': 'push',
        },
      }),
    );
    expect(response.status).toBe(401);
  });
});
