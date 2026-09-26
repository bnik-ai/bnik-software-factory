// Invariants:
//   - Tracks applied files in _migrations(filename PRIMARY KEY, applied_at).
//   - Lists migrations/*.sql sorted LEXICALLY (filenames are zero-padded
//     ordinals, so lexical = chronological).
//   - Each not-yet-applied file runs in its OWN transaction: BEGIN → file
//     SQL → INSERT INTO _migrations → COMMIT. Idempotent: re-running skips
//     already-recorded files.
//   - Direct-invocation entrypoint (node/tsx src/migrate.ts) like
//     mainConsumer; importable for tests via runMigrations(pool, dir).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PgPool, createPool, resolvePoolConfig } from './postgresClient.js';

const MIGRATIONS_DIRNAME = 'migrations';

// migrations/ sits beside src/ in the package root.
function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', MIGRATIONS_DIRNAME);
}

function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  pool: PgPool,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<RunMigrationsResult> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       filename text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const alreadyApplied = await pool.query<{ filename: string }>('SELECT filename FROM _migrations');
  const appliedSet = new Set(alreadyApplied.rows.map((row) => row.filename));

  const files = listMigrationFiles(migrationsDir);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of files) {
    if (appliedSet.has(filename)) {
      skipped.push(filename);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    applied.push(filename);
  }

  return { applied, skipped };
}

async function main(): Promise<void> {
  const config = resolvePoolConfig();
  if (config === undefined) {
    throw new Error('migrate: POSTGRES_HOST is unset — nothing to migrate against');
  }
  const pool = createPool({ config });
  try {
    const result = await runMigrations(pool);
    if (result.applied.length === 0) {
      console.log(`[migrate] up to date (${result.skipped.length} migrations already applied)`);
    } else {
      console.log(
        `[migrate] applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`,
      );
    }
  } finally {
    await pool.end();
  }
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().catch((err) => {
    console.error('[migrate] failed', err);
    process.exit(1);
  });
}
