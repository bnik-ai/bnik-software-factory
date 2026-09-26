import { describe, expect, test } from 'vitest';
import { ULID_REGEX, mintRunId } from '../src/runId.js';

describe('mintRunId', () => {
  test('matches the validator ULID_RE (ADR 0008 §2)', () => {
    for (let i = 0; i < 100; i++) {
      const id = mintRunId();
      expect(id).toMatch(ULID_REGEX);
    }
  });

  test('returns a 26-char string', () => {
    expect(mintRunId().length).toBe(26);
  });

  test('uses only Crockford-base32 alphabet (no I, L, O, U)', () => {
    for (let i = 0; i < 50; i++) {
      const id = mintRunId();
      expect(id).not.toMatch(/[ILOU]/);
    }
  });

  test('two calls within the same millisecond differ (entropy in last 16 chars)', () => {
    const fixedNow = 1717000000000;
    const a = mintRunId(fixedNow);
    const b = mintRunId(fixedNow);
    expect(a).not.toBe(b);
    // First 10 chars (the timestamp) are equal because now is fixed
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    // Last 16 chars (the random part) differ
    expect(a.slice(10)).not.toBe(b.slice(10));
  });

  test('lexicographic time ordering: earlier ts sorts before later', () => {
    const t1 = 1717000000000;
    const t2 = 1717000001000; // 1s later
    const id1 = mintRunId(t1);
    const id2 = mintRunId(t2);
    expect(id1 < id2).toBe(true);
  });

  test('encoding pads to exactly 10 timestamp chars even for small now', () => {
    // now = 0 → all-zero timestamp → 10 zero chars
    const id = mintRunId(0);
    expect(id.slice(0, 10)).toBe('0000000000');
    expect(id).toMatch(ULID_REGEX);
  });

  test('max-ish now (year 10889) still produces a 26-char ULID', () => {
    // 2^48 - 1 milliseconds — about year 10889. ADR 0008's grammar only
    // needs to hold for realistic timestamps but the encoder shouldn't
    // overflow for the full 48-bit range.
    const maxNow = 2 ** 48 - 1;
    const id = mintRunId(maxNow);
    expect(id).toMatch(ULID_REGEX);
    // 48 bits in base32 = 9.6 chars; ULID pads to 10 with a leading 0,
    // so all-set 48 bits becomes '0ZZZZZZZZZ' (top 2 bits of the
    // 50-bit-wide encoding window are necessarily zero).
    expect(id.slice(0, 10)).toBe('0ZZZZZZZZZ');
  });
});
