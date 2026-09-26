import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, test } from 'vitest';
import {
  type AppendArgs,
  type AuditLedgerRow,
  DuplicateLedgerEntryError,
  verifyChain,
} from '../src/auditLedger.js';
import { PostgresAuditLedgerWriter } from '../src/postgresAuditLedgerWriter.js';
import type { PgClient, PgPool } from '../src/postgresClient.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(join(HERE, '..', 'migrations', '0001_audit_ledger.sql'), 'utf8');

// The migration GRANTs a role pg-mem doesn't model; strip GRANT statements so
// the schema (the part under test) applies cleanly in-memory.
function schemaWithoutGrants(): string {
  return MIGRATION_SQL.split('\n')
    .filter((line) => !line.trimStart().toUpperCase().startsWith('GRANT'))
    .join('\n');
}

// pg-mem-backed pool implementing the PgPool seam. pg-mem has no native
// pg_advisory_xact_lock, so register it as a no-op (the lock's serialization
// effect is exercised by the byte-faithful fake-pool tests; here we only need
// the call to succeed so the append SQL runs end-to-end).
function makeMemPool(): PgPool {
  const db = newDb();
  db.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer],
    returns: DataType.text,
    implementation: () => '',
  });
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as PgPool;
}

function appendArgs(overrides: Partial<AppendArgs> = {}): AppendArgs {
  return {
    deliveryId: overrides.deliveryId ?? 'd-1',
    eventType: 'issues',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: overrides.recordId ?? 'I_record',
    fromState: '__initial__',
    toState: 'proposed',
    verdict: 'accept',
    payloadHash: overrides.payloadHash ?? Buffer.alloc(32, 1),
    receivedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

// Byte-faithful in-memory fake pool that actually stores audit_ledger rows
// and serves the FOR UPDATE chain-tail SELECT. pg-mem mangles bytea columns
// with high bytes (UTF-8 replacement-char round-trip), so it CANNOT be used
// to verify the sha256 hash chain byte-for-byte — this fake preserves
// Buffers exactly, exercising the writer's real chain logic.
function makeChainPool(): PgPool {
  interface StoredRow {
    seq: number;
    delivery_id: string;
    event_type: string;
    actor: string;
    record_type: string;
    record_kind: string | null;
    record_id: string;
    from_state: string | null;
    to_state: string | null;
    verdict: string;
    payload_hash: Buffer;
    prev_hash: Buffer;
    this_hash: Buffer;
    received_at: Date;
    processed_at: Date;
  }
  const rows: StoredRow[] = [];

  const client: PgClient = {
    async query(text: string, values?: readonly unknown[]) {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] as never[], rowCount: 0 };
      }
      if (/FOR UPDATE/.test(text)) {
        const tail = rows[rows.length - 1];
        return {
          rows: (tail === undefined
            ? []
            : [{ this_hash: tail.this_hash, seq: tail.seq }]) as never[],
          rowCount: tail === undefined ? 0 : 1,
        };
      }
      if (/INSERT INTO audit_ledger/.test(text)) {
        const v = values ?? [];
        const deliveryId = v[1] as string;
        if (rows.some((r) => r.delivery_id === deliveryId)) {
          throw Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'audit_ledger_delivery_id_key',
          });
        }
        if (rows.some((r) => r.seq === (v[0] as number))) {
          // A seq collision is NOT a delivery duplicate — it must propagate.
          throw Object.assign(new Error('duplicate seq'), {
            code: '23505',
            constraint: 'audit_ledger_pkey',
          });
        }
        const row: StoredRow = {
          seq: v[0] as number,
          delivery_id: deliveryId,
          event_type: v[2] as string,
          actor: v[3] as string,
          record_type: v[4] as string,
          record_kind: v[5] as string | null,
          record_id: v[6] as string,
          from_state: v[7] as string | null,
          to_state: v[8] as string | null,
          verdict: v[9] as string,
          payload_hash: v[10] as Buffer,
          prev_hash: v[11] as Buffer,
          this_hash: v[12] as Buffer,
          received_at: v[13] as Date,
          processed_at: new Date(),
        };
        rows.push(row);
        return { rows: [row] as never[], rowCount: 1 };
      }
      return { rows: [] as never[], rowCount: 0 };
    },
    release() {},
  };
  return {
    async query() {
      return { rows: [] as never[], rowCount: 0 };
    },
    async connect() {
      return client;
    },
    async end() {},
  } as unknown as PgPool;
}

