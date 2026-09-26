// Mint an installation access token by calling GitHub's
// `POST /app/installations/{installation_id}/access_tokens` endpoint with
// an App JWT (signed by `signAppJwt`) and optional per-token scope
// downgrade (`permissions`, `repository_ids`). See
// docs/design/github-app.md "Authentication model" — substrateClient()
// and agentClient() factories (PR6+) request different `permissions`
// against the same App JWT so a compromised honest code path cannot
// accidentally mint a substrate-write token.
//
// This module owns ONE concern: the HTTP exchange. It does NOT sign the
// JWT (PR4's `signAppJwt` does), does NOT cache the result (PR4's
// `InstallationTokenCache` does), and does NOT decide which permissions
// to request (PR6's factories do). Tests inject a mocked `fetch`; the
// real implementation passes Node 20's global `fetch`.

const GITHUB_API_HOST = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const ACCEPT_HEADER = 'application/vnd.github+json';

// GitHub's permission shape. The set of valid permission keys is large
// and version-dependent (per docs.github.com/en/rest/apps/apps); we keep
// the type as a string-keyed map so the factory layer in PR6 can request
// any documented permission without this layer needing updates.
export type InstallationPermission = 'read' | 'write' | 'admin';
export type InstallationPermissions = Record<string, InstallationPermission>;

export interface MintInstallationTokenArgs {
  appJwt: string;
  installationId: number | string;
  // Optional per-token permission downgrade. Omit to inherit the App's
  // full installed permission set.
  permissions?: InstallationPermissions;
  // Optional per-token repository scope (subset of the installation's
  // accessible repos). Omit to inherit the installation's full repo scope.
  repositoryIds?: number[];
}

export interface MintInstallationTokenDeps {
  // Test seam. Real callers pass Node 20's global `fetch`.
  fetch: typeof fetch;
  // Optional override of api.github.com (e.g. for GitHub Enterprise Server).
  apiBaseUrl?: string;
}

export interface MintedInstallationToken {
  token: string;
  expiresAt: Date;
  // GitHub's response includes the granted permissions and repo scope so
  // the caller can verify it actually got what it asked for.
  permissions: InstallationPermissions;
  repositorySelection: 'all' | 'selected';
}

// Errors carry the response status (or `undefined` for network failures)
// so callers can decide whether to retry. The body string is included
// for diagnostics; we deliberately do NOT include the JWT.
export class InstallationTokenMintError extends Error {
  readonly status: number | undefined;
  readonly responseBody: string | undefined;
  constructor(message: string, opts: { status?: number; responseBody?: string }) {
    super(message);
    this.name = 'InstallationTokenMintError';
    this.status = opts.status;
    this.responseBody = opts.responseBody;
  }
}

export async function mintInstallationToken(
  args: MintInstallationTokenArgs,
  deps: MintInstallationTokenDeps,
): Promise<MintedInstallationToken> {
  const baseUrl = deps.apiBaseUrl ?? GITHUB_API_HOST;
  const url = `${baseUrl}/app/installations/${args.installationId}/access_tokens`;

  const requestBody: { permissions?: InstallationPermissions; repository_ids?: number[] } = {};
  if (args.permissions !== undefined) {
    requestBody.permissions = args.permissions;
  }
  if (args.repositoryIds !== undefined) {
    requestBody.repository_ids = args.repositoryIds;
  }

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: {
        Accept: ACCEPT_HEADER,
        Authorization: `Bearer ${args.appJwt}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new InstallationTokenMintError(
      `Network failure calling GitHub installation-token mint endpoint: ${(err as Error).message}`,
      {},
    );
  }

  if (response.status !== 201) {
    const responseBody = await safeReadBody(response);
    throw new InstallationTokenMintError(
      `GitHub installation-token mint failed with status ${response.status}`,
      { status: response.status, responseBody },
    );
  }

  const parsed = (await response.json()) as {
    token: string;
    expires_at: string;
    permissions: InstallationPermissions;
    repository_selection: 'all' | 'selected';
  };

  return {
    token: parsed.token,
    expiresAt: new Date(parsed.expires_at),
    permissions: parsed.permissions,
    repositorySelection: parsed.repository_selection,
  };
}

async function safeReadBody(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
