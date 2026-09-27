import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { computeRowHash } from '../../validator/src/auditLedger.js';
import { migrationFiles } from '../src/migrate.js';
import { verifyDatabase } from '../src/verify-database.js';
import { initialize, reset } from './helpers.js';
let admin: Pool;
let pool: Pool;
before(async () => {
  ({ admin, pool } = await initialize());
});
beforeEach(async () => {
  await reset(admin);
});
after(async () => {
  await pool?.end();
  await admin?.end();
});
const zero = Buffer.alloc(32);
async function row(seq: number, prevHash: Buffer = zero, badHash = false) {
  const payloadHash = Buffer.alloc(32, 7);
  const hash = computeRowHash({ seq, prevHash, payloadHash });
  await admin.query(
    `INSERT INTO audit_ledger(seq,delivery_id,event_type,actor,record_type,record_id,verdict,payload_hash,prev_hash,this_hash,received_at)
     VALUES($1,$2,'fixture','fixture','Task','fixture','record-only',$3,$4,$5,now())`,
    [seq, `verification-${seq}`, payloadHash, prevHash, badHash ? zero : hash],
  );
  return hash;
}
test('verification exposes exact migration digests and ledger head; empty ledger has genesis head', async () => {
  const empty = await verifyDatabase(pool);
  assert.equal(empty.auditHead, zero.toString('hex'));
  assert.equal(empty.auditRows, 0);
  assert.deepEqual(
    empty.migrations,
    migrationFiles().map(({ version, sha256 }) => ({ version, sha256 })),
  );
  const first = await row(1);
  const last = await row(2, first);
  const result = await verifyDatabase(pool);
  assert.equal(result.auditRows, 2);
  assert.equal(result.auditHead, last.toString('hex'));
});
test('tampered migration checksum fails closed and a subsequent clean verification succeeds', async () => {
  const first = migrationFiles()[0];
  assert.ok(first);
  await admin.query('UPDATE factory_schema_migrations SET sha256=$1 WHERE version=$2', [
    'tampered',
    first.version,
  ]);
  try {
    await assert.rejects(verifyDatabase(pool), /database_schema_mismatch/);
  } finally {
    await admin.query('UPDATE factory_schema_migrations SET sha256=$1 WHERE version=$2', [
      first.sha256,
      first.version,
    ]);
  }
  await verifyDatabase(pool);
});
test('invalid stored row hash is rejected', async () => {
  await row(1, zero, true);
  await assert.rejects(verifyDatabase(pool), /audit_chain_invalid/);
});
test('internally valid row with a broken predecessor link is rejected', async () => {
  await row(1);
  await row(2, zero);
  await assert.rejects(verifyDatabase(pool), /audit_chain_invalid/);
});
test('a gap in sequence numbers is rejected', async () => {
  const first = await row(1);
  await row(3, first);
  await assert.rejects(verifyDatabase(pool), /audit_chain_invalid/);
});
