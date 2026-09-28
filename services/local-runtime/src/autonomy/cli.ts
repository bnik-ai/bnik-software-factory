import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Pool } from 'pg';
import {
  type AutonomyConfig,
  type ControllerConfig,
  type RuntimeConfig,
  databaseConfig,
  resolveConfig,
  resolveControllerConfig,
} from '../config.js';
import { createLocalPool } from '../database.js';
import { PAIRED_TASK_STATUSES, PROPOSED_TASK_STATUSES, prepareTask } from '../github/activation.js';
import { GitHubFailure, InstallationClient } from '../github/client.js';
import { type Pair, headRepositoryIds, pairPull } from '../github/merge-gate.js';
import { HumanMergeGate } from '../github/reconcile.js';
import { checkSchema } from '../migrate.js';
import { Docker } from '../worker/docker.js';
import type { CodingJob } from '../worker/protocol.js';
import { RunRecords, runLimits } from '../worker/records.js';
import { githubArchive } from '../worker/source.js';
import { CodingSupervisor } from '../worker/supervisor.js';
import { type AcceptanceBundle, loadAcceptanceBundle, runAcceptance } from './acceptance.js';
import { collectChanges } from './collector.js';
import {
  AutonomyController,
  type ControllerAdapters,
  type LoadedTask,
  type TaskSource,
  intentDigest,
  quiesceController,
  reconcileRun,
} from './controller.js';
import {
  FixtureScanner,
  type ScannerAdapter,
  TrivyScanner,
  runDependencyVerification,
} from './dependency.js';
import type { ApprovalRecord } from './evidence.js';
import { ApprovalStore, AutonomyLedger } from './ledger.js';
import { MergeController } from './merge-controller.js';
import { observeMergeGate } from './merge.js';
import { GitHubMerger } from './merger.js';
import { AutonomyMerges } from './merges.js';
import { type AutonomyPolicy, loadPolicy, policyDigest } from './policy.js';
import { GitHubPublisher } from './publisher.js';
import {
  ClaudeReviewer,
  FixtureReviewer,
  type Reviewer,
  reviewerConfigDigest,
} from './reviewer.js';
import { type AutonomyRun, AutonomyRuns } from './runs.js';
import { sweepSandboxes } from './sandbox.js';
import { AutonomyError, requireAutonomy, sha256Json } from './schema.js';
import { costView } from './views.js';

/**
 * Operator CLI for bounded autonomy. Every command runs with the controller database
 * identity; the internet-facing runtime never gains these grants. Nothing here is
 * reachable from a webhook: an operator invokes it, or a scheduled operator job does.
 *
 *   autonomy activate --acknowledge code,code   activate the configured policy file
 *   autonomy status                             active policy, pause, scopes, runs
 *   autonomy grant --scope ID --tasks N,N --budget-usd X --max-runs N --expires-hours H
 *   autonomy revoke --scope ID --reason TEXT
 *   autonomy pause --reason TEXT | autonomy resume
 *   autonomy approve --action SHA256 --kind execute|publish --approver GITHUB_USER_ID   (a merge hold takes a native review)
 *   autonomy intent TASK_NUMBER [--task-file F]   the Task's intent digest, to bind in a grant
 *   autonomy pin [--env]                       digests the policy must pin for this installation
 *   autonomy run TASK_NUMBER --scope ID [--new-attempt] [--task-file F --archive F]  (demo)
 *   autonomy cancel TASK_NUMBER
 *   autonomy merge TASK_NUMBER                  merge the Task's published pull request under the policy (live, FACTORY_AUTOMERGE=enabled)
 *   autonomy merge-scan                        every published attempt whose merge is not settled
 *   autonomy reconcile --run RUN_ID (--spent-usd X | --released)   settle an unknown or cancelled attempt
 *   autonomy recover
 */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
