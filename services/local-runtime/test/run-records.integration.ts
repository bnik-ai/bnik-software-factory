import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import type { MergePolicy } from '../src/github/merge-policy.js';
import { HumanMergeGate, SCAN_LIMIT } from '../src/github/reconcile.js';
import { WorkerFailure } from '../src/worker/docker.js';
import type { CodingJob, CodingOutcome } from '../src/worker/protocol.js';
import { RunRecords, runLimits } from '../src/worker/records.js';
import { CodingSupervisor } from '../src/worker/supervisor.js';
import { config, initialize, reset } from './helpers.js';
import { MergeFixture } from './merge-fixtures.js';
import { fixture } from './worker-fixtures.js';
let admin: Pool;
let pool: Pool;
const archive = Buffer.from('synthetic source');
before(async () => {
  ({ admin, pool } = await initialize());
});
beforeEach(async () => {
  await reset(admin);
  await admin.query(
    'TRUNCATE factory_task_activations,factory_pr_pairs,factory_pr_observations,factory_merge_receipts,factory_pr_state,factory_dependency_state',
  );
});
after(async () => {
  await pool?.end();
  await admin?.end();
});
async function liveJob(issueId = 10) {
  const id = randomUUID();
  const job = fixture(archive, {
    id: `activation-${id}`,
    mode: 'live',
    fixtureCommand: undefined,
    model: 'claude-fixture',
    prompt: 'private synthetic prompt',
  });
  await admin.query(
    "INSERT INTO factory_task_activations(id,delivery_id,repository_id,repository,installation_id,issue_number,issue_id,comment_id,actor_id,actor_login,source_commit,task_hash,proof) VALUES($1::uuid,($1::uuid)::text,42,$2,7,$7,$6,$3,55,'example-maintainer',$4,$5,'{}')",
    [
      id,
      job.repository,
      Math.floor(Math.random() * 1e12),
      job.sourceCommit,
      '0'.repeat(64),
      issueId,
      issueId - 9,
    ],
  );
  return job;
}
function outcome(job: CodingJob): CodingOutcome {
  return {
    version: 1,
    ok: true,
    reason: 'execution_completed',
    sourceCommit: job.sourceCommit,
    archiveSha256: job.archiveSha256,
    patch: 'private synthetic patch',
    patchSha256: '1'.repeat(64),
    testsStatus: 'passed',
    tests: [
      {
        command: 'echo private synthetic command',
        exitCode: 0,
        signal: null,
        output: 'private synthetic output',
        outputTruncated: false,
      },
    ],
    model: {
      mode: job.mode,
      subtype: 'success',
      turns: 2,
      costUsd: 0.25,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    summary: 'private synthetic summary',
  };
}
function supervisor(options: Partial<ConstructorParameters<typeof CodingSupervisor>[0]> = {}) {
  return new CodingSupervisor({
    pool,
    repository: 'example/factory-demo',
    mode: 'live',
    image: 'unused',
    signal: new AbortController().signal,
    authorize: async () => {},
    execute: async ({ job, onStarted }) => {
      await onStarted?.('synthetic-image');
      return { outcome: outcome(job), imageId: 'synthetic-image' };
    },
    ...options,
  });
}
test('restart-safe status retains task/head/timing/tests/accounting while omitting task and command content', async () => {
  const job = await liveJob();
  const s = supervisor();
  await s.submit(job);
  await s.run(job.id, archive);
  const status = (await new RunRecords(pool).status(job.id))[0];
  assert.equal(status.evidence.task.issueId, '10');
  assert.equal(status.evidence.sourceHead, job.sourceCommit);
  assert.equal(status.evidence.result.patchSha256, '1'.repeat(64));
  assert.equal(status.evidence.tests[0].exitCode, 0);
  assert.deepEqual(status.evidence.cost, {
    status: 'estimated',
    estimatedUsd: 0.25,
    billedUsd: null,
    source: 'sdk_query_estimate',
    hardMonetaryCeiling: false,
  });
  assert.equal(status.evidence.model.usage.inputTokens, 100);
  assert.equal(status.retry_count, 0);
  assert.ok(status.started_at && status.ended_at);
  assert.ok(!JSON.stringify(status).includes('private synthetic'));
  console.log(`RUN_STATUS_EXAMPLE ${JSON.stringify(status)}`);
  const cached = await supervisor({
    execute: async () => {
      throw Error('must_not_repeat');
    },
  }).run(job.id, archive);
  assert.equal(cached.cached, true);
  assert.equal((await new RunRecords(pool).status(job.id)).length, 1);
});
test('unknown usage on interrupted execution stays unavailable and is not reported as zero or billed', async () => {
  const job = await liveJob();
  const s = supervisor({
    execute: async ({ onStarted }) => {
      await onStarted?.('synthetic-image');
      throw new WorkerFailure('worker_timed_out');
    },
  });
  await s.submit(job);
  await assert.rejects(s.run(job.id, archive), /worker_timed_out/);
  const row = (await new RunRecords(pool).status(job.id))[0];
  assert.equal(row.state, 'timed_out');
  assert.equal(row.evidence.cost.status, 'unavailable');
  assert.equal(row.evidence.cost.estimatedUsd, null);
  assert.equal(row.evidence.cost.billedUsd, null);
  assert.equal(row.evidence.model.usage, null);
  assert.equal(row.evidence.executionMayHaveStarted, true);
  console.log(`RUN_STATUS_EXAMPLE ${JSON.stringify(row)}`);
});
test('queued cancellation survives new supervisor and starts no executor; stopped supervisor cannot start pending work', async () => {
  const job = await liveJob();
  let calls = 0;
  const s = supervisor({
    execute: async () => {
      calls++;
      throw Error('unexpected');
    },
  });
  await s.submit(job);
  assert.equal(await s.cancel(job.id), 1);
  await assert.rejects(supervisor().run(job.id, archive), /coding_job_dead/);
  const row = (await new RunRecords(pool).status(job.id))[0];
  assert.equal(row.cancel_requested, true);
  assert.equal(row.work_state, 'dead');
  assert.equal(row.run_id, null);
  assert.equal(calls, 0);
  const next = await liveJob();
  await s.submit(next);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(supervisor({ signal: abort.signal }).run(next.id, archive));
  assert.equal((await new RunRecords(pool).status(next.id))[0].attempts, 0);
});
test('cancellation between claim and worker start prevents paid execution and records cancellation', async () => {
  const job = await liveJob();
  let paid = 0;
  const s = supervisor({
    execute: async ({ onStarted }) => {
      await s.cancel(job.id);
      await onStarted?.('synthetic-image');
      paid++;
      return { outcome: outcome(job), imageId: 'synthetic-image' };
    },
  });
  await s.submit(job);
  await assert.rejects(s.run(job.id, archive), /worker_cancelled/);
  assert.equal(paid, 0);
  assert.equal((await new RunRecords(pool).status(job.id))[0].state, 'cancelled');
});
test('task run limit survives fresh activations and clamps SDK/time/turn controls before execution', async () => {
  const limits = {
    ...runLimits(),
    maxTaskRuns: 2,
    maxTurns: 1,
    timeoutMs: 1200,
    maxBudgetUsd: 0.01,
  };
  let calls = 0;
  const s = supervisor({
    limits,
    execute: async ({ job }) => {
      calls++;
      assert.equal(job.maxTurns, 1);
      assert.equal(job.timeoutMs, 1200);
      assert.equal(job.maxBudgetUsd, 0.01);
      return { outcome: outcome(job), imageId: 'synthetic' };
    },
  });
  for (let i = 0; i < 3; i++) {
    const job = await liveJob();
    await s.submit(job);
    if (i < 2) {
      await s.run(job.id, archive);
      assert.equal((await new RunRecords(pool).status(job.id))[0].evidence.revision, i);
    } else
      await assert.rejects(supervisor({ limits }).run(job.id, archive), /task_run_limit_reached/);
  }
  assert.equal(calls, 2);
});
test('repository mutex prevents two different Tasks from executing concurrently', async () => {
  const first = await liveJob();
  const second = await liveJob(11);
  const s = supervisor({
    execute: async ({ job }) => {
      await assert.rejects(supervisor().run(second.id, archive), /already_supervised/);
      return { outcome: outcome(job), imageId: 'synthetic' };
    },
  });
  await s.submit(first);
  await s.submit(second);
  await s.run(first.id, archive);
  assert.equal((await new RunRecords(pool).status(second.id))[0].attempts, 0);
});
test('retention removes terminal content but preserves run evidence, deduplication and task limit counters', async () => {
  const job = await liveJob();
  const s = supervisor();
  const id = await s.submit(job);
  await s.run(job.id, archive);
  await admin.query(
    "UPDATE factory_work SET settled_at=clock_timestamp()-interval '31 days' WHERE id=$1",
    [id],
  );
  const pending = await liveJob();
  await s.submit(pending);
  const records = new RunRecords(pool);
  assert.equal(await records.prune(30), 1);
  assert.equal(await records.prune(30), 0);
  const row = (await pool.query('SELECT body,result FROM factory_work WHERE id=$1', [id])).rows[0];
  assert.deepEqual(row, { body: null, result: null });
  const status = (await records.status(job.id))[0];
  assert.equal(status.evidence.cost.estimatedUsd, 0.25);
  assert.ok(status.content_deleted_at);
  assert.equal(await s.submit(job), id);
  await assert.rejects(s.run(job.id, archive), /compacted/);
  assert.equal((await records.status(pending.id))[0].work_state, 'pending');
  await assert.rejects(records.prune(0), /retention/);
});
test('publication head links only to the matching successful Task and cannot be replaced', async () => {
  const job = await liveJob();
  const s = supervisor();
  await s.submit(job);
  await s.run(job.id, archive);
  const records = new RunRecords(pool);
  const pair = {
    repositoryId: 42,
    installationId: 7,
    taskNumber: 1,
    taskId: 10,
    taskNodeId: 'I_FIXTURE',
    taskHash: '1'.repeat(64),
    pullNumber: 2,
    pullId: 22,
    pullNodeId: 'PR_FIXTURE',
    initialHead: 'a'.repeat(40),
  };
  await assert.rejects(
    records.linkPublication(job.id, job.repository, { ...pair, taskId: 99 }),
    /mismatch/,
  );
  await records.linkPublication(job.id, job.repository, pair);
  await records.linkPublication(job.id, job.repository, pair);
  await assert.rejects(
    records.linkPublication(job.id, job.repository, { ...pair, initialHead: 'b'.repeat(40) }),
    /already_recorded/,
  );
  assert.equal((await records.status(job.id))[0].evidence.publication.builtHead, pair.initialHead);
  const github = new MergeFixture();
  const gate = new HumanMergeGate(pool, github.config, github);
  try {
    await gate.track(1, 2, pair.initialHead);
    await gate.step();
    const checked = (await records.status(job.id))[0];
    assert.equal(checked.review.verifiedHead, pair.initialHead);
    assert.equal(checked.evidence.review.reviewedHead, pair.initialHead);
    github.pull.head.sha = 'b'.repeat(40);
    await gate.schedule();
    await gate.step();
    const stale = (await records.status(job.id))[0];
    assert.equal(stale.review, null);
    assert.equal(stale.evidence.review.reviewedHead, pair.initialHead);
  } finally {
    await gate.close();
  }
});

/** Pull numbers with a pending or running merge-gate item, in queue order. */
async function queuedPulls() {
  return (
    await admin.query<{ pull: number }>(
      "SELECT (body->>'pull')::int AS pull FROM factory_work WHERE queue_name='HumanMergeGate' AND state IN ('pending','running') ORDER BY id",
    )
  ).rows.map((row) => row.pull);
}

test('the periodic scan rests parked pull requests, keeps transient parks and pending ones on the minute, and queues each pull once', async () => {
  const github = new MergeFixture();
  const gate = new HumanMergeGate(pool, github.config, github);
  const repositoryId = github.config.repositoryId as number;
  const installationId = github.config.installationId;
  const pair = (pull: number) =>
    admin.query(
      'INSERT INTO factory_pr_pairs(repository_id,installation_id,pull_number,task_number,pair) VALUES($1,$2,$3,$4,$5::jsonb)',
      [repositoryId, installationId, pull, pull + 100, JSON.stringify({ pullNumber: pull })],
    );
  const state = (pull: number, value: string, minutesAgo: number, evidence = {}) =>
    admin.query(
      `INSERT INTO factory_pr_state(repository_id,pull_number,state,reason,head,evidence,updated_at)
       VALUES($1,$2,$3,'test',$4,$6::jsonb,clock_timestamp() - ($5::int * interval '1 minute'))`,
      [repositoryId, pull, value, 'a'.repeat(40), minutesAgo, JSON.stringify(evidence)],
    );
  try {
    await pair(11); // never evaluated
    await pair(12);
    await state(12, 'parked', 1); // parked a minute ago: rests
    await pair(13);
    await state(13, 'parked', 20); // parked long ago: due again
    await pair(14);
    await state(14, 'reconciled', 1); // settled for good
    await pair(15);
    await state(15, 'awaiting_human_merge', 1); // pending: every minute
    await pair(16);
    await state(16, 'parked', 1, { transient: true }); // a retryable GitHub failure: every minute
    await pair(17); // never evaluated, but a delivery already queued its look
    await gate.queue.enqueue(randomUUID(), 'example/factory-demo', {
      pull: 17,
      repositoryId,
      installationId,
    });
    await gate.schedule();
    assert.deepEqual(
      (await queuedPulls()).sort((a, b) => a - b),
      [11, 13, 15, 16, 17],
    );
    // A later minute queues nothing twice while the looks are still queued.
    await gate.schedule();
    assert.deepEqual(
      (await queuedPulls()).sort((a, b) => a - b),
      [11, 13, 15, 16, 17],
    );
    // The operator's scan looks at every parked pull request now.
    await gate.schedule({ includeParked: true });
    assert.deepEqual(
      (await queuedPulls()).sort((a, b) => a - b),
      [11, 12, 13, 15, 16, 17],
    );
  } finally {
    await gate.close();
  }
});

test('a park by the gate itself rests until the operator asks, unless a retryable GitHub failure caused it', async () => {
  const github = new MergeFixture();
  const gate = new HumanMergeGate(pool, github.config, github);
  const head = github.pull.head.sha;
  try {
    await gate.track(1, 2, head);
    github.failRead = true;
    assert.equal(await gate.step(), true);
    assert.equal((await gate.status())[0].reason, 'review_surface_unreadable');
    await gate.schedule();
    assert.deepEqual(await queuedPulls(), []);
    await gate.schedule({ includeParked: true });
    assert.deepEqual(await queuedPulls(), [2]);
    github.failRead = false;
    github.failReadTransient = true;
    assert.equal(await gate.step(), true);
    const parked = (await gate.status())[0];
    assert.equal(parked.reason, 'github_connection_failed');
    assert.equal(parked.evidence.transient, true);
    await gate.schedule();
    assert.deepEqual(await queuedPulls(), [2]);
    github.failReadTransient = false;
    assert.equal(await gate.step(), true);
    const looked = (await gate.status())[0];
    assert.equal(looked.state, 'awaiting_human_merge');
    assert.equal(looked.evidence.transient, undefined);
  } finally {
    await gate.close();
  }
});

test('a scan queues at most SCAN_LIMIT pull requests, stalest first, and the rest on the next scan', async () => {
  const github = new MergeFixture();
  const gate = new HumanMergeGate(pool, github.config, github);
  const repositoryId = github.config.repositoryId as number;
  try {
    const pulls = Array.from({ length: SCAN_LIMIT + 5 }, (_, index) => index + 1);
    await admin.query(
      `INSERT INTO factory_pr_pairs(repository_id,installation_id,pull_number,task_number,pair)
       SELECT $1,$2,n,n+1000,jsonb_build_object('pullNumber',n) FROM unnest($3::int[]) AS n`,
      [repositoryId, github.config.installationId, pulls],
    );
    await gate.schedule();
    assert.equal((await queuedPulls()).length, SCAN_LIMIT);
    await gate.schedule();
    assert.deepEqual(
      (await queuedPulls()).sort((a, b) => a - b),
      pulls,
    );
  } finally {
    await gate.close();
  }
});

test('the gate reads merge-policy.json before every look, so an edited base branch takes effect without a restart', async () => {
  const github = new MergeFixture();
  const dir = mkdtempSync(join(tmpdir(), 'merge-policy-'));
  const file = join(dir, 'merge-policy.json');
  const write = (baseBranch: string) =>
    writeFileSync(file, JSON.stringify({ ...github.config.mergePolicy, baseBranch }));
  write('main');
  // The loaded copy names a branch the repository never had; only the file is current.
  const gate = new HumanMergeGate(
    pool,
    {
      ...github.config,
      mergePolicy: { ...(github.config.mergePolicy as MergePolicy), baseBranch: 'stale' },
      mergePolicyFile: file,
    },
    github,
  );
  try {
    await gate.track(1, 2, github.pull.head.sha);
    await gate.step();
    assert.equal((await gate.status())[0].state, 'awaiting_human_merge');
    write('release');
    await gate.schedule();
    await gate.step();
    assert.equal((await gate.status())[0].reason, 'repository_merge_settings_unsafe');
    write('main');
    await gate.schedule({ includeParked: true });
    await gate.step();
    assert.equal((await gate.status())[0].state, 'awaiting_human_merge');
    writeFileSync(file, '{');
    await gate.schedule();
    await gate.step();
    assert.equal((await gate.status())[0].reason, 'merge_policy_unreadable');
  } finally {
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function cli(args: string[], password = config().database.password) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const env = {
      ...process.env,
      POSTGRES_USER: 'factory_runtime',
      POSTGRES_PASSWORD: password,
      POSTGRES_PASSWORD_FILE: undefined,
      FACTORY_REPOSITORY: 'example/factory-demo',
    };
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/cli.ts', ...args], {
      env,
    });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
    });
    child.stderr.on('data', (d) => {
      output += d;
    });
    child.on('exit', (code) => resolve({ code, output }));
  });
}
test('authenticated CLI status and queued cancellation need no GitHub or model credentials', async () => {
  const job = await liveJob();
  await supervisor().submit(job);
  const denied = await cli(['cancel', job.id], 'intentionally-incorrect');
  assert.equal(denied.code, 1);
  const pending = await cli(['status', job.id]);
  assert.equal(pending.code, 0);
  assert.equal(JSON.parse(pending.output)[0].attempts, 0);
  const cancelled = await cli(['cancel', job.id]);
  assert.equal(cancelled.code, 0);
  assert.equal(JSON.parse(cancelled.output).requested, 1);
  const status = await cli(['status', job.id]);
  const row = JSON.parse(status.output)[0];
  assert.equal(row.cancel_requested, true);
  assert.equal(row.reason, 'operator_cancelled');
  assert.equal(row.evidence.cost.estimatedUsd, null);
  const invalid = await cli(['prune', '0']);
  assert.equal(invalid.code, 1);
});
