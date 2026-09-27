import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { secret } from '../src/config.js';
import { createLocalPool } from '../src/database.js';
import { GitHubFailure } from '../src/github/client.js';
import { GitHubIntake } from '../src/github/intake.js';
import { HumanMergeGate } from '../src/github/reconcile.js';
import { checkSchema, migrate, migrationFiles } from '../src/migrate.js';
import { PostgresQueue } from '../src/queue.js';
import { Recovery, type RecoveryRequest } from '../src/recovery.js';
import { CodingSupervisor } from '../src/worker/supervisor.js';
import { FixtureGitHub, liveConfig } from './github-fixtures.js';
import { config, initialize, reset } from './helpers.js';
import { MergeFixture, head } from './merge-fixtures.js';
import { fixture } from './worker-fixtures.js';
let admin: Pool;
let pool: Pool;
let recovery: Recovery;
before(async () => {
  ({ admin, pool } = await initialize());
  recovery = new Recovery(pool);
});
beforeEach(async () => {
  await reset(admin);
  await admin.query(
    'TRUNCATE factory_task_activations,factory_pr_pairs,factory_pr_observations,factory_merge_receipts,factory_pr_state,factory_dependency_state',
  );
});
after(async () => {
  await pool?.end();
  await admin?.end();
});
function request(
  workId: string,
  action: 'replay' | 'quarantine' = 'replay',
  version = 0,
): RecoveryRequest {
  return {
    workId,
    action,
    version,
    requestId: randomUUID(),
    reason: 'cause_resolved',
  };
}
async function failed(queueName = 'GitHubIntake', body: unknown = { synthetic: true }) {
  const queue = new PostgresQueue(pool, queueName, { maxAttempts: 1 });
  const id = await queue.enqueue(randomUUID(), 'example/factory-demo', body);
  const work = await queue.claim();
  assert.ok(work);
  await queue.deadletter(work.lease_token, 'github_connection_failed');
  return { queue, id };
}
test('same recovery UUID is atomic, idempotent and keeps the original work identity and payload', async () => {
  const { queue, id } = await failed();
  const input = request(id);
  const [a, b] = await Promise.all([recovery.act(input), recovery.act(input)]);
  assert.equal(Number(a.cached) + Number(b.cached), 1);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM factory_recovery_actions')).rows[0].n,
    1,
  );
  const next = await queue.claim();
  assert.ok(next);
  assert.equal(next.id, id);
  assert.equal(next.attempts, 2);
  await queue.complete(next.lease_token, { done: true });
  assert.equal((await recovery.act(input)).cached, true);
  await assert.rejects(recovery.act({ ...input, reason: 'different_reason' }), /request_conflict/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_work')).rows[0].n, 1);
  assert.equal((await recovery.inspect(id)).work[0]?.state, 'completed');
});
test('recovery receipt failure rolls back replay; retry after lost acknowledgement reuses committed receipt', async () => {
  const { id } = await failed();
  const input = request(id);
  await admin.query(
    "CREATE FUNCTION fail_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$",
  );
  await admin.query(
    'CREATE TRIGGER fail_recovery BEFORE INSERT ON factory_recovery_actions FOR EACH ROW EXECUTE FUNCTION fail_recovery()',
  );
  try {
    await assert.rejects(recovery.act(input), /injected/);
    assert.equal((await recovery.inspect(id)).work[0]?.state, 'failed');
  } finally {
    await admin.query('DROP TRIGGER fail_recovery ON factory_recovery_actions');
    await admin.query('DROP FUNCTION fail_recovery()');
  }
  await recovery.act(input); // Simulate a lost response after COMMIT.
  const fresh = new Recovery(pool);
  assert.equal((await fresh.act(input)).cached, true);
  assert.equal((await fresh.inspect(id)).work[0]?.maxAttempts, 2);
});
test('quarantine blocks redelivery and claim, rejects stale versions and preserves the failure history', async () => {
  const { queue, id } = await failed();
  await recovery.act(request(id, 'quarantine'));
  assert.equal(await queue.claim(), undefined);
  const row = (await pool.query('SELECT * FROM factory_work WHERE id=$1', [id])).rows[0];
  assert.equal(await queue.enqueue(row.delivery_key, row.record_key, row.body), id);
  assert.equal(await queue.claim(), undefined);
  await assert.rejects(recovery.act(request(id)), /version_changed/);
  await recovery.act(request(id, 'replay', 1));
  const view = await recovery.inspect(id);
  assert.equal(view.work[0]?.state, 'queued');
  assert.equal(view.actions.length, 2);
  assert.equal(view.actions[1].before_state.reason, 'github_connection_failed');
  assert.ok(view.actions.every((a) => a.principal === 'factory_runtime'));
  for (const sql of [
    "UPDATE factory_recovery_actions SET reason='changed'",
    'DELETE FROM factory_recovery_actions',
  ])
    await assert.rejects(pool.query(sql), /permission denied/);
});
test('active work, sibling work, completed work and lifetime attempt cap cannot be bypassed', async () => {
  const { queue, id } = await failed();
  const sibling = await queue.enqueue(randomUUID(), 'example/factory-demo', {});
  await assert.rejects(recovery.act(request(id)), /record_has_active_work/);
  const active = await queue.claim();
  assert.ok(active);
  assert.equal(active.id, sibling);
  await assert.rejects(recovery.act(request(sibling, 'quarantine')), /active_or_completed/);
  await queue.complete(active.lease_token);
  await assert.rejects(recovery.act(request(sibling)), /active_or_completed/);
  await admin.query('UPDATE factory_work SET attempts=100,max_attempts=100 WHERE id=$1', [id]);
  await assert.rejects(recovery.act(request(id)), /lifetime_attempt_limit/);
});
test('inspection never emits queued secrets or raw outcomes and reports awaiting-human separately', async () => {
  const { id } = await failed('GitHubIntake', {
    secret: 'sensitive-fixture-value',
  });
  await admin.query('UPDATE factory_work SET last_error=$2,result=$3 WHERE id=$1', [
    id,
    'secret unsafe error',
    JSON.stringify({ token: 'hidden-result-value' }),
  ]);
  const g = new MergeFixture();
  const gate = new HumanMergeGate(pool, g.config, g);
  try {
    await gate.track(1, 2, head);
    await gate.step();
    const view = await recovery.inspect(id);
    assert.equal(view.work[0]?.reason, 'unclassified_failure');
    assert.equal(view.reviews[0]?.state, 'awaiting-human');
    const text = JSON.stringify(view);
    for (const value of ['sensitive-fixture-value', 'hidden-result-value', 'secret unsafe error'])
      assert.ok(!text.includes(value));
  } finally {
    await gate.close();
  }
});
test('transient GitHub failure exhausts a bound, then authenticated replay reuses the delivery and current authorization', async () => {
  const cfg = liveConfig();
  cfg.queue.maxAttempts = 1;
  const github = new FixtureGitHub();
  const read = github.read.bind(github);
  let fail = true;
  github.read = async (path) => {
    if (fail) throw new GitHubFailure('github_connection_failed', true);
    return read(path);
  };
  const intake = new GitHubIntake(pool, cfg, github);
  const delivery = randomUUID();
  try {
    await intake.accept(delivery, 'issue_comment', JSON.stringify(github.current));
    await intake.step();
    const row = (await pool.query('SELECT id,state FROM factory_work')).rows[0];
    assert.equal(row.state, 'dead');
    fail = false;
    await recovery.act(request(row.id));
    await intake.step();
    await intake.accept(delivery, 'issue_comment', JSON.stringify(github.current));
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM factory_task_activations')).rows[0].n,
      1,
    );
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_work')).rows[0].n, 1);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM factory_worker_runs')).rows[0].n,
      0,
    );
  } finally {
    await intake.close();
  }
});
test('replayed intake cannot revive revoked human permission', async () => {
  const cfg = liveConfig();
  cfg.queue.maxAttempts = 1;
  const github = new FixtureGitHub();
  github.permission = 'read';
  const intake = new GitHubIntake(pool, cfg, github);
  try {
    await intake.accept(randomUUID(), 'issue_comment', JSON.stringify(github.current));
    await intake.step();
    const row = (await pool.query('SELECT id FROM factory_work')).rows[0];
    await recovery.act(request(row.id));
    await intake.step();
    assert.equal((await recovery.inspect(row.id)).work[0]?.state, 'failed');
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM factory_task_activations')).rows[0].n,
      0,
    );
  } finally {
    await intake.close();
  }
});
test('failed model call and repeated job submission never trigger an automatic paid retry', async () => {
  let invoked = 0;
  const archive = Buffer.from('synthetic source');
  const job = fixture(archive, {
    mode: 'live',
    fixtureCommand: undefined,
    model: 'claude-fixture',
  });
  const supervisor = new CodingSupervisor({
    pool,
    repository: job.repository,
    mode: 'live',
    image: 'unused',
    signal: new AbortController().signal,
    authorize: async () => {},
    execute: async () => {
      invoked++;
      return {
        outcome: {
          version: 1,
          ok: false,
          reason: 'coding_failed',
          sourceCommit: job.sourceCommit,
          archiveSha256: job.archiveSha256,
          patch: '',
          patchSha256: '0'.repeat(64),
          testsStatus: 'not_run',
          tests: [],
          model: {
            mode: 'live',
            subtype: 'model_execution_failed',
            turns: null,
            costUsd: null,
          },
          summary: 'Synthetic provider timeout',
        },
        imageId: 'synthetic',
      };
    },
  });
  const id = await supervisor.submit(job);
  await supervisor.run(job.id, archive);
  assert.equal(await supervisor.submit(job), id);
  await assert.rejects(supervisor.run(job.id, archive), /not_claimable/);
  await assert.rejects(recovery.act(request(id)), /fresh_activation_required/);
  assert.equal(invoked, 1);
  assert.equal(
    (await recovery.inspect(id)).work[0]?.nextAction,
    'inspect_worker_status_recover_cleanup_then_fresh_human_activation',
  );
});
function cli(args: string[], password = config().database.password) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      POSTGRES_USER: 'factory_runtime',
      POSTGRES_PASSWORD: password,
    };
    env.POSTGRES_PASSWORD_FILE = undefined;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/recovery-cli.ts', ...args], {
      env,
    });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
    });
    child.stderr.on('data', (d) => {
      output += d;
    });
    child.on('exit', (code) => resolve({ code, output }));
  });
}
test('real CLI rejects incorrect database authentication and performs inspect/replay with the runtime identity', async () => {
  const { id } = await failed();
  const denied = await cli(['inspect', id], 'intentionally-wrong-password');
  assert.equal(denied.code, 1);
  assert.ok(!denied.output.includes('intentionally-wrong-password'));
  assert.equal((await recovery.inspect(id)).work[0]?.state, 'failed');
  const inspected = await cli(['inspect', id]);
  assert.equal(inspected.code, 0);
  assert.equal(JSON.parse(inspected.output).principal, 'factory_runtime');
  const input = request(id);
  const applied = await cli(['replay', id, '0', input.requestId, input.reason]);
  assert.equal(applied.code, 0);
  assert.equal(JSON.parse(applied.output).outcome.state, 'queued');
});

