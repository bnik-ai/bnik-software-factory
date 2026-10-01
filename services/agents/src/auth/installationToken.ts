// Agents-local GitHub App installation-token provider. Spec:
// docs/design/github-app.md "Authentication model" (App JWT →
// installation token). Replicates the minimal flow from
// services/github-app/src/{appJwt,installationTokenMinter}.ts rather than
// importing cross-package — the duplicate-by-package precedent (postgresClient)
// keeps each service self-contained until a shared workspace package lands.
// Invariants:
//   - signAppJwt(): RS256 over {iat:now-60, exp:now+540, iss:appId} via
//     node:crypto. iat back-dated 60s for clock skew; exp at +540s sits
//     inside GitHub's 10-minute JWT ceiling. No third-party JWT lib.
//   - getToken(owner, repo) resolves the installation via the repo lookup
//     (GET /repos/{owner}/{repo}/installation) — installation_id is NOT
//     threaded from the webhook. It then mints an
//     installation access token and caches it per-repo in-process with a
//     5-minute safety margin before the GitHub expiry.
//   - SECURITY: the App JWT, the PEM, and the installation token MUST NEVER
//     be logged or surface in a thrown error. Errors carry only the repo
//     slug + HTTP status, never the secret.
//   - fetch is dependency-injected for tests; CI has no App key and MUST
//     NOT reach api.github.com.

import { createSign } from 'node:crypto';

const GITHUB_API_HOST = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const ACCEPT_HEADER = 'application/vnd.github+json';
const USER_AGENT = 'sfac-agent';

// iat back-dated by 60s to absorb clock skew; exp at iat+600s sits at
// GitHub's 10-minute JWT ceiling (matches the github-app package's appJwt).
const IAT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 10 * 60;

// Cache the token until 5 minutes before GitHub's expiry so an in-flight
// downstream git/API call can't have it expire mid-request.
const DEFAULT_SAFETY_MARGIN_MS = 5 * 60 * 1000;

function base64UrlEncode(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input) : input;
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Sign a GitHub App JWT (RS256). appId surfaces in `iss`; the PEM signs.
// `now` overridable for deterministic tests.
export function signAppJwt(appId: string | number, pemKey: string, now?: number): string {
  const nowSeconds = now ?? Math.floor(Date.now() / 1000);
  const iat = nowSeconds - IAT_BACKDATE_SECONDS;
  const exp = nowSeconds + JWT_LIFETIME_SECONDS - IAT_BACKDATE_SECONDS;

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: typeof appId === 'string' ? appId : String(appId) };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload),
  )}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(pemKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function authHeaders(bearer: string): Record<string, string> {
  return {
    Accept: ACCEPT_HEADER,
    Authorization: `Bearer ${bearer}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
  };
}

export class InstallationTokenError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'InstallationTokenError';
    this.status = status;
  }
}

// Resolve the installation id for a repo. installation_id is NOT taken from
// the dispatch message; we look it up via the repo endpoint authenticated
// with the App JWT.
export async function resolveInstallationId(
  owner: string,
  repo: string,
  appJwt: string,
  deps: { fetch: typeof fetch; apiBaseUrl?: string },
): Promise<number> {
  const baseUrl = deps.apiBaseUrl ?? GITHUB_API_HOST;
  const url = `${baseUrl}/repos/${owner}/${repo}/installation`;
  let response: Response;
  try {
    response = await deps.fetch(url, { method: 'GET', headers: authHeaders(appJwt) });
  } catch (err) {
    // Never include the JWT; the message field of a fetch error is safe.
    throw new InstallationTokenError(
      `installation_lookup_network_error:${owner}/${repo}:${(err as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new InstallationTokenError(
      `installation_lookup_failed:${owner}/${repo}:status=${response.status}`,
      response.status,
    );
  }
  const json = (await response.json()) as { id?: number };
  if (typeof json.id !== 'number') {
    throw new InstallationTokenError(`installation_lookup_no_id:${owner}/${repo}`);
  }
  return json.id;
}

export interface MintedToken {
  token: string;
  expiresAt: Date;
}

// Mint an installation access token (POST /app/installations/{id}/access_tokens).
export async function mintInstallationToken(
  installationId: number | string,
  appJwt: string,
  deps: { fetch: typeof fetch; apiBaseUrl?: string },
): Promise<MintedToken> {
  const baseUrl = deps.apiBaseUrl ?? GITHUB_API_HOST;
  const url = `${baseUrl}/app/installations/${installationId}/access_tokens`;
  let response: Response;
  try {
    response = await deps.fetch(url, { method: 'POST', headers: authHeaders(appJwt), body: '{}' });
  } catch (err) {
    throw new InstallationTokenError(
      `token_mint_network_error:installation=${installationId}:${(err as Error).message}`,
    );
  }
  // GitHub returns 201 on mint.
  if (response.status !== 201) {
    throw new InstallationTokenError(
      `token_mint_failed:installation=${installationId}:status=${response.status}`,
      response.status,
    );
  }
  const json = (await response.json()) as { token?: string; expires_at?: string };
  if (typeof json.token !== 'string' || typeof json.expires_at !== 'string') {
    throw new InstallationTokenError(`token_mint_malformed:installation=${installationId}`);
  }
  return { token: json.token, expiresAt: new Date(json.expires_at) };
}

export interface TokenProviderEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

export interface TokenProviderDeps {
  // Injected for tests; defaults to global fetch (native Node 20+).
  fetch?: typeof fetch;
  // api.github.com override (GHES).
  apiBaseUrl?: string;
  // Date.now() override for deterministic cache tests.
  clock?: () => number;
  // Override of the 5-minute safety margin (ms).
  safetyMarginMs?: number;
}

interface CacheEntry {
  token: string;
  // Instant (ms) at which the cache stops returning this token — GitHub's
  // expiry shifted EARLIER by the safety margin.
  expiresAt: number;
}

// A function the tools call: getToken(owner, repo) → installation token.
export type RepoTokenProvider = (owner: string, repo: string) => Promise<string>;

// Build a per-repo-caching installation-token provider from env. Returns a
// getToken(owner, repo) the tool layer curries with its own owner/repo.
export function createTokenProvider(
  env: TokenProviderEnv,
  deps: TokenProviderDeps = {},
): RepoTokenProvider {
  const appId = env.GITHUB_APP_ID;
  const pemKey = env.GITHUB_APP_PRIVATE_KEY;
  if (appId === undefined || appId === '' || pemKey === undefined || pemKey === '') {
    throw new Error('createTokenProvider requires GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY');
  }
  const fetchImpl = deps.fetch ?? fetch;
  const clock = deps.clock ?? Date.now;
  const safetyMarginMs = deps.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  const fetchDeps = {
    fetch: fetchImpl,
    ...(deps.apiBaseUrl !== undefined ? { apiBaseUrl: deps.apiBaseUrl } : {}),
  };

  const cache = new Map<string, CacheEntry>();

  return async (owner: string, repo: string): Promise<string> => {
    const cacheKey = `${owner}/${repo}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > clock()) {
      return cached.token;
    }

    // Sign a fresh App JWT per mint (cheap; never cached/logged).
    const appJwt = signAppJwt(appId, pemKey, Math.floor(clock() / 1000));
    const installationId = await resolveInstallationId(owner, repo, appJwt, fetchDeps);
    const minted = await mintInstallationToken(installationId, appJwt, fetchDeps);

    const expiresAt = minted.expiresAt.getTime() - safetyMarginMs;
    cache.set(cacheKey, { token: minted.token, expiresAt });
    return minted.token;
  };
}
