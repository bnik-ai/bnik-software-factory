import { describe, expect, test } from 'vitest';
import { buildAdminApp } from '../../src/apps/adminApp.js';

describe('buildAdminApp', () => {
  test('GET /admin/health returns 200 + service identifier', async () => {
    const app = buildAdminApp({ version: '1.2.3' });
    const res = await app.request('http://test.local/admin/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string; version: string };
    expect(body).toEqual({ ok: true, service: 'ca-admin', version: '1.2.3' });
  });

  test('GET /admin/install/status returns 503 not_implemented_v0', async () => {
    const app = buildAdminApp();
    const res = await app.request('http://test.local/admin/install/status');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('not_implemented_v0');
    expect(body.detail).toContain('not implemented in this release');
  });

  test('POST /admin/replay returns 503 not_implemented_v0', async () => {
    const app = buildAdminApp();
    const res = await app.request('http://test.local/admin/replay', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  test('version default is 0.0.0 when omitted', async () => {
    const app = buildAdminApp();
    const res = await app.request('http://test.local/admin/health');
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe('0.0.0');
  });
});
