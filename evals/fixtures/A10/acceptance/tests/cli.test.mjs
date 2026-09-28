import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const run = (...args) => execFileSync('node', [resolve(root, 'report.js'), ...args], { cwd: root, encoding: 'utf8' });

test('text output is unchanged', () => {
  assert.equal(run('[{"amount":2},{"amount":3}]'), 'count=2 total=5\n');
});
test('--json prints the same fields as JSON', () => {
  assert.deepEqual(JSON.parse(run('[{"amount":2},{"amount":3}]', '--json')), { count: 2, total: 5 });
});
