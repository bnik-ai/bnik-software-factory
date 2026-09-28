import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Docker } from '../worker/docker.js';
import { sha256 } from '../worker/protocol.js';
import type { AcceptanceReceipt, CandidateSubject } from './evidence.js';
import { type AutonomyPolicy, contentTreeDigest } from './policy.js';
import { runSandbox } from './sandbox.js';
import {
  AutonomyError,
  requireAutonomy,
  requireInteger,
  requireRecord,
  requireRepositoryPath,
  requireText,
  requireUniqueList,
} from './schema.js';

/**
 * Protected acceptance bundle: a host directory pinned in the policy. `harness.json`
 * is the harness (how to run); every other file is the suite (what to run). Both are
 * content-addressed with contentTreeDigest and compared before and after each run.
 */
export type HarnessRunner =
  | { kind: 'node-test' }
  | { kind: 'command'; program: string; args: string[] };
export interface Harness {
  version: 1;
  runner: HarnessRunner;
  tests: string[];
  reproducer: string | null;
  timeoutMs: number;
}
export interface BundleFile {
  path: string;
  mode: '100644' | '100755';
  content: Buffer;
}
export interface AcceptanceBundle {
  directory: string;
  harness: Harness;
  files: BundleFile[];
  suiteSha256: string;
  harnessSha256: string;
}
const MAX_BUNDLE_FILES = 500;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

export function parseHarness(value: unknown, bundlePaths: readonly string[]): Harness {
  requireRecord(
    value,
    ['version', 'runner', 'tests', 'reproducer', 'timeoutMs'],
    'harness_invalid',
  );
  const harness = value as unknown as Harness;
  requireAutonomy(harness.version === 1, 'harness_invalid');
  requireRecord(
    harness.runner,
    harness.runner && (harness.runner as { kind: unknown }).kind === 'command'
      ? ['kind', 'program', 'args']
      : ['kind'],
    'harness_runner_invalid',
  );
  if (harness.runner.kind === 'command') {
    requireText(harness.runner.program, 128, 'harness_runner_invalid');
    requireAutonomy(/^[A-Za-z0-9_./-]+$/.test(harness.runner.program), 'harness_runner_invalid');
    requireUniqueList<string>(harness.runner.args, 0, 16, 'harness_runner_invalid');
    for (const argument of harness.runner.args)
      requireAutonomy(
        typeof argument === 'string' && argument.length <= 256,
        'harness_runner_invalid',
      );
  } else requireAutonomy(harness.runner.kind === 'node-test', 'harness_runner_invalid');
  requireUniqueList<string>(harness.tests, 1, 200, 'harness_tests_invalid');
  for (const path of harness.tests) {
    requireRepositoryPath(path, 'harness_tests_invalid');
    requireAutonomy(path !== 'harness.json' && bundlePaths.includes(path), 'harness_test_missing');
  }
  if (harness.reproducer !== null) {
    requireRepositoryPath(harness.reproducer, 'harness_reproducer_invalid');
    requireAutonomy(
      harness.reproducer !== 'harness.json' && bundlePaths.includes(harness.reproducer),
      'harness_reproducer_missing',
    );
  }
  requireInteger(harness.timeoutMs, 1000, 1_800_000, 'harness_timeout_invalid');
  return structuredClone(harness);
}
/** Reads the operator's bundle directory; refuses links, oddities and unbounded size. */
export async function loadAcceptanceBundle(directory: string): Promise<AcceptanceBundle> {
  requireAutonomy(isAbsolute(directory), 'bundle_directory_must_be_absolute');
  const files: BundleFile[] = [];
  let bytes = 0;
  async function walk(relative: string) {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(directory, path));
      if (info.isDirectory()) {
        requireAutonomy(name !== '.git', 'bundle_path_invalid');
        await walk(path);
        continue;
      }
      requireAutonomy(info.isFile(), 'bundle_entry_not_regular_file');
      requireRepositoryPath(path, 'bundle_path_invalid');
      requireAutonomy(files.length < MAX_BUNDLE_FILES, 'bundle_too_many_files');
      bytes += info.size;
      requireAutonomy(bytes <= MAX_BUNDLE_BYTES, 'bundle_too_large');
      files.push({
        path,
        mode: info.mode & 0o111 ? '100755' : '100644',
        content: await readFile(join(directory, path)),
      });
    }
  }
  await walk('');
  const harnessFile = files.find((file) => file.path === 'harness.json');
  requireAutonomy(harnessFile, 'harness_missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(harnessFile.content.toString('utf8'));
  } catch {
    throw new AutonomyError('harness_invalid');
  }
  const harness = parseHarness(
    parsed,
    files.map((file) => file.path),
  );
  const entry = (file: BundleFile) => ({
    path: file.path,
    mode: file.mode,
    sha256: sha256(file.content),
  });
  const suite = files.filter((file) => file.path !== 'harness.json');
  requireAutonomy(suite.length > 0, 'bundle_suite_empty');
  return {
    directory,
    harness,
    files,
    suiteSha256: contentTreeDigest(suite.map(entry)),
    harnessSha256: contentTreeDigest([entry(harnessFile)]),
  };
}

