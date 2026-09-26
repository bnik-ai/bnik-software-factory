import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { computeRowHash } from '../../validator/src/auditLedger.js';
import { AGENT_ROLES, PostgresAgentDispatcher, PostgresAgentRunConsumer } from '../src/adapters.js';
import { createLocalPool } from '../src/database.js';
import { LeaseGuard } from '../src/lease.js';
import { checkSchema, migrate } from '../src/migrate.js';
import { DeliveryConflictError, LeaseLostError, PostgresQueue } from '../src/queue.js';
import { LocalRuntime } from '../src/runtime.js';
import { runtimeDependencies } from '../src/substrate.js';
import { config, initialize, payload, reset, runtime, send } from './helpers.js';

let admin: Pool;
let pool: Pool;
before(async () => {
  ({ admin, pool } = await initialize());
});
beforeEach(async () => {
  await reset(admin);
});
after(async () => {
  await pool?.end();
  await admin?.end();
});
const queue = (name = 'contract', options = {}) =>
  new PostgresQueue(pool, name, {
    leaseMs: 1500,
    maxAttempts: 3,
    retryMs: 20,
    maxRetryMs: 40,
    ...options,
  });

async function chainIsValid() {
  const rows = (await pool.query('SELECT * FROM audit_ledger ORDER BY seq')).rows;
  let previous = Buffer.alloc(32);
  for (const row of rows) {
    assert.deepEqual(row.prev_hash, previous);
    assert.deepEqual(
      row.this_hash,
      computeRowHash({
        seq: Number(row.seq),
        prevHash: previous,
        payloadHash: row.payload_hash,
      }),
    );
    previous = row.this_hash;
  }
}

