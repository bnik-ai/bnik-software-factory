import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import type { AcceptanceRun } from '../src/autonomy/acceptance.js';
import type { ChangeManifest, FileChange } from '../src/autonomy/classify.js';
import type { CollectedChange } from '../src/autonomy/collector.js';
import {
  AutonomyController,
  type ControllerAdapters,
  type ExecutionResult,
  type LoadedTask,
  intentDigest,
  quiesceController,
} from '../src/autonomy/controller.js';
import { ApprovalStore, AutonomyLedger } from '../src/autonomy/ledger.js';
import { UncertainPublication, publishCandidate } from '../src/autonomy/publisher.js';
import {
  FIXTURE_REVIEWER,
  FixtureReviewer,
  reviewerConfigDigest,
} from '../src/autonomy/reviewer.js';
import { AutonomyRuns } from '../src/autonomy/runs.js';
import { AutonomyError, sha256Json } from '../src/autonomy/schema.js';
import type { CodingJob, CodingOutcome } from '../src/worker/protocol.js';
import { sha256 } from '../src/worker/protocol.js';
import { APPROVER_ID, NOW, policyFixture } from './autonomy-fixtures.js';
import { FixtureGitHost } from './git-host-fixture.js';
import { controllerPool, initialize } from './helpers.js';

