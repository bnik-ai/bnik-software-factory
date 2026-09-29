import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DatabaseConfig } from './database.js';
import { type MergePolicy, parseMergePolicy } from './github/merge-policy.js';
import type { QueueOptions } from './queue.js';

type Env = Record<string, string | undefined>;
/**
 * Bounded autonomy (OSS-19/20). Present only when `FACTORY_EXECUTION=bounded` (live)
 * or `FACTORY_AUTONOMY=bounded` (demo). The controller connects with its own database
 * identity; the publisher is a separate GitHub App installation.
 */
/** A configuration refusal names itself: the operator sees this reason, never a library message. */
export class ConfigurationError extends Error {
  constructor(readonly reason: string = 'configuration_invalid') {
    super(reason);
  }
}

export interface AutonomyConfig {
  policyFile: string;
  bundleDirectory: string;
  controllerDatabasePassword: string;
  reviewer: {
    adapter: 'fixture' | 'claude';
    model: string | null;
    promptVersion: number;
    maxTokens: number;
    maxDiffBytes: number;
    maxContextBytes: number;
  };
  scanner: {
    adapter: 'fixture' | 'trivy';
    reference: string | null;
    cacheVolume: string | null;
  } | null;
  publisher: {
    appId: string;
    appPrivateKey: string;
    installationId: number;
    mode: 'fork' | 'base';
    forkRepository: string | null;
    forkRepositoryId: number | null;
  } | null;
  /** OSS-21: the App that merges routine pull requests; present only with FACTORY_AUTOMERGE=enabled (live). */
  merger: {
    appId: string;
    appPrivateKey: string;
    installationId: number;
    appSlug: string;
  } | null;
}
export interface RuntimeConfig {
  mode: 'demo' | 'live';
  execution?: 'disabled' | 'manual' | 'bounded';
  autonomy?: AutonomyConfig;
  repositoryId?: number;
  webhookUrl?: string;
  operators?: readonly string[];
  mergePolicy?: MergePolicy;
  /** Where the merge policy was read from; the merge gate reads it again before every look. */
  mergePolicyFile?: string;
  database: DatabaseConfig;
  queue: QueueOptions;
  repository: string;
  installationId: number;
  appSlug: string;
  webhookSecret: string;
  appId?: string;
  appPrivateKey?: string;
  modelKey?: string;
  host: string;
  port: number;
  pollMs: number;
  shutdownMs: number;
}

export function secret(env: Env, name: string): string {
  if (env[name] && env[`${name}_FILE`])
    throw new ConfigurationError(`${name}_and_FILE_are_mutually_exclusive`);
  const file = env[`${name}_FILE`];
  const value = file ? readFileSync(file, 'utf8').trimEnd() : env[name];
  if (!value?.trim()) throw new ConfigurationError(`${name}_is_required`);
  return value;
}
function required(env: Env, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new ConfigurationError(`${name}_is_required`);
  return value;
}
function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (
    (!raw?.trim() && raw !== undefined) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new ConfigurationError(`${name}_is_invalid`);
  return value;
}

export function databaseConfig(env: Env): DatabaseConfig {
  const tls = required(env, 'POSTGRES_TLS');
  if (tls !== 'disable' && tls !== 'verify-full')
    throw new ConfigurationError('POSTGRES_TLS_is_invalid');
  const host = required(env, 'POSTGRES_HOST');
  // Cleartext transport is opt-in and limited to local/container networking.
  if (tls === 'disable' && !['localhost', '127.0.0.1', '::1', 'db'].includes(host))
    throw new ConfigurationError('remote_database_requires_TLS');
  return {
    host,
    port: integer(env, 'POSTGRES_PORT', 5432, 1, 65535),
    database: required(env, 'POSTGRES_DATABASE'),
    user: required(env, 'POSTGRES_USER'),
    password: secret(env, 'POSTGRES_PASSWORD'),
    ssl:
      tls === 'disable'
        ? false
        : {
            rejectUnauthorized: true,
            ...(env.POSTGRES_CA_FILE ? { ca: readFileSync(env.POSTGRES_CA_FILE, 'utf8') } : {}),
          },
    max: integer(env, 'POSTGRES_POOL_MAX', 8, 4, 32),
  };
}

export interface ControllerConfig {
  mode: 'demo' | 'live';
  /** Live: the configured repository id; demo: null, the policy file names it. */
  repositoryId: number | null;
  controllerDatabasePassword: string;
  policyFile: string;
}
/**
 * What the ledger commands (activate, status, grant, revoke, pause, resume, approve,
 * reconcile) need: bounded mode, the controller database password and the policy file.
 * They run in a role that mounts no GitHub, model or publisher secret, so nothing else
 * may be required here.
 */
