import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  TERRAFORM_HMAC_SECRET_ENV,
  TERRAFORM_SIGNATURE_HEADER,
  buildTerraformApp,
  readTerraformHmacSecretFromEnv,
} from '../../src/apps/terraformApp.js';

const TEST_SECRET = 'test-terraform-secret-do-not-use-in-prod';

function sigFor(body: string): string {
  return `sha256=${createHmac('sha256', TEST_SECRET).update(body).digest('hex')}`;
}

describe('buildTerraformApp — public /health', () => {
  test('GET /health → 200 + service identifier', async () => {
    const app = buildTerraformApp({ terraformHmacSecret: TEST_SECRET });
    const res = await app.request('http://test.local/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.service).toBe('ca-terraform');
    expect(body.ok).toBe(true);
  });
});

describe('buildTerraformApp — /terraform/* HMAC enforcement', () => {
  test('POST /terraform/plan without sig → 401', async () => {
    const app = buildTerraformApp({ terraformHmacSecret: TEST_SECRET });
    const res = await app.request('http://test.local/terraform/plan', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  test('POST /terraform/plan with valid sig → 503 not_implemented_v0', async () => {
    const app = buildTerraformApp({ terraformHmacSecret: TEST_SECRET });
    const body = JSON.stringify({ workspace: 'factory/dev/foundation' });
    const res = await app.request('http://test.local/terraform/plan', {
      method: 'POST',
      headers: { [TERRAFORM_SIGNATURE_HEADER]: sigFor(body), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(503);
    const respBody = (await res.json()) as { error: string; detail: string };
    expect(respBody.error).toBe('not_implemented_v0');
    expect(respBody.detail).toContain('not implemented');
  });

  test('POST /terraform/apply with valid sig → 503 describes overlay policy', async () => {
    const app = buildTerraformApp({ terraformHmacSecret: TEST_SECRET });
    const body = '{}';
    const res = await app.request('http://test.local/terraform/apply', {
      method: 'POST',
      headers: { [TERRAFORM_SIGNATURE_HEADER]: sigFor(body), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(503);
    const respBody = (await res.json()) as { detail: string };
    expect(respBody.detail).toContain('deployment overlays');
  });
});

describe('readTerraformHmacSecretFromEnv', () => {
  test('throws when env var is unset', () => {
    const original = process.env[TERRAFORM_HMAC_SECRET_ENV];
    delete process.env[TERRAFORM_HMAC_SECRET_ENV];
    try {
      expect(() => readTerraformHmacSecretFromEnv()).toThrow(/required/);
    } finally {
      if (original !== undefined) process.env[TERRAFORM_HMAC_SECRET_ENV] = original;
    }
  });
});