/**
 * Controller contracts on a real PostgreSQL with in-process fixtures for every
 * external effect: executor, collector, acceptance, reviewer and publisher. The
 * fixture publisher hashes trees like Git, so publication equivalence is real.
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
const SOURCE = '1'.repeat(40);
const BASE_FILES: Record<string, { content: Buffer }> = {
  'sum.js': { content: Buffer.from('module.exports = (a, b) => a - b;\n') },
  'README.md': { content: Buffer.from('# demo\n') },
};
const policy = policyFixture({
  allowedPaths: ['.'],
  verification: {
    ...policyFixture().verification,
    reviewerConfigSha256: reviewerConfigDigest(FIXTURE_REVIEWER),
    acceptanceSuiteSha256: '1'.repeat(64),
    acceptanceHarnessSha256: '2'.repeat(64),
    acceptanceRunnerImage: `sha256:${'3'.repeat(64)}`,
  },
});
let clock = NOW;
const now = () => clock;

/** Patches are a JSON map path -> content (null deletes); the fixture collector applies it. */
function applyPatch(patch: string): {
  files: Record<string, { content: Buffer }>;
  manifest: ChangeManifest;
} {
  const changes = JSON.parse(patch) as Record<string, string | null>;
  const files: Record<string, { content: Buffer }> = { ...BASE_FILES };
  const manifest: FileChange[] = [];
  for (const [path, content] of Object.entries(changes)) {
    const before = BASE_FILES[path]?.content.toString('utf8') ?? null;
    if (content === null) {
      delete files[path];
      manifest.push({
        status: 'deleted',
        oldPath: path,
        newPath: null,
        oldMode: '100644',
        newMode: null,
        oldContent: before,
        newContent: null,
        binary: false,
      });
    } else {
      files[path] = { content: Buffer.from(content) };
      manifest.push(
        before === null
          ? {
              status: 'added',
              oldPath: null,
              newPath: path,
              oldMode: null,
              newMode: '100644',
              oldContent: null,
              newContent: content,
              binary: false,
            }
          : {
              status: 'modified',
              oldPath: path,
              newPath: path,
              oldMode: '100644',
              newMode: '100644',
              oldContent: before,
              newContent: content,
              binary: false,
            },
      );
    }
  }
  return { files, manifest: { complete: true, files: manifest } };
}
function treeOf(files: Record<string, { content: Buffer }>): string {
  return new FixtureGitHost(REPOSITORY, REPOSITORY, files).baseTree;
}
interface Scenario {
  /** What the "worker" produces for the Task. */
  patch: string;
  outcomeOk?: boolean;
  costUsd?: number | null;
  acceptance?: Partial<AcceptanceRun['receipt']>;
  /** Fail the first N executions with this reason before succeeding; `started` says whether the paid container ran. */
  failExecutions?: { times: number; reason: string; started?: boolean };
}
function harness(scenario: Scenario) {
  const executions: CodingJob[] = [];
  let failures = scenario.failExecutions?.times ?? 0;
  const cached = new Map<string, ExecutionResult>();
  const task: LoadedTask = {
    id: 'I_TASK_7',
    issueId: 7007,
    number: 7,
    title: 'Fix sum',
    body: 'sum must add.',
    intentKind: 'change',
    definition: {
      prompt: 'Fix sum.js',
      tests: [],
      maxTurns: 2,
      timeoutMs: 30_000,
      fixtureCommand: 'true',
    },
    sourceCommit: SOURCE,
    status: 'status:proposed',
  };
  const publisher = new FixtureGitHost(REPOSITORY, REPOSITORY, BASE_FILES);
  // The fixture host's base commit stands in for the Task's pinned source commit.
  publisher.commits.set(
    SOURCE,
    publisher.commits.get(publisher.baseCommit) as {
      tree: string;
      parents: string[];
      message: string;
    },
  );
  const ledger = new AutonomyLedger(controllerDb);
  const runs = new AutonomyRuns(controllerDb);
  const approvals = new ApprovalStore(controllerDb);
  const adapters: ControllerAdapters = {
    pool: controllerDb,
    ledger,
    runs,
    approvals,
    taskSource: { load: async () => task, archive: async () => Buffer.from('archive') },
    executor: {
      run: async (job) => {
        executions.push(job);
        if (failures > 0) {
          failures--;
          throw new Error(scenario.failExecutions?.reason ?? 'worker_execution_failed');
        }
        const existing = cached.get(job.id);
        if (existing) return { ...existing, cached: true };
        const outcome: CodingOutcome = {
          version: 1,
          ok: scenario.outcomeOk ?? true,
          reason: scenario.outcomeOk === false ? 'coding_failed' : 'execution_completed',
          sourceCommit: job.sourceCommit,
          archiveSha256: job.archiveSha256,
          patch: scenario.patch,
          patchSha256: sha256(scenario.patch),
          testsStatus: 'not_run',
          tests: [],
          model: {
            mode: job.mode,
            subtype: 'fixture_completed',
            turns: 1,
            costUsd: scenario.costUsd ?? null,
            usage: null,
          },
          summary: 'fixture',
        };
        const result = { outcome, workId: `work-${job.id}`, runId: `run-${job.id}`, cached: false };
        cached.set(job.id, result);
        return result;
      },
      cancel: async () => 1,
      mayHaveStarted: async () => scenario.failExecutions?.started === true,
    },
    collect: async (_archive, patch): Promise<CollectedChange> => {
      const { files, manifest } = applyPatch(patch);
      return {
        base: SOURCE,
        baseTree: treeOf(BASE_FILES),
        candidateTree: treeOf(files),
        context: { files: [], omitted: [], truncated: false },
        patchSha256: sha256(patch),
        manifest,
        blobs: {},
        imageId: `sha256:${'c'.repeat(64)}`,
      };
    },
    acceptance: async (input) => ({
      receipt: {
        version: 1,
        kind: 'acceptance',
        runId: '00000000-0000-4000-8000-000000000001',
        subject: {
          repositoryId: input.subject.repositoryId,
          taskId: input.subject.taskId,
          base: input.subject.base,
          tree: input.subject.tree,
          changesSha256: input.subject.changesSha256,
        },
        suiteSha256: policy.verification.acceptanceSuiteSha256,
        harnessSha256: policy.verification.acceptanceHarnessSha256,
        runnerImage: policy.verification.acceptanceRunnerImage,
        status: 'passed',
        protectedSuite: { total: 3, passed: 3, failed: 0, skipped: 0 },
        reproducer: { baseline: 'not_run', candidate: 'not_run' },
        sourceModifiedByTests: false,
        completedAt: now(),
        ...scenario.acceptance,
      },
      reason: null,
      candidate: null,
      baseline: null,
    }),
    reviewer: new FixtureReviewer(now),
    dependency: null,
    publisher: (input) => publishCandidate(publisher, input),
    bundle: {
      directory: '/bundle',
      harness: {
        version: 1,
        runner: { kind: 'node-test' },
        tests: ['t.mjs'],
        reproducer: null,
        timeoutMs: 1000,
      },
      files: [],
      suiteSha256: policy.verification.acceptanceSuiteSha256,
      harnessSha256: policy.verification.acceptanceHarnessSha256,
    },
    policy,
    repository: REPOSITORY,
    mode: 'demo',
    actor: 'test-controller',
    now,
  };
  return {
    controller: new AutonomyController(adapters),
    adapters,
    executions,
    publisher,
    task,
    ledger,
    runs,
    approvals,
  };
}
async function grant(
  ledger: AutonomyLedger,
  overrides: Partial<Parameters<AutonomyLedger['grantScope']>[0]> = {},
) {
  await ledger
    .activatePolicy(
      policy,
      ['initial_activation', 'mode_changed:human_gated->bounded'],
      'owner',
      now(),
    )
    .catch(() => undefined);
  await ledger.grantScope(
    {
      scopeId: 'goal-1',
      repositoryId: REPOSITORY.id,
      taskIds: ['I_TASK_7'],
      models: ['claude-sonnet-5'],
      budgetMicrousd: 20_000_000,
      maxTaskRuns: 3,
      expiresAt: now() + DAY,
      ...overrides,
    },
    'owner',
    now(),
  );
}
const signal = () => new AbortController().signal;