test('restart after Task side effect before queue ACK reconciles the same PR and immutable receipt', async () => {
  const github = new MergeFixture();
  const first = new HumanMergeGate(pool, github.config, github);
  let restarted: HumanMergeGate | undefined;
  try {
    await first.track(1, 2, head);
    await first.step();
    github.merge();
    const id = await first.queue.enqueue(randomUUID(), 'example/factory-demo', {
      pull: 2,
      repositoryId: 42,
      installationId: 7,
    });
    first.queue.complete = async () => {
      throw new Error('injected_before_ack');
    };
    await assert.rejects(first.step(), /injected_before_ack/);
    assert.equal(github.task.state, 'closed');
    assert.equal((await recovery.inspect(id)).work[0]?.state, 'running');
    await first.close();
    // Advance the abandoned lease in the fixture instead of a wall-clock sleep.
    await admin.query(
      "UPDATE factory_work SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id],
    );
    restarted = new HumanMergeGate(pool, github.config, github);
    await restarted.step();
    assert.equal((await recovery.inspect(id)).work[0]?.state, 'completed');
    assert.equal((await recovery.inspect(id)).work[0]?.attempts, 2);
    assert.equal((await restarted.status())[0].state, 'reconciled');
    assert.deepEqual(github.task.labels.map((l) => l.name).sort(), ['kind:task', 'status:done']);
    for (const table of ['factory_pr_pairs', 'factory_merge_receipts'])
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_work')).rows[0].n, 2);
    assert.equal(github.pull.number, 2);
  } finally {
    await first.close();
    await restarted?.close();
  }
});

