import { describe, expect, test, vi } from 'vitest';
import { InMemoryInstallationTokenCache } from '../src/installationTokenCache.js';
import {
  InstallationTokenMintError,
  type MintedInstallationToken,
} from '../src/installationTokenMinter.js';
import {
  type GetInstallationTokenDeps,
  getInstallationToken,
} from '../src/installationTokenProvider.js';

const INSTALLATION_ID = 987654;
const APP_JWT = 'eyJhbGciOiJSUzI1NiJ9.signed';
const TOKEN_A = 'ghs_AAA';
const TOKEN_B = 'ghs_BBB';
const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const NOW = 1_700_000_000_000;

function makeMinted(
  token: string,
  expiresAtMs: number,
  overrides: Partial<MintedInstallationToken> = {},
): MintedInstallationToken {
  return {
    token,
    expiresAt: new Date(expiresAtMs),
    permissions: { contents: 'write' },
    repositorySelection: 'selected',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<GetInstallationTokenDeps> = {}): {
  deps: GetInstallationTokenDeps;
  cache: InMemoryInstallationTokenCache;
  signJwt: ReturnType<typeof vi.fn<() => string>>;
  mint: ReturnType<typeof vi.fn>;
} {
  const cache = new InMemoryInstallationTokenCache(() => NOW);
  const signJwt = vi.fn<() => string>(() => APP_JWT);
  const mint = vi.fn(async () => makeMinted(TOKEN_A, NOW + ONE_HOUR_MS));
  return {
    deps: { cache, signJwt, mint, clock: () => NOW, ...overrides },
    cache,
    signJwt,
    mint: mint as GetInstallationTokenDeps['mint'] & ReturnType<typeof vi.fn>,
  };
}

describe('getInstallationToken — cache miss', () => {
  test('signs a JWT, mints, caches with safety-margin-adjusted expiresAt, and returns', async () => {
    const { deps, cache, signJwt, mint } = makeDeps();
    const result = await getInstallationToken({ installationId: INSTALLATION_ID }, deps);

    expect(signJwt).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({
      appJwt: APP_JWT,
      installationId: INSTALLATION_ID,
      permissions: undefined,
      repositoryIds: undefined,
    });
    const expectedCacheExpiry = NOW + ONE_HOUR_MS - FIVE_MIN_MS;
    expect(result).toEqual({ token: TOKEN_A, expiresAt: expectedCacheExpiry });
    expect(cache.size()).toBe(1);
    await expect(cache.get(String(INSTALLATION_ID))).resolves.toEqual({
      token: TOKEN_A,
      expiresAt: expectedCacheExpiry,
    });
  });

  test('forwards permissions and repositoryIds to mint', async () => {
    const { deps, mint } = makeDeps();
    await getInstallationToken(
      {
        installationId: INSTALLATION_ID,
        permissions: { contents: 'write', issues: 'read' },
        repositoryIds: [1, 2, 3],
      },
      deps,
    );
    expect(mint).toHaveBeenCalledWith({
      appJwt: APP_JWT,
      installationId: INSTALLATION_ID,
      permissions: { contents: 'write', issues: 'read' },
      repositoryIds: [1, 2, 3],
    });
  });

  test('respects custom safetyMarginMs', async () => {
    const customMarginMs = 10 * 60 * 1000;
    const { deps } = makeDeps({ safetyMarginMs: customMarginMs });
    const result = await getInstallationToken({ installationId: INSTALLATION_ID }, deps);
    expect(result.expiresAt).toBe(NOW + ONE_HOUR_MS - customMarginMs);
  });

  test('propagates InstallationTokenMintError without writing to the cache', async () => {
    const { deps, cache } = makeDeps({
      mint: vi.fn(async () => {
        throw new InstallationTokenMintError('Bad credentials', {
          status: 401,
          responseBody: '{"message":"Bad credentials"}',
        });
      }),
    });
    await expect(
      getInstallationToken({ installationId: INSTALLATION_ID }, deps),
    ).rejects.toBeInstanceOf(InstallationTokenMintError);
    expect(cache.size()).toBe(0);
  });
});

describe('getInstallationToken — cache hit', () => {
  test('returns the cached token without calling signJwt or mint', async () => {
    const { deps, cache, signJwt, mint } = makeDeps();
    const cachedExpiry = NOW + ONE_HOUR_MS - FIVE_MIN_MS;
    await cache.set(String(INSTALLATION_ID), { token: TOKEN_B, expiresAt: cachedExpiry });

    const result = await getInstallationToken({ installationId: INSTALLATION_ID }, deps);
    expect(result).toEqual({ token: TOKEN_B, expiresAt: cachedExpiry });
    expect(signJwt).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('getInstallationToken — expired cache entry', () => {
  test('signs a JWT, mints a fresh token, overwrites the cache, and returns the fresh token', async () => {
    let nowMs = NOW;
    const cache = new InMemoryInstallationTokenCache(() => nowMs);
    const signJwt = vi.fn<() => string>(() => APP_JWT);
    const mint = vi.fn(async () => makeMinted(TOKEN_B, NOW + 2 * ONE_HOUR_MS));
    const deps: GetInstallationTokenDeps = { cache, signJwt, mint };

    // Seed an entry that will expire as time advances.
    await cache.set(String(INSTALLATION_ID), {
      token: TOKEN_A,
      expiresAt: NOW + 1_000,
    });

    // Advance past the cached expiry.
    nowMs = NOW + 2_000;

    const result = await getInstallationToken({ installationId: INSTALLATION_ID }, deps);
    expect(result.token).toBe(TOKEN_B);
    expect(signJwt).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledTimes(1);
    await expect(cache.get(String(INSTALLATION_ID))).resolves.toMatchObject({ token: TOKEN_B });
  });
});

describe('getInstallationToken — installationId types', () => {
  test('numeric and string installationId yield the same cache key', async () => {
    const { deps, cache } = makeDeps();
    await getInstallationToken({ installationId: INSTALLATION_ID }, deps);
    expect(cache.size()).toBe(1);

    // Second call with the string form of the same ID hits the existing cache entry.
    const {
      deps: secondCallDeps,
      mint: secondMint,
      signJwt: secondSign,
    } = makeDeps({
      cache,
    });
    const result = await getInstallationToken(
      { installationId: String(INSTALLATION_ID) },
      secondCallDeps,
    );
    expect(result.token).toBe(TOKEN_A);
    expect(secondMint).not.toHaveBeenCalled();
    expect(secondSign).not.toHaveBeenCalled();
  });
});
