const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadConfig = require('../src/config.js');

test('missing path throws', () => {
  assert.throws(() => loadConfig({}));
});
