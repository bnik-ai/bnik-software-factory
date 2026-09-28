import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import type { ChangeManifest } from '../src/autonomy/classify.js';
import { type LoadedTask, intentDigest } from '../src/autonomy/controller.js';
import { ADMISSION_TTL_MS, ApprovalStore, AutonomyLedger } from '../src/autonomy/ledger.js';
import { type MergeAdapters, MergeController } from '../src/autonomy/merge-controller.js';
import { observeMergeGate } from '../src/autonomy/merge.js';
import { AutonomyMerges } from '../src/autonomy/merges.js';
import { type AutonomyPolicy, policyDigest } from '../src/autonomy/policy.js';
import { AutonomyRuns } from '../src/autonomy/runs.js';
import {
  PAIRED_TASK_STATUSES,
  PROPOSED_TASK_STATUSES,
  taskSnapshot,
} from '../src/github/activation.js';
import { pairPull } from '../src/github/merge-gate.js';
import { HumanMergeGate } from '../src/github/reconcile.js';
import {
  APPROVER_ID,
  NOW,
  ROUTINE_CHANGE,
  acceptanceFor,
  added,
  manifest,
  policyFixture,
  requestFor,
  reviewFor,
} from './autonomy-fixtures.js';
import { controllerPool, initialize } from './helpers.js';
import { MergeFixture, base, head } from './merge-fixtures.js';
import { FixtureMergeHost, MERGER_APP_ID, MERGER_BOT, MERGE_COMMIT } from './merge-host-fixture.js';

/**
 * Merge controller contracts on a real PostgreSQL with a fixture GitHub (reads) and a fixture
 * merger identity (writes) sharing one pull request. Runs arrive `published` the way OSS-20
 * leaves them: tree-bound receipts, a publication and an intent digest.
 */
let admin: Pool;
let runtimePool: Pool;
let controllerDb: Pool;
const DAY = 86_400_000;
const REPOSITORY = {
  id: 101,
  installationId: 202,
  fullName: 'example/factory-demo',
  baseBranch: 'main',
};
const TASK_ID = 'I_FIXTURE';
const TRUNCATE =
  'TRUNCATE factory_autonomy_merges,factory_autonomy_locks,factory_autonomy_runs,factory_autonomy_approvals,factory_autonomy_reservations,factory_autonomy_decisions,factory_autonomy_scopes,factory_autonomy_control,factory_autonomy_policies,factory_pr_pairs,factory_pr_observations,factory_merge_receipts,factory_pr_state,factory_dependency_state,factory_work CASCADE';
let clock = NOW;
const now = () => clock;

before(async () => {
  ({ admin, pool: runtimePool } = await initialize());
  controllerDb = controllerPool();
});
beforeEach(async () => {
  clock = NOW;
  await admin.query(TRUNCATE);
});
after(async () => {
  await controllerDb?.end();
  await runtimePool?.end();
  await admin?.end();
});

