import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { databaseConfig, resolveConfig, secret } from '../src/config.js';
import { canonicalJson } from '../src/queue.js';

const env = () => ({
  FACTORY_MODE: 'demo',
  FACTORY_REPOSITORY: 'example/factory-demo',
  GITHUB_INSTALLATION_ID: '1',
  GITHUB_APP_SLUG: 'factory-demo',
  GITHUB_WEBHOOK_SECRET: 'synthetic-demo-webhook-key-00000000',
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_TLS: 'disable',
  POSTGRES_DATABASE: 'software_factory',
  POSTGRES_USER: 'factory_runtime',
  POSTGRES_PASSWORD: 'synthetic-test-database-key-000000',
});

test('mode must be explicitly selected and cannot silently enable stubs', () => {
  assert.throws(
    () => resolveConfig({ ...env(), FACTORY_MODE: undefined }),
    /FACTORY_MODE_is_required/,
  );
  assert.throws(() => resolveConfig({ ...env(), FACTORY_MODE: 'test' }), /must_be_demo_or_live/);
  assert.equal(resolveConfig(env()).mode, 'demo');
});
test('partial live credentials fail before database or model activity', () => {
  const live = { ...env(), FACTORY_MODE: 'live' };
  assert.throws(() => resolveConfig(live), /GITHUB_APP_ID/);
  assert.throws(() => resolveConfig({ ...live, GITHUB_APP_ID: '1' }), /GITHUB_APP_PRIVATE_KEY/);
  assert.throws(
    () =>
      resolveConfig({
        ...live,
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'not-a-key',
      }),
    /RSA_private_key/,
  );
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const keyed = {
    ...live,
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    FACTORY_REPOSITORY_ID: '42',
    FACTORY_WEBHOOK_URL: 'https://factory.example.com/webhook',
    FACTORY_OPERATORS: 'example-maintainer',
    FACTORY_EXECUTION: 'manual',
  };
  assert.throws(() => resolveConfig(keyed), /ANTHROPIC_API_KEY/);
  assert.equal(resolveConfig({ ...keyed, ANTHROPIC_API_KEY: 'synthetic-model-key' }).mode, 'live');
});
test('demo rejects accidentally inherited live and cloud credentials', () => {
  for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'ANTHROPIC_API_KEY'])
    assert.throws(() => resolveConfig({ ...env(), [name]: 'accidental-live-value' }), /demo_mode/);
  assert.throws(
    () => resolveConfig({ ...env(), SERVICE_BUS_NAMESPACE: 'example' }),
    /cloud_configuration/,
  );
});
test('local auth is explicit and remote databases require verified TLS', () => {
  assert.throws(
    () => databaseConfig({ ...env(), POSTGRES_PASSWORD: undefined }),
    /POSTGRES_PASSWORD/,
  );
  assert.throws(
    () => databaseConfig({ ...env(), POSTGRES_HOST: 'remote.example' }),
    /requires_TLS/,
  );
  assert.deepEqual(
    databaseConfig({
      ...env(),
      POSTGRES_HOST: 'remote.example',
      POSTGRES_TLS: 'verify-full',
    }).ssl,
    { rejectUnauthorized: true },
  );
  assert.throws(() => databaseConfig({ ...env(), POSTGRES_TLS: undefined }), /POSTGRES_TLS/);
});
test('secret files work without emitting values and reject competing sources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-secret-test-'));
  try {
    const file = join(directory, 'secret');
    writeFileSync(file, 'synthetic-file-value\n', { mode: 0o600 });
    assert.equal(secret({ KEY_FILE: file }, 'KEY'), 'synthetic-file-value');
    assert.throws(() => secret({ KEY: 'inline', KEY_FILE: file }, 'KEY'), /mutually_exclusive/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test('invalid repository, installation, pool and lease settings fail closed', () => {
  for (const override of [
    { FACTORY_REPOSITORY: '../escape' },
    { GITHUB_INSTALLATION_ID: '0' },
    { POSTGRES_POOL_MAX: '1' },
    { FACTORY_LEASE_MS: '0' },
    { FACTORY_PORT: 'NaN' },
    { FACTORY_RETRY_MS: '1000', FACTORY_MAX_RETRY_MS: '1' },
  ])
    assert.throws(() => resolveConfig({ ...env(), ...override }));
});
test('receipt canonicalization ignores object order but preserves arrays and exact payload bytes', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
    canonicalJson({ a: { x: 3, y: 2 }, z: 1 }),
  );
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.notEqual(canonicalJson({ payload: '{"a":1}' }), canonicalJson({ payload: '{ "a": 1 }' }));
});