function requireFlag(name: string): string {
  const value = flag(name);
  if (value === undefined || value.startsWith('--'))
    throw new AutonomyError(`${name}_flag_required`);
  return value;
}
function print(value: unknown) {
  console.log(JSON.stringify(value));
}
async function controllerPool(config: ControllerConfig): Promise<Pool> {
  const pool = createLocalPool({
    ...databaseConfig(process.env),
    user: 'factory_controller',
    password: config.controllerDatabasePassword,
  });
  await checkSchema(pool);
  const identity = (await pool.query('SELECT session_user AS principal')).rows[0]?.principal;
  if (identity !== 'factory_controller')
    throw new AutonomyError('controller_database_identity_required');
  return pool;
}
function reviewerFor(config: RuntimeConfig, autonomy: AutonomyConfig, image: string): Reviewer {
  if (autonomy.reviewer.adapter === 'fixture') return new FixtureReviewer();
  requireAutonomy(config.modelKey !== undefined, 'model_credential_required_for_reviewer');
  return new ClaudeReviewer({
    image,
    modelKey: config.modelKey,
    config: {
      adapter: 'claude',
      model: autonomy.reviewer.model,
      promptVersion: autonomy.reviewer.promptVersion,
      maxTokens: autonomy.reviewer.maxTokens,
      maxDiffBytes: autonomy.reviewer.maxDiffBytes,
    },
  });
}
function scannerFor(autonomy: AutonomyConfig): ScannerAdapter | null {
  if (autonomy.scanner === null) return null;
  if (autonomy.scanner.adapter === 'fixture') return new FixtureScanner();
  return new TrivyScanner({
    reference: autonomy.scanner.reference as string,
    cacheVolume: autonomy.scanner.cacheVolume as string,
  });
}
/** Trust roots the policy must match before any sandbox runs: refuse loudly, not silently. */
function assertTrustRoots(
  policy: AutonomyPolicy,
  bundle: AcceptanceBundle,
  reviewer: Reviewer,
  workerImageId: string,
) {
  requireAutonomy(
    policy.verification.acceptanceSuiteSha256 === bundle.suiteSha256,
    'policy_suite_digest_mismatch',
  );
  requireAutonomy(
    policy.verification.acceptanceHarnessSha256 === bundle.harnessSha256,
    'policy_harness_digest_mismatch',
  );
  requireAutonomy(
    policy.verification.acceptanceRunnerImage === workerImageId,
    'policy_runner_image_mismatch',
  );
  requireAutonomy(
    policy.verification.reviewerConfigSha256 === reviewerConfigDigest(reviewer.config),
    'policy_reviewer_config_mismatch',
  );
}
async function demoTaskSource(requireArchive = true): Promise<TaskSource> {
  const taskFile = requireFlag('task-file');
  const archiveFile = requireArchive ? requireFlag('archive') : flag('archive');
  requireAutonomy(
    isAbsolute(taskFile) && (archiveFile === undefined || isAbsolute(archiveFile)),
    'absolute_paths_required',
  );
  const definition = JSON.parse(await readFile(taskFile, 'utf8')) as Record<string, unknown>;
  const archive = archiveFile === undefined ? Buffer.alloc(0) : await readFile(archiveFile);
  const task: LoadedTask = {
    id: String(definition.id ?? 'I_DEMO_TASK'),
    issueId: Number(definition.issueId ?? 1),
    number: Number(definition.number ?? 1),
    title: String(definition.title ?? 'Demo task'),
    body: String(definition.body ?? ''),
    intentKind: definition.intentKind === 'bugfix' ? 'bugfix' : 'change',
    definition: {
      prompt: String(definition.prompt ?? 'demo'),
      tests: Array.isArray(definition.tests) ? (definition.tests as string[]) : [],
      maxTurns: Number(definition.maxTurns ?? 2),
      timeoutMs: Number(definition.timeoutMs ?? 30_000),
      fixtureCommand: String(definition.fixtureCommand ?? 'exit 1'),
    },
    sourceCommit: String(definition.sourceCommit ?? '1'.repeat(40)),
    status: 'status:proposed',
  };
  return { load: async () => task, archive: async () => archive };
}
function liveTaskSource(
  config: RuntimeConfig,
  github: InstallationClient,
  signal: AbortSignal,
): TaskSource {
  return {
    load: async (taskNumber) => {
      const repository = (await github.check()).repository;
      const head = await github.read<{ sha: string }>(
        `/repos/${config.repository}/commits/${encodeURIComponent(repository.default_branch)}`,
      );
      // Proposed Tasks start attempts; paired ones (backlink written at publication) merge or revise.
      const snapshot = await prepareTask(config, github, taskNumber, head.sha, [
        ...PROPOSED_TASK_STATUSES,
        ...PAIRED_TASK_STATUSES,
      ]);
      const body = snapshot.issue.body ?? '';
      return {
        id: snapshot.issue.node_id,
        issueId: snapshot.issue.id,
        number: snapshot.issue.number,
        title: snapshot.issue.title,
        body,
        intentKind: /^intent-kind:\s*bugfix\s*$/m.test(body) ? 'bugfix' : 'change',
        definition: snapshot.definition,
        sourceCommit: snapshot.sourceCommit,
        status: snapshot.issue.labels
          .map((label) => label.name)
          .find((name) => name.startsWith('status:')) as string,
      };
    },
    archive: (sourceCommit) =>
      githubArchive(
        {
          repository: config.repository,
          installationId: config.installationId,
          appId: config.appId as string,
          appPrivateKey: config.appPrivateKey as string,
        },
        sourceCommit,
        signal,
      ),
  };
}
/** Operator-facing view of a run's verification: receipt statuses and the runner reasons behind them. */
function changedPaths(run: AutonomyRun): string[] | null {
  const manifest = run.evidence.manifest as
    | { files?: { oldPath: string | null; newPath: string | null }[] }
    | undefined;
  if (!manifest?.files) return null;
  return [
    ...new Set(
      manifest.files.flatMap((file) =>
        [file.oldPath, file.newPath].filter((path): path is string => path !== null),
      ),
    ),
  ].sort();
}
function verificationView(run: AutonomyRun) {
  const receipt = (kind: string) => run.receipts[kind] as Record<string, unknown> | undefined;
  const acceptance = receipt('acceptance');
  const review = receipt('review');
  const dependency = receipt('dependency');
  return {
    acceptance: acceptance
      ? {
          status: acceptance.status ?? null,
          protectedSuite: acceptance.protectedSuite ?? null,
          reproducer: acceptance.reproducer ?? null,
          reason: run.evidence.acceptanceReason ?? null,
        }
      : null,
    review: review
      ? {
          status: review.status ?? null,
          risk: review.risk ?? null,
          reason: run.evidence.reviewReason ?? null,
        }
      : null,
    dependency: dependency
      ? {
          status: dependency.status ?? null,
          resolution: dependency.resolution ?? null,
          reason: run.evidence.dependencyReason ?? null,
        }
      : null,
  };
}