export function resolveControllerConfig(env: Env = process.env): ControllerConfig {
  const mode = required(env, 'FACTORY_MODE');
  if (mode !== 'demo' && mode !== 'live')
    throw new ConfigurationError('FACTORY_MODE_must_be_demo_or_live');
  const bounded =
    mode === 'demo' ? env.FACTORY_AUTONOMY === 'bounded' : env.FACTORY_EXECUTION === 'bounded';
  if (!bounded) throw new ConfigurationError('bounded_execution_required');
  const controllerDatabasePassword = secret(env, 'FACTORY_CONTROLLER_DB_PASSWORD');
  if (controllerDatabasePassword.length < 32)
    throw new ConfigurationError('FACTORY_CONTROLLER_DB_PASSWORD_must_have_at_least_32_characters');
  return {
    mode,
    repositoryId:
      mode === 'live' ? integer(env, 'FACTORY_REPOSITORY_ID', 0, 1, Number.MAX_SAFE_INTEGER) : null,
    controllerDatabasePassword,
    policyFile: absolutePath(env, 'FACTORY_AUTONOMY_POLICY_FILE'),
  };
}

/** The review sandbox reads at most 4 MiB of input; the diff and snapshot budgets must fit it. */
const REVIEW_INPUT_LIMIT = 3_500_000;
function reviewerSettings(
  env: NodeJS.ProcessEnv,
  adapter: 'fixture' | 'claude',
  model: string | null,
): AutonomyConfig['reviewer'] {
  const settings = {
    adapter,
    model,
    // Prompt 2 (OSS-22): the reviewer also receives the repository snapshot; 3: the protected suite
    // is never shown and the reply is one JSON object.
    promptVersion: integer(env, 'FACTORY_REVIEWER_PROMPT_VERSION', 3, 1, 1000),
    maxTokens: integer(env, 'FACTORY_REVIEWER_MAX_TOKENS', 4096, 256, 16384),
    maxDiffBytes: integer(env, 'FACTORY_REVIEWER_MAX_DIFF_BYTES', 1_000_000, 10_000, 8_000_000),
    // 640 KiB: the collector's 512 KiB of content plus headings and the omitted list.
    maxContextBytes: integer(
      env,
      'FACTORY_REVIEWER_MAX_CONTEXT_BYTES',
      640 * 1024,
      1024,
      4_000_000,
    ),
  };
  if (settings.maxDiffBytes + settings.maxContextBytes > REVIEW_INPUT_LIMIT)
    throw new ConfigurationError('reviewer_input_budgets_exceed_sandbox_limit');
  return settings;
}

/**
 * The merge policy as its file holds it now, validated as at start (parse, merger App identity).
 * The merge gate reads it before every look: a resident control plane otherwise keeps the policy it
 * started with, and a base branch changed since then parks every current pull request as
 * repository_merge_settings_unsafe while each command process sees the new file (OSS-22 live lane).
 */
export function readMergePolicy(
  file: string,
  merger?: { appId: string; appSlug: string },
): MergePolicy {
  const policy = parseMergePolicy(JSON.parse(readFileSync(file, 'utf8')));
  if (
    merger &&
    (policy.merger === undefined ||
      String(policy.merger.appId) !== merger.appId ||
      policy.merger.appSlug !== merger.appSlug)
  )
    throw new ConfigurationError('merge_policy_merger_must_match_FACTORY_MERGER_settings');
  return policy;
}

