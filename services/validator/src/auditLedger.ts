import { createHash } from 'node:crypto';

// Spec: docs/design/validator-bot.md "Audit ledger" section (schema +
// hash-chain rule).
// Invariants:
//   - this_hash = sha256(payload_hash || prev_hash || seq_8byte_be)
//   - prev_hash for the genesis row is 32 zero bytes (no predecessor).
//   - seq is monotonic, starting at 1 for the first row.
//   - delivery_id is UNIQUE per validator-bot.md:239. A duplicate append
//     throws DuplicateLedgerEntryError. (Service Bus is at-least-once;
//     a duplicate is possible if the consumer crashes between SB ACK
//     and ledger write.)
//   - The github-app ledger (services/github-app/src/auditLedger.ts)
//     and this validator audit_ledger are SEPARATE Postgres tables: the
//     github-app's is functionally the delivery-status / idempotency
//     table; this is the hash-chained event log. delivery_id uniqueness
//     here does NOT collide with the github-app's beginDelivery reservation.
//   - append-only: internal rows are never mutated. Returned rows are
//     defensive copies (Buffers and Dates are duplicated) so caller-side
//     mutation cannot corrupt the chain or the stored row.
//   - in-memory implementation is for tests and v0 boot;
//     PostgresAuditLedgerWriter uses the same schema. The hash-chain math is
//     identical.

const GENESIS_PREV_HASH: Buffer = Buffer.alloc(32);
const SEQ_BYTE_LENGTH = 8;

export type LedgerVerdict = 'accept' | 'reject' | 'flag' | 'record-only';

export interface AppendArgs {
  deliveryId: string;
  eventType: string;
  actor: string;
  recordType: string;
  recordKind?: string;
  recordId: string;
  fromState?: string;
  toState?: string;
  verdict: LedgerVerdict;
  payloadHash: Buffer;
  receivedAt: Date;
}

export interface AuditLedgerRow {
  readonly seq: number;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly actor: string;
  readonly recordType: string;
  readonly recordKind: string | undefined;
  readonly recordId: string;
  readonly fromState: string | undefined;
  readonly toState: string | undefined;
  readonly verdict: LedgerVerdict;
  readonly payloadHash: Buffer;
  readonly prevHash: Buffer;
  readonly thisHash: Buffer;
  readonly receivedAt: Date;
  readonly processedAt: Date;
}

export interface AuditLedgerWriter {
  append(args: AppendArgs): Promise<AuditLedgerRow>;
}

// Read-side counterpart to AuditLedgerWriter. The transitionResolver
// uses this to resolve fromState for events where the
// substrate-current-labels view is insufficient or unreachable (steady-
// state single-status-label resolution for issues; PR closed-without-
// merge; deployment_status follow-up events). v0 boot uses the
// in-memory impl below; PostgresAuditLedgerWriter is the Postgres-backed
// implementation (index audit_ledger_record_lookup on record_id,
// processed_at DESC).
export interface AuditLedgerReader {
  // Returns the most recent row for recordId where toState is set and
  // the verdict was accept or flag (i.e. a state transition was committed
  // to the substrate's effective state). Rejected and record-only rows
  // are skipped because they did NOT change the record's state.
  // Returns undefined if no such row exists (first event for this record).
  getLastTransitionForRecord(recordId: string): Promise<AuditLedgerRow | undefined>;
  // Returns the committed row for a delivery_id, or undefined if unseen.
  // Service Bus is at-least-once: a delivery can be redelivered after its
  // ledger row committed but before the inbound ACK. The SB consumer uses
  // this to replay the ALREADY-RECORDED transition on redelivery instead of
  // re-running the resolver (which reads a ledger that now contains this
  // row and could derive a different fromState/verdict — a no-op or
  // unresolvable result that would wrongly dead-letter an already-accepted
  // delivery).
  getByDeliveryId(deliveryId: string): Promise<AuditLedgerRow | undefined>;
}

export class DuplicateLedgerEntryError extends Error {
  readonly deliveryId: string;
  readonly eventType: string;
  constructor(deliveryId: string, eventType: string) {
    super(
      `delivery_id "${deliveryId}" (event_type "${eventType}") is already present in the audit ledger`,
    );
    this.name = 'DuplicateLedgerEntryError';
    this.deliveryId = deliveryId;
    this.eventType = eventType;
  }
}

export function computeRowHash(args: {
  payloadHash: Buffer;
  prevHash: Buffer;
  seq: number;
}): Buffer {
  const seqBuf = Buffer.alloc(SEQ_BYTE_LENGTH);
  seqBuf.writeBigUInt64BE(BigInt(args.seq));
  return createHash('sha256')
    .update(args.payloadHash)
    .update(args.prevHash)
    .update(seqBuf)
    .digest();
}

