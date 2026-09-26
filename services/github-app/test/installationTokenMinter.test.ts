import { describe, expect, test, vi } from 'vitest';
import {
  InstallationTokenMintError,
  type MintInstallationTokenArgs,
  type MintInstallationTokenDeps,
  mintInstallationToken,
} from '../src/installationTokenMinter.js';

const TEST_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.signature';
const INSTALLATION_ID = 987654;
const EXPIRES_AT_ISO = '2026-05-29T17:00:00Z';
const TOKEN = 'ghs_AAAAAAAA1234567890';

interface FetchCallRecord {
  url: string;
  init: RequestInit | undefined;
}

function makeFetchMock(impl: (call: FetchCallRecord) => Response | Promise<Response>) {
  const calls: FetchCallRecord[] = [];
  const fetchMock = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const record = { url, init };
      calls.push(record);
      return impl(record);
    },
  );
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function makeArgs(overrides: Partial<MintInstallationTokenArgs> = {}): MintInstallationTokenArgs {
  return {
    appJwt: TEST_JWT,
    installationId: INSTALLATION_ID,
    ...overrides,
  };
}

function makeDeps(
  fetchImpl: (call: FetchCallRecord) => Response | Promise<Response>,
  overrides: Partial<MintInstallationTokenDeps> = {},
): MintInstallationTokenDeps & { calls: FetchCallRecord[] } {
  const { fetch: fetchMock, calls } = makeFetchMock(fetchImpl);
  return { fetch: fetchMock, ...overrides, calls };
}

describe('mintInstallationToken — happy path', () => {
  test('201 response returns token, expiresAt as Date, permissions, repositorySelection', async () => {
    const deps = makeDeps(() =>
      jsonResponse(201, {
        token: TOKEN,
        expires_at: EXPIRES_AT_ISO,
        permissions: { contents: 'write', issues: 'read' },
        repository_selection: 'selected',
      }),
    );
    const result = await mintInstallationToken(makeArgs(), deps);
    expect(result.token).toBe(TOKEN);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.toISOString()).toBe(new Date(EXPIRES_AT_ISO).toISOString());
    expect(result.permissions).toEqual({ contents: 'write', issues: 'read' });
    expect(result.repositorySelection).toBe('selected');
  });

  test('targets the correct URL on api.github.com by default', async () => {
    const deps = makeDeps(() =>
      jsonResponse(201, {
        token: TOKEN,
        expires_at: EXPIRES_AT_ISO,
        permissions: {},
        repository_selection: 'all',
      }),
    );
    await mintInstallationToken(makeArgs(), deps);
    expect(deps.calls[0]?.url).toBe(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    );
  });

  test('respects apiBaseUrl override (e.g. GitHub Enterprise Server)', async () => {
    const deps = makeDeps(
      () =>
        jsonResponse(201, {
          token: TOKEN,
          expires_at: EXPIRES_AT_ISO,
          permissions: {},
          repository_selection: 'all',
        }),
      { apiBaseUrl: 'https://ghe.example.com/api/v3' },
    );
    await mintInstallationToken(makeArgs(), deps);
    expect(deps.calls[0]?.url).toBe(
      `https://ghe.example.com/api/v3/app/installations/${INSTALLATION_ID}/access_tokens`,
    );
  });

  test('sets Bearer Authorization with the supplied App JWT, Accept, and X-GitHub-Api-Version headers', async () => {
    const deps = makeDeps(() =>
      jsonResponse(201, {
        token: TOKEN,
        expires_at: EXPIRES_AT_ISO,
        permissions: {},
        repository_selection: 'all',
      }),
    );
    await mintInstallationToken(makeArgs(), deps);
    const headers = new Headers(deps.calls[0]?.init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${TEST_JWT}`);
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
    expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  test('omits permissions and repository_ids from the body when not requested', async () => {
    const deps = makeDeps(() =>
      jsonResponse(201, {
        token: TOKEN,
        expires_at: EXPIRES_AT_ISO,
        permissions: {},
        repository_selection: 'all',
      }),
    );
    await mintInstallationToken(makeArgs(), deps);
    expect(deps.calls[0]?.init?.body).toBe('{}');
  });

  test('forwards permissions and repository_ids when supplied', async () => {
    const deps = makeDeps(() =>
      jsonResponse(201, {
        token: TOKEN,
        expires_at: EXPIRES_AT_ISO,
        permissions: { contents: 'write' },
        repository_selection: 'selected',
      }),
    );
    await mintInstallationToken(
      makeArgs({
        permissions: { contents: 'write', issues: 'read' },
        repositoryIds: [1, 2, 3],
      }),
      deps,
    );
    const body = JSON.parse(String(deps.calls[0]?.init?.body));
    expect(body).toEqual({
      permissions: { contents: 'write', issues: 'read' },
      repository_ids: [1, 2, 3],
    });
  });
});

describe('mintInstallationToken — error mapping', () => {
  test('401 throws InstallationTokenMintError with status 401 and response body', async () => {
    const deps = makeDeps(() => jsonResponse(401, { message: 'Bad credentials' }));
    await expect(mintInstallationToken(makeArgs(), deps)).rejects.toMatchObject({
      name: 'InstallationTokenMintError',
      status: 401,
      responseBody: '{"message":"Bad credentials"}',
    });
  });

  test('404 throws InstallationTokenMintError with status 404', async () => {
    const deps = makeDeps(() => jsonResponse(404, { message: 'Not Found' }));
    await expect(mintInstallationToken(makeArgs(), deps)).rejects.toMatchObject({
      status: 404,
    });
  });

  test('422 throws InstallationTokenMintError with status 422', async () => {
    const deps = makeDeps(() =>
      jsonResponse(422, { message: 'Validation Failed', errors: [{ field: 'permissions' }] }),
    );
    await expect(mintInstallationToken(makeArgs(), deps)).rejects.toMatchObject({
      status: 422,
    });
  });

  test('503 throws InstallationTokenMintError with status 503', async () => {
    const deps = makeDeps(() => textResponse(503, 'Service Unavailable'));
    await expect(mintInstallationToken(makeArgs(), deps)).rejects.toMatchObject({
      status: 503,
      responseBody: 'Service Unavailable',
    });
  });

  test('network error throws InstallationTokenMintError with status undefined', async () => {
    const failingFetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;
    const deps = { fetch: failingFetch };
    await expect(mintInstallationToken(makeArgs(), deps)).rejects.toMatchObject({
      name: 'InstallationTokenMintError',
      status: undefined,
    });
    await expect(mintInstallationToken(makeArgs(), deps)).rejects.toBeInstanceOf(
      InstallationTokenMintError,
    );
  });

  test('error message does NOT include the App JWT in any field', async () => {
    const deps = makeDeps(() => jsonResponse(401, { message: 'Bad credentials' }));
    try {
      await mintInstallationToken(makeArgs(), deps);
    } catch (err) {
      const e = err as InstallationTokenMintError;
      expect(e.message).not.toContain(TEST_JWT);
      expect(e.responseBody ?? '').not.toContain(TEST_JWT);
    }
  });
});