export function resolveConfig(env: Env = process.env): RuntimeConfig {
  const mode = required(env, 'FACTORY_MODE');
  if (mode !== 'demo' && mode !== 'live')
    throw new ConfigurationError('FACTORY_MODE_must_be_demo_or_live');
  // The local launcher never silently selects Azure or inherits a legacy fallback.
  if (env.SERVICE_BUS_NAMESPACE || env.SERVICE_BUS_CONNECTION_STRING || env.AZURE_CLIENT_ID)
    throw new ConfigurationError('cloud_configuration_not_allowed_in_local_profile');
  const repository = required(env, 'FACTORY_REPOSITORY');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository))
    throw new ConfigurationError('FACTORY_REPOSITORY_is_invalid');
  const webhookSecret = secret(env, 'GITHUB_WEBHOOK_SECRET');
  if (webhookSecret.length < 32)
    throw new ConfigurationError('GITHUB_WEBHOOK_SECRET_must_have_at_least_32_characters');
  const config: RuntimeConfig = {
    mode,
    repository,
    webhookSecret,
    database: databaseConfig(env),
    installationId: integer(env, 'GITHUB_INSTALLATION_ID', 0, 1, Number.MAX_SAFE_INTEGER),
    appSlug: required(env, 'GITHUB_APP_SLUG'),
    host: env.FACTORY_HOST ?? '127.0.0.1',
    port: integer(env, 'FACTORY_PORT', 8787, 1, 65535),
    pollMs: integer(env, 'FACTORY_POLL_MS', 250, 25, 60_000),
    shutdownMs: integer(env, 'FACTORY_SHUTDOWN_MS', 10_000, 100, 60_000),
    queue: {
      leaseMs: integer(env, 'FACTORY_LEASE_MS', 30_000, 1_000, 3_600_000),
      maxAttempts: integer(env, 'FACTORY_MAX_ATTEMPTS', 5, 1, 100),
      retryMs: integer(env, 'FACTORY_RETRY_MS', 1_000, 1, 60_000),
      maxRetryMs: integer(env, 'FACTORY_MAX_RETRY_MS', 60_000, 1, 3_600_000),
    },
  };
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(config.appSlug) ||
    config.queue.maxRetryMs < config.queue.retryMs
  )
    throw new ConfigurationError('invalid_runtime_configuration');
  if (mode === 'live') {
    config.appId = required(env, 'GITHUB_APP_ID');
    if (!/^\d+$/.test(config.appId)) throw new ConfigurationError('GITHUB_APP_ID_is_invalid');
    config.appPrivateKey = secret(env, 'GITHUB_APP_PRIVATE_KEY');
    try {
      if (createPrivateKey(config.appPrivateKey).asymmetricKeyType !== 'rsa')
        throw new ConfigurationError();
    } catch {
      throw new ConfigurationError('GITHUB_APP_PRIVATE_KEY_must_be_an_RSA_private_key');
    }
    config.repositoryId = integer(env, 'FACTORY_REPOSITORY_ID', 0, 1, Number.MAX_SAFE_INTEGER);
    const url = new URL(required(env, 'FACTORY_WEBHOOK_URL'));
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/webhook' ||
      url.port ||
      !url.hostname.includes('.') ||
      /^(localhost|127\.|0\.|\[)/.test(url.hostname)
    )
      throw new ConfigurationError('FACTORY_WEBHOOK_URL_requires_public_HTTPS_webhook_path');
    config.webhookUrl = url.href;
    config.operators = required(env, 'FACTORY_OPERATORS')
      .split(',')
      .map((v) => v.trim().toLowerCase());
    if (
      config.operators.length > 20 ||
      config.operators.some((v) => !/^[a-z0-9][a-z0-9-]{0,38}$/.test(v)) ||
      new Set(config.operators).size !== config.operators.length
    )
      throw new ConfigurationError('FACTORY_OPERATORS_is_invalid');
    const execution = required(env, 'FACTORY_EXECUTION');
    if (execution !== 'disabled' && execution !== 'manual' && execution !== 'bounded')
      throw new ConfigurationError('FACTORY_EXECUTION_must_be_disabled_manual_or_bounded');
    config.execution = execution;
    if (env.FACTORY_MERGE_POLICY_FILE) {
      config.mergePolicyFile = env.FACTORY_MERGE_POLICY_FILE;
      config.mergePolicy = parseMergePolicy(
        JSON.parse(readFileSync(env.FACTORY_MERGE_POLICY_FILE, 'utf8')),
      );
    }
    if (execution === 'manual' || execution === 'bounded')
      config.modelKey = secret(env, 'ANTHROPIC_API_KEY');
    else if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY_FILE)
      throw new ConfigurationError('disabled_execution_must_not_receive_model_credentials');
    if (execution === 'bounded') config.autonomy = autonomyConfig(env, 'live');
    else if (env.FACTORY_AUTONOMY)
      throw new ConfigurationError('FACTORY_AUTONOMY_requires_bounded_execution');
    else if (env.FACTORY_AUTOMERGE)
      throw new ConfigurationError('FACTORY_AUTOMERGE_requires_bounded_execution');
    // Automatic merge needs the merge policy (protections, checks, merger App) to be configured.
    if (config.autonomy?.merger) {
      if (!config.mergePolicy) throw new ConfigurationError('automerge_requires_merge_policy');
      if (
        config.mergePolicy.merger === undefined ||
        String(config.mergePolicy.merger.appId) !== config.autonomy.merger.appId ||
        config.mergePolicy.merger.appSlug !== config.autonomy.merger.appSlug
      )
        throw new ConfigurationError('merge_policy_merger_must_match_FACTORY_MERGER_settings');
    }
  } else if (
    ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'ANTHROPIC_API_KEY'].some(
      (key) => env[key] || env[`${key}_FILE`],
    )
  ) {
    throw new ConfigurationError('demo_mode_must_not_receive_live_credentials');
  } else if (env.FACTORY_AUTONOMY === 'bounded') config.autonomy = autonomyConfig(env, 'demo');
  else if (env.FACTORY_AUTONOMY)
    throw new ConfigurationError('FACTORY_AUTONOMY_must_be_bounded_or_unset');
  return config;
}
function absolutePath(env: Env, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value)) throw new ConfigurationError(`${name}_must_be_absolute`);
  return value;
}
function autonomyConfig(env: Env, mode: 'demo' | 'live'): AutonomyConfig {
  const controllerDatabasePassword = secret(env, 'FACTORY_CONTROLLER_DB_PASSWORD');
  if (controllerDatabasePassword.length < 32)
    throw new ConfigurationError('FACTORY_CONTROLLER_DB_PASSWORD_must_have_at_least_32_characters');
  const reviewerAdapter = env.FACTORY_REVIEWER ?? (mode === 'demo' ? 'fixture' : undefined);
  if (reviewerAdapter !== 'fixture' && reviewerAdapter !== 'claude')
    throw new ConfigurationError('FACTORY_REVIEWER_must_be_fixture_or_claude');
  if (mode === 'demo' && reviewerAdapter !== 'fixture')
    throw new ConfigurationError('demo_autonomy_requires_fixture_reviewer');
  // Fixture adapters emit vacuous receipts; a live policy must not be able to pin them.
  if (mode === 'live' && reviewerAdapter === 'fixture')
    throw new ConfigurationError('live_autonomy_requires_claude_reviewer');
  const model = env.FACTORY_REVIEWER_MODEL ?? null;
  if (reviewerAdapter === 'claude' && !(model && /^claude-[A-Za-z0-9.-]{1,93}$/.test(model)))
    throw new ConfigurationError('FACTORY_REVIEWER_MODEL_is_required_for_claude_reviewer');
  if (reviewerAdapter === 'fixture' && model)
    throw new ConfigurationError('fixture_reviewer_takes_no_model');
  const scannerAdapter = env.FACTORY_SCANNER ?? 'off';
  if (mode === 'live' && scannerAdapter === 'fixture')
    throw new ConfigurationError('live_autonomy_forbids_fixture_scanner');
  let scanner: AutonomyConfig['scanner'] = null;
  if (scannerAdapter === 'fixture')
    scanner = { adapter: 'fixture', reference: null, cacheVolume: null };
  else if (scannerAdapter === 'trivy') {
    const reference = required(env, 'FACTORY_SCANNER_IMAGE');
    const cacheVolume = required(env, 'FACTORY_SCANNER_CACHE_VOLUME');
    if (!/^[A-Za-z0-9][A-Za-z0-9_./:@-]{1,255}$/.test(reference))
      throw new ConfigurationError('FACTORY_SCANNER_IMAGE_is_invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(cacheVolume))
      throw new ConfigurationError('FACTORY_SCANNER_CACHE_VOLUME_is_invalid');
    scanner = { adapter: 'trivy', reference, cacheVolume };
  } else if (scannerAdapter !== 'off')
    throw new ConfigurationError('FACTORY_SCANNER_must_be_off_fixture_or_trivy');
  let publisher: AutonomyConfig['publisher'] = null;
  const publisherKeys = [
    'FACTORY_PUBLISHER_APP_ID',
    'FACTORY_PUBLISHER_APP_PRIVATE_KEY',
    'FACTORY_PUBLISHER_APP_PRIVATE_KEY_FILE',
    'FACTORY_PUBLISHER_INSTALLATION_ID',
    'FACTORY_PUBLICATION_MODE',
    'FACTORY_FORK_REPOSITORY',
    'FACTORY_FORK_REPOSITORY_ID',
    'FACTORY_PUBLICATION_SECRETLESS_CI',
  ];
  if (mode === 'demo') {
    if (publisherKeys.some((key) => env[key]))
      throw new ConfigurationError('demo_autonomy_must_not_receive_publisher_credentials');
  } else {
    const appId = required(env, 'FACTORY_PUBLISHER_APP_ID');
    if (!/^\d+$/.test(appId)) throw new ConfigurationError('FACTORY_PUBLISHER_APP_ID_is_invalid');
    const appPrivateKey = secret(env, 'FACTORY_PUBLISHER_APP_PRIVATE_KEY');
    try {
      if (createPrivateKey(appPrivateKey).asymmetricKeyType !== 'rsa')
        throw new ConfigurationError();
    } catch {
      throw new ConfigurationError('FACTORY_PUBLISHER_APP_PRIVATE_KEY_must_be_an_RSA_private_key');
    }
    const publicationMode = required(env, 'FACTORY_PUBLICATION_MODE');
    if (publicationMode !== 'fork' && publicationMode !== 'base')
      throw new ConfigurationError('FACTORY_PUBLICATION_MODE_must_be_fork_or_base');
    let forkRepository: string | null = null;
    let forkRepositoryId: number | null = null;
    if (publicationMode === 'fork') {
      forkRepository = required(env, 'FACTORY_FORK_REPOSITORY');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(forkRepository))
        throw new ConfigurationError('FACTORY_FORK_REPOSITORY_is_invalid');
      forkRepositoryId = integer(env, 'FACTORY_FORK_REPOSITORY_ID', 0, 1, Number.MAX_SAFE_INTEGER);
    } else if (env.FACTORY_PUBLICATION_SECRETLESS_CI !== 'attested')
      // Pushing into the base repository runs its CI with its secrets on agent code.
      throw new ConfigurationError(
        'base_publication_requires_FACTORY_PUBLICATION_SECRETLESS_CI_attested',
      );
    publisher = {
      appId,
      appPrivateKey,
      installationId: integer(
        env,
        'FACTORY_PUBLISHER_INSTALLATION_ID',
        0,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      mode: publicationMode,
      forkRepository,
      forkRepositoryId,
    };
  }
  let merger: AutonomyConfig['merger'] = null;
  const mergerKeys = [
    'FACTORY_MERGER_APP_ID',
    'FACTORY_MERGER_APP_PRIVATE_KEY',
    'FACTORY_MERGER_APP_PRIVATE_KEY_FILE',
    'FACTORY_MERGER_INSTALLATION_ID',
    'FACTORY_MERGER_APP_SLUG',
  ];
  if (env.FACTORY_AUTOMERGE !== undefined && env.FACTORY_AUTOMERGE !== 'enabled')
    throw new ConfigurationError('FACTORY_AUTOMERGE_must_be_enabled_or_unset');
  if (env.FACTORY_AUTOMERGE === 'enabled') {
    if (mode === 'demo') throw new ConfigurationError('demo_autonomy_cannot_merge');
    const appId = required(env, 'FACTORY_MERGER_APP_ID');
    if (!/^\d+$/.test(appId)) throw new ConfigurationError('FACTORY_MERGER_APP_ID_is_invalid');
    const appPrivateKey = secret(env, 'FACTORY_MERGER_APP_PRIVATE_KEY');
    try {
      if (createPrivateKey(appPrivateKey).asymmetricKeyType !== 'rsa')
        throw new ConfigurationError();
    } catch {
      throw new ConfigurationError('FACTORY_MERGER_APP_PRIVATE_KEY_must_be_an_RSA_private_key');
    }
    const appSlug = required(env, 'FACTORY_MERGER_APP_SLUG');
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(appSlug))
      throw new ConfigurationError('FACTORY_MERGER_APP_SLUG_is_invalid');
    // Two identities: the publisher writes agent code, the merger merges it.
    if (publisher && publisher.appId === appId)
      throw new ConfigurationError('merger_app_must_differ_from_publisher_app');
    merger = {
      appId,
      appPrivateKey,
      installationId: integer(env, 'FACTORY_MERGER_INSTALLATION_ID', 0, 1, Number.MAX_SAFE_INTEGER),
      appSlug,
    };
  } else if (mergerKeys.some((key) => env[key]))
    throw new ConfigurationError('merger_settings_require_FACTORY_AUTOMERGE_enabled');
  return {
    policyFile: absolutePath(env, 'FACTORY_AUTONOMY_POLICY_FILE'),
    bundleDirectory: absolutePath(env, 'FACTORY_ACCEPTANCE_BUNDLE_DIR'),
    controllerDatabasePassword,
    reviewer: reviewerSettings(env, reviewerAdapter, model),
    scanner,
    publisher,
    merger,
  };
}
