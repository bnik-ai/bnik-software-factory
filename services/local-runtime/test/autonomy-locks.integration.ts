import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { lockRows, taskLockKey } from '../src/autonomy/controller.js';
import { config, controllerPassword, initialize } from './helpers.js';

let admin: Pool;
let runtimePool: Pool;
let short: Pool;

before(async () => {
  ({ admin, pool: runtimePool } = await initialize());
  // database.ts gives every session a 15 s idle-in-transaction timeout; a one-second copy makes the
  // live-lane finding (a real author outlives the timeout while the lock transaction idles) fast.
  short = new Pool({
    ...config().database,
    user: 'factory_controller',
    password: controllerPassword(),
    application_name: 'software-factory-test',
    idle_in_transaction_session_timeout: 1_000,
  });
  short.on('error', () => undefined);
  short.on('connect', (client) => client.on('error', () => undefined));
});
after(async () => {
  await short.end();
  await runtimePool.end();
  await admin.end();
});

test('a lock held across the idle-in-transaction timeout is still held by a live session', async () => {
  const locks = [
    { key: taskLockKey(1, 77), mode: 'UPDATE' as const, refused: 'task_run_in_progress' },
  ];
  const holder = await short.connect();
  await lockRows(holder, 1, locks);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const other = await short.connect();
  try {
    await assert.rejects(
      lockRows(other, 1, locks),
      (error: unknown) => (error as { reason?: string }).reason === 'task_run_in_progress',
    );
    assert.equal((await holder.query('SELECT 1 AS ok')).rows[0].ok, 1);
  } finally {
    await other.query('ROLLBACK').catch(() => undefined);
    other.release();
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
});
