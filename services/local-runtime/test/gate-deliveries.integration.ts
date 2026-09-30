import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { GitHubIntake } from '../src/github/intake.js';
import { HumanMergeGate } from '../src/github/reconcile.js';
import { liveConfig } from './github-fixtures.js';
import { initialize, reset } from './helpers.js';
import { MergeFixture, policy } from './merge-fixtures.js';

let admin: Pool;
let pool: Pool;
before(async () => {
  ({ admin, pool } = await initialize());
});
beforeEach(async () => {
  await reset(admin);
  await admin.query(
    'TRUNCATE factory_pr_pairs,factory_pr_observations,factory_merge_receipts,factory_pr_state,factory_dependency_state',
  );
});
after(async () => {
  await pool?.end();
  await admin?.end();
});

const scope = {
  installation: { id: 7 },
  repository: { id: 42, full_name: 'example/factory-demo' },
};
/** Pending or running gate looks, with the delivery keys that queued them. */
async function looks() {
  return (
    await admin.query<{ pull: number; key: string }>(
      "SELECT (body->>'pull')::int AS pull, delivery_key AS key FROM factory_work WHERE queue_name='HumanMergeGate' AND state IN ('pending','running') ORDER BY id",
    )
  ).rows;
}
async function deliver(intake: GitHubIntake, event: string, body: object) {
  await intake.accept(randomUUID(), event, JSON.stringify({ ...scope, ...body }));
  assert.equal(await intake.step(), true);
}
async function tracked() {
  const github = new MergeFixture();
  const gate = new HumanMergeGate(pool, github.config, github);
  const intake = new GitHubIntake(pool, github.config, github);
  await gate.track(1, 2, github.pull.head.sha);
  assert.equal(await gate.step(), true);
  assert.deepEqual(await looks(), []);
  return { github, gate, intake };
}

test('a delivery that can change the gate evidence queues its look at once, one at a time', async () => {
  const { github, gate, intake } = await tracked();
  const head = github.pull.head.sha;
  try {
    await deliver(intake, 'pull_request_review', {
      action: 'submitted',
      pull_request: { number: 2 },
      review: { user: { login: 'Example-Maintainer' } },
    });
    const queued = await looks();
    assert.deepEqual(
      queued.map((l) => l.pull),
      [2],
    );
    assert.match(queued[0]?.key ?? '', /^42:2:delivery:/);
    // A second delivery while that look is pending adds nothing.
    await deliver(intake, 'pull_request', { action: 'synchronize', pull_request: { number: 2 } });
    assert.equal((await looks()).length, 1);
    assert.equal(await gate.step(), true);
    const deliveries: [string, object][] = [
      ['check_run', { action: 'completed', check_run: { head_sha: head, pull_requests: [] } }],
      [
        'check_suite',
        {
          action: 'completed',
          check_suite: {
            head_sha: 'f'.repeat(40),
            pull_requests: [{ number: 2, base: { repo: { id: 42 } } }],
          },
        },
      ],
      ['issues', { action: 'edited', issue: { number: 1 } }],
      ['issues', { action: 'locked', issue: { number: 1 } }],
      ['issues', { action: 'unlocked', issue: { number: 1 } }],
      [
        'pull_request_review',
        {
          action: 'dismissed',
          pull_request: { number: 2 },
          review: { user: { login: 'someone-else' } },
        },
      ],
    ];
    for (const [event, payload] of deliveries) {
      await deliver(intake, event, payload);
      assert.deepEqual(
        (await looks()).map((l) => l.pull),
        [2],
        event,
      );
      assert.equal(await gate.step(), true);
    }
  } finally {
    await gate.close();
    await intake.close();
  }
});

