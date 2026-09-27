import { randomUUID } from 'node:crypto';
import type { ChangeManifest, FileChange } from '../src/autonomy/classify.js';
import {
  type ActionRequest,
  type AutonomyAction,
  actionDigest,
  parseRequest,
} from '../src/autonomy/decision.js';
import type {
  AcceptanceReceipt,
  ApprovalRecord,
  CandidateSubject,
  DependencyReceipt,
  MergeGateObservation,
  ReviewReceipt,
} from '../src/autonomy/evidence.js';
import { type AutonomyPolicy, policyDigest } from '../src/autonomy/policy.js';
import { sha256Json } from '../src/autonomy/schema.js';

export const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
export const BASE = 'a'.repeat(40);
export const TREE = 'b'.repeat(40);
export const HEAD = 'c'.repeat(40);
export const APPROVER_ID = 5001;
export const INTENT_SHA256 = sha256Json({ intent: 'fix the sum helper' });

export function policyFixture(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    version: 1,
    revision: 1,
    mode: 'bounded',
    repository: {
      fullName: 'example/factory-demo',
      id: 101,
      installationId: 202,
      baseBranch: 'main',
    },
    allowedPaths: ['src', 'test', 'docs', 'README.md'],
    criticalPaths: [{ path: 'src/billing', category: 'infrastructure_spend' }],
    execution: {
      models: ['claude-sonnet-5'],
      maxTurns: 40,
      maxRunMs: 900_000,
      maxRunMicrousd: 5_000_000,
      maxScopeMicrousd: 20_000_000,
      maxTaskRuns: 3,
    },
    changeLimits: { maxChangedFiles: 50, maxChangedBytes: 200_000 },
    mergeEffect: 'none',
    verification: {
      acceptanceSuiteSha256: '1'.repeat(64),
      acceptanceHarnessSha256: '2'.repeat(64),
      acceptanceRunnerImage: `sha256:${'3'.repeat(64)}`,
      reviewerConfigSha256: '4'.repeat(64),
      evalProtocolSha256: '5'.repeat(64),
      protectedPaths: ['acceptance'],
      receiptTtlMs: 3_600_000,
    },
    approvers: { githubUserIds: [APPROVER_ID] },
    dependencies: {
      scanner: {
        adapter: 'trivy',
        image: `sha256:${'6'.repeat(64)}`,
        databaseMaxAgeMs: 172_800_000,
      },
      holdSeverity: 'critical',
      licenseAllowlist: ['Apache-2.0', 'MIT', 'BSD-3-Clause', 'ISC'],
      allowNewDependencies: false,
      allowMajorUpgrades: false,
    },
    ...overrides,
  };
}
export function modified(path: string, oldContent: string, newContent: string): FileChange {
  return {
    status: 'modified',
    oldPath: path,
    newPath: path,
    oldMode: '100644',
    newMode: '100644',
    oldContent,
    newContent,
    binary: false,
  };
}
export function added(path: string, newContent: string): FileChange {
  return {
    status: 'added',
    oldPath: null,
    newPath: path,
    oldMode: null,
    newMode: '100644',
    oldContent: null,
    newContent,
    binary: false,
  };
}
export function deleted(path: string, oldContent: string): FileChange {
  return {
    status: 'deleted',
    oldPath: path,
    newPath: null,
    oldMode: '100644',
    newMode: null,
    oldContent,
    newContent: null,
    binary: false,
  };
}
export function renamed(oldPath: string, newPath: string, content: string): FileChange {
  return {
    status: 'renamed',
    oldPath,
    newPath,
    oldMode: '100644',
    newMode: '100644',
    oldContent: content,
    newContent: content,
    binary: false,
  };
}
export const ROUTINE_CHANGE = modified(
  'src/sum.js',
  'export function sum(a, b) {\n  return a - b;\n}\n',
  'export function sum(a, b) {\n  return a + b;\n}\n',
);
export function manifest(...files: FileChange[]): ChangeManifest {
  return { complete: true, files };
}
export function requestFor(
  policy: AutonomyPolicy,
  action: AutonomyAction,
  changes: ChangeManifest | null = manifest(ROUTINE_CHANGE),
  overrides: Partial<ActionRequest> = {},
): ActionRequest {
  return {
    version: 1,
    requestId: randomUUID(),
    action,
    scopeId: 'goal-1',
    policySha256: policyDigest(policy),
    repository: {
      id: policy.repository.id,
      installationId: policy.repository.installationId,
      baseBranch: 'main',
    },
    task: { id: 'TASK_1', intentSha256: INTENT_SHA256, intentKind: 'change' },
    base: BASE,
    head: action === 'merge' ? HEAD : null,
    tree: action === 'execute' ? null : TREE,
    changes: action === 'execute' ? null : changes,
    execution:
      action === 'execute'
        ? { model: 'claude-sonnet-5', maxTurns: 20, maxRunMs: 600_000, budgetMicrousd: 2_000_000 }
        : null,
    ...overrides,
  };
}
export function subjectOf(request: ActionRequest): CandidateSubject {
  return {
    repositoryId: request.repository.id,
    taskId: request.task.id,
    base: request.base,
    tree: request.tree ?? '',
    changesSha256: sha256Json(request.changes),
  };
}
export function acceptanceFor(
  policy: AutonomyPolicy,
  request: ActionRequest,
  overrides: Partial<AcceptanceReceipt> = {},
): AcceptanceReceipt {
  return {
    version: 1,
    kind: 'acceptance',
    runId: randomUUID(),
    subject: subjectOf(request),
    suiteSha256: policy.verification.acceptanceSuiteSha256,
    harnessSha256: policy.verification.acceptanceHarnessSha256,
    runnerImage: policy.verification.acceptanceRunnerImage,
    status: 'passed',
    protectedSuite: { total: 12, passed: 12, failed: 0, skipped: 0 },
    reproducer: { baseline: 'not_run', candidate: 'not_run' },
    sourceModifiedByTests: false,
    completedAt: NOW - 60_000,
    ...overrides,
  };
}
export function reviewFor(
  policy: AutonomyPolicy,
  request: ActionRequest,
  overrides: Partial<ReviewReceipt> = {},
): ReviewReceipt {
  return {
    version: 1,
    kind: 'review',
    runId: randomUUID(),
    subject: subjectOf(request),
    intentSha256: request.task.intentSha256,
    reviewerConfigSha256: policy.verification.reviewerConfigSha256,
    context: 'fresh',
    status: 'complete',
    risk: 'routine',
    categories: [],
    findings: [],
    limitations: [],
    completedAt: NOW - 30_000,
    ...overrides,
  };
}
export function mergeGateFor(
  request: ActionRequest,
  overrides: Partial<MergeGateObservation> = {},
): MergeGateObservation {
  return {
    version: 1,
    kind: 'merge_gate',
    repositoryId: request.repository.id,
    pullNumber: 7,
    head: request.head ?? HEAD,
    headTree: request.tree ?? TREE,
    base: request.base,
    baseBranch: request.repository.baseBranch,
    pullState: 'open',
    requiredChecks: 'passed',
    changesRequested: false,
    protectionVerified: true,
    observedAt: NOW - 10_000,
    ...overrides,
  };
}
export function approvalFor(
  policy: AutonomyPolicy,
  request: ActionRequest,
  overrides: Partial<ApprovalRecord> = {},
): ApprovalRecord {
  return {
    version: 1,
    kind: 'approval',
    actionSha256: actionDigest(parseRequest(policy, request)),
    action: request.action,
    approver: { githubUserId: APPROVER_ID, type: 'User' },
    source: 'github_review',
    approvedAt: NOW - 5_000,
    ...overrides,
  };
}
export const LOCKFILE_BUMP = modified(
  'package-lock.json',
  '{"packages":{"node_modules/left-pad":{"version":"1.3.0"}}}\n',
  '{"packages":{"node_modules/left-pad":{"version":"1.3.1"}}}\n',
);
/** A verified routine version bump: reproduced lockfile, no scripts, allowed license, no findings. */
export function dependencyFor(
  policy: AutonomyPolicy,
  request: ActionRequest,
  overrides: Partial<DependencyReceipt> = {},
): DependencyReceipt {
  const scanner = policy.dependencies?.scanner ?? {
    adapter: 'trivy',
    image: `sha256:${'6'.repeat(64)}`,
    databaseMaxAgeMs: 172_800_000,
  };
  return {
    version: 1,
    kind: 'dependency',
    runId: randomUUID(),
    subject: subjectOf(request),
    scanner: { adapter: scanner.adapter, image: scanner.image, databaseUpdatedAt: NOW - 3_600_000 },
    manifests: ['package-lock.json'],
    status: 'complete',
    resolution: 'reproduced',
    manifestFieldsChanged: [],
    installScriptsChanged: false,
    packages: {
      added: [],
      removed: [],
      upgraded: [
        {
          ecosystem: 'npm',
          name: 'left-pad',
          version: '1.3.1',
          previousVersion: '1.3.0',
          license: 'MIT',
          major: false,
          source: 'registry',
        },
      ],
    },
    findings: [],
    findingsOmittedBelow: null,
    completedAt: NOW - 20_000,
    ...overrides,
  };
}
/** Complete, current, passing evidence for the request's action. */
export function evidenceFor(policy: AutonomyPolicy, request: ActionRequest) {
  if (request.action === 'execute') return {};
  const evidence: Record<string, unknown> = {
    acceptance: acceptanceFor(policy, request),
    review: reviewFor(policy, request),
  };
  if (request.action === 'merge') evidence.mergeGate = mergeGateFor(request);
  return evidence;
}
