import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { GitHubMerger, MERGER_PERMISSIONS } from '../src/autonomy/merger.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const TREE = 'd'.repeat(40);

/** A GitHub stand-in that records every request and answers like the real API. */
function github(options: { mergeStatus?: number } = {}) {
  const calls: { method: string; path: string; body: unknown; auth: string }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    const path = url.replace('https://api.github.com', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = String((init?.headers as Record<string, string>).Authorization);
    calls.push({ method: init?.method ?? 'GET', path, body, auth });
    const reply = (status: number, json?: unknown) =>
      new Response(json === undefined ? null : JSON.stringify(json), { status });
    if (path.endsWith('/access_tokens'))
      return reply(201, {
        token: 'ghs_merger',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: body.permissions,
        repositories: body.repository_ids.map((id: number) => ({ id })),
      });
    if (path === '/installation/token') return reply(204);
    if (path.endsWith('/reviews')) return reply(200, { id: 77 });
    if (path.endsWith('/reviews/77/dismissals')) return reply(200, { id: 77, state: 'DISMISSED' });
    if (path.endsWith('/merge'))
      return reply(options.mergeStatus ?? 200, { sha: MERGE, merged: true });
    if (path.endsWith('/pulls/2'))
      return reply(200, {
        state: 'closed',
        merged: true,
        head: { sha: HEAD },
        base: { sha: MERGE },
        merge_commit_sha: MERGE,
        merged_at: '2026-09-28T00:00:00Z',
        merged_by: { id: 9001, login: 'factory-merger[bot]', type: 'Bot' },
      });
    if (path.includes('/git/commits/'))
      return reply(200, { sha: MERGE, tree: { sha: TREE }, parents: [{ sha: BASE }] });
    return reply(404, { message: 'unexpected' });
  };
  return { calls, request };
}
const merger = (request: typeof fetch) =>
  new GitHubMerger(
    { appId: '4242', appPrivateKey: KEY, installationId: 99 },
    { fullName: 'example/factory-demo', id: 101 },
    'factory-merger',
    new AbortController().signal,
    request,
  );

test('the merger mints one narrowly scoped token per action, merges the exact head by squash and revokes it', async () => {
  const g = github();
  const result = await merger(g.request).perform(async (host) => {
    assert.equal(host.mergerLogin, 'factory-merger[bot]');
    await host.approve(2, HEAD, 'Approved by the bounded-autonomy policy.\n\nmerge-decision: x');
    const merged = await host.merge(2, HEAD, 'Fix sum', 'factory-run: r1');
    const facts = await host.pull(2);
    const commit = await host.commit(facts.mergeCommitSha as string);
    return { merged, facts, commit };
  });
  assert.equal(result.merged.sha, MERGE);
  assert.equal(result.facts.mergedBy?.login, 'factory-merger[bot]');
  assert.deepEqual(result.commit, { sha: MERGE, tree: TREE, parents: [BASE] });
  const mint = g.calls[0] as (typeof g.calls)[number];
  assert.equal(mint.path, '/app/installations/99/access_tokens');
  assert.deepEqual(mint.body, { permissions: MERGER_PERMISSIONS, repository_ids: [101] });
  assert.ok(mint.auth.startsWith('Bearer ey'), 'the mint is signed as the App');
  const approve = g.calls.find((call) =>
    call.path.endsWith('/reviews'),
  ) as (typeof g.calls)[number];
  assert.deepEqual(approve.body, {
    commit_id: HEAD,
    event: 'APPROVE',
    body: 'Approved by the bounded-autonomy policy.\n\nmerge-decision: x',
  });
  const merge = g.calls.find((call) => call.path.endsWith('/merge')) as (typeof g.calls)[number];
  assert.equal(merge.method, 'PUT');
  assert.equal(merge.path, '/repos/example/factory-demo/pulls/2/merge');
  assert.deepEqual(merge.body, {
    sha: HEAD,
    merge_method: 'squash',
    commit_title: 'Fix sum',
    commit_message: 'factory-run: r1',
  });
  // Every call after the mint carries the minted token; the last call revokes it.
  for (const call of g.calls.slice(1)) assert.equal(call.auth, 'Bearer ghs_merger');
  assert.deepEqual(g.calls.at(-1), {
    method: 'DELETE',
    path: '/installation/token',
    body: undefined,
    auth: 'Bearer ghs_merger',
  });
  assert.equal(merger(g.request).lastTokenRevoked, null, 'nothing performed yet');
});
test('the merger dismisses its own review within the same scope, by review id', async () => {
  const g = github();
  await merger(g.request).perform((host) => host.dismiss(2, 77, 'attempt did not merge'));
  const dismissal = g.calls.find((call) => call.path.endsWith('/dismissals'));
  assert.deepEqual(dismissal, {
    method: 'PUT',
    path: '/repos/example/factory-demo/pulls/2/reviews/77/dismissals',
    body: { message: 'attempt did not merge' },
    auth: 'Bearer ghs_merger',
  });
  await assert.rejects(
    merger(g.request).perform((host) => host.dismiss(2, 0, 'x')),
    /github_review_invalid/,
  );
});
test('the performing merger records that its token was revoked', async () => {
  const g = github();
  const performing = merger(g.request);
  await performing.perform(async (host) => host.pull(2));
  assert.equal(performing.lastTokenRevoked, true);
  assert.equal(g.calls.at(-1)?.path, '/installation/token');
});

test('GitHub refusals become distinct reasons and a bad token scope stops before any write', async () => {
  const refused = github({ mergeStatus: 405 });
  await assert.rejects(
    merger(refused.request).perform((host) => host.merge(2, HEAD, 't', 'm')),
    /github_merge_not_allowed/,
  );
  assert.ok(
    refused.calls.some((call) => call.path === '/installation/token'),
    'token revoked after a refusal',
  );
  const moved = github({ mergeStatus: 409 });
  await assert.rejects(
    merger(moved.request).perform((host) => host.merge(2, HEAD, 't', 'm')),
    /github_merge_head_changed/,
  );
  const wide = github();
  const original = wide.request;
  const widened: typeof fetch = async (input, init) => {
    const response = await original(input, init);
    if (String(input).endsWith('/access_tokens')) {
      const json = (await response.json()) as { permissions: Record<string, string> };
      json.permissions = { ...json.permissions, administration: 'write' };
      return new Response(JSON.stringify(json), { status: 201 });
    }
    return response;
  };
  await assert.rejects(
    merger(widened).perform((host) => host.merge(2, HEAD, 't', 'm')),
    /merger_token_scope_invalid/,
  );
  assert.equal(wide.calls.filter((call) => call.path.endsWith('/merge')).length, 0);
});
