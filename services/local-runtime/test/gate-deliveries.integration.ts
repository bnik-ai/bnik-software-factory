import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { GitHubIntake } from '../src/github/intake.js';
import { HumanMergeGate } from '../src/github/reconcile.js';
import { liveConfig } from './github-fixtures.js';
import { initialize, reset } from './helpers.js';
import { MergeFixture } from './merge-fixtures.js';

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

test('a delivery about a tracked pull request queues its gate look at once, one at a time', async () => {
  const { github, gate, intake } = await tracked();
  try {
    await deliver(intake, 'pull_request_review', {
      action: 'submitted',
      pull_request: { number: 2 },
    });
    const queued = await looks();
    assert.deepEqual(
      queued.map((l) => l.pull),
      [2],
    );
    assert.match(queued[0]?.key ?? '', /^42:2:delivery:/);
    // A second delivery while that look is queued adds nothing.
    await deliver(intake, 'pull_request', { action: 'synchronize', pull_request: { number: 2 } });
    assert.equal((await looks()).length, 1);
    assert.equal(await gate.step(), true);
    for (const [event, body] of [
      ['status', { sha: github.pull.head.sha, state: 'success' }],
      [
        'check_run',
        { action: 'completed', check_run: { head_sha: github.pull.head.sha, pull_requests: [] } },
      ],
      [
        'check_suite',
        {
          action: 'completed',
          check_suite: { head_sha: 'f'.repeat(40), pull_requests: [{ number: 2 }] },
        },
      ],
      ['issues', { action: 'edited', issue: { number: 1 } }],
      [
        'issue_comment',
        {
          action: 'created',
          issue: { number: 2, pull_request: {} },
          comment: { body: 'looks good' },
        },
      ],
    ] as const) {
      await deliver(intake, event, body);
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

test('deliveries about untracked or reconciled pull requests, or unusable heads, queue nothing', async () => {
  const { github, gate, intake } = await tracked();
  try {
    await deliver(intake, 'pull_request', { action: 'opened', pull_request: { number: 3 } });
    await deliver(intake, 'status', { sha: 'not-a-sha' });
    await deliver(intake, 'check_suite', {
      check_suite: { head_sha: 'e'.repeat(40), pull_requests: [] },
    });
    assert.deepEqual(await looks(), []);
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

test('without a merge profile the intake queues no gate looks', async () => {
  const { gate, intake } = await tracked();
  const plain = new GitHubIntake(pool, liveConfig(), new MergeFixture());
  try {
    await deliver(plain, 'pull_request_review', {
      action: 'submitted',
      pull_request: { number: 2 },
    });
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
