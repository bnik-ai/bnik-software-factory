import type { Docker } from '../worker/docker.js';
import { MAX_ARCHIVE_BYTES, sha256 } from '../worker/protocol.js';
import { type ChangeManifest, parseChangeManifest } from './classify.js';
import { runSandbox } from './sandbox.js';
import { AutonomyError, requireAutonomy, requireGitObject, requireRecord } from './schema.js';

/** Text files of the candidate tree, bounded; what did not fit is listed and marked incomplete. */
export interface ReviewContext {
  files: { path: string; content: string }[];
  omitted: string[];
  /** Every omitted file, counted beyond the listed ones. */
  omittedCount: number;
  truncated: boolean;
}
const CONTEXT_MAX_FILES = 2_000;
const CONTEXT_MAX_OMITTED = 500;
const CONTEXT_MAX_BYTES = 1024 * 1024;
export function parseReviewContext(value: unknown): ReviewContext {
  requireRecord(
    value,
    ['files', 'omitted', 'omittedCount', 'truncated'],
    'collector_context_invalid',
  );
  const context = value as unknown as ReviewContext;
  requireAutonomy(
    Array.isArray(context.files) &&
      context.files.length <= CONTEXT_MAX_FILES &&
      Array.isArray(context.omitted) &&
      context.omitted.length <= CONTEXT_MAX_OMITTED &&
      Number.isSafeInteger(context.omittedCount) &&
      context.omittedCount >= context.omitted.length &&
      typeof context.truncated === 'boolean',
    'collector_context_invalid',
  );
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of context.files) {
    requireRecord(file, ['path', 'content'], 'collector_context_invalid');
    requireAutonomy(
      typeof file.path === 'string' &&
        file.path.length > 0 &&
        file.path.length <= 1024 &&
        !file.path.includes('\0') &&
        typeof file.content === 'string' &&
        !seen.has(file.path),
      'collector_context_invalid',
    );
    seen.add(file.path);
    bytes += Buffer.byteLength(file.content);
    requireAutonomy(bytes <= CONTEXT_MAX_BYTES, 'collector_context_too_large');
  }
  for (const path of context.omitted)
    requireAutonomy(
      typeof path === 'string' && path.length > 0 && path.length <= 1024,
      'collector_context_invalid',
    );
  return {
    files: context.files,
    omitted: context.omitted,
    omittedCount: context.omittedCount,
    truncated: context.truncated,
  };
}
export interface CollectedChange {
  /** Commit of the extracted base snapshot inside the sandbox (not the GitHub commit). */
  base: string;
  baseTree: string;
  /** Git tree of the candidate: the identity every receipt and the publisher bind to. */
  candidateTree: string;
  patchSha256: string;
  manifest: ChangeManifest;
  /** Base64 bytes for binary files and symlink targets, keyed by new path. */
  blobs: Record<string, string>;
  /** What the reviewer examines besides the diff. */
  context: ReviewContext;
  imageId: string;
}
export interface CollectOptions {
  docker?: Docker;
  image: string;
  runId: string;
  archive: Buffer;
  patch: string;
  /** The policy's protected verification assets: never part of the reviewer's snapshot. */
  protectedPaths?: string[];
  signal: AbortSignal;
  timeoutMs?: number;
}
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Runs the collector sandbox and validates its output before anything trusts it. */
export async function collectChanges(options: CollectOptions): Promise<CollectedChange> {
  requireAutonomy(options.archive.length <= MAX_ARCHIVE_BYTES, 'archive_too_large');
  requireAutonomy(
    typeof options.patch === 'string' && options.patch.length <= 32 * 1024 * 1024,
    'patch_too_large',
  );
  const { output, imageId } = await runSandbox({
    docker: options.docker,
    image: options.image,
    runId: options.runId,
    entry: 'src/autonomy/sandbox/collector.ts',
    input: {
      archive: options.archive.toString('base64'),
      patch: options.patch,
      protectedPaths: options.protectedPaths ?? [],
    },
    timeoutMs: options.timeoutMs ?? 300_000,
    signal: options.signal,
    outputLimit: 192 * 1024 * 1024,
  });
  return { ...parseCollectorOutput(output, options.patch), imageId };
}
/** Validates the sandbox's output before anything trusts it; pure, so a stale image is a unit test. */
export function parseCollectorOutput(
  output: unknown,
  patch: string,
): Omit<CollectedChange, 'imageId'> {
  requireAutonomy(
    output !== null && typeof output === 'object' && !Array.isArray(output),
    'collector_output_invalid',
  );
  if ((output as { ok: unknown }).ok !== true) {
    // A refusal carries exactly the failure shape written by sandbox/common.ts fail().
    requireRecord(output, ['version', 'ok', 'reason'], 'collector_output_invalid');
    const reason = (output as { reason?: unknown }).reason;
    throw new AutonomyError(
      typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason) ? reason : 'collector_failed',
    );
  }
  // Version 2 carries the reviewer's snapshot; a pinned older worker image is refused by name.
  const version = (output as { version: unknown }).version;
  requireAutonomy(
    version === 2,
    version === 1 ? 'collector_image_outdated' : 'collector_output_invalid',
  );
  requireRecord(
    output,
    [
      'version',
      'ok',
      'base',
      'baseTree',
      'candidateTree',
      'patchSha256',
      'manifest',
      'blobs',
      'context',
    ],
    'collector_output_invalid',
  );
  const collected = output as unknown as CollectedChange;
  const context = parseReviewContext(collected.context);
  requireGitObject(collected.base, 'collector_output_invalid');
  requireGitObject(collected.baseTree, 'collector_output_invalid');
  requireGitObject(collected.candidateTree, 'collector_output_invalid');
  requireAutonomy(collected.patchSha256 === sha256(patch), 'collector_patch_mismatch');
  const manifest = parseChangeManifest(collected.manifest);
  requireAutonomy(
    collected.blobs !== null &&
      typeof collected.blobs === 'object' &&
      !Array.isArray(collected.blobs),
    'collector_output_invalid',
  );
  const blobPaths = new Set(
    manifest.files
      .filter((file) => file.newPath !== null && (file.binary || file.newMode === '120000'))
      .map((file) => file.newPath as string),
  );
  let blobBytes = 0;
  for (const [path, encoded] of Object.entries(collected.blobs)) {
    requireAutonomy(blobPaths.has(path), 'collector_blob_unexpected');
    requireAutonomy(typeof encoded === 'string' && BASE64.test(encoded), 'collector_blob_invalid');
    blobBytes += encoded.length;
    requireAutonomy(blobBytes <= 96 * 1024 * 1024, 'collector_blobs_too_large');
  }
  for (const path of blobPaths) requireAutonomy(path in collected.blobs, 'collector_blob_missing');
  requireAutonomy(
    (manifest.files.length === 0) === (collected.baseTree === collected.candidateTree),
    'collector_tree_inconsistent',
  );
  return { ...collected, manifest, context };
}
