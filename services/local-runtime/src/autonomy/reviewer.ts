import { randomUUID } from 'node:crypto';
import type { Docker } from '../worker/docker.js';
import { SNAPSHOT_EXCLUSION_RULE } from '../worker/review-snapshot.js';
import type { ChangeManifest, FileChange } from './classify.js';
import type { ReviewContext } from './collector.js';
import {
  type AcceptanceReceipt,
  type CandidateSubject,
  type DependencyReceipt,
  FINDING_SEVERITIES,
  type ReviewFinding,
  type ReviewReceipt,
} from './evidence.js';
import { CRITICAL_CATEGORIES, type CriticalCategory } from './policy.js';
import { runSandbox, withProxy } from './sandbox.js';
import {
  requireAutonomy,
  requireRecord,
  requireText,
  requireUniqueList,
  sha256Json,
} from './schema.js';

/**
 * Separate verification. The reviewer never sees the author's conversation, never
 * edits anything and holds no credential; it returns structured findings the policy
 * consumes. The configuration digest is the policy trust root `reviewerConfigSha256`.
 */
export interface ReviewerConfig {
  adapter: 'fixture' | 'claude';
  model: string | null;
  promptVersion: number;
  maxTokens: number;
  /** Bytes of rendered diff the reviewer accepts; beyond it the review reports a limitation. */
  maxDiffBytes: number;
  /** Bytes of repository snapshot the reviewer receives; beyond it the snapshot is incomplete. */
  maxContextBytes: number;
}
export const FIXTURE_REVIEWER: ReviewerConfig = {
  adapter: 'fixture',
  model: null,
  promptVersion: 1,
  maxTokens: 0,
  maxDiffBytes: 1_000_000,
  maxContextBytes: 640 * 1024,
};
export function reviewerConfigDigest(config: ReviewerConfig): string {
  return sha256Json(config);
}
export interface ReviewRequest {
  subject: CandidateSubject;
  intent: { title: string; body: string; kind: 'change' | 'bugfix' };
  intentSha256: string;
  changes: ChangeManifest;
  /** The candidate tree's text files (OSS-22): what the reviewer may examine besides the diff. */
  context: ReviewContext | null;
  acceptance: AcceptanceReceipt | null;
  dependency: DependencyReceipt | null;
}
export interface ReviewOutcome {
  receipt: ReviewReceipt;
  /** Diagnostic only. */
  reason: string | null;
  usage: Record<string, number> | null;
}
export interface Reviewer {
  readonly config: ReviewerConfig;
  review(request: ReviewRequest, signal: AbortSignal): Promise<ReviewOutcome>;
}

/** Deterministic text rendering of the manifest; the classifier's diff, not the worker's. */
export function renderDiff(
  changes: ChangeManifest,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let bytes = 0;
  let truncated = false;
  const section = (file: FileChange) => {
    const header = `=== ${file.status.toUpperCase()} ${file.oldPath ?? '(none)'} -> ${file.newPath ?? '(none)'} [${file.oldMode ?? '-'} -> ${file.newMode ?? '-'}]${file.binary ? ' (binary)' : ''}`;
    const body = file.binary
      ? '(binary content not shown)'
      : [
          file.oldContent === null ? null : `--- before\n${file.oldContent}`,
          file.newContent === null ? null : `+++ after\n${file.newContent}`,
        ]
          .filter((part): part is string => part !== null)
          .join('\n');
    return `${header}\n${body}\n`;
  };
  for (const file of changes.files) {
    const rendered = section(file);
    bytes += Buffer.byteLength(rendered);
    if (bytes > maxBytes) {
      truncated = true;
      break;
    }
    parts.push(rendered);
  }
  return { text: parts.join('\n'), truncated };
}
/**
 * Deterministic rendering of the snapshot the collector took, within the reviewer's budget. An
 * incomplete snapshot is said so up front: the reviewer lists what it then could not examine.
 */
