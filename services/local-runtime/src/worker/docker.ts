import { spawn } from 'node:child_process';
import type { CodingJob, CodingOutcome } from './protocol.js';
import { MAX_ARCHIVE_BYTES, MAX_OUTPUT_BYTES, parseJob, sha256 } from './protocol.js';

export interface DockerReply {
  code: number;
  stdout: string;
  stderr: string;
}
export class WorkerFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export function dockerEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      'PATH',
      'HOME',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
      'DOCKER_TLS_VERIFY',
      'DOCKER_CERT_PATH',
    ].flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
  );
}
export class Docker {
  async command(
    args: string[],
    options: {
      input?: string | Buffer;
      limit?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<DockerReply> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, {
        env: dockerEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let failed = false;
      const fail = () => {
        failed = true;
        child.kill('SIGKILL');
      };
      const timeout = setTimeout(fail, options.timeoutMs ?? 20_000);
      options.signal?.addEventListener('abort', fail, { once: true });
      if (options.signal?.aborted) fail();
      const collect = (which: 'stdout' | 'stderr', data: Buffer) => {
        const current = which === 'stdout' ? stdout : stderr;
        if (current.length + data.length > (options.limit ?? MAX_OUTPUT_BYTES)) {
          fail();
          return;
        }
        if (which === 'stdout') stdout = Buffer.concat([current, data]);
        else stderr = Buffer.concat([current, data]);
      };
      child.stdout.on('data', (data: Buffer) => collect('stdout', data));
      child.stderr.on('data', (data: Buffer) => collect('stderr', data));
      child.stdin.on('error', () => {});
      child.once('error', () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', fail);
        reject(new WorkerFailure('docker_unavailable'));
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', fail);
        if (failed) reject(new WorkerFailure('docker_command_bound_exceeded'));
        else
          resolve({
            code: code ?? 1,
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
          });
      });
      child.stdin.end(options.input);
    });
  }
  async checked(args: string[], options?: Parameters<Docker['command']>[1]): Promise<string> {
    const result = await this.command(args, options);
    if (result.code !== 0) throw new WorkerFailure('docker_operation_failed');
    return result.stdout.trim();
  }
}
export function runPrefix(runId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId))
    throw new Error('invalid_worker_run_id');
  return `factory-job-${runId}`;
}
const label = 'io.software-factory.worker-run';
export function workerArgs(name: string, image: string, volume?: string): string[] {
  return [
    'create',
    '--name',
    name,
    '--label',
    `${label}=${name.replace(/-worker$/, '')}`,
    '--init',
    '--interactive',
    '--user',
    '1000:1000',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--network',
    'none',
    '--ipc',
    'private',
    '--memory',
    '2g',
    '--memory-swap',
    '2g',
    '--cpus',
    '2',
    '--pids-limit',
    '128',
    '--ulimit',
    'nofile=1024:1024',
    '--ulimit',
    'fsize=67108864:67108864',
    '--log-driver',
    'none',
    '--tmpfs',
    '/workspace:rw,exec,nosuid,nodev,size=536870912,uid=1000,gid=1000,mode=700',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,size=134217728,uid=1000,gid=1000,mode=700',
    ...(volume ? ['--mount', `type=volume,src=${volume},dst=/run/egress,readonly`] : []),
    image,
    'node',
    '--import',
    'tsx',
    'src/worker/entry.ts',
  ];
}
export async function cleanupRun(docker: Docker, runId: string): Promise<void> {
  const prefix = runPrefix(runId);
  // Names are derived only from a database-generated UUID, never issue/model text.
  const ids = await docker.checked(['ps', '-aq', '--filter', `label=${label}=${prefix}`]);
  for (const id of ids.split('\n').filter(Boolean)) {
    if (!/^[0-9a-f]{12,64}$/.test(id)) throw new WorkerFailure('invalid_container_identity');
    await docker.checked(['rm', '-f', id]);
  }
  const volumes = await docker.checked([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=${label}=${prefix}`,
  ]);
  for (const volume of volumes.split('\n').filter(Boolean)) {
    if (volume !== `${prefix}-egress`) throw new WorkerFailure('invalid_volume_identity');
    await docker.checked(['volume', 'rm', volume]);
  }
  if (
    (await docker.checked(['ps', '-aq', '--filter', `label=${label}=${prefix}`])) ||
    (await docker.checked(['volume', 'ls', '-q', '--filter', `label=${label}=${prefix}`]))
  )
    throw new WorkerFailure('worker_cleanup_incomplete');
}
export interface ExecuteOptions {
  job: CodingJob;
  archive: Buffer;
  runId: string;
  image: string;
  signal: AbortSignal;
  modelKey?: string;
  docker?: Docker;
  onStarted?: (imageId: string) => Promise<void>;
}
export async function executeIsolated(
  options: ExecuteOptions,
): Promise<{ outcome: CodingOutcome; imageId: string }> {
  const job = parseJob(options.job);
  if (options.archive.length > MAX_ARCHIVE_BYTES || sha256(options.archive) !== job.archiveSha256)
    throw new WorkerFailure('archive_mismatch');
  if (job.mode === 'live' ? !options.modelKey : options.modelKey !== undefined)
    throw new WorkerFailure('worker_credential_mode_mismatch');
  const docker = options.docker ?? new Docker();
  const prefix = runPrefix(options.runId);
  let cleanupError = false;
  let completed: { outcome: CodingOutcome; imageId: string } | undefined;
  let failure: unknown;
  let proxyProcess: Promise<DockerReply> | undefined;
  const proxyAttach = new AbortController();
  let cancelled = false;
  let stopProcess: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    cancelled = true;
    stopProcess ??= docker
      .command(['rm', '-f', `${prefix}-worker`, `${prefix}-proxy`])
      .then(() => undefined)
      .catch(() => undefined);
  };
  options.signal.throwIfAborted();
  options.signal.addEventListener('abort', stop, { once: true });
  try {
    const imageId = await docker.checked([
      'image',
      'inspect',
      options.image,
      '--format',
      '{{.Id}}',
    ]);
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new WorkerFailure('invalid_worker_image');
    const volume = job.mode === 'live' ? `${prefix}-egress` : undefined;
    if (volume) {
      await docker.checked(['volume', 'create', '--label', `${label}=${prefix}`, volume]);
      await docker.checked([
        'create',
        '--name',
        `${prefix}-proxy`,
        '--label',
        `${label}=${prefix}`,
        '--init',
        '--interactive',
        '--user',
        '1000:1000',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--network',
        'bridge',
        '--memory',
        '256m',
        '--memory-swap',
        '256m',
        '--cpus',
        '1',
        '--pids-limit',
        '64',
        '--log-driver',
        'none',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=16777216,uid=1000,gid=1000',
        '--mount',
        `type=volume,src=${volume},dst=/run/egress`,
        imageId,
        'node',
        '--import',
        'tsx',
        'src/worker/proxy.ts',
      ]);
      proxyProcess = docker
        .command(['start', '-a', '-i', `${prefix}-proxy`], {
          input: JSON.stringify({
            apiKey: options.modelKey,
            model: job.model,
            maxRequests: job.maxTurns + 4,
            timeoutMs: job.timeoutMs + 30_000,
          }),
          timeoutMs: job.timeoutMs + 60_000,
          signal: proxyAttach.signal,
        })
        .catch(() => ({ code: 1, stdout: '', stderr: '' }));
      let ready = false;
      for (let n = 0; n < 50 && !options.signal.aborted; n++) {
        const result = await docker.command([
          'exec',
          `${prefix}-proxy`,
          'test',
          '-S',
          '/run/egress/api.sock',
        ]);
        if (result.code === 0) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new WorkerFailure('worker_proxy_not_ready');
    }
    options.signal.throwIfAborted();
    if (cancelled) throw new WorkerFailure('worker_cancelled');
    await docker.checked(workerArgs(`${prefix}-worker`, imageId, volume));
    await options.onStarted?.(imageId);
    options.signal.throwIfAborted();
    timeout = setTimeout(stop, job.timeoutMs);
    const reply = await docker.command(['start', '-a', '-i', `${prefix}-worker`], {
      input: JSON.stringify({ job, archive: options.archive.toString('base64') }),
      timeoutMs: job.timeoutMs + 25_000,
    });
    if (options.signal.aborted) throw new WorkerFailure('worker_cancelled');
    if (cancelled) throw new WorkerFailure('worker_timed_out');
    if (reply.code !== 0) {
      const state = JSON.parse(
        await docker.checked(['inspect', `${prefix}-worker`, '--format', '{{json .State}}']),
      ) as { OOMKilled?: boolean };
      throw new WorkerFailure(state.OOMKilled ? 'worker_out_of_memory' : 'worker_process_failed');
    }
    const outcome = JSON.parse(reply.stdout) as CodingOutcome;
    if (
      outcome.version !== 1 ||
      typeof outcome.ok !== 'boolean' ||
      typeof outcome.patch !== 'string' ||
      outcome.sourceCommit !== job.sourceCommit ||
      outcome.archiveSha256 !== job.archiveSha256 ||
      outcome.patchSha256 !== sha256(outcome.patch) ||
      !Array.isArray(outcome.tests) ||
      !['passed', 'failed', 'not_run'].includes(outcome.testsStatus)
    )
      throw new WorkerFailure('invalid_worker_result');
    if (
      job.mode === 'live' &&
      options.modelKey &&
      JSON.stringify(outcome).includes(options.modelKey)
    )
      throw new WorkerFailure('credential_in_worker_result');
    completed = { outcome, imageId };
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', stop);
    // Await the bounded stop command before enumerating/removing the same resources.
    await stopProcess;
    try {
      await cleanupRun(docker, options.runId);
    } catch {
      cleanupError = true;
    }
    proxyAttach.abort();
    await proxyProcess;
  }
  if (cleanupError) throw new WorkerFailure('worker_cleanup_failed');
  if (failure) throw failure;
  if (!completed) throw new WorkerFailure('worker_missing_result');
  return completed;
}
