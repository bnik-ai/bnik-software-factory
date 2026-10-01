// Deterministic generator for docs/architecture-diagrams.md.
//
// Why this exists: the architecture diagram used to be hand-authored ASCII that
// silently drifted from the code. ADR 0010's principle — "when the answer to
// 'how do we keep an agent doing X' is 'remember to X', make the substrate
// enforce it" — applies here: the enumerable facts (the L3 agent set, the
// per-kind FSM count, the record-kind counts, the Azure resource names) are
// DERIVED from their source-of-truth files at generation time and verified
// against the static layout model. A real architecture change (e.g. an 8th
// agent) re-flows the diagram or fails the build loud; it can no longer pass
// unnoticed. The local --check option detects changes to generated content.
//
// Pure + dependency-free (mirrors doc-pr-sync.mjs): every derivation/render
// function takes already-read text and returns a value, so it is unit-testable.
// Only main() touches the filesystem, git, and the network.
//
// Determinism: render() never reads the wall clock. The Snapshot line is stamped
// from the most-recent commit touching SOURCE_PATHS (stable across unrelated
// commits — no daily churn), injected as args. Derived lists are sorted.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';

import {
  AGENT_ORDER,
  AGENT_ROW_LINE_LEN,
  AZURE_REFS,
  BODY_TEMPLATE,
  SOURCE_PATHS,
} from './gen-architecture-diagrams.model.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_REL = 'docs/architecture-diagrams.md';
// Box-drawing + the few punctuation glyphs the diagram uses. A derived string
// containing anything else (e.g. a wide CJK/emoji glyph) would silently break
// column alignment, so we reject it at build time instead.
const SAFE_GLYPHS = /^[\x20-\x7E·…▶◀▼▲│┌┐└┘├┤┬┴┼─╔╗╚╝║═╠╣╤╧╥]*$/u;

// ---------------------------------------------------------------------------
// Derivation layer (pure — caller passes already-read text)
// ---------------------------------------------------------------------------

// Most services/agents/src/agents/*Agent.ts declare `const ROLE = 'XAgent' as const;`
// (sreAgent is a stub and legitimately omits it). → sorted roles from the files
// that DO declare one; used as a subset cross-check against the AgentRole union,
// which is the canonical 7-agent set.
export function parseAgentRoles(agentFiles) {
  const roles = [];
  for (const { text } of agentFiles) {
    const m = text.match(/const ROLE = '(\w+)' as const;/);
    if (m) roles.push(m[1]);
  }
  return [...new Set(roles)].sort();
}

// Parse the `export type AgentRole = | 'X' | 'Y' ...` union from types.ts. → sorted.
export function parseAgentRoleUnion(typesText) {
  const block = typesText.match(/export type AgentRole\s*=([\s\S]*?);/);
  if (!block) throw new Error('AgentRole union not found');
  const roles = [...block[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  if (roles.length === 0) throw new Error('AgentRole union is empty');
  return [...new Set(roles)].sort();
}

// ROLE 'SpecAgent' → display short name 'Spec'.
export function shortName(role) {
  return role.replace(/Agent$/, '');
}

// Count rows of a markdown table under a `#### <heading>` section in architecture.md.
// Data rows look like `| **Name** | ... |`.
export function countTableRows(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`#### ${heading}`));
  if (start === -1) throw new Error(`section "#### ${heading}" not found`);
  let count = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#### ') || l.startsWith('### ') || l.startsWith('## ')) break;
    if (/^\|\s*\*\*/.test(l)) count++;
  }
  if (count === 0) throw new Error(`no data rows under "#### ${heading}"`);
  return count;
}

