import { describe, expect, test } from 'vitest';
import {
  crossCheckTrailersVsBranch,
  parseBranchRef,
  parseCommitTrailers,
  parseStructuralComment,
  resolveActorFromAgentSpec,
  resolveActorFromComment,
  resolveActorFromCommit,
} from '../src/attributionStamp.js';

const ULID = '01JR1C5N4P8XQ2WB6KDF3YH9SM';

describe('resolveActorFromAgentSpec', () => {
  test('maps each role to its Actor', () => {
    expect(resolveActorFromAgentSpec('build@opus-4-8')).toEqual({ ok: true, actor: 'BuildAgent' });
    expect(resolveActorFromAgentSpec('review@sonnet-4-6')).toEqual({
      ok: true,
      actor: 'ReviewAgent',
    });
    expect(resolveActorFromAgentSpec('sre@haiku-4-5')).toEqual({ ok: true, actor: 'SREAgent' });
  });
  test('rejects unknown role and malformed spec (no system/human fallback)', () => {
    expect(resolveActorFromAgentSpec('system@opus-4-8')).toEqual({
      ok: false,
      reason: 'unknown_role',
    });
    expect(resolveActorFromAgentSpec('build')).toEqual({
      ok: false,
      reason: 'malformed_agent_spec',
    });
    expect(resolveActorFromAgentSpec('@opus-4-8')).toEqual({
      ok: false,
      reason: 'malformed_agent_spec',
    });
    expect(resolveActorFromAgentSpec('build@')).toEqual({
      ok: false,
      reason: 'malformed_agent_spec',
    });
  });
  test('rejects a known role with a malformed model segment (ADR 0008 [a-z0-9.-]+)', () => {
    expect(resolveActorFromAgentSpec('build@opus 4')).toEqual({
      ok: false,
      reason: 'malformed_agent_spec',
    });
    expect(resolveActorFromAgentSpec('review@foo/bar')).toEqual({
      ok: false,
      reason: 'malformed_agent_spec',
    });
    expect(resolveActorFromAgentSpec('build@OPUS')).toEqual({
      ok: false,
      reason: 'malformed_agent_spec',
    });
  });
});

describe('parseCommitTrailers', () => {
  test('extracts only the trailing SF-* block', () => {
    const msg = `add: thing\n\nbody line\n\nSF-Agent: build@opus-4-8\nSF-Run: ${ULID}\nSF-Task: T-482`;
    const t = parseCommitTrailers(msg);
    expect(t.get('SF-Agent')).toBe('build@opus-4-8');
    expect(t.get('SF-Run')).toBe(ULID);
    expect(t.get('SF-Task')).toBe('T-482');
  });
  test('ignores non-SF trailers and body text', () => {
    const msg = 'subject\n\nSigned-off-by: x <x@e.com>\nSF-Agent: build@opus-4-8';
    const t = parseCommitTrailers(msg);
    expect(t.has('Signed-off-by')).toBe(false);
    expect(t.get('SF-Agent')).toBe('build@opus-4-8');
  });
  test('returns empty when the last block is not trailers', () => {
    expect(parseCommitTrailers('subject\n\njust prose, no trailers').size).toBe(0);
  });
});

describe('resolveActorFromCommit', () => {
  const trailers = `SF-Agent: build@opus-4-8\nSF-Run: ${ULID}\nSF-Task: T-482`;
  test('resolves a complete, valid stamp', () => {
    const r = resolveActorFromCommit(`add: x\n\n${trailers}`);
    expect(r).toEqual({
      ok: true,
      stamp: { agent: 'build@opus-4-8', run: ULID, task: 'T-482' },
      actor: 'BuildAgent',
    });
  });
  test('missing any required trailer fails', () => {
    expect(resolveActorFromCommit(`x\n\nSF-Agent: build@opus-4-8\nSF-Run: ${ULID}`)).toEqual({
      ok: false,
      reason: 'missing_trailers',
    });
  });
  test('non-ULID run fails bad_run', () => {
    const r = resolveActorFromCommit(
      'x\n\nSF-Agent: build@opus-4-8\nSF-Run: 202601012355\nSF-Task: T-482',
    );
    expect(r).toEqual({ ok: false, reason: 'bad_run' });
  });
  test('unknown role fails', () => {
    const r = resolveActorFromCommit(
      `x\n\nSF-Agent: system@opus-4-8\nSF-Run: ${ULID}\nSF-Task: T-482`,
    );
    expect(r).toEqual({ ok: false, reason: 'unknown_role' });
  });
});

