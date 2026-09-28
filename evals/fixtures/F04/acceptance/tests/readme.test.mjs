import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { HELP } = createRequire(import.meta.url)('../../../cli.js');

test('the README usage block is the CLI help text', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  for (const line of HELP.trim().split('\n')) assert.ok(readme.includes(line), line);
  assert.ok(!readme.includes('--quiet'));
});
test('the help text itself is unchanged', () => {
  assert.match(HELP, /--verbose/);
  assert.match(HELP, /--format text\|json/);
});
