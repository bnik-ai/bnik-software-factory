import { MAX_ARCHIVE_BYTES, sha256 } from '../../worker/protocol.js';
import {
  GIT_MODES,
  fail,
  git,
  isText,
  isolateEnvironment,
  prepareRepository,
  readInput,
} from './common.js';

/**
 * Trusted collector. Rebuilds the candidate tree from the base archive and the
 * worker patch, then lists every changed file with full content on both sides,
 * so the policy classifies the real change rather than a worker-reported diff.
 * Output: { version, ok, base, baseTree, candidateTree, patchSha256, manifest, blobs }.
 */
const MAX_FILES = 10_000;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_ARCHIVE_BYTES;

async function main() {
  if (process.getuid?.() !== 1000) fail('sandbox_requires_non_root_uid');
  const input = await readInput<{ archive: string; patch: string }>(MAX_ARCHIVE_BYTES * 3);
  if (typeof input.archive !== 'string' || typeof input.patch !== 'string')
    fail('collector_input_invalid');
  const archive = Buffer.from(input.archive, 'base64');
  const env = isolateEnvironment();
  const signal = AbortSignal.timeout(600_000);
  const prepared = await prepareRepository(archive, input.patch, env, signal);
  if ('reason' in prepared) fail(prepared.reason);
  const run = git(env, signal);
  const raw = await run(
    ['diff-tree', '-r', '-z', '--no-renames', '--raw', prepared.baseTree, prepared.candidateTree],
    undefined,
    64 * 1024 * 1024,
  );
  const fields = raw.toString('utf8').split('\0');
  const files: unknown[] = [];
  const blobs: Record<string, string> = {};
  let textBytes = 0;
  let complete = true;
  for (let index = 0; index + 1 < fields.length && fields[index] !== ''; index += 2) {
    const meta = fields[index] as string;
    const path = fields[index + 1] as string;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMDT])$/.exec(meta);
    if (!match) fail('collector_diff_unparseable');
    const [, oldMode, newMode, oldSha, newSha, status] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (files.length >= MAX_FILES) {
      complete = false;
      break;
    }
    const zero = '0'.repeat(40);
    const side = async (mode: string, sha: string) => {
      if (sha === zero) return { mode: null, content: null, bytes: null };
      if (!(GIT_MODES as readonly string[]).includes(mode)) fail('collector_mode_unsupported');
      if (mode === '160000') return { mode, content: null, bytes: null };
      const bytes = await run(['cat-file', 'blob', sha], undefined, MAX_FILE_BYTES + 1);
      if (bytes.length > MAX_FILE_BYTES) {
        complete = false;
        return { mode, content: null, bytes: null };
      }
      const text = mode !== '120000' && isText(bytes);
      return { mode, content: text ? bytes.toString('utf8') : null, bytes };
    };
    const before = await side(oldMode, oldSha);
    const after = await side(newMode, newSha);
    const binary =
      (before.mode !== null &&
        before.mode !== '120000' &&
        before.mode !== '160000' &&
        before.content === null &&
        before.bytes !== null) ||
      (after.mode !== null &&
        after.mode !== '120000' &&
        after.mode !== '160000' &&
        after.content === null &&
        after.bytes !== null);
    textBytes += Buffer.byteLength(before.content ?? '') + Buffer.byteLength(after.content ?? '');
    if (textBytes > MAX_TEXT_BYTES) {
      complete = false;
      break;
    }
    files.push({
      status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified',
      oldPath: status === 'A' ? null : path,
      newPath: status === 'D' ? null : path,
      oldMode: before.mode,
      newMode: after.mode,
      oldContent: binary || before.mode === '120000' ? null : before.content,
      newContent: binary || after.mode === '120000' ? null : after.content,
      binary,
    });
    // Bytes the publisher needs that the manifest text cannot carry: binaries and link targets.
    if (after.bytes !== null && (binary || after.mode === '120000'))
      blobs[path] = after.bytes.toString('base64');
  }
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      ok: true,
      base: prepared.base,
      baseTree: prepared.baseTree,
      candidateTree: prepared.candidateTree,
      patchSha256: sha256(input.patch),
      manifest: { complete, files },
      blobs,
    })}\n`,
  );
}
main().catch(() => fail('collector_failed'));