// Defensive deep copy. Buffers and Dates are the only mutable fields on
// AuditLedgerRow; everything else is a primitive. Object.freeze is shallow,
// so callers MUST receive their own Buffers/Dates to honor the
// append-only invariant.
function copyRow(row: AuditLedgerRow): AuditLedgerRow {
  return Object.freeze({
    seq: row.seq,
    deliveryId: row.deliveryId,
    eventType: row.eventType,
    actor: row.actor,
    recordType: row.recordType,
    recordKind: row.recordKind,
    recordId: row.recordId,
    fromState: row.fromState,
    toState: row.toState,
    verdict: row.verdict,
    payloadHash: Buffer.from(row.payloadHash),
    prevHash: Buffer.from(row.prevHash),
    thisHash: Buffer.from(row.thisHash),
    receivedAt: new Date(row.receivedAt.getTime()),
    processedAt: new Date(row.processedAt.getTime()),
  });
}

export class InMemoryAuditLedgerWriter implements AuditLedgerWriter, AuditLedgerReader {
  private readonly rows: AuditLedgerRow[] = [];
  private readonly deliveryIds: Set<string> = new Set();
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  async append(args: AppendArgs): Promise<AuditLedgerRow> {
    if (this.deliveryIds.has(args.deliveryId)) {
      throw new DuplicateLedgerEntryError(args.deliveryId, args.eventType);
    }
    const previous = this.rows[this.rows.length - 1];
    const prevHash =
      previous !== undefined ? Buffer.from(previous.thisHash) : Buffer.from(GENESIS_PREV_HASH);
    const seq = (previous?.seq ?? 0) + 1;
    const payloadHash = Buffer.from(args.payloadHash);
    const thisHash = computeRowHash({ payloadHash, prevHash, seq });

    const internal: AuditLedgerRow = Object.freeze({
      seq,
      deliveryId: args.deliveryId,
      eventType: args.eventType,
      actor: args.actor,
      recordType: args.recordType,
      recordKind: args.recordKind,
      recordId: args.recordId,
      fromState: args.fromState,
      toState: args.toState,
      verdict: args.verdict,
      payloadHash,
      prevHash,
      thisHash,
      receivedAt: new Date(args.receivedAt.getTime()),
      processedAt: this.clock(),
    });

    this.rows.push(internal);
    this.deliveryIds.add(args.deliveryId);
    return copyRow(internal);
  }

  // Snapshot returns copies — no caller-side mutation can reach the
  // internal store.
  snapshot(): readonly AuditLedgerRow[] {
    return this.rows.map(copyRow);
  }

  size(): number {
    return this.rows.length;
  }

  async getByDeliveryId(deliveryId: string): Promise<AuditLedgerRow | undefined> {
    if (!this.deliveryIds.has(deliveryId)) return undefined;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      // biome-ignore lint/style/noNonNullAssertion: i is bounded by length.
      const row = this.rows[i]!;
      if (row.deliveryId === deliveryId) return copyRow(row);
    }
    return undefined;
  }

  // O(n) reverse scan; v0 in-memory only. Postgres impl indexes on
  // (recordId, processedAt DESC) and returns TOP 1 in O(log n).
  async getLastTransitionForRecord(recordId: string): Promise<AuditLedgerRow | undefined> {
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      // biome-ignore lint/style/noNonNullAssertion: i is bounded by length.
      const row = this.rows[i]!;
      if (
        row.recordId === recordId &&
        row.toState !== undefined &&
        (row.verdict === 'accept' || row.verdict === 'flag')
      ) {
        return copyRow(row);
      }
    }
    return undefined;
  }
}

// Replays the chain from genesis. Returns { ok: true } on intact, or
// { ok: false; brokenAt } for the seq of the first broken row.
export function verifyChain(
  rows: readonly AuditLedgerRow[],
): { ok: true } | { ok: false; brokenAt: number } {
  let expectedPrevHash = GENESIS_PREV_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectedSeq) return { ok: false, brokenAt: row.seq };
    if (!row.prevHash.equals(expectedPrevHash)) return { ok: false, brokenAt: row.seq };
    const recomputed = computeRowHash({
      payloadHash: row.payloadHash,
      prevHash: row.prevHash,
      seq: row.seq,
    });
    if (!recomputed.equals(row.thisHash)) return { ok: false, brokenAt: row.seq };
    expectedPrevHash = row.thisHash;
    expectedSeq += 1;
  }
  return { ok: true };
}