before(async () => {
  ({ admin, pool: runtimePool } = await initialize());
  controllerDb = controllerPool();
});
beforeEach(async () => {
  clock = NOW;
  await admin.query(
    'TRUNCATE factory_autonomy_locks,factory_autonomy_runs,factory_autonomy_approvals,factory_autonomy_reservations,factory_autonomy_decisions,factory_autonomy_scopes,factory_autonomy_control,factory_autonomy_policies,factory_work,factory_worker_runs CASCADE',
  );
});
after(async () => {
  await controllerDb?.end();
  await runtimePool?.end();
  await admin?.end();
});

test('a routine change travels from admission to a published PR with no human step, and re-processing is idempotent', async () => {
  const h = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
    costUsd: 0.25,
  });
  await grant(h.ledger);
  const first = await h.controller.process(7, 'goal-1', signal());
  assert.equal(first.run.state, 'published', JSON.stringify(first.run));
  assert.equal(first.run.attempt, 1);
  assert.deepEqual(
    first.decisions.map((decision) => [decision.action, decision.outcome]),
    [
      ['execute', 'allow'],
      ['publish', 'allow'],
    ],
  );
  assert.equal(h.publisher.pulls.length, 1);
  assert.match(h.publisher.pulls[0]?.body ?? '', /task-ref: I_TASK_7/);
  assert.equal(first.run.publication?.tree, first.run.candidateTree);
  assert.equal(h.executions.length, 1);
  assert.equal(h.executions[0]?.id, `autonomy-${first.run.runId}`);
  // Budget was reserved then settled from the estimate.
  const reservation = (
    await admin.query(
      'SELECT state,reserved_microusd,settled_microusd FROM factory_autonomy_reservations',
    )
  ).rows[0];
  assert.equal(reservation.state, 'settled');
  assert.equal(Number(reservation.settled_microusd), 250_000);
  // Second call: nothing new happens.
  const again = await h.controller.process(7, 'goal-1', signal());
  assert.equal(again.run.runId, first.run.runId);
  assert.equal(again.decisions.length, 0);
  assert.equal(h.executions.length, 1);
  assert.equal(h.publisher.pulls.length, 1);
  assert.equal(
    (await admin.query('SELECT count(*) AS n FROM factory_autonomy_decisions')).rows[0].n,
    '2',
  );
  // The internet-facing runtime can read the run row but not touch it.
  assert.equal(
    (await runtimePool.query('SELECT count(*) AS n FROM factory_autonomy_runs')).rows[0].n,
    '1',
  );
  await assert.rejects(
    runtimePool.query("UPDATE factory_autonomy_runs SET state='cancelled'"),
    /permission denied/,
  );
});

test("a Task already in review is this factory's only while its published attempt exists", async () => {
  const foreign = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
  });
  await grant(foreign.ledger);
  // Someone else's Task in review (no attempt of ours): refused before anything runs or is reserved.
  foreign.task.status = 'status:in_review';
  await assert.rejects(foreign.controller.process(7, 'goal-1', signal()), /task_not_proposed/);
  assert.equal(foreign.executions.length, 0);
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM factory_autonomy_runs')).rows[0].n,
    0,
  );
  // Our own publication paired the Task: the published attempt is still reachable, and a revision may start.
  foreign.task.status = 'status:proposed';
  const first = await foreign.controller.process(7, 'goal-1', signal());
  assert.equal(first.run.state, 'published');
  foreign.task.status = 'status:in_review';
  const again = await foreign.controller.process(7, 'goal-1', signal());
  assert.equal(again.run.runId, first.run.runId);
  const revision = await foreign.controller.process(7, 'goal-1', signal(), { newAttempt: true });
  assert.equal(revision.run.attempt, 2);
});

test('a crashed controller resumes mid-pipeline without repeating execution or creating a second PR', async () => {
  const h = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(h.ledger);
  const done = await h.controller.process(7, 'goal-1', signal());
  assert.equal(done.run.state, 'published');
  // Simulate a crash after execution: rewind the row and let a fresh controller continue.
  for (const state of ['executing', 'collected', 'publish_admitted']) {
    await admin.query(
      'UPDATE factory_autonomy_runs SET state=$1, publication=NULL WHERE run_id=$2',
      [state, done.run.runId],
    );
    const resumed = await h.controller.process(7, 'goal-1', signal());
    assert.equal(resumed.run.state, 'published', state);
    assert.equal(h.publisher.pulls.length, 1, `no second PR after resuming from ${state}`);
    // The branch written before the crash is adopted, not recreated (commits differ by timestamp).
    assert.equal(resumed.run.publication?.head, done.run.publication?.head, state);
  }
  // Execution was asked for at most once more, and the executor served it from its cache.
  assert.ok(h.executions.length <= 2);
});

