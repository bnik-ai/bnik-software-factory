import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dependencyStates,
  inspectGate,
  pairPull,
  reviewEvidence,
} from '../src/github/merge-gate.js';
import {
  classifyChecks,
  latestReviews,
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
  // Automatic profile: the merger App's approval counts only for the App's own merge.
  const automatic = { ...policy, merger: { appSlug: 'factory-merger', appId: 7001 } };
  const botApproval = {
    ...present(g.reviews[0]),
    id: 9,
    user: { id: 9001, login: 'factory-merger[bot]', type: 'Bot' },
  };
  assert.throws(
    () => verifyReviews(automatic, [botApproval], head, 44),
    /human_approval_missing_or_stale/,
  );
  assert.throws(() => verifyReviews(automatic, [botApproval], head, 44, undefined, false));
  assert.equal(verifyReviews(automatic, [botApproval], head, 44, undefined, true).length, 1);
  assert.throws(() => verifyReviews(policy, [botApproval], head, 44, undefined, true));
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
test("the merger App's merge counts a change request as the automatic-merge observation does; any other merge, anyone's", async () => {
  const g = new MergeFixture();
  g.config.mergePolicy = { ...policy, merger: { appSlug: 'factory-merger', appId: 7001 } };
  const bot = { id: 9001, login: 'factory-merger[bot]', type: 'Bot' };
  g.merge();
  g.pull.merged_by = bot;
  const approval = { ...present(g.reviews[0]), id: 9, user: bot };
  const request = (user: { id: number; login: string; type: string }) => ({
    id: 10,
    user,
    state: 'CHANGES_REQUESTED',
    commit_id: head,
    submitted_at: '2026-01-01T00:00:00Z',
  });
  const stranger = { id: 999, login: 'stranger', type: 'User' };
  g.reviews = [approval, request(stranger)];
  assert.equal((await reviewEvidence(g.config, g, g.pull)).reviews.length, 1);
  g.reviews = [approval, request(g.human)];
  g.permission = 'read';
  assert.equal((await reviewEvidence(g.config, g, g.pull)).reviews.length, 1);
  g.permission = 'write';
  await assert.rejects(reviewEvidence(g.config, g, g.pull), /changes_requested/);
  g.reviews = [approval, request({ id: 777, login: 'some-app[bot]', type: 'Bot' })];
  await assert.rejects(reviewEvidence(g.config, g, g.pull), /changes_requested/);
  g.reviews = [approval, request({ id: 778, login: 'someone', type: 'Organization' })];
  assert.equal((await reviewEvidence(g.config, g, g.pull)).reviews.length, 1);
  // A human's merge, under either profile: any user's latest change request parks.
  g.pull.merged_by = g.human;
  for (const mergePolicy of [g.config.mergePolicy, policy]) {
    g.config.mergePolicy = mergePolicy;
    g.reviews = [present(new MergeFixture().reviews[0]), request(stranger)];
    await assert.rejects(reviewEvidence(g.config, g, g.pull), /changes_requested/);
  }
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

test('the automatic-merge profile names the merger App and reshapes the protection it accepts', () => {
  const automatic = parseMergePolicy({
    ...policy,
    merger: { appSlug: 'factory-merger', appId: 9001 },
  });
  assert.deepEqual(automatic.merger, { appSlug: 'factory-merger', appId: 9001 });
  for (const merger of [
    { appSlug: 'Factory Merger', appId: 9001 },
    { appSlug: 'factory-merger', appId: 0 },
    { appSlug: 'factory-merger', appId: 9001, extra: true },
    'factory-merger',
  ])
    assert.throws(() => parseMergePolicy({ ...policy, merger }), /merge_policy_merger_invalid/);
  const g = new MergeFixture();
  // The human profile protection is not enough for automatic merges, and vice versa.
  assert.throws(
    () => verifyProtection(automatic, g.protection, g.owners),
    /automatic_review_protection_missing/,
  );
  const protection = structuredClone(g.protection);
  protection.required_pull_request_reviews = {
    ...(protection.required_pull_request_reviews as NonNullable<
      typeof protection.required_pull_request_reviews
    >),
    require_code_owner_reviews: false,
  };
  assert.throws(
    () => verifyProtection(automatic, protection, g.owners),
    /automatic_merge_restriction_missing/,
  );
  protection.restrictions = {
    users: [{ login: 'example-maintainer' }],
    teams: [],
    apps: [{ slug: 'factory-merger' }],
  };
  verifyProtection(automatic, protection, g.owners);
  assert.throws(
    () => verifyProtection(policy, protection, g.owners),
    /human_review_protection_missing/,
  );
  protection.restrictions.apps = [{ slug: 'factory-merger' }, { slug: 'other-app' }];
  assert.throws(
    () => verifyProtection(automatic, protection, g.owners),
    /automatic_merge_restriction_missing/,
  );
  protection.restrictions.apps = [{ slug: 'other-app' }];
  assert.throws(
    () => verifyProtection(automatic, protection, g.owners),
    /automatic_merge_restriction_missing/,
  );
  // Nothing may bypass either profile.
  protection.restrictions.apps = [{ slug: 'factory-merger' }];
  (
    protection.required_pull_request_reviews as NonNullable<
      typeof protection.required_pull_request_reviews
    >
  ).bypass_pull_request_allowances = { apps: [{}] };
  assert.throws(
    () => verifyProtection(automatic, protection, g.owners),
    /automatic_review_protection_missing/,
  );
});

test('required checks are graded for the observation: the latest trusted attempt per check decides', () => {
  const g = new MergeFixture();
  const run = present(g.checks[0]);
  assert.equal(classifyChecks(policy, g.checks, head), 'passed');
  assert.equal(classifyChecks(policy, [], head), 'missing');
  assert.equal(classifyChecks(policy, [{ ...run, head_sha: base }], head), 'missing');
  assert.equal(classifyChecks(policy, [{ ...run, app: { id: 321 } }], head), 'missing');
  assert.equal(
    classifyChecks(policy, [{ ...run, status: 'in_progress', conclusion: null }], head),
    'pending',
  );
  assert.equal(classifyChecks(policy, [{ ...run, conclusion: 'failure' }], head), 'failed');
  assert.equal(classifyChecks(policy, [{ ...run, conclusion: 'neutral' }], head), 'failed');
  assert.equal(
    classifyChecks(policy, [run, { ...run, id: 2, conclusion: 'failure' }], head),
    'failed',
  );
  assert.equal(
    classifyChecks(
      policy,
      [
        { ...run, conclusion: 'failure' },
        { ...run, id: 2 },
      ],
      head,
    ),
    'passed',
  );
  assert.deepEqual(
    latestReviews([
      ...g.reviews,
      { ...present(g.reviews[0]), id: 2, state: 'COMMENTED' },
      {
        ...present(g.reviews[0]),
        id: 3,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-01-03T00:00:00Z',
      },
    ]).map((r) => r.id),
    [3],
  );
  assert.deepEqual(latestReviews(g.reviews, 0), []);
});