function github(policy: AutonomyPolicy, automatic = true): MergeFixture {
  const g = new MergeFixture();
  // One repository identity everywhere: policy, pairing, pull request and gate configuration.
  g.repo.id = REPOSITORY.id;
  g.pull.base.repo.id = REPOSITORY.id;
  g.pull.head.repo = { id: REPOSITORY.id };
  g.config.repositoryId = REPOSITORY.id;
  g.config.installationId = REPOSITORY.installationId;
  g.human = { id: APPROVER_ID, login: 'example-maintainer', type: 'User' };
  g.reviews = [];
  // The Task as publication leaves it: definition block, backlink to the pull request, in review.
  g.task.body = `pr-ref: ${g.pull.node_id}\n\n\`\`\`factory-task\n${JSON.stringify({
    prompt: 'Fix sum and verify it.',
    model: 'claude-fixture',
    tests: ['node --test'],
    maxTurns: 2,
    timeoutMs: 30_000,
  })}\n\`\`\`\n`;
  g.task.labels = [{ name: 'kind:task' }, { name: 'status:in_review' }];
  if (automatic) {
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
  }
  assert.equal(policy.repository.id, REPOSITORY.id);
  return g;
}
interface Scenario {
  changes?: ChangeManifest;
  policy?: AutonomyPolicy;
  receiptAge?: number;
}
async function harness(scenario: Scenario = {}) {
  const policy =
    scenario.policy ??
    policyFixture({ allowedPaths: ['.'], approvers: { githubUserIds: [APPROVER_ID] } });
  const g = github(policy);
  const host = new FixtureMergeHost(g, now);
  // The live reader's rules (labels, definition block) against the fixture Task.
  const loadTask = (): LoadedTask => {
    const snapshot = taskSnapshot(g.config, g.task, base, [
      ...PROPOSED_TASK_STATUSES,
      ...PAIRED_TASK_STATUSES,
    ]);
    return {
      id: snapshot.issue.node_id,
      issueId: snapshot.issue.id,
      number: snapshot.issue.number,
      title: snapshot.issue.title,
      body: snapshot.issue.body ?? '',
      intentKind: 'change',
      definition: snapshot.definition,
      sourceCommit: base,
      status: snapshot.issue.labels
        .map((label) => label.name)
        .find((name) => name.startsWith('status:')) as string,
    };
  };
  const task = loadTask();
  assert.equal(task.id, TASK_ID);
  assert.equal(task.status, 'status:in_review');
  const ledger = new AutonomyLedger(controllerDb);
  const runs = new AutonomyRuns(controllerDb);
  const merges = new AutonomyMerges(controllerDb);
  const approvals = new ApprovalStore(controllerDb);
  await ledger.activatePolicy(
    policy,
    ['initial_activation', 'mode_changed:human_gated->bounded'],
    'owner',
    now(),
  );
  await ledger.grantScope(
    {
      scopeId: 'goal-1',
      repositoryId: REPOSITORY.id,
      taskIds: [TASK_ID],
      models: ['claude-sonnet-5'],
      budgetMicrousd: 20_000_000,
      maxTaskRuns: 3,
      expiresAt: now() + DAY,
    },
    'owner',
    now(),
  );
  // A published attempt as OSS-20 leaves it.
  const changes = scenario.changes ?? manifest(ROUTINE_CHANGE);
  const bound = requestFor(policy, 'merge', changes, {
    task: { id: TASK_ID, intentSha256: intentDigest(task), intentKind: 'change' },
    base,
    head,
    tree: g.headTree,
  });
  const completedAt = now() - (scenario.receiptAge ?? 60_000);
  let run = await runs.create({
    repositoryId: REPOSITORY.id,
    scopeId: 'goal-1',
    taskId: TASK_ID,
    taskNumber: task.number,
    taskIssueId: task.issueId,
    intentSha256: intentDigest(task),
    sourceCommit: base,
  });
  for (const state of [
    'executing',
    'executed',
    'collected',
    'verified',
    'publish_admitted',
  ] as const)
    run = await runs.transition(run.runId, [run.state], state, {});
  run = await runs.transition(run.runId, ['publish_admitted'], 'published', {
    baseTree: 'e'.repeat(40),
    candidateTree: g.headTree,
    receipts: {
      acceptance: acceptanceFor(policy, bound, { completedAt }),
      review: reviewFor(policy, bound, { completedAt }),
    },
    evidence: { manifest: changes },
    publication: {
      branch: 'factory/task-1-abcdef12',
      head,
      tree: g.headTree,
      pullNumber: g.pull.number,
      pullNodeId: g.pull.node_id,
      pullId: g.pull.id,
      writeRepositoryId: REPOSITORY.id,
      baseRepositoryId: REPOSITORY.id,
      outcome: 'created',
    },
  });
  const reconciled: string[] = [];
  // The pairing publication registered while the pull request was open (factory_pr_pairs).
  const registered = await pairPull(g.config, g, task.number, g.pull.number, head, {
    headRepositoryIds: [REPOSITORY.id],
  });
  const adapters: MergeAdapters = {
    pool: controllerDb,
    ledger,
    runs,
    merges,
    approvals,
    policy,
    repository: REPOSITORY,
    taskSource: { load: async () => loadTask(), archive: async () => Buffer.alloc(0) },
    actor: 'test-merger',
    now,
    loadPair: async () => registered,
    observe: (pair, expectation) => observeMergeGate(g.config, g, pair, expectation, now),
    perform: (work) => host.perform(work),
    afterMerge: async (_run, merge) => {
      reconciled.push(merge.mergeCommit ?? '');
    },
  };
  return {
    controller: new MergeController(adapters),
    adapters,
    g,
    host,
    run,
    task,
    policy,
    ledger,
    runs,
    merges,
    approvals,
    reconciled,
  };
}
let reviewId = 100;
function approve(g: MergeFixture, commit = head, user = g.human) {
  g.reviews.push({
    id: reviewId++,
    user,
    state: 'APPROVED',
    commit_id: commit,
    submitted_at: new Date(now()).toISOString(),
  });
}
function failChecks(g: MergeFixture, conclusion: string | null = 'failure') {
  g.checks[0] = {
    ...(g.checks[0] as (typeof g.checks)[number]),
    ...(conclusion === null
      ? { status: 'in_progress', conclusion: null, completed_at: null }
      : { conclusion }),
  };
}
function passChecks(g: MergeFixture) {
  g.checks[0] = {
    ...(g.checks[0] as (typeof g.checks)[number]),
    status: 'completed',
    conclusion: 'success',
    completed_at: new Date(now()).toISOString(),
  };
}
const mergeDecisions = async () =>
  (
    await admin.query(
      "SELECT count(*)::int AS n FROM factory_autonomy_decisions WHERE action='merge'",
    )
  ).rows[0].n as number;

