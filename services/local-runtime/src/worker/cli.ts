import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { databaseConfig, resolveConfig } from '../config.js';
import { createLocalPool } from '../database.js';
import {
  activationCommand,
  approvedJob,
  prepareTask,
  verifyActivation,
} from '../github/activation.js';
import { GitHubFailure, InstallationClient } from '../github/client.js';
import { authorizeApprovedJob, loadActivation } from '../github/intake.js';
import { pairPull } from '../github/merge-gate.js';
import { HumanMergeGate } from '../github/reconcile.js';
import { checkSchema } from '../migrate.js';
import { type CodingJob, parseJob, sha256 } from './protocol.js';
import { RunRecords, runLimits } from './records.js';
import { githubArchive } from './source.js';
import { CodingSupervisor } from './supervisor.js';

async function main() {
  const command = process.argv[2];
  if (
    ![
      'run',
      'run-activation',
      'cancel',
      'recover',
      'status',
      'prune',
      'record-pr',
      'github-check',
      'prepare-task',
      'activations',
      'track-pr',
      'review-scan',
      'review-status',
    ].includes(command ?? '')
  )
    throw new Error('worker_command_required');
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => controller.abort());
  const pool = createLocalPool(databaseConfig(process.env));
  try {
    await checkSchema(pool);
    const identity = (await pool.query('SELECT session_user AS principal')).rows[0]?.principal;
    if (identity !== 'factory_runtime') throw new Error('runtime_database_identity_required');
    const records = new RunRecords(pool);
    if (command === 'status') {
      console.log(JSON.stringify(await records.status(process.argv[3])));
      return;
    }
    if (command === 'prune') {
      console.log(JSON.stringify({ contentRemoved: await records.prune(Number(process.argv[3])) }));
      return;
    }
    if (command === 'cancel') {
      const id = process.argv[3];
      const repository = process.env.FACTORY_REPOSITORY;
      if (!id || !repository) throw new Error('cancellation_identity_required');
      console.log(JSON.stringify({ requested: await records.cancel(id, repository) }));
      return;
    }
    const config = resolveConfig();
    const github = new InstallationClient(config, controller.signal);
    if (command === 'record-pr') {
      const jobId = process.argv[3] ?? '';
      const row = (await records.status(jobId))[0];
      if (!row?.evidence?.task) throw new Error('run_task_link_required');
      const pair = await pairPull(
        config,
        github,
        Number(row.evidence.task.number),
        Number(process.argv[4]),
        process.argv[5] ?? '',
      );
      console.log(JSON.stringify(await records.linkPublication(jobId, config.repository, pair)));
      return;
    }
    if (command === 'track-pr' || command === 'review-scan' || command === 'review-status') {
      const gate = new HumanMergeGate(pool, config, github);
      try {
        if (command === 'track-pr')
          console.log(
            JSON.stringify(
              await gate.track(
                Number(process.argv[3]),
                Number(process.argv[4]),
                process.argv[5] ?? '',
              ),
            ),
          );
        if (command === 'review-scan') {
          await gate.schedule();
          for (let i = 0; i < 100 && (await gate.step()); i++) controller.signal.throwIfAborted();
        }
        console.log(JSON.stringify(await gate.status()));
      } finally {
        await gate.close();
      }
      return;
    }
    if (command === 'github-check') {
      if (config.mode !== 'live') throw new Error('live_configuration_required');
      console.log(JSON.stringify(await github.check()));
      return;
    }
    if (command === 'activations') {
      console.log(
        JSON.stringify(
          (
            await pool.query(
              'SELECT id,issue_number,comment_id,actor_login,source_commit,task_hash,created_at FROM factory_task_activations WHERE repository_id=$1 AND installation_id=$2 ORDER BY created_at DESC LIMIT 100',
              [config.repositoryId, config.installationId],
            )
          ).rows,
        ),
      );
      return;
    }
    if (command === 'prepare-task') {
      if (config.mode !== 'live') throw new Error('live_configuration_required');
      const snapshot = await prepareTask(
        config,
        github,
        Number(process.argv[3]),
        process.argv[4] ?? '',
      );
      const directory = process.argv[5];
      if (!directory || !isAbsolute(directory)) throw new Error('new_absolute_directory_required');
      await mkdir(directory, { mode: 0o700 });
      await writeFile(resolve(directory, 'task.json'), `${JSON.stringify(snapshot, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          reviewFile: resolve(directory, 'task.json'),
          command: activationCommand(snapshot.sourceCommit, snapshot.taskHash),
          instruction:
            'Review the exact Task and commit, then post this command yourself as a configured human operator. No paid work starts automatically.',
        }),
      );
      return;
    }
    const authorize = (job: CodingJob) => authorizeApprovedJob(pool, config, github, job);
    const supervisor = new CodingSupervisor({
      pool,
      repository: config.repository,
      mode: config.mode,
      image: process.env.FACTORY_WORKER_IMAGE ?? 'software-factory-worker:development',
      modelKey: config.modelKey,
      signal: controller.signal,
      authorize,
      limits: runLimits(process.env),
    });
    if (command === 'recover') {
      await supervisor.recover();
      console.log(JSON.stringify({ recoveredRepository: config.repository }));
      return;
    }
    const argument = process.argv[3];
    if (!argument) throw new Error('worker_argument_required');
    const output = process.argv[4];
    if (!output || !isAbsolute(output)) throw new Error('new_absolute_artifact_directory_required');
    let archive: Buffer;
    let job: CodingJob;
    if (command === 'run-activation') {
      if (
        config.mode !== 'live' ||
        config.execution !== 'manual' ||
        !config.appId ||
        !config.appPrivateKey ||
        process.argv[5]
      )
        throw new Error('manual_live_execution_required');
      const proof = await loadActivation(pool, config, argument);
      const fresh = await verifyActivation(config, github, {
        action: 'created',
        sender: proof.comment.user,
        comment: proof.comment,
        issue: proof.issue,
      });
      archive = await githubArchive(
        {
          repository: config.repository,
          installationId: config.installationId,
          appId: config.appId,
          appPrivateKey: config.appPrivateKey,
        },
        fresh.sourceCommit,
        controller.signal,
      );
      job = approvedJob(config, argument, fresh, sha256(archive));
    } else {
      // Live Task execution is bound to a durable, current human activation receipt.
      if (config.mode !== 'demo') throw new Error('live_jobs_require_authorized_activation');
      const request = JSON.parse(await readFile(argument, 'utf8')) as Record<string, unknown>;
      if (request.repository !== config.repository || request.mode !== config.mode)
        throw new Error('unconfigured_coding_job');
      const archivePath = process.argv[5];
      if (!archivePath) throw new Error('demo_source_archive_required');
      archive = await readFile(archivePath);
      const digest = sha256(archive);
      if (request.archiveSha256 !== undefined && request.archiveSha256 !== digest)
        throw new Error('source_archive_mismatch');
      job = parseJob({ ...request, archiveSha256: digest });
    }
    await mkdir(resolve(output), { mode: 0o700 });
    try {
      const workId = await supervisor.submit(job);
      console.log(JSON.stringify({ jobId: job.id, workId, event: 'coding_job_prepared' }));
      const result = await supervisor.run(job.id, archive);
      await writeFile(resolve(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await writeFile(resolve(output, 'changes.patch'), result.outcome.patch, {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          jobId: job.id,
          runId: result.runId,
          ok: result.outcome.ok,
          testsStatus: result.outcome.testsStatus,
          cached: result.cached,
          artifactDirectory: output,
        }),
      );
      if (!result.outcome.ok) process.exitCode = 1;
    } catch {
      await writeFile(
        resolve(output, 'failure.json'),
        `${JSON.stringify({ jobId: job.id, reason: 'See worker status; no successful completion is claimed.' })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      throw new Error('coding_job_failed');
    }
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof GitHubFailure
      ? error.reason
      : 'worker_command_failed_check_configuration_and_worker_status',
  );
  process.exitCode = 1;
});
