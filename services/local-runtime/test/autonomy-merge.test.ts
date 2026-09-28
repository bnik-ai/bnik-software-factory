import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeGateReasons } from '../src/autonomy/evidence.js';
import {
  approvalsFromReviews,
  headRepositoryIds,
  observeMergeGate,
} from '../src/autonomy/merge.js';
import type { AutonomyConfig } from '../src/config.js';
import { NOW, policyFixture } from './autonomy-fixtures.js';
import { MergeFixture, base, head, policy } from './merge-fixtures.js';

const now = () => NOW;
/** The merge policy's reviewer logins, which reconciliation accepts approvals from. */
const REVIEWERS = policy.reviewers;

test('the intent digest ignores the pairing backlink publication writes, and nothing else', async () => {
  const { intentDigest } = await import('../src/autonomy/controller.js');
  const proposed = {
    title: 'Fix sum',
    body: 'sum must add.\n\n```factory-task\n{}\n```',
    definition: { prompt: 'Fix sum', tests: [], maxTurns: 2, timeoutMs: 30_000 },
    intentKind: 'change' as const,
  };
  const paired = { ...proposed, body: `${proposed.body}\n\npr-ref: PR_FIXTURE\n` };
  assert.equal(intentDigest(paired), intentDigest(proposed));
  assert.equal(
    intentDigest({ ...proposed, body: `  pr-ref: X\n${proposed.body}` }),
    intentDigest(proposed),
  );
  assert.notEqual(
    intentDigest({ ...proposed, body: `${proposed.body}\nchanged` }),
    intentDigest(proposed),
  );
  assert.notEqual(
    intentDigest({ ...proposed, body: `${proposed.body}\nnot-pr-ref: X` }),
    intentDigest(proposed),
  );
  assert.notEqual(intentDigest({ ...proposed, title: 'Other' }), intentDigest(proposed));
});
const DIGEST = 'e'.repeat(64);

test('the merge-gate observation reports GitHub facts the policy can decide on', async () => {
  const g = new MergeFixture();
  const { pairPull } = await import('../src/github/merge-gate.js');
  const pair = await pairPull(g.config, g, 1, 2, head);
  const observed = await observeMergeGate(g.config, g, pair, { head, tree: g.headTree, base }, now);
  assert.deepEqual(observed.observation, {
    version: 1,
    kind: 'merge_gate',
    repositoryId: 42,
    pullNumber: 2,
    head,
    headTree: g.headTree,
    base,
    baseBranch: 'main',
    pullState: 'open',
    requiredChecks: 'passed',
    changesRequested: false,
    protectionVerified: true,
    observedAt: NOW,
  });
  assert.equal(observed.protectionReason, null);
  // The OSS-19 rules accept it for exactly this head, tree and base.
  const target = { repositoryId: 42, baseBranch: 'main', head, tree: g.headTree, base };
  assert.deepEqual(mergeGateReasons(target, observed.observation, NOW), []);
  assert.equal(
    mergeGateReasons({ ...target, tree: 'f'.repeat(40) }, observed.observation, NOW)[0]?.code,
    'published_tree_differs_from_tested_tree',
  );
  // Graded facts instead of opaque failures: pending checks, a change request, weak protection.
  g.checks[0] = {
    ...(g.checks[0] as (typeof g.checks)[number]),
    status: 'in_progress',
    conclusion: null,
  };
  g.reviews.push({
    id: 9,
    user: g.human,
    state: 'CHANGES_REQUESTED',
    commit_id: head,
    submitted_at: '2026-01-02T00:00:00Z',
  });
  g.protection.enforce_admins = { enabled: false };
  const degraded = await observeMergeGate(g.config, g, pair, { head, tree: g.headTree, base }, now);
  assert.equal(degraded.observation.requiredChecks, 'pending');
  assert.equal(degraded.observation.changesRequested, true);
  assert.equal(degraded.observation.protectionVerified, false);
  assert.equal(degraded.protectionReason, 'branch_protection_unsafe');
  assert.deepEqual(degraded.reviewers, ['example-maintainer']);
  const reasons = mergeGateReasons(target, degraded.observation, NOW).map((r) => r.code);
  assert.deepEqual(reasons, ['branch_protection_not_verified']);
  // As on GitHub, a request for changes counts only from a human with write access.
  g.reviews = [
    {
      id: 3,
      user: { id: 999, login: 'stranger', type: 'User' },
      state: 'CHANGES_REQUESTED',
      commit_id: head,
      submitted_at: '2026-01-02T00:00:00Z',
    },
  ];
  const stranger = await observeMergeGate(g.config, g, pair, { head, tree: g.headTree, base }, now);
  assert.equal(stranger.observation.changesRequested, false);
  g.reviews[0] = { ...(g.reviews[0] as (typeof g.reviews)[number]), user: g.human };
  g.permission = 'read';
  const reader = await observeMergeGate(g.config, g, pair, { head, tree: g.headTree, base }, now);
  assert.equal(reader.observation.changesRequested, false);
  g.permission = 'write';
  const writer = await observeMergeGate(g.config, g, pair, { head, tree: g.headTree, base }, now);
  assert.equal(writer.observation.changesRequested, true);
  // An approval by a listed reviewer without write access is one GitHub ignores: dropped here too.
  g.reviews = [
    {
      id: 4,
      user: g.human,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2026-01-02T00:00:00Z',
    },
  ];
  g.permission = 'read';
  const unprivileged = await observeMergeGate(
    g.config,
    g,
    pair,
    { head, tree: g.headTree, base },
    now,
  );
  assert.deepEqual(unprivileged.reviews, []);
  g.permission = 'write';
  const privileged = await observeMergeGate(
    g.config,
    g,
    pair,
    { head, tree: g.headTree, base },
    now,
  );
  assert.equal(privileged.reviews.length, 1);
  g.reviews[0] = { ...(g.reviews[0] as (typeof g.reviews)[number]), state: 'CHANGES_REQUESTED' };
  // An installed App's request for changes blocks on GitHub too.
  g.reviews[0] = {
    ...(g.reviews[0] as (typeof g.reviews)[number]),
    user: { id: 777, login: 'some-app[bot]', type: 'Bot' },
  };
  const app = await observeMergeGate(g.config, g, pair, { head, tree: g.headTree, base }, now);
  assert.equal(app.observation.changesRequested, true);
});

