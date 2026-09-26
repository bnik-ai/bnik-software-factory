import { executeIsolated } from '../src/worker/docker.js';
import { CodingSupervisor } from '../src/worker/supervisor.js';
// Invoked only by the disposable worker-container test harness.
import { initialize } from './helpers.js';
import { fixture, source } from './worker-fixtures.js';
if (process.env.FACTORY_TEST_FAULT_INJECTION !== '1')
  throw new Error('explicit_test_mode_required');
const { admin, pool } = await initialize();
const archive = source();
const job = fixture(archive, {
  id: 'controller-crash-fixture',
  fixtureCommand: 'sleep 60',
  tests: [],
});
const supervisor = new CodingSupervisor({
  pool,
  repository: job.repository,
  mode: 'demo',
  image: process.env.FACTORY_TEST_WORKER_IMAGE ?? 'software-factory-worker:development',
  signal: new AbortController().signal,
  queue: { leaseMs: 1000 },
  execute: (options) =>
    executeIsolated({
      ...options,
      onStarted: async (imageId) => {
        await options.onStarted?.(imageId);
        console.log(JSON.stringify({ runId: options.runId, jobId: job.id }));
      },
    }),
});
try {
  await supervisor.submit(job);
  await supervisor.run(job.id, archive);
} finally {
  await pool.end();
  await admin.end();
}
