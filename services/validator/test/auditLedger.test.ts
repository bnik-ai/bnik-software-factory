import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  DuplicateLedgerEntryError,
  InMemoryAuditLedgerWriter,
  computeRowHash,
  verifyChain,
} from '../src/auditLedger.js';

// Spec: docs/design/validator-bot.md "Audit ledger" section.
// Hash rule: this_hash = sha256(payload_hash || prev_hash || seq_8byte_be).
// Genesis prev_hash = 32 zero bytes.

const GENESIS = Buffer.alloc(32);

function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

function fixedClock(start = 1_700_000_000_000): () => Date {
  let now = start;
  return () => {
    const d = new Date(now);
    now += 1000;
    return d;
  };
}

const baseArgs = {
  deliveryId: '7f3d0c4e-1234-1234-1234-abcdef012345',
  eventType: 'validator:accept',
  actor: 'agent:BuildAgent',
  recordType: 'Issue',
  recordKind: 'Task',
  recordId: 'I_kwAOA',
  fromState: 'ready',
  toState: 'in_progress',
  verdict: 'accept' as const,
  receivedAt: new Date('2026-05-29T18:00:00Z'),
};

describe('InMemoryAuditLedgerWriter — first row (genesis)', () => {
  test('first append has seq=1 and prev_hash = 32 zero bytes', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const row = await writer.append({ ...baseArgs, payloadHash: sha256('payload-1') });
    expect(row.seq).toBe(1);
    expect(row.prevHash.equals(GENESIS)).toBe(true);
  });

  test('this_hash matches sha256(payload_hash || prev_hash || seq_8byte_be)', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const payloadHash = sha256('payload-1');
    const row = await writer.append({ ...baseArgs, payloadHash });
    const expected = computeRowHash({ payloadHash, prevHash: GENESIS, seq: 1 });
    expect(row.thisHash.equals(expected)).toBe(true);
  });
});

describe('InMemoryAuditLedgerWriter — chained subsequent rows', () => {
  test('second append uses first row this_hash as prev_hash and seq=2', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const first = await writer.append({
      ...baseArgs,
      deliveryId: 'd-1',
      payloadHash: sha256('p1'),
    });
    const second = await writer.append({
      ...baseArgs,
      deliveryId: 'd-2',
      payloadHash: sha256('p2'),
    });
    expect(second.seq).toBe(2);
    expect(second.prevHash.equals(first.thisHash)).toBe(true);
  });

  test('seq is monotonic across many appends', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const seqs: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const row = await writer.append({
        ...baseArgs,
        deliveryId: `d-${i}`,
        payloadHash: sha256(`p-${i}`),
      });
      seqs.push(row.seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('changing the payload changes this_hash (chain reflects content)', async () => {
    const writer1 = new InMemoryAuditLedgerWriter(fixedClock());
    const writer2 = new InMemoryAuditLedgerWriter(fixedClock());
    const a = await writer1.append({ ...baseArgs, payloadHash: sha256('payload-A') });
    const b = await writer2.append({ ...baseArgs, payloadHash: sha256('payload-B') });
    expect(a.thisHash.equals(b.thisHash)).toBe(false);
  });
});

describe('InMemoryAuditLedgerWriter — row immutability', () => {
  test('returned rows are frozen — mutation throws TypeError', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const row = await writer.append({ ...baseArgs, payloadHash: sha256('p') });
    expect(Object.isFrozen(row)).toBe(true);
    expect(() => {
      (row as { verdict: string }).verdict = 'reject';
    }).toThrow(TypeError);
  });

  test('payloadHash is copied — mutating the input buffer does NOT alter the stored row', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const original = sha256('p');
    const expected = Buffer.from(original);
    const row = await writer.append({ ...baseArgs, payloadHash: original });
    original.fill(0); // mutate the caller's buffer
    expect(row.payloadHash.equals(expected)).toBe(true);
  });

  test('snapshot returns a fresh array; mutating it does not affect the ledger', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({ ...baseArgs, payloadHash: sha256('p1') });
    const snap = writer.snapshot();
    (snap as { length?: number }).length = 0;
    expect(writer.size()).toBe(1);
  });

  test('mutating a returned row Buffer does NOT corrupt the next append chain', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const first = await writer.append({
      ...baseArgs,
      deliveryId: 'd-1',
      payloadHash: sha256('p1'),
    });
    first.thisHash.fill(0); // would-be attacker; defensive copy means this is harmless
    const second = await writer.append({
      ...baseArgs,
      deliveryId: 'd-2',
      payloadHash: sha256('p2'),
    });
    // The next row's prev_hash must still be the ORIGINAL thisHash of row 1,
    // not the all-zero buffer the caller just stomped on.
    expect(second.prevHash.every((byte) => byte === 0)).toBe(false);
  });

  test('mutating a returned row Buffer does NOT break verifyChain', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const first = await writer.append({
      ...baseArgs,
      deliveryId: 'd-1',
      payloadHash: sha256('p1'),
    });
    await writer.append({ ...baseArgs, deliveryId: 'd-2', payloadHash: sha256('p2') });
    first.payloadHash.fill(0);
    first.thisHash.fill(0);
    expect(verifyChain(writer.snapshot())).toEqual({ ok: true });
  });
});