test('important review findings trigger one bounded revision with the findings in the prompt', async () => {
  const h = harness({
    patch: JSON.stringify({
      'sum.js': '// FIXTURE_REVIEW_FINDING:high\nmodule.exports = (a, b) => a + b;\n',
    }),
  });
  await grant(h.ledger, { maxTaskRuns: 2 });
  const result = await h.controller.process(7, 'goal-1', signal());
  // Attempt 1 needs repair; attempt 2 runs with the findings appended and, producing the same flagged patch, is repaired again until attempts run out.
  const rows = await h.runs.list(REPOSITORY.id);
  assert.ok(
    rows.length >= 2,
    JSON.stringify(rows.map((row) => [row.attempt, row.state, row.reason])),
  );
  const first = rows.find((row) => row.attempt === 1);
  assert.equal(first?.state, 'repair');
  // Each attempt is its own approvable execute action: every execute decision has a distinct digest.
  const executeDigests = (
    await admin.query("SELECT action_sha256 FROM factory_autonomy_decisions WHERE action='execute'")
  ).rows.map((decision) => decision.action_sha256 as string);
  assert.ok(executeDigests.length >= 2);
  assert.equal(new Set(executeDigests).size, executeDigests.length);
  assert.match(String(h.executions[1]?.prompt ?? ''), /# Revision required[\s\S]*\[high\] F1/);
  assert.equal(
    result.decisions.some((decision) => decision.outcome === 'repair_required'),
    true,
  );
  // The ledger, not the controller, ends the loop: the third attempt cannot be admitted.
  const last = rows.find((row) => row.attempt === Math.max(...rows.map((row) => row.attempt)));
  assert.ok(['repair', 'blocked'].includes(last?.state ?? ''), JSON.stringify(last));
  assert.equal(h.publisher.pulls.length, 0);
});

test('a critical change holds for a human and proceeds only with an approval bound to that exact action', async () => {
  const h = harness({ patch: JSON.stringify({ '.github/workflows/ci.yml': 'on: push\n' }) });
  await grant(h.ledger);
  const held = await h.controller.process(7, 'goal-1', signal());
  assert.equal(held.run.state, 'held');
  assert.equal(held.run.reason, 'publish_approval_required');
  assert.equal(h.publisher.pulls.length, 0);
  const actionSha256 = String(held.run.evidence.actionSha256);
  assert.match(actionSha256, /^[0-9a-f]{64}$/);
  // Nothing changes without an approval.
  assert.equal((await h.controller.process(7, 'goal-1', signal())).run.state, 'held');
  // An approval by an unlisted user does not count.
  await h.approvals.record(
    REPOSITORY.id,
    {
      version: 1,
      kind: 'approval',
      actionSha256,
      action: 'publish',
      approver: { githubUserId: 999, type: 'User' },
      source: 'operator_console',
      approvedAt: now(),
    },
    { actor: 'x' },
    'test',
  );
  const stillHeld = await h.controller.process(7, 'goal-1', signal());
  assert.equal(stillHeld.run.state, 'held');
  await h.approvals.record(
    REPOSITORY.id,
    {
      version: 1,
      kind: 'approval',
      actionSha256,
      action: 'publish',
      approver: { githubUserId: APPROVER_ID, type: 'User' },
      source: 'operator_console',
      approvedAt: now(),
    },
    { actor: 'owner' },
    'test',
  );
  const published = await h.controller.process(7, 'goal-1', signal());
  assert.equal(published.run.state, 'published');
  assert.equal(published.decisions.at(-1)?.approvedBy, APPROVER_ID);
  assert.equal(h.publisher.pulls.length, 1);
});

test('failed acceptance sends the change to repair; a failed worker run fails the attempt and settles nothing paid', async () => {
  const failing = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a * b;\n' }),
    acceptance: {
      status: 'failed',
      protectedSuite: { total: 3, passed: 2, failed: 1, skipped: 0 },
    },
  });
  await grant(failing.ledger, { maxTaskRuns: 1 });
  const repaired = await failing.controller.process(7, 'goal-1', signal());
  assert.ok(['repair', 'blocked'].includes(repaired.run.state), JSON.stringify(repaired.run));
  assert.equal(failing.publisher.pulls.length, 0);
  await admin.query(
    'TRUNCATE factory_autonomy_runs,factory_autonomy_reservations,factory_autonomy_decisions,factory_autonomy_scopes CASCADE',
  );
  const broken = harness({ patch: '{}', outcomeOk: false });
  await grant(broken.ledger);
  const failed = await broken.controller.process(7, 'goal-1', signal());
  assert.equal(failed.run.state, 'failed');
  assert.equal(failed.run.reason, 'coding_failed');
  const reservation = (
    await admin.query('SELECT state,settled_microusd FROM factory_autonomy_reservations')
  ).rows[0];
  assert.equal(reservation.state, 'settled');
  assert.equal(Number(reservation.settled_microusd), 0);
});

