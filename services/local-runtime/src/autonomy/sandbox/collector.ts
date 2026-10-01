import { MAX_ARCHIVE_BYTES, sha256 } from '../../worker/protocol.js';
import { SNAPSHOT_EXCLUDED_DIRECTORIES } from '../../worker/review-snapshot.js';
import {
  SECRET_MATERIAL_CONTENT,
  SECRET_MATERIAL_PATH,
  isEnvironmentDump,
} from '../../worker/secrets.js';
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
// The reviewer sees a bounded snapshot of the candidate tree's text files, not only the
// diff, so it can examine what a change relies on. Generated and dependency directories and the
// protected verification assets are not context; secret-shaped paths and secret material are never
// sent; files near the change come first; what does not fit is listed as omitted (counted beyond
// the list) and the snapshot marked incomplete. Sizes come from the listing, so no blob above the
// per-file cap is ever read.
const CONTEXT_BYTES = 512 * 1024;
const CONTEXT_FILE_BYTES = 64 * 1024;
const CONTEXT_MAX_FILES = 2_000;
const CONTEXT_OMITTED_LIST = 500;
const CONTEXT_EXCLUDED = new RegExp(
  `(^|/)(${SNAPSHOT_EXCLUDED_DIRECTORIES.map((name) => name.replace(/\./g, '\\.')).join('|')})/`,
);
// The classifier's pathWithin semantics (schema.ts): case-insensitive, `.` covers everything.
const withinAny = (path: string, prefixes: string[]) => {
  const lower = path.toLowerCase();
  return prefixes.some((prefix) => {
    const normalized = prefix.toLowerCase().replace(/\/+$/, '');
    return normalized === '.' || lower === normalized || lower.startsWith(`${normalized}/`);
  });
};
export interface Snapshot {
  files: { path: string; content: string }[];
  omitted: string[];
  omittedCount: number;
  truncated: boolean;
}
const directoryOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const topOf = (path: string) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '');

/** Files in a changed file's directory first, then its top-level directory, then the rest; each group by path. */
export function relevanceOrder<T extends { path: string }>(
  entries: T[],
  changedPaths: string[],
): T[] {
  const directories = new Set(changedPaths.map(directoryOf));
  const tops = new Set(changedPaths.map(topOf));
  const rank = (path: string) =>
    directories.has(directoryOf(path)) ? 0 : tops.has(topOf(path)) ? 1 : 2;
  return [...entries].sort((a, b) => {
    const byRank = rank(a.path) - rank(b.path);
    return byRank !== 0 ? byRank : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

async function snapshot(
  run: (args: string[], stdin: Buffer | undefined, limit: number) => Promise<Buffer>,
  tree: string,
  changedPaths: string[],
  protectedPaths: string[],
): Promise<Snapshot> {
  const listing = (
    await run(['ls-tree', '-r', '-l', '-z', tree], undefined, 64 * 1024 * 1024)
  ).toString('utf8');
  const entries: { mode: string; sha: string; size: number; path: string }[] = [];
  for (const record of listing.split('\0')) {
    if (record === '') continue;
    const match = /^([0-7]{6}) (blob|commit|tree) ([0-9a-f]{40}) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match) fail('collector_tree_unparseable');
    entries.push({
      mode: match[1] as string,
      sha: match[3] as string,
      size: match[4] === '-' ? -1 : Number(match[4]),
      path: match[5] as string,
    });
  }
  const files: { path: string; content: string }[] = [];
  const omitted: string[] = [];
  let omittedCount = 0;
  const omit = (path: string) => {
    omittedCount += 1;
    if (omitted.length < CONTEXT_OMITTED_LIST) omitted.push(path);
  };
  let bytes = 0;
  let truncated = false;
  for (const entry of relevanceOrder(entries, changedPaths)) {
    if (CONTEXT_EXCLUDED.test(entry.path)) continue;
    // The policy's protected verification assets are not context for the model.
    if (withinAny(entry.path, protectedPaths)) {
      omit(entry.path);
      continue;
    }
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      omit(entry.path);
      continue;
    }
    if (entry.path.length > 1024 || SECRET_MATERIAL_PATH.test(entry.path.toLowerCase())) {
      omit(entry.path.slice(0, 1024));
      continue;
    }
    if (entry.size < 0 || entry.size > CONTEXT_FILE_BYTES) {
      omit(entry.path);
      continue;
    }
    if (truncated || files.length >= CONTEXT_MAX_FILES) {
      truncated = true;
      omit(entry.path);
      continue;
    }
    const blob = await run(['cat-file', 'blob', entry.sha], undefined, CONTEXT_FILE_BYTES + 1);
    if (blob.length > CONTEXT_FILE_BYTES || !isText(blob)) {
      omit(entry.path);
      continue;
    }
    const content = blob.toString('utf8');
    if (SECRET_MATERIAL_CONTENT.test(content) || isEnvironmentDump(content)) {
      omit(entry.path);
      continue;
    }
    if (bytes + Buffer.byteLength(content) > CONTEXT_BYTES) {
      truncated = true;
      omit(entry.path);
      continue;
    }
    bytes += Buffer.byteLength(content);
    files.push({ path: entry.path, content });
  }
  return { files, omitted, omittedCount, truncated };
}

async function main() {
  if (process.getuid?.() !== 1000) fail('sandbox_requires_non_root_uid');
  const input = await readInput<{ archive: string; patch: string; protectedPaths?: unknown }>(
    MAX_ARCHIVE_BYTES * 3,
  );
  if (typeof input.archive !== 'string' || typeof input.patch !== 'string')
    fail('collector_input_invalid');
  const protectedPaths = input.protectedPaths ?? [];
  if (
    !Array.isArray(protectedPaths) ||
    protectedPaths.length > 64 ||
    !protectedPaths.every((path) => typeof path === 'string' && path.length <= 512)
  )
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
  const context = await snapshot(
    run,
    prepared.candidateTree,
    (files as { newPath: string | null; oldPath: string | null }[]).map(
      (file) => file.newPath ?? file.oldPath ?? '',
    ),
    protectedPaths as string[],
  );
  process.stdout.write(
    `${JSON.stringify({
      version: 2,
      ok: true,
      base: prepared.base,
      baseTree: prepared.baseTree,
      candidateTree: prepared.candidateTree,
      patchSha256: sha256(input.patch),
      manifest: { complete, files },
      blobs,
      context,
    })}\n`,
  );
}
main().catch(() => fail('collector_failed'));
