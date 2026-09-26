import { createHmac, timingSafeEqual } from 'node:crypto';
import { SIGNATURE_HEX_LENGTH, SIGNATURE_PREFIX } from './constants.js';

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: 'missing_header' | 'malformed_header' | 'mismatch' };

export interface VerifyWebhookSignatureArgs {
  signatureHeader: string | null | undefined;
  rawBody: Buffer | Uint8Array;
  secret: string;
}

const HEX_PATTERN = /^[0-9a-f]+$/i;

export function verifyWebhookSignature(args: VerifyWebhookSignatureArgs): VerificationResult {
  const { signatureHeader, rawBody, secret } = args;

  if (signatureHeader == null || signatureHeader.length === 0) {
    return { ok: false, reason: 'missing_header' };
  }

  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'malformed_header' };
  }

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (providedHex.length !== SIGNATURE_HEX_LENGTH || !HEX_PATTERN.test(providedHex)) {
    return { ok: false, reason: 'malformed_header' };
  }

  const expectedDigest = createHmac('sha256', secret).update(rawBody).digest();
  const providedDigest = Buffer.from(providedHex, 'hex');

  // timingSafeEqual throws on length mismatch; guard explicitly so signatures of
  // unexpected length surface as a clean 'mismatch' instead of an exception.
  if (providedDigest.length !== expectedDigest.length) {
    return { ok: false, reason: 'mismatch' };
  }

  return timingSafeEqual(providedDigest, expectedDigest)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}
