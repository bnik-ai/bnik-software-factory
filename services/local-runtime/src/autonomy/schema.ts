import { createHash } from 'node:crypto';
import { canonicalJson } from '../queue.js';

/** Stable reason code. Callers map it to a non-pass outcome; never to success. */
export class AutonomyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export function requireAutonomy(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new AutonomyError(reason);
}
export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function requireRecord(
  value: unknown,
  expectedKeys: readonly string[],
  reason: string,
): asserts value is Record<string, unknown> {
  requireAutonomy(value !== null && typeof value === 'object' && !Array.isArray(value), reason);
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  requireAutonomy(
    actualKeys.length === sortedExpected.length &&
      actualKeys.every((key, index) => key === sortedExpected[index]),
    reason,
  );
}
export function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  reason: string,
): asserts value is number {
  requireAutonomy(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
    reason,
  );
}
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
export function requireText(
  value: unknown,
  maxLength: number,
  reason: string,
): asserts value is string {
  requireAutonomy(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maxLength &&
      value.trim() === value &&
      !hasControlCharacter(value),
    reason,
  );
}
export function requireSha256(value: unknown, reason: string): asserts value is string {
  requireAutonomy(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), reason);
}
export function requireGitObject(value: unknown, reason: string): asserts value is string {
  requireAutonomy(typeof value === 'string' && /^[0-9a-f]{40}$/.test(value), reason);
}
export function requireTimestamp(value: unknown, reason: string): asserts value is number {
  requireInteger(value, 1, 8_640_000_000_000_000, reason);
}
export function requireUniqueList<T>(
  value: unknown,
  minimum: number,
  maximum: number,
  reason: string,
): asserts value is T[] {
  requireAutonomy(
    Array.isArray(value) &&
      value.length >= minimum &&
      value.length <= maximum &&
      new Set(value.map((item) => canonicalJson(item))).size === value.length,
    reason,
  );
}
/**
 * Repository-relative path as Git records it. Rejects traversal, absolute paths,
 * backslashes and any `.git` segment; the collector must never emit those.
 */
export function requireRepositoryPath(value: unknown, reason: string): asserts value is string {
  requireText(value, 1024, reason);
  const segments = value.split('/');
  requireAutonomy(
    !value.includes('\\') &&
      segments.every(
        (segment) =>
          segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git',
      ),
    reason,
  );
}
/** Segment-boundary prefix match, case-insensitive so case-folding filesystems cannot dodge a rule. */
export function pathWithin(candidatePath: string, prefix: string): boolean {
  if (prefix === '.') return true;
  const normalizedPath = candidatePath.toLowerCase();
  const normalizedPrefix = prefix.toLowerCase();
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}
