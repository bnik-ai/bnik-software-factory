import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { runCodingAgent } from '../../../agents/src/runtime/codingAgent.js';
import {
  type CodingOutcome,
  type CommandEvidence,
  MAX_ARCHIVE_BYTES,
  MAX_OUTPUT_BYTES,
  parseJob,
  sha256,
  workerEnvironment,
} from './protocol.js';

// This program is only started by the Docker executor. It never reads host paths.
export async function runCommand(
  command: string,
  args: string[],
  options: {
    env: Record<string, string>;
    signal: AbortSignal;
    cwd?: string;
    input?: Buffer;
    limit?: number;
  },
): Promise<CommandEvidence> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = Buffer.alloc(0);
    let truncated = false;
    const limit = options.limit ?? 16_384;
    const collect = (data: Buffer) => {
      if (output.length + data.length > limit) truncated = true;
      output = Buffer.concat([output, data.subarray(0, Math.max(0, limit - output.length))]);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const kill = () => child.kill('SIGKILL');
    options.signal.addEventListener('abort', kill, { once: true });
    if (options.signal.aborted) kill();
    child.once('error', () => {
      options.signal.removeEventListener('abort', kill);
      reject(new Error('worker_command_spawn_failed'));
    });
    child.once('close', (exitCode, signal) => {
      options.signal.removeEventListener('abort', kill);
      resolve({
        command: [command, ...args].join(' '),
        exitCode,
        signal,
        output: output.toString('utf8'),
        outputTruncated: truncated,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}
async function main() {
  if (process.getuid?.() !== 1000) throw new Error('worker_requires_non_root_uid');
  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    input = Buffer.concat([input, chunk]);
    if (input.length > MAX_ARCHIVE_BYTES * 1.5 + 100_000) throw new Error('worker_input_limit');
  }
  const data = JSON.parse(input.toString('utf8')) as { job: unknown; archive: string };
  const job = parseJob(data.job);
  if (typeof data.archive !== 'string') throw new Error('source_archive_required');
  const archive = Buffer.from(data.archive, 'base64');
  if (archive.length > MAX_ARCHIVE_BYTES || sha256(archive) !== job.archiveSha256)
    throw new Error('source_archive_mismatch');
  const env = workerEnvironment(job.mode === 'live');
  // Do not inherit image/launcher variables into model or test commands.
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
  await mkdir('/tmp/worker-home', { recursive: true, mode: 0o700 });
  const deadline = AbortSignal.timeout(job.timeoutMs);
  const controller = new AbortController();
  const signal = AbortSignal.any([deadline, controller.signal]);
  const exit = () => {
    controller.abort();
    setTimeout(() => process.exit(124), 300).unref();
  };
  process.once('SIGTERM', exit);
  process.once('SIGINT', exit);
  // Supervisor has an independent wall timer that kills the entire namespace.
  signal.addEventListener('abort', () => setTimeout(() => process.exit(124), 500).unref(), {
    once: true,
  });
  const exec = async (
    program: string,
    args: string[],
    cwd?: string,
    stdin?: Buffer,
    limit?: number,
  ) => {
    const result = await runCommand(program, args, { env, signal, cwd, input: stdin, limit });
    if (result.exitCode !== 0 || result.outputTruncated)
      throw new Error('worker_preparation_or_artifact_failed');
    return result.output;
  };
  await exec('python3', ['/app/runtime/worker/extract.py'], undefined, archive);
  const cwd = '/workspace/repo';
  const git = (...args: string[]) =>
    exec(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      cwd,
      undefined,
      MAX_OUTPUT_BYTES / 2,
    );
  await git('init', '--quiet');
  await git('config', 'user.name', 'software-factory-worker');
  await git('config', 'user.email', 'worker@example.invalid');
  await git('add', '-A');
  await git('commit', '--quiet', '--allow-empty', '-m', 'Input snapshot');
  const base = (await git('rev-parse', 'HEAD')).trim();
  let bridge: ReturnType<typeof createServer> | undefined;
  const connections = new Set<Socket>();
  if (job.mode === 'live') {
    bridge = createServer((socket) => {
      const upstream = connect('/run/egress/api.sock');
      connections.add(socket);
      connections.add(upstream);
      socket.on('close', () => connections.delete(socket));
      upstream.on('close', () => connections.delete(upstream));
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    await new Promise<void>((resolve, reject) => {
      bridge?.once('error', reject);
      bridge?.listen(18080, '127.0.0.1', resolve);
    });
  }
  let ok = false;
  let subtype = 'fixture_failed';
  let turns: number | null = null;
  let costUsd: number | null = null;
  let usage: Record<string, number> | null = null;
  let summary = '';
  try {
    if (job.mode === 'demo') {
      const fixture = await runCommand('bash', ['-c', job.fixtureCommand ?? 'exit 1'], {
        env,
        signal,
        cwd,
      });
      ok = fixture.exitCode === 0;
      subtype = ok ? 'fixture_completed' : 'fixture_failed';
      summary = 'Synthetic executor; no model was called.';
    } else {
      const result = await runCodingAgent({
        cwd,
        prompt: job.prompt,
        model: job.model,
        maxTurns: job.maxTurns,
        maxBudgetUsd: job.maxBudgetUsd ?? 5,
        isolation: { environment: env, signal },
      });
      ok = result.ok;
      subtype = result.subtype;
      turns = result.subtype === 'no_result' ? null : result.numTurns;
      costUsd = result.subtype === 'no_result' ? null : result.costUsd;
      usage = result.usage ?? null;
      summary = result.summary.slice(0, 8192);
    }
  } catch (error) {
    subtype = signal.aborted ? 'interrupted' : 'model_execution_failed';
    summary = 'Execution interrupted or provider unavailable; inspect run status.';
  } finally {
    for (const socket of connections) socket.destroy();
    bridge?.close();
  }
  const tests: CommandEvidence[] = [];
  if (ok && !signal.aborted) {
    for (const command of job.tests) {
      tests.push(
        await runCommand('bash', ['-c', command], { env: workerEnvironment(false), signal, cwd }),
      );
      if (signal.aborted) break;
    }
  }
  const testsStatus =
    tests.length === 0
      ? 'not_run'
      : tests.length === job.tests.length && tests.every((t) => t.exitCode === 0 && !t.signal)
        ? 'passed'
        : 'failed';
  await git('add', '-A');
  const patch = await git('diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', base);
  const outcome: CodingOutcome = {
    version: 1,
    ok: ok && testsStatus !== 'failed' && !signal.aborted,
    reason: signal.aborted
      ? 'interrupted'
      : !ok
        ? 'coding_failed'
        : testsStatus === 'failed'
          ? 'tests_failed'
          : 'execution_completed',
    sourceCommit: job.sourceCommit,
    archiveSha256: job.archiveSha256,
    patch,
    patchSha256: sha256(patch),
    testsStatus,
    tests,
    model: { mode: job.mode, subtype, turns, costUsd, usage },
    summary,
  };
  const encoded = JSON.stringify(outcome);
  if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) throw new Error('worker_result_limit');
  process.stdout.write(`${encoded}\n`);
}
main().catch(() => {
  console.error('worker_failed_no_result');
  process.exitCode = 1;
});
