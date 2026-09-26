import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dependencyStates,
  inspectGate,
  pairPull,
  reviewEvidence,
} from '../src/github/merge-gate.js';
import {
  parseMergePolicy,
  verifyChecks,
  verifyProtection,
  verifyReviews,
} from '../src/github/merge-policy.js';
import { MergeFixture, base, head, policy } from './merge-fixtures.js';

test('merge policy is explicit and rejects untrusted producers, duplicate users and unknown keys', () => {
  assert.deepEqual(parseMergePolicy(policy), policy);
  for (const p of [
    { ...policy, merge: true },
    { ...policy, requiredChecks: [] },
    { ...policy, reviewers: ['example-maintainer', 'example-maintainer'] },
    { ...policy, requiredChecks: [{ name: 'test', appId: -1 }] },
  ])
    assert.throws(() => parseMergePolicy(p));
});
test('native protection must require fresh human ownership, strict trusted checks, no bypass and restricted human merge', () => {
  const g = new MergeFixture();
  verifyProtection(policy, g.protection, g.owners);
  const mutations = [
    () => {
      present(g.protection.required_pull_request_reviews).dismiss_stale_reviews = false;
    },
    () => {
      present(g.protection.required_pull_request_reviews).require_code_owner_reviews = false;
    },
    () => {
      present(g.protection.required_pull_request_reviews).require_last_push_approval = false;
    },
    () => {
      present(g.protection.required_pull_request_reviews).bypass_pull_request_allowances = {
        apps: [{}],
      };
    },
    () => {
      present(present(g.protection.required_status_checks).checks[0]).app_id = -1;
    },
    () => {
      present(g.protection.required_status_checks).strict = false;
    },
    () => {
      present(g.protection.enforce_admins).enabled = false;
    },
    () => {
      present(g.protection.restrictions).apps.push({});
    },
    () => {
      g.owners += 'src/* @factory-bot\n';
    },
  ];
  for (const mutate of mutations) {
    g.protection = structuredClone(new MergeFixture().protection);
    g.owners = '* @example-maintainer\n';
    mutate();
    assert.throws(() => verifyProtection(policy, g.protection, g.owners));
  }
});
test('native human approval is tied to exact head and cannot be replaced by bots, self approval or stale review', () => {
  const g = new MergeFixture();
  assert.equal(verifyReviews(policy, g.reviews, head, 44).length, 1);
  for (const change of [
    { commit_id: base },
    { user: { ...g.human, type: 'Bot' } },
    { user: { ...g.human, id: 44 } },
    { state: 'DISMISSED' },
    { state: 'CHANGES_REQUESTED' },
  ])
    assert.throws(() => verifyReviews(policy, [{ ...present(g.reviews[0]), ...change }], head, 44));
  assert.throws(() =>
    verifyReviews(
      policy,
      [...g.reviews, { ...present(g.reviews[0]), id: 2, state: 'CHANGES_REQUESTED' }],
      head,
      44,
    ),
  );
  assert.throws(() => verifyReviews(policy, g.reviews, head, 44, 0));
});
test('required CI uses latest attempt from trusted App on exact head and fails closed', () => {
  const g = new MergeFixture();
  assert.equal(verifyChecks(policy, g.checks, head).length, 1);
  for (const change of [
    { head_sha: base },
    { app: { id: 321 } },
    { conclusion: 'failure' },
    { conclusion: 'neutral' },
    { status: 'in_progress' },
    { completed_at: null },
  ])
    assert.throws(() => verifyChecks(policy, [{ ...present(g.checks[0]), ...change }], head));
  assert.throws(() =>
    verifyChecks(
      policy,
      [...g.checks, { ...present(g.checks[0]), id: 2, conclusion: 'failure' }],
      head,
    ),
  );
});
test('trusted pairing and inspection reject changed task identity, body, scope and unsafe repository settings', async () => {
  const g = new MergeFixture();
  const pair = await pairPull(g.config, g, 1, 2, head);
  await inspectGate(g.config, g, pair);
  await reviewEvidence(g.config, g, g.pull);
  g.task.body += '\nchanged';
  await assert.rejects(inspectGate(g.config, g, pair), /paired_task_changed/);
  g.task.body = 'pr-ref: PR_FIXTURE';
  g.repo.allow_auto_merge = true;
  await assert.rejects(inspectGate(g.config, g, pair), /repository_merge_settings_unsafe/);
  g.repo.allow_auto_merge = false;
  g.pull.head.repo = { id: 99 };
  await assert.rejects(inspectGate(g.config, g, pair), /paired_pull_changed/);
});
test('merge requires prior matching protection/head/base observation and configured human merger', async () => {
  const g = new MergeFixture();
  const pair = await pairPull(g.config, g, 1, 2, head);
  const seen = await inspectGate(g.config, g, pair);
  g.merge();
  await inspectGate(g.config, g, pair, seen.foundation);
  await reviewEvidence(g.config, g, g.pull);
  await assert.rejects(inspectGate(g.config, g, pair), /pre_merge_observation_missing/);
  await assert.rejects(
    inspectGate(g.config, g, pair, { ...seen.foundation, head: base }),
    /pre_merge_observation_stale/,
  );
  g.pull.merged_by = { ...g.human, type: 'Bot' };
  await assert.rejects(
    inspectGate(g.config, g, pair, seen.foundation),
    /merge_actor_not_configured_human/,
  );
  g.pull.merged_by = g.human;
  g.parents = [{ sha: head }];
  await assert.rejects(inspectGate(g.config, g, pair, seen.foundation), /merge_base_differs/);
});
test('dependencies reuse inline and issue-form parsing, clear only terminal Tasks and fail closed on missing/ambiguous refs', () => {
  const g = new MergeFixture();
  assert.equal(dependencyStates([g.task, g.dependent])[1]?.state, 'blocked');
  g.task.labels = [{ name: 'kind:task' }, { name: 'status:done' }];
  g.task.state = 'closed';
  for (const body of ['blocked-by: I_FIXTURE', '### blocked-by\n\nI_FIXTURE']) {
    g.dependent.body = body;
    assert.equal(dependencyStates([g.task, g.dependent])[0]?.state, 'clear');
  }
  for (const body of [
    'blocked-by: missing',
    'blocked-by: I_DEPENDENT',
    'blocked-by: I_FIXTURE\nblocked-by: missing',
  ]) {
    g.dependent.body = body;
    assert.equal(dependencyStates([g.task, g.dependent])[0]?.state, 'blocked');
  }
});

function present<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}