// Extract ca-*/caj-*/queue names from azure-adapter.md backticks. Names may carry
// the `sfac-<env>-<region>-` prefix (stripped) or appear bare; `cae-*` (the
// Container App *Environment*) is excluded. → { containerApps, jobs, queues } sorted.
export function parseAzureResources(azureMd) {
  const apps = new Set();
  const jobs = new Set();
  const queues = new Set();
  for (const m of azureMd.matchAll(/`([a-z0-9-]+(?:\{[a-z]+\})?[a-z0-9-]*)`/g)) {
    let name = m[1].replace(/^sfac-[a-z0-9]+-[a-z0-9]+-/, '');
    if (name.startsWith('cae-')) continue;
    if (/^ca-[a-z-]+$/.test(name)) apps.add(name);
    else if (/^caj-/.test(name)) jobs.add(name);
  }
  for (const m of azureMd.matchAll(/`(validator-events|agent-runs-[a-z-]+|terraform-apply)`/g)) {
    queues.add(m[1]);
  }
  return {
    containerApps: [...apps].sort(),
    jobs: [...jobs].sort(),
    queues: [...queues].sort(),
  };
}

// ---------------------------------------------------------------------------
// Consistency / fail-loud layer
// ---------------------------------------------------------------------------

const setsEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// → array of violation strings. Empty = consistent. The generator refuses to
// emit a diagram when this is non-empty, so --check in contributor CI fails loud on real drift.
export function verifyModelConsistency(derived) {
  const v = [];
  // Canonical agent set = the AgentRole union in types.ts (the dispatch contract;
  // includes SREAgent even though its stub file has no ROLE const).
  const modelAgents = [...AGENT_ORDER].sort();
  const codeAgents = derived.agentUnion.map(shortName).sort();
  if (!setsEqual(modelAgents, codeAgents)) {
    v.push(
      `L3 agent set drift: model layout has [${modelAgents.join(', ')}] but the ` +
        `AgentRole union in services/agents/src/types.ts has [${codeAgents.join(', ')}]. ` +
        `Update AGENT_ORDER in the model (and the View 2 DAG) to match.`,
    );
  }
  // Every file that declares a ROLE const must name a role in the union.
  for (const r of derived.agentRoleConsts) {
    if (!derived.agentUnion.includes(r)) {
      v.push(`agent ROLE const '${r}' is not in the AgentRole union in types.ts.`);
    }
  }
  for (const [bucket, names] of Object.entries(AZURE_REFS)) {
    for (const n of names) {
      if (!derived.azure[bucket].includes(n)) {
        v.push(`Azure ref \`${n}\` (diagram ${bucket}) no longer found in azure-adapter.md.`);
      }
    }
  }
  for (const name of AGENT_ORDER) {
    if (!SAFE_GLYPHS.test(name)) v.push(`agent name "${name}" contains a non-ASCII-safe glyph.`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Render layer (pure, deterministic)
// ---------------------------------------------------------------------------

const cpLen = (s) => [...s].length;

function agentBox(name) {
  const inner = Math.max(name.length + 2, 6);
  return {
    top: `┌${'─'.repeat(inner)}┐`,
    mid: `│ ${name}${' '.repeat(inner - 1 - name.length)}│`,
    bot: `└${'─'.repeat(inner)}┘`,
  };
}

// Render the three L3 agent-row lines inside the layer-stack band, padded to the
// band width. Re-flows deterministically when the agent set changes.
export function renderAgentRow(shortNames, lineLen = AGENT_ROW_LINE_LEN) {
  const boxes = shortNames.map(agentBox);
  const compose = (k) => boxes.map((b) => b[k]).join(' ');
  const wrap = (inner) => {
    const line = `║   ${inner}`;
    const pad = lineLen - 1 - cpLen(line);
    if (pad < 0) throw new Error(`agent row overflows band width (${cpLen(line) + 1} > ${lineLen})`);
    return `${line}${' '.repeat(pad)}║`;
  };
  return [wrap(compose('top')), wrap(compose('mid')), wrap(compose('bot'))].join('\n');
}

export function renderHeader(sourceSha, sourceDate) {
  return [
    '# BNIK Software Factory — Source Diagrams',
    '',
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Source: scripts/gen-architecture-diagrams.mjs (+ .model.mjs).',
    '     Regenerate: node scripts/gen-architecture-diagrams.mjs > docs/architecture-diagrams.md',
    '     Check drift with the generator --check option. -->',
    '',
    `> **Snapshot:** sources as of \`${sourceDate}\` · ${sourceDate === 'content-derived' ? 'sha256' : 'commit'} \`${sourceSha.slice(0, 7)}\``,
    '>',
    '> Deterministically generated ASCII rendering of the architecture; the enumerable facts (agents, FSMs,' +
      ' queues, container apps, record kinds) are derived from their source-of-truth files and the layout is' +
      " held in the generator's static model. Successive snapshots `diff` cleanly. Source of truth:",
    '> - [`architecture.md`](architecture.md) — source responsibilities and record tables',
    '> - [`design/azure-adapter.md`](design/azure-adapter.md) — experimental Azure role vocabulary',
    '> - [`decisions/0011-agent-dispatch-topology.md`](decisions/0011-agent-dispatch-topology.md) — per-role Service Bus fan-out',
    '>',
    '> Regenerate with `node scripts/gen-architecture-diagrams.mjs > docs/architecture-diagrams.md`;' +
      ' compare evolution with `git log -p docs/architecture-diagrams.md`.',
    '',
    '',
  ].join('\n');
}

// Full document. `derived` carries the enumerable facts; `snapshot` is injected
// git metadata (never read from the clock here).
export function render(derived, snapshot) {
  for (const name of AGENT_ORDER) {
    if (!SAFE_GLYPHS.test(name)) throw new Error(`unsafe glyph in agent name "${name}"`);
  }
  const body = BODY_TEMPLATE.replace('{{AGENT_ROW}}', renderAgentRow(AGENT_ORDER))
    .replace('{{FSM_COUNT}}', String(derived.fsmCount))
    .replace('{{PRIM_COUNT}}', String(derived.primCount))
    .replace('{{KIND_COUNT}}', String(derived.kindCount));
  // Exactly one trailing newline, regardless of how the template ends.
  return `${renderHeader(snapshot.sha, snapshot.date)}${body}`.replace(/\n*$/, '\n');
}

// ---------------------------------------------------------------------------
// Slack payload (pure, unit-tested; webhook URL never appears here)
// ---------------------------------------------------------------------------

const SLACK_DIFF_CAP = 2800;

export function buildSlackPayload(diff, { runUrl, prUrl } = {}) {
  let body = diff.length > SLACK_DIFF_CAP ? `${diff.slice(0, SLACK_DIFF_CAP)}\n… (truncated, see PR)` : diff;
  const links = [prUrl ? `PR: ${prUrl}` : null, runUrl ? `run: ${runUrl}` : null]
    .filter(Boolean)
    .join('  ·  ');
  const text = [
    ':triangular_ruler: *architecture-diagrams.md drifted* — a source of truth changed; a PR was opened.',
    '```',
    body,
    '```',
    links,
  ]
    .filter((l) => l !== '')
    .join('\n');
  return JSON.stringify({ text });
}

// ---------------------------------------------------------------------------
// I/O layer (main only)
// ---------------------------------------------------------------------------

function readAgentFiles() {
  const dir = join(REPO_ROOT, 'services/agents/src/agents');
  return readdirSync(dir)
    .filter((f) => f.endsWith('Agent.ts'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

function countFsmFiles() {
  const dir = join(REPO_ROOT, 'services/validator/src');
  return readdirSync(dir).filter((f) => /Fsm\.ts$/.test(f)).length;
}

function deriveAll() {
  const agentFiles = readAgentFiles();
  const types = readFileSync(join(REPO_ROOT, 'services/agents/src/types.ts'), 'utf8');
  const arch = readFileSync(join(REPO_ROOT, 'docs/architecture.md'), 'utf8');
  const azure = readFileSync(join(REPO_ROOT, 'docs/design/azure-adapter.md'), 'utf8');
  return {
    agentUnion: parseAgentRoleUnion(types),
    agentRoleConsts: parseAgentRoles(agentFiles),
    fsmCount: countFsmFiles(),
    primCount: countTableRows(arch, 'Primitives'),
    kindCount: countTableRows(arch, 'Issue kinds'),
    azure: parseAzureResources(azure),
  };
}

function gitLine(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function sourceSnapshot() {
  if (!process.env.FACTORY_DIAGRAM_GIT_SNAPSHOT) {
    const inputs = [
      'docs/architecture.md', 'docs/design/azure-adapter.md',
      'scripts/gen-architecture-diagrams.mjs', 'scripts/gen-architecture-diagrams.model.mjs',
      'services/agents/src/types.ts',
      ...readAgentFiles().map(({ name }) => `services/agents/src/agents/${name}`),
      ...readdirSync(join(REPO_ROOT, 'services/validator/src')).filter((f) => /Fsm\.ts$/.test(f)).map((f) => `services/validator/src/${f}`),
    ].sort();
    const hash = createHash('sha256');
    for (const path of inputs) hash.update(path).update('\0').update(readFileSync(join(REPO_ROOT, path))).update('\0');
    return { sha: hash.digest('hex'), date: 'content-derived' };
  }
  // %ct is the committer UNIX timestamp — timezone-independent, so the rendered
  // date is identical whether the generator runs locally or in CI (UTC). On a
  // shallow CI checkout `git log -- <paths>` may be empty (no history for those
  // paths); fall back to HEAD so we never crash. The --check comparison ignores
  // the snapshot line anyway.
  let out = gitLine(['log', '-1', '--format=%H %ct', '--', ...SOURCE_PATHS]);
  if (!out) out = gitLine(['log', '-1', '--format=%H %ct']);
  const sp = out.indexOf(' ');
  return { sha: out.slice(0, sp), date: toUtcStamp(out.slice(sp + 1)) };
}

// UNIX seconds → 'YYYY-MM-DDTHH:MM:SSZ' (UTC, deterministic).
export function toUtcStamp(unixSeconds) {
  return `${new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 19)}Z`;
}

function generate() {
  const derived = deriveAll();
  const violations = verifyModelConsistency(derived);
  if (violations.length > 0) {
    console.error('gen-architecture-diagrams: model/code drift — refusing to emit:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exitCode = 1;
    return null;
  }
  return render(derived, sourceSnapshot());
}

function postSlack(diffPath) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.error('--slack-notify: SLACK_WEBHOOK_URL not set');
    process.exitCode = 1;
    return;
  }
  const diff = readFileSync(diffPath, 'utf8');
  const payload = buildSlackPayload(diff, {
    runUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
    prUrl: process.env.PR_URL || undefined,
  });
  const u = new URL(url);
  const req = request(
    { method: 'POST', hostname: u.hostname, path: u.pathname + u.search, headers: { 'content-type': 'application/json' } },
    (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        console.error(`--slack-notify: Slack returned ${res.statusCode}`);
        process.exitCode = 1;
      }
      res.resume();
    },
  );
  req.on('error', (e) => {
    console.error(`--slack-notify: ${e.message}`);
    process.exitCode = 1;
  });
  req.end(payload);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--slack-notify') {
    postSlack(argv[1]);
    return;
  }
  const doc = generate();
  if (doc === null) return;
  if (argv[0] === '--check') {
    // Compare CONTENT, ignoring the Snapshot line (its git stamp is unreliable on
    // shallow CI clones and moves independently of the diagram body). Content
    // drift — a new agent, a changed count, a renamed resource — is still caught.
    const stripSnapshot = (s) => s.replace(/^> \*\*Snapshot:\*\* .*$/m, '> **Snapshot:** <stamp>');
    const committed = readFileSync(join(REPO_ROOT, OUTPUT_REL), 'utf8');
    if (stripSnapshot(committed) === stripSnapshot(doc)) {
      console.log('gen-architecture-diagrams: OK — committed file matches generator output.');
      return;
    }
    console.error(
      `gen-architecture-diagrams: ${OUTPUT_REL} is stale. ` +
        'Run `node scripts/gen-architecture-diagrams.mjs > docs/architecture-diagrams.md` and commit.',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(doc);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
