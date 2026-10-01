import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CodingJob, CodingOutcome } from '../worker/protocol.js';
import type { AcceptanceBundle, AcceptanceRun } from './acceptance.js';
import type { CollectedChange, ReviewContext } from './collector.js';
import { type ActionRequest, type Decision, actionDigest, parseRequest } from './decision.js';
import type { DependencyVerificationRun } from './dependency.js';
import type { ApprovalRecord } from './evidence.js';
import type { ApprovalStore, AutonomyLedger } from './ledger.js';
import type { AutonomyPolicy } from './policy.js';
import type { Publication, PublishInput } from './publisher.js';
import { UncertainPublication, publicationBranch } from './publisher.js';
import type { Reviewer } from './reviewer.js';
import type { AutonomyRun, AutonomyRuns, RunState } from './runs.js';
import { AutonomyError, requireAutonomy, sha256Json } from './schema.js';

/**
 * Durable controller for bounded autonomy: admits work through the ledger, drives
 * the existing supervisor, collects the frozen change, gathers trusted receipts,
 * asks the policy, publishes when allowed and records every step on the run row.
 * Each step is a compare-and-set transition, so a restarted or duplicated controller
 * resumes where the last one stopped and never repeats paid or external work.
 */
/** Outcomes the controller cannot know: the worker may still run or may have run to completion. */
const UNCERTAIN_EXECUTION_REASONS: ReadonlySet<string> = new Set([
  'worker_cleanup_failed',
  'worker_lease_lost',
  'supervisor_database_lost',
  'coding_job_dead',
]);
/** Supervisor refusals that mean another process holds the repository or the job, not that the job failed. */
const EXECUTION_BUSY_REASONS: ReadonlySet<string> = new Set([
  'coding_job_already_supervised',
  'coding_job_lease_still_active',
  'coding_job_not_claimable',
]);
export interface TaskDefinition {
  prompt: string;
  tests: string[];
  model?: string;
  maxTurns: number;
  timeoutMs: number;
  maxBudgetUsd?: number;
  fixtureCommand?: string;
}
export interface LoadedTask {
  /** Stable identity used by scopes and the policy: the issue node id. */
  id: string;
  issueId: number;
  number: number;
  title: string;
  body: string;
  intentKind: 'change' | 'bugfix';
  definition: TaskDefinition;
  /** Current default-branch head the change is built from. */
  sourceCommit: string;
  /** The Task's single status label; `status:proposed` until publication pairs it. */
  status: string;
}
export interface TaskSource {
  load(taskNumber: number): Promise<LoadedTask>;
  archive(sourceCommit: string, signal: AbortSignal): Promise<Buffer>;
}
export interface ExecutionResult {
  outcome: CodingOutcome;
  workId: string;
  runId?: string;
  cached: boolean;
}
export interface Executor {
  run(job: CodingJob, archive: Buffer, signal: AbortSignal): Promise<ExecutionResult>;
  cancel(jobId: string): Promise<number>;
  /** Whether the paid worker container may have started for this job (settles spend as uncertain). */
  mayHaveStarted(jobId: string): Promise<boolean>;
}
export interface ControllerAdapters {
  pool: Pool;
  ledger: AutonomyLedger;
  runs: AutonomyRuns;
  approvals: ApprovalStore;
  taskSource: TaskSource;
  executor: Executor;
  collect(archive: Buffer, patch: string, signal: AbortSignal): Promise<CollectedChange>;
  acceptance(input: {
    archive: Buffer;
    patch: string;
    baseTree: string;
    candidateTree: string;
    subject: ActionRequest['task'] & {
      repositoryId: number;
      base: string;
      tree: string;
      changesSha256: string;
      taskId: string;
    };
    intentKind: 'change' | 'bugfix';
    signal: AbortSignal;
  }): Promise<AcceptanceRun>;
  reviewer: Reviewer;
  dependency:
    | ((input: {
        archive: Buffer;
        patch: string;
        candidateTree: string;
        manifestPaths: string[];
        subject: {
          repositoryId: number;
          taskId: string;
          base: string;
          tree: string;
          changesSha256: string;
        };
        signal: AbortSignal;
      }) => Promise<DependencyVerificationRun>)
    | null;
  /** Performs one publication (fixture host or GitHub); null disables publication. */
  publisher: ((input: PublishInput) => Promise<Publication>) | null;
  /** Records the PR pair and links the run (existing merge-gate tracking). */
  afterPublish?: (run: AutonomyRun, publication: Publication) => Promise<void>;
  bundle: AcceptanceBundle;
  policy: AutonomyPolicy;
  repository: { id: number; installationId: number; fullName: string; baseBranch: string };
  mode: 'demo' | 'live';
  actor: string;
  now?: () => number;
}
export interface ProcessResult {
  run: AutonomyRun;
  decisions: Decision[];
}
/** A stable request id for one intended action, so duplicate events deduplicate in the ledger. */
export const deterministicRequestId = (seed: string) => {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
export interface RepositoryIdentityForPolicy {
  id: number;
  installationId: number;
  baseBranch: string;
}
export function buildRequest(
  policy: AutonomyPolicy,
  repository: RepositoryIdentityForPolicy,
  base: Omit<ActionRequest, 'version' | 'requestId' | 'policySha256' | 'repository'>,
  seed: string,
): ActionRequest {
  return parseRequest(policy, {
    version: 1,
    requestId: deterministicRequestId(seed),
    policySha256: sha256Json(policy),
    repository: {
      id: repository.id,
      installationId: repository.installationId,
      baseBranch: repository.baseBranch,
    },
    ...base,
  });
}
/**
 * Decide and, when allowed, consume the admission once. A crashed controller that already
 * consumed this request continues with the recorded admission. Only approvals by configured
 * approvers can unlock an action; an unauthorized one is passed on for the decision to refuse.
 */
export async function admitAction(
  ledger: AutonomyLedger,
  approvals: ApprovalStore,
  policy: AutonomyPolicy,
  repositoryId: number,
  request: ActionRequest,
  evidence: Record<string, unknown>,
  now: number,
): Promise<{ decision: Decision; decisionId: string; reservationId: string | null }> {
  const prior = await ledger.consumedAdmission(request.requestId);
  if (prior) return prior;
  const recorded = await approvals.forAction(repositoryId, actionDigest(request));
  const { decision, decisionId } = await decideAction(
    ledger,
    policy,
    request,
    evidence,
    chooseApproval(policy, request, recorded),
    now,
  );
  if (decision.outcome !== 'allow') return { decision, decisionId, reservationId: null };
  const consumed = await ledger.consume(decisionId, now);
  return { decision, decisionId, reservationId: consumed.reservationId };
}
/** A configured approver's record when one exists; otherwise the first, for the decision to refuse. */
export function chooseApproval(
  policy: AutonomyPolicy,
  request: ActionRequest,
  recorded: ApprovalRecord[],
): ApprovalRecord | undefined {
  return (
    recorded.find(
      (approval) =>
        approval.action === request.action &&
        policy.approvers.githubUserIds.includes(approval.approver.githubUserId),
    ) ?? recorded[0]
  );
}
/**
 * Decide and record without consuming. The merge controller consumes immediately before the
 * merge call, so an admission that dies first (TTL, policy change, withdrawn review) spends
 * nothing and the same human approval can admit the merge again.
 */
export async function decideAction(
  ledger: AutonomyLedger,
  policy: AutonomyPolicy,
  request: ActionRequest,
  evidence: Record<string, unknown>,
  approval: ApprovalRecord | undefined,
  now: number,
): Promise<{ decision: Decision; decisionId: string }> {
  const withApproval = approval ? { ...evidence, approval } : evidence;
  return ledger.admit(policy, request, withApproval, now);
}
/**
 * The Task's intent: title, body, definition and kind. Publication writes the `pr-ref:`
 * backlink into the body (merge-gate pairing); that line is the factory's, not the owner's,
 * and is left out so the intent an owner granted survives pairing.
 */
export function intentDigest(
  task: Pick<LoadedTask, 'title' | 'body' | 'definition' | 'intentKind'>,
): string {
  return sha256Json({
    title: task.title,
    body: task.body
      .split(/\r?\n/)
      .filter((line) => !/^\s*pr-ref:/.test(line))
      .join('\n')
      .replace(/\s+$/, ''),
    definition: task.definition,
    intentKind: task.intentKind,
  });
}
/** Findings from the previous attempt, appended verbatim as data the author must address. */
export function revisionPrompt(
  prompt: string,
  findings: { id: string; severity: string; summary: string; location: string }[],
  reasons: string[],
): string {
  const lines = [
    prompt,
    '',
    '# Revision required',
    'The previous attempt was not accepted. Address every item below in full; do not weaken or skip tests.',
    ...findings.map(
      (finding) =>
        `- [${finding.severity}] ${finding.id} at ${finding.location}: ${finding.summary}`,
    ),
    ...reasons
      .filter((reason) => !reason.startsWith('review_finding_'))
      .map((reason) => `- ${reason}`),
  ];
  return lines.join('\n');
}

export class AutonomyController {
  private readonly now: () => number;
  constructor(private readonly adapters: ControllerAdapters) {
    this.now = adapters.now ?? Date.now;
  }
  private get policy() {
    return this.adapters.policy;
  }
  private request(
    base: Omit<ActionRequest, 'version' | 'requestId' | 'policySha256' | 'repository'>,
    seed: string,
  ): ActionRequest {
    return buildRequest(this.policy, this.adapters.repository, base, seed);
  }
  private async decideAndAdmit(
    request: ActionRequest,
    evidence: Record<string, unknown>,
  ): Promise<{ decision: Decision; decisionId: string; reservationId: string | null }> {
    return admitAction(
      this.adapters.ledger,
      this.adapters.approvals,
      this.policy,
      this.adapters.repository.id,
      request,
      evidence,
      this.now(),
    );
  }
  private codingJob(
    run: AutonomyRun,
    task: LoadedTask,
    archiveSha256: string,
    prompt: string,
    limits: { maxTurns: number; maxRunMs: number; budgetMicrousd: number; model: string },
  ): CodingJob {
    const job: CodingJob = {
      id: `autonomy-${run.runId}`,
      mode: this.adapters.mode,
      repository: this.adapters.repository.fullName,
      sourceCommit: task.sourceCommit,
      archiveSha256,
      prompt,
      maxTurns: limits.maxTurns,
      timeoutMs: limits.maxRunMs,
      tests: task.definition.tests,
    };
    if (this.adapters.mode === 'live') {
      job.model = limits.model;
      job.maxBudgetUsd = Math.max(0.001, Math.min(100, limits.budgetMicrousd / 1_000_000));
    } else job.fixtureCommand = task.definition.fixtureCommand ?? 'exit 1';
    return job;
  }
  private limitsFor(task: LoadedTask) {
    const model = task.definition.model ?? this.policy.execution.models[0] ?? '';
    requireAutonomy(this.policy.execution.models.includes(model), 'model_not_allowed');
    return {
      model,
      maxTurns: Math.min(task.definition.maxTurns, this.policy.execution.maxTurns),
      maxRunMs: Math.min(task.definition.timeoutMs, this.policy.execution.maxRunMs),
      budgetMicrousd: Math.min(
        Math.round(
          (task.definition.maxBudgetUsd ?? this.policy.execution.maxRunMicrousd / 1_000_000) *
            1_000_000,
        ),
        this.policy.execution.maxRunMicrousd,
      ),
    };
  }
  /**
   * Drives one Task forward as far as the evidence allows. Safe to call repeatedly:
   * a finished attempt (published, failed, blocked, cancelled) is returned as is;
   * only `newAttempt` starts another, and the ledger still caps how many there are.
   * One controller per Task at a time: a concurrent invocation fails with
   * `task_run_in_progress` before reading or writing anything.
   */
  async process(
    taskNumber: number,
    scopeId: string,
    signal: AbortSignal,
    options: { newAttempt?: boolean } = {},
  ): Promise<ProcessResult> {
    const repositoryId = this.adapters.repository.id;
    const client = await this.adapters.pool.connect();
    try {
      await lockRows(client, repositoryId, [
        {
          key: taskLockKey(repositoryId, taskNumber),
          mode: 'UPDATE',
          refused: 'task_run_in_progress',
        },
        { key: repositoryLockKey(repositoryId), mode: 'SHARE', refused: 'controller_busy' },
      ]);
      return await this.processLocked(taskNumber, scopeId, signal, options);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
  private async processLocked(
    taskNumber: number,
    scopeId: string,
    signal: AbortSignal,
    options: { newAttempt?: boolean } = {},
  ): Promise<ProcessResult> {
    const decisions: Decision[] = [];
    const task = await this.adapters.taskSource.load(taskNumber);
    const intentSha256 = intentDigest(task);
    let run = await this.adapters.runs.open(this.adapters.repository.id, task.id);
    if (run === null) {
      const latest = await this.adapters.runs.latest(this.adapters.repository.id, task.id);
      // A Task publication paired (backlink, `status:in_review`) is this factory's only while its
      // published attempt exists; anything else in review is someone else's work.
      requireAutonomy(
        task.status === 'status:proposed' || latest?.state === 'published',
        'task_not_proposed',
      );
      if (latest !== null && !options.newAttempt) {
        // Pairing writes the Task's backlink and status: a halted ledger or scope changes nothing.
        const halted = await this.adapters.ledger.halted(
          this.adapters.repository.id,
          latest.scopeId,
          this.now(),
        );
        if (halted !== null) throw new AutonomyError(halted);
        return { run: await this.pairPublication(latest), decisions };
      }
      // A halted ledger or scope refuses before any attempt is recorded.
      const refusal = await this.adapters.ledger.halted(
        this.adapters.repository.id,
        scopeId,
        this.now(),
      );
      if (refusal !== null) throw new AutonomyError(refusal);
      run = await this.adapters.runs.create({
        repositoryId: this.adapters.repository.id,
        scopeId,
        taskId: task.id,
        taskNumber: task.number,
        taskIssueId: task.issueId,
        intentSha256,
        sourceCommit: task.sourceCommit,
      });
    }
    // An uncertain attempt belongs to the operator: nothing here may rewrite it (reconcile does).
    if (run.state === 'unknown') return { run, decisions };
    // Pause, revocation and expiry stop resumption as well as admission; the attempt keeps its state.
    const halted = await this.adapters.ledger.halted(
      this.adapters.repository.id,
      run.scopeId,
      this.now(),
    );
    if (halted !== null) throw new AutonomyError(halted);
    // The Task text or source moved under an open attempt: nothing recorded still applies.
    if (run.intentSha256 !== intentSha256 || run.sourceCommit !== task.sourceCommit) {
      const reason =
        run.intentSha256 !== intentSha256
          ? 'task_changed_during_attempt'
          : 'source_moved_during_attempt';
      if (run.state === 'executing') {
        // A worker may already have run and spent: the attempt is uncertain, never a clean failure.
        if (run.workerJobId) await this.adapters.executor.cancel(run.workerJobId).catch(() => 0);
        if (run.reservationId)
          await this.adapters.ledger
            .settle(run.reservationId, { state: 'unknown' }, this.now())
            .catch(() => undefined);
        run = await this.adapters.runs.transition(run.runId, ['executing'], 'unknown', { reason });
      } else if (run.state === 'publish_admitted') {
        // A controller that stopped after the publisher's branch write leaves this state too: the
        // publication may exist, so the attempt is uncertain until an operator reconciles it.
        run = await this.adapters.runs.transition(run.runId, ['publish_admitted'], 'unknown', {
          reason,
        });
      } else
        run = await this.adapters.runs.transition(run.runId, [run.state], 'failed', { reason });
      return { run, decisions };
    }
    const limits = this.limitsFor(task);
    const attemptPrompt =
      (run.evidence.revisionPrompt as string | undefined) ?? task.definition.prompt;
    const archive = await this.adapters.taskSource.archive(task.sourceCommit, signal);
    const archiveSha256 = createHash('sha256').update(archive).digest('hex');
    let guard = 0;
    while (guard++ < 12) {
      signal.throwIfAborted();
      switch (run.state) {
        case 'admitted': {
          const request = this.request(
            {
              action: 'execute',
              scopeId: run.scopeId,
              task: { id: task.id, intentSha256, intentKind: task.intentKind },
              base: task.sourceCommit,
              head: null,
              tree: null,
              changes: null,
              attempt: run.attempt,
              execution: {
                model: limits.model,
                maxTurns: limits.maxTurns,
                maxRunMs: limits.maxRunMs,
                budgetMicrousd: limits.budgetMicrousd,
              },
            },
            `${run.runId}:execute`,
          );
          let admitted: Awaited<ReturnType<AutonomyController['decideAndAdmit']>>;
          try {
            admitted = await this.decideAndAdmit(request, {});
          } catch (error) {
            // The admission belongs to a concurrent controller; never record it as a refusal.
            if (error instanceof AutonomyError && error.reason === 'request_already_admitted')
              throw new AutonomyError('task_run_in_progress');
            run = await this.adapters.runs.transition(run.runId, ['admitted'], 'blocked', {
              reason: error instanceof AutonomyError ? error.reason : 'admission_failed',
            });
            return { run, decisions };
          }
          decisions.push(admitted.decision);
          if (admitted.decision.outcome === 'approval_required') {
            run = await this.adapters.runs.transition(run.runId, ['admitted'], 'held', {
              reason: 'execute_approval_required',
              executeDecisionId: admitted.decisionId,
              evidence: {
                ...run.evidence,
                executeReasons: admitted.decision.reasons,
                actionSha256: admitted.decision.actionSha256,
              },
            });
            return { run, decisions };
          }
          if (admitted.decision.outcome !== 'allow') {
            run = await this.adapters.runs.transition(run.runId, ['admitted'], 'blocked', {
              reason: admitted.decision.reasons[0]?.code ?? 'execute_blocked',
              executeDecisionId: admitted.decisionId,
            });
            return { run, decisions };
          }
          run = await this.adapters.runs.transition(run.runId, ['admitted'], 'executing', {
            executeDecisionId: admitted.decisionId,
            reservationId: admitted.reservationId,
            workerJobId: `autonomy-${run.runId}`,
            archiveSha256,
            evidence: { ...run.evidence, limits, model: limits.model },
          });
          break;
        }
        case 'held': {
          // A human may have approved since; re-decide the held action with current evidence.
          if (run.reason === 'execute_approval_required') {
            const approvals = await this.adapters.approvals.forAction(
              this.adapters.repository.id,
              String(run.evidence.actionSha256 ?? ''),
            );
            if (approvals.length === 0) return { run, decisions };
            run = await this.adapters.runs.transition(run.runId, ['held'], 'admitted', {
              reason: null,
            });
            break;
          }
          if (run.reason === 'publish_approval_required') {
            const approvals = await this.adapters.approvals.forAction(
              this.adapters.repository.id,
              String(run.evidence.actionSha256 ?? ''),
            );
            if (approvals.length === 0) return { run, decisions };
            // Receipts older than the policy's TTL cannot back the decision: verify again first.
            run = await this.adapters.runs.transition(
              run.runId,
              ['held'],
              this.receiptsStale(run) ? 'collected' : 'verified',
              { reason: null },
            );
            break;
          }
          return { run, decisions };
        }
        case 'executing': {
          const job = this.codingJob(run, task, archiveSha256, attemptPrompt, limits);
          let result: ExecutionResult;
          try {
            result = await this.adapters.executor.run(job, archive, signal);
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'execution_failed';
            // Another supervisor owns the repository or this job: nothing here changed; run again later.
            if (EXECUTION_BUSY_REASONS.has(reason)) throw new AutonomyError('worker_busy');
            // coding_job_dead: the work item died after the lease expired; a worker may have run.
            const uncertainOutcome = UNCERTAIN_EXECUTION_REASONS.has(reason);
            // Spend is certain only when the paid container provably never started.
            const started =
              uncertainOutcome ||
              (await this.adapters.executor.mayHaveStarted(job.id).catch(() => true));
            if (run.reservationId)
              await this.adapters.ledger
                .settle(
                  run.reservationId,
                  started ? { state: 'unknown' } : { state: 'settled', microusd: 0 },
                  this.now(),
                )
                .catch(() => undefined);
            run = await this.adapters.runs.transition(
              run.runId,
              ['executing'],
              uncertainOutcome ? 'unknown' : reason === 'worker_cancelled' ? 'cancelled' : 'failed',
              {
                reason,
              },
            );
            return { run, decisions };
          }
          const estimated = result.outcome.model.costUsd;
          if (run.reservationId)
            await this.adapters.ledger
              .settle(
                run.reservationId,
                estimated === null
                  ? result.outcome.model.mode === 'live' &&
                    result.outcome.model.subtype !== 'fixture_completed'
                    ? { state: 'unknown' }
                    : { state: 'settled', microusd: 0 }
                  : { state: 'settled', microusd: Math.round(estimated * 1_000_000) },
                this.now(),
              )
              .catch(() => undefined);
          if (!result.outcome.ok) {
            run = await this.adapters.runs.transition(run.runId, ['executing'], 'failed', {
              reason: result.outcome.reason,
              evidence: {
                ...run.evidence,
                workerRunId: result.runId ?? null,
                patchSha256: result.outcome.patchSha256,
                // A failed attempt spent too (a max-turns failure still consumed model calls).
                estimatedUsd: estimated,
              },
            });
            return { run, decisions };
          }
          run = await this.adapters.runs.transition(run.runId, ['executing'], 'executed', {
            evidence: {
              ...run.evidence,
              workerRunId: result.runId ?? null,
              patchSha256: result.outcome.patchSha256,
              patch: result.outcome.patch,
              estimatedUsd: estimated,
              testsStatus: result.outcome.testsStatus,
              // What the worker removed before the freeze or saw its tests generate.
              testSideEffects: result.outcome.testSideEffects ?? null,
            },
          });
          break;
        }
        case 'executed': {
          const patch = String(run.evidence.patch ?? '');
          let collected: CollectedChange;
          try {
            collected = await this.adapters.collect(archive, patch, signal);
          } catch (error) {
            run = await this.adapters.runs.transition(run.runId, ['executed'], 'failed', {
              reason: error instanceof AutonomyError ? error.reason : 'collection_failed',
            });
            return { run, decisions };
          }
          run = await this.adapters.runs.transition(run.runId, ['executed'], 'collected', {
            baseTree: collected.baseTree,
            candidateTree: collected.candidateTree,
            changesSha256: sha256Json(collected.manifest),
            evidence: {
              ...run.evidence,
              manifest: collected.manifest,
              blobs: collected.blobs,
              reviewContext: collected.context,
              collectorImage: collected.imageId,
            },
          });
          break;
        }
        case 'collected': {
          const verified = await this.verifyCandidate(run, task, archive, signal);
          run = await this.adapters.runs.transition(run.runId, ['collected'], 'verified', {
            receipts: verified.receipts,
            evidence: { ...run.evidence, ...verified.evidence },
          });
          break;
        }
        case 'verified': {
          const manifest = run.evidence.manifest as CollectedChange['manifest'];
          const request = this.request(
            {
              action: 'publish',
              scopeId: run.scopeId,
              task: { id: task.id, intentSha256, intentKind: task.intentKind },
              base: task.sourceCommit,
              head: null,
              tree: run.candidateTree as string,
              changes: manifest,
              execution: null,
            },
            `${run.runId}:publish`,
          );
          const evidence = { ...run.receipts };
          let admitted: Awaited<ReturnType<AutonomyController['decideAndAdmit']>>;
          try {
            admitted = await this.decideAndAdmit(request, evidence);
          } catch (error) {
            // The admission belongs to a concurrent controller; never record it as a refusal.
            if (error instanceof AutonomyError && error.reason === 'request_already_admitted')
              throw new AutonomyError('task_run_in_progress');
            run = await this.adapters.runs.transition(run.runId, ['verified'], 'blocked', {
              reason: error instanceof AutonomyError ? error.reason : 'publish_admission_failed',
            });
            return { run, decisions };
          }
          decisions.push(admitted.decision);
          const reasons = admitted.decision.reasons.map((reason) => reason.code);
          if (admitted.decision.outcome === 'repair_required') {
            run = await this.adapters.runs.transition(run.runId, ['verified'], 'repair', {
              reason: reasons[0] ?? 'repair_required',
              publishDecisionId: admitted.decisionId,
              evidence: { ...run.evidence, publishReasons: admitted.decision.reasons },
            });
            // Bounded revision: a fresh attempt with the findings appended; the ledger caps attempts.
            const findings = (
              (
                run.receipts.review as
                  | {
                      findings?: {
                        id: string;
                        severity: string;
                        summary: string;
                        location: string;
                      }[];
                    }
                  | undefined
              )?.findings ?? []
            ).filter((finding) => finding.severity !== 'low');
            const next = await this.adapters.runs
              .create({
                repositoryId: this.adapters.repository.id,
                scopeId: run.scopeId,
                taskId: task.id,
                taskNumber: task.number,
                taskIssueId: task.issueId,
                intentSha256,
                sourceCommit: task.sourceCommit,
              })
              .catch(() => null);
            if (next === null) return { run, decisions };
            run = await this.adapters.runs.transition(next.runId, ['admitted'], 'admitted', {
              evidence: {
                revisionPrompt: revisionPrompt(task.definition.prompt, findings, reasons),
                previousAttempt: run.runId,
              },
            });
            return {
              run: await this.continueFrom(run, task, scopeId, signal, decisions),
              decisions,
            };
          }
          if (admitted.decision.outcome === 'approval_required') {
            run = await this.adapters.runs.transition(run.runId, ['verified'], 'held', {
              reason: 'publish_approval_required',
              publishDecisionId: admitted.decisionId,
              evidence: {
                ...run.evidence,
                publishReasons: admitted.decision.reasons,
                actionSha256: admitted.decision.actionSha256,
              },
            });
            return { run, decisions };
          }
          if (admitted.decision.outcome !== 'allow') {
            run = await this.adapters.runs.transition(run.runId, ['verified'], 'blocked', {
              reason: reasons[0] ?? 'publish_blocked',
              publishDecisionId: admitted.decisionId,
              evidence: { ...run.evidence, publishReasons: admitted.decision.reasons },
            });
            return { run, decisions };
          }
          if (this.adapters.publisher === null) {
            run = await this.adapters.runs.transition(run.runId, ['verified'], 'held', {
              reason: 'publication_disabled',
              publishDecisionId: admitted.decisionId,
            });
            return { run, decisions };
          }
          run = await this.adapters.runs.transition(run.runId, ['verified'], 'publish_admitted', {
            publishDecisionId: admitted.decisionId,
            evidence: { ...run.evidence, publishReasons: admitted.decision.reasons },
          });
          break;
        }
        case 'publish_admitted': {
          const publisher = this.adapters.publisher;
          requireAutonomy(publisher !== null, 'publication_disabled');
          const manifest = run.evidence.manifest as CollectedChange['manifest'];
          const previous = await this.previousPublication(task.id, run.attempt);
          let publication: Publication;
          try {
            publication = await publisher({
              base: task.sourceCommit,
              baseTree: run.baseTree,
              candidateTree: run.candidateTree as string,
              manifest,
              blobs: (run.evidence.blobs as Record<string, string>) ?? {},
              branch: previous?.branch ?? publicationBranch(task.number, run.runId),
              baseBranch: this.adapters.repository.baseBranch,
              title: task.title.slice(0, 200),
              body: this.pullBody(task, run),
              message: `${task.title.slice(0, 72)}\n\nfactory-run: ${run.runId}\nfactory-tree: ${run.candidateTree}\nSF-Actor: factory`,
              previousHead: previous?.head ?? null,
            });
          } catch (error) {
            // After a branch write the publication may exist: uncertain until an operator
            // reconciles it. Before any write nothing happened: the run stays publish_admitted
            // and the next `run` retries the publication alone.
            if (error instanceof UncertainPublication) {
              run = await this.adapters.runs.transition(
                run.runId,
                ['publish_admitted'],
                'unknown',
                {
                  reason: error.reason,
                },
              );
              return { run, decisions };
            }
            throw error;
          }
          run = await this.adapters.runs.transition(run.runId, ['publish_admitted'], 'published', {
            publication: { ...publication },
          });
          run = await this.pairPublication(run);
          return { run, decisions };
        }
        default:
          return { run, decisions };
      }
    }
    throw new AutonomyError('controller_step_limit');
  }
  private async continueFrom(
    run: AutonomyRun,
    _task: LoadedTask,
    scopeId: string,
    signal: AbortSignal,
    decisions: Decision[],
  ): Promise<AutonomyRun> {
    const next = await this.processLocked(run.taskNumber, scopeId, signal);
    decisions.push(...next.decisions);
    return next.run;
  }
  /**
   * Fresh protected acceptance, review and (when manifests changed) dependency receipts for
   * the run's candidate, from the base archive and the recorded worker patch. Used once
   * before publication and again by the merger when receipts have expired: the
   * same inputs rebuild the same tree, so the receipts bind to the same subject.
   */
  async verifyCandidate(
    run: AutonomyRun,
    task: LoadedTask,
    archive: Buffer,
    signal: AbortSignal,
  ): Promise<{ receipts: Record<string, unknown>; evidence: Record<string, unknown> }> {
    const manifest = run.evidence.manifest as CollectedChange['manifest'];
    const patch = String(run.evidence.patch ?? '');
    const intentSha256 = intentDigest(task);
    requireAutonomy(run.intentSha256 === intentSha256, 'task_changed_since_attempt');
    const subject = {
      repositoryId: this.adapters.repository.id,
      taskId: task.id,
      // The attempt's own base: re-verifying a published head must not follow a moved default branch.
      base: run.sourceCommit as string,
      tree: run.candidateTree as string,
      changesSha256: run.changesSha256 as string,
    };
    const acceptance = await this.adapters.acceptance({
      archive,
      patch,
      baseTree: run.baseTree as string,
      candidateTree: run.candidateTree as string,
      subject: { ...subject, id: task.id, intentSha256, intentKind: task.intentKind },
      intentKind: task.intentKind,
      signal,
    });
    const review = await this.adapters.reviewer.review(
      {
        subject,
        intent: { title: task.title, body: task.body, kind: task.intentKind },
        intentSha256,
        changes: manifest,
        context: (run.evidence.reviewContext as ReviewContext | undefined) ?? null,
        acceptance: acceptance.receipt,
        dependency: null,
      },
      signal,
    );
    let dependency: DependencyVerificationRun | null = null;
    const manifestPaths = this.manifestPaths(manifest);
    if (manifestPaths.length > 0 && this.adapters.dependency && this.policy.dependencies !== null)
      dependency = await this.adapters.dependency({
        archive,
        patch,
        candidateTree: run.candidateTree as string,
        manifestPaths,
        subject,
        signal,
      });
    return {
      receipts: {
        acceptance: acceptance.receipt,
        review: review.receipt,
        ...(dependency ? { dependency: dependency.receipt } : {}),
      },
      evidence: {
        acceptanceReason: acceptance.reason,
        reviewReason: review.reason,
        reviewUsage: review.usage,
        dependencyReason: dependency?.reason ?? null,
      },
    };
  }
  /**
   * Pairing and tracking run after the terminal `published` transition and are recorded
   * on the publication; a failure is retried by the next `run` instead of being lost.
   */
  private async pairPublication(run: AutonomyRun): Promise<AutonomyRun> {
    const publication = run.publication as (Publication & { paired?: boolean }) | null;
    if (run.state !== 'published' || publication === null || publication.paired === true)
      return run;
    if (!this.adapters.afterPublish) return run;
    await this.adapters.afterPublish(run, publication);
    return this.adapters.runs.transition(run.runId, ['published'], 'published', {
      publication: { ...publication, paired: true },
    });
  }
  private receiptsStale(run: AutonomyRun): boolean {
    const ttl = this.policy.verification.receiptTtlMs;
    return ['acceptance', 'review', 'dependency'].some((kind) => {
      const completedAt = (run.receipts[kind] as { completedAt?: unknown } | undefined)
        ?.completedAt;
      return typeof completedAt === 'number' && this.now() - completedAt > ttl;
    });
  }
  private manifestPaths(manifest: CollectedChange['manifest']): string[] {
    // Mirrors the classifier: only data manifests that still exist can be covered by a receipt.
    const surviving = new Set(
      manifest.files.map((file) => file.newPath).filter((path): path is string => path !== null),
    );
    const pattern =
      /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/i;
    return [...surviving].filter((path) => pattern.test(path)).sort();
  }
  private async previousPublication(
    taskId: string,
    attempt: number,
  ): Promise<{ branch: string; head: string } | null> {
    if (attempt <= 1) return null;
    const rows = await this.adapters.pool.query(
      "SELECT publication FROM factory_autonomy_runs WHERE repository_id=$1 AND task_id=$2 AND attempt<$3 AND state='published' ORDER BY attempt DESC LIMIT 1",
      [this.adapters.repository.id, taskId, attempt],
    );
    const publication = rows.rows[0]?.publication as { branch?: string; head?: string } | undefined;
    return publication?.branch && publication.head
      ? { branch: publication.branch, head: publication.head }
      : null;
  }
  private pullBody(task: LoadedTask, run: AutonomyRun): string {
    const receipts = run.receipts as {
      acceptance?: { status: string; protectedSuite: { passed: number; total: number } };
      review?: { risk: string; findings: unknown[] };
      dependency?: { status: string; resolution: string };
    };
    return [
      `task-ref: ${task.id}`,
      `factory-run: ${run.runId}`,
      `factory-attempt: ${run.attempt}`,
      `factory-source: ${task.sourceCommit}`,
      `factory-tree: ${run.candidateTree}`,
      '',
      `Automated change for Task #${task.number} produced by BNIK Software Factory under the repository's autonomy policy.`,
      '',
      '## Evidence',
      `- Protected acceptance: ${receipts.acceptance?.status ?? 'not run'} (${receipts.acceptance?.protectedSuite.passed ?? 0}/${receipts.acceptance?.protectedSuite.total ?? 0})`,
      `- Separate review: risk ${receipts.review?.risk ?? 'unknown'}, ${receipts.review?.findings.length ?? 0} finding(s)`,
      `- Dependency verification: ${receipts.dependency ? `${receipts.dependency.status}, lockfile ${receipts.dependency.resolution}` : 'not applicable'}`,
      '',
      'Statements in this description are copied from trusted receipts; the merge decision is made by the policy and required checks on the current head, never by this text.',
    ].join('\n');
  }
  /** Marks the open attempt cancelled and asks the supervisor to stop any running job. */
  /**
   * Operator cancellation under the Task lock. While a controller drives the attempt the
   * lock is held: if its worker is running, cancellation is requested from the worker and
   * that controller records the outcome; in any other step nothing can be cancelled safely
   * right now (`task_run_in_progress`).
   */
  async cancel(
    taskNumber: number,
  ): Promise<{ cancelled: boolean; state: RunState | null; requested?: number }> {
    const repositoryId = this.adapters.repository.id;
    const task = await this.adapters.taskSource.load(taskNumber);
    const client = await this.adapters.pool.connect();
    try {
      let locked = true;
      await lockRows(client, repositoryId, [
        {
          key: taskLockKey(repositoryId, taskNumber),
          mode: 'UPDATE',
          refused: 'task_run_in_progress',
        },
      ]).catch((error) => {
        if (error instanceof AutonomyError && error.reason === 'task_run_in_progress')
          locked = false;
        else throw error;
      });
      const run = await this.adapters.runs.open(repositoryId, task.id);
      if (!run) return { cancelled: false, state: null };
      // An uncertain attempt is settled by reconcile, never cancelled away.
      if (run.state === 'unknown') throw new AutonomyError('reconcile_required');
      if (!locked) {
        if (run.state === 'executing' && run.workerJobId) {
          const requested = await this.adapters.executor.cancel(run.workerJobId).catch(() => 0);
          return { cancelled: false, state: run.state, requested };
        }
        throw new AutonomyError('task_run_in_progress');
      }
      if (run.workerJobId) await this.adapters.executor.cancel(run.workerJobId).catch(() => 0);
      // The reservation is open only while executing, and the worker may have spent: uncertain.
      if (run.reservationId && run.state === 'executing')
        await this.adapters.ledger
          .settle(run.reservationId, { state: 'unknown' }, this.now())
          .catch(() => undefined);
      const updated = await this.adapters.runs.transition(run.runId, [run.state], 'cancelled', {
        reason: 'operator_cancelled',
      });
      return { cancelled: true, state: updated.state };
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
  /** Operator settlement of an uncertain attempt or reservation; see reconcileRun. */
  async reconcile(
    runId: string,
    settlement: { state: 'settled'; microusd: number } | { state: 'released' },
  ): Promise<AutonomyRun> {
    return reconcileRun(
      this.adapters.pool,
      this.adapters.ledger,
      this.adapters.runs,
      this.adapters.repository.id,
      runId,
      settlement,
      this.now(),
    );
  }
}

export function taskLockKey(repositoryId: number, taskNumber: number): string {
  return `Task:${repositoryId}:${taskNumber}`;
}
export function repositoryLockKey(repositoryId: number): string {
  return `Repository:${repositoryId}`;
}
/**
 * Serializes controller commands on rows of factory_autonomy_locks, held by the caller's
 * client until it rolls back. NOWAIT: a held row means another command is active, and the
 * caller reports that instead of waiting. The runtime role has no privilege on the table.
 */
/** Longer than any single controller command (a run is bounded by the policy's maxRunMs). */
export const LOCK_SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export async function lockRows(
  client: PoolClient,
  repositoryId: number,
  locks: { key: string; mode: 'UPDATE' | 'SHARE'; refused: string }[],
): Promise<void> {
  for (const lock of locks)
    await client.query(
      'INSERT INTO factory_autonomy_locks(lock_key,repository_id) VALUES($1,$2) ON CONFLICT (lock_key) DO NOTHING',
      [lock.key, repositoryId],
    );
  await client.query('BEGIN');
  // The lock transaction idles while the author works, longer than the pool's 15 s
  // idle-in-transaction timeout (database.ts); the lock must hold for the whole command, and
  // a wedged-but-alive controller must still lose it eventually.
  await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${LOCK_SESSION_TIMEOUT_MS}`);
  for (const lock of locks) {
    try {
      await client.query(
        `SELECT 1 FROM factory_autonomy_locks WHERE lock_key=$1 FOR ${lock.mode} NOWAIT`,
        [lock.key],
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string }).code === '55P03') throw new AutonomyError(lock.refused);
      throw error;
    }
  }
}
/** Runs `work` only while no controller command holds the repository (recovery sweeps). */
export async function quiesceController<T>(
  pool: Pool,
  repositoryId: number,
  work: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await lockRows(client, repositoryId, [
      { key: repositoryLockKey(repositoryId), mode: 'UPDATE', refused: 'controller_busy' },
    ]);
    return await work();
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
/**
 * Operator settlement shared by the CLI and the controller: closes a reservation that is
 * still `reserved` or `unknown` (whatever the run's state) and frees an `unknown` attempt
 * for a new one. A reservation the controller already settled is left alone.
 */
export async function reconcileRun(
  pool: Pool,
  ledger: AutonomyLedger,
  runs: AutonomyRuns,
  repositoryId: number,
  runId: string,
  settlement: { state: 'settled'; microusd: number } | { state: 'released' },
  now: number,
): Promise<AutonomyRun> {
  const run = await runs.get(runId);
  requireAutonomy(run !== null && run.repositoryId === repositoryId, 'run_missing');
  const reservationState = run.reservationId
    ? ((
        await pool.query<{ state: string }>(
          'SELECT state FROM factory_autonomy_reservations WHERE reservation_id=$1',
          [run.reservationId],
        )
      ).rows[0]?.state ?? null)
    : null;
  const open = reservationState === 'reserved' || reservationState === 'unknown';
  requireAutonomy(
    open || ['unknown', 'cancelled'].includes(run.state),
    'reconcile_requires_uncertain_run_or_reservation',
  );
  if (open && run.reservationId) await ledger.settle(run.reservationId, settlement, now);
  return run.state === 'unknown'
    ? runs.transition(run.runId, ['unknown'], 'cancelled', { reason: 'operator_reconciled' })
    : run;
}
