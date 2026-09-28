import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { databaseConfig, resolveConfig, resolveControllerConfig, secret } from '../src/config.js';
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

test('ledger commands resolve a controller configuration that needs no GitHub, model or publisher secret', () => {
  const controllerPassword = 'synthetic-controller-database-key-000000';
  const live = {
    FACTORY_MODE: 'live',
    FACTORY_EXECUTION: 'bounded',
    FACTORY_REPOSITORY_ID: '4242',
    FACTORY_CONTROLLER_DB_PASSWORD: controllerPassword,
    FACTORY_AUTONOMY_POLICY_FILE: '/state/autonomy-policy.json',
  };
  const resolved = resolveControllerConfig(live);
  assert.equal(resolved.mode, 'live');
  assert.equal(resolved.repositoryId, 4242);
  assert.equal(resolved.controllerDatabasePassword, controllerPassword);
  // The full live configuration refuses the same environment: it demands the App key.
  assert.throws(() => resolveConfig({ ...env(), ...live }));
  assert.throws(
    () => resolveControllerConfig({ ...live, FACTORY_EXECUTION: 'manual' }),
    /bounded_execution_required/,
  );
  const demo = {
    FACTORY_MODE: 'demo',
    FACTORY_AUTONOMY: 'bounded',
    FACTORY_CONTROLLER_DB_PASSWORD: controllerPassword,
    FACTORY_AUTONOMY_POLICY_FILE: '/state/autonomy-policy.json',
  };
  assert.equal(resolveControllerConfig(demo).repositoryId, null);
  assert.throws(
    () => resolveControllerConfig({ ...demo, FACTORY_AUTONOMY: undefined }),
    /bounded_execution_required/,
  );
  assert.throws(
    () => resolveControllerConfig({ ...demo, FACTORY_CONTROLLER_DB_PASSWORD: 'short' }),
    /at_least_32/,
  );
});

