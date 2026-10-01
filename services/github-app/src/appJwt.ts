import { createSign } from 'node:crypto';

// Sign a GitHub App JWT (RS256) for the App-to-GitHub auth path.
//
// Per docs/design/github-app.md "Authentication model": the App JWT is
// signed with the App's private PEM (held in Azure Key Vault as
// `sf-app-private-key`) and used for one purpose — calling GitHub's
// `POST /app/installations/{installation_id}/access_tokens` to mint an
// installation-scoped token. The JWT has a 10-minute lifetime per
// GitHub's hard limit; we additionally back-date the `iat` claim by 60
// seconds to absorb clock skew between this container and api.github.com.
//
// This module is intentionally pure: it takes the App ID, the PEM string,
// and an optional `now` for deterministic tests, and returns the encoded
// JWT. It does NOT read the PEM from the environment or Key Vault; the
// caller resolves the secret. It does NOT call the GitHub API; the client
// factories do.
//
// The signature path uses Node's built-in `crypto.createSign('RSA-SHA256')`
// rather than a third-party JWT library, so the package picks up no new
// runtime attack surface. JWT base64url encoding matches RFC 7515.

export interface SignAppJwtArgs {
  // The App ID as a number (or numeric string). Surfaces in the JWT's `iss`
  // claim. Issued by GitHub when the App is registered.
  appId: number | string;
  // PKCS#1 or PKCS#8 PEM-encoded RSA private key. Read from Azure Key Vault
  // by the caller; never read here.
  privateKeyPem: string;
  // Override the current time (in seconds since epoch). Tests inject a
  // deterministic value; production uses the real clock.
  now?: number;
}

// GitHub allows JWTs with `exp - iat <= 10 minutes`; we use exactly 10
// minutes from `iat`. `iat` is back-dated by `IAT_BACKDATE_SECONDS` to
// absorb clock skew between this container and api.github.com. The 60s
// figure matches GitHub's recommendation and the @octokit/auth-app default.
const IAT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 10 * 60;

function base64UrlEncode(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input) : input;
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function signAppJwt(args: SignAppJwtArgs): string {
  const { appId, privateKeyPem } = args;
  const nowSeconds = args.now ?? Math.floor(Date.now() / 1000);
  const iat = nowSeconds - IAT_BACKDATE_SECONDS;
  const exp = nowSeconds + JWT_LIFETIME_SECONDS - IAT_BACKDATE_SECONDS;

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: typeof appId === 'string' ? appId : String(appId) };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  const encodedSignature = base64UrlEncode(signature);

  return `${signingInput}.${encodedSignature}`;
}
