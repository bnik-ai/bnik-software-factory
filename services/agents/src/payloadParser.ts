// Spec: docs/decisions/0011-agent-dispatch-topology.md (orchestrator →
// agents JSON envelope on per-role Service Bus queues).
// Invariants:
//   - Wire format is JSON. The orchestrator's ServiceBusAgentDispatcher
//     serializes:
//       {
//         agent: AgentRole,
//         transition_key: string,
//         message: {
//           lockToken, deliveryId, eventType, kind, actor, recordType,
//           recordKind?, recordId, fromState, toState,
//           payloadHash: hex string,
//           receivedAt: ISO-8601 string,
//           verdict?: 'accept'|'flag'|'reject'
//         }
//       }
//   - payloadHash is encoded as a lowercase hex string on the wire; the
//     in-process ParsedTransitionMessage type is a Buffer, so we decode here.
//   - receivedAt is encoded as an ISO-8601 string; we parse to Date here.
//   - The parser returns a typed Result envelope rather than throwing so the
//     entrypoint loop can deadletter malformed messages without crashing the
//     execution. Throwing escalates to the loop's catch-all which ends the
//     execution per session-ordering discipline; for malformed payloads
//     that's the wrong response — the message will never parse, so we should
//     deadletter it and continue.

import type { AgentRole, Kind, ParsedTransitionMessage, TransitionVerdict } from './types.js';

export type PayloadParseResult =
  | {
      ok: true;
      value: {
        agent: AgentRole;
        transitionKey: string;
        message: ParsedTransitionMessage;
      };
    }
  | { ok: false; reason: string };

const VALID_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  'SpecAgent',
  'DesignAgent',
  'PlannerAgent',
  'BuildAgent',
  'ReviewAgent',
  'OpsAgent',
  'SREAgent',
]);

const VALID_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  'goal',
  'spec',
  'design',
  'task',
  'pr',
  'deployment',
  'decision',
]);

const VALID_VERDICTS: ReadonlySet<TransitionVerdict> = new Set<TransitionVerdict>([
  'accept',
  'flag',
  'reject',
]);

const HEX_RE = /^[0-9a-f]+$/;

export function parseAgentRunPayload(raw: string): PayloadParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `payload_not_json:${detail}` };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'payload_not_object' };
  }
  const envelope = parsed as Record<string, unknown>;

  const agent = envelope.agent;
  if (typeof agent !== 'string' || !VALID_ROLES.has(agent as AgentRole)) {
    return { ok: false, reason: `invalid_agent:${String(agent)}` };
  }

  const transitionKey = envelope.transition_key;
  if (typeof transitionKey !== 'string' || transitionKey.length === 0) {
    return { ok: false, reason: 'missing_transition_key' };
  }

  const inner = envelope.message;
  if (inner === null || typeof inner !== 'object') {
    return { ok: false, reason: 'missing_message' };
  }
  const m = inner as Record<string, unknown>;

  const stringFields = [
    'lockToken',
    'deliveryId',
    'eventType',
    'actor',
    'recordType',
    'recordId',
    'fromState',
    'toState',
  ] as const;
  for (const field of stringFields) {
    if (typeof m[field] !== 'string' || (m[field] as string).length === 0) {
      return { ok: false, reason: `invalid_${field}` };
    }
  }

  if (typeof m.kind !== 'string' || !VALID_KINDS.has(m.kind as Kind)) {
    return { ok: false, reason: `invalid_kind:${String(m.kind)}` };
  }

  // recordKind is optional but if present must be a non-empty string.
  if (
    m.recordKind !== undefined &&
    (typeof m.recordKind !== 'string' || m.recordKind.length === 0)
  ) {
    return { ok: false, reason: 'invalid_recordKind' };
  }

  const payloadHashStr = m.payloadHash;
  if (typeof payloadHashStr !== 'string' || payloadHashStr.length === 0) {
    return { ok: false, reason: 'invalid_payloadHash' };
  }
  // Hex must be lowercase, even-length, and only [0-9a-f]. Buffer.from
  // silently skips invalid chars otherwise, which would mask malformed input.
  if (payloadHashStr.length % 2 !== 0 || !HEX_RE.test(payloadHashStr)) {
    return { ok: false, reason: 'invalid_payloadHash_hex' };
  }
  const payloadHash = Buffer.from(payloadHashStr, 'hex');

  const receivedAtStr = m.receivedAt;
  if (typeof receivedAtStr !== 'string' || receivedAtStr.length === 0) {
    return { ok: false, reason: 'invalid_receivedAt' };
  }
  const receivedAt = new Date(receivedAtStr);
  if (Number.isNaN(receivedAt.getTime())) {
    return { ok: false, reason: `invalid_receivedAt_iso:${receivedAtStr}` };
  }

  let verdict: TransitionVerdict | undefined;
  if (m.verdict !== undefined) {
    if (typeof m.verdict !== 'string' || !VALID_VERDICTS.has(m.verdict as TransitionVerdict)) {
      return { ok: false, reason: `invalid_verdict:${String(m.verdict)}` };
    }
    verdict = m.verdict as TransitionVerdict;
  }

  // Optional PR-specific fields (B4-PR8 / B4-PR9). Pass through as
  // strings or undefined; the orchestrator populates them on review-
  // trigger transitions and on synthetic rebase-for-review dispatches.
  const headBranch = typeof m.headBranch === 'string' ? m.headBranch : undefined;
  const baseBranch = typeof m.baseBranch === 'string' ? m.baseBranch : undefined;

  const message: ParsedTransitionMessage = {
    lockToken: m.lockToken as string,
    deliveryId: m.deliveryId as string,
    eventType: m.eventType as string,
    kind: m.kind as Kind,
    actor: m.actor as ParsedTransitionMessage['actor'],
    recordType: m.recordType as string,
    recordKind: m.recordKind as string | undefined,
    recordId: m.recordId as string,
    fromState: m.fromState as string,
    toState: m.toState as string,
    payloadHash,
    receivedAt,
    verdict,
    headBranch,
    baseBranch,
  };

  return {
    ok: true,
    value: {
      agent: agent as AgentRole,
      transitionKey,
      message,
    },
  };
}
