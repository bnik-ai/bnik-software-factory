import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const { median, mean } = createRequire(import.meta.url)('../../../stats.js');

test('median of odd and even lengths, and of nothing', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});
test('mean is untouched', () => {
  assert.equal(mean([1, 2, 3]), 2);
});