test('a routine published attempt merges with no human step: admitted once, exact head, verified proof, reconciled', async () => {
  const h = await harness();
  const result = await h.controller.merge(1);
  assert.equal(result.merge.state, 'merged', JSON.stringify(result.merge));
  assert.equal(result.merge.mergeCommit, MERGE_COMMIT);
  assert.deepEqual(
    result.decisions.map((d) => [d.action, d.outcome, d.risk]),
    [['merge', 'allow', 'routine']],
  );
  // The factory approved as itself (no human review existed), then squash-merged the exact head.
  assert.deepEqual(h.host.calls, ['pull', 'approve', 'merge', 'pull', 'commit']);
  assert.equal(h.g.pull.merged_by?.login, MERGER_BOT.login);
  assert.equal((result.merge.proof as { approvedBy: number | null }).approvedBy, null);
  assert.deepEqual(h.reconciled, [MERGE_COMMIT]);
  assert.equal(result.merge.evidence.reconciled, true);
  // The run row is untouched; the ledger consumed exactly one merge admission.
  assert.equal((await h.adapters.runs.get(h.run.runId))?.state, 'published');
  const decisions = await admin.query(
    "SELECT count(*)::int AS n FROM factory_autonomy_decisions WHERE action='merge' AND consumed_at IS NOT NULL",
  );
  assert.equal(decisions.rows[0].n, 1);
  // The pre-merge observation the gate reconciles against was recorded for this head and base.
  const observation = await admin.query(
    'SELECT foundation FROM factory_pr_observations WHERE repository_id=$1 AND pull_number=$2',
    [REPOSITORY.id, h.g.pull.number],
  );
  assert.equal(observation.rows.length, 1);
  assert.equal(observation.rows[0].foundation.head, head);
  assert.equal(observation.rows[0].foundation.base, base);
  // Repeating changes nothing and calls GitHub for nothing.
  const calls = h.host.calls.length;
  const again = await h.controller.merge(1);
  assert.equal(again.merge.state, 'merged');
  assert.equal(again.decisions.length, 0);
  assert.equal(h.host.calls.length, calls);
  // The internet-facing runtime reads the record but cannot touch it.
  assert.equal(
    (await runtimePool.query('SELECT count(*)::int AS n FROM factory_autonomy_merges')).rows[0].n,
    1,
  );
  await assert.rejects(
    runtimePool.query("UPDATE factory_autonomy_merges SET state='blocked'"),
    /permission denied/,
  );
});

test('the Task is read with the live rules: a Task not paired to the pull request never merges, and the backlink is not part of its intent', async () => {
  const h = await harness();
  // Publication wrote the backlink after the attempt started: the intent the owner granted is unchanged.
  const proposed = {
    ...h.task,
    body: h.task.body.replace(/^pr-ref:.*\n/m, ''),
    status: 'status:proposed',
  };
  assert.equal(intentDigest(proposed), h.run.intentSha256);
  assert.notEqual(intentDigest({ ...h.task, body: `${h.task.body}\nchanged` }), h.run.intentSha256);
  // Someone removes the backlink or re-labels the Task: the pairing no longer holds, nothing merges.
  h.g.task.body = h.g.task.body?.replace(/^pr-ref:.*\n/m, '') ?? '';
  await assert.rejects(h.controller.merge(1), /paired_task_changed/);
  assert.equal(h.host.calls.length, 0);
  h.g.task.body = `pr-ref: ${h.g.pull.node_id}\n${h.g.task.body}`;
  h.g.task.labels = [{ name: 'kind:task' }, { name: 'status:done' }];
  await assert.rejects(h.controller.merge(1), /task_labels_invalid/);
  h.g.task.labels = [{ name: 'kind:task' }, { name: 'status:proposed' }];
  await assert.rejects(h.controller.merge(1), /paired_task_state_invalid/);
  assert.equal(h.host.calls.length, 0);
  h.g.task.labels = [{ name: 'kind:task' }, { name: 'status:in_review' }];
  assert.equal((await h.controller.merge(1)).merge.state, 'merged');
});

test('a merge made without any earlier gate observation still reconciles through the human merge gate', async () => {
  const h = await harness();
  // The publication registered the pairing and queued gate work, but no gate step ran yet.
  const gate = new HumanMergeGate(runtimePool, h.g.config, h.g);
  try {
    await gate.track(1, h.g.pull.number, head);
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM factory_pr_observations')).rows[0].n,
      0,
    );
    h.adapters.afterMerge = async (_run, merge) => {
      await gate.queue.enqueue('after-merge', 'example/factory-demo', {
        pull: merge.pullNumber,
        repositoryId: REPOSITORY.id,
        installationId: REPOSITORY.installationId,
      });
      while (await gate.step());
    };
    const result = await h.controller.merge(1);
    assert.equal(result.merge.state, 'merged', JSON.stringify(result.merge));
    assert.equal(result.merge.evidence.reconciled, true);
    assert.equal((await gate.status())[0]?.state, 'reconciled');
    assert.equal(h.g.task.state, 'closed');
    const receipt = (await runtimePool.query('SELECT proof FROM factory_merge_receipts')).rows[0]
      ?.proof;
    assert.equal(receipt?.mergeCommit, MERGE_COMMIT);
    assert.equal(receipt?.merger?.login, MERGER_BOT.login);
  } finally {
    await gate.close();
  }
});