test('deliveries without gate evidence, or about untracked or reconciled pull requests, queue nothing', async () => {
  const { github, gate, intake } = await tracked();
  const head = github.pull.head.sha;
  try {
    const ignored: [string, object][] = [
      ['pull_request', { action: 'opened', pull_request: { number: 3 } }],
      ['status', { sha: head, state: 'success' }],
      ['status', { sha: head, state: 'failure' }],
      [
        'check_run',
        { action: 'completed', check_run: { head_sha: 'not-a-sha', pull_requests: [] } },
      ],
      [
        'check_suite',
        {
          action: 'requested',
          check_suite: {
            head_sha: head,
            pull_requests: [{ number: 2, base: { repo: { id: 42 } } }],
          },
        },
      ],
      [
        'check_run',
        {
          action: 'completed',
          check_run: {
            head_sha: 'e'.repeat(40),
            pull_requests: [{ number: 2, base: { repo: { id: 7 } } }],
          },
        },
      ],
      [
        'issue_comment',
        {
          action: 'created',
          issue: { number: 2, pull_request: {} },
          comment: { body: 'looks good' },
        },
      ],
      [
        'issue_comment',
        { action: 'created', issue: { number: 1 }, comment: { body: 'any news?' } },
      ],
      ['issues', { action: 'opened', issue: { number: 1 } }],
      [
        'pull_request_review',
        {
          action: 'submitted',
          pull_request: { number: 2 },
          review: { state: 'approved', user: { login: 'drive-by' } },
        },
      ],
    ];
    for (const [event, payload] of ignored) {
      await deliver(intake, event, payload);
      assert.deepEqual(await looks(), [], event);
    }
    github.merge();
    await gate.schedule({ includeParked: true });
    assert.equal(await gate.step(), true);
    assert.equal((await gate.status())[0].state, 'reconciled');
    await deliver(intake, 'pull_request', { action: 'closed', pull_request: { number: 2 } });
    assert.deepEqual(await looks(), []);
  } finally {
    await gate.close();
    await intake.close();
  }
});

test('each head clause alone matches, and a delivery during a running look queues the next', async () => {
  const { github, gate, intake } = await tracked();
  const repositoryId = github.config.repositoryId as number;
  const setHead = (sha: string) =>
    admin.query('UPDATE factory_pr_state SET head=$3 WHERE repository_id=$1 AND pull_number=$2', [
      repositoryId,
      2,
      sha,
    ]);
  try {
    const completed = (sha: string) => ({
      action: 'completed',
      check_run: { head_sha: sha, pull_requests: [] },
    });
    // The observed head moved on: a check on it matches the state row, not the pairing's initial head.
    await setHead('b'.repeat(40));
    await deliver(intake, 'check_run', completed('b'.repeat(40)));
    assert.deepEqual(
      (await looks()).map((l) => l.pull),
      [2],
    );
    assert.equal(await gate.step(), true);
    // A check on the pairing's initial head matches even when the state row names another head.
    await setHead('c'.repeat(40));
    await deliver(intake, 'check_run', completed(github.pull.head.sha));
    assert.deepEqual(
      (await looks()).map((l) => l.pull),
      [2],
    );
    // A look is running (it may already have read the evidence): a delivery still queues the next.
    const running = await gate.take();
    assert.ok(running);
    await deliver(intake, 'check_run', completed(github.pull.head.sha));
    const states = (
      await admin.query<{ state: string }>(
        "SELECT state FROM factory_work WHERE queue_name='HumanMergeGate' AND state IN ('pending','running') ORDER BY id",
      )
    ).rows.map((row) => row.state);
    assert.deepEqual(states, ['running', 'pending']);
    await gate.forget(running.lease_token);
  } finally {
    await gate.close();
    await intake.close();
  }
});

test('without a merge profile the intake queues no gate looks', async () => {
  const { gate, intake } = await tracked();
  const plain = new GitHubIntake(pool, liveConfig(), new MergeFixture());
  try {
    await deliver(plain, 'pull_request', { action: 'synchronize', pull_request: { number: 2 } });
    assert.deepEqual(await looks(), []);
  } finally {
    await plain.close();
    await gate.close();
    await intake.close();
  }
});

test('the resident gate accepts a pull request from the configured fork, and only then', async () => {
  const github = new MergeFixture();
  github.pull.head.repo = { id: 99 };
  const refusing = new HumanMergeGate(pool, github.config, github);
  const forked = new HumanMergeGate(pool, { ...github.config, mergeForkRepositoryId: 99 }, github);
  try {
    await assert.rejects(refusing.track(1, 2, github.pull.head.sha));
    await forked.track(1, 2, github.pull.head.sha);
    assert.equal(await forked.step(), true);
    assert.equal((await forked.status())[0].state, 'awaiting_human_merge');
  } finally {
    await refusing.close();
    await forked.close();
  }
});

