import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
const helper = resolve('examples/invoice/prepare-result.py');
const sha = text => createHash('sha256').update(text).digest('hex');
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-pilot-'));
  const source = join(dir, 'source'); mkdirSync(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    for (const file of ['invoice.mjs', 'invoice.test.mjs']) writeFileSync(join(source, file), readFileSync(resolve('examples/invoice', file)));
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Baseline');
    const commit = git('rev-parse', 'HEAD').trim();
    const receipt = (patch, overrides = {}) => {
      const body = { workId: 'synthetic-work', runId: 'synthetic-run', outcome: { ok: true, sourceCommit: commit, patch, patchSha256: sha(patch), testsStatus: 'passed', tests: [{exitCode: 0, signal: null}], model: {mode: 'live', costUsd: null}, ...overrides } };
      const path = join(dir, 'result.json'); writeFileSync(path, JSON.stringify(body)); return path;
    };
    const run = (path, output = join(dir, 'prepared')) => spawnSync('python3', [helper, '--repository', source, '--receipt', path, '--output', output], {encoding: 'utf8'});
    fn({dir, source, git, commit, receipt, run});
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
test('review preparation binds a complete two-file result to the source and receipt without running code', () => fixture(({dir, source, git, commit, receipt, run}) => {
  const content = 'throw new Error("Must not execute on host");\n';
  writeFileSync(join(source, 'invoice.mjs'), content);
  const patch = git('diff');
  const path = receipt(patch); const result = run(path);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(join(dir, 'prepared/publication-plan.json')));
  assert.equal(plan.source_commit, commit); assert.equal(plan.receipt_sha256, sha(readFileSync(path)));
  assert.equal(readFileSync(join(dir, 'prepared/invoice.mjs'), 'utf8'), content);
  assert.equal(plan.files['invoice.mjs'], sha(content));
  assert.notEqual(run(path).status, 0, 'must not overwrite operator output');
}));
test('review preparation rejects changed digest, failed tests, demo receipts and governance changes', () => fixture(({source, git, receipt, run}) => {
  writeFileSync(join(source, 'invoice.mjs'), 'export const subtotal = () => 0;\n');
  const patch = git('diff');
  for (const overrides of [{patchSha256: '0'.repeat(64)}, {testsStatus: 'failed'}, {model: {mode: 'demo'}}, {tests: [{exitCode: 1, signal: null}]}]) {
    assert.notEqual(run(receipt(patch, overrides)).status, 0);
  }
  mkdirSync(join(source, '.github')); writeFileSync(join(source, '.github/CODEOWNERS'), '* @attacker\n');
  git('add', '.'); assert.notEqual(run(receipt(git('diff', '--cached'))).status, 0);
}));
test('review preparation rejects a sample source replaced by a symlink', () => fixture(({source, git, receipt, run}) => {
  rmSync(join(source, 'invoice.mjs')); symlinkSync('/etc/passwd', join(source, 'invoice.mjs'));
  assert.notEqual(run(receipt(git('diff'))).status, 0);
}));