export function renderContext(
  context: ReviewContext | null,
  maxBytes: number,
): { text: string; truncated: boolean } {
  // A change collected before snapshots existed has none; the diff is still complete.
  if (context === null)
    return { text: 'No repository snapshot was taken for this change.', truncated: false };
  // Everything rendered is charged against the budget, the review sandbox's input is bounded.
  let omittedNames = context.omitted;
  if (omittedNames.join(', ').length > OMITTED_LIST_BYTES) {
    const kept = omittedNames.slice(0, Math.max(1, Math.floor(omittedNames.length / 2)));
    while (kept.length > 1 && kept.join(', ').length > OMITTED_LIST_BYTES) kept.pop();
    omittedNames = kept;
  }
  const omittedList = omittedNames.join(', ');
  const more = context.omittedCount - omittedNames.length;
  const omitted =
    omittedNames.length > 0
      ? ` Omitted: ${omittedList}${more > 0 ? ` and ${more} more` : ''}.`
      : '';
  const parts: string[] = [];
  let bytes = Buffer.byteLength(omitted) + Buffer.byteLength(SNAPSHOT_EXCLUSION_RULE) + 96;
  let truncated = context.truncated;
  for (const file of context.files) {
    const rendered = `=== ${file.path}\n${file.content}\n`;
    bytes += Buffer.byteLength(rendered) + 1;
    if (bytes > maxBytes) {
      truncated = true;
      break;
    }
    parts.push(rendered);
  }
  const heading = `${truncated ? 'INCOMPLETE' : 'Complete'} snapshot of the candidate repository's text files (${SNAPSHOT_EXCLUSION_RULE}).${omitted}`;
  return { text: `${heading}\n\n${parts.join('\n')}`, truncated };
}
/** The omitted list is bounded too; beyond it the count says how many more. */
const OMITTED_LIST_BYTES = 64 * 1024;
/** What sandbox/review.ts reads at most, JSON-encoded; the budgets are on raw text. */
const REVIEW_SANDBOX_INPUT_BYTES = 4 * 1024 * 1024;
/**
 * The diff and the snapshot within their budgets, then shrunk until their JSON encoding fits the
 * sandbox's input limit: the snapshot gives way first (it is context), the diff last (a cut diff
 * is a limitation the receipt reports).
 */