test('identical enqueue deduplicates and a conflicting delivery is visible', async () => {
  const q = queue();
  const id = await q.enqueue('delivery', 'record', { b: 2, a: 1 });
  assert.equal(await q.enqueue('delivery', 'record', { a: 1, b: 2 }), id);
  await assert.rejects(q.enqueue('delivery', 'record', { a: 2 }), DeliveryConflictError);
  await assert.rejects(
    q.enqueue('delivery', 'other-record', { a: 1, b: 2 }),
    DeliveryConflictError,
  );
  assert.equal((await pool.query('SELECT count(*) FROM factory_work')).rows[0].count, '1');
});
test('concurrent claims isolate records and preserve FIFO within each queue', async () => {
  const q = queue();
  await q.enqueue('a1', 'a', {});
  await q.enqueue('a2', 'a', {});
  await q.enqueue('b1', 'b', {});
  const claimed = (await Promise.all(Array.from({ length: 6 }, () => q.claim()))).filter(
    (job) => job !== undefined,
  );
  assert.deepEqual(claimed.map((job) => job.delivery_key).sort(), ['a1', 'b1']);
  for (const job of claimed) await q.ack(job.lease_token);
  assert.equal((await q.claim())?.delivery_key, 'a2');
});
test('delayed retries block only their own record and terminate at the attempt limit', async () => {
  const q = queue();
  await q.enqueue('a1', 'a', {});
  await q.enqueue('a2', 'a', {});
  await q.enqueue('b1', 'b', {});
  const first = await q.claim();
  assert.ok(first);
  await q.retry(first.lease_token, 'transient');
  const unrelated = await q.claim();
  assert.equal(unrelated?.delivery_key, 'b1');
  assert.ok(unrelated);
  await q.ack(unrelated.lease_token);
  assert.equal(await q.claim(), undefined);
  for (let attempt = 2; attempt <= 3; attempt++) {
    await delay(55);
    const retry = await q.claim();
    assert.equal(retry?.attempts, attempt);
    assert.ok(retry);
    await q.retry(retry.lease_token, 'transient');
  }
  assert.equal(
    (await pool.query("SELECT state FROM factory_work WHERE delivery_key='a1'")).rows[0].state,
    'dead',
  );
  assert.equal((await q.claim())?.delivery_key, 'a2');
});
test('expired leases get bounded attempts, stale ACK and effects are rejected', async () => {
  const q = queue('expiry', { leaseMs: 150 });
  await q.enqueue('first', 'record', {});
  await q.enqueue('next', 'record', {});
  const original = await q.claim();
  assert.ok(original);
  await delay(200);
  const current = await q.claim();
  assert.equal(current?.attempts, 2);
  assert.ok(current);
  await assert.rejects(q.ack(original.lease_token), LeaseLostError);
  await assert.rejects(q.renew(original.lease_token), LeaseLostError);
  await assert.rejects(
    q.complete(original.lease_token, null, async (client) => {
      await client.query('DELETE FROM factory_work');
    }),
    LeaseLostError,
  );
  await delay(200);
  assert.equal((await q.claim())?.attempts, 3);
  await delay(200);
  assert.equal((await q.claim())?.delivery_key, 'next');
  assert.equal(
    (await pool.query("SELECT last_error FROM factory_work WHERE delivery_key='first'")).rows[0]
      .last_error,
    'lease_attempts_exhausted',
  );
});
test('renewal keeps a long-running claim owned and release recovers after expiry', async () => {
  const q = queue('renewal', { leaseMs: 300 });
  await q.enqueue('work', 'record', {});
  const job = await q.claim();
  assert.ok(job);
  const guard = new LeaseGuard(q, job.lease_token);
  try {
    await delay(1100);
    assert.equal(await q.claim(), undefined);
    assert.equal(guard.signal.aborted, false);
  } finally {
    await guard.stop();
  }
  await delay(400);
  const retry = await q.claim();
  assert.equal(retry?.attempts, 2);
  await assert.rejects(q.ack(job.lease_token), LeaseLostError);
});
test('lease expiry during commit rolls back the database effect and settlement', async () => {
  const q = queue('commit-expiry', { leaseMs: 150 });
  await q.enqueue('work', 'record', {});
  const job = await q.claim();
  assert.ok(job);
  await assert.rejects(
    q.complete(job.lease_token, {}, async (client) => {
      await client.query(
        "INSERT INTO factory_demo_effects(work_id,agent,result) VALUES($1,'BuildAgent','fixture')",
        [job.id],
      );
      await delay(200);
    }),
    LeaseLostError,
  );
  assert.equal((await pool.query('SELECT count(*) FROM factory_demo_effects')).rows[0].count, '0');
  assert.equal((await pool.query('SELECT state FROM factory_work')).rows[0].state, 'running');
});
test('lost renewal cancels the handler signal', async () => {
  const q = queue('cancel', { leaseMs: 300 });
  await q.enqueue('work', 'record', {});
  const job = await q.claim();
  assert.ok(job);
  const guard = new LeaseGuard(q, job.lease_token);
  try {
    await admin.query(
      "UPDATE factory_work SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    await delay(180);
    assert.equal(guard.signal.aborted, true);
  } finally {
    await guard.stop();
  }
});
test('signed intake commits receipt and work together; duplicates compare payloads', async () => {
  const id = 'fixed-delivery';
  assert.equal((await send(pool, payload(), id)).status, 200);
  assert.equal(
    (
      (await (await send(pool, payload(), id)).json()) as {
        idempotent: boolean;
      }
    ).idempotent,
    true,
  );
  assert.equal((await send(pool, payload('different-record'), id)).status, 409);
  assert.equal((await send(pool, payload(), 'bad-signature', false)).status, 401);
  assert.equal(
    (
      await send(pool, {
        ...payload(),
        repository: { full_name: 'unconfigured/repository' },
      })
    ).status,
    403,
  );
  assert.equal((await send(pool, { ...payload(), installation: { id: 9 } })).status, 403);
  assert.equal((await pool.query('SELECT count(*) FROM webhook_deliveries')).rows[0].count, '1');
  assert.equal((await pool.query('SELECT count(*) FROM factory_work')).rows[0].count, '1');
});
test('failed receipt insertion rolls back intake work and permits a clean redelivery', async () => {
  await admin.query('REVOKE INSERT ON webhook_deliveries FROM factory_runtime');
  try {
    assert.equal((await send(pool, payload(), 'intake-retry')).status, 503);
    assert.equal((await pool.query('SELECT count(*) FROM factory_work')).rows[0].count, '0');
    assert.equal((await pool.query('SELECT count(*) FROM webhook_deliveries')).rows[0].count, '0');
  } finally {
    await admin.query('GRANT INSERT ON webhook_deliveries TO factory_runtime');
  }
  assert.equal((await send(pool, payload(), 'intake-retry')).status, 200);
});
test('audit insertion and outbox publication roll back together on a crash-like failure', async () => {
  assert.equal((await send(pool)).status, 200);
  const broken = runtime(pool, async (point) => {
    if (point === 'audit-inserted') throw new Error('injected');
  });
  try {
    await assert.rejects(broken.validatorStep(), /injected/);
  } finally {
    await broken.close();
  }
  assert.equal((await pool.query('SELECT count(*) FROM audit_ledger')).rows[0].count, '0');
  assert.equal(
    (await pool.query("SELECT count(*) FROM factory_work WHERE queue_name='orchestrator'")).rows[0]
      .count,
    '0',
  );
  await delay(30);
  const recovered = runtime(pool);
  try {
    assert.equal(await recovered.validatorStep(), true);
  } finally {
    await recovered.close();
  }
  assert.equal((await pool.query('SELECT count(*) FROM audit_ledger')).rows[0].count, '1');
  assert.equal(
    (await pool.query("SELECT count(*) FROM factory_work WHERE queue_name='orchestrator'")).rows[0]
      .count,
    '1',
  );
  await chainIsValid();
});
test('committed verdict cannot be reevaluated against a changed remote state', async () => {
  await send(pool, payload('I_FLAGGED', true));
  const first = runtime(pool, async (point) => {
    if (point === 'validator-committed') throw new Error('lost_commit_response');
  });
  try {
    await assert.rejects(first.validatorStep());
  } finally {
    await first.close();
  }
  assert.equal((await pool.query('SELECT verdict FROM audit_ledger')).rows[0].verdict, 'flag');
  const settings = config();
  const dependencies = runtimeDependencies(settings);
  const later = new LocalRuntime(pool, settings, {
    ...dependencies,
    validatorSubstrate: () => {
      throw new Error('must_not_read_remote_again');
    },
  });
  try {
    assert.equal(await later.validatorStep(), false);
    assert.equal(await later.orchestratorStep(), true);
  } finally {
    await later.close();
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM factory_work WHERE queue_name NOT IN ('validator','orchestrator')",
      )
    ).rows[0].count,
    '0',
  );
});
test('accepted transition passes existing FSM/router into one durable demo effect', async () => {
  await send(pool);
  const local = runtime(pool);
  try {
    assert.equal(await local.validatorStep(), true);
    assert.equal(await local.orchestratorStep(), true);
    assert.equal(await local.demoWorkerStep('BuildAgent'), true);
    assert.equal(await local.validatorStep(), false);
    assert.equal(await local.orchestratorStep(), false);
    assert.equal(await local.demoWorkerStep('BuildAgent'), false);
  } finally {
    await local.close();
  }
  assert.equal((await pool.query('SELECT verdict FROM audit_ledger')).rows[0].verdict, 'accept');
  assert.equal((await pool.query('SELECT count(*) FROM factory_demo_effects')).rows[0].count, '1');
  assert.deepEqual((await pool.query('SELECT DISTINCT state FROM factory_work')).rows, [
    { state: 'done' },
  ]);
  await chainIsValid();
});
test('multiple validators append a valid serial audit chain for independent records', async () => {
  await send(pool, payload('record-a'));
  await send(pool, payload('record-b'));
  const a = runtime(pool);
  const b = runtime(pool);
  try {
    assert.deepEqual(await Promise.all([a.validatorStep(), b.validatorStep()]), [true, true]);
  } finally {
    await a.close();
    await b.close();
  }
  assert.equal((await pool.query('SELECT count(*) FROM audit_ledger')).rows[0].count, '2');
  await chainIsValid();
});
test('malformed input is dead-lettered without swallowing a later valid record', async () => {
  const local = runtime(pool);
  await local.validator.queue.enqueue('malformed', 'record', {
    deliveryId: 'malformed',
    event: 'issues',
    payload: '{',
  });
  await send(pool);
  try {
    assert.equal(await local.validatorStep(), false);
    assert.equal(await local.validatorStep(), true);
  } finally {
    await local.close();
  }
  assert.equal(
    (await pool.query("SELECT state,last_error FROM factory_work WHERE delivery_key='malformed'"))
      .rows[0].last_error,
    'payload_not_json',
  );
});
test('dispatch and consume preserve verdict, repository and review-resync intent', async () => {
  const dispatcher = new PostgresAgentDispatcher(pool);
  const request = {
    agent: 'BuildAgent' as const,
    transitionKey: 'pr:open→needs_sync_for_review',
    message: {
      lockToken: 'first-token',
      deliveryId: 'wire',
      eventType: 'pull_request',
      kind: 'pr' as const,
      actor: 'ReviewAgent' as const,
      recordType: 'PullRequest',
      recordId: 'PR_WIRE',
      fromState: 'open',
      toState: 'needs_sync_for_review',
      payloadHash: Buffer.alloc(32),
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      verdict: 'accept' as const,
      repoFullName: 'example/factory-demo',
      installationId: 1,
      headBranch: 'topic',
      baseBranch: 'main',
      reReviewMode: 'bounce' as const,
    },
  };
  const first = await dispatcher.dispatch(request);
  const second = await dispatcher.dispatch({
    ...request,
    message: { ...request.message, lockToken: 'new-token' },
  });
  assert.deepEqual(first, second);
  const consumer = new PostgresAgentRunConsumer(queue('BuildAgent'), 'BuildAgent');
  try {
    const [message] = await consumer.receive({ maxMessages: 10 });
    assert.ok(message);
    assert.equal(message.message.reReviewMode, 'bounce');
    assert.equal(message.message.repoFullName, 'example/factory-demo');
    assert.equal(message.message.installationId, 1);
    assert.equal(message.message.verdict, 'accept');
    await consumer.ack(message.lockToken);
  } finally {
    await consumer.close();
  }
});
test('retention removes completed payloads but preserves deduplication and dead-letter evidence', async () => {
  const q = queue();
  await q.enqueue('done', 'a', { retained: 'hash-only' });
  await q.enqueue('dead', 'b', { retained: 'triage' });
  const a = await q.claim();
  assert.ok(a);
  await q.ack(a.lease_token);
  const b = await q.claim();
  assert.ok(b);
  await q.deadletter(b.lease_token, 'malformed');
  await admin.query("UPDATE factory_work SET settled_at=clock_timestamp()-interval '3 days'");
  assert.equal(await q.compactDone(1), 1);
  assert.ok(await q.enqueue('done', 'a', { retained: 'hash-only' }));
  await assert.rejects(q.enqueue('done', 'a', { replaced: true }), DeliveryConflictError);
  const rows = (await pool.query('SELECT delivery_key,body FROM factory_work ORDER BY id')).rows;
  assert.equal(rows[0].body, null);
  assert.deepEqual(rows[1].body, { retained: 'triage' });
});
test('runtime database role cannot alter schema, delete work, or rewrite the audit chain', async () => {
  await assert.rejects(
    pool.query('CREATE TABLE unauthorized_table(id integer)'),
    /permission denied/,
  );
  await assert.rejects(pool.query('DELETE FROM factory_work'), /permission denied/);
  await assert.rejects(pool.query("UPDATE audit_ledger SET verdict='accept'"), /permission denied/);
  const invalid = createLocalPool({
    ...config().database,
    password: 'synthetic-wrong-password',
  });
  try {
    await assert.rejects(invalid.query('SELECT 1'), /password authentication failed/);
  } finally {
    await invalid.end();
  }
});
test('migrations are repeatable and checksum drift prevents startup', async () => {
  await migrate(admin, config().database.password);
  await checkSchema(pool);
  const version = (
    await admin.query(
      "SELECT sha256 FROM factory_schema_migrations WHERE version='0002_durable_work'",
    )
  ).rows[0].sha256;
  try {
    await admin.query(
      "UPDATE factory_schema_migrations SET sha256='changed' WHERE version='0002_durable_work'",
    );
    await assert.rejects(checkSchema(pool), /schema_mismatch/);
    await assert.rejects(migrate(admin, config().database.password), /checksum_mismatch/);
  } finally {
    await admin.query(
      "UPDATE factory_schema_migrations SET sha256=$1 WHERE version='0002_durable_work'",
      [version],
    );
  }
});
test('live profile cannot call the demo worker even with valid queued work', async () => {
  const settings = { ...config(), mode: 'live' as const };
  const local = new LocalRuntime(pool, settings, runtimeDependencies(config()));
  try {
    for (const role of AGENT_ROLES)
      await assert.rejects(local.demoWorkerStep(role), /requires_demo_mode/);
  } finally {
    await local.close();
  }
});
