import type { Actor } from './types.js';

// Spec: ADR 0009 §D + §2 (commit-trailer + structural-comment attribution),
// ADR 0009 rule 4 (branch↔commit integrity), ADR 0008 §2 (branch grammar +
// canonical regex), docs/design/validator-bot.md "Action attribution" +
// "Branch ref policy" + the structural-comment carve-out.
//
// ADR 0009 mandates ONE canonical parser for the `SF-*` trailers and the
// `sf:structural`/`sf:agent`/`run` comment attributes — this module is it.
// Pure: no I/O, no clock. Callers (push / PR-review / comment event handlers)
// resolve Actor from the stamp on the record; under single-App (ADR 0009 §1)
// the stamp — NOT `sender.login` — carries the per-agent/-model identity.
//
// Out of scope here: issue label/status transitions carry NO stamp (no commit,
// no comment), so their actor is recoverable only by correlating the webhook
// to the API caller in the substrate (agent_runs / tool-call audit) — a
// substrate-lookup step, not a payload parse.

// ADR 0008 §2: `run` is a ULID — 26-char Crockford base32 (excludes I/L/O/U),
// time-sortable. Verified against ulid/spec (ADR 0008 References).
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ADR 0008 §2 canonical regex (anchored on the ref minus any refs/heads/
// prefix). v0 role set is build|design — the only PR-producing agents that
// create feeder branches. `lane` is deferred (ADR 0008 rule 6) and absent.
const BRANCH_REF_RE = /^sf\/(T-[0-9]+)\/([0-9A-HJKMNP-TV-Z]{26})\/((?:build|design)@[a-z0-9.-]+)$/;

// ADR 0008 §2 `role@model` vocabulary: the model segment is `[a-z0-9.-]+`.
// ADR 0009 §2 reuses it for stamps, so a stamp's model must conform too —
// `build@opus 4` / `review@foo/bar` are malformed, not valid attribution.
const AGENT_MODEL_RE = /^[a-z0-9.-]+$/;

// role → Actor. Covers all seven L3 roles: branch/commit stamps use
// build|design (ADR 0008), but structural-comment stamps attribute reviews
// and notices to review|ops|sre|spec|planner|design too (ADR 0009 §D table).
const ROLE_TO_ACTOR: ReadonlyMap<string, Actor> = new Map([
  ['spec', 'SpecAgent'],
  ['design', 'DesignAgent'],
  ['planner', 'PlannerAgent'],
  ['build', 'BuildAgent'],
  ['review', 'ReviewAgent'],
  ['ops', 'OpsAgent'],
  ['sre', 'SREAgent'],
]);

// Carve-out (validator-bot.md, canonical): a structural comment is identified
// by a LEADING `sf:structural` token in its opening HTML comment, optionally
// followed by key=value attributes — matched on the token, NOT the exact
// string `<!-- sf:structural -->`.
const STRUCTURAL_TOKEN = 'sf:structural';
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/;
const ATTR_RE = /(\S+?)=(\S+)/g;

export interface AgentStamp {
  agent: string; // raw `role@model` spec
  run: string; // ULID
  task?: string; // `T-<n>` (commit trailers carry it; comments need not)
}

export type ActorFromSpec =
  | { ok: true; actor: Actor }
  | { ok: false; reason: 'malformed_agent_spec' | 'unknown_role' };

// `role@model` → Actor. Shape + closed role allow-list; no `system`/`human`
// fallback (stamps attribute to agents only).
export function resolveActorFromAgentSpec(agentSpec: string): ActorFromSpec {
  const at = agentSpec.indexOf('@');
  if (at <= 0 || at === agentSpec.length - 1) return { ok: false, reason: 'malformed_agent_spec' };
  if (!AGENT_MODEL_RE.test(agentSpec.slice(at + 1))) {
    return { ok: false, reason: 'malformed_agent_spec' };
  }
  const actor = ROLE_TO_ACTOR.get(agentSpec.slice(0, at));
  if (actor === undefined) return { ok: false, reason: 'unknown_role' };
  return { ok: true, actor };
}

// git commit trailers (git-interpret-trailers): RFC-822-style `Key: value`
// lines in the LAST block of the message. Returns the SF-* trailers only.
export function parseCommitTrailers(message: string): Map<string, string> {
  const lines = message.replace(/\s+$/, '').split('\n');
  const block: Array<[string, string]> = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') break; // top of the trailer block
    const m = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
    if (m === null) break; // a non-trailer line ends the block
    block.push([m[1] as string, (m[2] as string).trim()]);
  }
  const out = new Map<string, string>();
  for (const [k, v] of block) if (k.startsWith('SF-')) out.set(k, v);
  return out;
}

