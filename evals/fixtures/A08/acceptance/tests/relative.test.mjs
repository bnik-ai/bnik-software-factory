import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const render = require('../../../lib/feed.js');

test('relative times in the activity feed', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const at = (ms) => new Date(now.getTime() - ms);
  assert.match(render([{ text: 'a', at: at(3 * 86_400_000) }], now)[0], /3 days ago/);
  assert.match(render([{ text: 'b', at: at(3_600_000) }], now)[0], /1 hour ago/);
  assert.match(render([{ text: 'c', at: at(10_000) }], now)[0], /just now/);
});
