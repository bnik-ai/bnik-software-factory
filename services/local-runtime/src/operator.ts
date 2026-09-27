import { computeRowHash } from '../../validator/src/auditLedger.js';
import { databaseConfig } from './config.js';
import { createLocalPool } from './database.js';
import { checkSchema } from './migrate.js';

const pool = createLocalPool(databaseConfig(process.env));
try {
  await checkSchema(pool);
  if (process.argv[2] === 'demo-status') {
    console.log(
      JSON.stringify(
        (
          await pool.query(
            'SELECT work_id,agent,result FROM factory_demo_effects ORDER BY work_id DESC LIMIT 20',
          )
        ).rows,
      ),
    );
  } else if (process.argv[2] === 'verify-database') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
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
      console.log(
        JSON.stringify({
          schema: 'verified',
          auditChain: 'verified',
          auditRows: seq,
          counts,
        }),
      );
    } finally {
      client.release();
    }
  } else throw new Error('unknown_operator_command');
} finally {
  await pool.end();
}
