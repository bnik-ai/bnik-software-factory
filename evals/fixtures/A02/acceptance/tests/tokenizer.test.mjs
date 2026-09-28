import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const tokenize = require('../../../tokenizer.js');

test('splits words and punctuation', () => {
  assert.deepEqual(tokenize('hi, there'), ['hi', ',', 'there']);
  assert.deepEqual(tokenize('a  b'), ['a', 'b']);
  assert.deepEqual(tokenize('end.'), ['end', '.']);
});
