import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifyWebhookSignature } from '../src/hmac.js';

const TEST_SECRET = 'test-webhook-secret-do-not-use-in-prod';

function signatureFor(body: Buffer, secret: string = TEST_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyWebhookSignature', () => {
  test('valid signature returns ok: true', () => {
    const body = Buffer.from('{"action":"opened"}');
    const result = verifyWebhookSignature({
      signatureHeader: signatureFor(body),
      rawBody: body,
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ ok: true });
  });

  test('missing (undefined) header returns missing_header', () => {
    const result = verifyWebhookSignature({
      signatureHeader: undefined,
      rawBody: Buffer.from('{}'),
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  test('header without sha256= prefix returns malformed_header', () => {
    const result = verifyWebhookSignature({
      signatureHeader: 'a'.repeat(64),
      rawBody: Buffer.from('{}'),
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_header' });
  });

  test('header with 63-char hex (wrong length) returns malformed_header', () => {
    const result = verifyWebhookSignature({
      signatureHeader: `sha256=${'a'.repeat(63)}`,
      rawBody: Buffer.from('{}'),
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_header' });
  });

  test('correct prefix and 64-char hex but wrong digest returns mismatch', () => {
    const result = verifyWebhookSignature({
      signatureHeader: `sha256=${'0'.repeat(64)}`,
      rawBody: Buffer.from('{}'),
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('signature for payload A verified against same-length payload B returns mismatch', () => {
    const bodyA = Buffer.from('{"a":1}');
    const bodyB = Buffer.from('{"b":2}');
    expect(bodyA.length).toBe(bodyB.length);
    const result = verifyWebhookSignature({
      signatureHeader: signatureFor(bodyA),
      rawBody: bodyB,
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('empty body with the correct signature for an empty body returns ok', () => {
    const body = Buffer.alloc(0);
    const result = verifyWebhookSignature({
      signatureHeader: signatureFor(body),
      rawBody: body,
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ ok: true });
  });
});
