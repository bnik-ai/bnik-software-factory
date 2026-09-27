import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { AutonomyLedger } from '../src/autonomy/ledger.js';
import { type AutonomyPolicy, policyDigest } from '../src/autonomy/policy.js';
import { migrate } from '../src/migrate.js';
import { NOW, evidenceFor, policyFixture, requestFor } from './autonomy-fixtures.js';
import { config, initialize } from './helpers.js';

let admin: Pool;
let runtimePool: Pool;
let ledger: AutonomyLedger;
const policy = policyFixture();
const INITIAL = ['initial_activation', 'mode_changed:human_gated->bounded'];
const DAY = 86_400_000;

before(async () => {
  ({ admin, pool: runtimePool } = await initialize());
  ledger = new AutonomyLedger(admin);
});
beforeEach(async () => {
  await admin.query(
    'TRUNCATE factory_autonomy_reservations,factory_autonomy_decisions,factory_autonomy_scopes,factory_autonomy_control,factory_autonomy_policies CASCADE',
  );
});
after(async () => {
  await runtimePool?.end();
  await admin?.end();
});

async function activate(document: AutonomyPolicy = policy) {
  await ledger.activatePolicy(document, INITIAL, 'owner', NOW);
}
async function grant(overrides: Partial<Parameters<AutonomyLedger['grantScope']>[0]> = {}) {
  await ledger.grantScope(
    {
      scopeId: 'goal-1',
      repositoryId: policy.repository.id,
      taskIds: ['TASK_1', 'TASK_2'],
      models: ['claude-sonnet-5'],
      budgetMicrousd: 6_000_000,
      maxTaskRuns: 2,
      expiresAt: NOW + DAY,
      ...overrides,
    },
    'owner',
    NOW,
  );
}
async function admitExecute(taskId = 'TASK_1', budgetMicrousd = 2_000_000, now = NOW) {
  const request = requestFor(policy, 'execute');
  request.task.id = taskId;
  if (request.execution) request.execution.budgetMicrousd = budgetMicrousd;
  return { request, ...(await ledger.admit(policy, request, {}, now)) };
}

test('activation requires exact acknowledgement of every weakening and refuses rollback', async () => {
  await assert.rejects(
    ledger.activatePolicy(policy, [], 'owner', NOW),
    /policy_weakening_not_acknowledged/,
  );
  await activate();
  assert.equal(
    policyDigest((await ledger.activePolicy(policy.repository.id)) as AutonomyPolicy),
    policyDigest(policy),
  );
  const wider = policyFixture({ revision: 2, allowedPaths: ['.'] });
  await assert.rejects(
    ledger.activatePolicy(wider, [], 'owner', NOW),
    /policy_weakening_not_acknowledged/,
  );
  await assert.rejects(
    ledger.activatePolicy(wider, ['allowed_path_added:.', 'model_added:x'], 'owner', NOW),
    /policy_weakening_not_acknowledged/,
  );
  const result = await ledger.activatePolicy(wider, ['allowed_path_added:.'], 'owner', NOW);
  assert.deepEqual(result.weakenings, ['allowed_path_added:.']);
  await assert.rejects(
    ledger.activatePolicy(policy, [], 'owner', NOW),
    /policy_revision_not_increasing/,
  );
  const stricter = policyFixture({ revision: 3, allowedPaths: ['src'] });
  await ledger.activatePolicy(stricter, [], 'owner', NOW);
});

test('the internet-facing runtime role can read but never write autonomy authority', async () => {
  await activate();
  await grant();
  const { decisionId } = await admitExecute();
  assert.equal(
    (await runtimePool.query('SELECT count(*) AS n FROM factory_autonomy_decisions')).rows[0].n,
    '1',
  );
  for (const statement of [
    "UPDATE factory_autonomy_decisions SET outcome='allow'",
    `UPDATE factory_autonomy_decisions SET consumed_at=now() WHERE decision_id='${decisionId}'`,
    'UPDATE factory_autonomy_control SET paused=false',
    'UPDATE factory_autonomy_scopes SET budget_microusd=999999999',
    `INSERT INTO factory_autonomy_policies(policy_sha256,repository_id,revision,mode,document,acknowledged_weakenings,activated_by) VALUES('${'0'.repeat(64)}',1,99,'bounded','{}','[]','attacker')`,
    'DELETE FROM factory_autonomy_reservations',
  ])
    await assert.rejects(runtimePool.query(statement), /permission denied/, statement);
  // A privilege added out of band does not survive the next migration run.
  await admin.query('GRANT UPDATE ON factory_autonomy_control TO factory_runtime');
  await runtimePool.query('UPDATE factory_autonomy_control SET paused=false');
  await migrate(admin, config().database.password);
  await assert.rejects(
    runtimePool.query('UPDATE factory_autonomy_control SET paused=false'),
    /permission denied/,
  );
});

test('scope grants stay inside the active policy', async () => {
  await assert.rejects(grant(), /autonomy_not_configured/);
  await activate();
  await assert.rejects(grant({ budgetMicrousd: 20_000_001 }), /scope_budget_exceeds_policy/);
  await assert.rejects(grant({ models: ['claude-opus-5-5'] }), /scope_model_not_in_policy/);
  await assert.rejects(grant({ maxTaskRuns: 4 }), /scope_runs_exceed_policy/);
  await assert.rejects(grant({ expiresAt: NOW + 31 * DAY }), /scope_expiry_invalid/);
  await assert.rejects(grant({ taskIds: [] }), /scope_tasks_invalid/);
  await grant();
  await assert.rejects(grant(), /duplicate key/);
});

