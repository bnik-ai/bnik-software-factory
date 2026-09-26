import { describe, expect, test } from 'vitest';
import { __test } from '../src/mainWebhook.js';

const { resolvePort, resolveBindHost } = __test;

// Spec: docs/design/github-app.md route table (POST /webhook on ca-webhook).
// Spec: docs/design/azure-adapter.md ca-webhook ingress (port 8080 default).
// Tests exercise the pure env-resolution helpers without starting a listener.

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('resolvePort', () => {
  test('returns 8080 when PORT is unset', () => {
    expect(withEnv({ PORT: undefined }, resolvePort)).toBe(8080);
  });

  test('returns 8080 when PORT is the empty string', () => {
    expect(withEnv({ PORT: '' }, resolvePort)).toBe(8080);
  });

  test('returns the parsed integer when PORT is a valid number', () => {
    expect(withEnv({ PORT: '3000' }, resolvePort)).toBe(3000);
  });

  test('throws when PORT is not a number', () => {
    expect(() => withEnv({ PORT: 'eighty-eighty' }, resolvePort)).toThrow(/not a valid TCP port/);
  });

  test('throws when PORT is zero or negative', () => {
    expect(() => withEnv({ PORT: '0' }, resolvePort)).toThrow(/not a valid TCP port/);
    expect(() => withEnv({ PORT: '-1' }, resolvePort)).toThrow(/not a valid TCP port/);
  });

  test('throws when PORT is above the TCP range', () => {
    expect(() => withEnv({ PORT: '65536' }, resolvePort)).toThrow(/not a valid TCP port/);
  });

  test('throws when PORT has a trailing non-numeric suffix (no parseInt truncation)', () => {
    expect(() => withEnv({ PORT: '3000abc' }, resolvePort)).toThrow(/not a valid TCP port/);
  });

  test('throws when PORT is a float', () => {
    expect(() => withEnv({ PORT: '1.5' }, resolvePort)).toThrow(/not a valid TCP port/);
    expect(() => withEnv({ PORT: '8080.0' }, resolvePort)).not.toThrow();
  });

  test('throws when PORT is whitespace-padded with non-numeric characters', () => {
    expect(() => withEnv({ PORT: '8080 extra' }, resolvePort)).toThrow(/not a valid TCP port/);
  });
});

describe('resolveBindHost', () => {
  // Note: read from BIND_HOST, NOT HOSTNAME. Docker/K8s/Container Apps inject
  // HOSTNAME as the container/replica name; reading that would either fail to
  // bind or break the loopback healthcheck.
  test('returns 0.0.0.0 when BIND_HOST is unset', () => {
    expect(withEnv({ BIND_HOST: undefined }, resolveBindHost)).toBe('0.0.0.0');
  });

  test('returns 0.0.0.0 when BIND_HOST is the empty string', () => {
    expect(withEnv({ BIND_HOST: '' }, resolveBindHost)).toBe('0.0.0.0');
  });

  test('returns the supplied BIND_HOST when set', () => {
    expect(withEnv({ BIND_HOST: '127.0.0.1' }, resolveBindHost)).toBe('127.0.0.1');
  });

  test('does NOT read HOSTNAME (which is injected by Docker/K8s/Container Apps as the container name)', () => {
    // Injected HOSTNAME like a container name must be ignored entirely.
    expect(
      withEnv({ BIND_HOST: undefined, HOSTNAME: 'ca-webhook-revabc-123' }, resolveBindHost),
    ).toBe('0.0.0.0');
  });
});
