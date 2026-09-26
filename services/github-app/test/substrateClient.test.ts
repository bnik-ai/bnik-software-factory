import { describe, expect, test, vi } from 'vitest';
import { InMemoryInstallationTokenCache } from '../src/installationTokenCache.js';
import type { MintedInstallationToken } from '../src/installationTokenMinter.js';
import { SUBSTRATE_PERMISSIONS, buildSubstrateClient } from '../src/substrateClient.js';

const INSTALLATION_ID = 987654;
const TOKEN = 'ghs_SUBSTRATE_AAA';
const APP_JWT = 'eyJhbGciOiJSUzI1NiJ9.signed.substrate';

function makeMint() {
  return vi.fn(
    async (): Promise<MintedInstallationToken> => ({
      token: TOKEN,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      permissions: SUBSTRATE_PERMISSIONS,
      repositorySelection: 'all',
    }),
  );
}

describe('buildSubstrateClient', () => {
  test('exposes scope=substrate and the SUBSTRATE_PERMISSIONS constant', () => {
    const cache = new InMemoryInstallationTokenCache();
    const client = buildSubstrateClient({ cache, signJwt: () => APP_JWT, mint: makeMint() });
    expect(client.scope).toBe('substrate');
    expect(client.permissions).toBe(SUBSTRATE_PERMISSIONS);
  });

  test('SUBSTRATE_PERMISSIONS matches the canonical substrate-write table in github-app.md', () => {
    // From docs/design/github-app.md lines 64-72.
    expect(SUBSTRATE_PERMISSIONS).toEqual({
      administration: 'write',
      contents: 'write',
      organization_administration: 'write',
      organization_projects: 'admin',
      organization_hooks: 'admin',
      repository_hooks: 'admin',
      environments: 'write',
      secrets: 'write',
    });
  });

  test('SUBSTRATE_PERMISSIONS does NOT include agent-only keys (issues, pull_requests, deployments, releases, statuses, actions, workflows, members)', () => {
    expect(SUBSTRATE_PERMISSIONS.issues).toBeUndefined();
    expect(SUBSTRATE_PERMISSIONS.pull_requests).toBeUndefined();
    expect(SUBSTRATE_PERMISSIONS.deployments).toBeUndefined();
    expect(SUBSTRATE_PERMISSIONS.releases).toBeUndefined();
    expect(SUBSTRATE_PERMISSIONS.statuses).toBeUndefined();
    expect(SUBSTRATE_PERMISSIONS.actions).toBeUndefined();
    expect(SUBSTRATE_PERMISSIONS.workflows).toBeUndefined();
    expect(SUBSTRATE_PERMISSIONS.members).toBeUndefined();
  });

  test('SUBSTRATE_PERMISSIONS is frozen — runtime mutation cannot widen the scope', () => {
    expect(Object.isFrozen(SUBSTRATE_PERMISSIONS)).toBe(true);
    expect(() => {
      (SUBSTRATE_PERMISSIONS as Record<string, string>).contents = 'write';
    }).toThrow(TypeError);
  });

  test('getToken forwards the substrate permissions constant to mint on cache miss', async () => {
    const cache = new InMemoryInstallationTokenCache();
    const mint = makeMint();
    const client = buildSubstrateClient({ cache, signJwt: () => APP_JWT, mint });
    await client.getToken(INSTALLATION_ID);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({
      appJwt: APP_JWT,
      installationId: INSTALLATION_ID,
      permissions: SUBSTRATE_PERMISSIONS,
      repositoryIds: undefined,
    });
  });

  test('getToken returns just the bearer string', async () => {
    const cache = new InMemoryInstallationTokenCache();
    const client = buildSubstrateClient({ cache, signJwt: () => APP_JWT, mint: makeMint() });
    const token = await client.getToken(INSTALLATION_ID);
    expect(token).toBe(TOKEN);
    expect(typeof token).toBe('string');
  });

  test('getToken on cache hit returns the cached token without minting', async () => {
    const cache = new InMemoryInstallationTokenCache(() => 1_000);
    const mint = makeMint();
    const client = buildSubstrateClient({ cache, signJwt: () => APP_JWT, mint });
    // Pre-seed the cache at the substrate-namespaced key. The factory
    // wraps the user-supplied cache with this prefix so a shared backing
    // cache cannot leak tokens across the substrate/agent scope split.
    await cache.set(`substrate:${INSTALLATION_ID}`, { token: 'ghs_CACHED', expiresAt: 10_000 });
    const token = await client.getToken(INSTALLATION_ID);
    expect(token).toBe('ghs_CACHED');
    expect(mint).not.toHaveBeenCalled();
  });
});
