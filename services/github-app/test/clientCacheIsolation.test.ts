import { describe, expect, test, vi } from 'vitest';
import { AGENT_PERMISSIONS, buildAgentClient } from '../src/agentClient.js';
import { InMemoryInstallationTokenCache } from '../src/installationTokenCache.js';
import type { MintedInstallationToken } from '../src/installationTokenMinter.js';
import { SUBSTRATE_PERMISSIONS, buildSubstrateClient } from '../src/substrateClient.js';

// PR #21 rev0 → rev1 Codex P1 finding: when both factories are configured
// with the same backing cache instance, the rev0 implementation would let
// the second factory's `getToken` hit the first factory's cached token
// because both used the bare installation_id as the cache key. The fix
// namespaces each factory's cache keys (`substrate:<id>` vs `agent:<id>`)
// so a shared backing cache is safe. These tests pin that property.

const INSTALLATION_ID = 987654;
const APP_JWT_SUBSTRATE = 'eyJhbGciOiJSUzI1NiJ9.signed.substrate';
const APP_JWT_AGENT = 'eyJhbGciOiJSUzI1NiJ9.signed.agent';
const SUBSTRATE_TOKEN = 'ghs_SUBSTRATE_AAA';
const AGENT_TOKEN = 'ghs_AGENT_BBB';

describe('cross-factory cache isolation', () => {
  test('shared backing cache: substrate token does NOT leak to the agent path', async () => {
    const sharedCache = new InMemoryInstallationTokenCache();

    const substrateMint = vi.fn(
      async (): Promise<MintedInstallationToken> => ({
        token: SUBSTRATE_TOKEN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        permissions: SUBSTRATE_PERMISSIONS,
        repositorySelection: 'all',
      }),
    );
    const agentMint = vi.fn(
      async (): Promise<MintedInstallationToken> => ({
        token: AGENT_TOKEN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        permissions: AGENT_PERMISSIONS,
        repositorySelection: 'all',
      }),
    );

    const substrate = buildSubstrateClient({
      cache: sharedCache,
      signJwt: () => APP_JWT_SUBSTRATE,
      mint: substrateMint,
    });
    const agent = buildAgentClient({
      cache: sharedCache,
      signJwt: () => APP_JWT_AGENT,
      mint: agentMint,
    });

    // Substrate runs first → mints a substrate-scoped token, caches under `substrate:<id>`.
    const substrateToken = await substrate.getToken(INSTALLATION_ID);
    expect(substrateToken).toBe(SUBSTRATE_TOKEN);
    expect(substrateMint).toHaveBeenCalledTimes(1);

    // Agent runs second with the SAME backing cache. If the cache key were
    // the bare installation_id (rev0 bug), agent.getToken would return the
    // substrate token without minting. With the rev1 namespacing fix, agent
    // sees a cache miss and mints its own agent-scoped token.
    const agentToken = await agent.getToken(INSTALLATION_ID);
    expect(agentToken).toBe(AGENT_TOKEN);
    expect(agentMint).toHaveBeenCalledTimes(1);
    expect(agentToken).not.toBe(substrateToken);

    // Two distinct cached entries from one shared cache.
    expect(sharedCache.size()).toBe(2);
  });

  test('shared backing cache: subsequent same-scope call hits the namespaced entry', async () => {
    const sharedCache = new InMemoryInstallationTokenCache();
    const substrateMint = vi.fn(
      async (): Promise<MintedInstallationToken> => ({
        token: SUBSTRATE_TOKEN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        permissions: SUBSTRATE_PERMISSIONS,
        repositorySelection: 'all',
      }),
    );
    const agentMint = vi.fn(
      async (): Promise<MintedInstallationToken> => ({
        token: AGENT_TOKEN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        permissions: AGENT_PERMISSIONS,
        repositorySelection: 'all',
      }),
    );
    const substrate = buildSubstrateClient({
      cache: sharedCache,
      signJwt: () => APP_JWT_SUBSTRATE,
      mint: substrateMint,
    });
    const agent = buildAgentClient({
      cache: sharedCache,
      signJwt: () => APP_JWT_AGENT,
      mint: agentMint,
    });

    await substrate.getToken(INSTALLATION_ID);
    await agent.getToken(INSTALLATION_ID);
    expect(substrateMint).toHaveBeenCalledTimes(1);
    expect(agentMint).toHaveBeenCalledTimes(1);

    // Second call from each factory must hit its own cached entry (no remint).
    const substrateSecondToken = await substrate.getToken(INSTALLATION_ID);
    const agentSecondToken = await agent.getToken(INSTALLATION_ID);
    expect(substrateSecondToken).toBe(SUBSTRATE_TOKEN);
    expect(agentSecondToken).toBe(AGENT_TOKEN);
    expect(substrateMint).toHaveBeenCalledTimes(1);
    expect(agentMint).toHaveBeenCalledTimes(1);
  });
});
