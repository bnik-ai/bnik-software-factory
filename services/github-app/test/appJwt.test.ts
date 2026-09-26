import { createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import { signAppJwt } from '../src/appJwt.js';

interface KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

function generateTestKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function base64UrlDecodeToString(input: string): string {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

function base64UrlDecodeToBuffer(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

interface DecodedJwt {
  header: { alg: string; typ: string };
  payload: { iat: number; exp: number; iss: string };
  signature: Buffer;
  signingInput: string;
}

function decodeJwt(jwt: string): DecodedJwt {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error(`expected 3 JWT segments, got ${parts.length}`);
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  return {
    header: JSON.parse(base64UrlDecodeToString(headerB64)),
    payload: JSON.parse(base64UrlDecodeToString(payloadB64)),
    signature: base64UrlDecodeToBuffer(signatureB64),
    signingInput: `${headerB64}.${payloadB64}`,
  };
}

describe('signAppJwt', () => {
  let keypair: KeyPair;
  beforeAll(() => {
    keypair = generateTestKeyPair();
  });

  const FIXED_NOW = 1_700_000_000; // 2023-11-14 22:13:20 UTC; chosen for clarity
  const APP_ID = 123456;

  test('emits a 3-segment JWT with alg=RS256 and typ=JWT', () => {
    const jwt = signAppJwt({
      appId: APP_ID,
      privateKeyPem: keypair.privateKeyPem,
      now: FIXED_NOW,
    });
    const decoded = decodeJwt(jwt);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  test('payload uses iss = String(appId)', () => {
    const jwt = signAppJwt({
      appId: APP_ID,
      privateKeyPem: keypair.privateKeyPem,
      now: FIXED_NOW,
    });
    const decoded = decodeJwt(jwt);
    expect(decoded.payload.iss).toBe(String(APP_ID));
  });

  test('numeric and string appId yield the same iss claim', () => {
    const jwtFromNumber = signAppJwt({
      appId: APP_ID,
      privateKeyPem: keypair.privateKeyPem,
      now: FIXED_NOW,
    });
    const jwtFromString = signAppJwt({
      appId: String(APP_ID),
      privateKeyPem: keypair.privateKeyPem,
      now: FIXED_NOW,
    });
    expect(decodeJwt(jwtFromNumber).payload.iss).toBe(decodeJwt(jwtFromString).payload.iss);
  });

  test('iat is back-dated 60 seconds for clock-skew safety', () => {
    const jwt = signAppJwt({
      appId: APP_ID,
      privateKeyPem: keypair.privateKeyPem,
      now: FIXED_NOW,
    });
    const decoded = decodeJwt(jwt);
    expect(decoded.payload.iat).toBe(FIXED_NOW - 60);
  });

  test('exp is 9 minutes (540s) after now — within GitHub’s 10-minute hard limit even after back-dating iat', () => {
    const jwt = signAppJwt({
      appId: APP_ID,
      privateKeyPem: keypair.privateKeyPem,
      now: FIXED_NOW,
    });
    const decoded = decodeJwt(jwt);
    expect(decoded.payload.exp).toBe(FIXED_NOW + 540);
    expect(decoded.payload.exp - decoded.payload.iat).toBeLessThanOrEqual(600);
  });

  test('signature verifies against the public key (round-trip)', () => {
    const jwt = signAppJwt({
      appId: APP_ID,
      privateKeyPem: keypair.privateKeyPem,
      now: FIXED_NOW,
    });
    const decoded = decodeJwt(jwt);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(decoded.signingInput);
    expect(verifier.verify(keypair.publicKeyPem, decoded.signature)).toBe(true);
  });

  test('signature does NOT verify against a different public key', () => {
    const otherKeypair = generateTestKeyPair();
    const jwt = signAppJwt({
      appId: APP_ID,
      privateKeyPem: keypair.privateKeyPem,
      now: FIXED_NOW,
    });
    const decoded = decodeJwt(jwt);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(decoded.signingInput);
    expect(verifier.verify(otherKeypair.publicKeyPem, decoded.signature)).toBe(false);
  });

  test('omitting now falls back to the real clock and produces an iat within a few seconds of system time', () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = signAppJwt({ appId: APP_ID, privateKeyPem: keypair.privateKeyPem });
    const after = Math.floor(Date.now() / 1000);
    const decoded = decodeJwt(jwt);
    expect(decoded.payload.iat).toBeGreaterThanOrEqual(before - 60);
    expect(decoded.payload.iat).toBeLessThanOrEqual(after - 60 + 1);
  });
});