test('a critical change holds until a configured approver reviews the exact head; other reviews never count', async () => {
  const h = await harness({
    changes: manifest(added('.github/workflows/ci.yml', 'on: push\n')),
  });
  const held = await h.controller.merge(1);
  assert.equal(held.merge.state, 'held');
  assert.equal(held.merge.reason, 'merge_approval_required');
  const actionSha256 = String(held.merge.evidence.actionSha256);
  assert.match(actionSha256, /^[0-9a-f]{64}$/);
  assert.equal(h.host.calls.length, 0, 'nothing was written to GitHub');
  // Reviews that must not unlock: an unlisted user, a bot, a review of another commit, the author.
  for (const user of [
    { id: 999, login: 'stranger', type: 'User' },
    { ...MERGER_BOT },
    { id: h.g.pull.user.id, login: 'factory[bot]', type: 'Bot' },
  ])
    h.g.reviews.push({
      id: 200 + h.g.reviews.length,
      user,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: new Date(now()).toISOString(),
    });
  approve(h.g, base);
  assert.equal((await h.controller.merge(1)).merge.state, 'held');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM factory_autonomy_approvals')).rows[0].n,
    0,
  );
  // The configured approver on the exact head unlocks exactly this action, once. Without the
  // bot's earlier review on the head, the factory must still not approve a critical change.
  h.g.reviews = h.g.reviews.filter((review) => review.user.id !== MERGER_BOT.id);
  approve(h.g);
  const merged = await h.controller.merge(1);
  assert.equal(merged.merge.state, 'merged', JSON.stringify(merged.merge));
  assert.equal(merged.decisions.at(-1)?.approvedBy, APPROVER_ID);
  assert.equal((merged.merge.proof as { approvedBy: number | null }).approvedBy, APPROVER_ID);
  assert.ok(!h.host.calls.includes('approve'), 'no factory approval on top of the human one');
  const approvals = await admin.query(
    'SELECT source,approver_user_id::int AS approver,evidence FROM factory_autonomy_approvals',
  );
  assert.equal(approvals.rows.length, 1);
  assert.equal(approvals.rows[0].source, 'github_review');
  assert.equal(approvals.rows[0].approver, APPROVER_ID);
  assert.equal(approvals.rows[0].evidence.head, head);
});

test('an approver the merge policy does not list as a reviewer cannot unlock a critical merge', async () => {
  const h = await harness({
    changes: manifest(added('.github/workflows/ci.yml', 'on: push\n')),
  });
  approve(h.g, head, { id: APPROVER_ID, login: 'approver-not-a-reviewer', type: 'User' });
  const held = await h.controller.merge(1);
  assert.equal(held.merge.state, 'held');
  assert.equal(held.merge.reason, 'merge_approval_required');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM factory_autonomy_approvals')).rows[0].n,
    0,
  );
  assert.equal(h.host.calls.length, 0);
});

test("the factory's own approval is decided by the ledger, not by who else approved on GitHub", async () => {
  // Routine work with a stranger's approval on the head: the merger still approves as itself,
  // since GitHub counts only write-access reviews and reconciliation only listed reviewers.
  const h = await harness();
  approve(h.g, head, { id: 999, login: 'stranger', type: 'User' });
  const result = await h.controller.merge(1);
  assert.equal(result.merge.state, 'merged', JSON.stringify(result.merge));
  assert.deepEqual(h.host.calls, ['pull', 'approve', 'merge', 'pull', 'commit']);
  assert.equal((result.merge.proof as { approvedBy: number | null }).approvedBy, null);
});

test('pending or missing checks and a change request keep the record open; the next scan merges once they clear', async () => {
  const h = await harness();
  failChecks(h.g, null);
  const pending = await h.controller.merge(1);
  assert.equal(pending.merge.state, 'observing');
  assert.equal(pending.merge.reason, 'required_checks_pending');
  assert.equal(pending.decisions.length, 0, 'no decision is recorded for a wait');
  assert.equal(await mergeDecisions(), 0);
  const check = h.g.checks[0] as (typeof h.g.checks)[number];
  h.g.checks = [];
  const missing = await h.controller.merge(1);
  assert.equal(missing.merge.state, 'observing');
  assert.equal(missing.merge.reason, 'required_checks_missing');
  // A stranger's request for changes is not a hold; a write collaborator's is, until withdrawn.
  h.g.checks = [check];
  passChecks(h.g);
  h.g.reviews.push({
    id: 300,
    user: { id: 999, login: 'stranger', type: 'User' },
    state: 'CHANGES_REQUESTED',
    commit_id: head,
    submitted_at: new Date(now()).toISOString(),
  });
  h.g.reviews.push({
    id: 301,
    user: h.g.human,
    state: 'CHANGES_REQUESTED',
    commit_id: head,
    submitted_at: new Date(now()).toISOString(),
  });
  const requested = await h.controller.merge(1);
  assert.equal(requested.merge.state, 'observing');
  assert.equal(requested.merge.reason, 'human_requested_changes');
  assert.equal(h.host.calls.length, 0);
  h.g.reviews = h.g.reviews.filter((review) => review.id !== 301);
  const scanned = await h.controller.scan();
  assert.deepEqual(scanned, [{ taskNumber: 1, state: 'merged', reason: null }]);
  assert.equal(await mergeDecisions(), 1, 'one decision, for the merge that happened');
  assert.equal(h.g.pull.merged, true);
});

test('failed checks and weakened protection keep the record open without a merge; a moved head or base ends it', async () => {
  const failing = await harness();
  failChecks(failing.g);
  const open = await failing.controller.merge(1);
  assert.equal(open.merge.state, 'observing');
  assert.equal(open.merge.reason, 'required_checks_failed');
  assert.equal(failing.host.calls.length, 0);
  // A re-run of the checks that passes lets the same record merge.
  passChecks(failing.g);
  assert.equal((await failing.controller.merge(1)).merge.state, 'merged');
  for (const [name, mutate, state, reason] of [
    [
      'moved head',
      (g: MergeFixture) => {
        g.pull.head.sha = 'f'.repeat(40);
      },
      'blocked',
      'pull_head_changed',
    ],
    [
      'moved base',
      (g: MergeFixture) => {
        g.pull.base.sha = 'f'.repeat(40);
      },
      'blocked',
      'pull_base_changed',
    ],
    [
      'weak protection',
      (g: MergeFixture) => {
        g.protection.enforce_admins = { enabled: false };
      },
      'observing',
      'branch_protection_not_verified',
    ],
  ] as const) {
    await admin.query(TRUNCATE);
    const h = await harness();
    mutate(h.g);
    const result = await h.controller.merge(1);
    assert.equal(result.merge.state, state, name);
    assert.equal(result.merge.reason, reason, name);
    assert.equal(h.host.calls.length, 0, name);
    // A scan skips what is settled and retries what is open, without merging either.
    const scanned = await h.controller.scan();
    if (state === 'blocked') assert.deepEqual(scanned, [], name);
    else assert.equal(scanned[0]?.state, 'observing', name);
    assert.equal(h.host.calls.length, 0, name);
  }
});