describe('InMemoryAuditLedgerWriter — getByDeliveryId', () => {
  test('returns the committed row for a known delivery_id, undefined otherwise', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const row = await writer.append({
      ...baseArgs,
      deliveryId: 'd-known',
      payloadHash: sha256('p'),
    });
    const found = await writer.getByDeliveryId('d-known');
    expect(found?.deliveryId).toBe('d-known');
    expect(found?.thisHash.equals(row.thisHash)).toBe(true);
    expect(await writer.getByDeliveryId('d-unseen')).toBeUndefined();
  });
});

describe('InMemoryAuditLedgerWriter — delivery_id uniqueness', () => {
  test('duplicate delivery_id throws DuplicateLedgerEntryError', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({ ...baseArgs, payloadHash: sha256('p1') });
    await expect(writer.append({ ...baseArgs, payloadHash: sha256('p2') })).rejects.toBeInstanceOf(
      DuplicateLedgerEntryError,
    );
  });

  test('duplicate append does NOT add a row or advance the chain', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const first = await writer.append({ ...baseArgs, payloadHash: sha256('p1') });
    expect(writer.size()).toBe(1);
    try {
      await writer.append({ ...baseArgs, payloadHash: sha256('p2') });
    } catch (_err) {
      // expected
    }
    expect(writer.size()).toBe(1);
    expect(verifyChain(writer.snapshot())).toEqual({ ok: true });
    const snapshot = writer.snapshot();
    // biome-ignore lint/style/noNonNullAssertion: snapshot has 1 row by construction.
    expect(snapshot[0]!.thisHash.equals(first.thisHash)).toBe(true);
  });

  test('distinct delivery_ids append successfully', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({ ...baseArgs, payloadHash: sha256('p1') });
    await writer.append({
      ...baseArgs,
      deliveryId: 'distinct-second-delivery-id',
      payloadHash: sha256('p2'),
    });
    expect(writer.size()).toBe(2);
  });

  test('same delivery_id with different event_type is ALSO a duplicate (delivery_id alone is the key)', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({
      ...baseArgs,
      eventType: 'webhook:issues.opened',
      payloadHash: sha256('p-webhook'),
    });
    await expect(
      writer.append({ ...baseArgs, eventType: 'validator:accept', payloadHash: sha256('p-val') }),
    ).rejects.toBeInstanceOf(DuplicateLedgerEntryError);
  });

  test('DuplicateLedgerEntryError carries the offending delivery_id and event_type', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({ ...baseArgs, payloadHash: sha256('p1') });
    await writer.append({ ...baseArgs, payloadHash: sha256('p2') }).catch((err) => {
      expect(err).toBeInstanceOf(DuplicateLedgerEntryError);
      expect((err as DuplicateLedgerEntryError).deliveryId).toBe(baseArgs.deliveryId);
      expect((err as DuplicateLedgerEntryError).eventType).toBe(baseArgs.eventType);
      expect((err as DuplicateLedgerEntryError).name).toBe('DuplicateLedgerEntryError');
    });
  });
});

describe('verifyChain — tamper detection', () => {
  test('verifyChain on an intact ledger returns ok', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({ ...baseArgs, deliveryId: 'd-1', payloadHash: sha256('p1') });
    await writer.append({ ...baseArgs, deliveryId: 'd-2', payloadHash: sha256('p2') });
    await writer.append({ ...baseArgs, deliveryId: 'd-3', payloadHash: sha256('p3') });
    expect(verifyChain(writer.snapshot())).toEqual({ ok: true });
  });

  test('verifyChain on an empty ledger returns ok (trivially)', () => {
    expect(verifyChain([])).toEqual({ ok: true });
  });

  test('verifyChain detects a tampered payloadHash', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({ ...baseArgs, deliveryId: 'd-1', payloadHash: sha256('p1') });
    const row2 = await writer.append({ ...baseArgs, deliveryId: 'd-2', payloadHash: sha256('p2') });
    // Produce a forged row with the wrong payloadHash but the same prev/this hashes.
    const forged: typeof row2 = { ...row2, payloadHash: sha256('different-payload') };
    const snapshot = writer.snapshot();
    // biome-ignore lint/style/noNonNullAssertion: snapshot has 2 rows by construction.
    const tampered = [snapshot[0]!, forged];
    expect(verifyChain(tampered)).toEqual({ ok: false, brokenAt: 2 });
  });

  test('verifyChain detects a tampered prev_hash linkage', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const a = await writer.append({ ...baseArgs, deliveryId: 'd-1', payloadHash: sha256('p1') });
    const b = await writer.append({ ...baseArgs, deliveryId: 'd-2', payloadHash: sha256('p2') });
    // Disconnect row 2 from row 1 by replacing its prev_hash.
    const disconnected: typeof b = { ...b, prevHash: Buffer.alloc(32, 0xff) };
    expect(verifyChain([a, disconnected])).toEqual({ ok: false, brokenAt: 2 });
  });

  test('verifyChain detects a skipped seq', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    const a = await writer.append({ ...baseArgs, deliveryId: 'd-1', payloadHash: sha256('p1') });
    const b = await writer.append({ ...baseArgs, deliveryId: 'd-2', payloadHash: sha256('p2') });
    const skewed: typeof b = { ...b, seq: 99 };
    expect(verifyChain([a, skewed])).toEqual({ ok: false, brokenAt: 99 });
  });
});

