const assert = require('node:assert/strict');
const { test } = require('node:test');
const page = require('../page.js');

test('first page', () => {
  assert.deepEqual(page([1, 2, 3, 4], 1, 2), [1, 2]);
});
