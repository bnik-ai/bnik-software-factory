const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mean } = require('../stats.js');

test('mean', () => {
  assert.equal(mean([1, 2, 3]), 2);
});