describe('PostgresAuditLedgerWriter — hash chain (byte-faithful fake pool)', () => {
  test('append builds an intact hash chain over inserted rows (verifyChain)', async () => {
    const writer = new PostgresAuditLedgerWriter(makeChainPool());
    const rows: AuditLedgerRow[] = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push(
        await writer.append(
          appendArgs({ deliveryId: `d-${i}`, payloadHash: Buffer.alloc(32, i + 1) }),
        ),
      );
    }
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    // genesis prevHash is 32 zero bytes; each row links to the prior thisHash.
    const [first, second] = rows;
    expect(first?.prevHash.equals(Buffer.alloc(32))).toBe(true);
    expect(first !== undefined && second?.prevHash.equals(first.thisHash)).toBe(true);
    expect(verifyChain(rows)).toEqual({ ok: true });
  });

  test('duplicate delivery_id (23505 on delivery_id constraint) → DuplicateLedgerEntryError', async () => {
    const writer = new PostgresAuditLedgerWriter(makeChainPool());
    await writer.append(appendArgs({ deliveryId: 'dup' }));
    await expect(writer.append(appendArgs({ deliveryId: 'dup' }))).rejects.toBeInstanceOf(
      DuplicateLedgerEntryError,
    );
  });

  test('seq-collision (23505 on a NON-delivery constraint) propagates, NOT mapped to duplicate', async () => {
    // A unique violation on audit_ledger_pkey (seq) is a chain bug, never an
    // idempotent redelivery. If it were swallowed as a duplicate, a distinct
    // delivery would be ACKed/published with no audit row.
    const pool = makeChainPool();
    const client = await pool.connect();
    const original = client.query.bind(client);
    // Force the next INSERT to collide on seq by pre-seeding a row at seq=1
    // through the same fake (the fake already throws audit_ledger_pkey when a
    // seq repeats). Drive two appends that compute the same seq by stubbing
    // the FOR UPDATE tail read to always report an empty table.
    client.query = (async (text: string, values?: readonly unknown[]) => {
      if (/FOR UPDATE/.test(text)) return { rows: [], rowCount: 0 };
      return original(text, values);
    }) as typeof client.query;
    pool.connect = (async () => client) as typeof pool.connect;
    const writer = new PostgresAuditLedgerWriter(pool);
    await writer.append(appendArgs({ deliveryId: 'a' })); // seq 1
    // Second append also computes seq 1 (stubbed empty tail) → seq collision.
    await expect(writer.append(appendArgs({ deliveryId: 'b' }))).rejects.not.toBeInstanceOf(
      DuplicateLedgerEntryError,
    );
  });
});

