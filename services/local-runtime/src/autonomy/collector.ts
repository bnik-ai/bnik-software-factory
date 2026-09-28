import type { Docker } from '../worker/docker.js';
import { MAX_ARCHIVE_BYTES, sha256 } from '../worker/protocol.js';
import { type ChangeManifest, parseChangeManifest } from './classify.js';
import { runSandbox } from './sandbox.js';
import { AutonomyError, requireAutonomy, requireGitObject, requireRecord } from './schema.js';

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
  imageId: string;
}
export interface CollectOptions {
  docker?: Docker;
  image: string;
  runId: string;
  archive: Buffer;
  patch: string;
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
    input: { archive: options.archive.toString('base64'), patch: options.patch },
    timeoutMs: options.timeoutMs ?? 300_000,
    signal: options.signal,
    outputLimit: 192 * 1024 * 1024,
  });
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
  requireRecord(
    output,
    ['version', 'ok', 'base', 'baseTree', 'candidateTree', 'patchSha256', 'manifest', 'blobs'],
    'collector_output_invalid',
  );
  requireAutonomy((output as { version: unknown }).version === 1, 'collector_output_invalid');
  const collected = output as unknown as CollectedChange;
  requireGitObject(collected.base, 'collector_output_invalid');
  requireGitObject(collected.baseTree, 'collector_output_invalid');
  requireGitObject(collected.candidateTree, 'collector_output_invalid');
  requireAutonomy(collected.patchSha256 === sha256(options.patch), 'collector_patch_mismatch');
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
  return { ...collected, manifest, imageId };
}
