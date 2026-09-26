import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { databaseConfig, resolveConfig } from '../config.js';
import { createLocalPool } from '../database.js';
import { checkSchema } from '../migrate.js';
import { parseJob, sha256 } from './protocol.js';
import { githubArchive } from './source.js';
import { CodingSupervisor } from './supervisor.js';

async function main() {
  const command = process.argv[2];
  if (!['run', 'cancel', 'recover', 'status'].includes(command ?? ''))
    throw new Error('worker_command_required');
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => controller.abort());
  const pool = createLocalPool(databaseConfig(process.env));
  try {
    await checkSchema(pool);
    if (command === 'status') {
      console.log(
        JSON.stringify(
          (
            await pool.query(
              'SELECT w.delivery_key,r.run_id,r.state,r.reason,r.image_id,r.cancel_requested,r.started_at,r.ended_at FROM factory_worker_runs r JOIN factory_work w ON w.id=r.work_id ORDER BY r.started_at DESC LIMIT 100',
            )
          ).rows,
        ),
      );
      return;
    }
    const config = resolveConfig();
    const supervisor = new CodingSupervisor({
      pool,
      repository: config.repository,
      mode: config.mode,
      image: process.env.FACTORY_WORKER_IMAGE ?? 'software-factory-worker:development',
      modelKey: config.modelKey,
      signal: controller.signal,
    });
    if (command === 'recover') {
      await supervisor.recover();
      console.log(JSON.stringify({ recoveredRepository: config.repository }));
      return;
    }
    const argument = process.argv[3];
    if (!argument) throw new Error('worker_argument_required');
    if (command === 'cancel') {
      console.log(JSON.stringify({ requested: await supervisor.cancel(argument) }));
      return;
    }
    // A deliberate operator-provided request is required for each job. The local
    // webhook runtime never launches a worker or trusts public text as activation.
    const request = JSON.parse(await readFile(argument, 'utf8')) as Record<string, unknown>;
    if (request.repository !== config.repository || request.mode !== config.mode)
      throw new Error('unconfigured_coding_job');
    const output = process.argv[4];
    if (!output || !isAbsolute(output)) throw new Error('new_absolute_artifact_directory_required');
    const archivePath = process.argv[5];
    let archive: Buffer;
    if (config.mode === 'demo') {
      if (!archivePath) throw new Error('demo_source_archive_required');
      archive = await readFile(archivePath);
    } else {
      if (archivePath) throw new Error('live_source_must_come_from_configured_repository');
      if (!config.appId || !config.appPrivateKey) throw new Error('live_identity_required');
      archive = await githubArchive(
        {
          repository: config.repository,
          installationId: config.installationId,
          appId: config.appId,
          appPrivateKey: config.appPrivateKey,
        },
        String(request.sourceCommit),
        controller.signal,
      );
    }
    const digest = sha256(archive);
    if (request.archiveSha256 !== undefined && request.archiveSha256 !== digest)
      throw new Error('source_archive_mismatch');
    const job = parseJob({ ...request, archiveSha256: digest });
    // Refuse overwriting previous evidence before starting any paid operation.
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
        `${JSON.stringify({
          jobId: job.id,
          reason: 'See worker status; no successful completion is claimed.',
        })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      throw new Error('coding_job_failed');
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('worker_command_failed_check_configuration_and_worker_status');
  process.exitCode = 1;
});
