import { describe, expect, test } from 'vitest';
import {
  createTokenProvider,
  mintInstallationToken,
  resolveInstallationId,
  signAppJwt,
} from '../../src/auth/installationToken.js';

// A 2048-bit RSA key generated for tests only (not a real App key). Used to
// verify signAppJwt produces a valid RS256 JWT shape.
import { generateKeyPairSync } from 'node:crypto';

const { privateKey: TEST_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeFetch(
  responder: (call: RecordedCall) => { status?: number; json?: unknown; text?: string },
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const r = responder(call);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

describe('signAppJwt', () => {
  test('produces a three-part RS256 JWT with iat back-dated and iss=appId', () => {
    const now = 1_700_000_000;
    const jwt = signAppJwt('12345', TEST_PEM, now);
    const [headerPart, payloadPart] = jwt.split('.');
    expect(jwt.split('.')).toHaveLength(3);
    expect(headerPart).toBeDefined();
    expect(payloadPart).toBeDefined();

    const header = decodeJwtPart(headerPart ?? '');
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');

    const payload = decodeJwtPart(payloadPart ?? '');
    expect(payload.iss).toBe('12345');
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 600 - 60);
  });

  test('numeric appId is stringified into iss', () => {
    const jwt = signAppJwt(999, TEST_PEM, 1_700_000_000);
    expect(decodeJwtPart(jwt.split('.')[1] ?? '').iss).toBe('999');
  });
});

describe('resolveInstallationId', () => {
  test('GETs the repo installation endpoint with the App JWT bearer and returns .id', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ json: { id: 4242 } }));
    const id = await resolveInstallationId('example-org', 'SF', 'app.jwt.value', {
      fetch: fetchImpl,
    });
    expect(id).toBe(4242);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/example-org/SF/installation');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.Authorization).toBe('Bearer app.jwt.value');
  });

  test('non-ok status throws without leaking the JWT', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 404, text: 'not found' }));
    await expect(
      resolveInstallationId('o', 'r', 'secret.jwt', { fetch: fetchImpl }),
    ).rejects.toThrow(/installation_lookup_failed:o\/r:status=404/);
  });
});

describe('mintInstallationToken', () => {
  test('POSTs the access_tokens endpoint and returns token + expiresAt', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 201,
      json: { token: 'ghs_TESTTOKEN', expires_at: '2026-06-03T09:00:00Z' },
    }));
    const minted = await mintInstallationToken(4242, 'app.jwt', { fetch: fetchImpl });
    expect(minted.token).toBe('ghs_TESTTOKEN');
    expect(minted.expiresAt.toISOString()).toBe('2026-06-03T09:00:00.000Z');
    expect(calls[0]?.url).toBe('https://api.github.com/app/installations/4242/access_tokens');
    expect(calls[0]?.method).toBe('POST');
  });

  test('non-201 throws without leaking the JWT', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 403, text: 'forbidden' }));
    await expect(
      mintInstallationToken(1, 'super.secret.jwt', { fetch: fetchImpl }),
    ).rejects.toThrow(/token_mint_failed:installation=1:status=403/);
  });
});

describe('createTokenProvider', () => {
  const ENV = { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: TEST_PEM };

  test('throws when required env is missing', () => {
    expect(() => createTokenProvider({})).toThrow(/GITHUB_APP_ID/);
    expect(() => createTokenProvider({ GITHUB_APP_ID: '1' })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
  });

  test('end-to-end: signs JWT, resolves installation, mints, returns token', async () => {
    const now = 1_700_000_000_000;
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith('/installation')) return { json: { id: 77 } };
      return {
        status: 201,
        json: { token: 'ghs_REALONE', expires_at: new Date(now + 3_600_000).toISOString() },
      };
    });
    const getToken = createTokenProvider(ENV, { fetch: fetchImpl, clock: () => now });
    const token = await getToken('example-org', 'SF');
    expect(token).toBe('ghs_REALONE');
    // installation lookup + mint = 2 calls.
    expect(calls).toHaveLength(2);
  });

  test('caches per-repo until the safety margin, then re-mints', async () => {
    let now = 1_700_000_000_000;
    let mintCount = 0;
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith('/installation')) return { json: { id: 77 } };
      mintCount += 1;
      return {
        status: 201,
        json: {
          token: `ghs_TOKEN_${mintCount}`,
          expires_at: new Date(now + 3_600_000).toISOString(),
        },
      };
    });
    const getToken = createTokenProvider(ENV, { fetch: fetchImpl, clock: () => now });

    const first = await getToken('example-org', 'SF');
    const cached = await getToken('example-org', 'SF');
    expect(first).toBe('ghs_TOKEN_1');
    expect(cached).toBe('ghs_TOKEN_1'); // cache hit, no re-mint
    expect(mintCount).toBe(1);

    // A different repo is a different cache key.
    await getToken('example-org', 'Other');
    expect(mintCount).toBe(2);

    // Advance past the GitHub expiry minus the 5-min margin → re-mint.
    now += 3_600_000; // 1h later, well past (1h − 5m)
    const refreshed = await getToken('example-org', 'SF');
    expect(refreshed).toBe('ghs_TOKEN_3');
    expect(mintCount).toBe(3);
  });

  test('the minted token never appears in a thrown error', async () => {
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith('/installation')) return { json: { id: 77 } };
      // Mint fails — assert the error carries status, not any secret.
      return { status: 500, text: 'ghs_SHOULD_NOT_LEAK internal error' };
    });
    const getToken = createTokenProvider(ENV, { fetch: fetchImpl });
    await expect(getToken('o', 'r')).rejects.toThrow(/token_mint_failed/);
    await expect(getToken('o', 'r')).rejects.not.toThrow(/ghs_SHOULD_NOT_LEAK/);
  });
});
