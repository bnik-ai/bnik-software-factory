import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { databaseConfig, secret } from './config.js';
import { createLocalPool, transaction } from './database.js';

const migrations = [
  [
    '0001_audit_ledger',
    new URL('../../validator/migrations/0001_audit_ledger.sql', import.meta.url),
  ],
  ['0002_durable_work', new URL('../migrations/0002_durable_work.sql', import.meta.url)],
  ['0003_worker_runs', new URL('../migrations/0003_worker_runs.sql', import.meta.url)],
  ['0004_task_activations', new URL('../migrations/0004_task_activations.sql', import.meta.url)],
  ['0005_human_merge', new URL('../migrations/0005_human_merge.sql', import.meta.url)],
  ['0006_recovery', new URL('../migrations/0006_recovery.sql', import.meta.url)],
  ['0007_run_evidence', new URL('../migrations/0007_run_evidence.sql', import.meta.url)],
  ['0008_autonomy_policy', new URL('../migrations/0008_autonomy_policy.sql', import.meta.url)],
  ['0009_autonomy_runs', new URL('../migrations/0009_autonomy_runs.sql', import.meta.url)],
  [
    '0010_autonomy_scope_intents',
    new URL('../migrations/0010_autonomy_scope_intents.sql', import.meta.url),
  ],
  ['0011_autonomy_locks', new URL('../migrations/0011_autonomy_locks.sql', import.meta.url)],
] as const;
export function migrationFiles() {
  return migrations.map(([version, path]) => {
    const sql = readFileSync(fileURLToPath(path), 'utf8');
    return {
      version,
      sql,
      sha256: createHash('sha256').update(sql).digest('hex'),
    };
  });
}
export async function checkSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  const rows = await pool.query<{ version: string; sha256: string }>(
    'SELECT version,sha256 FROM factory_schema_migrations ORDER BY version',
  );
  const expected = migrationFiles();
  if (
    rows.rows.length !== expected.length ||
    expected.some(
      (m, i) => rows.rows[i]?.version !== m.version || rows.rows[i]?.sha256 !== m.sha256,
    )
  )
    throw new Error('database_schema_mismatch_run_migrations');
}
/**
 * `controllerPassword` provisions the trusted controller role that writes autonomy
 * state; without it, only the read-only runtime role exists and no autonomy is possible.
 */
export async function migrate(
  pool: Pool,
  runtimePassword: string,
  controllerPassword?: string,
): Promise<void> {
  if (runtimePassword.length < 32) throw new Error('runtime_database_password_too_short');
  if (controllerPassword !== undefined && controllerPassword.length < 32)
    throw new Error('controller_database_password_too_short');
  if (controllerPassword !== undefined && controllerPassword === runtimePassword)
    throw new Error('controller_password_must_differ_from_runtime');
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(6060001)');
    const legacy = await client.query<{
      migrations: string | null;
      audit: string | null;
      deliveries: string | null;
    }>(
      "SELECT to_regclass('factory_schema_migrations') AS migrations,to_regclass('audit_ledger') AS audit,to_regclass('webhook_deliveries') AS deliveries",
    );
    if (!legacy.rows[0]?.migrations && (legacy.rows[0]?.audit || legacy.rows[0]?.deliveries))
      throw new Error('unmanaged_factory_tables_use_a_dedicated_database');
    await client.query(
      'CREATE TABLE IF NOT EXISTS factory_schema_migrations(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
    );
    const applied = await client.query<{ version: string; sha256: string }>(
      'SELECT version,sha256 FROM factory_schema_migrations',
    );
    const files = migrationFiles();
    if (applied.rows.some((row) => !files.some((file) => file.version === row.version)))
      throw new Error('database_schema_newer_than_runtime');
    for (const migration of files) {
      const existing = applied.rows.find((row) => row.version === migration.version);
      if (existing) {
        if (existing.sha256 !== migration.sha256) throw new Error('migration_checksum_mismatch');
      } else {
        await client.query(migration.sql);
        await client.query('INSERT INTO factory_schema_migrations(version,sha256) VALUES($1,$2)', [
          migration.version,
          migration.sha256,
        ]);
      }
    }
    // DDL has no bind-parameter slot for PASSWORD; quote exactly and never log it.
    const ensureRole = async (name: string, password: string) => {
      const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name]);
      const passwordLiteral = `'${password.replaceAll("'", "''")}'`;
      await client.query(
        `${role.rowCount ? 'ALTER' : 'CREATE'} ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${passwordLiteral}`,
      );
    };
    await ensureRole('factory_runtime', runtimePassword);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query('GRANT USAGE ON SCHEMA public TO factory_runtime');
    await client.query('GRANT SELECT ON factory_schema_migrations TO factory_runtime');
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON webhook_deliveries,factory_work,factory_worker_runs,factory_pr_state,factory_dependency_state TO factory_runtime',
    );
    await client.query(
      'GRANT SELECT,INSERT ON audit_ledger,factory_demo_effects,factory_task_activations,factory_pr_pairs,factory_pr_observations,factory_merge_receipts,factory_recovery_actions TO factory_runtime',
    );
    // Read-only: the internet-facing runtime must not forge policy, scopes, approvals or
    // admissions. Revoke first so every migration run restores least privilege.
    const autonomyTables =
      'factory_autonomy_policies,factory_autonomy_control,factory_autonomy_scopes,factory_autonomy_decisions,factory_autonomy_reservations,factory_autonomy_approvals,factory_autonomy_runs';
    await client.query(`REVOKE ALL ON ${autonomyTables} FROM factory_runtime`);
    await client.query(`GRANT SELECT ON ${autonomyTables} TO factory_runtime`);
    // Controller lock rows: no runtime access at all, so the runtime cannot hold them.
    await client.query('REVOKE ALL ON factory_autonomy_locks FROM factory_runtime');
    await client.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO factory_runtime');
    if (controllerPassword !== undefined) {
      // The controller drives the supervisor (runtime grants) and owns autonomy state.
      await ensureRole('factory_controller', controllerPassword);
      await client.query('GRANT USAGE ON SCHEMA public TO factory_controller');
      await client.query('GRANT SELECT ON factory_schema_migrations TO factory_controller');
      await client.query(
        'GRANT SELECT,INSERT,UPDATE ON webhook_deliveries,factory_work,factory_worker_runs,factory_pr_state,factory_dependency_state TO factory_controller',
      );
      await client.query(
        'GRANT SELECT,INSERT ON audit_ledger,factory_demo_effects,factory_task_activations,factory_pr_pairs,factory_pr_observations,factory_merge_receipts,factory_recovery_actions TO factory_controller',
      );
      await client.query(`REVOKE ALL ON ${autonomyTables} FROM factory_controller`);
      await client.query(`GRANT SELECT,INSERT,UPDATE ON ${autonomyTables} TO factory_controller`);
      await client.query(
        'GRANT SELECT,INSERT,UPDATE ON factory_autonomy_locks TO factory_controller',
      );
      await client.query(
        'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO factory_controller',
      );
    }
  });
}
async function main() {
  const pool = createLocalPool(databaseConfig(process.env));
  try {
    await migrate(
      pool,
      secret(process.env, 'FACTORY_DB_PASSWORD'),
      process.env.FACTORY_CONTROLLER_DB_PASSWORD || process.env.FACTORY_CONTROLLER_DB_PASSWORD_FILE
        ? secret(process.env, 'FACTORY_CONTROLLER_DB_PASSWORD')
        : undefined,
    );
    console.log('database_migrations_ready');
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('database_migration_failed');
    process.exitCode = 1;
  });