describe('parseStructuralComment — token match, not literal', () => {
  test('bare marker is structural with no attributes', () => {
    const r = parseStructuralComment('<!-- sf:structural -->');
    expect(r.isStructural).toBe(true);
    expect(r.attributes.size).toBe(0);
  });
  test('attributed marker is structural and parses attributes', () => {
    const r = parseStructuralComment(`<!-- sf:structural sf:agent=review@opus-4-8 run=${ULID} -->`);
    expect(r.isStructural).toBe(true);
    expect(r.attributes.get('sf:agent')).toBe('review@opus-4-8');
    expect(r.attributes.get('run')).toBe(ULID);
  });
  test('non-structural HTML comment is not structural', () => {
    expect(parseStructuralComment('<!-- just a note -->').isStructural).toBe(false);
  });
  test('plain text without an HTML comment is not structural', () => {
    expect(parseStructuralComment('hello world').isStructural).toBe(false);
  });
});

describe('resolveActorFromComment', () => {
  test('resolves agent from an attributed structural comment', () => {
    const r = resolveActorFromComment(
      `verdict\n<!-- sf:structural sf:agent=review@opus-4-8 run=${ULID} -->`,
    );
    expect(r).toEqual({ ok: true, actor: 'ReviewAgent', run: ULID });
  });
  test('structural but missing sf:agent fails', () => {
    expect(resolveActorFromComment('<!-- sf:structural -->')).toEqual({
      ok: false,
      reason: 'missing_agent',
    });
  });
  test('sf:agent without run fails missing_run (run is the audit join key)', () => {
    expect(resolveActorFromComment('<!-- sf:structural sf:agent=review@opus-4-8 -->')).toEqual({
      ok: false,
      reason: 'missing_run',
    });
  });
  test('non-structural comment fails not_structural', () => {
    expect(resolveActorFromComment('<!-- note -->')).toEqual({
      ok: false,
      reason: 'not_structural',
    });
  });
  test('bad run fails bad_run', () => {
    expect(
      resolveActorFromComment('<!-- sf:structural sf:agent=review@opus-4-8 run=nope -->'),
    ).toEqual({
      ok: false,
      reason: 'bad_run',
    });
  });
});

describe('parseBranchRef', () => {
  test('parses a valid ref, with or without refs/heads/ prefix', () => {
    const want = { ok: true, segments: { task: 'T-482', run: ULID, agent: 'build@opus-4-8' } };
    expect(parseBranchRef(`sf/T-482/${ULID}/build@opus-4-8`)).toEqual(want);
    expect(parseBranchRef(`refs/heads/sf/T-482/${ULID}/build@opus-4-8`)).toEqual(want);
  });
  test('rejects datetime run, lane segment, and non-PR roles', () => {
    expect(parseBranchRef('sf/T-482/202601012355/build@opus-4-8')).toEqual({
      ok: false,
      reason: 'not_sf_branch',
    });
    expect(parseBranchRef(`sf/T-482/${ULID}/build@opus-4-8/mvp`)).toEqual({
      ok: false,
      reason: 'not_sf_branch',
    });
    expect(parseBranchRef(`sf/T-482/${ULID}/spec@opus-4-8`)).toEqual({
      ok: false,
      reason: 'not_sf_branch',
    });
  });
  test('rejects ad-hoc names', () => {
    expect(parseBranchRef('feature/add-login')).toEqual({ ok: false, reason: 'not_sf_branch' });
  });
});

describe('crossCheckTrailersVsBranch — ADR 0009 rule 4', () => {
  const branch = { task: 'T-482', run: ULID, agent: 'build@opus-4-8' };
  test('matching trailers pass', () => {
    expect(
      crossCheckTrailersVsBranch({ agent: 'build@opus-4-8', run: ULID, task: 'T-482' }, branch),
    ).toEqual({
      ok: true,
    });
  });
  test('reports each mismatched field', () => {
    const r = crossCheckTrailersVsBranch(
      { agent: 'design@opus-4-8', run: '01JR1A8KF3M2YB7N6V4PXR9TC0', task: 'T-999' },
      branch,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect([...r.mismatches].sort()).toEqual(['SF-Agent', 'SF-Run', 'SF-Task']);
  });
});