test('bounded autonomy configuration is explicit in both modes and keeps publisher credentials out of demo', () => {
  const controllerPassword = 'synthetic-controller-database-key-000000';
  const demo = {
    ...env(),
    FACTORY_AUTONOMY: 'bounded',
    FACTORY_CONTROLLER_DB_PASSWORD: controllerPassword,
    FACTORY_AUTONOMY_POLICY_FILE: '/state/autonomy-policy.json',
    FACTORY_ACCEPTANCE_BUNDLE_DIR: '/state/acceptance',
  };
  const resolved = resolveConfig(demo);
  assert.equal(resolved.autonomy?.reviewer.adapter, 'fixture');
  assert.equal(resolved.autonomy?.scanner, null);
  assert.equal(resolved.autonomy?.publisher, null);
  assert.equal(resolved.autonomy?.controllerDatabasePassword, controllerPassword);
  assert.throws(
    () => resolveConfig({ ...demo, FACTORY_AUTONOMY: 'yes' }),
    /FACTORY_AUTONOMY_must_be_bounded_or_unset/,
  );
  assert.throws(
    () => resolveConfig({ ...demo, FACTORY_CONTROLLER_DB_PASSWORD: 'short' }),
    /at_least_32/,
  );
  assert.throws(
    () => resolveConfig({ ...demo, FACTORY_AUTONOMY_POLICY_FILE: 'relative.json' }),
    /must_be_absolute/,
  );
  assert.throws(
    () => resolveConfig({ ...demo, FACTORY_REVIEWER: 'claude' }),
    /demo_autonomy_requires_fixture_reviewer/,
  );
  assert.throws(
    () => resolveConfig({ ...demo, FACTORY_PUBLISHER_APP_ID: '9' }),
    /demo_autonomy_must_not_receive_publisher_credentials/,
  );
  assert.throws(
    () => resolveConfig({ ...demo, FACTORY_SCANNER: 'trivy' }),
    /FACTORY_SCANNER_IMAGE_is_required/,
  );
  assert.equal(
    resolveConfig({
      ...demo,
      FACTORY_SCANNER: 'trivy',
      FACTORY_SCANNER_IMAGE: 'aquasec/trivy@sha256:abc',
      FACTORY_SCANNER_CACHE_VOLUME: 'factory-scanner-cache',
    }).autonomy?.scanner?.adapter,
    'trivy',
  );
  assert.equal(resolveConfig(env()).autonomy, undefined);

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const live = {
    ...env(),
    FACTORY_MODE: 'live',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    FACTORY_REPOSITORY_ID: '42',
    FACTORY_WEBHOOK_URL: 'https://factory.example.com/webhook',
    FACTORY_OPERATORS: 'example-maintainer',
    FACTORY_EXECUTION: 'bounded',
    ANTHROPIC_API_KEY: 'synthetic-model-key',
    FACTORY_CONTROLLER_DB_PASSWORD: controllerPassword,
    FACTORY_AUTONOMY_POLICY_FILE: '/state/autonomy-policy.json',
    FACTORY_ACCEPTANCE_BUNDLE_DIR: '/state/acceptance',
    FACTORY_REVIEWER: 'claude',
    FACTORY_REVIEWER_MODEL: 'claude-sonnet-5',
    FACTORY_PUBLISHER_APP_ID: '2',
    FACTORY_PUBLISHER_APP_PRIVATE_KEY: privateKey,
    FACTORY_PUBLISHER_INSTALLATION_ID: '77',
    FACTORY_PUBLICATION_MODE: 'fork',
    FACTORY_FORK_REPOSITORY: 'factory-bot/factory-demo',
    FACTORY_FORK_REPOSITORY_ID: '4242',
  };
  const bounded = resolveConfig(live);
  assert.equal(bounded.execution, 'bounded');
  assert.equal(bounded.autonomy?.publisher?.mode, 'fork');
  assert.equal(bounded.autonomy?.publisher?.forkRepositoryId, 4242);
  assert.equal(bounded.autonomy?.reviewer.model, 'claude-sonnet-5');
  assert.equal(bounded.modelKey, 'synthetic-model-key');
  assert.throws(
    () => resolveConfig({ ...live, FACTORY_REVIEWER: undefined }),
    /FACTORY_REVIEWER_must_be_fixture_or_claude/,
  );
  // Live mode never accepts the fixture adapters: their receipts prove nothing.
  assert.throws(
    () =>
      resolveConfig({ ...live, FACTORY_REVIEWER: 'fixture', FACTORY_REVIEWER_MODEL: undefined }),
    /live_autonomy_requires_claude_reviewer/,
  );
  assert.throws(
    () => resolveConfig({ ...live, FACTORY_SCANNER: 'fixture' }),
    /live_autonomy_forbids_fixture_scanner/,
  );
  assert.throws(
    () => resolveConfig({ ...live, FACTORY_REVIEWER_MODEL: undefined }),
    /FACTORY_REVIEWER_MODEL_is_required/,
  );
  assert.throws(
    () => resolveConfig({ ...live, FACTORY_PUBLISHER_APP_PRIVATE_KEY: 'nope' }),
    /FACTORY_PUBLISHER_APP_PRIVATE_KEY_must_be_an_RSA/,
  );
  assert.throws(
    () => resolveConfig({ ...live, FACTORY_PUBLICATION_MODE: 'base' }),
    /base_publication_requires_FACTORY_PUBLICATION_SECRETLESS_CI_attested/,
  );
  assert.equal(
    resolveConfig({
      ...live,
      FACTORY_PUBLICATION_MODE: 'base',
      FACTORY_FORK_REPOSITORY: undefined,
      FACTORY_FORK_REPOSITORY_ID: undefined,
      FACTORY_PUBLICATION_SECRETLESS_CI: 'attested',
    }).autonomy?.publisher?.mode,
    'base',
  );
  assert.throws(
    () => resolveConfig({ ...live, FACTORY_EXECUTION: 'manual', FACTORY_AUTONOMY: 'bounded' }),
    /FACTORY_AUTONOMY_requires_bounded_execution/,
  );
  assert.throws(
    () => resolveConfig({ ...live, ANTHROPIC_API_KEY: undefined }),
    /ANTHROPIC_API_KEY/,
  );
});

