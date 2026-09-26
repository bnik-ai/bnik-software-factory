import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER } from './constants.js';
import { type VerificationResult, verifyWebhookSignature } from './hmac.js';

export interface HandleWebhookArgs {
  headers: Record<string, string | undefined>;
  rawBody: Buffer | Uint8Array;
  secret: string;
  // Optional whitelist of allowed `X-GitHub-Event` values. When omitted, any
  // non-empty event is accepted (preserves B2-PR1 behaviour). When provided,
  // events outside the set return 400 `event_not_allowed`.
  allowedEvents?: ReadonlySet<string>;
}

export type HandleWebhookResult =
  | { status: 200; body: { ok: true; deliveryId: string; event: string } }
  | {
      status: 400;
      body: {
        ok: false;
        reason:
          | 'malformed_signature'
          | 'missing_delivery_id'
          | 'missing_event'
          | 'event_not_allowed';
      };
    }
  | { status: 401; body: { ok: false; reason: 'invalid_signature' | 'missing_signature' } };

function lowerCaseHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

export function handleWebhook(args: HandleWebhookArgs): HandleWebhookResult {
  const { headers, rawBody, secret, allowedEvents } = args;
  const normalizedHeaders = lowerCaseHeaders(headers);

  const signatureHeader = normalizedHeaders[SIGNATURE_HEADER];
  const verification: VerificationResult = verifyWebhookSignature({
    signatureHeader,
    rawBody,
    secret,
  });

  if (!verification.ok) {
    if (verification.reason === 'malformed_header') {
      return { status: 400, body: { ok: false, reason: 'malformed_signature' } };
    }
    if (verification.reason === 'missing_header') {
      return { status: 401, body: { ok: false, reason: 'missing_signature' } };
    }
    return { status: 401, body: { ok: false, reason: 'invalid_signature' } };
  }

  const deliveryId = normalizedHeaders[DELIVERY_HEADER];
  if (deliveryId == null || deliveryId.length === 0) {
    return { status: 400, body: { ok: false, reason: 'missing_delivery_id' } };
  }

  const event = normalizedHeaders[EVENT_HEADER];
  if (event == null || event.length === 0) {
    return { status: 400, body: { ok: false, reason: 'missing_event' } };
  }

  if (allowedEvents !== undefined && !allowedEvents.has(event)) {
    return { status: 400, body: { ok: false, reason: 'event_not_allowed' } };
  }

  return { status: 200, body: { ok: true, deliveryId, event } };
}
