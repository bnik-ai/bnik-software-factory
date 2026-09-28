const assert = require('node:assert/strict');
const { test } = require('node:test');
const render = require('../lib/feed.js');

test('renders text', () => {
  assert.match(render([{ text: 'hi', at: new Date(0) }], new Date(0))[0], /^hi/);
});
