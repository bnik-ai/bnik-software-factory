import type { InstallationTokenCache } from './installationTokenCache.js';
import type {
  InstallationPermissions,
  MintedInstallationToken,
} from './installationTokenMinter.js';

// Cache-or-mint orchestration that composes `signAppJwt` +
// `InstallationTokenCache` with `mintInstallationToken` into a single call
// surface that the substrate/agent client factories (`buildSubstrateClient` /
// `buildAgentClient`) call once per request.
//
// Substrate-vs-agent permission isolation lives ONE level above this
// function: each factory (`buildSubstrateClient` / `buildAgentClient`)
// wraps the user-supplied `InstallationTokenCache` with a per-scope key
// prefix (`substrate:<installation_id>` / `agent:<installation_id>`)
// before passing it to this provider. The provider itself stays
// scope-agnostic and just calls `cache.get(args.installationId)`. The
// design in github-app.md "Authentication model" specifies
// `inst:<installation_id>` for the underlying cache; the factory-side
// scope prefix is layered on top, so the real Azure Cache for Redis key
// is `inst:<scope>:<installation_id>` once the production cache wraps
// the bare key in the design's `inst:` prefix.
//
// Safety margin: GitHub returns `expires_at` 1 hour after mint. We cache
// the token with an `expiresAt` shifted EARLIER by the safety margin
// (default 5 minutes) so the cache returns null while there's still
// enough time on the real token to complete the next downstream request
// without it expiring mid-flight.

export interface GetInstallationTokenArgs {
  installationId: number | string;
  // Optional per-token scope downgrade forwarded to `mintInstallationToken`
  // on cache miss. The caller (the client factory layer) supplies a fixed
  // value per scope so all calls within a scope share the same minted-
  // token shape and the cache key remains the bare installation_id.
  permissions?: InstallationPermissions;
  repositoryIds?: number[];
}

export interface GetInstallationTokenDeps {
  cache: InstallationTokenCache;
  // Signs a fresh App JWT each time it's called. Wraps `signAppJwt` so the
  // provider doesn't need the App ID or PEM directly (the factory layer
  // closes over both when constructing this dep).
  signJwt: () => string;
  // The mint function from `installationTokenMinter.ts`. Injectable for
  // tests and so the GHE-server `apiBaseUrl` override sits at one place
  // (the factory layer).
  mint: (args: {
    appJwt: string;
    installationId: number | string;
    permissions?: InstallationPermissions;
    repositoryIds?: number[];
  }) => Promise<MintedInstallationToken>;
  // Override of `Date.now()` for deterministic tests.
  clock?: () => number;
  // Override of the default 5-minute safety margin. Express in milliseconds.
  safetyMarginMs?: number;
}

export interface ProvidedInstallationToken {
  token: string;
  // Absolute instant at which the *cache* will return null for this token.
  // This is the GitHub-supplied `expiresAt` shifted earlier by the safety
  // margin, NOT the underlying GitHub expiry.
  expiresAt: number;
}

const DEFAULT_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export async function getInstallationToken(
  args: GetInstallationTokenArgs,
  deps: GetInstallationTokenDeps,
): Promise<ProvidedInstallationToken> {
  const cacheKey = String(args.installationId);
  const cached = await deps.cache.get(cacheKey);
  if (cached !== null) {
    return { token: cached.token, expiresAt: cached.expiresAt };
  }

  const appJwt = deps.signJwt();
  const minted = await deps.mint({
    appJwt,
    installationId: args.installationId,
    permissions: args.permissions,
    repositoryIds: args.repositoryIds,
  });

  const safetyMarginMs = deps.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  const cacheExpiresAt = minted.expiresAt.getTime() - safetyMarginMs;
  await deps.cache.set(cacheKey, { token: minted.token, expiresAt: cacheExpiresAt });

  return { token: minted.token, expiresAt: cacheExpiresAt };
}
