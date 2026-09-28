import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);

test('the typo is fixed', () => {
  const intro = readFileSync(resolve(root, 'docs/intro.md'), 'utf8');
  assert.ok(!/recieve/.test(intro));
  assert.ok(/receive/.test(intro));
});
