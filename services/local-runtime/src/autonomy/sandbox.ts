import { Docker, WorkerFailure } from '../worker/docker.js';
import { MAX_OUTPUT_BYTES } from '../worker/protocol.js';
import { AutonomyError } from './schema.js';

/**
 * Disposable trusted-side containers for collection, acceptance, review and
 * dependency resolution. Same hardening as the coding worker (non-root, read-only
 * image, tmpfs workspace, no capabilities, no network unless an egress volume is
 * given), a distinct label so worker and autonomy cleanup never touch each other.
 */
export const SANDBOX_LABEL = 'io.software-factory.autonomy-run';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTRY = /^src\/autonomy\/sandbox\/[a-z][a-z0-9-]*\.ts$/;
export function sandboxPrefix(runId: string): string {
  if (!UUID.test(runId)) throw new AutonomyError('invalid_sandbox_run_id');
  return `factory-autonomy-${runId}`;
}
export interface SandboxOptions {
  docker?: Docker;
  image: string;
  runId: string;
  /** Entry module inside the image, under src/autonomy/sandbox/. */
  entry: string;
  input: unknown;
  timeoutMs: number;
  signal: AbortSignal;
  /** Bytes of stdout accepted from the container. */
  outputLimit?: number;
  /** Named volume holding a proxy socket at /run/egress; the container itself stays off-network. */
  egressVolume?: string;
  /** `registry`: the Docker bridge for the resolution sandbox; that sandbox refuses non-registry sources before it fetches. */
  network?: 'none' | 'registry';
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  onStarted?: (imageId: string) => Promise<void>;
}
export interface SandboxResult {
  output: unknown;
  imageId: string;
  /** Wall time of the container process. */
  elapsedMs: number;
}
export function sandboxArgs(
  name: string,
  prefix: string,
  image: string,
  entry: string,
  options: Pick<SandboxOptions, 'egressVolume' | 'memory' | 'cpus' | 'pidsLimit' | 'network'>,
): string[] {
  if (!ENTRY.test(entry)) throw new AutonomyError('invalid_sandbox_entry');
  return [
    'create',
    '--name',
    name,
    '--label',
    `${SANDBOX_LABEL}=${prefix}`,
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
    options.network === 'registry' ? 'bridge' : 'none',
    '--ipc',
    'private',
    '--memory',
    options.memory ?? '2g',
    '--memory-swap',
    options.memory ?? '2g',
    '--cpus',
    options.cpus ?? '2',
    '--pids-limit',
    String(options.pidsLimit ?? 256),
    '--ulimit',
    'nofile=1024:1024',
    '--ulimit',
    'fsize=67108864:67108864',
    '--log-driver',
    'none',
    '--tmpfs',
    '/workspace:rw,exec,nosuid,nodev,size=1073741824,uid=1000,gid=1000,mode=700',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,size=268435456,uid=1000,gid=1000,mode=700',
    ...(options.egressVolume
      ? ['--mount', `type=volume,src=${options.egressVolume},dst=/run/egress,readonly`]
      : []),
    image,
    'node',
    '--import',
    'tsx',
    entry,
  ];
}
export async function cleanupSandbox(docker: Docker, runId: string): Promise<void> {
  const prefix = sandboxPrefix(runId);
  const ids = await docker.checked(['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}=${prefix}`]);
  for (const id of ids.split('\n').filter(Boolean)) {
    if (!/^[0-9a-f]{12,64}$/.test(id)) throw new AutonomyError('invalid_container_identity');
    await docker.checked(['rm', '-f', id]);
  }
  const volumes = await docker.checked([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=${SANDBOX_LABEL}=${prefix}`,
  ]);
  for (const volume of volumes.split('\n').filter(Boolean)) {
    if (!volume.startsWith(prefix)) throw new AutonomyError('invalid_volume_identity');
    await docker.checked(['volume', 'rm', volume]);
  }
  if (
    (await docker.checked(['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}=${prefix}`])) ||
    (await docker.checked(['volume', 'ls', '-q', '--filter', `label=${SANDBOX_LABEL}=${prefix}`]))
  )
    throw new AutonomyError('sandbox_cleanup_incomplete');
}
/**
 * Runs one entry module to completion and returns its final stdout line as JSON.
 * Resources are removed before returning; a cleanup failure is reported even when
 * the run itself succeeded, so an orphan is never silent.
 */
