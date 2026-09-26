// Installation-token cache contract.
//
// Per docs/design/github-app.md "Authentication model": installation tokens
// from GitHub are valid for 1 hour. We cache them under
// `inst:<installation_id>` with TTL = 50 minutes — a 10-minute safety
// margin under GitHub's expiry so callers don't race a token that GitHub
// rejects mid-request. Production (B7) will swap in an Azure Cache for
// Redis implementation; this PR ships the interface and an in-memory
// implementation used by tests and v0 boot.
//
// The cache exposes two operations: `get` returns the cached token if it
// hasn't expired, `null` otherwise (eviction-at-read — there is no
// background sweeper, so unused entries linger in memory until next
// access). `set` overwrites any existing entry, storing the token bytes
// and the absolute `expiresAt` instant. Callers compute `expiresAt` from
// GitHub's `expires_at` field with the safety margin already subtracted.

export interface CachedInstallationToken {
  token: string;
  // Absolute expiry instant in milliseconds since epoch. The cache returns
  // the entry only while `now < expiresAt`. Callers compute this from
  // GitHub's `expires_at` field minus the safety margin.
  expiresAt: number;
}

export interface InstallationTokenCache {
  get(installationId: string): Promise<CachedInstallationToken | null>;
  set(installationId: string, token: CachedInstallationToken): Promise<void>;
}

export class InMemoryInstallationTokenCache implements InstallationTokenCache {
  private readonly tokensByInstallationId = new Map<string, CachedInstallationToken>();
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  async get(installationId: string): Promise<CachedInstallationToken | null> {
    const entry = this.tokensByInstallationId.get(installationId);
    if (entry === undefined) {
      return null;
    }
    if (this.clock() >= entry.expiresAt) {
      this.tokensByInstallationId.delete(installationId);
      return null;
    }
    return entry;
  }

  async set(installationId: string, token: CachedInstallationToken): Promise<void> {
    this.tokensByInstallationId.set(installationId, { ...token });
  }

  // Test-only inspection helper — not part of the InstallationTokenCache contract.
  size(): number {
    return this.tokensByInstallationId.size;
  }
}