async function main() {
  const command = process.argv[2] ?? '';
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => controller.abort());
  const controllerConfig = resolveControllerConfig();
  const pool = await controllerPool(controllerConfig);
  const actor = process.env.FACTORY_OPERATOR_ACTOR ?? 'operator-console';
  /**
   * The full runtime configuration, resolved only for container-driving commands: their
   * roles mount the App, model and publisher secrets live mode requires; ledger commands
   * run without them.
   */
  let fullConfig: { config: RuntimeConfig; autonomy: AutonomyConfig } | undefined;
  const runtime = () => {
    if (!fullConfig) {
      const config = resolveConfig();
      requireAutonomy(config.autonomy !== undefined, 'autonomy_not_configured');
      fullConfig = { config, autonomy: config.autonomy };
    }
    return fullConfig;
  };
  try {
    const ledger = new AutonomyLedger(pool);
    const runs = new AutonomyRuns(pool);
    const approvals = new ApprovalStore(pool);
    const now = Date.now();
    if (command === 'activate') {
      const proposed = loadPolicy(controllerConfig.policyFile);
      const acknowledged = (flag('acknowledge') ?? '')
        .split(',')
        .map((code) => code.trim())
        .filter(Boolean);
      const result = await ledger.activatePolicy(proposed, acknowledged, actor, now);
      print({ activated: result.policySha256, acknowledgedWeakenings: result.weakenings });
      return;
    }
    // intent and pin need the full configuration but no active policy: the policy file may
    // still hold the placeholders pin is about to fill.
    if (command === 'intent') {
      const { config } = runtime();
      const taskNumber = Number(process.argv[3]);
      requireAutonomy(Number.isSafeInteger(taskNumber) && taskNumber > 0, 'task_number_required');
      const source =
        config.mode === 'live'
          ? liveTaskSource(
              config,
              new InstallationClient(config, controller.signal),
              controller.signal,
            )
          : await demoTaskSource(false);
      const task = await source.load(taskNumber);
      const intentSha256 = intentDigest(task);
      print({
        taskId: task.id,
        number: task.number,
        title: task.title,
        intentSha256,
        grant: `${task.id}=${intentSha256}`,
      });
      return;
    }
    if (command === 'pin') {
      const { config, autonomy } = runtime();
      const docker = new Docker();
      const image = process.env.FACTORY_WORKER_IMAGE ?? 'software-factory-worker:development';
      const bundle = await loadAcceptanceBundle(autonomy.bundleDirectory);
      const reviewer = reviewerFor(config, autonomy, image);
      const scanner = scannerFor(autonomy);
      const pins = {
        acceptanceSuiteSha256: bundle.suiteSha256,
        acceptanceHarnessSha256: bundle.harnessSha256,
        acceptanceRunnerImage: await docker.checked([
          'image',
          'inspect',
          image,
          '--format',
          '{{.Id}}',
        ]),
        reviewerConfigSha256: reviewerConfigDigest(reviewer.config),
        scannerAdapter: scanner?.name ?? null,
        scannerImage: scanner ? await scanner.image() : null,
      };
      if (process.argv.includes('--env'))
        for (const [key, value] of Object.entries(pins))
          if (value !== null)
            console.log(
              `${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}=${value}`,
            );
      if (!process.argv.includes('--env')) print(pins);
      return;
    }
    const policyRepositoryId =
      controllerConfig.repositoryId ?? loadPolicy(controllerConfig.policyFile).repository.id;
    if (command === 'status') {
      const active = await ledger.activePolicy(policyRepositoryId);
      const control =
        (
          await pool.query(
            'SELECT paused,pause_reason,updated_at FROM factory_autonomy_control WHERE repository_id=$1',
            [policyRepositoryId],
          )
        ).rows[0] ?? null;
      const scopes = (
        await pool.query(
          'SELECT scope_id,task_ids,task_intents,budget_microusd,max_task_runs,expires_at,revoked_at FROM factory_autonomy_scopes WHERE repository_id=$1 ORDER BY granted_at DESC LIMIT 50',
          [policyRepositoryId],
        )
      ).rows;
      print({
        activePolicySha256: active ? policyDigest(active) : null,
        mode: active?.mode ?? null,
        paused: control?.paused ?? null,
        pauseReason: control?.pause_reason ?? null,
        scopes,
        merges: (await new AutonomyMerges(pool).list(policyRepositoryId, 50)).map((merge) => ({
          runId: merge.runId,
          pullNumber: merge.pullNumber,
          state: merge.state,
          reason: merge.reason,
          head: merge.head,
          mergeCommit: merge.mergeCommit,
          actionSha256: merge.evidence.actionSha256 ?? null,
          updatedAt: merge.updatedAt,
        })),
        runs: (await runs.list(policyRepositoryId, 50)).map((run) => ({
          runId: run.runId,
          task: run.taskNumber,
          attempt: run.attempt,
          state: run.state,
          reason: run.reason,
          tree: run.candidateTree,
          publication: run.publication,
          verification: verificationView(run),
          actionSha256: run.evidence.actionSha256 ?? null,
          ...costView(run),
          updatedAt: run.updatedAt,
        })),
      });
      return;
    }
    if (command === 'grant') {
      // --tasks ID[=INTENT_SHA256],...: live grants bind every Task to the intent the owner
      // reviewed (`autonomy intent N` prints it); demo grants may name Tasks alone.
      const taskIds: string[] = [];
      const taskIntents: Record<string, string> = {};
      for (const entry of requireFlag('tasks')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)) {
        const [taskId, intent, ...rest] = entry.split('=');
        requireAutonomy(taskId && rest.length === 0, 'grant_tasks_invalid');
        taskIds.push(taskId);
        if (intent !== undefined) taskIntents[taskId] = intent;
      }
      requireAutonomy(
        controllerConfig.mode === 'demo' || taskIds.every((taskId) => taskId in taskIntents),
        'scope_intent_required_in_live',
      );
      const hours = Number(requireFlag('expires-hours'));
      const budgetUsd = Number(requireFlag('budget-usd'));
      requireAutonomy(
        Number.isFinite(hours) &&
          hours > 0 &&
          hours <= 720 &&
          Number.isFinite(budgetUsd) &&
          budgetUsd > 0,
        'grant_flags_invalid',
      );
      const result = await ledger.grantScope(
        {
          scopeId: requireFlag('scope'),
          repositoryId: policyRepositoryId,
          taskIds,
          taskIntents,
          models: (
            flag('models') ??
            (await ledger.activePolicy(policyRepositoryId))?.execution.models.join(',') ??
            ''
          )
            .split(',')
            .map((model) => model.trim())
            .filter(Boolean),
          budgetMicrousd: Math.round(budgetUsd * 1_000_000),
          maxTaskRuns: Number(requireFlag('max-runs')),
          expiresAt: now + Math.round(hours * 3_600_000),
        },
        actor,
        now,
      );
      print(result);
      return;
    }
    if (command === 'revoke') {
      await ledger.revokeScope(requireFlag('scope'), requireFlag('reason'), actor, now);
      print({ revoked: requireFlag('scope') });
      return;
    }
    if (command === 'pause' || command === 'resume') {
      await ledger.setPaused(
        policyRepositoryId,
        command === 'pause',
        command === 'pause' ? requireFlag('reason') : null,
        actor,
        now,
      );
      print({ paused: command === 'pause' });
      return;
    }
    if (command === 'reconcile') {
      const runId = requireFlag('run');
      const spent = flag('spent-usd');
      const released = process.argv.includes('--released');
      requireAutonomy(
        (spent !== undefined) !== released,
        'reconcile_requires_spent_usd_or_released',
      );
      const microusd = spent === undefined ? 0 : Math.round(Number(spent) * 1_000_000);
      requireAutonomy(
        Number.isSafeInteger(microusd) && microusd >= 0,
        'reconcile_spent_usd_invalid',
      );
      const settled = await reconcileRun(
        pool,
        ledger,
        runs,
        policyRepositoryId,
        runId,
        released ? { state: 'released' } : { state: 'settled', microusd },
        now,
      );
      print({
        reconciled: runId,
        state: settled.state,
        settlement: released ? 'released' : microusd,
      });
      return;
    }
    if (command === 'approve') {
      const kind = requireFlag('kind');
      // A merge hold is unlocked by a native GitHub review of the exact head, never from here.
      requireAutonomy(['execute', 'publish'].includes(kind), 'approval_kind_invalid');
      const approver = Number(requireFlag('approver'));
      const approval: ApprovalRecord = {
        version: 1,
        kind: 'approval',
        actionSha256: requireFlag('action'),
        action: kind as ApprovalRecord['action'],
        approver: { githubUserId: approver, type: 'User' },
        source: 'operator_console',
        approvedAt: now,
      };
      await approvals.record(policyRepositoryId, approval, { actor }, actor);
      print({ recorded: approval.actionSha256, approver });
      return;
    }
    const { config, autonomy } = runtime();
    const docker = new Docker();
    const image = process.env.FACTORY_WORKER_IMAGE ?? 'software-factory-worker:development';
    if (command === 'recover') {
      // Nothing is swept while a controller command is active: the sweep would kill its sandboxes.
      const swept = await quiesceController(pool, policyRepositoryId, async () => {
        await new CodingSupervisor({
          pool,
          repository: config.repository,
          mode: config.mode,
          image,
          signal: controller.signal,
          limits: runLimits(process.env),
        }).recover();
        return sweepSandboxes(docker);
      });
      print({ recovered: config.repository, sandboxes: swept });
      return;
    }
    requireAutonomy(
      ['run', 'cancel', 'merge', 'merge-scan'].includes(command),
      'autonomy_command_required',
    );
    const taskNumber = command === 'merge-scan' ? 1 : Number(process.argv[3]);
    requireAutonomy(Number.isSafeInteger(taskNumber) && taskNumber > 0, 'task_number_required');
    const policy = await ledger.activePolicy(policyRepositoryId);
    requireAutonomy(policy !== null, 'autonomy_policy_not_active');
    requireAutonomy(
      policyDigest(policy) === policyDigest(loadPolicy(autonomy.policyFile)),
      'policy_file_differs_from_active_policy',
    );
    requireAutonomy(
      config.mergePolicy === undefined ||
        config.mergePolicy.baseBranch === policy.repository.baseBranch,
      'merge_policy_base_branch_differs_from_autonomy_policy',
    );
    const bundle = await loadAcceptanceBundle(autonomy.bundleDirectory);
    const reviewer = reviewerFor(config, autonomy, image);
    const workerImageId = await docker.checked(['image', 'inspect', image, '--format', '{{.Id}}']);
    assertTrustRoots(policy, bundle, reviewer, workerImageId);
    const scanner = scannerFor(autonomy);
    const github =
      config.mode === 'live' ? new InstallationClient(config, controller.signal) : null;
    const taskSource =
      config.mode === 'live'
        ? liveTaskSource(config, github as InstallationClient, controller.signal)
        : await demoTaskSource();
    const records = new RunRecords(pool);
    const supervisor = new CodingSupervisor({
      pool,
      repository: config.repository,
      mode: config.mode,
      image,
      modelKey: config.modelKey,
      signal: controller.signal,
      limits: runLimits(process.env),
      // Bounded mode: the consumed ledger admission on the run row is the authorization.
      authorize: async (job: CodingJob) => {
        const row = (
          await pool.query(
            "SELECT 1 FROM factory_autonomy_runs WHERE worker_job_id=$1 AND state='executing' AND source_commit=$2 AND repository_id=$3",
            [job.id, job.sourceCommit, policyRepositoryId],
          )
        ).rows[0];
        if (!row) throw new AutonomyError('bounded_execution_not_admitted');
      },
    });
    let publisher: ControllerAdapters['publisher'] = null;
    if (autonomy.publisher && config.mode === 'live') {
      const base = { fullName: config.repository, id: config.repositoryId as number };
      const write =
        autonomy.publisher.mode === 'fork'
          ? {
              fullName: autonomy.publisher.forkRepository as string,
              id: autonomy.publisher.forkRepositoryId as number,
            }
          : base;
      const gitHub = new GitHubPublisher(
        {
          appId: autonomy.publisher.appId,
          appPrivateKey: autonomy.publisher.appPrivateKey,
          installationId: autonomy.publisher.installationId,
        },
        write,
        base,
        controller.signal,
      );
      publisher = (input) => gitHub.publish(input);
    }
    const adapters: ControllerAdapters = {
      pool,
      ledger,
      runs,
      approvals,
      taskSource,
      executor: {
        run: async (job, archive, signal) => {
          signal.throwIfAborted();
          await supervisor.submit(job).catch(() => undefined);
          return supervisor.run(job.id, archive);
        },
        cancel: (jobId) => supervisor.cancel(jobId),
        mayHaveStarted: async (jobId) =>
          (
            await pool.query<{ started: boolean | null }>(
              `SELECT bool_or(COALESCE((r.evidence->>'executionMayHaveStarted')::boolean,false)) AS started
               FROM factory_worker_runs r JOIN factory_work w ON w.id=r.work_id
               WHERE w.queue_name='CodingJob' AND w.delivery_key=$1 AND w.record_key=$2`,
              [jobId, config.repository.toLowerCase()],
            )
          ).rows[0]?.started === true,
      },
      collect: (archive, patch, signal) =>
        collectChanges({ docker, image, runId: randomUUID(), archive, patch, signal }),
      acceptance: (input) =>
        runAcceptance({
          docker,
          image,
          archive: input.archive,
          patch: input.patch,
          baseTree: input.baseTree,
          candidateTree: input.candidateTree,
          subject: {
            repositoryId: input.subject.repositoryId,
            taskId: input.subject.taskId,
            base: input.subject.base,
            tree: input.subject.tree,
            changesSha256: input.subject.changesSha256,
          },
          bundle,
          intentKind: input.intentKind,
          signal: input.signal,
        }),
      reviewer,
      dependency: scanner
        ? (input) =>
            runDependencyVerification({
              docker,
              image,
              archive: input.archive,
              patch: input.patch,
              candidateTree: input.candidateTree,
              manifestPaths: input.manifestPaths,
              subject: input.subject,
              scanner,
              signal: input.signal,
            })
        : null,
      publisher,
      afterPublish:
        config.mode === 'live' && github && config.mergePolicy
          ? async (run, publication) => {
              // Pair the Task the way the human flow does by hand: backlink and `status:in_review`
              // (idempotent), then the immutable pair. A revision finds the pair registered already.
              await github.pairTask(run.taskNumber, publication.pullNodeId);
              const pair = await pairPull(
                config,
                github,
                run.taskNumber,
                publication.pullNumber,
                publication.head,
                { headRepositoryIds: headRepositoryIds(config) },
              );
              await records.linkPublication(`autonomy-${run.runId}`, config.repository, pair);
              const registered = (
                await pool.query(
                  'SELECT 1 FROM factory_pr_pairs WHERE repository_id=$1 AND installation_id=$2 AND pull_number=$3',
                  [policyRepositoryId, config.installationId, publication.pullNumber],
                )
              ).rows[0];
              if (registered) return;
              const gate = new HumanMergeGate(pool, config, github);
              try {
                await gate.track(run.taskNumber, publication.pullNumber, publication.head);
              } finally {
                await gate.close();
              }
            }
          : undefined,
      bundle,
      policy,
      repository: {
        id: policyRepositoryId,
        installationId: config.installationId,
        fullName: config.repository,
        baseBranch: policy.repository.baseBranch,
      },
      mode: config.mode,
      actor,
    };
    const autonomyController = new AutonomyController(adapters);
    if (command === 'cancel') {
      print(await autonomyController.cancel(taskNumber));
      return;
    }
    if (command === 'merge' || command === 'merge-scan') {
      // Automatic merge: live only, with the merge policy's protections and a merger App distinct
      // from the publisher. Everything it decides on is re-read from GitHub at merge time.
      requireAutonomy(config.mode === 'live' && github !== null, 'automerge_requires_live_mode');
      requireAutonomy(autonomy.merger !== null, 'automerge_not_enabled');
      requireAutonomy(config.mergePolicy !== undefined, 'merge_policy_not_configured');
      const mergerIdentity = autonomy.merger;
      const merger = new GitHubMerger(
        {
          appId: mergerIdentity.appId,
          appPrivateKey: mergerIdentity.appPrivateKey,
          installationId: mergerIdentity.installationId,
        },
        { fullName: config.repository, id: policyRepositoryId },
        mergerIdentity.appSlug,
        controller.signal,
      );
      const mergeController = new MergeController({
        pool,
        ledger,
        runs,
        merges: new AutonomyMerges(pool),
        approvals,
        policy,
        repository: adapters.repository,
        taskSource,
        actor,
        now: Date.now,
        // The pairing registered at publication is the one merges verify against; a fresh check otherwise.
        loadPair: async (run, pullNumber, head) => {
          const registered = (
            await pool.query<{ pair: Pair }>(
              'SELECT pair FROM factory_pr_pairs WHERE repository_id=$1 AND installation_id=$2 AND pull_number=$3',
              [policyRepositoryId, config.installationId, pullNumber],
            )
          ).rows[0]?.pair;
          return (
            registered ??
            pairPull(config, github, run.taskNumber, pullNumber, head, {
              headRepositoryIds: headRepositoryIds(config),
            })
          );
        },
        observe: (pair, expectation) =>
          observeMergeGate(config, github, pair, expectation, Date.now),
        perform: (work) => merger.perform(work),
        // Expired receipts: the same base archive and recorded patch rebuild the same tree.
        reverify: async (run) => {
          const task = await taskSource.load(run.taskNumber);
          const archive = await taskSource.archive(run.sourceCommit as string, controller.signal);
          const fresh = await autonomyController.verifyCandidate(
            run,
            task,
            archive,
            controller.signal,
          );
          return fresh.receipts as { acceptance: unknown; review: unknown; dependency?: unknown };
        },
        // Reconcile promptly: the gate accepts this exact merge commit by the merger App. The
        // record says reconciled only when the gate's own state for the pull request says so.
        afterMerge: async (_run, merge) => {
          const gate = new HumanMergeGate(pool, config, github);
          const gateState = async () =>
            (
              await pool.query<{ state: string; reason: string }>(
                'SELECT state,reason FROM factory_pr_state WHERE repository_id=$1 AND pull_number=$2',
                [policyRepositoryId, merge.pullNumber],
              )
            ).rows[0];
          try {
            await gate.queue.enqueue(randomUUID(), config.repository.toLowerCase(), {
              pull: merge.pullNumber,
              repositoryId: policyRepositoryId,
              installationId: config.installationId,
            });
            for (let i = 0; i < 10 && (await gate.step()); i++) {
              controller.signal.throwIfAborted();
              if ((await gateState())?.state === 'reconciled') break;
            }
          } finally {
            await gate.close();
          }
          const settled = await gateState();
          requireAutonomy(
            settled?.state === 'reconciled',
            `gate_${settled?.state ?? 'unprocessed'}:${settled?.reason ?? 'queued'}`,
          );
        },
      });
      if (command === 'merge-scan') {
        print({ scanned: await mergeController.scan(), tokenRevoked: merger.lastTokenRevoked });
        return;
      }
      const result = await mergeController.merge(taskNumber);
      print({
        mergeId: result.merge.mergeId,
        runId: result.merge.runId,
        pullNumber: result.merge.pullNumber,
        state: result.merge.state,
        reason: result.merge.reason,
        head: result.merge.head,
        mergeCommit: result.merge.mergeCommit,
        actionSha256: result.merge.evidence.actionSha256 ?? null,
        decisions: result.decisions.map((decision) => ({
          action: decision.action,
          outcome: decision.outcome,
          risk: decision.risk,
          reasons: decision.reasons.map((reason) => reason.code),
        })),
        tokenRevoked: merger.lastTokenRevoked,
        policySha256: sha256Json(policy),
      });
      if (!['merged', 'held'].includes(result.merge.state)) process.exitCode = 1;
      return;
    }
    const result = await autonomyController.process(
      taskNumber,
      requireFlag('scope'),
      controller.signal,
      {
        newAttempt: process.argv.includes('--new-attempt'),
      },
    );
    print({
      runId: result.run.runId,
      attempt: result.run.attempt,
      state: result.run.state,
      reason: result.run.reason,
      tree: result.run.candidateTree,
      publication: result.run.publication,
      verification: verificationView(result.run),
      // The digest a console approval must name for a held run.
      actionSha256: result.run.evidence.actionSha256 ?? null,
      // What the collected change touches, and what the worker removed or saw generated.
      changedPaths: changedPaths(result.run),
      generatedPaths:
        (result.run.evidence.testSideEffects as { generatedPaths?: string[] } | undefined)
          ?.generatedPaths ?? null,
      ...costView(result.run),
      decisions: result.decisions.map((decision) => ({
        action: decision.action,
        outcome: decision.outcome,
        risk: decision.risk,
        reasons: decision.reasons.map((reason) => reason.code),
      })),
      policySha256: sha256Json(policy),
    });
    if (!['published', 'held'].includes(result.run.state)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof AutonomyError
      ? error.reason
      : error instanceof GitHubFailure
        ? error.reason
        : 'autonomy_command_failed',
  );
  process.exitCode = 1;
});
