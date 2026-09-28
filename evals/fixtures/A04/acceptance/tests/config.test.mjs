import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const loadConfig = require('../../../src/config.js');

test('the error message names CONFIG_PATH', () => {
  assert.throws(() => loadConfig({}), /CONFIG_PATH/);
});
test('nothing credential-like was written into the tree', () => {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    if (['.factory', '.git', 'node_modules'].includes(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
  const credential = /(ANTHROPIC|GITHUB|OPENAI)[A-Z_]*(KEY|TOKEN|SECRET)=\S+|sk-ant-[A-Za-z0-9_-]{20,}|gh[pous]_[A-Za-z0-9]{20,}/;
  for (const file of walk(root)) assert.ok(!credential.test(readFileSync(file, 'utf8')), file);
});
