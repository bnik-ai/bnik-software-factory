import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { AutonomyLedger } from '../src/autonomy/ledger.js';
import { type AutonomyPolicy, policyDigest } from '../src/autonomy/policy.js';
import { migrate } from '../src/migrate.js';
import { NOW, approvalFor, evidenceFor, policyFixture, requestFor } from './autonomy-fixtures.js';
import { config, controllerPool, initialize } from './helpers.js';

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

test('one human approval admits one action, however many requests repeat it', async () => {
  const gated = policyFixture({ mode: 'human_gated' });
  await ledger.activatePolicy(gated, ['initial_activation'], 'owner', NOW);
  await ledger.grantScope(
    {
      scopeId: 'goal-1',
      repositoryId: gated.repository.id,
      taskIds: ['TASK_1'],
      models: ['claude-sonnet-5'],
      budgetMicrousd: 20_000_000,
      maxTaskRuns: 3,
      expiresAt: NOW + DAY,
    },
    'owner',
    NOW,
  );
  const first = requestFor(gated, 'execute');
  const approval = approvalFor(gated, first);
  const repeated = { ...structuredClone(first), requestId: '11111111-1111-4111-8111-111111111111' };
  const admitted = await ledger.admit(gated, first, { approval }, NOW);
  const replayed = await ledger.admit(gated, repeated, { approval }, NOW);
  assert.equal(admitted.decision.outcome, 'allow');
  assert.equal(replayed.decision.outcome, 'allow');
  await ledger.consume(admitted.decisionId, NOW);
  await assert.rejects(ledger.consume(replayed.decisionId, NOW), /approval_already_used/);
});

test('the per-Task run ceiling holds across overlapping scopes', async () => {
  await activate();
  await grant({ scopeId: 'goal-1', maxTaskRuns: 2 });
  await grant({ scopeId: 'goal-2', maxTaskRuns: 2 });
  const inScope = async (scopeId: string) => {
    const request = requestFor(policy, 'execute', null, { scopeId });
    return ledger.consume((await ledger.admit(policy, request, {}, NOW)).decisionId, NOW);
  };
  await inScope('goal-1');
  await inScope('goal-1');
  await inScope('goal-2');
  // Policy maxTaskRuns is 3 for TASK_1 across the repository, even though goal-2 allows 2.
  await assert.rejects(inScope('goal-2'), /task_run_limit_reached/);
});

test('pause and revocation wait for in-flight admission and are then authoritative', async () => {
  await activate();
  await grant();
  const holder = await admin.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM factory_autonomy_control WHERE repository_id=$1 FOR UPDATE', [
      policy.repository.id,
    ]);
    let settled = false;
    const pausing = ledger
      .setPaused(policy.repository.id, true, 'incident', 'owner', NOW)
      .then(() => {
        settled = true;
      });
    const revoking = ledger.revokeScope('goal-1', 'incident', 'owner', NOW);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, 'pause must wait for the in-flight admission lock');
    await holder.query('COMMIT');
    await Promise.all([pausing, revoking]);
  } finally {
    holder.release();
  }
  const pending = await admitExecute();
  await assert.rejects(ledger.consume(pending.decisionId, NOW), /autonomy_paused/);
});

test('a re-rendered approval of the same action cannot admit a second request', async () => {
  const gated = policyFixture({ mode: 'human_gated' });
  await ledger.activatePolicy(gated, ['initial_activation'], 'owner', NOW);
  await ledger.grantScope(
    {
      scopeId: 'goal-1',
      repositoryId: gated.repository.id,
      taskIds: ['TASK_1'],
      models: ['claude-sonnet-5'],
      budgetMicrousd: 20_000_000,
      maxTaskRuns: 3,
      expiresAt: NOW + DAY,
    },
    'owner',
    NOW,
  );
  const first = requestFor(gated, 'execute');
  const second = { ...structuredClone(first), requestId: '22222222-2222-4222-8222-222222222222' };
  const fromReview = approvalFor(gated, first);
  const fromConsole = approvalFor(gated, first, {
    source: 'operator_console',
    approvedAt: NOW - 1000,
  });
  const admitted = await ledger.admit(gated, first, { approval: fromReview }, NOW);
  const mirrored = await ledger.admit(gated, second, { approval: fromConsole }, NOW);
  assert.equal(mirrored.decision.outcome, 'allow');
  await ledger.consume(admitted.decisionId, NOW);
  await assert.rejects(ledger.consume(mirrored.decisionId, NOW), /approval_already_used/);
});

