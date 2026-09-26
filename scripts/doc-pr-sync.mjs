// Deterministic doc <-> PR-body diagram-drift guard.
//
// Spec: the diagram convention (templates/app-repo/AGENTS.md.tpl §Documentation
// conventions, merged PR #47) says a diagram is reused across an ADR/doc and its
// PR body. ADR 0010's principle — "whenever the answer to 'how do we make sure an
// agent does X' is 'tell the agent to remember X', make the substrate enforce it"
// — this is that enforcement (the deterministic backstop layer).
//
// Rule: every ```mermaid block in the PR body must byte-match (after whitespace
// normalization) a ```mermaid block in some tracked `.md` file, UNLESS the block
// is immediately preceded by `<!-- sf:diagram-local -->` (an intentional PR-only
// diagram). A drifted PR-body diagram no longer matches its (updated) source doc
// → flagged. Pure + dependency-free so it is unit-testable and CI-portable.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MERMAID_RE = /```mermaid\r?\n([\s\S]*?)```/g;
const LOCAL_MARKER = 'sf:diagram-local';

// Normalize so trivial whitespace differences don't read as drift: strip
// trailing whitespace per line and leading/trailing blank lines.
export function normalizeBlock(body) {
  return body
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

// → [{ content, local }]. `local` is true when the marker appears in the lines
// immediately before the block's fence.
export function extractMermaidBlocks(markdown) {
  const out = [];
  MERMAID_RE.lastIndex = 0;
  let match;
  while ((match = MERMAID_RE.exec(markdown)) !== null) {
    const preceding = markdown.slice(0, match.index).split('\n').slice(-3).join('\n');
    out.push({ content: normalizeBlock(match[1]), local: preceding.includes(LOCAL_MARKER) });
  }
  return out;
}

export function collectDocBlocks(markdownContents) {
  const set = new Set();
  for (const md of markdownContents) {
    for (const block of extractMermaidBlocks(md)) set.add(block.content);
  }
  return set;
}

// → array of drift findings (first line of each offending block). Empty = clean.
export function findDrift(prBody, docBlockSet) {
  const findings = [];
  for (const block of extractMermaidBlocks(prBody)) {
    if (block.local) continue;
    if (!docBlockSet.has(block.content)) {
      findings.push(block.content.split('\n')[0] || '(empty diagram)');
    }
  }
  return findings;
}

// --- CLI (only runs when invoked directly, not on import) ---

function walkMarkdown(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkMarkdown(full, acc);
    else if (entry.endsWith('.md') || entry.endsWith('.md.tpl')) acc.push(full);
  }
  return acc;
}

function main() {
  const prBody = process.env.PR_BODY ?? '';
  if (prBody.trim() === '') {
    console.log('doc-pr-sync: no PR_BODY provided; nothing to check.');
    return;
  }
  const docContents = walkMarkdown(process.cwd()).map((f) => readFileSync(f, 'utf8'));
  const findings = findDrift(prBody, collectDocBlocks(docContents));
  if (findings.length === 0) {
    console.log('doc-pr-sync: OK — every PR-body mermaid block matches a doc (or is sf:diagram-local).');
    return;
  }
  console.error(
    `doc-pr-sync: ${findings.length} PR-body diagram(s) do not match any tracked doc ` +
      `(drifted from source, or PR-only without an \`<!-- ${LOCAL_MARKER} -->\` marker):`,
  );
  for (const f of findings) console.error(`  - ${f}`);
  process.exitCode = 1;
}

// Run main() only on direct invocation. pathToFileURL (not `file://${argv}`) so
// the guard still matches when the path has spaces/special chars — otherwise the
// CLI would silently no-op and the CI check would pass vacuously.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
