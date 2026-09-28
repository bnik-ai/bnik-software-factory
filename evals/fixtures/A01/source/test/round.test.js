const assert = require('node:assert/strict');
const { test } = require('node:test');
const roundCents = require('../round.js');

test('half up', () => {
  assert.equal(roundCents(1.005), 1.01);
  assert.equal(roundCents(2.675), 2.68);
});
