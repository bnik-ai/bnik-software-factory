import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);

test('the file moved and the link follows', () => {
  assert.ok(existsSync(resolve(root, 'docs/examples/deploy-config.yml')));
  assert.ok(!existsSync(resolve(root, 'deploy/config.yml')));
  assert.match(readFileSync(resolve(root, 'README.md'), 'utf8'), /docs\/examples\/deploy-config\.yml/);
});