export interface AcceptanceOptions {
  docker?: Docker;
  image: string;
  archive: Buffer;
  patch: string;
  baseTree: string;
  candidateTree: string;
  subject: CandidateSubject;
  bundle: AcceptanceBundle;
  intentKind: 'change' | 'bugfix';
  signal: AbortSignal;
  now?: () => number;
}
interface SandboxReport {
  version: 1;
  ok: true;
  mode: 'candidate' | 'baseline';
  tree: string;
  protectedSuite: { total: number; passed: number; failed: number; skipped: number };
  tests: unknown[];
  reproducer: 'passed' | 'failed' | 'error' | 'not_run';
  sourceModifiedByTests: boolean;
  generatedPaths: string[];
  suiteDigestBefore: string;
  suiteDigestAfter: string;
  harnessDigestBefore: string;
  harnessDigestAfter: string;
  interrupted: boolean;
  elapsedMs: number;
}
export interface AcceptanceRun {
  receipt: AcceptanceReceipt;
  /** Why the status is not `passed`, when known. Diagnostic, not evidence. */
  reason: string | null;
  candidate: SandboxReport | null;
  baseline: SandboxReport | null;
}
/** Every bundle file, harness.json included, byte for byte: the sandbox digests what it writes. */
function bundleInput(bundle: AcceptanceBundle) {
  return {
    files: bundle.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      contentBase64: file.content.toString('base64'),
    })),
  };
}
async function runOnce(
  options: AcceptanceOptions,
  mode: 'candidate' | 'baseline',
): Promise<{ report: SandboxReport | null; imageId: string | null; reason: string | null }> {
  try {
    const { output, imageId } = await runSandbox({
      docker: options.docker,
      image: options.image,
      runId: randomUUID(),
      entry: 'src/autonomy/sandbox/acceptance.ts',
      input: {
        archive: options.archive.toString('base64'),
        patch: options.patch,
        expectedTree: mode === 'candidate' ? options.candidateTree : options.baseTree,
        mode,
        bundle: bundleInput(options.bundle),
      },
      timeoutMs: Math.min(
        1_800_000,
        options.bundle.harness.timeoutMs * (options.bundle.harness.tests.length + 1) + 120_000,
      ),
      signal: options.signal,
      outputLimit: 8 * 1024 * 1024,
    });
    const raw = output as { ok?: unknown; reason?: unknown };
    if (raw.ok !== true)
      return {
        report: null,
        imageId,
        reason:
          typeof raw.reason === 'string' && /^[a-z_]{1,64}$/.test(raw.reason)
            ? raw.reason
            : 'acceptance_failed',
      };
    requireRecord(
      output,
      [
        'version',
        'ok',
        'mode',
        'tree',
        'protectedSuite',
        'tests',
        'reproducer',
        'sourceModifiedByTests',
        'generatedPaths',
        'suiteDigestBefore',
        'suiteDigestAfter',
        'harnessDigestBefore',
        'harnessDigestAfter',
        'interrupted',
        'elapsedMs',
      ],
      'acceptance_output_invalid',
    );
    const report = output as unknown as SandboxReport;
    requireAutonomy(report.mode === mode, 'acceptance_output_invalid');
    requireRecord(
      report.protectedSuite,
      ['total', 'passed', 'failed', 'skipped'],
      'acceptance_output_invalid',
    );
    for (const count of Object.values(report.protectedSuite))
      requireInteger(count, 0, 1_000_000, 'acceptance_output_invalid');
    requireAutonomy(
      ['passed', 'failed', 'error', 'not_run'].includes(report.reproducer) &&
        typeof report.sourceModifiedByTests === 'boolean' &&
        typeof report.interrupted === 'boolean',
      'acceptance_output_invalid',
    );
    return { report, imageId, reason: null };
  } catch (error) {
    return {
      report: null,
      imageId: null,
      reason: error instanceof AutonomyError ? error.reason : 'acceptance_sandbox_failed',
    };
  }
}
/**
 * Produces the acceptance receipt for one candidate. Everything the receipt states
 * comes from the sandbox's exit statuses, structured runner counts and digests; a
 * changed bundle, a mismatched tree or an interrupted run is `error`/`timeout`, never
 * `passed`. Bug fixes additionally run the reproducer against the base tree.
 */
