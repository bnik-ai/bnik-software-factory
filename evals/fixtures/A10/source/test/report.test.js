const assert = require('node:assert/strict');
const { test } = require('node:test');
const report = require('../lib/report.js');

test('totals amounts', () => {
  assert.deepEqual(report([{ amount: 2 }, { amount: 3 }]), { count: 2, total: 5 });
});
