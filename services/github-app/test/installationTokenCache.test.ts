import { describe, expect, test } from 'vitest';
import { InMemoryInstallationTokenCache } from '../src/installationTokenCache.js';

describe('InMemoryInstallationTokenCache', () => {
  test('get on a missing installation_id returns null', async () => {
    const cache = new InMemoryInstallationTokenCache();
    await expect(cache.get('missing')).resolves.toBeNull();
  });

  test('set then get returns the cached token', async () => {
    const cache = new InMemoryInstallationTokenCache(() => 1_000);
    await cache.set('inst-1', { token: 'ghs_AAA', expiresAt: 5_000 });
    await expect(cache.get('inst-1')).resolves.toEqual({ token: 'ghs_AAA', expiresAt: 5_000 });
  });

  test('get returns null when the current time is at or past expiresAt and evicts the entry', async () => {
    let now = 1_000;
    const cache = new InMemoryInstallationTokenCache(() => now);
    await cache.set('inst-1', { token: 'ghs_AAA', expiresAt: 5_000 });
    now = 5_000;
    await expect(cache.get('inst-1')).resolves.toBeNull();
    expect(cache.size()).toBe(0);
  });

  test('get returns the entry one millisecond before expiresAt', async () => {
    let now = 1_000;
    const cache = new InMemoryInstallationTokenCache(() => now);
    await cache.set('inst-1', { token: 'ghs_AAA', expiresAt: 5_000 });
    now = 4_999;
    await expect(cache.get('inst-1')).resolves.toEqual({ token: 'ghs_AAA', expiresAt: 5_000 });
  });

  test('set overwrites an existing entry', async () => {
    const cache = new InMemoryInstallationTokenCache(() => 1_000);
    await cache.set('inst-1', { token: 'ghs_OLD', expiresAt: 5_000 });
    await cache.set('inst-1', { token: 'ghs_NEW', expiresAt: 9_000 });
    await expect(cache.get('inst-1')).resolves.toEqual({ token: 'ghs_NEW', expiresAt: 9_000 });
    expect(cache.size()).toBe(1);
  });

  test('different installation_ids are isolated', async () => {
    const cache = new InMemoryInstallationTokenCache(() => 1_000);
    await cache.set('inst-1', { token: 'ghs_AAA', expiresAt: 5_000 });
    await cache.set('inst-2', { token: 'ghs_BBB', expiresAt: 5_000 });
    await expect(cache.get('inst-1')).resolves.toMatchObject({ token: 'ghs_AAA' });
    await expect(cache.get('inst-2')).resolves.toMatchObject({ token: 'ghs_BBB' });
    expect(cache.size()).toBe(2);
  });

  test('set stores a copy of the token object so external mutation does NOT affect the cache', async () => {
    const cache = new InMemoryInstallationTokenCache(() => 1_000);
    const token = { token: 'ghs_AAA', expiresAt: 5_000 };
    await cache.set('inst-1', token);
    token.token = 'ghs_MUTATED';
    await expect(cache.get('inst-1')).resolves.toEqual({ token: 'ghs_AAA', expiresAt: 5_000 });
  });
});
