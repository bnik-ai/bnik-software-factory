import type { CachedInstallationToken, InstallationTokenCache } from './installationTokenCache.js';
import type { InstallationPermissions } from './installationTokenMinter.js';
import {
  type GetInstallationTokenDeps,
  getInstallationToken,
} from './installationTokenProvider.js';

// Spec: docs/design/github-app.md:64-72 (Substrate-write table).
// Invariants:
//   - SUBSTRATE_PERMISSIONS is frozen; runtime mutation throws TypeError.
//   - Cache keys carry `substrate:` prefix before reaching the provider,
//     so a backing cache shared with agentClient cannot leak tokens.
//   - No barrel with agentClient.ts; static-import-only isolation. The
//     ca-terraform image bundles THIS file directly; ca-agent / ca-webhook
//     / ca-admin bundle agentClient.ts directly.
// Permission key map (design name → GitHub API key):
//   Repository administration   → administration
//   Repository contents         → contents
//   Organization administration → organization_administration
//   Organization projects       → organization_projects (admin level)
//   Organization webhooks       → organization_hooks (admin level)
//   Repository webhooks         → repository_hooks (admin level)
//   Environments                → environments
//   Secrets                     → secrets

const SUBSTRATE_CACHE_PREFIX = 'substrate:';

export const SUBSTRATE_PERMISSIONS: InstallationPermissions = Object.freeze({
  administration: 'write',
  contents: 'write',
  organization_administration: 'write',
  organization_projects: 'admin',
  organization_hooks: 'admin',
  repository_hooks: 'admin',
  environments: 'write',
  secrets: 'write',
});

function namespacedCache(cache: InstallationTokenCache, prefix: string): InstallationTokenCache {
  return {
    get(installationId: string): Promise<CachedInstallationToken | null> {
      return cache.get(`${prefix}${installationId}`);
    },
    set(installationId: string, token: CachedInstallationToken): Promise<void> {
      return cache.set(`${prefix}${installationId}`, token);
    },
  };
}

// Caller closes `fetch` over `mintInstallationToken` to produce the
// single-arg `mint`; see GetInstallationTokenDeps.
export interface SubstrateClientConfig {
  cache: InstallationTokenCache;
  signJwt: () => string;
  mint: GetInstallationTokenDeps['mint'];
  clock?: () => number;
  safetyMarginMs?: number;
}

export interface SubstrateClient {
  readonly scope: 'substrate';
  readonly permissions: InstallationPermissions;
  getToken(installationId: number | string): Promise<string>;
}

export function buildSubstrateClient(config: SubstrateClientConfig): SubstrateClient {
  const scopedConfig: GetInstallationTokenDeps = {
    ...config,
    cache: namespacedCache(config.cache, SUBSTRATE_CACHE_PREFIX),
  };
  return {
    scope: 'substrate',
    permissions: SUBSTRATE_PERMISSIONS,
    async getToken(installationId) {
      const provided = await getInstallationToken(
        { installationId, permissions: SUBSTRATE_PERMISSIONS },
        scopedConfig,
      );
      return provided.token;
    },
  };
}