test('an admission is consumed once, and a re-decided request cannot be admitted twice', async () => {
  await activate();
  await grant();
  const { request, decisionId, decision } = await admitExecute();
  assert.equal(decision.outcome, 'allow');
  const consumed = await ledger.consume(decisionId, NOW + 1000);
  assert.ok(consumed.reservationId);
  await assert.rejects(ledger.consume(decisionId, NOW + 1000), /admission_already_consumed/);
  const again = await ledger.admit(policy, request, {}, NOW + 2000);
  await assert.rejects(ledger.consume(again.decisionId, NOW + 2000), /request_already_admitted/);
});

test('only allowed, current decisions are admissible', async () => {
  await activate();
  await grant();
  const heldRequest = requestFor(policy, 'merge');
  const { decisionId: blockedId } = await ledger.admit(policy, heldRequest, {}, NOW);
  await assert.rejects(ledger.consume(blockedId, NOW), /admission_not_allowed/);
  const merge = await ledger.admit(policy, heldRequest, evidenceFor(policy, heldRequest), NOW);
  assert.equal(merge.decision.outcome, 'allow');
  await assert.rejects(ledger.consume(merge.decisionId, NOW + 600_001), /admission_expired/);
  await assert.rejects(
    ledger.consume('00000000-0000-4000-8000-000000000000', NOW),
    /admission_missing/,
  );
  await assert.rejects(
    ledger.admit(policyFixture({ revision: 9 }), heldRequest, {}, NOW),
    /policy_not_active/,
  );
});

test('pause and scope revocation stop admission even after an allow decision', async () => {
  await activate();
  await grant();
  const first = await admitExecute();
  await ledger.setPaused(policy.repository.id, true, 'incident', 'owner', NOW);
  await assert.rejects(ledger.consume(first.decisionId, NOW), /autonomy_paused/);
  await ledger.setPaused(policy.repository.id, false, null, 'owner', NOW);
  await ledger.consume(first.decisionId, NOW);
  const second = await admitExecute('TASK_2');
  await ledger.revokeScope('goal-1', 'change of plan', 'owner', NOW);
  await assert.rejects(ledger.consume(second.decisionId, NOW), /scope_revoked/);
  await assert.rejects(
    ledger.revokeScope('goal-1', 'again', 'owner', NOW),
    /scope_missing_or_already_revoked/,
  );
  const outside = await admitExecute('TASK_9');
  assert.equal(outside.decision.outcome, 'allow');
});

test('a policy change invalidates pending decisions and scopes granted under the old policy', async () => {
  await activate();
  await grant();
  const pending = await admitExecute();
  const stricter = policyFixture({ revision: 2, allowedPaths: ['src'] });
  await ledger.activatePolicy(stricter, [], 'owner', NOW);
  await assert.rejects(ledger.consume(pending.decisionId, NOW), /policy_changed_since_decision/);
  const request = requestFor(stricter, 'execute');
  const fresh = await ledger.admit(stricter, request, {}, NOW);
  await assert.rejects(ledger.consume(fresh.decisionId, NOW), /scope_granted_under_other_policy/);
});

test('scope membership, model, attempt limit and budget are enforced at admission', async () => {
  await activate();
  await grant({ taskIds: ['TASK_1', 'TASK_2', 'TASK_3'] });
  const outside = await admitExecute('TASK_9');
  await assert.rejects(ledger.consume(outside.decisionId, NOW), /task_outside_scope/);

  const firstRun = await ledger.consume((await admitExecute('TASK_1', 2_000_000)).decisionId, NOW);
  const secondRun = await ledger.consume((await admitExecute('TASK_1', 1_000_000)).decisionId, NOW);
  await assert.rejects(
    ledger.consume((await admitExecute('TASK_1', 1)).decisionId, NOW),
    /task_run_limit_reached/,
  );
  // A run that provably never started frees its attempt and budget.
  await ledger.settle(secondRun.reservationId as string, { state: 'released' }, NOW);
  await ledger.consume((await admitExecute('TASK_1', 1_000_000)).decisionId, NOW);

  // Committed: 2.0 reserved + 1.0 reserved = 3.0 of 6.0.
  await ledger.settle(
    firstRun.reservationId as string,
    { state: 'settled', microusd: 2_500_000 },
    NOW,
  );
  // Committed: 2.5 settled (estimate above reservation counts) + 1.0 = 3.5; 2.5 more fits, 2.6 does not.
  await assert.rejects(
    ledger.consume((await admitExecute('TASK_2', 2_600_000)).decisionId, NOW),
    /scope_budget_exhausted/,
  );
  const unknownRun = await ledger.consume(
    (await admitExecute('TASK_2', 2_500_000)).decisionId,
    NOW,
  );
  await ledger.settle(unknownRun.reservationId as string, { state: 'unknown' }, NOW);
  // Unknown outcome keeps its full reservation; nothing is left.
  await assert.rejects(
    ledger.consume((await admitExecute('TASK_3', 1)).decisionId, NOW),
    /scope_budget_exhausted/,
  );
  await assert.rejects(
    ledger.settle(firstRun.reservationId as string, { state: 'released' }, NOW),
    /reservation_missing_or_already_settled/,
  );
  await ledger.settle(
    unknownRun.reservationId as string,
    { state: 'settled', microusd: 100_000 },
    NOW,
  );
  await ledger.consume((await admitExecute('TASK_3', 1_000_000)).decisionId, NOW);
});

test('concurrent admissions cannot overspend a scope', async () => {
  await activate();
  await grant({ budgetMicrousd: 5_000_000 });
  const candidates = await Promise.all([
    admitExecute('TASK_1', 3_000_000),
    admitExecute('TASK_2', 3_000_000),
  ]);
  const results = await Promise.allSettled(
    candidates.map((candidate) => ledger.consume(candidate.decisionId, NOW)),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(rejected.reason), /scope_budget_exhausted/);
});
