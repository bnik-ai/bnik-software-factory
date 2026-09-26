// Fail closed if an ordinary test job receives operator credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_CLIENT_SECRET',
  'AZURE_CREDENTIALS', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_TOKEN', 'GH_TOKEN',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
  assert.ok(!process.env[key], `Ordinary CI must not receive ${key}`);
}
const config = execFileSync('git', ['config', '--local', '--list'], { encoding: 'utf8' });
assert.ok(!/extraheader|credential|https:\/\/[^/\s]+@/i.test(config), 'Checkout must not retain credentials');
console.log('Contributor environment contains no configured operator credentials or persisted checkout credentials.');