export type CommitStampResult =
  | { ok: true; stamp: AgentStamp; actor: Actor }
  | { ok: false; reason: 'missing_trailers' | 'bad_run' | 'malformed_agent_spec' | 'unknown_role' };

// ADR 0009 §2: SF-Agent / SF-Run / SF-Task are required on an agent commit.
export function resolveActorFromCommit(message: string): CommitStampResult {
  const t = parseCommitTrailers(message);
  const agent = t.get('SF-Agent');
  const run = t.get('SF-Run');
  const task = t.get('SF-Task');
  if (agent === undefined || run === undefined || task === undefined) {
    return { ok: false, reason: 'missing_trailers' };
  }
  if (!ULID_RE.test(run)) return { ok: false, reason: 'bad_run' };
  const resolved = resolveActorFromAgentSpec(agent);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true, stamp: { agent, run, task }, actor: resolved.actor };
}

export interface StructuralComment {
  isStructural: boolean;
  attributes: Map<string, string>;
}

// Carve-out token-match. Reads the FIRST HTML comment; structural iff its
// trimmed body starts with the `sf:structural` token. Attributes are the
// whitespace-separated key=value pairs that follow (e.g. sf:agent, run).
export function parseStructuralComment(body: string): StructuralComment {
  const m = HTML_COMMENT_RE.exec(body);
  if (m === null) return { isStructural: false, attributes: new Map() };
  const inner = (m[1] as string).trim();
  if (inner !== STRUCTURAL_TOKEN && !inner.startsWith(`${STRUCTURAL_TOKEN} `)) {
    return { isStructural: false, attributes: new Map() };
  }
  const rest = inner.slice(STRUCTURAL_TOKEN.length);
  const attributes = new Map<string, string>();
  for (const attr of rest.matchAll(ATTR_RE)) attributes.set(attr[1] as string, attr[2] as string);
  return { isStructural: true, attributes };
}

export type CommentStampResult =
  | { ok: true; actor: Actor; run: string }
  | {
      ok: false;
      reason:
        | 'not_structural'
        | 'missing_agent'
        | 'missing_run'
        | 'bad_run'
        | 'malformed_agent_spec'
        | 'unknown_role';
    };

// ADR 0009 §D: a structural comment attributes via `sf:agent=<role@model>
// run=<run>`. BOTH are required — `run` is the audit join key into agent_runs,
// so an agent stamp without it loses the per-run granularity the model exists
// to provide. `run` must be a ULID.
export function resolveActorFromComment(body: string): CommentStampResult {
  const parsed = parseStructuralComment(body);
  if (!parsed.isStructural) return { ok: false, reason: 'not_structural' };
  const agent = parsed.attributes.get('sf:agent');
  if (agent === undefined) return { ok: false, reason: 'missing_agent' };
  const run = parsed.attributes.get('run');
  if (run === undefined) return { ok: false, reason: 'missing_run' };
  if (!ULID_RE.test(run)) return { ok: false, reason: 'bad_run' };
  const resolved = resolveActorFromAgentSpec(agent);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true, actor: resolved.actor, run };
}

export interface BranchSegments {
  task: string; // `T-<n>`
  run: string; // ULID
  agent: string; // `role@model`
}

export type BranchRefResult =
  | { ok: true; segments: BranchSegments }
  | { ok: false; reason: 'not_sf_branch' };

// ADR 0008 §2: parse `sf/<task>/<run>/<agent>` (optionally `refs/heads/`-
// prefixed). Rejects datetime runs, lane segments, ad-hoc names by construction.
export function parseBranchRef(ref: string): BranchRefResult {
  const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  const m = BRANCH_REF_RE.exec(name);
  if (m === null) return { ok: false, reason: 'not_sf_branch' };
  return {
    ok: true,
    segments: { task: m[1] as string, run: m[2] as string, agent: m[3] as string },
  };
}

export type IntegrityResult = { ok: true } | { ok: false; mismatches: ReadonlyArray<string> };

// ADR 0009 rule 4: a head commit's SF-* trailers MUST equal the branch's
// task/run/agent segments. Mismatch is a violation (soft-flag v0).
export function crossCheckTrailersVsBranch(
  stamp: AgentStamp,
  branch: BranchSegments,
): IntegrityResult {
  const mismatches: string[] = [];
  if (stamp.agent !== branch.agent) mismatches.push('SF-Agent');
  if (stamp.run !== branch.run) mismatches.push('SF-Run');
  if (stamp.task !== undefined && stamp.task !== branch.task) mismatches.push('SF-Task');
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}