test('an uncertain execution outcome keeps its reservation and stops; scope revocation and pause block admission', async () => {
  const lost = harness({ patch: '{}', failExecutions: { times: 1, reason: 'worker_lease_lost' } });
  await grant(lost.ledger);
  const uncertain = await lost.controller.process(7, 'goal-1', signal());
  assert.equal(uncertain.run.state, 'unknown');
  assert.equal(
    (await admin.query('SELECT state FROM factory_autonomy_reservations')).rows[0].state,
    'unknown',
  );
  await admin.query(
    'TRUNCATE factory_autonomy_runs,factory_autonomy_reservations,factory_autonomy_decisions,factory_autonomy_scopes CASCADE',
  );
  const paused = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
  });
  await grant(paused.ledger);
  await paused.ledger.setPaused(REPOSITORY.id, true, 'incident', 'owner', now());
  // A pause is a hold, not a refusal: the attempt keeps its state and nothing runs.
  await assert.rejects(paused.controller.process(7, 'goal-1', signal()), /autonomy_paused/);
  assert.equal(paused.executions.length, 0);
  assert.equal((await paused.runs.open(REPOSITORY.id, 'I_TASK_7'))?.state, 'admitted');
  await paused.ledger.setPaused(REPOSITORY.id, false, null, 'owner', now());
  assert.equal((await paused.controller.process(7, 'goal-1', signal())).run.state, 'published');
});

test('a changed Task or moved source under an open attempt fails that attempt instead of publishing stale work', async () => {
  const h = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(h.ledger);
  const run = await h.runs.create({
    repositoryId: REPOSITORY.id,
    scopeId: 'goal-1',
    taskId: 'I_TASK_7',
    taskNumber: 7,
    taskIssueId: 7007,
    intentSha256: '0'.repeat(64),
    sourceCommit: SOURCE,
  });
  assert.notEqual(run.intentSha256, intentDigest(h.task));
  const result = await h.controller.process(7, 'goal-1', signal());
  assert.equal(result.run.state, 'failed');
  assert.equal(result.run.reason, 'task_changed_during_attempt');
  assert.equal(h.executions.length, 0);
  assert.ok(sha256Json(policy).length === 64);
});

test('one controller per Task: a concurrent invocation fails fast and changes nothing', async () => {
  const h = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(h.ledger);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const executor = h.adapters.executor.run;
  let gated = false;
  // Only the first execution waits at the gate; a second one (which the lock must prevent) would run at once.
  h.adapters.executor.run = async (job, archive, abort) => {
    if (!gated) {
      gated = true;
      entered();
      await gate;
    }
    return executor(job, archive, abort);
  };
  const first = h.controller.process(7, 'goal-1', signal());
  await started;
  try {
    await assert.rejects(h.controller.process(7, 'goal-1', signal()), /task_run_in_progress/);
  } finally {
    release();
  }
  const done = await first;
  assert.equal(done.run.state, 'published');
  assert.equal(
    (await admin.query('SELECT count(*) AS n FROM factory_autonomy_runs')).rows[0].n,
    '1',
  );
  assert.equal(h.executions.length, 1);
});

test('a busy repository leaves the attempt executing with its reservation open; the next run finishes it', async () => {
  const h = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
    failExecutions: { times: 1, reason: 'coding_job_already_supervised' },
  });
  await grant(h.ledger);
  await assert.rejects(h.controller.process(7, 'goal-1', signal()), /worker_busy/);
  const open = await h.runs.open(REPOSITORY.id, 'I_TASK_7');
  assert.equal(open?.state, 'executing');
  assert.equal(
    (await admin.query('SELECT state FROM factory_autonomy_reservations')).rows[0].state,
    'reserved',
  );
  const done = await h.controller.process(7, 'goal-1', signal());
  assert.equal(done.run.state, 'published');
  assert.equal(h.executions.length, 2);
});

test('a publication whose confirmation fails after the branch was written is uncertain, not blocked', async () => {
  const h = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(h.ledger);
  const publish = h.adapters.publisher as NonNullable<ControllerAdapters['publisher']>;
  h.adapters.publisher = async (input) => {
    await publish(input);
    throw new UncertainPublication('publish_pull_head_not_current');
  };
  const result = await h.controller.process(7, 'goal-1', signal());
  assert.equal(result.run.state, 'unknown');
  assert.equal(result.run.reason, 'publish_pull_head_not_current');
  assert.equal(h.publisher.pulls.length, 1, 'the external effect happened');
});

