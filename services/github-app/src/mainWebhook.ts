import { serve } from '@hono/node-server';
import {
  buildApp,
  readWebhookSecretFromEnv,
  resolveAuditLedgerFromEnv,
  resolveEventQueueFromEnv,
} from './app.js';

// Production entrypoint for the `ca-webhook` Container App.
// Spec: docs/design/azure-adapter.md (ca-webhook Container App, port 8080).
// Invariants:
//   - GITHUB_WEBHOOK_SECRET MUST be set; readWebhookSecretFromEnv throws otherwise.
//   - PORT defaults to 8080 (Container Apps expects this for HTTP ingress).
//   - BIND_HOST defaults to 0.0.0.0. Service-specific name (not HOSTNAME) because
//     Docker/K8s/Container Apps inject HOSTNAME as the container/replica name —
//     binding to that would either fail or break loopback healthchecks.
//   - AuditLedger + EventQueue resolved from env: Postgres when POSTGRES_HOST
//     set / Service Bus when SERVICE_BUS_* set, else in-memory for v0 boot + tests.
//   - Graceful shutdown on SIGTERM (Container Apps sends this on revision rollover).

const DEFAULT_PORT = 8080;
const DEFAULT_BIND_HOST = '0.0.0.0';
const SHUTDOWN_TIMEOUT_MS = 25_000;

function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  // Number() rejects trailing junk (`'3000abc'` → NaN) and floats
  // (`'1.5'` → 1.5, then isInteger filters it). parseInt would truncate
  // both and silently start on the prefix.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`PORT env var "${raw}" is not a valid TCP port`);
  }
  return parsed;
}

function resolveBindHost(): string {
  const raw = process.env.BIND_HOST;
  return raw === undefined || raw === '' ? DEFAULT_BIND_HOST : raw;
}

export function startServer(): { close: () => Promise<void> } {
  const webhookSecret = readWebhookSecretFromEnv();
  const { queue: eventQueue, impl: eventQueueImpl } = resolveEventQueueFromEnv();
  const { ledger: auditLedger, impl: auditLedgerImpl } = resolveAuditLedgerFromEnv();
  console.log(`[ca-webhook] eventQueue=${eventQueueImpl} auditLedger=${auditLedgerImpl}`);
  const app = buildApp({ webhookSecret, eventQueue, auditLedger });
  const port = resolvePort();
  const hostname = resolveBindHost();

  const server = serve({ fetch: app.fetch, port, hostname });
  console.log(`[ca-webhook] listening on http://${hostname}:${port}`);

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`shutdown did not complete within ${SHUTDOWN_TIMEOUT_MS}ms`));
      }, SHUTDOWN_TIMEOUT_MS);
      server.close((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`[ca-webhook] received ${signal}, shutting down`);
    close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[ca-webhook] shutdown failed', err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { close };
}

// Bootstrap only when executed directly. Vitest can import this module
// to exercise resolvePort / resolveBindHost / startServer in isolation
// without triggering the listener.
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startServer();
}

export const __test = { resolvePort, resolveBindHost };
