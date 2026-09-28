import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { HumanMergeGate } from '../src/github/reconcile.js';
import { initialize, reset } from './helpers.js';
import { MergeFixture, base, head } from './merge-fixtures.js';
let admin: Pool;
let pool: Pool;
before(async () => {
  ({ admin, pool } = await initialize());
});
beforeEach(async () => {
  await reset(admin);
  await admin.query(
    'TRUNCATE factory_pr_pairs,factory_pr_observations,factory_merge_receipts,factory_pr_state,factory_dependency_state,factory_autonomy_merges,factory_autonomy_runs,factory_autonomy_scopes,factory_autonomy_control,factory_autonomy_policies CASCADE',
  );
});
after(async () => {
  await pool?.end();
  await admin?.end();
});
async function setup() {
  const g = new MergeFixture();
  const gate = new HumanMergeGate(pool, g.config, g);
  await gate.track(1, 2, head);
  return { g, gate };
}
async function again(gate: HumanMergeGate) {
  await gate.queue.enqueue(randomUUID(), 'example/factory-demo', {
    pull: 2,
    repositoryId: 42,
    installationId: 7,
  });
  await gate.step();
  return (await gate.status())[0];
}
test('protected human merge completes only paired Task and refreshes dependency readiness idempotently', async () => {
  const { g, gate } = await setup();
  try {
    await gate.step();
    assert.equal((await gate.status())[0].state, 'awaiting_human_merge');
    assert.equal(g.writes, 0);
    g.merge();
    assert.equal((await again(gate)).state, 'reconciled');
    assert.equal(g.task.state, 'closed');
    assert.equal(g.dependent.state, 'open');
    assert.deepEqual(g.task.labels.map((l) => l.name).sort(), ['kind:task', 'status:done']);
    const dep = (await pool.query('SELECT snapshot FROM factory_dependency_state')).rows[0]
      .snapshot;
    assert.equal(dep[0].state, 'clear');
    await again(gate);
    assert.equal(g.writes, 1);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM factory_merge_receipts')).rows[0].n,
      1,
    );
    assert.deepEqual((await pool.query('SELECT DISTINCT queue_name FROM factory_work')).rows, [
      { queue_name: 'HumanMergeGate' },
    ]);
  } finally {
    await gate.close();
  }
});
test('new head invalidates approval and CI; labels and structural comments cannot authorize merge', async () => {
  const { g, gate } = await setup();
  try {
    await gate.step();
    g.pull.head.sha = 'd'.repeat(40);
    g.task.labels.push({ name: 'status:approved' });
    assert.equal((await again(gate)).state, 'parked');
    g.task.labels.pop();
    assert.equal((await again(gate)).reason, 'required_ci_missing_failed_or_pending');
    present(g.checks[0]).head_sha = g.pull.head.sha;
    assert.equal((await again(gate)).reason, 'human_approval_missing_or_stale');
    present(g.reviews[0]).commit_id = g.pull.head.sha;
    present(g.reviews[0]).user = { ...g.human, type: 'Bot' };
    assert.equal((await again(gate)).reason, 'human_approval_missing_or_stale');
    assert.equal(g.writes, 0);
  } finally {
    await gate.close();
  }
});
test('unreadable or failed review surfaces park visibly without Task mutation and recover on later scans', async () => {
  const { g, gate } = await setup();
  try {
    g.failRead = true;
    await gate.step();
    assert.equal((await gate.status())[0].reason, 'review_surface_unreadable');
    g.failRead = false;
    present(g.checks[0]).conclusion = 'failure';
    assert.equal((await again(gate)).reason, 'required_ci_missing_failed_or_pending');
    present(g.checks[0]).conclusion = 'success';
    assert.equal((await again(gate)).state, 'awaiting_human_merge');
    assert.equal(g.writes, 0);
  } finally {
    await gate.close();
  }
});
test('partial Task label write is retried from immutable merge receipt and completes once without dropping unrelated labels', async () => {
  const { g, gate } = await setup();
  try {
    await gate.step();
    g.task.labels.push({ name: 'priority:P1' });
    g.merge();
    g.failAfterLabel = true;
    assert.equal((await again(gate)).state, 'parked');
    assert.equal(g.task.state, 'open');
    assert.ok(g.task.labels.some((l) => l.name === 'status:done'));
    assert.equal((await again(gate)).state, 'reconciled');
    assert.equal(g.task.state, 'closed');
    assert.ok(g.task.labels.some((l) => l.name === 'priority:P1'));
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM factory_merge_receipts')).rows[0].n,
      1,
    );
  } finally {
    await gate.close();
  }
});
test('changed Task and non-human or unobserved merge never complete Task', async () => {
  const { g, gate } = await setup();
  try {
    g.merge();
    await gate.step();
    assert.equal((await gate.status())[0].reason, 'pre_merge_observation_missing');
    assert.equal(g.writes, 0);
  } finally {
    await gate.close();
  }
});
test('pair registration and merge evidence are immutable to the runtime database role', async () => {
  const { gate } = await setup();
  try {
    for (const table of ['factory_pr_pairs', 'factory_pr_observations', 'factory_merge_receipts']) {
      await assert.rejects(pool.query(`UPDATE ${table} SET repository_id=43`), /permission denied/);
      await assert.rejects(pool.query(`DELETE FROM ${table}`), /permission denied/);
    }
    await gate.track(1, 2, head);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM factory_pr_pairs')).rows[0].n,
      1,
    );
  } finally {
    await gate.close();
  }
});

