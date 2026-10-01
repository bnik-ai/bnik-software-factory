import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  AGENT_HMAC_SECRET_ENV,
  AGENT_SIGNATURE_HEADER,
  buildAgentApp,
  readAgentHmacSecretFromEnv,
} from '../../src/apps/agentApp.js';

const TEST_SECRET = 'test-agent-secret-do-not-use-in-prod';

function sigFor(body: string): string {
  return `sha256=${createHmac('sha256', TEST_SECRET).update(body).digest('hex')}`;
}

describe('buildAgentApp — public /health route (no auth)', () => {
  test('GET /health returns 200 + service identifier without signature', async () => {
    const app = buildAgentApp({ agentHmacSecret: TEST_SECRET, version: '1.2.3' });
    const res = await app.request('http://test.local/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string; version: string };
    expect(body).toEqual({ ok: true, service: 'ca-agent', version: '1.2.3' });
  });
});

describe('buildAgentApp — /agent/* HMAC enforcement', () => {
  test('POST /agent/tool/github/:verb without signature → 401', async () => {
    const app = buildAgentApp({ agentHmacSecret: TEST_SECRET });
    const res = await app.request('http://test.local/agent/tool/github/applyLabel', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('unauthorized');
    expect(body.reason).toBe('missing_header');
  });

  test('POST /agent/tool/github/:verb with mismatched signature → 401 mismatch', async () => {
    const app = buildAgentApp({ agentHmacSecret: TEST_SECRET });
    const body = JSON.stringify({ recordId: 'I_x', label: 'status:accepted' });
    const wrongSig = sigFor('different-body');
    const res = await app.request('http://test.local/agent/tool/github/applyLabel', {
      method: 'POST',
      headers: { [AGENT_SIGNATURE_HEADER]: wrongSig, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
    const respBody = (await res.json()) as { reason: string };
    expect(respBody.reason).toBe('mismatch');
  });

  test('POST /agent/tool/github/:verb with valid sig → 503 echoes verb in detail', async () => {
    const app = buildAgentApp({ agentHmacSecret: TEST_SECRET });
    const body = '{}';
    const res = await app.request('http://test.local/agent/tool/github/applyLabel', {
      method: 'POST',
      headers: { [AGENT_SIGNATURE_HEADER]: sigFor(body), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(503);
    const respBody = (await res.json()) as { detail: string };
    expect(respBody.detail).toContain("'applyLabel'");
  });

  test('Per-tool verb param is preserved as-is (multi-segment verbs allowed)', async () => {
    const app = buildAgentApp({ agentHmacSecret: TEST_SECRET });
    const body = '{}';
    const res = await app.request('http://test.local/agent/tool/github/issue.applyLabel', {
      method: 'POST',
      headers: { [AGENT_SIGNATURE_HEADER]: sigFor(body), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(503);
    const respBody = (await res.json()) as { detail: string };
    expect(respBody.detail).toContain("'issue.applyLabel'");
  });
});

describe('buildAgentApp — /agent/dispatch route removed per ADR 0011', () => {
  test('POST /agent/dispatch → 404 (route no longer registered)', async () => {
    const app = buildAgentApp({ agentHmacSecret: TEST_SECRET });
    const body = '{}';
    const res = await app.request('http://test.local/agent/dispatch', {
      method: 'POST',
      headers: { [AGENT_SIGNATURE_HEADER]: sigFor(body), 'content-type': 'application/json' },
      body,
    });
    // After ADR 0011, the orchestrator no longer HTTP-dispatches to ca-agent;
    // it enqueues per-role Service Bus messages. The /agent/dispatch route
    // that used to receive those HTTP dispatches is removed from the surface.
    expect(res.status).toBe(404);
  });
});

describe('readAgentHmacSecretFromEnv', () => {
  test('throws when env var is unset', () => {
    const original = process.env[AGENT_HMAC_SECRET_ENV];
    delete process.env[AGENT_HMAC_SECRET_ENV];
    try {
      expect(() => readAgentHmacSecretFromEnv()).toThrow(/required/);
    } finally {
      if (original !== undefined) process.env[AGENT_HMAC_SECRET_ENV] = original;
    }
  });

  test('returns the env value when set', () => {
    const original = process.env[AGENT_HMAC_SECRET_ENV];
    process.env[AGENT_HMAC_SECRET_ENV] = 'x';
    try {
      expect(readAgentHmacSecretFromEnv()).toBe('x');
    } finally {
      if (original === undefined) {
        delete process.env[AGENT_HMAC_SECRET_ENV];
      } else {
        process.env[AGENT_HMAC_SECRET_ENV] = original;
      }
    }
  });
});
