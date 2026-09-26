// Shared Hono-on-node bootstrap helpers used by every ca-* main*.ts.
// Spec: docs/design/azure-adapter.md (Container Apps HTTP ingress: port
// 8080, BIND_HOST 0.0.0.0, SIGTERM-driven shutdown on revision rollover).
// Invariants:
//   - PORT defaults to 8080 (Container Apps ingress contract).
//   - BIND_HOST defaults to 0.0.0.0. Service-specific name (not HOSTNAME)
//     because Docker/K8s/Container Apps inject HOSTNAME as the
//     container/replica name — binding to that would either fail or break
//     loopback healthchecks.
//   - Graceful shutdown on SIGTERM with a 25s timeout. Container Apps
//     SIGTERMs on revision rollover; if shutdown exceeds the timeout the
//     close() promise rejects and the supervisor SIGKILLs.
//   - resolvePort uses Number(), not parseInt(), to reject trailing junk
//     (`'3000abc'` → NaN) and floats (`'1.5'` → fails isInteger). parseInt
//     would silently truncate both.

import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Env } from 'hono/types';

export const DEFAULT_PORT = 8080;
export const DEFAULT_BIND_HOST = '0.0.0.0';
export const SHUTDOWN_TIMEOUT_MS = 25_000;

export function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`PORT env var "${raw}" is not a valid TCP port`);
  }
  return parsed;
}

export function resolveBindHost(): string {
  const raw = process.env.BIND_HOST;
  return raw === undefined || raw === '' ? DEFAULT_BIND_HOST : raw;
}

export interface StartedServer {
  close(): Promise<void>;
}

// Boots a Hono app on PORT/BIND_HOST with graceful SIGTERM/SIGINT shutdown.
// The `name` is the log prefix and identifies the Container App in logs
// (e.g. 'ca-webhook', 'ca-agent', 'ca-admin', 'ca-terraform'). Generic
// over Hono's Env so apps with custom Variables / Bindings (typed
// c.set/c.var) compose without losing their generics through this seam.
export function startHonoServer<E extends Env>(args: {
  name: string;
  app: Hono<E>;
}): StartedServer {
  const port = resolvePort();
  const hostname = resolveBindHost();

  const server = serve({ fetch: args.app.fetch, port, hostname });
  console.log(`[${args.name}] listening on http://${hostname}:${port}`);

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
    console.log(`[${args.name}] received ${signal}, shutting down`);
    close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[${args.name}] shutdown failed`, err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { close };
}

export const __test = { resolvePort, resolveBindHost };
