import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ARCHIVE_BYTES, workerEnvironment } from '../../worker/protocol.js';

/**
 * Shared by the sandbox entry modules. These programs run only inside a
 * disposable container started by runSandbox; they never read host paths, and
 * they import nothing outside this directory except the worker protocol constants.
 */
export const REPOSITORY = '/workspace/repo';
export const GIT_MODES = ['100644', '100755', '120000', '160000'] as const;
export interface Execution {
  code: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
}
export function fail(reason: string): never {
  process.stdout.write(`${JSON.stringify({ version: 1, ok: false, reason })}\n`);
  process.exit(0);
}
export async function readInput<T>(limitBytes: number): Promise<T> {
  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    input = Buffer.concat([input, chunk]);
    if (input.length > limitBytes) fail('sandbox_input_limit');
  }
  try {
    return JSON.parse(input.toString('utf8')) as T;
  } catch {
    return fail('sandbox_input_invalid');
  }
}
/** Drop every inherited variable; the sandbox tools see only the worker environment. */
export function isolateEnvironment(): Record<string, string> {
  const environment = workerEnvironment(false);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, environment);
  return environment;
}
export async function exec(
  program: string,
  args: string[],
  options: {
    env: Record<string, string>;
    signal: AbortSignal;
    cwd?: string;
    input?: Buffer;
    limit?: number;
  },
): Promise<Execution> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const limit = options.limit ?? 16 * 1024 * 1024;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exceeded = false;
    const collect = (which: 'stdout' | 'stderr') => (data: Buffer) => {
      const current = which === 'stdout' ? stdout : stderr;
      if (current.length + data.length > limit) {
        exceeded = true;
        child.kill('SIGKILL');
        return;
      }
      if (which === 'stdout') stdout = Buffer.concat([current, data]);
      else stderr = Buffer.concat([current, data]);
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const kill = () => child.kill('SIGKILL');
    options.signal.addEventListener('abort', kill, { once: true });
    if (options.signal.aborted) kill();
    child.once('error', () => {
      options.signal.removeEventListener('abort', kill);
      reject(new Error('sandbox_command_spawn_failed'));
    });
    child.once('close', (code, signal) => {
      options.signal.removeEventListener('abort', kill);
      if (exceeded) reject(new Error('sandbox_command_output_limit'));
      else resolve({ code, signal, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}
export async function checked(
  program: string,
  args: string[],
  options: Parameters<typeof exec>[2],
): Promise<Buffer> {
  const result = await exec(program, args, options);
  if (result.code !== 0) throw new Error(`${program}_failed`);
  return result.stdout;
}
export function git(env: Record<string, string>, signal: AbortSignal) {
  return (args: string[], input?: Buffer, limit?: number) =>
    checked('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      env,
      signal,
      cwd: REPOSITORY,
      input,
      limit,
    });
}
export interface PreparedRepository {
  base: string;
  baseTree: string;
  candidateTree: string;
}
/**
 * Extracts the base archive exactly as the worker does, commits it, applies the
 * worker patch to the index and returns the Git tree identities. Same input,
 * same trees: the collector, acceptance runner and publisher all agree.
 */
export async function prepareRepository(
  archive: Buffer,
  patch: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<PreparedRepository | { reason: string }> {
  if (archive.length > MAX_ARCHIVE_BYTES) return { reason: 'archive_too_large' };
  await mkdir('/tmp/worker-home', { recursive: true, mode: 0o700 });
  await checked('python3', ['/app/runtime/worker/extract.py'], { env, signal, input: archive });
  const run = git(env, signal);
  await run(['init', '--quiet']);
  // GitHub's tree holds every tracked file byte for byte: no ignore rules, no attribute filters.
  await writeFile(join(REPOSITORY, '.git/info/attributes'), '* -text -eol -filter -ident\n');
  await run(['config', 'user.name', 'software-factory-sandbox']);
  await run(['config', 'user.email', 'sandbox@example.invalid']);
  await run(['add', '-A', '--force']);
  await run(['commit', '--quiet', '--allow-empty', '-m', 'Input snapshot']);
  const base = (await run(['rev-parse', 'HEAD'])).toString('utf8').trim();
  const baseTree = (await run(['rev-parse', 'HEAD^{tree}'])).toString('utf8').trim();
  if (patch.length > 0) {
    const applied = await exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'apply',
        '--index',
        '--binary',
        '--whitespace=nowarn',
        '-',
      ],
      { env, signal, cwd: REPOSITORY, input: Buffer.from(patch, 'utf8') },
    );
    if (applied.code !== 0) return { reason: 'patch_apply_failed' };
  }
  const candidateTree = (await run(['write-tree'])).toString('utf8').trim();
  return { base, baseTree, candidateTree };
}
export function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
