import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Pool } from 'pg';
import { buildApp } from '../../github-app/src/app.js';
import { AGENT_ROLES, PostgresDeliveryAcceptor, RAW_QUEUE } from './adapters.js';
import { type RuntimeConfig, databaseConfig, resolveConfig } from './config.js';
import { createLocalPool } from './database.js';
import { checkSchema } from './migrate.js';
import { PostgresQueue } from './queue.js';
import { LocalRuntime } from './runtime.js';
import { runtimeDependencies } from './substrate.js';

export function localApp(pool: Pool, config: RuntimeConfig): Hono {
  const app = new Hono();
  app.use('/webhook', bodyLimit({ maxSize: 1_048_576 }));
  app.get('/readyz', async (c) => {
    try {
      await pool.query('SELECT 1');
      return c.json({
        ready: true,
        mode: config.mode,
        liveWorkerEnabled: false,
      });
    } catch {
      return c.json({ ready: false }, 503);
    }
  });
  app.route(
    '/',
    buildApp({
      webhookSecret: config.webhookSecret,
      deliveryAcceptor: new PostgresDeliveryAcceptor(
        pool,
        new PostgresQueue(pool, RAW_QUEUE, config.queue),
        config.repository,
        config.installationId,
      ),
    }),
  );
  return app;
}
async function main() {
  const command = process.argv[2] ?? 'serve';
  if (command === 'status' || command === 'compact') {
    const pool = createLocalPool(databaseConfig(process.env));
    try {
      await checkSchema(pool);
      if (command === 'compact') {
        const days = Number(process.argv[3]);
        let count = 0;
        for (const queue of ['validator', 'orchestrator', ...AGENT_ROLES])
          count += await new PostgresQueue(pool, queue).compactDone(days);
        console.log(JSON.stringify({ compacted: count, retainedDays: days }));
      } else
        console.log(
          JSON.stringify(
            (
              await pool.query(
                'SELECT queue_name,state,count(*)::integer AS count FROM factory_work GROUP BY queue_name,state ORDER BY queue_name,state',
              )
            ).rows,
          ),
        );
    } finally {
      await pool.end();
    }
    return;
  }
  if (command !== 'serve') throw new Error('unknown_runtime_command');
  const config = resolveConfig();
  const pool = createLocalPool(config.database);
  try {
    await checkSchema(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const runtime = new LocalRuntime(pool, config, runtimeDependencies(config));
  const controller = new AbortController();
  const server = serve({
    fetch: localApp(pool, config).fetch,
    hostname: config.host,
    port: config.port,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    await runtime.close();
    await pool.end();
    throw error;
  }
  server.on('error', () => {
    console.error('http_server_failed');
    process.exitCode = 1;
    controller.abort();
  });
  const running = runtime.run(controller.signal);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    controller.abort(); // stop taking work, drain active work while renewing leases
    const timeout = setTimeout(() => {
      void runtime.close();
      if ('closeAllConnections' in server) server.closeAllConnections();
      process.exit(1);
    }, config.shutdownMs);
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await running;
      await runtime.close();
      await pool.end();
      clearTimeout(timeout);
    } catch {
      clearTimeout(timeout);
      console.error('runtime_shutdown_failed');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  console.log(
    JSON.stringify({
      event: 'local_runtime_started',
      mode: config.mode,
      liveWorkerEnabled: false,
    }),
  );
  await running;
  await stop();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('local_runtime_start_failed_check_configuration_and_database');
    process.exitCode = 1;
  });
