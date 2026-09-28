import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAX_ARCHIVE_BYTES, sha256 } from '../../worker/protocol.js';
import { snapshot, sourceChanges } from '../../worker/snapshot.js';
import {
  REPOSITORY,
  exec,
  fail,
  isolateEnvironment,
  prepareRepository,
  readInput,
} from './common.js';

/**
 * Trusted acceptance runner. Rebuilds the candidate (or base) tree, verifies its
 * identity, copies the protected bundle to .factory/acceptance, runs each protected
 * test file in its own process and reports counts from exit status and structured
 * runner events, never from test output. The bundle digest is checked before and
 * after, and the source tree is snapshotted around the run.
 */
export const ACCEPTANCE_DIR = '.factory/acceptance';
interface BundleFile {
  path: string;
  mode: '100644' | '100755';
  contentBase64: string;
}
interface Harness {
  version: 1;
  runner: { kind: 'node-test' } | { kind: 'command'; program: string; args: string[] };
  tests: string[];
  reproducer: string | null;
  timeoutMs: number;
}
interface Input {
  archive: string;
  patch: string;
  expectedTree: string;
  mode: 'candidate' | 'baseline';
  /** All bundle files, harness.json included, exactly as the host loaded them. */
  bundle: { files: BundleFile[] };
}
interface TestResult {
  path: string;
  exitCode: number | null;
  signal: string | null;
  pass: number;
  fail: number;
  skipped: number;
  unfinished: number;
  /** The child reported completion of its root test (per-file summary); see reporter.mjs. */
  completed: boolean;
  outputSha256: string;
  outputTruncated: boolean;
  counted: boolean;
}
/** Same value as the host's contentTreeDigest: sha256 of canonical {entries, version}. */
function bundleDigest(entries: { path: string; mode: string; sha256: string }[]): string {
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        entries: sorted.map((entry) => [entry.path, entry.mode, entry.sha256]),
        version: 1,
      }),
    )
    .digest('hex');
}
async function digestDirectory(root: string, files: string[]): Promise<string> {
  const entries = [];
  for (const path of files) {
    const absolute = join(root, path);
    const info = await stat(absolute);
    entries.push({
      path,
      mode: info.mode & 0o111 ? '100755' : '100644',
      sha256: sha256(await readFile(absolute)),
    });
  }
  return bundleDigest(entries);
}
async function main() {
  if (process.getuid?.() !== 1000) fail('sandbox_requires_non_root_uid');
  const input = await readInput<Input>(MAX_ARCHIVE_BYTES * 4);
  const env = isolateEnvironment();
  const started = Date.now();
  const signal = AbortSignal.timeout(1_800_000);
  const prepared = await prepareRepository(
    Buffer.from(input.archive, 'base64'),
    input.mode === 'candidate' ? input.patch : '',
    env,
    signal,
  );
  if ('reason' in prepared) fail(prepared.reason);
  const tree = input.mode === 'candidate' ? prepared.candidateTree : prepared.baseTree;
  if (tree !== input.expectedTree) fail('tree_mismatch');
  const target = join(REPOSITORY, ACCEPTANCE_DIR);
  try {
    await stat(target);
    fail('acceptance_path_collision');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // The protected bundle lands after the candidate is materialized and outside its control.
  const bundlePaths: string[] = [];
  for (const file of input.bundle.files) {
    if (
      typeof file.path !== 'string' ||
      file.path.split('/').some((segment) => ['', '.', '..', '.git'].includes(segment)) ||
      file.path.includes('\\')
    )
      fail('bundle_path_invalid');
    const absolute = join(target, file.path);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFile(absolute, Buffer.from(file.contentBase64, 'base64'), {
      flag: 'wx',
      mode: file.mode === '100755' ? 0o755 : 0o644,
    });
    bundlePaths.push(file.path);
  }
  if (!bundlePaths.includes('harness.json')) fail('harness_missing');
  const suitePaths = bundlePaths.filter((path) => path !== 'harness.json');
  const suiteDigestBefore = await digestDirectory(target, suitePaths);
  const harnessDigestBefore = await digestDirectory(target, ['harness.json']);
  const before = await snapshot(REPOSITORY);
  for (const key of [...before.keys()])
    if (key.startsWith(`${ACCEPTANCE_DIR}/`)) before.delete(key);

  // Parsed from the bytes just written, so the digested file and the executed harness agree.
  const harness = JSON.parse(await readFile(join(target, 'harness.json'), 'utf8')) as Harness;
  const testEnvironment = { ...env, FACTORY_ACCEPTANCE_DIR: target };
  const results: TestResult[] = [];
  const runOne = async (path: string): Promise<TestResult> => {
    const absolute = join(target, path);
    const perTest = AbortSignal.any([signal, AbortSignal.timeout(harness.timeoutMs)]);
    let pass = 0;
    let failCount = 0;
    let skipped = 0;
    let unfinished = 0;
    let completed = false;
    let counted = false;
    let execution: Awaited<ReturnType<typeof exec>>;
    if (harness.runner.kind === 'node-test') {
      // The summary travels through the runner parent's stdout, which only the reporter writes to:
      // child output reaches the reporter as events, and no file the candidate's processes can
      // reach carries the result.
      execution = await exec(
        'node',
        [
          '--test',
          '--test-reporter=/app/services/local-runtime/src/autonomy/sandbox/reporter.mjs',
          '--test-reporter-destination=stdout',
          absolute,
        ],
        { env: testEnvironment, signal: perTest, cwd: REPOSITORY, limit: 16 * 1024 },
      ).catch(() => ({
        code: null,
        signal: 'SIGKILL',
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }));
      try {
        const lines = execution.stdout.toString('utf8').trim().split('\n');
        const summary = JSON.parse(lines[lines.length - 1] ?? '') as Record<string, unknown>;
        const count = (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
        pass = count(summary.pass);
        failCount = count(summary.fail);
        skipped = count(summary.skipped);
        unfinished = count(summary.unfinished);
        completed = summary.completed === true;
        counted = true;
      } catch {
        counted = false;
      }
    } else {
      execution = await exec(harness.runner.program, [...harness.runner.args, absolute], {
        env: testEnvironment,
        signal: perTest,
        cwd: REPOSITORY,
        limit: 16 * 1024,
      }).catch(() => ({
        code: null,
        signal: 'SIGKILL',
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }));
      // Exit status is the only trusted signal for a generic command runner.
      pass = execution.code === 0 ? 1 : 0;
      failCount = execution.code === 0 ? 0 : 1;
      completed = execution.code !== null;
      counted = true;
    }
    const output = Buffer.concat([execution.stdout, execution.stderr]);
    return {
      path,
      exitCode: execution.code,
      signal: execution.signal,
      pass,
      fail: failCount,
      skipped,
      unfinished,
      completed,
      outputSha256: sha256(output),
      outputTruncated: output.length >= 16 * 1024,
      counted,
    };
  };
  const passedFile = (result: TestResult) =>
    result.counted &&
    result.completed &&
    result.exitCode === 0 &&
    result.signal === null &&
    result.fail === 0 &&
    result.unfinished === 0 &&
    result.pass >= 1;

  let reproducer: 'passed' | 'failed' | 'error' | 'not_run' = 'not_run';
  if (input.mode === 'baseline') {
    if (harness.reproducer === null) fail('reproducer_missing');
    const result = await runOne(harness.reproducer);
    results.push(result);
    reproducer =
      !result.counted || result.exitCode === null
        ? 'error'
        : passedFile(result)
          ? 'passed'
          : 'failed';
  } else {
    for (const path of harness.tests) {
      results.push(await runOne(path));
      if (signal.aborted) break;
    }
    if (harness.reproducer !== null) {
      const result = await runOne(harness.reproducer);
      results.push(result);
      reproducer =
        !result.counted || result.exitCode === null
          ? 'error'
          : passedFile(result)
            ? 'passed'
            : 'failed';
    }
  }
  const after = await snapshot(REPOSITORY);
  for (const key of [...after.keys()]) if (key.startsWith(`${ACCEPTANCE_DIR}/`)) after.delete(key);
  const changes = sourceChanges(before, after);
  const suiteDigestAfter = await digestDirectory(target, suitePaths).catch(() => 'unreadable');
  const harnessDigestAfter = await digestDirectory(target, ['harness.json']).catch(
    () => 'unreadable',
  );
  const suiteResults = results.slice(0, input.mode === 'candidate' ? harness.tests.length : 0);
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      ok: true,
      mode: input.mode,
      tree,
      protectedSuite: {
        total: suiteResults.length,
        passed: suiteResults.filter(passedFile).length,
        failed: suiteResults.filter((result) => !passedFile(result)).length,
        skipped: 0,
      },
      tests: results,
      reproducer,
      sourceModifiedByTests: changes.modifiedPaths.length > 0,
      generatedPaths: changes.generatedPaths.slice(0, 100),
      suiteDigestBefore,
      suiteDigestAfter,
      harnessDigestBefore,
      harnessDigestAfter,
      interrupted: signal.aborted,
      elapsedMs: Date.now() - started,
    })}\n`,
  );
}
main().catch(() => fail('acceptance_failed'));
