// Spec: ADR 0008 §2 (`run` is a 26-char Crockford-base32 ULID).
// Validator regex: services/validator/src/attributionStamp.ts ULID_RE =
// `/^[0-9A-HJKMNP-TV-Z]{26}$/` (excludes I/L/O/U per Crockford spec).
//
// Inline ULID minter — used by per-role agent entrypoints (mainAgentSpec /
// Design / Build / Review) to mint a fresh ULID per agent run. Replaces the
// v0 stub of `runId: message.deliveryId` which produced non-ULID stamps
// that the validator's attributionStamp parser rejected (issue #109 P1).
//
// We inline rather than pull the `ulid` npm package because:
//   - One function, ~25 lines; less surface than a dep.
//   - No transitive deps to audit.
//   - The validator's ULID_RE is the authoritative target — owning the
//     producer code in this repo keeps the round-trip in one place.
//
// Real wire-envelope run-id (the proper fix per ADR 0011 §"per-run
// dispatch") still TODO — the dispatch message would carry SF's
// canonical run-id and entrypoints would consume it. Until that lands
// (B5-PR11+), this minter ensures the stamp parses.

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = CROCKFORD.length; // 32

function encodeBase32(buf: Buffer, length: number): string {
  // Big-endian base32 over a byte buffer. Bytes left to right, 5 bits at
  // a time, padded with zero bits if the input is < length * 5 bits.
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && result.length < length) {
      bits -= 5;
      const idx = (value >> bits) & 0x1f;
      result += CROCKFORD[idx];
    }
  }
  // Pad with leading '0' if the encoded result is shorter than requested
  // (only happens when buf has fewer bits than length * 5).
  while (result.length < length) {
    result = `0${result}`;
  }
  return result.slice(0, length);
}

function encodeTime(now: number): string {
  // 48-bit big-endian millis-since-epoch → 10 Crockford-base32 chars.
  // `now` ≤ Number.MAX_SAFE_INTEGER (2^53 - 1) so the conversion is exact
  // for any realistic timestamp.
  const buf = Buffer.alloc(6);
  let n = now;
  for (let i = 5; i >= 0; i--) {
    buf[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return encodeBase32(buf, 10);
}

function encodeRandom(): string {
  // 16 base32 chars = 80 bits of randomness.
  const buf = randomBytes(10);
  return encodeBase32(buf, 16);
}

// Mint a new ULID. 26 chars, lexicographically time-sortable, matches
// /^[0-9A-HJKMNP-TV-Z]{26}$/ per ADR 0008.
export function mintRunId(now: number = Date.now()): string {
  return `${encodeTime(now)}${encodeRandom()}`;
}

// Exposed for tests — verifies any string matches the validator's ULID_RE.
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