describe('PostgresAuditLedgerWriter — against pg-mem', () => {
  async function freshWriter(): Promise<{ pool: PgPool; writer: PostgresAuditLedgerWriter }> {
    const pool = makeMemPool();
    await pool.query(schemaWithoutGrants());
    return { pool, writer: new PostgresAuditLedgerWriter(pool) };
  }

  test('real SQL UNIQUE(delivery_id) constraint rejects a second insert (23505)', async () => {
    // pg-mem enforces the unique constraint but does not populate err.constraint,
    // so the writer cannot map it to DuplicateLedgerEntryError here; the
    // constraint-name-scoped mapping is covered by the byte-faithful fake above.
    // This test confirms the migration's UNIQUE actually fires against real SQL.
    const { pool, writer } = await freshWriter();
    await writer.append(appendArgs({ deliveryId: 'dup' }));
    await expect(writer.append(appendArgs({ deliveryId: 'dup' }))).rejects.toMatchObject({
      code: '23505',
    });
    await pool.end();
  });

  test('getLastTransitionForRecord returns most-recent accept/flag with to_state', async () => {
    const { pool, writer } = await freshWriter();
    await writer.append(appendArgs({ deliveryId: 'a', recordId: 'R1', toState: 'proposed' }));
    await writer.append(appendArgs({ deliveryId: 'b', recordId: 'R1', toState: 'accepted' }));
    // A reject for the same record must NOT win.
    await writer.append(
      appendArgs({ deliveryId: 'c', recordId: 'R1', toState: 'rejected', verdict: 'reject' }),
    );
    const last = await writer.getLastTransitionForRecord('R1');
    expect(last?.toState).toBe('accepted');
    expect(last?.verdict).toBe('accept');

    const none = await writer.getLastTransitionForRecord('R-unknown');
    expect(none).toBeUndefined();
    await pool.end();
  });

  test('flag verdict counts as a committed transition', async () => {
    const { pool, writer } = await freshWriter();
    await writer.append(
      appendArgs({ deliveryId: 'f', recordId: 'R2', toState: 'flagged', verdict: 'flag' }),
    );
    const last = await writer.getLastTransitionForRecord('R2');
    expect(last?.verdict).toBe('flag');
    await pool.end();
  });

  test('getByDeliveryId returns the committed row for a known delivery, else undefined', async () => {
    const { pool, writer } = await freshWriter();
    await writer.append(appendArgs({ deliveryId: 'known', recordId: 'R3' }));
    const found = await writer.getByDeliveryId('known');
    expect(found?.deliveryId).toBe('known');
    expect(found?.recordId).toBe('R3');
    expect(await writer.getByDeliveryId('unseen')).toBeUndefined();
    await pool.end();
  });
});

// Fake pool that records every query so we can assert the FOR UPDATE lock
// query is issued inside the append transaction.
describe('PostgresAuditLedgerWriter — query discipline (fake pool)', () => {
  interface RecordingPool extends PgPool {
    queries: string[];
  }

  function makeRecordingPool(tailRows: Array<{ this_hash: Buffer; seq: number }>): RecordingPool {
    const queries: string[] = [];
    const client: PgClient = {
      async query(text: string) {
        queries.push(text);
        if (/FOR UPDATE/.test(text)) {
          return { rows: tailRows as never[], rowCount: tailRows.length };
        }
        if (/INSERT INTO audit_ledger/.test(text)) {
          return {
            rows: [
              {
                seq: 1,
                delivery_id: 'd',
                event_type: 'issues',
                actor: 'human',
                record_type: 'Issue',
                record_kind: 'Goal',
                record_id: 'R',
                from_state: '__initial__',
                to_state: 'proposed',
                verdict: 'accept',
                payload_hash: Buffer.alloc(32, 1),
                prev_hash: Buffer.alloc(32),
                this_hash: Buffer.alloc(32, 2),
                received_at: new Date(),
                processed_at: new Date(),
              },
            ] as never[],
            rowCount: 1,
          };
        }
        return { rows: [] as never[], rowCount: 0 };
      },
      release() {},
    };
    const pool = {
      queries,
      async query(text: string) {
        queries.push(text);
        return { rows: [] as never[], rowCount: 0 };
      },
      async connect() {
        return client;
      },
      async end() {},
    };
    return pool as unknown as RecordingPool;
  }

  test('append issues BEGIN, advisory lock, SELECT ... FOR UPDATE, INSERT, COMMIT in order', async () => {
    const pool = makeRecordingPool([]);
    const writer = new PostgresAuditLedgerWriter(pool);
    await writer.append(appendArgs());
    expect(pool.queries[0]).toBe('BEGIN');
    expect(pool.queries[1]).toMatch(/pg_advisory_xact_lock/);
    expect(pool.queries[2]).toMatch(/FOR UPDATE/);
    expect(pool.queries[3]).toMatch(/INSERT INTO audit_ledger/);
    expect(pool.queries[4]).toBe('COMMIT');
  });
});
