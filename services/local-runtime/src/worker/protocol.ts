import { createHash } from 'node:crypto';

export interface CodingJob {
  id: string;
  mode: 'demo' | 'live';
  repository: string;
  sourceCommit: string;
  archiveSha256: string;
  prompt: string;
  model?: string;
  maxTurns: number;
  timeoutMs: number;
  tests: string[];
  fixtureCommand?: string;
}
export interface CommandEvidence {
  command: string;
  exitCode: number | null;
  signal: string | null;
  output: string;
  outputTruncated: boolean;
}
export interface CodingOutcome {
  version: 1;
  ok: boolean;
  reason: string;
  sourceCommit: string;
  archiveSha256: string;
  patch: string;
  patchSha256: string;
  testsStatus: 'passed' | 'failed' | 'not_run';
  tests: CommandEvidence[];
  model: { mode: 'demo' | 'live'; subtype: string; turns: number | null; costUsd: number | null };
  summary: string;
}
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_job');
  return value as Record<string, unknown>;
}
export function parseJob(value: unknown): CodingJob {
  const v = object(value);
  const allowed = [
    'id',
    'mode',
    'repository',
    'sourceCommit',
    'archiveSha256',
    'prompt',
    'model',
    'maxTurns',
    'timeoutMs',
    'tests',
    'fixtureCommand',
  ];
  if (Object.keys(v).some((key) => !allowed.includes(key))) throw new Error('unknown_job_field');
  const string = (key: string, pattern: RegExp, max: number) => {
    const val = v[key];
    if (typeof val !== 'string' || val.length > max || !pattern.test(val))
      throw new Error(`invalid_job_${key}`);
    return val;
  };
  const integer = (key: string, min: number, max: number) => {
    const val = v[key];
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < min || val > max)
      throw new Error(`invalid_job_${key}`);
    return val;
  };
  if (v.mode !== 'demo' && v.mode !== 'live') throw new Error('explicit_job_mode_required');
  if (
    !Array.isArray(v.tests) ||
    v.tests.length > 12 ||
    v.tests.some((c) => typeof c !== 'string' || !c.trim() || c.length > 4096)
  )
    throw new Error('invalid_test_commands');
  const job: CodingJob = {
    id: string('id', /^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 128),
    mode: v.mode,
    repository: string(
      'repository',
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/,
      200,
    ),
    sourceCommit: string('sourceCommit', /^[0-9a-f]{40}$/, 40),
    archiveSha256: string('archiveSha256', /^[0-9a-f]{64}$/, 64),
    prompt: string('prompt', /\S/, 65_536),
    maxTurns: integer('maxTurns', 1, 60),
    timeoutMs: integer('timeoutMs', 1000, 1_800_000),
    tests: v.tests as string[],
  };
  if (job.mode === 'live') {
    job.model = string('model', /^claude-[A-Za-z0-9.-]+$/, 100);
    if (v.fixtureCommand !== undefined) throw new Error('live_cannot_use_fixture');
  } else {
    if (v.model !== undefined) throw new Error('demo_cannot_select_live_model');
    job.fixtureCommand = string('fixtureCommand', /\S/, 8192);
  }
  return job;
}
export const workerEnvironment = (live: boolean): Record<string, string> => ({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp/worker-home',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
  ...(live
    ? {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080',
        ANTHROPIC_API_KEY: 'local-proxy-no-credential',
      }
    : {}),
});