test('the merge is re-checked immediately before it happens, and GitHub refusals are recorded and retried only with fresh evidence', async () => {
  const h = await harness();
  // Checks fail between admission and the merge call: the recheck refuses, the admission waits.
  const observe = h.adapters.observe;
  let observations = 0;
  h.adapters.observe = async (pair, expectation) => {
    const observed = await observe(pair, expectation);
    observations++;
    if (observations === 1) failChecks(h.g);
    return observed;
  };
  const drifted = await h.controller.merge(1);
  assert.equal(drifted.merge.state, 'admitted');
  assert.equal(drifted.merge.reason, 'pre_merge_recheck_failed:required_checks_failed');
  assert.equal(observations, 2, 'observed once to decide, once immediately before merging');
  assert.ok(!h.host.calls.includes('merge'));
  assert.equal(h.g.pull.merged, false);
  // The checks pass again: the still-valid admission merges without a second decision.
  passChecks(h.g);
  const merged = await h.controller.merge(1);
  assert.equal(merged.merge.state, 'merged');
  assert.equal(await mergeDecisions(), 1);
  await admin.query(TRUNCATE);
  const refused = await harness();
  refused.host.refuseMerge = 'github_merge_not_allowed';
  const result = await refused.controller.merge(1);
  assert.equal(result.merge.state, 'observing');
  assert.equal(result.merge.reason, 'github_merge_not_allowed');
  assert.equal(refused.g.pull.merged, false);
  assert.deepEqual(refused.reconciled, []);
  // The factory's approval does not outlive the refused attempt.
  assert.deepEqual(refused.host.calls, ['pull', 'approve', 'merge', 'pull', 'dismiss']);
  assert.equal(
    refused.g.reviews.find((review) => review.user.id === MERGER_BOT.id)?.state,
    'DISMISSED',
  );
  // Once GitHub accepts, the same admission merges with a fresh approval.
  refused.host.refuseMerge = null;
  const retried = await refused.controller.merge(1);
  assert.equal(retried.merge.state, 'merged', JSON.stringify(retried.merge));
  assert.equal(refused.host.calls.filter((call) => call === 'approve').length, 2);
  assert.equal(await mergeDecisions(), 1);
});

test('an admission is honoured only under the policy it was decided with, within its TTL, with its approval still standing', async () => {
  // Policy activation between admission and merge: the admission dies, the merge is decided again.
  const h = await harness();
  const perform = h.adapters.perform;
  h.adapters.perform = async () => {
    throw new Error('stop before the merge');
  };
  const first = await h.controller.merge(1);
  assert.equal(first.merge.state, 'admitted', JSON.stringify(first.merge));
  assert.equal(first.merge.reason, 'merge_failed');
  const stricter = policyFixture({
    revision: 2,
    allowedPaths: ['.'],
    approvers: { githubUserIds: [APPROVER_ID] },
    verification: {
      ...h.policy.verification,
      receiptTtlMs: h.policy.verification.receiptTtlMs - 1,
    },
  });
  await h.ledger.activatePolicy(stricter, [], 'owner', now());
  h.adapters.policy = stricter;
  h.adapters.perform = perform;
  // The dead admission is not acted on; the fresh decision is recorded under the new policy and
  // fails closed at consumption because the scope was granted under the replaced policy (the
  // ledger's rule), so nothing merges and nothing is consumed.
  await assert.rejects(h.controller.merge(1), /scope_granted_under_other_policy/);
  const record = await h.merges.forRun(h.run.runId);
  assert.equal(record?.state, 'admitted');
  assert.equal(record?.reason, 'scope_granted_under_other_policy');
  assert.equal(record?.evidence.admission, 2);
  assert.equal(h.g.pull.merged, false);
  assert.ok(!h.host.calls.includes('approve') && !h.host.calls.includes('merge'));
  const rows = await admin.query(
    "SELECT request_id,policy_sha256,consumed_at FROM factory_autonomy_decisions WHERE action='merge' ORDER BY decided_at",
  );
  assert.equal(rows.rows.length, 2, 'the second admission was requested under a new request id');
  assert.notEqual(rows.rows[0].request_id, rows.rows[1].request_id);
  assert.notEqual(rows.rows[0].policy_sha256, rows.rows[1].policy_sha256);
  assert.equal(rows.rows[1].policy_sha256, policyDigest(stricter));
  assert.deepEqual(
    rows.rows.map((row) => row.consumed_at),
    [null, null],
  );
  // An admission older than the TTL is not acted on either.
  await admin.query(TRUNCATE);
  const aged = await harness();
  aged.adapters.perform = async () => {
    throw new Error('stop before the merge');
  };
  assert.equal((await aged.controller.merge(1)).merge.state, 'admitted');
  aged.adapters.perform = perform;
  clock += ADMISSION_TTL_MS + 1;
  const expired = await aged.controller.merge(1);
  assert.equal(expired.merge.state, 'merged');
  assert.equal(expired.merge.evidence.admission, 2);
  assert.equal(expired.decisions.length, 1);
});

