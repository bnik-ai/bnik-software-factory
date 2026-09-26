// Scope-agnostic GitHub App auth primitives shared by the per-scope dep
// builders (agentDeps.ts / substrateDeps.ts). This module imports NEITHER
// agentClient.ts NOR substrateClient.ts, so it cannot break their
// static-import permission isolation (see those modules' headers).
//
// Reuses the existing utilities verbatim — does NOT reimplement JWT signing
// (appJwt.ts) or token minting (installationTokenMinter.ts).
//
// SECURITY: the PEM and any minted installation token MUST NEVER be logged.
// This module never console.logs the private key or a token. `signAppJwt`
// and `mintInstallationToken` likewise keep secrets out of error messages.

import { signAppJwt } from './appJwt.js';
import {
  InMemoryInstallationTokenCache,
  type InstallationTokenCache,
} from './installationTokenCache.js';
import { mintInstallationToken } from './installationTokenMinter.js';
import type { GetInstallationTokenDeps } from './installationTokenProvider.js';
import { getRedisClient } from './redisClient.js';
import { RedisInstallationTokenCache } from './redisInstallationTokenCache.js';

export const GITHUB_APP_ID_ENV = 'GITHUB_APP_ID';
export const GITHUB_APP_PRIVATE_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';
export const REDIS_HOST_ENV = 'REDIS_HOST';

export interface GitHubAppAuthOverrides {
  // Test seams. Production reads from env / constructs the real cache.
  appId?: string;
  privateKeyPem?: string;
  cache?: InstallationTokenCache;
  // Test override for the GitHub mint HTTP transport; production uses
  // Node 20's global fetch.
  fetchImpl?: typeof fetch;
}

// The shared inputs each scope-specific factory needs: a cache, a JWT signer,
// and a single-arg mint. Carries no agent/substrate-specific surface.
export interface GitHubAppAuthBase {
  cache: InstallationTokenCache;
  signJwt: () => string;
  mint: GetInstallationTokenDeps['mint'];
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; refusing to build GitHub App deps.`);
  }
  return value;
}

// Resolves the cache backend: Redis when REDIS_HOST is set, else in-memory
// (keeps the v0 boot + existing test suite working with no Redis env set).
function resolveCache(): InstallationTokenCache {
  const redisHost = process.env[REDIS_HOST_ENV];
  if (redisHost !== undefined && redisHost !== '') {
    return new RedisInstallationTokenCache(getRedisClient());
  }
  return new InMemoryInstallationTokenCache();
}

export function buildGitHubAppAuthBase(overrides: GitHubAppAuthOverrides = {}): GitHubAppAuthBase {
  const appId = overrides.appId ?? readRequiredEnv(GITHUB_APP_ID_ENV);
  const privateKeyPem = overrides.privateKeyPem ?? readRequiredEnv(GITHUB_APP_PRIVATE_KEY_ENV);
  const cache = overrides.cache ?? resolveCache();
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;

  // Fresh App JWT per call (10-min lifetime, signed from the PEM). The PEM is
  // captured in this closure and never logged.
  const signJwt = (): string => signAppJwt({ appId, privateKeyPem });

  // Adapt the two-arg mintInstallationToken to the single-arg `mint` shape
  // the client factories expect, closing over the global fetch transport.
  const mint: GetInstallationTokenDeps['mint'] = (args) =>
    mintInstallationToken(args, { fetch: fetchImpl });

  return { cache, signJwt, mint };
}
