// Tests for gen-architecture-diagrams.mjs — pure functions only (no fs/git/net),
// mirroring doc-pr-sync.test.mjs. Run: node --test 'scripts/*.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSlackPayload,
  countTableRows,
  parseAgentRoleUnion,
  parseAgentRoles,
  parseAzureResources,
  render,
  renderAgentRow,
  renderHeader,
  shortName,
  toUtcStamp,
  verifyModelConsistency,
} from './gen-architecture-diagrams.mjs';
import { AGENT_ORDER, AGENT_ROW_LINE_LEN } from './gen-architecture-diagrams.model.mjs';

const cpLen = (s) => [...s].length;

// A consistent fixture matching today's real architecture.
const UNION = ['BuildAgent', 'DesignAgent', 'OpsAgent', 'PlannerAgent', 'ReviewAgent', 'SREAgent', 'SpecAgent'];
const goodDerived = () => ({
  agentUnion: [...UNION].sort(),
  agentRoleConsts: ['BuildAgent', 'DesignAgent', 'OpsAgent', 'PlannerAgent', 'ReviewAgent', 'SpecAgent'], // no SRE const
  fsmCount: 7,
  primCount: 6,
  kindCount: 6,
  azure: {
    containerApps: ['ca-admin', 'ca-agent', 'ca-cf-tunnel', 'ca-terraform', 'ca-webhook'],
    jobs: ['caj-orchestrator', 'caj-tf-apply', 'caj-validator'],
    queues: ['agent-runs-dispatch', 'validator-events'],
  },
});
const SNAP = { sha: 'abcdef1234567', date: '2026-06-03T06:03:02Z' };

// --- determinism ---

test('render is deterministic and ends in exactly one newline', () => {
  const a = render(goodDerived(), SNAP);
  const b = render(goodDerived(), SNAP);
  assert.equal(a, b);
  assert.match(a, /[^\n]\n$/); // exactly one trailing newline
});

test('render never reads the wall clock (date comes only from snapshot arg)', () => {
  const out = render(goodDerived(), { sha: 'deadbeefcafe', date: '1999-12-31T23:59:59Z' });
  assert.ok(out.includes('1999-12-31T23:59:59Z'));
  assert.ok(out.includes('commit `deadbee`'));
});

test('derived counts are substituted into the body', () => {
  const out = render({ ...goodDerived(), fsmCount: 9, primCount: 8, kindCount: 7 }, SNAP);
  assert.ok(out.includes('9 per-kind FSMs'));
  assert.ok(out.includes('8 prims · 7 kinds'));
});

test('toUtcStamp formats UNIX seconds as UTC, timezone-independent', () => {
  assert.equal(toUtcStamp('1780466582'), '2026-06-03T06:03:02Z');
  assert.equal(toUtcStamp(1780466582), '2026-06-03T06:03:02Z');
});

test('renderHeader is a pure function of its args', () => {
  assert.equal(renderHeader('abcdef1234567', '2026-06-03T06:03:02Z'), renderHeader('abcdef1234567', '2026-06-03T06:03:02Z'));
});

// --- agent row (the data-driven re-flow) ---

test('renderAgentRow reproduces the current L3 row byte-for-byte', () => {
  const lines = renderAgentRow(AGENT_ORDER).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(
    lines[1],
    '║   │ Spec │ │ Design │ │ Planner │ │ Build │ │ Review │ │ Ops  │ │ SRE  │                          ║',
  );
  for (const l of lines) assert.equal(cpLen(l), AGENT_ROW_LINE_LEN);
});

test('renderAgentRow re-flows when an agent is added, staying band-width-stable', () => {
  const lines = renderAgentRow([...AGENT_ORDER, 'Oracle']).split('\n');
  assert.ok(lines[1].includes('│ Oracle │'));
  for (const l of lines) assert.equal(cpLen(l), AGENT_ROW_LINE_LEN);
});

test('renderAgentRow throws if the row would overflow the band', () => {
  assert.throws(() => renderAgentRow(Array(20).fill('Wide')), /overflows band width/);
});

// --- consistency / fail-loud ---

test('verifyModelConsistency is clean for the real architecture', () => {
  assert.deepEqual(verifyModelConsistency(goodDerived()), []);
});

