import {
  type AuditLedgerWriter,
  DuplicateLedgerEntryError,
  type LedgerVerdict,
} from './auditLedger.js';
import { runCrossRecordAssertions } from './crossRecordAssertions.js';
import type { evaluateTransition } from './dispatcher.js';
import type { ParsedTransitionMessage } from './queueConsumer.js';
import { runReviewLoopAssertions } from './reviewLoopAssertions.js';
import type { SubstrateClient } from './substrateClient.js';
import type { Verdict } from './types.js';

// Spec: docs/design/validator-bot.md "Service Bus session-keyed consumer"
// + Failure handling table (line 222+) + docs/decisions/0003-cross-repo-delivery.md
// (cross-record assertions for parent-goal / spec-ref / design-ref) +
// docs/decisions/0010-multi-model-review-loop.md §"Substrate constraints"
// (review-loop model-independence + Review-required-before-merge).
// Invariants:
//   - On duplicate delivery: ACK (already processed); upstream github-app
//     idempotency ledger has accepted the delivery, so we ack to drop
//     the redelivery.
//   - On ledger write failure other than duplicate: bubble up so the
//     consumer's lock times out and Service Bus redelivers (per
//     "Mirror beginDelivery INSERT fails: Return 5xx so GitHub re-delivers").
//   - The Verdict envelope is preserved across the boundary — soft-flag
//     kinds carry forward as `flag`, hard-reject as `reject`.
//   - Cross-record AND review-loop assertions run AFTER the per-kind FSM
//     and BEFORE the ledger row is finalized. A failed assertion DOWNGRADES
//     the verdict accept→flag (soft-flag posture per ADR 0003 + ADR 0010:
//     the upstream substrate write already happened, hard-reject can't
//     undo it). flag/reject verdicts are left untouched — the FSM already
//     surfaced a stronger signal and the assertion failure adds no new
//     value. `substrate` is optional for backward compatibility: when
//     omitted, both assertion runners are skipped (the per-kind FSM
//     result is the only signal).
//   - Cross-record runs FIRST; if it fails, the review-loop check is
//     skipped and the cross-record reason wins. Rationale: cross-record
//     references are structural (a broken parent-goal is a hard linking
//     bug); review-loop policy is a downstream concern. Surfacing one
//     reason keeps the ledger row's `reason` column unambiguous.

export interface ProcessMessageDeps {
  dispatcher: typeof evaluateTransition;
  ledger: AuditLedgerWriter;
  substrate?: SubstrateClient;
  // Issue #178 rev11: the configured App-bot login set used to authenticate
  // structural markers in the review-loop assertions. MUST be the same set the
  // parser/resolver use (GITHUB_APP_SLUG threading); falls back to env inside
  // the assertion when omitted.
  appBotLogins?: ReadonlySet<string>;
}

export type ProcessingDecision =
  | { action: 'ack'; verdict: Verdict; rowSeq?: number; idempotent: boolean }
  | { action: 'deadletter'; reason: string };

export async function processMessage(
  message: ParsedTransitionMessage,
  deps: ProcessMessageDeps,
): Promise<ProcessingDecision> {
  const fsmVerdict = deps.dispatcher({
    kind: message.kind,
    fromState: message.fromState,
    toState: message.toState,
    actor: message.actor,
  });

  // Cross-record + review-loop assertions ONLY run when substrate is wired
  // AND the FSM accepted. If the FSM already flagged/rejected we keep the
  // stronger signal — running assertions on an off-policy transition adds
  // noise without changing the ledger outcome. Cross-record runs first;
  // its failure short-circuits review-loop (first failing assertion wins).
  let verdict: Verdict = fsmVerdict;
  if (deps.substrate !== undefined && fsmVerdict.verdict === 'accept') {
    const crossRecord = await runCrossRecordAssertions(message, deps.substrate);
    if (!crossRecord.ok) {
      // Soft-flag downgrade. Verdict.reason is the VerdictReason union
      // (FsmRejectReason ∪ CrossRecordAssertionReason ∪
      // ReviewLoopAssertionReason) so the assertion name flows in directly.
      verdict = { verdict: 'flag', reason: crossRecord.assertion };
    } else {
      const reviewLoop = await runReviewLoopAssertions(message, deps.substrate, deps.appBotLogins);
      if (!reviewLoop.ok) {
        verdict = { verdict: 'flag', reason: reviewLoop.assertion };
      }
    }
  }

  const ledgerVerdict: LedgerVerdict = verdict.verdict;

  try {
    const row = await deps.ledger.append({
      deliveryId: message.deliveryId,
      eventType: message.eventType,
      actor: message.actor,
      recordType: message.recordType,
      recordKind: message.recordKind,
      recordId: message.recordId,
      fromState: message.fromState,
      toState: message.toState,
      verdict: ledgerVerdict,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
    });
    return { action: 'ack', verdict, rowSeq: row.seq, idempotent: false };
  } catch (err) {
    if (err instanceof DuplicateLedgerEntryError) {
      return { action: 'ack', verdict, idempotent: true };
    }
    throw err;
  }
}
