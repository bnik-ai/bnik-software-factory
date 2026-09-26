// Validator-local GitHub App installation-token minter. Spec:
// docs/design/github-app.md "Authentication model" (App JWT → installation
// token). Replicates the minimal sign-JWT + mint flow from
// services/agents/src/auth/installationToken.ts rather than importing
// cross-package — the duplicate-by-package precedent (postgresClient) keeps
// each service self-contained, and the validator must NOT depend on the
// agents package (a read-only consumer importing an agent-runtime package
// would invert the dependency direction).
//
// Difference from the agents copy: the validator threads the installation id
// directly from `installationId` — there is no repo→installation lookup hop.
//
// Invariants:
//   - signAppJwt(): RS256 over {iat:now-60, exp:now+540, iss:appId} via
//     node:crypto. iat back-dated 60s for clock skew; exp inside GitHub's
//     10-minute JWT ceiling. No third-party JWT lib.
//   - SECURITY: the App JWT, the PEM, and the installation token MUST NEVER
//     be logged or surface in a thrown error. Errors carry only the
//     installation id + HTTP status, never the secret.
//   - fetch is dependency-injected for tests; CI has no App key and MUST NOT
//     reach api.github.com.

import { createSign } from 'node:crypto';

const GITHUB_API_HOST = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const ACCEPT_HEADER = 'application/vnd.github+json';
const USER_AGENT = 'sfac-validator';

// iat back-dated by 60s to absorb clock skew; exp at iat+600s sits at
// GitHub's 10-minute JWT ceiling (matches the agents + github-app copies).
const IAT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 10 * 60;

function base64UrlEncode(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input) : input;
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Sign a GitHub App JWT (RS256). appId surfaces in `iss`; the PEM signs.
// `now` overridable for deterministic tests.
export function signAppJwt(appId: string, pemKey: string, now?: number): string {
  const nowSeconds = now ?? Math.floor(Date.now() / 1000);
  const iat = nowSeconds - IAT_BACKDATE_SECONDS;
  const exp = nowSeconds + JWT_LIFETIME_SECONDS - IAT_BACKDATE_SECONDS;

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: appId };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload),
  )}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(pemKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export class InstallationTokenError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'InstallationTokenError';
    this.status = status;
  }
}

export interface MintedToken {
  token: string;
  expiresAt: Date;
}

export interface MintDeps {
  fetch: typeof fetch;
  apiBaseUrl?: string;
}

// Mint an installation access token (POST /app/installations/{id}/access_tokens).
export async function mintInstallationToken(
  installationId: number,
  appJwt: string,
  deps: MintDeps,
): Promise<MintedToken> {
  const baseUrl = deps.apiBaseUrl ?? GITHUB_API_HOST;
  const url = `${baseUrl}/app/installations/${installationId}/access_tokens`;
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: {
        Accept: ACCEPT_HEADER,
        Authorization: `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (err) {
    // Never include the JWT; the message field of a fetch error is safe.
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