function present<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}

test('receipt insert failure prevents Task writes; a later retry safely records proof before effects', async () => {
  const { g, gate } = await setup();
  try {
    await gate.step();
    g.merge();
    await admin.query(
      "CREATE FUNCTION reject_merge_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$",
    );
    await admin.query(
      'CREATE TRIGGER fail_merge_receipt BEFORE INSERT ON factory_merge_receipts FOR EACH ROW EXECUTE FUNCTION reject_merge_receipt()',
    );
    assert.equal((await again(gate)).state, 'parked');
    assert.equal(g.writes, 0);
    await admin.query('DROP TRIGGER fail_merge_receipt ON factory_merge_receipts');
    await admin.query('DROP FUNCTION reject_merge_receipt()');
    assert.equal((await again(gate)).state, 'reconciled');
    assert.equal(g.writes, 1);
  } finally {
    await admin.query('DROP TRIGGER IF EXISTS fail_merge_receipt ON factory_merge_receipts');
    await admin.query('DROP FUNCTION IF EXISTS reject_merge_receipt()');
    await gate.close();
  }
});
test('duplicate reconciliation does not replace a newer dependency snapshot with stale evidence', async () => {
  const { g, gate } = await setup();
  try {
    await gate.step();
    g.merge();
    await again(gate);
    await admin.query(`UPDATE factory_dependency_state SET snapshot='[{"newer":true}]'::jsonb`);
    const original = (await gate.status())[0].updated_at;
    await again(gate);
    assert.deepEqual(
      (await pool.query('SELECT snapshot FROM factory_dependency_state')).rows[0].snapshot,
      [{ newer: true }],
    );
    assert.equal((await gate.status())[0].updated_at.toISOString(), original.toISOString());
    assert.equal(g.writes, 1);
  } finally {
    await gate.close();
  }
});

test('lease expiry during observation insertion rolls back proof and cannot authorize external writes', async () => {
  const g = new MergeFixture();
  g.config.queue.leaseMs = 200;
  const gate = new HumanMergeGate(pool, g.config, g);
  try {
    await gate.track(1, 2, head);
    await admin.query(
      'CREATE FUNCTION delay_merge_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$',
    );
    await admin.query(
      'CREATE TRIGGER delay_merge_observation BEFORE INSERT ON factory_pr_observations FOR EACH ROW EXECUTE FUNCTION delay_merge_observation()',
    );
    await assert.rejects(gate.step());
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM factory_pr_observations')).rows[0].n,
      0,
    );
    assert.equal(g.writes, 0);
  } finally {
    await admin.query('DROP TRIGGER IF EXISTS delay_merge_observation ON factory_pr_observations');
    await admin.query('DROP FUNCTION IF EXISTS delay_merge_observation()');
    await gate.close();
  }
});