test('automatic merge is a live opt-in with a merger App distinct from the publisher and named in the merge policy', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const directory = mkdtempSync(join(tmpdir(), 'factory-merge-policy-'));
  const policyFile = join(directory, 'merge-policy.json');
  const mergePolicy = {
    version: 1,
    baseBranch: 'main',
    reviewers: ['example-maintainer'],
    mergers: ['example-maintainer'],
    requiredChecks: [{ name: 'test', appId: 12345 }],
    merger: { appSlug: 'factory-merger', appId: 777 },
  };
  writeFileSync(policyFile, JSON.stringify(mergePolicy), { mode: 0o600 });
  try {
    const live = {
      ...env(),
      FACTORY_MODE: 'live',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      FACTORY_REPOSITORY_ID: '42',
      FACTORY_WEBHOOK_URL: 'https://factory.example.com/webhook',
      FACTORY_OPERATORS: 'example-maintainer',
      FACTORY_EXECUTION: 'bounded',
      ANTHROPIC_API_KEY: 'synthetic-model-key',
      FACTORY_CONTROLLER_DB_PASSWORD: 'synthetic-controller-database-key-000000',
      FACTORY_AUTONOMY_POLICY_FILE: '/state/autonomy-policy.json',
      FACTORY_ACCEPTANCE_BUNDLE_DIR: '/state/acceptance',
      FACTORY_REVIEWER: 'claude',
      FACTORY_REVIEWER_MODEL: 'claude-sonnet-5',
      FACTORY_PUBLICATION_MODE: 'fork',
      FACTORY_FORK_REPOSITORY: 'factory-bot/factory-demo',
      FACTORY_FORK_REPOSITORY_ID: '4242',
      FACTORY_PUBLISHER_APP_ID: '9',
      FACTORY_PUBLISHER_APP_PRIVATE_KEY: privateKey,
      FACTORY_PUBLISHER_INSTALLATION_ID: '99',
      FACTORY_MERGE_POLICY_FILE: policyFile,
    };
    assert.equal(resolveConfig(live).autonomy?.merger, null);
    const merging = {
      ...live,
      FACTORY_AUTOMERGE: 'enabled',
      FACTORY_MERGER_APP_ID: '777',
      FACTORY_MERGER_APP_PRIVATE_KEY: privateKey,
      FACTORY_MERGER_INSTALLATION_ID: '7777',
      FACTORY_MERGER_APP_SLUG: 'factory-merger',
    };
    const resolved = resolveConfig(merging);
    assert.deepEqual(
      { ...resolved.autonomy?.merger, appPrivateKey: 'redacted' },
      { appId: '777', appPrivateKey: 'redacted', installationId: 7777, appSlug: 'factory-merger' },
    );
    assert.throws(
      () => resolveConfig({ ...merging, FACTORY_AUTOMERGE: 'yes' }),
      /FACTORY_AUTOMERGE_must_be_enabled_or_unset/,
    );
    assert.throws(
      () => resolveConfig({ ...live, FACTORY_MERGER_APP_ID: '777' }),
      /merger_settings_require_FACTORY_AUTOMERGE_enabled/,
    );
    assert.throws(
      () => resolveConfig({ ...merging, FACTORY_MERGER_APP_ID: '9' }),
      /merger_app_must_differ_from_publisher_app/,
    );
    assert.throws(
      () => resolveConfig({ ...merging, FACTORY_MERGER_APP_SLUG: 'other-merger' }),
      /merge_policy_merger_must_match_FACTORY_MERGER_settings/,
    );
    assert.throws(
      () => resolveConfig({ ...merging, FACTORY_MERGE_POLICY_FILE: undefined }),
      /automerge_requires_merge_policy/,
    );
    assert.throws(
      () => resolveConfig({ ...merging, FACTORY_EXECUTION: 'manual', FACTORY_AUTONOMY: undefined }),
      /FACTORY_AUTOMERGE_requires_bounded_execution|FACTORY_AUTONOMY|publisher|merger/,
    );
    const demo = {
      ...env(),
      FACTORY_AUTONOMY: 'bounded',
      FACTORY_CONTROLLER_DB_PASSWORD: 'synthetic-controller-database-key-000000',
      FACTORY_AUTONOMY_POLICY_FILE: '/state/autonomy-policy.json',
      FACTORY_ACCEPTANCE_BUNDLE_DIR: '/state/acceptance',
      FACTORY_AUTOMERGE: 'enabled',
    };
    assert.throws(() => resolveConfig(demo), /demo_autonomy_cannot_merge/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
