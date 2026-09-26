import RedisMock from 'ioredis-mock';
import { describe, expect, test } from 'vitest';
import { RedisInstallationTokenCache, type RedisLike } from '../src/redisInstallationTokenCache.js';

// ioredis-mock implements the GET/SET (with EX) surface RedisLike needs.
function newClient(): RedisLike {
  return new RedisMock() as unknown as RedisLike;
}

describe('RedisInstallationTokenCache', () => {
  test('get on a missing key returns null', async () => {
    const cache = new RedisInstallationTokenCache(newClient());
    await expect(cache.get('missing')).resolves.toBeNull();
  });

  test('set then get returns the cached token', async () => {
    const cache = new RedisInstallationTokenCache(newClient(), () => 1_000);
    await cache.set('inst-1', { token: 'ghs_AAA', expiresAt: 5_000 });
    await expect(cache.get('inst-1')).resolves.toEqual({ token: 'ghs_AAA', expiresAt: 5_000 });
  });

  test('namespaces keys under inst:', async () => {
    const client = new RedisMock();
    const cache = new RedisInstallationTokenCache(client as unknown as RedisLike, () => 1_000);
    await cache.set('agent:7', { token: 'ghs_X', expiresAt: 60_000 });
    const raw = await client.get('inst:agent:7');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ token: 'ghs_X', expiresAt: 60_000 });
  });

  test('get returns null at or past expiresAt', async () => {
    let now = 1_000;
    const cache = new RedisInstallationTokenCache(newClient(), () => now);
    await cache.set('inst-1', { token: 'ghs_AAA', expiresAt: 5_000 });
    now = 5_000;
    await expect(cache.get('inst-1')).resolves.toBeNull();
  });

  test('get returns the entry one millisecond before expiresAt', async () => {
    let now = 1_000;
    const cache = new RedisInstallationTokenCache(newClient(), () => now);
    await cache.set('inst-1', { token: 'ghs_AAA', expiresAt: 5_000 });
    now = 4_999;
    await expect(cache.get('inst-1')).resolves.toEqual({ token: 'ghs_AAA', expiresAt: 5_000 });
  });

  test('computes EX TTL as floor((expiresAt - now)/1000)', async () => {
    const captured: Array<{ key: string; mode: string; ttl: number }> = [];
    const fake: RedisLike = {
      async get() {
        return null;
      },
      async set(key, _value, mode, ttlSeconds) {
        captured.push({ key, mode, ttl: ttlSeconds });
        return 'OK';
      },
    };
    const cache = new RedisInstallationTokenCache(fake, () => 1_000);
    // 7_400 - 1_000 = 6_400ms → floor 6s
    await cache.set('inst-1', { token: 'ghs_AAA', expiresAt: 7_400 });
    expect(captured[0]).toEqual({ key: 'inst:inst-1', mode: 'EX', ttl: 6 });
  });

  test('clamps TTL to a minimum of 1 second for an about-to-expire token', async () => {
    const captured: number[] = [];
    const fake: RedisLike = {
      async get() {
        return null;
      },
      async set(_key, _value, _mode, ttlSeconds) {
        captured.push(ttlSeconds);
        return 'OK';
      },
    };
    const cache = new RedisInstallationTokenCache(fake, () => 1_000);
    await cache.set('inst-1', { token: 'ghs_AAA', expiresAt: 1_100 }); // 100ms → floor 0 → clamp 1
    expect(captured[0]).toBe(1);
  });

  test('treats an unparseable cached value as a miss', async () => {
    const fake: RedisLike = {
      async get() {
        return 'not-json{';
      },
      async set() {
        return 'OK';
      },
    };
    const cache = new RedisInstallationTokenCache(fake);
    await expect(cache.get('inst-1')).resolves.toBeNull();
  });

  test.each([
    ['null', 'null'],
    ['empty object', '{}'],
    ['missing token', JSON.stringify({ expiresAt: 9_999_999 })],
    ['missing expiresAt', JSON.stringify({ token: 'ghs_X' })],
    ['non-string token', JSON.stringify({ token: 42, expiresAt: 9_999_999 })],
    ['non-numeric expiresAt', JSON.stringify({ token: 'ghs_X', expiresAt: 'soon' })],
    ['array', '[]'],
  ])('treats malformed-but-JSON value (%s) as a miss without throwing', async (_label, stored) => {
    const fake: RedisLike = {
      async get() {
        return stored;
      },
      async set() {
        return 'OK';
      },
    };
    const cache = new RedisInstallationTokenCache(fake, () => 1_000);
    await expect(cache.get('inst-1')).resolves.toBeNull();
  });
});
