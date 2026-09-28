const assert = require('node:assert/strict');
const { test } = require('node:test');
const tokenize = require('../tokenizer.js');

test('splits words and punctuation', () => {
  assert.deepEqual(tokenize('hi, there'), ['hi', ',', 'there']);
});