export function fitReviewInput(
  request: ReviewRequest,
  config: ReviewerConfig,
): { text: string; truncated: boolean; context: { text: string; truncated: boolean } } {
  let diffBudget = config.maxDiffBytes;
  let contextBudget = config.maxContextBytes;
  for (;;) {
    const diff = renderDiff(request.changes, diffBudget);
    const context = renderContext(request.context, contextBudget);
    const encoded = Buffer.byteLength(
      JSON.stringify({ intent: request.intent, diff: diff.text, context: context.text }),
    );
    if (encoded <= REVIEW_SANDBOX_INPUT_BYTES - 64 * 1024)
      return { text: diff.text, truncated: diff.truncated, context };
    if (contextBudget > 1024) contextBudget = Math.floor(contextBudget / 2);
    else if (diffBudget > 10_000) diffBudget = Math.floor(diffBudget / 2);
    else return { text: diff.text, truncated: true, context };
  }
}
function receiptsSummary(request: ReviewRequest): string {
  const acceptance = request.acceptance;
  const lines = [
    acceptance
      ? `Protected acceptance: ${acceptance.status}; ${acceptance.protectedSuite.passed}/${acceptance.protectedSuite.total} passed; reproducer baseline=${acceptance.reproducer.baseline}, candidate=${acceptance.reproducer.candidate}; tests modified source: ${acceptance.sourceModifiedByTests}.`
      : 'Protected acceptance: no receipt.',
    request.dependency
      ? `Dependency verification: ${request.dependency.status}; resolution ${request.dependency.resolution}; ${request.dependency.findings.length} finding(s) at or above reporting floor.`
      : 'Dependency verification: not run.',
  ];
  return lines.join('\n');
}
function base(
  request: ReviewRequest,
  config: ReviewerConfig,
  now: number,
): Omit<ReviewReceipt, 'status' | 'risk' | 'categories' | 'findings' | 'limitations'> {
  // Only prompt 2 of the model reviewer puts the snapshot in front of the model.
  const shown =
    config.adapter === 'claude' && config.promptVersion >= 2 && request.context !== null;
  return {
    version: 1,
    kind: 'review',
    runId: randomUUID(),
    subject: request.subject,
    intentSha256: request.intentSha256,
    reviewerConfigSha256: reviewerConfigDigest(config),
    context: 'fresh',
    snapshot: !shown
      ? 'none'
      : renderContext(request.context, config.maxContextBytes).truncated
        ? 'incomplete'
        : 'complete',
    completedAt: now,
  };
}
/** Strict parse of a model verdict into receipt fields; anything odd becomes `error`. */
export function parseVerdict(
  value: unknown,
): Pick<ReviewReceipt, 'risk' | 'categories' | 'findings' | 'limitations'> {
  requireRecord(value, ['risk', 'categories', 'findings', 'limitations'], 'verdict_invalid');
  const verdict = value as {
    risk: unknown;
    categories: unknown;
    findings: unknown;
    limitations: unknown;
  };
  requireAutonomy(verdict.risk === 'routine' || verdict.risk === 'critical', 'verdict_invalid');
  requireUniqueList<string>(verdict.categories, 0, CRITICAL_CATEGORIES.length, 'verdict_invalid');
  for (const category of verdict.categories)
    requireAutonomy(
      (CRITICAL_CATEGORIES as readonly string[]).includes(category),
      'verdict_invalid',
    );
  requireAutonomy(
    (verdict.risk === 'routine') === (verdict.categories.length === 0),
    'verdict_invalid',
  );
  requireUniqueList<unknown>(verdict.findings, 0, 200, 'verdict_invalid');
  const findings: ReviewFinding[] = [];
  const ids = new Set<string>();
  for (const finding of verdict.findings) {
    requireRecord(finding, ['id', 'severity', 'summary', 'location'], 'verdict_invalid');
    const entry = finding as unknown as ReviewFinding;
    requireAutonomy(
      typeof entry.id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(entry.id) && !ids.has(entry.id),
      'verdict_invalid',
    );
    ids.add(entry.id);
    requireAutonomy(
      (FINDING_SEVERITIES as readonly unknown[]).includes(entry.severity),
      'verdict_invalid',
    );
    requireText(entry.summary, 2000, 'verdict_invalid');
    requireText(entry.location, 1024, 'verdict_invalid');
    findings.push({
      id: entry.id,
      severity: entry.severity,
      summary: entry.summary,
      location: entry.location,
    });
  }
  requireUniqueList<string>(verdict.limitations, 0, 50, 'verdict_invalid');
  for (const limitation of verdict.limitations) requireText(limitation, 500, 'verdict_invalid');
  return {
    risk: verdict.risk,
    categories: verdict.categories as CriticalCategory[],
    findings,
    limitations: verdict.limitations,
  };
}

/**
 * Credential-free reviewer for demo mode and tests. Reads markers in added lines:
 * `FIXTURE_REVIEW_FINDING:<severity>` and `FIXTURE_REVIEW_CRITICAL:<category>`.
 */
export class FixtureReviewer implements Reviewer {
  readonly config = FIXTURE_REVIEWER;
  constructor(private readonly now: () => number = Date.now) {}
  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    const findings: ReviewFinding[] = [];
    const categories = new Set<CriticalCategory>();
    for (const file of request.changes.files) {
      for (const line of (file.newContent ?? '').split('\n')) {
        const finding = /FIXTURE_REVIEW_FINDING:(high|medium|low)/.exec(line);
        if (finding)
          findings.push({
            id: `F${findings.length + 1}`,
            severity: finding[1] as ReviewFinding['severity'],
            summary: 'Fixture finding',
            location: file.newPath ?? file.oldPath ?? 'unknown',
          });
        const critical = /FIXTURE_REVIEW_CRITICAL:([a-z_]+)/.exec(line);
        if (critical && (CRITICAL_CATEGORIES as readonly string[]).includes(critical[1] as string))
          categories.add(critical[1] as CriticalCategory);
      }
    }
    const { truncated } = renderDiff(request.changes, this.config.maxDiffBytes);
    return {
      receipt: {
        ...base(request, this.config, this.now()),
        status: 'complete',
        risk: categories.size ? 'critical' : 'routine',
        categories: [...categories].sort(),
        findings,
        limitations: truncated ? ['diff_truncated'] : [],
      },
      reason: null,
      usage: null,
    };
  }
}

