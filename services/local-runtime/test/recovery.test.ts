import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { recoveryRequest } from '../src/recovery.js';
test('recovery parser requires explicit action, work identity, version, UUID and a bounded reason code', () => {
  const args = ['replay', '12', '0', randomUUID(), 'github_available'];
  assert.equal(recoveryRequest(args).version, 0);
  for (const bad of [
    [],
    [...args, 'extra'],
    ['run', ...args.slice(1)],
    ['replay', '0', ...args.slice(2)],
    ['replay', '12', '-1', ...args.slice(3)],
    ['replay', '12', '1.1', ...args.slice(3)],
    ['replay', '12', '0', 'not-a-uuid', 'reason'],
    [...args.slice(0, 4), 'credential goes here'],
  ])
    assert.throws(() => recoveryRequest(bad), /recovery_arguments_invalid/);
});
