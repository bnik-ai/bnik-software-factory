const BLOCKED_BY_PREFIX = 'blocked-by:';

// Parse blocked-by refs from a Task body — both the inline `blocked-by:` line
// (agent-authored) and the `### blocked-by` issue-form heading (task.yml). Comma-
// separated refs; trims + drops empties. Absent line → no blockers.
export function parseBlockedBy(body: string): ReadonlyArray<string> {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    const lower = trimmed.toLowerCase();
    // Inline convention: `blocked-by: a, b` (agent-authored Task bodies).
    if (lower.startsWith(BLOCKED_BY_PREFIX)) {
      return splitRefs(trimmed.slice(BLOCKED_BY_PREFIX.length));
    }
    // GitHub issue-form convention: a `### blocked-by` heading with the value on
    // the following non-empty line. task.yml renders the `blocked-by` INPUT this
    // way (not as a `blocked-by:` line), so human-created Tasks must be parsed
    // here too — else declared blockers are dropped and blocked work is promoted
    // prematurely. `_No response_` is GitHub's empty-optional-field placeholder.
    // (codex PR #150)
    if (/^#{1,6}\s+blocked-by\s*$/.test(lower)) {
      for (let j = i + 1; j < lines.length; j++) {
        const value = (lines[j] ?? '').trim();
        if (value.length === 0) continue; // blank line between heading and value
        if (/^#{1,6}\s+/.test(value)) break; // next heading → field left empty
        if (value.toLowerCase() === '_no response_') return [];
        return splitRefs(value);
      }
      return [];
    }
  }
  return [];
}

function splitRefs(raw: string): ReadonlyArray<string> {
  return raw
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
}
