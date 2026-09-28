import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);

test('the docs team owns docs/', () => {
  const owners = readFileSync(resolve(root, '.github/CODEOWNERS'), 'utf8');
  assert.match(owners, /^\* @maintainers$/m);
  assert.match(owners, /^docs\/ @docs-team$/m);
});