describe('AuditLedgerReader — getLastTransitionForRecord', () => {
  test('returns undefined when no rows have been appended', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    expect(await writer.getLastTransitionForRecord('I_kwAOA')).toBeUndefined();
  });

  test('returns undefined for an unknown recordId', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({ ...baseArgs, payloadHash: sha256('p1') });
    expect(await writer.getLastTransitionForRecord('I_OTHER')).toBeUndefined();
  });

  test('returns the most recent accepted transition for the recordId', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({
      ...baseArgs,
      deliveryId: 'd-1',
      payloadHash: sha256('p1'),
      fromState: 'proposed',
      toState: 'ready',
    });
    await writer.append({
      ...baseArgs,
      deliveryId: 'd-2',
      payloadHash: sha256('p2'),
      fromState: 'ready',
      toState: 'in_progress',
    });
    const last = await writer.getLastTransitionForRecord('I_kwAOA');
    expect(last?.toState).toBe('in_progress');
    expect(last?.fromState).toBe('ready');
  });

  test('isolates records (does not return rows for other recordIds)', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({
      ...baseArgs,
      deliveryId: 'd-a-1',
      recordId: 'I_A',
      payloadHash: sha256('a'),
      toState: 'in_progress',
    });
    await writer.append({
      ...baseArgs,
      deliveryId: 'd-b-1',
      recordId: 'I_B',
      payloadHash: sha256('b'),
      toState: 'ready',
    });
    expect((await writer.getLastTransitionForRecord('I_A'))?.toState).toBe('in_progress');
    expect((await writer.getLastTransitionForRecord('I_B'))?.toState).toBe('ready');
  });

  test('skips rejected rows (state did not change on reject)', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({
      ...baseArgs,
      deliveryId: 'd-1',
      payloadHash: sha256('p1'),
      fromState: 'ready',
      toState: 'in_progress',
      verdict: 'accept',
    });
    await writer.append({
      ...baseArgs,
      deliveryId: 'd-2',
      payloadHash: sha256('p2'),
      fromState: 'in_progress',
      toState: 'success',
      verdict: 'reject',
    });
    // Latest accepted transition is still ready → in_progress; the reject
    // did not change state.
    const last = await writer.getLastTransitionForRecord('I_kwAOA');
    expect(last?.toState).toBe('in_progress');
    expect(last?.verdict).toBe('accept');
  });

  test('includes flagged rows (flag commits the transition; just marks for human review)', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({
      ...baseArgs,
      deliveryId: 'd-1',
      payloadHash: sha256('p1'),
      toState: 'in_progress',
      verdict: 'flag',
    });
    expect((await writer.getLastTransitionForRecord('I_kwAOA'))?.toState).toBe('in_progress');
  });

  test('skips record-only rows (no state transition occurred)', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({
      ...baseArgs,
      deliveryId: 'd-1',
      payloadHash: sha256('p1'),
      toState: 'in_progress',
      verdict: 'accept',
    });
    await writer.append({
      ...baseArgs,
      deliveryId: 'd-2',
      payloadHash: sha256('p2'),
      fromState: undefined,
      toState: undefined,
      verdict: 'record-only',
    });
    // record-only row should NOT shadow the prior accepted transition.
    expect((await writer.getLastTransitionForRecord('I_kwAOA'))?.toState).toBe('in_progress');
  });

  test('returned row is a defensive copy (mutating buffers does not affect the ledger)', async () => {
    const writer = new InMemoryAuditLedgerWriter(fixedClock());
    await writer.append({
      ...baseArgs,
      payloadHash: sha256('p1'),
      toState: 'in_progress',
    });
    const first = await writer.getLastTransitionForRecord('I_kwAOA');
    first?.payloadHash.fill(0xff);
    const second = await writer.getLastTransitionForRecord('I_kwAOA');
    expect(second?.payloadHash.equals(sha256('p1'))).toBe(true);
  });
});
