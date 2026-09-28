import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const slugify = createRequire(import.meta.url)('../../../slugify.js');

test('behaviour is unchanged', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify(''), '');
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
});
test('the author added edge-case tests without touching slugify.js', () => {
  const tests = readFileSync(resolve(root, 'test/slugify.test.js'), 'utf8');
  assert.match(tests, /slugify\(''\)/);
  assert.match(tests, /Cr\u00e8me|Cr\\u00e8me|unicode/i);
});