test('a pull request head on the configured fork is accepted; any other repository is refused', async () => {
  const g = new MergeFixture();
  const { pairPull } = await import('../src/github/merge-gate.js');
  g.pull.head.repo = { id: 77 };
  await assert.rejects(pairPull(g.config, g, 1, 2, head), /paired_pull_changed_or_unsafe/);
  assert.deepEqual(headRepositoryIds(g.config), [42]);
  g.config.autonomy = {
    publisher: { mode: 'fork', forkRepositoryId: 77, forkRepository: 'factory-bot/factory-demo' },
  } as unknown as AutonomyConfig;
  assert.deepEqual(headRepositoryIds(g.config), [42, 77]);
  const pair = await pairPull(g.config, g, 1, 2, head, {
    headRepositoryIds: headRepositoryIds(g.config),
  });
  const observed = await observeMergeGate(g.config, g, pair, { head, tree: g.headTree, base }, now);
  assert.equal(observed.observation.head, head);
  g.pull.head.repo = { id: 78 };
  await assert.rejects(
    observeMergeGate(g.config, g, pair, { head, tree: g.headTree, base }, now),
    /paired_pull_changed_or_unsafe/,
  );
});

test('only a configured human approver reviewing the exact head yields a merge approval', () => {
  const g = new MergeFixture();
  const autonomy = policyFixture({ approvers: { githubUserIds: [g.human.id] } });
  const author = g.pull.user.id;
  const approved = approvalsFromReviews(autonomy, g.reviews, head, author, DIGEST, REVIEWERS);
  assert.equal(approved.length, 1);
  assert.deepEqual(approved[0]?.approval, {
    version: 1,
    kind: 'approval',
    actionSha256: DIGEST,
    action: 'merge',
    approver: { githubUserId: g.human.id, type: 'User' },
    source: 'github_review',
    approvedAt: Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.deepEqual(approved[0]?.evidence, { reviewId: 1, head });
  const review = g.reviews[0] as (typeof g.reviews)[number];
  for (const change of [
    { commit_id: base },
    { user: { ...g.human, type: 'Bot' } },
    { user: { ...g.human, id: 999 } },
    { user: { ...g.human, id: author } },
    { state: 'DISMISSED' },
    { state: 'COMMENTED' },
  ])
    assert.equal(
      approvalsFromReviews(autonomy, [{ ...review, ...change }], head, author, DIGEST, REVIEWERS)
        .length,
      0,
      JSON.stringify(change),
    );
  // A later request for changes by the same approver supersedes the approval.
  assert.equal(
    approvalsFromReviews(
      autonomy,
      [
        review,
        { ...review, id: 2, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-02T00:00:00Z' },
      ],
      head,
      author,
      DIGEST,
      REVIEWERS,
    ).length,
    0,
  );
  // An approver the merge policy does not list as a reviewer cannot unlock a merge the gate would park.
  assert.equal(approvalsFromReviews(autonomy, g.reviews, head, author, DIGEST, []).length, 0);
  assert.throws(
    () => approvalsFromReviews(autonomy, g.reviews, head, author, 'nope', REVIEWERS),
    /approval_action_invalid/,
  );
  assert.equal(
    approvalsFromReviews(policyFixture(), g.reviews, head, author, DIGEST, REVIEWERS).length,
    0,
    'unlisted approver',
  );
  assert.equal(policy.merger, undefined);
});
