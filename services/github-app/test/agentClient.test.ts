import { describe, expect, test, vi } from 'vitest';
import { AGENT_PERMISSIONS, buildAgentClient } from '../src/agentClient.js';
import { InMemoryInstallationTokenCache } from '../src/installationTokenCache.js';
import type { MintedInstallationToken } from '../src/installationTokenMinter.js';

const INSTALLATION_ID = 987654;
const TOKEN = 'ghs_AGENT_AAA';
const APP_JWT = 'eyJhbGciOiJSUzI1NiJ9.signed.agent';

function makeMint() {
  return vi.fn(
    async (): Promise<MintedInstallationToken> => ({
      token: TOKEN,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      permissions: AGENT_PERMISSIONS,
      repositorySelection: 'all',
    }),
  );
}

describe('buildAgentClient', () => {
  test('exposes scope=agent and the AGENT_PERMISSIONS constant', () => {
    const cache = new InMemoryInstallationTokenCache();
    const client = buildAgentClient({ cache, signJwt: () => APP_JWT, mint: makeMint() });
    expect(client.scope).toBe('agent');
    expect(client.permissions).toBe(AGENT_PERMISSIONS);
  });

  test('AGENT_PERMISSIONS matches the canonical agent-write table in github-app.md', () => {
    // From docs/design/github-app.md lines 79-89.
    expect(AGENT_PERMISSIONS).toEqual({
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
  });

  test('AGENT_PERMISSIONS does NOT include substrate-only keys (administration, environments, secrets, hooks, organization_administration)', () => {
    expect(AGENT_PERMISSIONS.administration).toBeUndefined();
    expect(AGENT_PERMISSIONS.environments).toBeUndefined();
    expect(AGENT_PERMISSIONS.secrets).toBeUndefined();
    expect(AGENT_PERMISSIONS.repository_hooks).toBeUndefined();
    expect(AGENT_PERMISSIONS.organization_hooks).toBeUndefined();
    expect(AGENT_PERMISSIONS.organization_administration).toBeUndefined();
  });

  test('AGENT_PERMISSIONS is frozen — runtime mutation cannot widen the scope', () => {
    expect(Object.isFrozen(AGENT_PERMISSIONS)).toBe(true);
    expect(() => {
      (AGENT_PERMISSIONS as Record<string, string>).administration = 'write';
    }).toThrow(TypeError);
  });

  test('getToken forwards the agent permissions constant to mint on cache miss', async () => {
    const cache = new InMemoryInstallationTokenCache();
    const mint = makeMint();
    const client = buildAgentClient({ cache, signJwt: () => APP_JWT, mint });
    await client.getToken(INSTALLATION_ID);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({
      appJwt: APP_JWT,
      installationId: INSTALLATION_ID,
      permissions: AGENT_PERMISSIONS,
      repositoryIds: undefined,
    });
  });

  test('getToken returns just the bearer string', async () => {
    const cache = new InMemoryInstallationTokenCache();
    const client = buildAgentClient({ cache, signJwt: () => APP_JWT, mint: makeMint() });
    const token = await client.getToken(INSTALLATION_ID);
    expect(token).toBe(TOKEN);
    expect(typeof token).toBe('string');
  });

  test('getToken on cache hit returns the cached token without minting', async () => {
    const cache = new InMemoryInstallationTokenCache(() => 1_000);
    const mint = makeMint();
    const client = buildAgentClient({ cache, signJwt: () => APP_JWT, mint });
    // Pre-seed the cache at the agent-namespaced key. The factory wraps
    // the user-supplied cache with this prefix so a shared backing cache
    // cannot leak tokens across the substrate/agent scope split.
    await cache.set(`agent:${INSTALLATION_ID}`, { token: 'ghs_CACHED', expiresAt: 10_000 });
    const token = await client.getToken(INSTALLATION_ID);
    expect(token).toBe('ghs_CACHED');
    expect(mint).not.toHaveBeenCalled();
  });
});
