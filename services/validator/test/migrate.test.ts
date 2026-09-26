import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import type { PgClient, PgPool } from '../src/postgresClient.js';

// Fake pool that records every query and seeds the _migrations rows.
interface FakePool extends PgPool {
  poolQueries: string[];
  clientQueries: string[];
}

function makeFakePool(alreadyApplied: string[] = []): FakePool {
  const poolQueries: string[] = [];
  const clientQueries: string[] = [];
  const client: PgClient = {
    async query(text: string) {
      clientQueries.push(text);
      return { rows: [] as never[], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    poolQueries,
    clientQueries,
    async query(text: string) {
      poolQueries.push(text);
      if (/SELECT filename FROM _migrations/.test(text)) {
        return {
          rows: alreadyApplied.map((filename) => ({ filename })) as never[],
          rowCount: alreadyApplied.length,
        };
      }
      return { rows: [] as never[], rowCount: 0 };
    },
    async connect() {
      return client;
    },
    async end() {},
  };
  return pool as unknown as FakePool;
}

function makeMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-migrate-'));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

describe('runMigrations', () => {
  test('applies *.sql files in sorted (lexical) order', async () => {
    const pool = makeFakePool();
    const dir = makeMigrationsDir({
      '0002_b.sql': 'SELECT 2;',
      '0001_a.sql': 'SELECT 1;',
      '0003_c.sql': 'SELECT 3;',
      'notes.txt': 'ignored',
    });
    const result = await runMigrations(pool, dir);
    expect(result.applied).toEqual(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
    // non-.sql ignored.
    expect(result.applied).not.toContain('notes.txt');
  });

  test('skips already-applied migrations', async () => {
    const pool = makeFakePool(['0001_a.sql']);
    const dir = makeMigrationsDir({
      '0001_a.sql': 'SELECT 1;',
      '0002_b.sql': 'SELECT 2;',
    });
    const result = await runMigrations(pool, dir);
    expect(result.skipped).toEqual(['0001_a.sql']);
    expect(result.applied).toEqual(['0002_b.sql']);
  });

  test('each migration runs inside its own BEGIN/COMMIT transaction', async () => {
    const pool = makeFakePool();
    const dir = makeMigrationsDir({ '0001_a.sql': 'SELECT 1;' });
    await runMigrations(pool, dir);
    // client (transactional) query sequence for the single migration.
    expect(pool.clientQueries[0]).toBe('BEGIN');
    expect(pool.clientQueries[1]).toBe('SELECT 1;');
    expect(pool.clientQueries[2]).toMatch(/INSERT INTO _migrations/);
    expect(pool.clientQueries[3]).toBe('COMMIT');
  });

  test('creates the _migrations table before reading it', async () => {
    const pool = makeFakePool();
    const dir = makeMigrationsDir({ '0001_a.sql': 'SELECT 1;' });
    await runMigrations(pool, dir);
    expect(pool.poolQueries[0]).toMatch(/CREATE TABLE IF NOT EXISTS _migrations/);
    expect(pool.poolQueries[1]).toMatch(/SELECT filename FROM _migrations/);
  });
});