test('a publication failure before any write leaves the attempt retryable and retries publish only', async () => {
  const h = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(h.ledger);
  const publish = h.adapters.publisher as NonNullable<ControllerAdapters['publisher']>;
  let attempts = 0;
  h.adapters.publisher = async (input) => {
    attempts++;
    if (attempts === 1) throw new AutonomyError('github_commit_unavailable');
    return publish(input);
  };
  await assert.rejects(h.controller.process(7, 'goal-1', signal()), /github_commit_unavailable/);
  const open = await h.runs.open(REPOSITORY.id, 'I_TASK_7');
  assert.equal(open?.state, 'publish_admitted');
  assert.equal(h.publisher.pulls.length, 0);
  const done = await h.controller.process(7, 'goal-1', signal());
  assert.equal(done.run.state, 'published');
  assert.equal(h.executions.length, 1, 'no second paid execution');
  assert.equal(attempts, 2);
});

test('pairing that fails after publication is retried by the next run and recorded on the publication', async () => {
  const h = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(h.ledger);
  let pairings = 0;
  h.adapters.afterPublish = async () => {
    pairings++;
    if (pairings === 1) throw new Error('pairing_failed');
  };
  await assert.rejects(h.controller.process(7, 'goal-1', signal()), /pairing_failed/);
  const latest = await h.runs.latest(REPOSITORY.id, 'I_TASK_7');
  assert.equal(latest?.state, 'published');
  assert.notEqual(latest?.publication?.paired, true);
  const paired = await h.controller.process(7, 'goal-1', signal());
  assert.equal(paired.run.publication?.paired, true);
  assert.equal(pairings, 2);
  assert.equal(h.publisher.pulls.length, 1);
});

test('an operator reconciles an uncertain attempt: the reservation settles and a new attempt can start', async () => {
  const h = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
    failExecutions: { times: 1, reason: 'worker_lease_lost' },
  });
  await grant(h.ledger);
  const uncertain = await h.controller.process(7, 'goal-1', signal());
  assert.equal(uncertain.run.state, 'unknown');
  await assert.rejects(
    h.controller.reconcile('00000000-0000-4000-8000-00000000dead', { state: 'released' }),
    /run_missing/,
  );
  const reconciled = await h.controller.reconcile(uncertain.run.runId, {
    state: 'settled',
    microusd: 250_000,
  });
  assert.equal(reconciled.state, 'cancelled');
  assert.equal(reconciled.reason, 'operator_reconciled');
  const reservation = (
    await admin.query('SELECT state,settled_microusd FROM factory_autonomy_reservations')
  ).rows[0];
  assert.equal(reservation.state, 'settled');
  assert.equal(Number(reservation.settled_microusd), 250_000);
  const next = await h.controller.process(7, 'goal-1', signal(), { newAttempt: true });
  assert.equal(next.run.attempt, 2);
  assert.equal(next.run.state, 'published');
});

test('an approval that arrives after the receipts expired triggers fresh verification before publishing', async () => {
  const h = harness({ patch: JSON.stringify({ '.github/workflows/ci.yml': 'on: push\n' }) });
  await grant(h.ledger, { expiresAt: NOW + 3 * DAY });
  const acceptance = h.adapters.acceptance;
  let verifications = 0;
  h.adapters.acceptance = async (input) => {
    verifications++;
    return acceptance(input);
  };
  const held = await h.controller.process(7, 'goal-1', signal());
  assert.equal(held.run.state, 'held');
  assert.equal(verifications, 1);
  clock = NOW + policy.verification.receiptTtlMs + 60_000;
  await h.approvals.record(
    REPOSITORY.id,
    {
      version: 1,
      kind: 'approval',
      actionSha256: String(held.run.evidence.actionSha256),
      action: 'publish',
      approver: { githubUserId: APPROVER_ID, type: 'User' },
      source: 'operator_console',
      approvedAt: now(),
    },
    { actor: 'owner' },
    'test',
  );
  const published = await h.controller.process(7, 'goal-1', signal());
  assert.equal(published.run.state, 'published', JSON.stringify(published.run));
  assert.equal(verifications, 2, 'stale receipts were replaced before the decision');
  assert.equal(h.publisher.pulls.length, 1);
});

test('a Task or source change while executing is uncertain, not a clean failure', async () => {
  const h = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
    failExecutions: { times: 1, reason: 'coding_job_already_supervised' },
  });
  await grant(h.ledger);
  await assert.rejects(h.controller.process(7, 'goal-1', signal()), /worker_busy/);
  h.task.sourceCommit = '2'.repeat(40);
  const moved = await h.controller.process(7, 'goal-1', signal());
  assert.equal(moved.run.state, 'unknown');
  assert.equal(moved.run.reason, 'source_moved_during_attempt');
  assert.equal(
    (await admin.query('SELECT state FROM factory_autonomy_reservations')).rows[0].state,
    'unknown',
  );
});

test('a work item that died after a lost lease is uncertain, never busy forever', async () => {
  const h = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
    failExecutions: { times: 1, reason: 'coding_job_dead' },
  });
  await grant(h.ledger);
  const dead = await h.controller.process(7, 'goal-1', signal());
  assert.equal(dead.run.state, 'unknown');
  assert.equal(dead.run.reason, 'coding_job_dead');
  assert.equal(
    (await admin.query('SELECT state FROM factory_autonomy_reservations')).rows[0].state,
    'unknown',
  );
});