export async function runAcceptance(options: AcceptanceOptions): Promise<AcceptanceRun> {
  const now = options.now ?? Date.now;
  const candidate = await runOnce(options, 'candidate');
  let reason = candidate.reason;
  let status: AcceptanceReceipt['status'] = 'error';
  const report = candidate.report;
  if (report) {
    const trusted =
      report.tree === options.candidateTree &&
      report.suiteDigestBefore === options.bundle.suiteSha256 &&
      report.harnessDigestBefore === options.bundle.harnessSha256;
    const intact =
      report.suiteDigestAfter === report.suiteDigestBefore &&
      report.harnessDigestAfter === report.harnessDigestBefore;
    if (!trusted) reason = 'acceptance_bundle_or_tree_mismatch';
    else if (!intact) reason = 'protected_suite_modified';
    else if (report.interrupted) status = 'timeout';
    else if (report.protectedSuite.total !== options.bundle.harness.tests.length)
      reason = 'acceptance_suite_incomplete';
    else status = report.protectedSuite.failed === 0 ? 'passed' : 'failed';
  } else if (reason === 'sandbox_timed_out') status = 'timeout';
  let baseline: SandboxReport | null = null;
  let baselineResult: AcceptanceReceipt['reproducer']['baseline'] = 'not_run';
  if (
    options.intentKind === 'bugfix' &&
    options.bundle.harness.reproducer !== null &&
    status !== 'error'
  ) {
    const run = await runOnce(options, 'baseline');
    baseline = run.report;
    baselineResult =
      run.report === null || run.report.tree !== options.baseTree
        ? 'error'
        : run.report.reproducer === 'not_run'
          ? 'error'
          : run.report.reproducer;
  }
  const receipt: AcceptanceReceipt = {
    version: 1,
    kind: 'acceptance',
    runId: randomUUID(),
    subject: options.subject,
    suiteSha256: options.bundle.suiteSha256,
    harnessSha256: options.bundle.harnessSha256,
    runnerImage: candidate.imageId ?? 'sha256:unavailable',
    status,
    protectedSuite:
      status === 'passed' || status === 'failed'
        ? (report as SandboxReport).protectedSuite
        : { total: 0, passed: 0, failed: 0, skipped: 0 },
    reproducer: {
      baseline: baselineResult,
      candidate: report && status !== 'error' ? report.reproducer : 'not_run',
    },
    sourceModifiedByTests: report?.sourceModifiedByTests ?? false,
    completedAt: now(),
  };
  return { receipt, reason: status === 'passed' ? null : reason, candidate: report, baseline };
}