test('a merge by the merger App is reconciled only when the autonomy ledger recorded that exact merge', async () => {
  const { MERGER_APP_ID, MERGER_BOT, MERGE_COMMIT } = await import('./merge-host-fixture.js');
  const g = new MergeFixture();
  g.config.mergePolicy = {
    ...(g.config.mergePolicy as NonNullable<typeof g.config.mergePolicy>),
    merger: { appSlug: 'factory-merger', appId: MERGER_APP_ID },
  };
  g.protection.required_pull_request_reviews = {
    ...(g.protection.required_pull_request_reviews as NonNullable<
      typeof g.protection.required_pull_request_reviews
    >),
    require_code_owner_reviews: false,
  };
  g.protection.restrictions = {
    users: [{ login: 'example-maintainer' }],
    teams: [],
    apps: [{ slug: 'factory-merger' }],
  };
  // Routine work: the only approval is the factory's own, given after the policy admitted it.
  g.reviews = [
    {
      id: 1,
      user: MERGER_BOT,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2026-01-01T00:00:00Z',
    },
  ];
  const gate = new HumanMergeGate(pool, g.config, g);
  try {
    await gate.track(1, 2, head);
    await gate.step();
    // Open, with only the factory's approval: not a pull request a human may merge yet; the
    // observation the merge is later reconciled against is recorded all the same.
    assert.equal((await gate.status())[0].state, 'parked');
    assert.equal((await gate.status())[0].reason, 'human_approval_missing_or_stale');
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM factory_pr_observations')).rows[0].n,
      1,
    );
    g.merge();
    g.pull.merged_by = MERGER_BOT;
    // No autonomy merge record: a bot merge is parked for a human to investigate.
    assert.equal((await again(gate)).state, 'parked');
    assert.equal((await gate.status())[0].reason, 'merge_actor_not_configured_human');
    assert.equal(g.task.state, 'open');
    // The controller's record of this exact merge commit makes it an accepted actor.
    const { AutonomyLedger } = await import('../src/autonomy/ledger.js');
    const { AutonomyRuns } = await import('../src/autonomy/runs.js');
    const { AutonomyMerges } = await import('../src/autonomy/merges.js');
    const { NOW, policyFixture } = await import('./autonomy-fixtures.js');
    const policy = policyFixture({
      repository: {
        fullName: 'example/factory-demo',
        id: 42,
        installationId: 7,
        baseBranch: 'main',
      },
    });
    const ledger = new AutonomyLedger(admin);
    await ledger.activatePolicy(
      policy,
      ['initial_activation', 'mode_changed:human_gated->bounded'],
      'owner',
      NOW,
    );
    await ledger.grantScope(
      {
        scopeId: 'gate-test',
        repositoryId: 42,
        taskIds: ['I_FIXTURE'],
        models: ['claude-sonnet-5'],
        budgetMicrousd: 1_000_000,
        maxTaskRuns: 1,
        expiresAt: NOW + 86_400_000,
      },
      'owner',
      NOW,
    );
    const runs = new AutonomyRuns(admin);
    let run = await runs.create({
      repositoryId: 42,
      scopeId: 'gate-test',
      taskId: 'I_FIXTURE',
      taskNumber: 1,
      taskIssueId: 10,
      intentSha256: '1'.repeat(64),
      sourceCommit: base,
    });
    for (const state of [
      'executing',
      'executed',
      'collected',
      'verified',
      'publish_admitted',
      'published',
    ] as const)
      run = await runs.transition(run.runId, [run.state], state, {});
    const merges = new AutonomyMerges(admin);
    const record = await merges.create({
      repositoryId: 42,
      runId: run.runId,
      taskId: 'I_FIXTURE',
      pullNumber: 2,
      head,
      tree: 'd'.repeat(40),
      base,
    });
    await merges.transition(record.mergeId, ['observing'], 'admitted', {});
    // A record of some other merge commit does not vouch for this one: still parked.
    await merges.transition(record.mergeId, ['admitted'], 'merged', {
      mergeCommit: 'e'.repeat(40),
    });
    assert.equal((await again(gate)).state, 'parked');
    assert.equal((await gate.status())[0].reason, 'merge_actor_not_configured_human');
    await admin.query('UPDATE factory_autonomy_merges SET merge_commit=$1 WHERE merge_id=$2', [
      MERGE_COMMIT,
      record.mergeId,
    ]);
    assert.equal((await again(gate)).state, 'reconciled');
    assert.equal(g.task.state, 'closed');
    const receipt = (await pool.query('SELECT proof FROM factory_merge_receipts')).rows[0].proof;
    assert.equal(receipt.merger.login, MERGER_BOT.login);
    assert.equal(receipt.mergeCommit, MERGE_COMMIT);
  } finally {
    await gate.close();
  }
});

test("under the automatic profile a human merge still needs a listed reviewer; the merger App's approval does not carry it", async () => {
  const { MERGER_APP_ID, MERGER_BOT } = await import('./merge-host-fixture.js');
  const g = new MergeFixture();
  g.config.mergePolicy = {
    ...(g.config.mergePolicy as NonNullable<typeof g.config.mergePolicy>),
    merger: { appSlug: 'factory-merger', appId: MERGER_APP_ID },
  };
  g.protection.required_pull_request_reviews = {
    ...(g.protection.required_pull_request_reviews as NonNullable<
      typeof g.protection.required_pull_request_reviews
    >),
    require_code_owner_reviews: false,
  };
  g.protection.restrictions = {
    users: [{ login: 'example-maintainer' }],
    teams: [],
    apps: [{ slug: 'factory-merger' }],
  };
  // Only the factory's own approval is on the head (left behind by a refused automatic merge).
  g.reviews = [
    {
      id: 1,
      user: MERGER_BOT,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2026-01-01T00:00:00Z',
    },
  ];
  const gate = new HumanMergeGate(pool, g.config, g);
  try {
    await gate.track(1, 2, head);
    await gate.step();
    assert.equal((await gate.status())[0].state, 'parked');
    assert.equal((await gate.status())[0].reason, 'human_approval_missing_or_stale');
    g.merge();
    assert.equal((await again(gate)).state, 'parked');
    assert.equal((await gate.status())[0].reason, 'human_approval_missing_or_stale');
    assert.equal(g.task.state, 'open');
  } finally {
    await gate.close();
  }
});
