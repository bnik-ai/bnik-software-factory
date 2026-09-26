// Azure Cache for Redis implementation of InstallationTokenCache.
//
// Mirrors InMemoryInstallationTokenCache semantics: `get` returns the cached
// token only while `now < expiresAt` (null otherwise); `set` overwrites with
// a Redis TTL derived from `expiresAt`. Keys are namespaced `inst:<key>`
// per docs/design/github-app.md "Authentication model".

import type { CachedInstallationToken, InstallationTokenCache } from './installationTokenCache.js';

const KEY_PREFIX = 'inst:';

// Minimal subset of ioredis we use, so tests can pass ioredis-mock / a fake.
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

export class RedisInstallationTokenCache implements InstallationTokenCache {
  private readonly client: RedisLike;
  private readonly clock: () => number;

  constructor(client: RedisLike, clock: () => number = () => Date.now()) {
    this.client = client;
    this.clock = clock;
  }

  async get(installationId: string): Promise<CachedInstallationToken | null> {
    const raw = await this.client.get(`${KEY_PREFIX}${installationId}`);
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable entry — treat as a miss rather than throwing into the hot path.
      return null;
    }
    // Shape-validate: a JSON value that parses but has the wrong shape
    // (`null`, `{}`, a stale schema) is still a corrupt entry and must be a
    // miss, not a throw (`null.expiresAt`) or a malformed token
    // (`{token: undefined}`). Redis is an external shared cache, so don't
    // trust its contents.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { token?: unknown }).token !== 'string' ||
      typeof (parsed as { expiresAt?: unknown }).expiresAt !== 'number'
    ) {
      return null;
    }
    const { token, expiresAt } = parsed as CachedInstallationToken;
    if (this.clock() >= expiresAt) {
      return null;
    }
    return { token, expiresAt };
  }

  async set(installationId: string, token: CachedInstallationToken): Promise<void> {
    // Redis EX requires a positive integer; floor the remaining lifetime and
    // clamp to >= 1 so an about-to-expire token still gets written (and is
    // then filtered by the clock check in get).
    const ttlSeconds = Math.max(1, Math.floor((token.expiresAt - this.clock()) / 1000));
    await this.client.set(
      `${KEY_PREFIX}${installationId}`,
      JSON.stringify({ token: token.token, expiresAt: token.expiresAt }),
      'EX',
      ttlSeconds,
    );
  }
}
