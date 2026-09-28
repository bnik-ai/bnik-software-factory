const assert = require('node:assert/strict');
const { test } = require('node:test');
const { updateProfile } = require('../src/handlers/updateProfile.js');

test('owner updates name', () => {
  const r = updateProfile({ user: { id: 1 } }, { ownerId: 1 }, { name: ' Ada ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.name, 'Ada');
});
