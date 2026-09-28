const assert = require('node:assert/strict');
const { test } = require('node:test');
const { invoice } = require('../index.js');

test('invoice totals lines', () => {
  assert.equal(invoice([{ quantity: 2, price: 3 }]).total, 6);
});
