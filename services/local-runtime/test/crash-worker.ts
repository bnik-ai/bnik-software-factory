// Invoked only by runtime/test.py against its disposable PostgreSQL container.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { computeRowHash } from '../../validator/src/auditLedger.js';
import { PostgresQueue } from '../src/queue.js';
import type { Checkpoint } from '../src/runtime.js';
import { initialize, reset, runtime, send } from './helpers.js';

if (process.env.FACTORY_TEST_FAULT_INJECTION !== '1')
  throw new Error('explicit_test_mode_required');
const { admin, pool } = await initialize();
const phase = process.argv[2];
const point = process.argv[3] as Checkpoint | undefined;
const local = runtime(pool, async (current) => {
  if (point === current) {
    process.stdout.write(`${JSON.stringify({ event: 'crash_checkpoint', point })}\n`);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
});
try {
  if (phase === 'setup') {
    await reset(admin);
    assert.equal((await send(pool)).status, 200);
  } else if (phase === 'validator') await local.validatorStep();
  else if (phase === 'orchestrator') await local.orchestratorStep();
  else if (phase === 'worker') await local.demoWorkerStep('BuildAgent');
  else if (phase === 'recover') {
    for (let attempt = 0; attempt < 5; attempt++) {
      await local.validatorStep();
      await local.orchestratorStep();
      await local.demoWorkerStep('BuildAgent');
      if (
        (await pool.query("SELECT count(*) FROM factory_work WHERE state!='done'")).rows[0]
          .count === '0'
      )
        break;
      await delay(1100);
    }
    assert.equal(
      (await pool.query('SELECT count(*) FROM factory_demo_effects')).rows[0].count,
      '1',
    );
    assert.equal((await pool.query('SELECT count(*) FROM audit_ledger')).rows[0].count, '1');
    assert.equal(
      (await pool.query("SELECT count(*) FROM factory_work WHERE state='done'")).rows[0].count,
      '3',
    );
    const row = (await pool.query('SELECT * FROM audit_ledger')).rows[0];
    assert.deepEqual(
      row.this_hash,
      computeRowHash({
        seq: Number(row.seq),
        prevHash: Buffer.alloc(32),
        payloadHash: row.payload_hash,
      }),
    );
  } else if (phase === 'seed-restart') {
    const q = new PostgresQueue(pool, 'restart', {
      leaseMs: 1000,
      retryMs: 10_000,
    });
    await q.enqueue('retry', 'a', { fixture: true });
    await q.enqueue('dead', 'b', { fixture: true });
    await q.enqueue('running', 'c', { fixture: true });
    await q.enqueue('pending', 'd', { fixture: true });
    const retry = await q.claim();
    assert.ok(retry);
    await q.retry(retry.lease_token, 'saved_retry');
    const dead = await q.claim();
    assert.ok(dead);
    assert.equal(dead.delivery_key, 'dead');
    await q.deadletter(dead.lease_token, 'saved_deadletter');
    const active = await q.claim();
    assert.ok(active);
    await admin.query('CREATE TABLE IF NOT EXISTS restart_fixture(token text)');
    await admin.query('DELETE FROM restart_fixture');
    await admin.query('INSERT INTO restart_fixture(token) VALUES($1)', [active.lease_token]);
  } else if (phase === 'verify-restart') {
    const rows = (
      await pool.query(
        "SELECT delivery_key,state,attempts,last_error FROM factory_work WHERE queue_name='restart' ORDER BY id",
      )
    ).rows;
    assert.equal(rows.length, 4);
    assert.equal(rows.find((r) => r.delivery_key === 'dead')?.last_error, 'saved_deadletter');
    assert.deepEqual(
      rows.map(({ delivery_key, state, attempts, last_error }) => ({
        delivery_key,
        state,
        attempts,
        last_error,
      })),
      [
        { delivery_key: 'retry', state: 'pending', attempts: 1, last_error: 'saved_retry' },
        { delivery_key: 'dead', state: 'dead', attempts: 1, last_error: 'saved_deadletter' },
        { delivery_key: 'running', state: 'running', attempts: 1, last_error: null },
        { delivery_key: 'pending', state: 'pending', attempts: 0, last_error: null },
      ],
    );
    const audit = (await pool.query('SELECT * FROM audit_ledger')).rows[0];
    assert.deepEqual(
      audit.this_hash,
      computeRowHash({
        seq: Number(audit.seq),
        prevHash: Buffer.alloc(32),
        payloadHash: audit.payload_hash,
      }),
    );
    assert.equal((await pool.query('SELECT count(*) FROM audit_ledger')).rows[0].count, '1');
    assert.equal(
      (await pool.query('SELECT count(*) FROM factory_demo_effects')).rows[0].count,
      '1',
    );
    const token = (await admin.query('SELECT token FROM restart_fixture')).rows[0].token;
    await assert.rejects(new PostgresQueue(pool, 'restart').ack(token), /work_lease_lost/);
  } else throw new Error('unknown_test_phase');
  console.log(JSON.stringify({ event: 'phase_passed', phase }));
} finally {
  await local.close();
  await pool.end();
  await admin.end();
}