export interface ClaudeReviewerOptions {
  docker?: Docker;
  image: string;
  modelKey: string;
  config: ReviewerConfig;
  timeoutMs?: number;
  now?: () => number;
}
/** Model reviewer through the fixed-origin proxy; the sandbox never holds the key. */
export class ClaudeReviewer implements Reviewer {
  readonly config: ReviewerConfig;
  constructor(private readonly options: ClaudeReviewerOptions) {
    requireAutonomy(options.config.adapter === 'claude', 'reviewer_adapter_mismatch');
    requireAutonomy(
      typeof options.config.model === 'string' &&
        /^claude-[A-Za-z0-9.-]{1,93}$/.test(options.config.model),
      'reviewer_model_invalid',
    );
    this.config = options.config;
  }
  async review(request: ReviewRequest, signal: AbortSignal): Promise<ReviewOutcome> {
    const now = this.options.now ?? Date.now;
    const { text, truncated, context } = fitReviewInput(request, this.config);
    const runId = randomUUID();
    const timeoutMs = this.options.timeoutMs ?? 600_000;
    let status: ReviewReceipt['status'] = 'error';
    let reason: string | null = null;
    let verdict: ReturnType<typeof parseVerdict> | null = null;
    let usage: Record<string, number> | null = null;
    try {
      const result = await withProxy(
        {
          docker: this.options.docker,
          image: this.options.image,
          runId,
          apiKey: this.options.modelKey,
          model: this.config.model as string,
          maxRequests: 2,
          timeoutMs: timeoutMs + 30_000,
          signal,
        },
        (egressVolume) =>
          runSandbox({
            docker: this.options.docker,
            image: this.options.image,
            runId,
            entry: 'src/autonomy/sandbox/review.ts',
            input: {
              model: this.config.model,
              maxTokens: this.config.maxTokens,
              promptVersion: this.config.promptVersion,
              intent: request.intent,
              diff: text,
              context: context.text,
              receipts: receiptsSummary(request),
            },
            timeoutMs,
            signal,
            egressVolume,
            memory: '1g',
            cpus: '1',
            pidsLimit: 64,
          }),
      );
      const output = result.output as {
        ok?: unknown;
        status?: unknown;
        reason?: unknown;
        verdict?: unknown;
        usage?: unknown;
      };
      if (output.ok !== true) reason = 'review_sandbox_failed';
      else if (output.status !== 'complete') {
        reason =
          typeof output.reason === 'string' && /^[a-z_]{1,64}$/.test(output.reason)
            ? output.reason
            : 'review_failed';
      } else {
        try {
          verdict = parseVerdict(output.verdict);
          status = 'complete';
        } catch {
          reason = 'verdict_invalid';
        }
      }
      if (output.usage && typeof output.usage === 'object' && !Array.isArray(output.usage)) {
        usage = Object.fromEntries(
          Object.entries(output.usage as Record<string, unknown>).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === 'number' && Number.isFinite(entry[1]),
          ),
        );
      }
      if (JSON.stringify(result.output).includes(this.options.modelKey)) {
        status = 'error';
        reason = 'credential_in_review_output';
        verdict = null;
      }
    } catch (error) {
      reason =
        error instanceof Error && error.message === 'sandbox_timed_out'
          ? 'review_timed_out'
          : 'review_sandbox_failed';
      if (reason === 'review_timed_out') status = 'timeout';
    }
    const limitations = verdict ? [...verdict.limitations] : [];
    if (truncated && !limitations.includes('diff_truncated')) limitations.push('diff_truncated');
    return {
      receipt: {
        ...base(request, this.config, now()),
        status,
        risk: verdict?.risk ?? 'critical',
        categories: verdict?.categories ?? [],
        findings: verdict?.findings ?? [],
        limitations,
      },
      reason,
      usage,
    };
  }
}