export async function runSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const docker = options.docker ?? new Docker();
  const prefix = sandboxPrefix(options.runId);
  const name = `${prefix}-sandbox`;
  let result: SandboxResult | undefined;
  let failure: unknown;
  let cleanupFailed = false;
  let cancelled = false;
  let stopProcess: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    cancelled = true;
    stopProcess ??= docker
      .command(['rm', '-f', name])
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
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new AutonomyError('invalid_sandbox_image');
    await docker.checked(sandboxArgs(name, prefix, imageId, options.entry, options));
    await options.onStarted?.(imageId);
    options.signal.throwIfAborted();
    if (cancelled) throw new AutonomyError('sandbox_cancelled');
    timer = setTimeout(stop, options.timeoutMs);
    const started = Date.now();
    const reply = await docker.command(['start', '-a', '-i', name], {
      input: JSON.stringify(options.input),
      timeoutMs: options.timeoutMs + 25_000,
      limit: options.outputLimit ?? MAX_OUTPUT_BYTES,
    });
    const elapsedMs = Date.now() - started;
    if (options.signal.aborted) throw new AutonomyError('sandbox_cancelled');
    if (cancelled) throw new AutonomyError('sandbox_timed_out');
    if (reply.code !== 0) {
      const state = JSON.parse(
        await docker.checked(['inspect', name, '--format', '{{json .State}}']),
      ) as { OOMKilled?: boolean };
      throw new AutonomyError(state.OOMKilled ? 'sandbox_out_of_memory' : 'sandbox_process_failed');
    }
    const lines = reply.stdout.trimEnd().split('\n');
    let output: unknown;
    try {
      output = JSON.parse(lines[lines.length - 1] ?? '');
    } catch {
      throw new AutonomyError('sandbox_output_invalid');
    }
    result = { output, imageId, elapsedMs };
  } catch (error) {
    failure =
      error instanceof WorkerFailure
        ? new AutonomyError(
            error.reason === 'docker_command_bound_exceeded'
              ? 'sandbox_output_bound_exceeded'
              : error.reason,
          )
        : error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', stop);
    await stopProcess;
    try {
      await cleanupSandbox(docker, options.runId);
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) throw new AutonomyError('sandbox_cleanup_failed');
  if (failure) throw failure;
  if (!result) throw new AutonomyError('sandbox_missing_result');
  return result;
}

export interface ProxyOptions {
  docker?: Docker;
  image: string;
  runId: string;
  apiKey: string;
  model: string;
  maxRequests: number;
  timeoutMs: number;
  signal: AbortSignal;
}
/**
 * Starts the fixed-origin provider proxy beside a sandbox: the proxy holds the key
 * and network; the sandbox reaches it only through the egress volume socket. Both are
 * labelled with the run prefix, so cleanupSandbox removes them together.
 */
export async function withProxy<T>(
  options: ProxyOptions,
  work: (egressVolume: string) => Promise<T>,
): Promise<T> {
  const docker = options.docker ?? new Docker();
  const prefix = sandboxPrefix(options.runId);
  const volume = `${prefix}-egress`;
  const proxy = `${prefix}-proxy`;
  const attach = new AbortController();
  let proxyProcess: Promise<unknown> | undefined;
  try {
    const imageId = await docker.checked([
      'image',
      'inspect',
      options.image,
      '--format',
      '{{.Id}}',
    ]);
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new AutonomyError('invalid_sandbox_image');
    await docker.checked(['volume', 'create', '--label', `${SANDBOX_LABEL}=${prefix}`, volume]);
    await docker.checked([
      'create',
      '--name',
      proxy,
      '--label',
      `${SANDBOX_LABEL}=${prefix}`,
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
      .command(['start', '-a', '-i', proxy], {
        input: JSON.stringify({
          apiKey: options.apiKey,
          model: options.model,
          maxRequests: options.maxRequests,
          timeoutMs: options.timeoutMs,
        }),
        timeoutMs: options.timeoutMs + 30_000,
        signal: attach.signal,
      })
      .catch(() => undefined);
    let ready = false;
    for (let attempt = 0; attempt < 50 && !options.signal.aborted; attempt++) {
      const probe = await docker.command(['exec', proxy, 'test', '-S', '/run/egress/api.sock']);
      if (probe.code === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new AutonomyError('sandbox_proxy_not_ready');
    return await work(volume);
  } finally {
    await docker.command(['rm', '-f', proxy]).catch(() => undefined);
    attach.abort();
    await proxyProcess;
    await cleanupSandbox(docker, options.runId).catch(() => undefined);
  }
}

/**
 * Recovery after a crashed controller: removes every autonomy sandbox and proxy
 * left behind, whatever run they belonged to. Only the recovery command calls this,
 * while it holds the repository lock row exclusively (quiesceController), so no live
 * controller command can have a sandbox running.
 */
export async function sweepSandboxes(
  docker: Docker,
): Promise<{ containers: number; volumes: number }> {
  const ids = (await docker.checked(['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}`]))
    .split('\n')
    .filter(Boolean);
  for (const id of ids) {
    if (!/^[0-9a-f]{12,64}$/.test(id)) throw new AutonomyError('invalid_container_identity');
    await docker.checked(['rm', '-f', id]);
  }
  const volumes = (
    await docker.checked(['volume', 'ls', '-q', '--filter', `label=${SANDBOX_LABEL}`])
  )
    .split('\n')
    .filter(Boolean);
  for (const volume of volumes) {
    if (!volume.startsWith('factory-autonomy-')) throw new AutonomyError('invalid_volume_identity');
    await docker.checked(['volume', 'rm', volume]);
  }
  return { containers: ids.length, volumes: volumes.length };
}
