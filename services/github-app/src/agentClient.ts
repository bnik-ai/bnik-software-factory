import type { CachedInstallationToken, InstallationTokenCache } from './installationTokenCache.js';
import type { InstallationPermissions } from './installationTokenMinter.js';
import {
  type GetInstallationTokenDeps,
  getInstallationToken,
} from './installationTokenProvider.js';

// Spec: docs/design/github-app.md:79-89 (Agent-write table).
// Invariants:
//   - AGENT_PERMISSIONS is frozen; runtime mutation throws TypeError.
//   - Cache keys carry `agent:` prefix before reaching the provider, so
//     a backing cache shared with substrateClient cannot leak tokens.
//   - No barrel with substrateClient.ts; static-import-only isolation.
//     ca-agent / ca-webhook / ca-admin bundle THIS file directly;
//     ca-terraform bundles substrateClient.ts directly.
//   - substrate and agent BOTH carry `contents:write` (substrate for
//     Terraform commits, agent for code pushes); isolation comes from
//     the disjoint set, not from any single key.
// Permission key map (design name → GitHub API key):
//   Issues                → issues
//   Pull requests         → pull_requests
//   Repository contents   → contents          (also covers Releases)
//   Repository projects   → repository_projects
//   Organization projects → organization_projects (write level, vs substrate's admin)
//   Workflows / actions   → actions + workflows (trigger + modify)
//   Deployments           → deployments       (Deployment + DeploymentStatus)
//   Commit statuses       → statuses
//   Members               → members (read level — assignees / reviewers)

const AGENT_CACHE_PREFIX = 'agent:';

export const AGENT_PERMISSIONS: InstallationPermissions = Object.freeze({
  issues: 'write',
  pull_requests: 'write',
  contents: 'write',
  repository_projects: 'write',
  organization_projects: 'write',
  actions: 'write',
  workflows: 'write',
  deployments: 'write',
  statuses: 'write',
  members: 'read',
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
export interface AgentClientConfig {
  cache: InstallationTokenCache;
  signJwt: () => string;
  mint: GetInstallationTokenDeps['mint'];
  clock?: () => number;
  safetyMarginMs?: number;
}

export interface AgentClient {
  readonly scope: 'agent';
  readonly permissions: InstallationPermissions;
  getToken(installationId: number | string): Promise<string>;
}

export function buildAgentClient(config: AgentClientConfig): AgentClient {
  const scopedConfig: GetInstallationTokenDeps = {
    ...config,
    cache: namespacedCache(config.cache, AGENT_CACHE_PREFIX),
  };
  return {
    scope: 'agent',
    permissions: AGENT_PERMISSIONS,
    async getToken(installationId) {
      const provided = await getInstallationToken(
        { installationId, permissions: AGENT_PERMISSIONS },
        scopedConfig,
      );
      return provided.token;
    },
  };
}
