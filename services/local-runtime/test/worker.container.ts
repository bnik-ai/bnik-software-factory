import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { Docker, WorkerFailure, executeIsolated, runPrefix } from '../src/worker/docker.js';
import { RunRecords } from '../src/worker/records.js';
import { CodingSupervisor } from '../src/worker/supervisor.js';
import { initialize, reset } from './helpers.js';
import { fixture, source } from './worker-fixtures.js';

let admin: Pool;
let pool: Pool;
const docker = new Docker();
const image = process.env.FACTORY_TEST_WORKER_IMAGE ?? 'software-factory-worker:development';
const evidence: unknown[] = [];
const clean = async (id: string) => {
  assert.equal(
    await docker.checked([
      'ps',
      '-aq',
      '--filter',
      `label=io.software-factory.worker-run=${runPrefix(id)}`,
    ]),
    '',
  );
  assert.equal(
    await docker.checked([
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=io.software-factory.worker-run=${runPrefix(id)}`,
    ]),
    '',
  );
};
before(async () => {
  ({ admin, pool } = await initialize());
});
beforeEach(async () => {
  await reset(admin);
});
after(async () => {
  await pool?.end();
  await admin?.end();
  if (process.env.WORKER_EVIDENCE_PATH)
    await writeFile(process.env.WORKER_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
});
function supervisor(overrides: Partial<ConstructorParameters<typeof CodingSupervisor>[0]> = {}) {
  return new CodingSupervisor({
    pool,
    repository: 'example/factory-demo',
    mode: 'demo',
    image,
    signal: new AbortController().signal,
    queue: { leaseMs: 1000 },
    ...overrides,
  });
}
test('shipped non-root container edits code and actually runs shell, Node and Python tests within resource and mount bounds', async () => {
  const archive = source();
  const job = fixture(archive);
  const runId = randomUUID();
  const output = await executeIsolated({
    job,
    archive,
    runId,
    image,
    signal: new AbortController().signal,
    onStarted: async () => {
      const state = JSON.parse(await docker.checked(['inspect', `${runPrefix(runId)}-worker`]))[0];
      assert.equal(state.Config.User, '1000:1000');
      assert.equal(state.HostConfig.NetworkMode, 'none');
      assert.equal(state.HostConfig.ReadonlyRootfs, true);
      assert.deepEqual(state.HostConfig.CapDrop, ['ALL']);
      assert.ok(state.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
      assert.equal(state.HostConfig.Memory, 2 * 1024 ** 3);
      assert.equal(state.HostConfig.NanoCpus, 2 * 10 ** 9);
      assert.equal(state.HostConfig.PidsLimit, 128);
      assert.equal(state.HostConfig.Privileged, false);
      assert.deepEqual(state.Mounts, []);
      assert.ok(
        !state.Config.Env.some((v: string) =>
          /GITHUB|POSTGRES|ANTHROPIC_API_KEY|AZURE|DOCKER_HOST/.test(v),
        ),
      );
      evidence.push({
        check: 'worker container declaration',
        user: state.Config.User,
        network: state.HostConfig.NetworkMode,
        readOnly: true,
        bindMounts: 0,
        capabilities: state.HostConfig.CapDrop,
        memoryBytes: state.HostConfig.Memory,
        cpus: 2,
        pidsLimit: 128,
      });
    },
  });
  assert.equal(output.outcome.ok, true);
  assert.equal(output.outcome.testsStatus, 'passed');
  assert.match(output.outcome.patch, /a \+ b/);
  assert.doesNotMatch(output.outcome.patch, /__pycache__|\.pyc/);
  assert.equal(output.outcome.tests.length, 3);
  for (const entry of output.outcome.tests) assert.equal(entry.exitCode, 0);
  assert.equal(output.outcome.model.costUsd, null);
  evidence.push({
    check: 'real in-image commands',
    imageId: output.imageId,
    tests: output.outcome.tests,
    patchSha256: output.outcome.patchSha256,
  });
  await clean(runId);
});
test('worker cannot access control-plane secrets, host filesystem, Docker socket, writable image files or direct network', async () => {
  const script = [
    'set -eu',
    '[ "$(id -u)" = 1000 ]',
    'test ! -e /var/run/docker.sock',
    'test ! -e /run/secrets',
    'test ! -e /Users',
    'test -z "${GITHUB_APP_PRIVATE_KEY:-}"',
    'test -z "${POSTGRES_PASSWORD:-}"',
    'test -z "${ANTHROPIC_API_KEY:-}"',
    "node -e \"const fs=require('node:fs');let blocked=false;try{fs.writeFileSync('/app/boundary-probe','no')}catch{blocked=true}if(!blocked)process.exit(1)\"",
    "node -e \"const net=require('node:net');const s=net.connect(5432,'192.168.65.254');s.setTimeout(500);s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));s.on('timeout',()=>process.exit(0));\"",
    "node -e \"const net=require('node:net');const s=net.connect(443,'1.1.1.1');s.setTimeout(500);s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));s.on('timeout',()=>process.exit(0));\"",
  ].join('\n');
  const archive = source();
  const job = fixture(archive, { fixtureCommand: script, tests: [] });
  const runId = randomUUID();
  const output = await executeIsolated({
    job,
    archive,
    runId,
    image,
    signal: new AbortController().signal,
  });
  assert.equal(output.outcome.ok, true);
  assert.equal(output.outcome.testsStatus, 'not_run');
  evidence.push({ check: 'in-container boundary probes', passed: true });
  await clean(runId);
});
test('failed or omitted tests remain explicit and cannot be presented as passing', async () => {
  const archive = source();
  for (const tests of [['node -e "process.exit(7)"'], []]) {
    const runId = randomUUID();
    const job = fixture(archive, { tests });
    const output = await executeIsolated({
      job,
      archive,
      runId,
      image,
      signal: new AbortController().signal,
    });
    assert.equal(output.outcome.testsStatus, tests.length ? 'failed' : 'not_run');
    assert.equal(output.outcome.ok, !tests.length);
    if (tests.length) assert.equal(output.outcome.tests[0]?.exitCode, 7);
    await clean(runId);
  }
});
test('wall deadline kills a non-cooperative shell and its descendants and removes job resources', async () => {
  const archive = source();
  const job = fixture(archive, {
    fixtureCommand: "trap '' TERM; sleep 60 & wait",
    tests: [],
    timeoutMs: 1200,
  });
  const runId = randomUUID();
  const start = Date.now();
  await assert.rejects(
    executeIsolated({
      job,
      archive,
      runId,
      image,
      signal: new AbortController().signal,
    }),
    (e: unknown) =>
      e instanceof WorkerFailure &&
      ['worker_timed_out', 'worker_process_failed'].includes(e.reason),
  );
  assert.ok(Date.now() - start < 15_000);
  await clean(runId);
  evidence.push({
    check: 'wall deadline and descendant cleanup',
    elapsedMs: Date.now() - start,
    passed: true,
  });
});
test('explicit cancellation removes an in-flight container', async () => {
  const archive = source();
  const job = fixture(archive, { fixtureCommand: 'sleep 60', tests: [] });
  const runId = randomUUID();
  const controller = new AbortController();
  await assert.rejects(
    executeIsolated({
      job,
      archive,
      runId,
      image,
      signal: controller.signal,
      onStarted: async () => {
        setTimeout(() => controller.abort(), 350);
      },
    }),
    /worker_cancelled/,
  );
  await clean(runId);
});
test('archive traversal and embedded git metadata fail inside the worker without materializing on the host', async () => {
  for (const filename of ['../escape.txt', '.git/config']) {
    const archive = source({ [filename]: 'synthetic' });
    const job = fixture(archive, { fixtureCommand: 'true', tests: [] });
    const runId = randomUUID();
    await assert.rejects(
      executeIsolated({
        job,
        archive,
        runId,
        image,
        signal: new AbortController().signal,
      }),
      /worker_process_failed/,
    );
    await clean(runId);
  }
});
test('supervisor commits completed execution once, preserves evidence and does not touch BuildAgent work', async () => {
  const archive = source();
  const job = fixture(archive);
  const controller = supervisor();
  await controller.submit(job);
  const first = await controller.run(job.id, archive);
  assert.equal(first.outcome.testsStatus, 'passed');
  assert.equal(first.cached, false);
  assert.equal(
    (await pool.query('SELECT state FROM factory_worker_runs')).rows[0].state,
    'succeeded',
  );
  assert.equal(
    (await pool.query("SELECT state FROM factory_work WHERE queue_name='CodingJob'")).rows[0].state,
    'done',
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM factory_work WHERE queue_name='BuildAgent'")).rows[0]
      .count,
    '0',
  );
  const repeated = await supervisor({
    execute: async () => {
      throw new Error('must_not_execute_twice');
    },
  }).run(job.id, archive);
  assert.equal(repeated.cached, true);
  assert.deepEqual(repeated.outcome, first.outcome);
});
test('lease loss kills the real worker and fences stale settlement', async () => {
  const archive = source();
  const job = fixture(archive, { fixtureCommand: 'sleep 60', tests: [] });
  let runId = '';
  const controller = supervisor({
    execute: (options) => {
      runId = options.runId;
      return executeIsolated({
        ...options,
        onStarted: async (imageId) => {
          await options.onStarted?.(imageId);
          setTimeout(() => {
            void admin.query(
              "UPDATE factory_work SET lease_until=clock_timestamp()-interval '1 second' WHERE queue_name='CodingJob'",
            );
          }, 300);
        },
      });
    },
  });
  await controller.submit(job);
  await assert.rejects(controller.run(job.id, archive));
  assert.equal(
    (await pool.query("SELECT state FROM factory_work WHERE queue_name='CodingJob'")).rows[0].state,
    'running',
  );
  assert.equal(
    (await pool.query('SELECT state FROM factory_worker_runs')).rows[0].state,
    'lease_lost',
  );
  await clean(runId);
  evidence.push({ check: 'lost lease stops worker without ACK', passed: true });
});
test('database cancellation is observed during execution and settles the attempt without automatic retry', async () => {
  const archive = source();
  const job = fixture(archive, { fixtureCommand: 'sleep 60', tests: [] });
  let runId = '';
  const controller = supervisor({
    execute: (options) => {
      runId = options.runId;
      return executeIsolated({
        ...options,
        onStarted: async (imageId) => {
          await options.onStarted?.(imageId);
          setTimeout(() => {
            void controller.cancel(job.id);
          }, 300);
        },
      });
    },
  });
  await controller.submit(job);
  await assert.rejects(controller.run(job.id, archive), /worker_cancelled/);
  assert.equal(
    (await pool.query('SELECT state FROM factory_worker_runs')).rows[0].state,
    'cancelled',
  );
  assert.equal(
    (await pool.query("SELECT state FROM factory_work WHERE queue_name='CodingJob'")).rows[0].state,
    'dead',
  );
  await assert.rejects(controller.run(job.id, archive), /not_claimable/);
  await clean(runId);
});
test('simultaneous supervisors cannot run or recover the same job while a live owner holds it', async () => {
  const archive = source();
  const job = fixture(archive, { fixtureCommand: 'sleep 1', tests: [] });
  const controller = supervisor({
    execute: async (options) => {
      await assert.rejects(supervisor().run(job.id, archive), /already_supervised/);
      await assert.rejects(supervisor().recover(), /already_supervised/);
      return executeIsolated(options);
    },
  });
  await controller.submit(job);
  assert.equal((await controller.run(job.id, archive)).outcome.ok, true);
});

test('installed Claude SDK executes its real Bash tool through the credential-free worker and fixed-origin proxy using a synthetic provider', async () => {
  class FixtureDocker extends Docker {
    override checked(args: string[], options?: Parameters<Docker['checked']>[1]) {
      return super.checked(
        args.map((value) =>
          value === 'src/worker/proxy.ts' ? 'test/worker-proxy-fixture.ts' : value,
        ),
        options,
      );
    }
  }
  const fixtureDocker = new FixtureDocker();
  const archive = source();
  const runId = randomUUID();
  const job = fixture(archive, {
    mode: 'live',
    fixtureCommand: undefined,
    // Exercise the selected model's SDK request shape against a synthetic provider.
    model: 'claude-opus-5-5',
    maxTurns: 4,
    timeoutMs: 45_000,
  });
  const output = await executeIsolated({
    job,
    archive,
    runId,
    image,
    docker: fixtureDocker,
    modelKey: 'synthetic-proxy-only-key',
    signal: new AbortController().signal,
    onStarted: async () => {
      const state = JSON.parse(await docker.checked(['inspect', `${runPrefix(runId)}-worker`]))[0];
      assert.equal(state.HostConfig.NetworkMode, 'none');
      assert.equal(state.Mounts.length, 1);
      assert.equal(state.Mounts[0].Type, 'volume');
      assert.equal(state.Mounts[0].Destination, '/run/egress');
      assert.equal(state.Mounts[0].RW, false);
      assert.ok(!JSON.stringify(state).includes('synthetic-proxy-only-key'));
    },
  });
  assert.equal(output.outcome.ok, true, JSON.stringify(output.outcome));
  assert.equal(output.outcome.testsStatus, 'passed');
  assert.match(output.outcome.patch, /a \+ b/);
  assert.equal(output.outcome.model.subtype, 'success');
  assert.ok(Number(output.outcome.model.turns) > 0);
  evidence.push({
    check: 'real SDK tool execution through synthetic API transport',
    model: job.model,
    paidApi: false,
    subtype: output.outcome.model.subtype,
    turns: output.outcome.model.turns,
    tests: output.outcome.tests,
  });
  await clean(runId);
});
test('installed SDK turn limit halts repeated model tool calls', async () => {
  class FixtureDocker extends Docker {
    override checked(args: string[], options?: Parameters<Docker['checked']>[1]) {
      return super.checked(
        args.map((value) =>
          value === 'src/worker/proxy.ts' ? 'test/worker-proxy-fixture.ts' : value,
        ),
        options,
      );
    }
  }
  const archive = source();
  const runId = randomUUID();
  const job = fixture(archive, {
    mode: 'live',
    fixtureCommand: undefined,
    model: 'claude-fixture-loop',
    maxTurns: 1,
    timeoutMs: 45_000,
  });
  const output = await executeIsolated({
    job,
    archive,
    runId,
    image,
    docker: new FixtureDocker(),
    modelKey: 'synthetic-proxy-only-key',
    signal: new AbortController().signal,
  });
  assert.equal(output.outcome.ok, false);
  assert.equal(output.outcome.model.subtype, 'error_max_turns', JSON.stringify(output.outcome));
  assert.equal(output.outcome.testsStatus, 'not_run');
  await clean(runId);
  evidence.push({
    check: 'SDK turn bound',
    paidApi: false,
    configuredMaxTurns: 1,
    reportedTurns: output.outcome.model.turns,
    subtype: output.outcome.model.subtype,
  });
});

test('supervisor SIGKILL leaves a fenced attempt and explicit recovery removes its orphan before another execution', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/worker-crash.ts'], {
    env: { ...process.env, FACTORY_TEST_FAULT_INJECTION: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let runId = '';
  let stdout = '';
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.resume();
  try {
    for (let n = 0; n < 100; n++) {
      if (stdout.includes('\n')) {
        runId = JSON.parse(stdout.split('\n')[0] ?? '{}').runId;
        break;
      }
      await delay(100);
    }
    assert.ok(runId);
    let running = false;
    for (let n = 0; n < 50; n++) {
      const state = await docker.command([
        'inspect',
        `${runPrefix(runId)}-worker`,
        '--format',
        '{{.State.Running}}',
      ]);
      if (state.stdout.trim() === 'true') {
        running = true;
        break;
      }
      await delay(100);
    }
    assert.ok(running);
    child.kill('SIGKILL');
    await closed;
    await delay(1300);
    assert.notEqual(
      await docker.checked([
        'ps',
        '-aq',
        '--filter',
        `label=io.software-factory.worker-run=${runPrefix(runId)}`,
      ]),
      '',
    );
    await supervisor().recover();
    await clean(runId);
    assert.equal(
      (await pool.query('SELECT state FROM factory_worker_runs')).rows[0].state,
      'failed',
    );
    await assert.rejects(supervisor().run('controller-crash-fixture', source()), /not_claimable/);
    assert.equal(
      (await pool.query("SELECT state FROM factory_work WHERE queue_name='CodingJob'")).rows[0]
        .state,
      'dead',
    );
    evidence.push({
      check: 'controller SIGKILL and explicit orphan recovery',
      exitSignal: 'SIGKILL',
      automaticPaidRetry: false,
      passed: true,
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
    if (runId) {
      await delay(1300);
      await supervisor()
        .recover()
        .catch(() => undefined);
    }
  }
});

test('cleanup failure leaves work unsettled and requires recovery before any later job in the repository', async () => {
  class FailingCleanup extends Docker {
    override checked(args: string[], options?: Parameters<Docker['checked']>[1]) {
      if (args[0] === 'rm') throw new WorkerFailure('injected_cleanup_failure');
      return super.checked(args, options);
    }
  }
  const archive = source();
  const job = fixture(archive, { fixtureCommand: 'true', tests: [] });
  const controller = supervisor({ docker: new FailingCleanup() });
  await controller.submit(job);
  await assert.rejects(controller.run(job.id, archive), /worker_cleanup_failed/);
  const row = (await pool.query('SELECT run_id,state FROM factory_worker_runs')).rows[0];
  assert.equal(row.state, 'cleanup_failed');
  assert.equal(
    (await pool.query("SELECT state FROM factory_work WHERE queue_name='CodingJob'")).rows[0].state,
    'running',
  );
  try {
    await assert.rejects(supervisor().recover(), /lease_still_active/);
    await delay(1300);
    const later = fixture(archive, { fixtureCommand: 'true', tests: [] });
    const next = supervisor();
    await next.submit(later);
    assert.equal((await next.run(later.id, archive)).outcome.ok, true);
    await clean(row.run_id);
    assert.equal(
      (await pool.query('SELECT state FROM factory_worker_runs WHERE run_id=$1', [row.run_id]))
        .rows[0].state,
      'failed',
    );
  } finally {
    await delay(1300);
    await supervisor()
      .recover()
      .catch(() => undefined);
  }
  evidence.push({
    check: 'cleanup failure fences all later jobs for the repository until recovered',
    passed: true,
  });
});

test('installed SDK budget threshold stops execution with estimated usage rather than claiming a billed ceiling', async () => {
  class FixtureDocker extends Docker {
    override checked(args: string[], options?: Parameters<Docker['checked']>[1]) {
      return super.checked(
        args.map((value) =>
          value === 'src/worker/proxy.ts' ? 'test/worker-proxy-fixture.ts' : value,
        ),
        options,
      );
    }
  }
  const archive = source();
  const runId = randomUUID();
  const job = fixture(archive, {
    mode: 'live',
    fixtureCommand: undefined,
    model: 'claude-opus-5-5',
    maxBudgetUsd: 0.001,
    maxTurns: 4,
    timeoutMs: 45000,
  });
  const output = await executeIsolated({
    job,
    archive,
    runId,
    image,
    docker: new FixtureDocker(),
    modelKey: 'synthetic-proxy-only-key',
    signal: new AbortController().signal,
  });
  assert.equal(output.outcome.ok, false);
  assert.equal(
    output.outcome.model.subtype,
    'error_max_budget_usd',
    JSON.stringify(output.outcome),
  );
  assert.ok(output.outcome.model.costUsd !== null && output.outcome.model.costUsd >= 0.001);
  assert.ok(output.outcome.model.usage);
  assert.equal(output.outcome.testsStatus, 'not_run');
  await clean(runId);
  evidence.push({
    check: 'installed SDK budget threshold',
    thresholdUsd: job.maxBudgetUsd,
    estimatedUsd: output.outcome.model.costUsd,
    usage: output.outcome.model.usage,
    subtype: output.outcome.model.subtype,
    paidApi: false,
    hardBillingCeiling: false,
  });
});

test('cancelling live-mode execution removes both SDK worker and provider proxy without a new paid attempt', async () => {
  class FixtureDocker extends Docker {
    override checked(args: string[], options?: Parameters<Docker['checked']>[1]) {
      return super.checked(
        args.map((value) =>
          value === 'src/worker/proxy.ts' ? 'test/worker-proxy-fixture.ts' : value,
        ),
        options,
      );
    }
  }
  const archive = source();
  const runId = randomUUID();
  const controller = new AbortController();
  const job = fixture(archive, {
    mode: 'live',
    fixtureCommand: undefined,
    model: 'claude-fixture-loop',
    maxTurns: 60,
    timeoutMs: 45000,
  });
  await assert.rejects(
    executeIsolated({
      job,
      archive,
      runId,
      image,
      docker: new FixtureDocker(),
      modelKey: 'synthetic-proxy-only-key',
      signal: controller.signal,
      onStarted: async () => {
        setTimeout(() => controller.abort(), 1000);
      },
    }),
    /worker_cancelled/,
  );
  await clean(runId);
  evidence.push({
    check: 'live-mode cancellation removes SDK worker and provider proxy',
    paidApi: false,
    automaticRetry: false,
    resourcesRemaining: 0,
  });
});

test('completed run evidence and cached result survive a real PostgreSQL SIGKILL and new connections', async () => {
  const database = process.env.FACTORY_TEST_DATABASE_CONTAINER ?? '';
  assert.match(database, /^factory-worker-test-[0-9a-f]{10}$/);
  const archive = source();
  const job = fixture(archive);
  const s = supervisor();
  await s.submit(job);
  await s.run(job.id, archive);
  const before = (await new RunRecords(pool).status(job.id))[0];
  await pool.end();
  await admin.end();
  await docker.checked(['kill', '--signal', 'KILL', database]);
  await docker.checked(['start', database]);
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (
      (
        await docker.command([
          'exec',
          database,
          'pg_isready',
          '-U',
          'factory_migrator',
          '-d',
          'software_factory',
        ])
      ).code === 0
    ) {
      ready = true;
      break;
    }
    await delay(100);
  }
  assert.ok(ready);
  process.env.POSTGRES_PORT = (await docker.checked(['port', database, '5432']))
    .split(':')
    .at(-1)
    ?.trim();
  ({ admin, pool } = await initialize());
  const restored = (await new RunRecords(pool).status(job.id))[0];
  assert.deepEqual(restored, before);
  const repeated = await supervisor({
    execute: async () => {
      throw Error('must_not_execute_after_restart');
    },
  }).run(job.id, archive);
  assert.equal(repeated.cached, true);
  assert.equal(restored.evidence.sourceHead, job.sourceCommit);
  assert.equal(restored.evidence.testsStatus, 'passed');
  evidence.push({
    check: 'completed run evidence after PostgreSQL SIGKILL and reconnect',
    unchangedRecord: true,
    cachedResult: true,
    paidApi: false,
  });
});

test('validation outputs never enter the frozen patch and source mutations fail validation', async () => {
  for (const mutate of [false, true]) {
    const archive = source();
    const runId = randomUUID();
    const output = await executeIsolated({
      job: fixture(archive, {
        tests: [
          mutate
            ? "printf 'test-injected code' > sum.js"
            : "mkdir -p coverage; printf 'report' > coverage/output.txt",
        ],
      }),
      archive,
      runId,
      image,
      signal: new AbortController().signal,
    });
    assert.doesNotMatch(output.outcome.patch, /coverage|test-injected/);
    assert.match(output.outcome.patch, /a \+ b/);
    assert.equal(output.outcome.ok, !mutate);
    assert.equal(output.outcome.reason, mutate ? 'test_modified_source' : 'execution_completed');
    assert.deepEqual(output.outcome.testSideEffects?.modifiedPaths, mutate ? ['sum.js'] : []);
    assert.deepEqual(
      output.outcome.testSideEffects?.generatedPaths,
      mutate ? [] : ['coverage/output.txt'],
    );
    await clean(runId);
  }
  evidence.push({
    check: 'frozen patch excludes test outputs and rejects changed proposed source',
  });
});
