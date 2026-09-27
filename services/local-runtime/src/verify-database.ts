import type { Pool } from 'pg';
import { computeRowHash } from '../../validator/src/auditLedger.js';
import { checkSchema } from './migrate.js';

/** Verify stored migration checksums and ledger links in one database snapshot. */
export async function verifyDatabase(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await checkSchema(client);
    const migrations = (
      await client.query<{ version: string; sha256: string }>(
        'SELECT version,sha256 FROM factory_schema_migrations ORDER BY version',
      )
    ).rows;
    let seq = 0;
    let previous: Buffer = Buffer.alloc(32);
    for (;;) {
      const rows = (
        await client.query(
          'SELECT seq,payload_hash,prev_hash,this_hash FROM audit_ledger WHERE seq>$1 ORDER BY seq LIMIT 1000',
          [seq],
        )
      ).rows;
      if (!rows.length) break;
      for (const row of rows) {
        const current = Number(row.seq);
        if (
          !Number.isSafeInteger(current) ||
          current !== seq + 1 ||
          !previous.equals(row.prev_hash) ||
          !computeRowHash({
            seq: current,
            prevHash: row.prev_hash,
            payloadHash: row.payload_hash,
          }).equals(row.this_hash)
        )
          throw new Error('audit_chain_invalid');
        seq = current;
        previous = row.this_hash;
      }
    }
    const counts = (
      await client.query(
        'SELECT (SELECT count(*) FROM factory_work) AS work, (SELECT count(*) FROM factory_demo_effects) AS demo_effects, (SELECT count(*) FROM webhook_deliveries) AS deliveries',
      )
    ).rows[0];
    await client.query('COMMIT');
    return {
      schema: 'verified',
      migrations,
      auditChain: 'verified',
      auditRows: seq,
      auditHead: previous.toString('hex'),
      counts,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
