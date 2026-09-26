import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { approvedJob } from '../src/github/activation.js';
import { GitHubIntake, authorizeApprovedJob, loadActivation } from '../src/github/intake.js';
import { localApp } from '../src/main.js';
import { CodingSupervisor } from '../src/worker/supervisor.js';
import { FixtureGitHub, liveConfig } from './github-fixtures.js';
import { initialize, reset } from './helpers.js';
let admin: Pool;
let pool: Pool;
before(async () => {
  ({ admin, pool } = await initialize());
});
beforeEach(async () => {
  await reset(admin);
  await admin.query('TRUNCATE factory_task_activations');
});
after(async () => {
  await pool?.end();
  await admin?.end();
});
function fixture() {
  const config = liveConfig();
  const github = new FixtureGitHub();
  const intake = new GitHubIntake(pool, config, github);
  const send = (
    body: unknown = github.current,
    event = 'issue_comment',
    id: string = randomUUID(),
    valid = true,
  ) => {
    const raw = JSON.stringify(body);
    return localApp(pool, config, intake).request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'x-github-delivery': id,
        'x-github-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', config.webhookSecret)
          .update(valid ? raw : 'tampered')
          .digest('hex')}`,
      },
      body: raw,
    });
  };
  return { config, github, intake, send };
}
async function count(table: 'factory_task_activations' | 'factory_work') {
  return Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
}
test('live webhook validates raw HMAC and immutable scope before durably accepting even noise events', async () => {
  const { github, send, intake } = fixture();
  try {
    assert.equal((await send(github.current, 'issue_comment', randomUUID(), false)).status, 401);
    for (const changed of [
      { ...github.current, installation: { id: 9 } },
      { ...github.current, repository: { ...github.current.repository, id: 99 } },
      {
        ...github.current,
        repository: { ...github.current.repository, full_name: 'example/other' },
      },
    ]) {
      assert.equal((await send(changed)).status, 403);
      assert.equal((await send(changed, 'check_run')).status, 403);
    }
    assert.equal((await send(github.current, 'repository_dispatch')).status, 400);
    assert.equal(await count('factory_work'), 0);
    assert.equal((await send()).status, 202);
    assert.equal(await count('factory_work'), 1);
  } finally {
    await intake.close();
  }
});
test('public issue, label, comment and forged attribution events cannot enqueue coding or legacy role work', async () => {
  const { send, intake, github } = fixture();
  try {
    const outsider = { id: 77, login: 'outsider', type: 'User' };
    const bodies = [
      [github.current, 'issues'],
      [{ ...github.current, action: 'labeled', label: { name: 'status:ready' } }, 'issues'],
      [
        {
          ...github.current,
          sender: outsider,
          comment: { ...github.current.comment, user: outsider },
          author_association: 'OWNER',
        },
        'issue_comment',
      ],
      [
        {
          ...github.current,
          comment: {
            ...github.current.comment,
            body: '<!-- sf:structural sf:agent=planner@fixture -->',
          },
        },
        'issue_comment',
      ],
      [{ ...github.current, action: 'edited' }, 'issue_comment'],
    ] as const;
    for (const [body, event] of bodies) {
      assert.equal((await send(body, event)).status, 202);
      await intake.step();
    }
    assert.equal(await count('factory_task_activations'), 0);
    assert.deepEqual(
      (await pool.query('SELECT DISTINCT queue_name FROM factory_work')).rows.map(
        (row) => row.queue_name,
      ),
      ['GitHubIntake'],
    );
    assert.equal(github.reads.length, 0);
  } finally {
    await intake.close();
  }
});
test('authorization receipt and settlement are atomic and redelivered comments authorize only once', async () => {
  const { send, intake, github } = fixture();
  const id = randomUUID();
  try {
    assert.equal((await send(github.current, 'issue_comment', id)).status, 202);
    assert.equal((await send(github.current, 'issue_comment', id)).status, 202);
    assert.equal(
      (await send({ ...github.current, action: 'edited' }, 'issue_comment', id)).status,
      409,
    );
    await intake.step();
    assert.equal(await count('factory_task_activations'), 1);
    const first = (await pool.query('SELECT result FROM factory_work')).rows[0].result;
    assert.equal(first.decision, 'authorized_for_manual_execution');
    assert.ok(first.activationId);
    await send();
    await intake.step();
    assert.equal(await count('factory_task_activations'), 1);
    assert.ok(
      (await pool.query('SELECT state,result FROM factory_work')).rows.every(
        (r) => r.state === 'done' && r.result.activationId === first.activationId,
      ),
    );
    await assert.rejects(
      pool.query('UPDATE factory_task_activations SET actor_login=$1', ['changed']),
      /permission denied/,
    );
  } finally {
    await intake.close();
  }
});
test('receipt insertion failure rolls back authorization and ACK before safe bounded retry', async () => {
  const { send, intake } = fixture();
  try {
    await send();
    await admin.query(
      "CREATE FUNCTION reject_activation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$",
    );
    await admin.query(
      'CREATE TRIGGER reject_activation_fixture BEFORE INSERT ON factory_task_activations FOR EACH ROW EXECUTE FUNCTION reject_activation_fixture()',
    );
    await intake.step();
    assert.equal(await count('factory_task_activations'), 0);
    assert.equal((await pool.query('SELECT state FROM factory_work')).rows[0].state, 'pending');
    await admin.query('DROP TRIGGER reject_activation_fixture ON factory_task_activations');
    await admin.query('DROP FUNCTION reject_activation_fixture()');
    await admin.query('UPDATE factory_work SET available_at=clock_timestamp()');
    await intake.step();
    assert.equal(await count('factory_task_activations'), 1);
  } finally {
    await admin.query(
      'DROP TRIGGER IF EXISTS reject_activation_fixture ON factory_task_activations',
    );
    await admin.query('DROP FUNCTION IF EXISTS reject_activation_fixture()');
    await intake.close();
  }
});
test('Task changes after intake leave durable denial and no execution authorization', async () => {
  const { send, intake, github } = fixture();
  try {
    await send();
    github.current.issue.title = 'edited after command';
    await intake.step();
    assert.equal(await count('factory_task_activations'), 0);
    const row = (await pool.query('SELECT state,last_error FROM factory_work')).rows[0];
    assert.equal(row.state, 'dead');
    assert.equal(row.last_error, 'activation_task_changed');
  } finally {
    await intake.close();
  }
});
test('execution rechecks current permission and exact approved job before any Docker or model executor starts', async () => {
  const { send, intake, config, github } = fixture();
  let invoked = 0;
  try {
    await send();
    await intake.step();
    const id = (await pool.query('SELECT id FROM factory_task_activations')).rows[0].id;
    const proof = await loadActivation(pool, config, id);
    const job = approvedJob(config, id, proof, '0'.repeat(64));
    const manual = { ...config, execution: 'manual' as const };
    await authorizeApprovedJob(pool, manual, github, job);
    await assert.rejects(
      authorizeApprovedJob(pool, manual, github, { ...job, prompt: 'changed' }),
      /differs/,
    );
    await assert.rejects(authorizeApprovedJob(pool, config, github, job), /execution_disabled/);
    github.permission = 'read';
    const supervisor = new CodingSupervisor({
      pool,
      repository: config.repository,
      mode: 'live',
      image: 'unused',
      signal: new AbortController().signal,
      authorize: (value) => authorizeApprovedJob(pool, manual, github, value),
      execute: async () => {
        invoked++;
        throw new Error('must never execute');
      },
    });
    await supervisor.submit(job);
    await assert.rejects(
      supervisor.run(job.id, Buffer.from('fixture')),
      /worker_activation_denied/,
    );
    assert.equal(invoked, 0);
    assert.equal(
      (await pool.query("SELECT state FROM factory_work WHERE queue_name='CodingJob'")).rows[0]
        .state,
      'dead',
    );
    assert.equal(
      (await pool.query('SELECT reason FROM factory_worker_runs')).rows[0].reason,
      'worker_activation_denied',
    );
  } finally {
    await intake.close();
  }
});
test('signed App ping and installation notifications remain observable without task activation', async () => {
  const { send, intake } = fixture();
  try {
    assert.equal((await send({ zen: 'Synthetic liveness only.' }, 'ping')).status, 202);
    assert.equal(
      (await send({ installation: { id: 7 }, action: 'suspend' }, 'installation')).status,
      202,
    );
    await intake.step();
    await intake.step();
    assert.equal(await count('factory_task_activations'), 0);
    assert.ok(
      (await pool.query('SELECT result FROM factory_work')).rows.every(
        (row) => row.result.decision === 'observed_no_activation',
      ),
    );
  } finally {
    await intake.close();
  }
});
