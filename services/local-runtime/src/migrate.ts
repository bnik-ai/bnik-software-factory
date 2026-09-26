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
export async function checkSchema(pool: Pool): Promise<void> {
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
export async function migrate(pool: Pool, runtimePassword: string): Promise<void> {
  if (runtimePassword.length < 32) throw new Error('runtime_database_password_too_short');
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
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname='factory_runtime'");
    const passwordLiteral = `'${runtimePassword.replaceAll("'", "''")}'`;
    // DDL has no bind-parameter slot for PASSWORD; quote exactly and never log it.
    await client.query(
      `${role.rowCount ? 'ALTER' : 'CREATE'} ROLE factory_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${passwordLiteral}`,
    );
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query('GRANT USAGE ON SCHEMA public TO factory_runtime');
    await client.query('GRANT SELECT ON factory_schema_migrations TO factory_runtime');
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON webhook_deliveries,factory_work,factory_worker_runs,factory_pr_state,factory_dependency_state TO factory_runtime',
    );
    await client.query(
      'GRANT SELECT,INSERT ON audit_ledger,factory_demo_effects,factory_task_activations,factory_pr_pairs,factory_pr_observations,factory_merge_receipts TO factory_runtime',
    );
    await client.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO factory_runtime');
  });
}
async function main() {
  const pool = createLocalPool(databaseConfig(process.env));
  try {
    await migrate(pool, secret(process.env, 'FACTORY_DB_PASSWORD'));
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
