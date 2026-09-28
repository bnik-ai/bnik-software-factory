import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);

test('computeTotal replaces calcTotal with the same behaviour', () => {
  const total = require('../../../lib/total.js');
  assert.equal(typeof total.computeTotal, 'function');
  assert.equal(total.calcTotal, undefined);
  assert.equal(total.computeTotal([{ quantity: 2, price: 3 }, { quantity: 1, price: 4 }]), 10);
  assert.equal(require('../../../index.js').invoice([{ quantity: 2, price: 3 }]).total, 6);
});
test('no source file still mentions calcTotal', () => {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    if (['.factory', '.git', 'node_modules'].includes(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
  for (const file of walk(root).filter((f) => f.endsWith('.js')))
    assert.ok(!readFileSync(file, 'utf8').includes('calcTotal'), file);
});
