import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
const builder = resolve('scripts/build-candidate.py');
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(dir, 'README.md'), 'Source fixture\n');
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture');
    fn(dir, git, git('rev-parse', 'HEAD'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('source archives reproduce byte-for-byte and ignore untracked credentials and worktree edits', () => fixture((dir, git, commit) => {
  mkdirSync(join(dir, 'runtime')); writeFileSync(join(dir, 'runtime', '.env'), 'untracked-private-canary');
  writeFileSync(join(dir, 'README.md'), 'uncommitted-canary');
  for (const out of ['a', 'b']) execFileSync('python3', [builder, '--commit', commit, '--output', out], { cwd: dir });
  for (const file of readdirSync(join(dir, 'a'))) assert.deepEqual(readFileSync(join(dir, 'a', file)), readFileSync(join(dir, 'b', file)));
  const manifest = JSON.parse(readFileSync(join(dir, 'a', readdirSync(join(dir, 'a')).find(x => x.endsWith('.json')))));
  assert.equal(manifest.commit, commit); assert.deepEqual(manifest.files.map(f => f.path), ['README.md']);
  const body = execFileSync('tar', ['-xOzf', join(dir, 'a', manifest.artifact)], { encoding: 'utf8' });
  assert.equal(body, 'Source fixture\n');
  assert.notEqual(spawnSync('python3', [builder, '--commit', 'HEAD', '--output', 'c'], { cwd: dir }).status, 0);
}));
test('tracked secrets and symbolic links cannot enter a source artifact', () => {
  for (const scenario of ['path', 'key', 'symlink']) fixture((dir, git) => {
    if (scenario === 'path') writeFileSync(join(dir, '.env'), 'not-for-distribution');
    if (scenario === 'key') writeFileSync(join(dir, 'unexpected.txt'), '-----BEGIN ' + 'PRIVATE KEY-----\nsynthetic\n');
    if (scenario === 'symlink') symlinkSync('/etc/passwd', join(dir, 'external'));
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Unsafe fixture');
    assert.notEqual(spawnSync('python3', [builder, '--commit', git('rev-parse', 'HEAD'), '--output', 'out'], { cwd: dir }).status, 0);
  });
});
test('untrusted install lifecycle does not run and contributor checks reject inherited credentials', () => fixture((dir) => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name:'untrusted-fixture',version:'1.0.0',scripts:{postinstall:'node -e "require(\'fs\').writeFileSync(\'executed\',\'bad\')"'}}));
  execFileSync('npm', ['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'], {cwd:dir});
  execFileSync('npm', ['ci','--ignore-scripts','--no-audit','--no-fund'], {cwd:dir});
  assert.ok(!readdirSync(dir).includes('executed'));
  const boundary=resolve('scripts/ci-boundary.mjs');
  const r=spawnSync('node',[boundary],{cwd:dir,env:{...process.env,ANTHROPIC_API_KEY:'synthetic-canary'},encoding:'utf8'});
  assert.notEqual(r.status,0); assert.ok(!r.stderr.includes('synthetic-canary'));
}));
