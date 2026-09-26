import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseConfig } from './database.js';
import type { QueueOptions } from './queue.js';

type Env = Record<string, string | undefined>;
export interface RuntimeConfig {
  mode: 'demo' | 'live';
  execution?: 'disabled' | 'manual';
  repositoryId?: number;
  webhookUrl?: string;
  operators?: readonly string[];
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
  if (env[name] && env[`${name}_FILE`]) throw new Error(`${name}_and_FILE_are_mutually_exclusive`);
  const file = env[`${name}_FILE`];
  const value = file ? readFileSync(file, 'utf8').trimEnd() : env[name];
  if (!value?.trim()) throw new Error(`${name}_is_required`);
  return value;
}
function required(env: Env, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`${name}_is_required`);
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
    throw new Error(`${name}_is_invalid`);
  return value;
}

export function databaseConfig(env: Env): DatabaseConfig {
  const tls = required(env, 'POSTGRES_TLS');
  if (tls !== 'disable' && tls !== 'verify-full') throw new Error('POSTGRES_TLS_is_invalid');
  const host = required(env, 'POSTGRES_HOST');
  // Cleartext transport is opt-in and limited to local/container networking.
  if (tls === 'disable' && !['localhost', '127.0.0.1', '::1', 'db'].includes(host))
    throw new Error('remote_database_requires_TLS');
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

export function resolveConfig(env: Env = process.env): RuntimeConfig {
  const mode = required(env, 'FACTORY_MODE');
  if (mode !== 'demo' && mode !== 'live') throw new Error('FACTORY_MODE_must_be_demo_or_live');
  // The local launcher never silently selects Azure or inherits a legacy fallback.
  if (env.SERVICE_BUS_NAMESPACE || env.SERVICE_BUS_CONNECTION_STRING || env.AZURE_CLIENT_ID)
    throw new Error('cloud_configuration_not_allowed_in_local_profile');
  const repository = required(env, 'FACTORY_REPOSITORY');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository))
    throw new Error('FACTORY_REPOSITORY_is_invalid');
  const webhookSecret = secret(env, 'GITHUB_WEBHOOK_SECRET');
  if (webhookSecret.length < 32)
    throw new Error('GITHUB_WEBHOOK_SECRET_must_have_at_least_32_characters');
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
    throw new Error('invalid_runtime_configuration');
  if (mode === 'live') {
    config.appId = required(env, 'GITHUB_APP_ID');
    if (!/^\d+$/.test(config.appId)) throw new Error('GITHUB_APP_ID_is_invalid');
    config.appPrivateKey = secret(env, 'GITHUB_APP_PRIVATE_KEY');
    try {
      if (createPrivateKey(config.appPrivateKey).asymmetricKeyType !== 'rsa') throw new Error();
    } catch {
      throw new Error('GITHUB_APP_PRIVATE_KEY_must_be_an_RSA_private_key');
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
      throw new Error('FACTORY_WEBHOOK_URL_requires_public_HTTPS_webhook_path');
    config.webhookUrl = url.href;
    config.operators = required(env, 'FACTORY_OPERATORS')
      .split(',')
      .map((v) => v.trim().toLowerCase());
    if (
      config.operators.length > 20 ||
      config.operators.some((v) => !/^[a-z0-9][a-z0-9-]{0,38}$/.test(v)) ||
      new Set(config.operators).size !== config.operators.length
    )
      throw new Error('FACTORY_OPERATORS_is_invalid');
    const execution = required(env, 'FACTORY_EXECUTION');
    if (execution !== 'disabled' && execution !== 'manual')
      throw new Error('FACTORY_EXECUTION_must_be_disabled_or_manual');
    config.execution = execution;
    if (execution === 'manual') config.modelKey = secret(env, 'ANTHROPIC_API_KEY');
    else if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY_FILE)
      throw new Error('disabled_execution_must_not_receive_model_credentials');
  } else if (
    ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'ANTHROPIC_API_KEY'].some(
      (key) => env[key] || env[`${key}_FILE`],
    )
  ) {
    throw new Error('demo_mode_must_not_receive_live_credentials');
  }
  return config;
}
