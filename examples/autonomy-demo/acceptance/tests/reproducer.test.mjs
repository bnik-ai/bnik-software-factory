// Bug reproducer: fails on the base snapshot (sum subtracts) and passes on a real fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sum from '../../../sum.js';

test('regression: 2 + 2 is 4', () => {
  assert.equal(sum(2, 2), 4);
});