test('flags a NEW agent in the union that the model has not absorbed', () => {
  const d = goodDerived();
  d.agentUnion = [...d.agentUnion, 'OracleAgent'].sort();
  const v = verifyModelConsistency(d);
  assert.equal(v.length, 1);
  assert.match(v[0], /agent set drift/);
});

test('flags a REMOVED agent (model lists one the union no longer has)', () => {
  const d = goodDerived();
  d.agentUnion = d.agentUnion.filter((r) => r !== 'SREAgent'); // drop SRE
  const v = verifyModelConsistency(d);
  assert.ok(v.some((x) => /agent set drift/.test(x)));
});

test('flags a ROLE const that is not in the AgentRole union', () => {
  const d = goodDerived();
  d.agentRoleConsts = [...d.agentRoleConsts, 'GhostAgent'];
  const v = verifyModelConsistency(d);
  assert.ok(v.some((x) => /GhostAgent.*not in the AgentRole union/.test(x)));
});

test('flags an Azure ref the diagram depends on disappearing from azure-adapter.md', () => {
  const d = goodDerived();
  d.azure.containerApps = d.azure.containerApps.filter((n) => n !== 'ca-webhook');
  const v = verifyModelConsistency(d);
  assert.ok(v.some((x) => /ca-webhook.*no longer found/.test(x)));
});

// --- parsers ---

test('parseAgentRoleUnion extracts the seven roles, sorted', () => {
  const types = `export type AgentRole =\n  | 'SpecAgent'\n  | 'DesignAgent'\n  | 'PlannerAgent'\n  | 'BuildAgent'\n  | 'ReviewAgent'\n  | 'OpsAgent'\n  | 'SREAgent';\n`;
  assert.deepEqual(parseAgentRoleUnion(types), [...UNION].sort());
});

test('parseAgentRoles reads ROLE consts and skips files without one', () => {
  const files = [
    { name: 'specAgent.ts', text: "const ROLE = 'SpecAgent' as const;" },
    { name: 'sreAgent.ts', text: '// SREAgent stub — no ROLE const' },
  ];
  assert.deepEqual(parseAgentRoles(files), ['SpecAgent']);
});

test('countTableRows counts ** rows under a section and throws when missing', () => {
  const md = [
    '#### Primitives',
    '| Primitive | Purpose |',
    '| --- | --- |',
    '| **Issue** | x |',
    '| **Pull Request** | y |',
    '',
    '#### Issue kinds',
    '| **Goal** | z |',
  ].join('\n');
  assert.equal(countTableRows(md, 'Primitives'), 2);
  assert.equal(countTableRows(md, 'Issue kinds'), 1);
  assert.throws(() => countTableRows(md, 'Nope'), /not found/);
});

test('parseAzureResources extracts ca-/caj-/queues, strips prefix, excludes cae-', () => {
  const md = [
    '| `sfac-dev-region-ca-webhook` | HTTP |',
    '| `sfac-dev-region-cae-main` | env |',
    '| `caj-validator` | job |',
    '| `agent-runs-dispatch` | queue | `validator-events` |',
  ].join('\n');
  const r = parseAzureResources(md);
  assert.ok(r.containerApps.includes('ca-webhook'));
  assert.ok(!r.containerApps.some((n) => n.startsWith('cae')));
  assert.ok(r.jobs.includes('caj-validator'));
  assert.deepEqual(r.queues, ['agent-runs-dispatch', 'validator-events']);
});

test('shortName strips the Agent suffix', () => {
  assert.equal(shortName('PlannerAgent'), 'Planner');
  assert.equal(shortName('SRE'), 'SRE');
});

// --- Slack payload ---

test('buildSlackPayload truncates a long diff and stays valid JSON', () => {
  const diff = 'x'.repeat(5000);
  const payload = buildSlackPayload(diff, { runUrl: 'https://run', prUrl: 'https://pr' });
  const obj = JSON.parse(payload);
  assert.ok(obj.text.includes('… (truncated, see PR)'));
  assert.ok(obj.text.includes('https://pr'));
  assert.ok(obj.text.includes('https://run'));
  assert.ok(obj.text.length < 5000);
});

test('buildSlackPayload keeps a short diff intact and omits absent links', () => {
  const obj = JSON.parse(buildSlackPayload('-a\n+b', {}));
  assert.ok(obj.text.includes('-a\n+b'));
  assert.ok(!obj.text.includes('truncated'));
  assert.ok(!obj.text.includes('PR:'));
});
