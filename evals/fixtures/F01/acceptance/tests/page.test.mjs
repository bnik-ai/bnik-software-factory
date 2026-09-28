import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const page = createRequire(import.meta.url)('../../../page.js');

test('pages partition the items in order', () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(page(items, 1, 3), [1, 2, 3]);
  assert.deepEqual(page(items, 2, 3), [4, 5, 6]);
  assert.deepEqual(page(items, 3, 3), [7]);
  assert.deepEqual(page(items, 4, 3), []);
});
