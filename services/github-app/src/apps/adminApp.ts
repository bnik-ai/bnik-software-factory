// Spec: docs/design/azure-adapter.md (ca-admin Container App).
// Routes: GET /admin/install/status, GET /admin/health, POST /admin/replay.
// Auth: Microsoft Entra ID via Container Apps built-in authentication
// (Easy Auth). The application code does NOT enforce auth — the platform
// rejects unauthenticated requests before they reach Hono. v0 ships
// install-status and replay as 503 not_implemented_v0 stubs; the real
// routes read the audit_ledger + Postgres tenants table and replay from the
// Service Bus dead-letter queue.

import { Hono } from 'hono';

export interface AdminAppConfig {
  // Service version exposed via /admin/health. Defaults to '0.0.0' (v0
  // boot passes no version).
  version?: string;
}

export function buildAdminApp(config: AdminAppConfig = {}): Hono {
  const version = config.version ?? '0.0.0';
  const app = new Hono();

  app.get('/admin/health', (c) => c.json({ ok: true, service: 'ca-admin', version }));

  app.get('/admin/install/status', (c) =>
    c.json(
      {
        error: 'not_implemented_v0',
        detail:
          'install-status read against audit_ledger + tenants table lands in B7 alongside Postgres mirror DB',
      },
      503,
    ),
  );

  app.post('/admin/replay', (c) =>
    c.json(
      {
        error: 'not_implemented_v0',
        detail: 'dead-letter replay against Service Bus DLQ lands in B7 alongside real SB topology',
      },
      503,
    ),
  );

  return app;
}
