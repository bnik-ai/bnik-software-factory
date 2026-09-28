const assert = require('node:assert/strict');
const { test } = require('node:test');
const slugify = require('../slugify.js');

test('basic', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});