test('upgrade from previous schema retains failed work identity, payload and attempts', async () => {
  const database = `upgrade_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const upgrade = createLocalPool({
    ...config().database,
    database,
    user: process.env.POSTGRES_USER ?? '',
    password: secret(process.env, 'POSTGRES_PASSWORD'),
  });
  try {
    await upgrade.query(
      'CREATE TABLE factory_schema_migrations(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
    );
    for (const file of migrationFiles().slice(0, -1)) {
      await upgrade.query(file.sql);
      await upgrade.query('INSERT INTO factory_schema_migrations(version,sha256) VALUES($1,$2)', [
        file.version,
        file.sha256,
      ]);
    }
    const queue = new PostgresQueue(upgrade, 'GitHubIntake', { maxAttempts: 1 });
    const id = await queue.enqueue('unchanged-delivery', 'example/factory-demo', {
      synthetic: true,
    });
    const work = await queue.claim();
    assert.ok(work);
    await queue.deadletter(work.lease_token, 'github_connection_failed');
    const before = (await upgrade.query('SELECT * FROM factory_work WHERE id=$1', [id])).rows[0];
    await migrate(upgrade, config().database.password);
    await checkSchema(upgrade);
    const after = (await upgrade.query('SELECT * FROM factory_work WHERE id=$1', [id])).rows[0];
    assert.deepEqual(after, { ...before, recovery_version: 0 });
    await new Recovery(upgrade).act(request(id));
    assert.equal((await queue.claim())?.id, id);
  } finally {
    await upgrade.end();
    await admin.query(`DROP DATABASE ${database}`);
  }
});