test('cancel under a live controller only asks the worker to stop, refuses mid-publication, and cancels a held run', async () => {
  const h = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(h.ledger);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const executor = h.adapters.executor.run;
  let cancelRequests = 0;
  h.adapters.executor.cancel = async () => {
    cancelRequests++;
    return 1;
  };
  h.adapters.executor.run = async (job, archive, abort) => {
    entered();
    await gate;
    return executor(job, archive, abort);
  };
  const first = h.controller.process(7, 'goal-1', signal());
  await started;
  try {
    // The controller holds the Task: cancel reaches only the worker.
    const requested = await h.controller.cancel(7);
    assert.deepEqual(requested, { cancelled: false, state: 'executing', requested: 1 });
    assert.equal(cancelRequests, 1);
  } finally {
    release();
  }
  assert.equal((await first).run.state, 'published');
  // A controller inside the publisher: cancel must not create an orphan pull request.
  await admin.query(
    'TRUNCATE factory_autonomy_runs,factory_autonomy_reservations,factory_autonomy_decisions,factory_autonomy_scopes,factory_autonomy_locks CASCADE',
  );
  const g = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(g.ledger);
  let releasePublish: () => void = () => undefined;
  const publishGate = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  let publishing: () => void = () => undefined;
  const publishStarted = new Promise<void>((resolve) => {
    publishing = resolve;
  });
  const publish = g.adapters.publisher as NonNullable<ControllerAdapters['publisher']>;
  g.adapters.publisher = async (input) => {
    publishing();
    await publishGate;
    return publish(input);
  };
  const run = g.controller.process(7, 'goal-1', signal());
  await publishStarted;
  try {
    await assert.rejects(g.controller.cancel(7), /task_run_in_progress/);
  } finally {
    releasePublish();
  }
  const done = await run;
  assert.equal(done.run.state, 'published');
  assert.equal(g.publisher.pulls.length, 1);
  assert.equal(done.run.publication?.pullNumber, 1, 'the publication is recorded, no orphan');
  // A held run belongs to nobody: cancel records it.
  await admin.query(
    'TRUNCATE factory_autonomy_runs,factory_autonomy_reservations,factory_autonomy_decisions,factory_autonomy_scopes,factory_autonomy_locks CASCADE',
  );
  const held = harness({ patch: JSON.stringify({ '.github/workflows/ci.yml': 'on: push\n' }) });
  await grant(held.ledger);
  assert.equal((await held.controller.process(7, 'goal-1', signal())).run.state, 'held');
  assert.deepEqual(await held.controller.cancel(7), { cancelled: true, state: 'cancelled' });
});

test('reconcile settles what is still open, whatever the run state, and never fails on a settled reservation', async () => {
  const h = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(h.ledger);
  const publish = h.adapters.publisher as NonNullable<ControllerAdapters['publisher']>;
  h.adapters.publisher = async (input) => {
    await publish(input);
    throw new UncertainPublication('publish_pull_head_not_current');
  };
  const uncertain = await h.controller.process(7, 'goal-1', signal());
  assert.equal(uncertain.run.state, 'unknown');
  // The execution reservation was settled at 'executed'; reconcile still frees the attempt.
  const freed = await h.controller.reconcile(uncertain.run.runId, { state: 'released' });
  assert.equal(freed.state, 'cancelled');
  assert.equal(
    (await admin.query('SELECT state FROM factory_autonomy_reservations')).rows[0].state,
    'settled',
  );
  // A published run is not reconcilable ... unless its reservation was left `unknown`
  // (a live worker that reported no cost figure).
  const latest = await h.runs.latest(REPOSITORY.id, 'I_TASK_7');
  await admin.query("UPDATE factory_autonomy_runs SET state='published' WHERE run_id=$1", [
    latest?.runId,
  ]);
  await assert.rejects(
    h.controller.reconcile(latest?.runId as string, { state: 'released' }),
    /reconcile_requires_uncertain_run_or_reservation/,
  );
  await admin.query(
    "UPDATE factory_autonomy_reservations SET state='unknown', settled_microusd=NULL, settled_at=NULL",
  );
  const settled = await h.controller.reconcile(latest?.runId as string, {
    state: 'settled',
    microusd: 120_000,
  });
  assert.equal(settled.state, 'published', 'the run itself is untouched');
  const reservation = (
    await admin.query('SELECT state,settled_microusd FROM factory_autonomy_reservations')
  ).rows[0];
  assert.equal(reservation.state, 'settled');
  assert.equal(Number(reservation.settled_microusd), 120_000);
});

