import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { parseAgentRunPayload } from '../src/payloadParser.js';

// Helper: build a wire envelope. If `overrides.message` is supplied it
// REPLACES the default message wholesale (so tests can omit fields to
// exercise the parser's required-field checks). Top-level keys like `agent`
// and `transition_key` override individually.
function validEnvelope(overrides: Record<string, unknown> = {}): string {
  const defaultMessage = {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.transitioned',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA',
    fromState: 'proposed',
    toState: 'accepted',
    payloadHash: createHash('sha256').update('p').digest('hex'),
    receivedAt: '2026-05-30T18:00:00.000Z',
    verdict: 'accept',
  };
  const message = overrides.message !== undefined ? overrides.message : defaultMessage;
  const topLevel: Record<string, unknown> = {
    agent: 'SpecAgent',
    transition_key: 'goal:proposed→accepted',
    ...overrides,
    message,
  };
  return JSON.stringify(topLevel);
}

describe('parseAgentRunPayload — happy path', () => {
  test('parses a well-formed envelope and decodes payloadHash + receivedAt', () => {
    const result = parseAgentRunPayload(validEnvelope());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agent).toBe('SpecAgent');
    expect(result.value.transitionKey).toBe('goal:proposed→accepted');
    expect(result.value.message.recordId).toBe('I_kwAOA');
    expect(Buffer.isBuffer(result.value.message.payloadHash)).toBe(true);
    expect(result.value.message.payloadHash.length).toBe(32); // sha256 = 32 bytes
    expect(result.value.message.receivedAt).toBeInstanceOf(Date);
    expect(result.value.message.receivedAt.toISOString()).toBe('2026-05-30T18:00:00.000Z');
    expect(result.value.message.verdict).toBe('accept');
  });

  test('verdict and recordKind are optional', () => {
    const result = parseAgentRunPayload(
      validEnvelope({
        message: {
          lockToken: 'lt-1',
          deliveryId: 'd-1',
          eventType: 'webhook:issues.transitioned',
          kind: 'goal',
          actor: 'human',
          recordType: 'Issue',
          recordId: 'I_kwAOA',
          fromState: 'proposed',
          toState: 'accepted',
          payloadHash: 'ab'.repeat(32),
          receivedAt: '2026-05-30T18:00:00.000Z',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.message.verdict).toBeUndefined();
    expect(result.value.message.recordKind).toBeUndefined();
  });
});

describe('parseAgentRunPayload — malformed top-level', () => {
  test('non-JSON returns payload_not_json', () => {
    const result = parseAgentRunPayload('{not-json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^payload_not_json/);
  });

  test('JSON-null returns payload_not_object', () => {
    const result = parseAgentRunPayload('null');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('payload_not_object');
  });

  test('JSON-array returns payload_not_object via shape check', () => {
    // Arrays are typeof === 'object' but missing the required fields → first
    // failing field-shape check.
    const result = parseAgentRunPayload('[]');
    expect(result.ok).toBe(false);
  });

  test('unknown agent role rejected', () => {
    const result = parseAgentRunPayload(validEnvelope({ agent: 'NopeAgent' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_agent:NopeAgent');
  });

  test('missing transition_key rejected', () => {
    const result = parseAgentRunPayload(validEnvelope({ transition_key: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_transition_key');
  });

  test('missing message rejected', () => {
    const result = parseAgentRunPayload(
      JSON.stringify({ agent: 'SpecAgent', transition_key: 'x' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_message');
  });
});

describe('parseAgentRunPayload — malformed inner message', () => {
  test('missing required string field rejected with specific reason', () => {
    const result = parseAgentRunPayload(validEnvelope({ message: { deliveryId: 'd-1' } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^invalid_/);
  });

  test('unknown kind rejected', () => {
    const result = parseAgentRunPayload(
      validEnvelope({
        message: {
          lockToken: 'lt-1',
          deliveryId: 'd-1',
          eventType: 'webhook:issues.transitioned',
          kind: 'wat',
          actor: 'human',
          recordType: 'Issue',
          recordId: 'I_kwAOA',
          fromState: 'proposed',
          toState: 'accepted',
          payloadHash: 'aa'.repeat(32),
          receivedAt: '2026-05-30T18:00:00.000Z',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_kind:wat');
  });

  test('payloadHash with non-hex character rejected', () => {
    const result = parseAgentRunPayload(
      validEnvelope({
        message: {
          lockToken: 'lt-1',
          deliveryId: 'd-1',
          eventType: 'webhook:issues.transitioned',
          kind: 'goal',
          actor: 'human',
          recordType: 'Issue',
          recordId: 'I_kwAOA',
          fromState: 'proposed',
          toState: 'accepted',
          payloadHash: 'zz'.repeat(32),
          receivedAt: '2026-05-30T18:00:00.000Z',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_payloadHash_hex');
  });

  test('payloadHash with odd length rejected (would silently truncate via Buffer.from)', () => {
    const result = parseAgentRunPayload(
      validEnvelope({
        message: {
          lockToken: 'lt-1',
          deliveryId: 'd-1',
          eventType: 'webhook:issues.transitioned',
          kind: 'goal',
          actor: 'human',
          recordType: 'Issue',
          recordId: 'I_kwAOA',
          fromState: 'proposed',
          toState: 'accepted',
          payloadHash: 'abc',
          receivedAt: '2026-05-30T18:00:00.000Z',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_payloadHash_hex');
  });

  test('payloadHash uppercase rejected (must be lowercase)', () => {
    const result = parseAgentRunPayload(
      validEnvelope({
        message: {
          lockToken: 'lt-1',
          deliveryId: 'd-1',
          eventType: 'webhook:issues.transitioned',
          kind: 'goal',
          actor: 'human',
          recordType: 'Issue',
          recordId: 'I_kwAOA',
          fromState: 'proposed',
          toState: 'accepted',
          payloadHash: 'AB'.repeat(32),
          receivedAt: '2026-05-30T18:00:00.000Z',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_payloadHash_hex');
  });

  test('non-ISO receivedAt rejected', () => {
    const result = parseAgentRunPayload(
      validEnvelope({
        message: {
          lockToken: 'lt-1',
          deliveryId: 'd-1',
          eventType: 'webhook:issues.transitioned',
          kind: 'goal',
          actor: 'human',
          recordType: 'Issue',
          recordId: 'I_kwAOA',
          fromState: 'proposed',
          toState: 'accepted',
          payloadHash: 'aa'.repeat(32),
          receivedAt: 'not a date',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^invalid_receivedAt_iso/);
  });

  test('unknown verdict rejected', () => {
    const result = parseAgentRunPayload(
      validEnvelope({
        message: {
          lockToken: 'lt-1',
          deliveryId: 'd-1',
          eventType: 'webhook:issues.transitioned',
          kind: 'goal',
          actor: 'human',
          recordType: 'Issue',
          recordId: 'I_kwAOA',
          fromState: 'proposed',
          toState: 'accepted',
          payloadHash: 'aa'.repeat(32),
          receivedAt: '2026-05-30T18:00:00.000Z',
          verdict: 'maybe',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_verdict:maybe');
  });
});
