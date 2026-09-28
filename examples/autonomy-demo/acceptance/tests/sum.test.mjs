// Protected acceptance test for the synthetic demo source. It lives outside the
// candidate's control at .factory/acceptance/ and imports the candidate's sum.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sum from '../../../sum.js';

test('sum adds its arguments', () => {
  assert.equal(sum(1, 2), 3);
  assert.equal(sum(-1, 1), 0);
});
