import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const { updateProfile } = require('../../../src/handlers/updateProfile.js');

test('only the owner or an admin may update', () => {
  assert.equal(updateProfile(null, { ownerId: 1 }, { name: 'x' }).status, 403);
  assert.equal(updateProfile({ user: { id: 2 } }, { ownerId: 1 }, { name: 'x' }).status, 403);
  assert.equal(updateProfile({ user: { id: 2, isAdmin: true } }, { ownerId: 1 }, { name: 'x' }).status, 200);
});
test('validation still applies', () => {
  assert.equal(updateProfile({ user: { id: 1 } }, { ownerId: 1 }, { name: '' }).status, 400);
  assert.equal(updateProfile({ user: { id: 1 } }, { ownerId: 1 }, { bio: 5 }).status, 400);
  const r = updateProfile({ user: { id: 1 } }, { ownerId: 1 }, { name: ' Ada ', bio: 'hi' });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.name, 'Ada');
  assert.equal(r.body.touched, true);
});
