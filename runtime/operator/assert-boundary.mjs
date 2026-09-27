// Runs in each real service container with synthetic files, never live credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const role = process.argv[2];
const expected = {
  operator: [], probe: [],
  'database-operator': ['database_password'],
  'demo-operator': ['webhook_secret'],
  'github-operator': ['app_private_key', 'database_password', 'webhook_secret'],
  supervisor: ['database_password'],
  'demo-supervisor': ['database_password', 'webhook_secret'],
  'live-supervisor': ['app_private_key', 'database_password', 'model_key', 'webhook_secret'],
}[role];
assert.ok(expected, 'known role');
const actual = fs.existsSync('/state/secrets') ? fs.readdirSync('/state/secrets').sort() : [];
assert.deepEqual(actual, expected, `${role}: only declared secrets are mounted`);
for (const name of actual) assert.ok(fs.readFileSync(`/state/secrets/${name}`).length);
assert.equal(fs.existsSync('/state/.env'), expected.length > 0);
assert.equal(fs.existsSync('/state/merge-policy.json'), ['github-operator', 'live-supervisor'].includes(role));
assert.equal(fs.existsSync('/var/run/docker.sock'), role.includes('supervisor'));
assert.equal(fs.existsSync('/artifacts/input/job.json'), !['probe', 'database-operator', 'demo-operator', 'supervisor'].includes(role));
assert.throws(() => fs.writeFileSync('/app/boundary-probe', 'denied'));
// Both supported cgroup layouts expose the effective Docker limit.
function cgroup(v2, v1) { return fs.readFileSync(fs.existsSync(v2) ? v2 : v1, 'utf8').trim(); }
assert.equal(cgroup('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'), role.includes('supervisor') ? '1073741824' : '536870912');
assert.equal(cgroup('/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max'), role.includes('supervisor') ? '256' : '128');
if (role === 'operator') assert.equal(fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1);
console.log(`${role}: credential, policy, artifact, socket and resource boundaries passed`);
