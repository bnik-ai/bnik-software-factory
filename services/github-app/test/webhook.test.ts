import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { handleWebhook } from '../src/webhook.js';

const TEST_SECRET = 'test-webhook-secret-do-not-use-in-prod';
const DELIVERY_ID = '7f3d0c4e-1234-1234-1234-abcdef012345';

function signatureFor(body: Buffer): string {
  return `sha256=${createHmac('sha256', TEST_SECRET).update(body).digest('hex')}`;
}

describe('handleWebhook', () => {
  test('valid signature with delivery + event returns 200 echoing both', () => {
    const body = Buffer.from('{"action":"opened"}');
    const result = handleWebhook({
      headers: {
        'X-Hub-Signature-256': signatureFor(body),
        'X-GitHub-Delivery': DELIVERY_ID,
        'X-GitHub-Event': 'issues',
      },
      rawBody: body,
      secret: TEST_SECRET,
    });
    expect(result).toEqual({
      status: 200,
      body: { ok: true, deliveryId: DELIVERY_ID, event: 'issues' },
    });
  });

  test('invalid signature returns 401 invalid_signature', () => {
    const body = Buffer.from('{}');
    const result = handleWebhook({
      headers: {
        'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
        'X-GitHub-Delivery': DELIVERY_ID,
        'X-GitHub-Event': 'issues',
      },
      rawBody: body,
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ status: 401, body: { ok: false, reason: 'invalid_signature' } });
  });

  test('missing signature header returns 401 missing_signature', () => {
    const result = handleWebhook({
      headers: {
        'X-GitHub-Delivery': DELIVERY_ID,
        'X-GitHub-Event': 'issues',
      },
      rawBody: Buffer.from('{}'),
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ status: 401, body: { ok: false, reason: 'missing_signature' } });
  });

  test('malformed signature header returns 400 malformed_signature', () => {
    const result = handleWebhook({
      headers: {
        'X-Hub-Signature-256': 'sha1=abc',
        'X-GitHub-Delivery': DELIVERY_ID,
        'X-GitHub-Event': 'issues',
      },
      rawBody: Buffer.from('{}'),
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ status: 400, body: { ok: false, reason: 'malformed_signature' } });
  });

  test('valid signature but missing delivery ID returns 400 missing_delivery_id', () => {
    const body = Buffer.from('{}');
    const result = handleWebhook({
      headers: {
        'X-Hub-Signature-256': signatureFor(body),
        'X-GitHub-Event': 'issues',
      },
      rawBody: body,
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ status: 400, body: { ok: false, reason: 'missing_delivery_id' } });
  });

  test('valid signature but missing event header returns 400 missing_event', () => {
    const body = Buffer.from('{}');
    const result = handleWebhook({
      headers: {
        'X-Hub-Signature-256': signatureFor(body),
        'X-GitHub-Delivery': DELIVERY_ID,
      },
      rawBody: body,
      secret: TEST_SECRET,
    });
    expect(result).toEqual({ status: 400, body: { ok: false, reason: 'missing_event' } });
  });

  test('allowedEvents set, event in the set returns 200', () => {
    const body = Buffer.from('{}');
    const result = handleWebhook({
      headers: {
        'X-Hub-Signature-256': signatureFor(body),
        'X-GitHub-Delivery': DELIVERY_ID,
        'X-GitHub-Event': 'issues',
      },
      rawBody: body,
      secret: TEST_SECRET,
      allowedEvents: new Set(['issues', 'pull_request']),
    });
    expect(result).toEqual({
      status: 200,
      body: { ok: true, deliveryId: DELIVERY_ID, event: 'issues' },
    });
  });

  test('allowedEvents set, event NOT in the set returns 400 event_not_allowed', () => {
    const body = Buffer.from('{}');
    const result = handleWebhook({
      headers: {
        'X-Hub-Signature-256': signatureFor(body),
        'X-GitHub-Delivery': DELIVERY_ID,
        'X-GitHub-Event': 'star',
      },
      rawBody: body,
      secret: TEST_SECRET,
      allowedEvents: new Set(['issues', 'pull_request']),
    });
    expect(result).toEqual({ status: 400, body: { ok: false, reason: 'event_not_allowed' } });
  });
});