test('a critical approval withdrawn after admission stops the merge and spends nothing; a fresh review unlocks it again', async () => {
  const h = await harness({
    changes: manifest(added('.github/workflows/ci.yml', 'on: push\n')),
  });
  approve(h.g);
  h.host.failPerform = 'merger_token_unavailable';
  const admitted = await h.controller.merge(1);
  assert.equal(admitted.merge.state, 'admitted');
  assert.equal(admitted.decisions[0]?.approvedBy, APPROVER_ID);
  // The approver dismisses the review before the merge resumes: the admission dies unconsumed.
  h.g.reviews = [];
  h.host.failPerform = null;
  const stopped = await h.controller.merge(1);
  assert.equal(stopped.merge.state, 'held', JSON.stringify(stopped.merge));
  assert.equal(stopped.merge.reason, 'merge_approval_required');
  assert.equal(stopped.merge.evidence.admission, 2);
  assert.equal(h.g.pull.merged, false);
  assert.ok(!h.host.calls.includes('approve'), 'the factory never approves a critical change');
  assert.ok(!h.host.calls.includes('merge'));
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM factory_autonomy_decisions WHERE action='merge' AND consumed_at IS NOT NULL",
      )
    ).rows[0].n,
    0,
    'nothing was consumed',
  );
  // Approving the exact head again unlocks the same attempt; the admission is consumed at the merge.
  approve(h.g);
  const merged = await h.controller.merge(1);
  assert.equal(merged.merge.state, 'merged', JSON.stringify(merged.merge));
  assert.ok(!h.host.calls.includes('approve'));
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM factory_autonomy_decisions WHERE action='merge' AND consumed_at IS NOT NULL",
      )
    ).rows[0].n,
    1,
  );
});

test('an approval-based admission that expires before the merge is decided again on the same review and merges', async () => {
  const h = await harness({
    changes: manifest(added('.github/workflows/ci.yml', 'on: push\n')),
  });
  approve(h.g);
  h.host.failPerform = 'merger_token_unavailable';
  assert.equal((await h.controller.merge(1)).merge.state, 'admitted');
  h.host.failPerform = null;
  clock += ADMISSION_TTL_MS + 1;
  const merged = await h.controller.merge(1);
  assert.equal(merged.merge.state, 'merged', JSON.stringify(merged.merge));
  assert.equal(merged.merge.evidence.admission, 2);
  assert.equal(merged.decisions.length, 1);
  assert.equal(merged.decisions[0]?.approvedBy, APPROVER_ID);
  assert.ok(!h.host.calls.includes('approve'));
  // The only consumed decision is the one that merged; the first admission spent nothing.
  const rows = await admin.query(
    "SELECT consumed_at IS NOT NULL AS consumed FROM factory_autonomy_decisions WHERE action='merge' ORDER BY decided_at",
  );
  assert.deepEqual(
    rows.rows.map((row) => row.consumed),
    [false, true],
  );
});

test('the residual corner: a consumed admission whose merge call was lost and that expires before settlement spends the approval', async () => {
  const h = await harness({
    changes: manifest(added('.github/workflows/ci.yml', 'on: push\n')),
  });
  approve(h.g);
  h.host.refuseMerge = 'github_connection_failed';
  const uncertain = await h.controller.merge(1);
  assert.equal(uncertain.merge.state, 'unknown');
  h.host.refuseMerge = null;
  clock += ADMISSION_TTL_MS + 1;
  const settled = await h.controller.merge(1);
  assert.equal(settled.merge.state, 'held', JSON.stringify(settled.merge));
  assert.equal(settled.merge.reason, 'approval_already_used');
  assert.equal(h.g.pull.merged, false);
  assert.ok(!h.host.calls.includes('approve'));
  // A scan spends nothing more on it: no decision, no token.
  const decisions = await mergeDecisions();
  const performed = h.host.performed;
  assert.deepEqual(await h.controller.scan(), []);
  assert.equal(await mergeDecisions(), decisions);
  assert.equal(h.host.performed, performed);
});

test('an approver without write access is not an approver: GitHub would refuse the merge, so the approval is never spent on it', async () => {
  const h = await harness({
    changes: manifest(added('.github/workflows/ci.yml', 'on: push\n')),
  });
  h.g.permission = 'read';
  approve(h.g);
  const held = await h.controller.merge(1);
  assert.equal(held.merge.state, 'held');
  assert.equal(held.merge.reason, 'merge_approval_required');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM factory_autonomy_approvals')).rows[0].n,
    0,
  );
  h.g.permission = 'write';
  assert.equal((await h.controller.merge(1)).merge.state, 'merged');
});

