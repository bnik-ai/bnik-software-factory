const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HELP } = require('../cli.js');

test('help names both commands', () => {
  assert.match(HELP, /list/);
  assert.match(HELP, /show ID/);
});