test('anyone may park a pull request with a change request; any review then queues a look', async () => {
  const { github, gate, intake } = await tracked();
  const review = (login: string, state: string) => ({
    action: 'submitted',
    pull_request: { number: 2 },
    review: { state, user: { login } },
  });
  try {
    assert.equal((await gate.status())[0].state, 'awaiting_human_merge');
    github.reviews.push({
      id: 2,
      user: { id: 77, login: 'drive-by', type: 'User' },
      state: 'CHANGES_REQUESTED',
      commit_id: github.pull.head.sha,
      submitted_at: '2026-01-01T00:01:00Z',
    });
    await deliver(intake, 'pull_request_review', review('drive-by', 'changes_requested'));
    assert.deepEqual(
      (await looks()).map((l) => l.pull),
      [2],
    );
    assert.equal(await gate.step(), true);
    assert.deepEqual(
      (await gate.status()).map((row) => [row.state, row.reason]),
      [['parked', 'changes_requested']],
    );
    // Parked on the change request: any review queues a look (the same user's approval lifts it; a comment
    // changes nothing and costs one look).
    await deliver(intake, 'pull_request_review', review('drive-by', 'commented'));
    assert.equal((await looks()).length, 1);
    assert.equal(await gate.step(), true);
    // Parked for another reason: a review that cannot count queues nothing.
    github.reviews = [];
    await gate.schedule({ includeParked: true });
    assert.equal(await gate.step(), true);
    assert.deepEqual(
      (await gate.status()).map((row) => row.reason),
      ['human_approval_missing_or_stale'],
    );
    await deliver(intake, 'pull_request_review', review('drive-by', 'approved'));
    assert.deepEqual(await looks(), []);
    // A look is running (it may have read a change request the stored state does not show yet): any
    // review queues the next look.
    await gate.schedule({ includeParked: true });
    const running = await gate.take();
    assert.ok(running);
    await deliver(intake, 'pull_request_review', review('drive-by', 'approved'));
    const states = (
      await admin.query<{ state: string }>(
        "SELECT state FROM factory_work WHERE queue_name='HumanMergeGate' AND state IN ('pending','running') ORDER BY id",
      )
    ).rows.map((row) => row.state);
    assert.deepEqual(states, ['running', 'pending']);
    await gate.forget(running.lease_token);
  } finally {
    await gate.close();
    await intake.close();
  }
});

test('whose review counts is read from the current policy file, merger App included', async () => {
  const { github, gate, intake } = await tracked();
  const directory = mkdtempSync(join(tmpdir(), 'gate-deliveries-'));
  const file = join(directory, 'merge-policy.json');
  const fileIntake = new GitHubIntake(pool, { ...github.config, mergePolicyFile: file }, github);
  const review = (login: string) => ({
    action: 'submitted',
    pull_request: { number: 2 },
    review: { state: 'approved', user: { login } },
  });
  try {
    github.reviews = [];
    await gate.schedule({ includeParked: true });
    assert.equal(await gate.step(), true);
    assert.equal((await gate.status())[0].reason, 'human_approval_missing_or_stale');
    // The loaded policy lists example-maintainer; the file, rewritten since, lists new-reviewer.
    writeFileSync(file, JSON.stringify({ ...policy, reviewers: ['new-reviewer'] }));
    await deliver(fileIntake, 'pull_request_review', review('Example-Maintainer'));
    assert.deepEqual(await looks(), []);
    await deliver(fileIntake, 'pull_request_review', review('New-Reviewer'));
    assert.equal((await looks()).length, 1);
    assert.equal(await gate.step(), true);
    writeFileSync(
      file,
      JSON.stringify({ ...policy, merger: { appSlug: 'factory-merger', appId: 9 } }),
    );
    await deliver(fileIntake, 'pull_request_review', review('factory-merger[bot]'));
    assert.equal((await looks()).length, 1);
    assert.equal(await gate.step(), true);
    // An unreadable file leaves the loaded list deciding.
    writeFileSync(file, '{');
    await deliver(fileIntake, 'pull_request_review', review('example-maintainer'));
    assert.equal((await looks()).length, 1);
    assert.equal(await gate.step(), true);
    await deliver(fileIntake, 'pull_request_review', review('factory-merger[bot]'));
    assert.deepEqual(await looks(), []);
  } finally {
    await fileIntake.close();
    await gate.close();
    await intake.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