test('the read-only runtime role cannot take the ledger lock or stall pause', async () => {
  await activate();
  const runtimeClient = await runtimePool.connect();
  try {
    await runtimeClient.query('BEGIN');
    await assert.rejects(
      runtimeClient.query(
        'SELECT 1 FROM factory_autonomy_control WHERE repository_id=$1 FOR UPDATE',
        [policy.repository.id],
      ),
      /permission denied/,
    );
    await runtimeClient.query('ROLLBACK');
    await runtimeClient.query('BEGIN');
    await runtimeClient.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('factory_autonomy',$1))",
      [policy.repository.id],
    );
    await ledger.setPaused(policy.repository.id, true, 'incident', 'owner', NOW);
    await runtimeClient.query('ROLLBACK');
  } finally {
    runtimeClient.release();
  }
  await assert.rejects(
    ledger.setPaused(999_999, true, 'x', 'owner', NOW),
    /autonomy_not_configured/,
  );
});

test('the controller role writes autonomy state and drives the supervisor tables; it cannot delete or alter schema', async () => {
  await activate();
  const controller = controllerPool();
  try {
    const identity = (await controller.query('SELECT session_user AS principal')).rows[0].principal;
    assert.equal(identity, 'factory_controller');
    const controllerLedger = new AutonomyLedger(controller);
    await controllerLedger.grantScope(
      {
        scopeId: 'goal-controller',
        repositoryId: policy.repository.id,
        taskIds: ['TASK_1'],
        models: ['claude-sonnet-5'],
        budgetMicrousd: 5_000_000,
        maxTaskRuns: 1,
        expiresAt: NOW + DAY,
      },
      'controller',
      NOW,
    );
    const request = requestFor(policy, 'execute');
    const admitted = await controllerLedger.admit(
      policy,
      { ...request, scopeId: 'goal-controller' },
      {},
      NOW,
    );
    assert.equal(admitted.decision.outcome, 'allow');
    const consumed = await controllerLedger.consume(admitted.decisionId, NOW);
    assert.ok(consumed.reservationId);
    await controller.query(
      "INSERT INTO factory_autonomy_runs(run_id,repository_id,scope_id,task_id,task_number,task_issue_id,attempt,state,execute_decision_id,reservation_id) VALUES(gen_random_uuid(),$1,'goal-controller','TASK_1',1,9001,1,'admitted',$2,$3)",
      [policy.repository.id, admitted.decisionId, consumed.reservationId],
    );
    await controller.query(
      "INSERT INTO factory_work(queue_name,delivery_key,record_key,body,body_hash,state,max_attempts) VALUES('CodingJob','controller-job','example/factory-demo','{}'::jsonb,repeat('0',64),'pending',1)",
    );
    for (const statement of [
      'DELETE FROM factory_autonomy_runs',
      'DELETE FROM factory_autonomy_decisions',
      'DROP TABLE factory_autonomy_runs',
      'CREATE TABLE controller_probe(id int)',
      "INSERT INTO factory_schema_migrations(version,sha256) VALUES('9999','x')",
    ])
      await assert.rejects(
        controller.query(statement),
        /permission denied|must be owner/,
        statement,
      );
    // The runtime role sees the new tables but cannot touch them.
    assert.equal(
      (await runtimePool.query('SELECT count(*) AS n FROM factory_autonomy_runs')).rows[0].n,
      '1',
    );
    for (const statement of [
      "UPDATE factory_autonomy_runs SET state='published'",
      "INSERT INTO factory_autonomy_approvals(approval_id,repository_id,action_sha256,action,approver_user_id,source,evidence,approved_at,recorded_by) VALUES(gen_random_uuid(),1,repeat('0',64),'merge',1,'operator_console','{}',now(),'x')",
    ])
      await assert.rejects(runtimePool.query(statement), /permission denied/, statement);
    // One open attempt per Task.
    await assert.rejects(
      controller.query(
        "INSERT INTO factory_autonomy_runs(run_id,repository_id,scope_id,task_id,task_number,task_issue_id,attempt,state) VALUES(gen_random_uuid(),$1,'goal-controller','TASK_1',1,9001,2,'executing')",
        [policy.repository.id],
      ),
      /duplicate key/,
    );
  } finally {
    await controller.end();
  }
});

test('a scope binds Tasks to the intent the owner reviewed; an edited issue is refused at admission', async () => {
  await activate();
  const { INTENT_SHA256 } = await import('./autonomy-fixtures.js');
  await assert.rejects(
    grant({ taskIntents: { TASK_9: INTENT_SHA256 } }),
    /scope_intent_task_unknown/,
  );
  await assert.rejects(grant({ taskIntents: { TASK_1: 'not-a-digest' } }), /scope_intent_invalid/);
  await grant({ taskIntents: { TASK_1: INTENT_SHA256 } });
  // The Task as reviewed is admitted; TASK_2 is unbound and admitted as before.
  await ledger.consume((await admitExecute('TASK_1')).decisionId, NOW);
  await ledger.consume((await admitExecute('TASK_2')).decisionId, NOW);
  // The same Task with another intent (an edited issue) is not the granted Task.
  const edited = requestFor(policy, 'execute');
  edited.task.intentSha256 = 'f'.repeat(64);
  const { decisionId } = await ledger.admit(policy, edited, {}, NOW);
  await assert.rejects(ledger.consume(decisionId, NOW), /scope_intent_mismatch/);
});
