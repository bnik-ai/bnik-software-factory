// Fails on the base (page 2 skips its first item), passes on a real fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const page = createRequire(import.meta.url)('../../../page.js');

test('page 2 of size 10 starts at the 11th item', () => {
  const items = Array.from({ length: 25 }, (_, i) => i + 1);
  assert.equal(page(items, 2, 10)[0], 11);
});