test('a lingering factory approval is dismissed when the admission it belonged to dies', async () => {
  const h = await harness();
  // The merge call was lost after the approval: uncertain, approval standing, pull request open.
  h.host.refuseMerge = 'github_connection_failed';
  assert.equal((await h.controller.merge(1)).merge.state, 'unknown');
  assert.equal(h.g.reviews.find((review) => review.user.id === MERGER_BOT.id)?.state, 'APPROVED');
  h.host.refuseMerge = null;
  clock += ADMISSION_TTL_MS + 1;
  const merged = await h.controller.merge(1);
  assert.equal(merged.merge.state, 'merged', JSON.stringify(merged.merge));
  // The dead admission's approval was dismissed before the new decision approved again.
  const bot = h.g.reviews.filter((review) => review.user.id === MERGER_BOT.id);
  assert.deepEqual(
    bot.map((review) => review.state),
    ['DISMISSED', 'APPROVED'],
  );
  assert.ok(h.host.calls.indexOf('dismiss') < h.host.calls.lastIndexOf('approve'));
});

test('a merge whose Task reconciliation did not complete is reconciled again by the next scan', async () => {
  const h = await harness();
  let attempts = 0;
  h.adapters.afterMerge = async (_run, merge) => {
    attempts++;
    if (attempts === 1) throw new Error('gate_parked:pre_merge_observation_stale');
    h.reconciled.push(merge.mergeCommit ?? '');
  };
  const merged = await h.controller.merge(1);
  assert.equal(merged.merge.state, 'merged');
  assert.equal(merged.merge.evidence.reconciled, false);
  assert.equal(merged.merge.evidence.reconcileError, 'gate_parked:pre_merge_observation_stale');
  const scanned = await h.controller.scan();
  assert.deepEqual(scanned, [{ taskNumber: 1, state: 'merged', reason: null }]);
  const record = await h.merges.forRun(h.run.runId);
  assert.equal(record?.evidence.reconciled, true);
  assert.equal(record?.evidence.reconcileError, null);
  assert.deepEqual(h.reconciled, [MERGE_COMMIT]);
  assert.deepEqual(await h.controller.scan(), [], 'reconciled: nothing left to do');
  assert.equal(h.host.calls.filter((call) => call === 'merge').length, 1);
});

test('a controller holding a stale copy of the policy does not act, even on an admission decided under the active one', async () => {
  const h = await harness();
  h.host.failPerform = 'merger_token_unavailable';
  const admitted = await h.controller.merge(1);
  assert.equal(admitted.merge.state, 'admitted', JSON.stringify(admitted.merge));
  // A controller process whose policy file is not the active policy must not act on the admission.
  h.host.failPerform = null;
  const stale = policyFixture({
    revision: 2,
    allowedPaths: ['.'],
    approvers: { githubUserIds: [APPROVER_ID] },
    verification: {
      ...h.policy.verification,
      receiptTtlMs: h.policy.verification.receiptTtlMs - 1,
    },
  });
  h.adapters.policy = stale;
  await assert.rejects(h.controller.merge(1), /policy_not_active/);
  assert.equal(h.g.pull.merged, false);
  assert.ok(!h.host.calls.includes('merge'));
  // The controller holding the active policy merges it.
  h.adapters.policy = h.policy;
  assert.equal((await h.controller.merge(1)).merge.state, 'merged');
});

test('a scan leaves an unapproved hold alone and gives up after repeated GitHub refusals; the explicit command retries', async () => {
  const held = await harness({
    changes: manifest(added('.github/workflows/ci.yml', 'on: push\n')),
  });
  assert.equal((await held.controller.merge(1)).merge.state, 'held');
  assert.equal(await mergeDecisions(), 1);
  assert.deepEqual(await held.controller.scan(), [
    { taskNumber: 1, state: 'held', reason: 'merge_approval_required' },
  ]);
  assert.equal(await mergeDecisions(), 1, 'a scan records no decision for an unapproved hold');
  approve(held.g);
  assert.equal((await held.controller.scan())[0]?.state, 'merged');
  await admin.query(TRUNCATE);
  const refused = await harness();
  refused.host.refuseMerge = 'github_merge_not_allowed';
  assert.equal((await refused.controller.merge(1)).merge.reason, 'github_merge_not_allowed');
  assert.equal((await refused.controller.scan())[0]?.state, 'observing');
  assert.equal((await refused.controller.scan())[0]?.state, 'observing');
  assert.equal((await refused.merges.forRun(refused.run.runId))?.evidence.refusals, 3);
  assert.deepEqual(await refused.controller.scan(), [], 'three refusals: left to the operator');
  assert.equal(refused.host.calls.filter((call) => call === 'merge').length, 3);
  refused.host.refuseMerge = null;
  const merged = await refused.controller.merge(1);
  assert.equal(merged.merge.state, 'merged', JSON.stringify(merged.merge));
  // One approval per merge call, each dismissed with its refusal; none lingers on the head.
  assert.equal(refused.host.calls.filter((call) => call === 'approve').length, 4);
  assert.equal(refused.host.calls.filter((call) => call === 'dismiss').length, 3);
});

