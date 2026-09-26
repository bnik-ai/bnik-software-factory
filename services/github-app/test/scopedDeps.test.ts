import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildAgentDeps } from '../src/agentDeps.js';
import { GITHUB_APP_ID_ENV, GITHUB_APP_PRIVATE_KEY_ENV } from '../src/githubAppAuthBase.js';
import { InMemoryInstallationTokenCache } from '../src/installationTokenCache.js';
import { buildSubstrateDeps } from '../src/substrateDeps.js';

// A real RSA key so signAppJwt actually signs (it uses crypto.createSign).
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TEST_APP_ID = '3947948';

function mintResponse(): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          token: 'ghs_INSTALLATION_SECRET',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          permissions: {},
          repository_selection: 'all',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
  ) as unknown as typeof fetch;
}

describe('scoped GitHub App dep builders', () => {
  const saved = {
    id: process.env[GITHUB_APP_ID_ENV],
    pem: process.env[GITHUB_APP_PRIVATE_KEY_ENV],
  };
  afterEach(() => {
    if (saved.id === undefined) delete process.env[GITHUB_APP_ID_ENV];
    else process.env[GITHUB_APP_ID_ENV] = saved.id;
    if (saved.pem === undefined) delete process.env[GITHUB_APP_PRIVATE_KEY_ENV];
    else process.env[GITHUB_APP_PRIVATE_KEY_ENV] = saved.pem;
    vi.restoreAllMocks();
  });

  test('buildAgentDeps throws when GITHUB_APP_ID is missing', () => {
    delete process.env[GITHUB_APP_ID_ENV];
    process.env[GITHUB_APP_PRIVATE_KEY_ENV] = TEST_PEM;
    expect(() => buildAgentDeps()).toThrow(/GITHUB_APP_ID/);
  });

  test('buildSubstrateDeps throws when GITHUB_APP_PRIVATE_KEY is missing', () => {
    process.env[GITHUB_APP_ID_ENV] = TEST_APP_ID;
    delete process.env[GITHUB_APP_PRIVATE_KEY_ENV];
    expect(() => buildSubstrateDeps()).toThrow(/GITHUB_APP_PRIVATE_KEY/);
  });

  test('buildAgentDeps builds an agent-scoped client when both env vars are set', () => {
    process.env[GITHUB_APP_ID_ENV] = TEST_APP_ID;
    process.env[GITHUB_APP_PRIVATE_KEY_ENV] = TEST_PEM;
    const deps = buildAgentDeps({ cache: new InMemoryInstallationTokenCache() });
    expect(deps.agentClient.scope).toBe('agent');
  });

  test('buildSubstrateDeps builds a substrate-scoped client when both env vars are set', () => {
    process.env[GITHUB_APP_ID_ENV] = TEST_APP_ID;
    process.env[GITHUB_APP_PRIVATE_KEY_ENV] = TEST_PEM;
    const deps = buildSubstrateDeps({ cache: new InMemoryInstallationTokenCache() });
    expect(deps.substrateClient.scope).toBe('substrate');
  });

  test('the agent client mints + caches an installation token through the wired deps', async () => {
    const fetchImpl = mintResponse();
    const deps = buildAgentDeps({
      appId: TEST_APP_ID,
      privateKeyPem: TEST_PEM,
      cache: new InMemoryInstallationTokenCache(),
      fetchImpl,
    });
    const token = await deps.agentClient.getToken(42);
    expect(token).toBe('ghs_INSTALLATION_SECRET');
    // Second call should hit the cache, not re-mint.
    await deps.agentClient.getToken(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('neither scoped builder logs the PEM or a minted token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = mintResponse();

    const agent = buildAgentDeps({
      appId: TEST_APP_ID,
      privateKeyPem: TEST_PEM,
      cache: new InMemoryInstallationTokenCache(),
      fetchImpl,
    });
    const substrate = buildSubstrateDeps({
      appId: TEST_APP_ID,
      privateKeyPem: TEST_PEM,
      cache: new InMemoryInstallationTokenCache(),
      fetchImpl,
    });
    await agent.agentClient.getToken(7);
    await substrate.substrateClient.getToken(7);

    const allLogged = [...logSpy.mock.calls, ...errSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
    expect(allLogged).not.toContain('ghs_INSTALLATION_SECRET');
    expect(allLogged).not.toContain('PRIVATE KEY');
    expect(allLogged).not.toContain(TEST_PEM);
  });
});