test('controller locks live in rows the runtime role cannot touch, and recovery waits for quiet', async () => {
  await assert.rejects(
    runtimePool.query('SELECT 1 FROM factory_autonomy_locks FOR UPDATE'),
    /permission denied/,
  );
  await assert.rejects(
    runtimePool.query('SELECT 1 FROM factory_autonomy_locks'),
    /permission denied/,
  );
  const h = harness({ patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }) });
  await grant(h.ledger);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const executor = h.adapters.executor.run;
  h.adapters.executor.run = async (job, archive, abort) => {
    entered();
    await gate;
    return executor(job, archive, abort);
  };
  const first = h.controller.process(7, 'goal-1', signal());
  await started;
  try {
    await assert.rejects(
      quiesceController(controllerDb, REPOSITORY.id, async () => 'swept'),
      /controller_busy/,
    );
  } finally {
    release();
  }
  assert.equal((await first).run.state, 'published');
  assert.equal(await quiesceController(controllerDb, REPOSITORY.id, async () => 'swept'), 'swept');
});

test('an uncertain attempt is never rewritten: not by a moved source, not by cancel', async () => {
  const h = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
    failExecutions: { times: 1, reason: 'worker_lease_lost' },
  });
  await grant(h.ledger);
  const uncertain = await h.controller.process(7, 'goal-1', signal());
  assert.equal(uncertain.run.state, 'unknown');
  h.task.sourceCommit = '2'.repeat(40);
  const again = await h.controller.process(7, 'goal-1', signal(), { newAttempt: true });
  assert.equal(again.run.runId, uncertain.run.runId);
  assert.equal(again.run.state, 'unknown', 'a moved source does not turn uncertainty into failure');
  assert.equal(again.run.attempt, 1, 'no new attempt while the uncertain one is unsettled');
  await assert.rejects(h.controller.cancel(7), /reconcile_required/);
  assert.equal(
    (await admin.query('SELECT state FROM factory_autonomy_reservations')).rows[0].state,
    'unknown',
  );
});

test('a worker failure after the paid container started keeps the spend uncertain; one before it settles at zero', async () => {
  const timedOut = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
    failExecutions: { times: 1, reason: 'worker_timed_out', started: true },
  });
  await grant(timedOut.ledger);
  const failed = await timedOut.controller.process(7, 'goal-1', signal());
  assert.equal(failed.run.state, 'failed');
  assert.equal(failed.run.reason, 'worker_timed_out');
  assert.equal(
    (await admin.query('SELECT state FROM factory_autonomy_reservations')).rows[0].state,
    'unknown',
  );
  const settled = await timedOut.controller.reconcile(failed.run.runId, {
    state: 'settled',
    microusd: 300_000,
  });
  assert.equal(settled.state, 'failed');
  assert.equal(
    Number(
      (await admin.query('SELECT settled_microusd FROM factory_autonomy_reservations')).rows[0]
        .settled_microusd,
    ),
    300_000,
  );
  await admin.query(
    'TRUNCATE factory_autonomy_runs,factory_autonomy_reservations,factory_autonomy_decisions,factory_autonomy_scopes,factory_autonomy_locks CASCADE',
  );
  const denied = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
    failExecutions: { times: 1, reason: 'worker_activation_denied', started: false },
  });
  await grant(denied.ledger);
  const refused = await denied.controller.process(7, 'goal-1', signal());
  assert.equal(refused.run.state, 'failed');
  const reservation = (
    await admin.query('SELECT state,settled_microusd FROM factory_autonomy_reservations')
  ).rows[0];
  assert.equal(reservation.state, 'settled');
  assert.equal(Number(reservation.settled_microusd), 0);
});

test('pause and revocation stop resumption of open attempts, not only admission', async () => {
  const h = harness({
    patch: JSON.stringify({ 'sum.js': 'module.exports = (a, b) => a + b;\n' }),
    failExecutions: { times: 1, reason: 'coding_job_already_supervised' },
  });
  await grant(h.ledger);
  await assert.rejects(h.controller.process(7, 'goal-1', signal()), /worker_busy/);
  await h.ledger.setPaused(REPOSITORY.id, true, 'incident', 'owner', now());
  await assert.rejects(h.controller.process(7, 'goal-1', signal()), /autonomy_paused/);
  assert.equal((await h.runs.open(REPOSITORY.id, 'I_TASK_7'))?.state, 'executing');
  assert.equal(h.executions.length, 1, 'the paused attempt did not run the worker again');
  await h.ledger.setPaused(REPOSITORY.id, false, null, 'owner', now());
  await h.ledger.revokeScope('goal-1', 'incident over, scope closed', 'owner', now());
  await assert.rejects(h.controller.process(7, 'goal-1', signal()), /scope_revoked/);
  assert.equal((await h.runs.open(REPOSITORY.id, 'I_TASK_7'))?.state, 'executing');
});