test('a failure before any GitHub write keeps the admission for the next scan; a lost connection after the merge is settled by verifying it', async () => {
  const h = await harness();
  h.host.failPerform = 'merger_token_unavailable';
  const deferred = await h.controller.merge(1);
  assert.equal(deferred.merge.state, 'admitted');
  assert.equal(deferred.merge.reason, 'merger_token_unavailable');
  assert.equal(h.host.calls.length, 0);
  h.host.failPerform = null;
  h.host.crashAfterMerge = true;
  const uncertain = await h.controller.merge(1);
  assert.equal(uncertain.merge.state, 'unknown');
  assert.equal(uncertain.merge.reason, 'github_connection_failed');
  assert.equal(h.g.pull.merged, true, 'GitHub did merge');
  // A scan leaves an uncertain merge to the operator.
  assert.deepEqual(await h.controller.scan(), []);
  // The operator's explicit command settles it from GitHub's facts, never by merging again.
  const merges = h.host.calls.filter((call) => call === 'merge').length;
  const verified = await h.controller.merge(1);
  assert.equal(verified.merge.state, 'merged', JSON.stringify(verified.merge));
  assert.equal(verified.merge.mergeCommit, MERGE_COMMIT);
  assert.equal(h.host.calls.filter((call) => call === 'merge').length, merges, 'no second merge');
  assert.deepEqual(h.reconciled, [MERGE_COMMIT]);
});

test('an uncertain merge whose pull request is still open and untouched resumes; a closed one ends', async () => {
  const h = await harness();
  // Uncertainty with nothing merged (the connection dropped as the merge call went out).
  h.host.refuseMerge = 'github_connection_failed';
  const observe = h.adapters.observe;
  const uncertain = await h.controller.merge(1);
  assert.equal(uncertain.merge.state, 'unknown');
  assert.equal(h.g.pull.merged, false);
  h.host.refuseMerge = null;
  h.adapters.observe = observe;
  const resumed = await h.controller.merge(1);
  assert.equal(resumed.merge.state, 'merged', JSON.stringify(resumed.merge));
  assert.equal(await mergeDecisions(), 1, 'the consumed admission was resumed, not repeated');
  await admin.query(TRUNCATE);
  const closed = await harness();
  closed.host.refuseMerge = 'github_connection_failed';
  assert.equal((await closed.controller.merge(1)).merge.state, 'unknown');
  closed.g.pull.state = 'closed';
  const ended = await closed.controller.merge(1);
  assert.equal(ended.merge.state, 'blocked');
  assert.equal(ended.merge.reason, 'pull_closed_without_merge');
});

test('a merge commit that is not the tested tree on the observed base stays uncertain, a merge by someone else ends the record, and pause holds everything', async () => {
  const h = await harness();
  h.host.mergeTreeOverride = 'f'.repeat(40);
  const mismatch = await h.controller.merge(1);
  assert.equal(mismatch.merge.state, 'unknown');
  assert.equal(mismatch.merge.reason, 'merge_proof_mismatch');
  assert.deepEqual(h.reconciled, [], 'an unproven merge is never reconciled');
  const settled = await h.controller.merge(1);
  assert.equal(settled.merge.state, 'unknown');
  assert.equal(settled.merge.reason, 'merge_proof_mismatch');
  assert.deepEqual(h.reconciled, []);
  await admin.query(TRUNCATE);
  const human = await harness();
  human.g.merge();
  const other = await human.controller.merge(1);
  assert.equal(other.merge.state, 'blocked');
  // The fixture's human merge moves the base as GitHub does; either identity change ends the record.
  assert.ok(
    ['pull_base_changed', 'pull_not_open'].includes(other.merge.reason ?? ''),
    other.merge.reason ?? '',
  );
  assert.equal(human.host.calls.length, 0);
  await admin.query(TRUNCATE);
  const paused = await harness();
  await paused.ledger.setPaused(REPOSITORY.id, true, 'incident', 'owner', now());
  await assert.rejects(paused.controller.merge(1), /autonomy_paused/);
  assert.equal(paused.host.calls.length, 0);
  await paused.ledger.setPaused(REPOSITORY.id, false, null, 'owner', now());
  await paused.ledger.revokeScope('goal-1', 'closed', 'owner', now());
  await assert.rejects(paused.controller.merge(1), /scope_revoked/);
});

test('expired receipts are replaced by fresh verification of the published head before deciding, or the merge waits', async () => {
  const stale = await harness({ receiptAge: policyFixture().verification.receiptTtlMs + 60_000 });
  const refused = await stale.controller.merge(1);
  assert.equal(refused.merge.state, 'observing');
  assert.equal(refused.merge.reason, 'acceptance_receipt_stale');
  await admin.query(TRUNCATE);
  const fresh = await harness({ receiptAge: policyFixture().verification.receiptTtlMs + 60_000 });
  let reverified = 0;
  fresh.adapters.reverify = async (run) => {
    reverified++;
    const bound = requestFor(fresh.policy, 'merge', run.evidence.manifest as ChangeManifest, {
      task: { id: TASK_ID, intentSha256: run.intentSha256 as string, intentKind: 'change' },
      base,
      head,
      tree: fresh.g.headTree,
    });
    return {
      acceptance: acceptanceFor(fresh.policy, bound, { completedAt: now() }),
      review: reviewFor(fresh.policy, bound, { completedAt: now() }),
    };
  };
  // Nothing is re-verified while the observation alone refuses: no paid work for a wait.
  failChecks(fresh.g, null);
  assert.equal((await fresh.controller.merge(1)).merge.reason, 'required_checks_pending');
  assert.equal(reverified, 0);
  passChecks(fresh.g);
  const merged = await fresh.controller.merge(1);
  assert.equal(merged.merge.state, 'merged', JSON.stringify(merged.merge));
  assert.equal(reverified, 1);
});
