import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Pool } from 'pg';
import { buildApp } from '../../github-app/src/app.js';
import { handleWebhook } from '../../github-app/src/webhook.js';
import { AGENT_ROLES, PostgresDeliveryAcceptor, RAW_QUEUE } from './adapters.js';
import { type RuntimeConfig, databaseConfig, resolveConfig } from './config.js';
import { createLocalPool } from './database.js';
import { GitHubFailure, InstallationClient } from './github/client.js';
import { GitHubIntake, LIVE_EVENTS } from './github/intake.js';
import { HumanMergeGate } from './github/reconcile.js';
import { checkSchema } from './migrate.js';
import { PostgresQueue } from './queue.js';
import { LocalRuntime } from './runtime.js';
import { runtimeDependencies } from './substrate.js';

export function localApp(pool: Pool, config: RuntimeConfig, intake?: GitHubIntake): Hono {
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
  if (config.mode === 'live') {
    const live =
      intake ??
      new GitHubIntake(pool, config, new InstallationClient(config, new AbortController().signal));
    app.post('/webhook', async (c) => {
      const rawBody = Buffer.from(await c.req.arrayBuffer());
      const headers = Object.fromEntries(c.req.raw.headers.entries());
      const verified = handleWebhook({
        headers,
        rawBody,
        secret: config.webhookSecret,
        allowedEvents: LIVE_EVENTS,
      });
      if (verified.status !== 200) return c.json(verified.body, verified.status);
      try {
        const result = await live.accept(
          verified.body.deliveryId,
          verified.body.event,
          rawBody.toString('utf8'),
        );
        return c.json({ ...result, deliveryId: verified.body.deliveryId }, 202);
      } catch (error) {
        if (error instanceof GitHubFailure) return c.json({ ok: false, reason: error.reason }, 403);
        if (error instanceof Error && error.message === 'delivery_key_payload_conflict')
          return c.json({ ok: false, reason: error.message }, 409);
        return c.json({ ok: false, reason: 'intake_unavailable' }, 503);
      }
    });
    app.get('/healthz', (c) => c.json({ status: 'ok' }));
    return app;
  }
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
        for (const queue of [
          'validator',
          'orchestrator',
          'CodingJob',
          'GitHubIntake',
          'HumanMergeGate',
          ...AGENT_ROLES,
        ])
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
  const controller = new AbortController();
  let intake: GitHubIntake | undefined;
  let mergeGate: HumanMergeGate | undefined;
  if (config.mode === 'live') {
    const github = new InstallationClient(config, controller.signal);
    try {
      await github.check();
    } catch (error) {
      await pool.end();
      throw error;
    }
    intake = new GitHubIntake(pool, config, github);
    if (config.mergePolicy) mergeGate = new HumanMergeGate(pool, config, github);
  }
  const runtime = new LocalRuntime(pool, config, runtimeDependencies(config));
  const server = serve({
    fetch: localApp(pool, config, intake).fetch,
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
  const running = Promise.all([
    config.mode === 'demo' ? runtime.run(controller.signal) : undefined,
    intake?.run(controller.signal),
    mergeGate?.run(controller.signal),
  ]);
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
      await intake?.close();
      await mergeGate?.close();
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
  main().catch((error) => {
    console.error(
      error instanceof GitHubFailure
        ? error.reason
        : 'local_runtime_start_failed_check_configuration_and_database',
    );
    process.exitCode = 1;
  });
