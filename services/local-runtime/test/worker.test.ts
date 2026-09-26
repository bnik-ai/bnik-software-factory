import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { dockerEnvironment, workerArgs } from '../src/worker/docker.js';
import { parseJob, workerEnvironment } from '../src/worker/protocol.js';
import { apiProxy } from '../src/worker/proxy.js';
import { githubArchive } from '../src/worker/source.js';

const job = () => ({
  id: 'fixture-job',
  mode: 'demo',
  repository: 'example/factory-demo',
  sourceCommit: '1'.repeat(40),
  archiveSha256: '2'.repeat(64),
  prompt: 'Update the fixture.',
  maxTurns: 2,
  timeoutMs: 30_000,
  tests: ['node --test'],
  fixtureCommand: 'true',
});
test('worker jobs reject inherited configuration, missing mode and unbounded execution', () => {
  assert.equal(parseJob(job()).mode, 'demo');
  for (const change of [
    { mode: undefined },
    { maxTurns: 0 },
    { maxTurns: 61 },
    { timeoutMs: 0 },
    { timeoutMs: 1_800_001 },
    { repository: '../escape' },
    { sourceCommit: 'main' },
    { GITHUB_APP_PRIVATE_KEY: 'accidental' },
    { tests: [''] },
  ])
    assert.throws(() => parseJob({ ...job(), ...change }));
});
test('live mode cannot select fixture commands or inherit a model alias', () => {
  assert.throws(() => parseJob({ ...job(), mode: 'live', model: 'claude-example' }));
  assert.throws(() => parseJob({ ...job(), mode: 'live', fixtureCommand: undefined }));
  assert.equal(
    parseJob({ ...job(), mode: 'live', fixtureCommand: undefined, model: 'claude-example' }).model,
    'claude-example',
  );
  assert.throws(() => parseJob({ ...job(), model: 'claude-example' }));
});
test('model and Docker subprocess environments are explicit and contain no control-plane credentials', () => {
  const env = dockerEnvironment({
    PATH: '/bin',
    HOME: '/declared/docker-config',
    GITHUB_APP_PRIVATE_KEY: 'private',
    POSTGRES_PASSWORD: 'private',
    ANTHROPIC_API_KEY: 'private',
    NODE_OPTIONS: '--require=untrusted',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/declared/docker-config' });
  const worker = workerEnvironment(true);
  assert.equal(worker.ANTHROPIC_API_KEY, 'local-proxy-no-credential');
  assert.equal(worker.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18080');
  assert.equal(worker.GITHUB_APP_PRIVATE_KEY, undefined);
  assert.equal(worker.POSTGRES_PASSWORD, undefined);
  assert.equal(workerEnvironment(false).ANTHROPIC_API_KEY, undefined);
});
test('worker declaration has no bind mounts, network, host namespaces or elevated capabilities', () => {
  const args = workerArgs('fixture-worker', `sha256:${'1'.repeat(64)}`, 'fixture-egress');
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('no-new-privileges:true'));
  assert.ok(args.includes('--pids-limit'));
  assert.ok(args.includes('type=volume,src=fixture-egress,dst=/run/egress,readonly'));
  assert.ok(!args.some((a) => /type=bind|docker\.sock|privileged/.test(a)));
});
async function withProxy(
  run: (url: string, calls: { url: string; init: RequestInit }[]) => Promise<void>,
  maxRequests = 4,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const upstream = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response('{"fixture":true}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const server = createServer(
    apiProxy(
      {
        apiKey: 'synthetic-proxy-only-key',
        model: 'claude-fixture',
        maxRequests,
        timeoutMs: 10_000,
      },
      upstream,
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const message = {
  model: 'claude-fixture',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Synthetic fixture.' }],
};
test('API proxy uses fixed origin and substitutes its private credential without exposing it to the worker', async () => {
  await withProxy(async (url, calls) => {
    const response = await fetch(`${url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'x-api-key': 'worker-does-not-control-provider-key', authorization: 'untrusted' },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.anthropic.com/v1/messages?beta=true');
    assert.equal(new Headers(calls[0]?.init.headers).get('x-api-key'), 'synthetic-proxy-only-key');
    assert.equal(new Headers(calls[0]?.init.headers).get('authorization'), null);
    assert.equal(calls[0]?.init.redirect, 'error');
    assert.ok(!(await response.text()).includes('synthetic-proxy-only-key'));
  });
});
test('proxy denies arbitrary URLs, model substitution, remote tools and excessive output tokens', async () => {
  await withProxy(async (url, calls) => {
    for (const path of [
      '/admin',
      '/v1/messages/../../models',
      '/v1/messages?target=https://other.example',
    ])
      assert.equal(
        (await fetch(url + path, { method: 'POST', body: JSON.stringify(message) })).status,
        403,
      );
    for (const payload of [
      { ...message, model: 'claude-other' },
      { ...message, max_tokens: 20_000 },
      { ...message, tools: [{ type: 'web_search_20250305' }] },
      { ...message, mcp_servers: [{ url: 'https://other.example' }] },
    ])
      assert.equal(
        (await fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify(payload) }))
          .status,
        403,
      );
    assert.equal(calls.length, 0);
  }, 10);
});
test('proxy enforces request budget and rejects payloads above its byte limit', async () => {
  await withProxy(async (url, calls) => {
    assert.equal(
      (await fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify(message) })).status,
      200,
    );
    assert.equal(
      (await fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify(message) })).status,
      429,
    );
    assert.equal(calls.length, 1);
  }, 1);
  await withProxy(async (url) => {
    assert.equal(
      (await fetch(`${url}/v1/messages`, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1) }))
        .status,
      413,
    );
  });
});
const key = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const credentials = {
  repository: 'example/factory-demo',
  installationId: 1,
  appId: '1',
  appPrivateKey: key,
};
function sourceMock(change: Record<string, unknown> = {}, redirect?: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const request = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/access_tokens'))
      return Response.json(
        {
          token: 'synthetic-repository-read-token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          repositories: [{ full_name: credentials.repository }],
          permissions: { contents: 'read', metadata: 'read' },
          ...change,
        },
        { status: 201 },
      );
    if (url.endsWith('/installation/token')) return new Response(null, { status: 204 });
    if (url.includes('/git/commits/')) return Response.json({ sha: '1'.repeat(40) });
    if (redirect && url.includes('/tarball/'))
      return new Response(null, { status: 302, headers: { location: redirect } });
    return new Response('synthetic-archive');
  }) as typeof fetch;
  return { calls, request };
}
test('source preparation requests one repository with read-only permissions and revokes the token', async () => {
  const { calls, request } = sourceMock();
  assert.equal(
    (
      await githubArchive(credentials, '1'.repeat(40), new AbortController().signal, request)
    ).toString(),
    'synthetic-archive',
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    repositories: ['factory-demo'],
    permissions: { contents: 'read', metadata: 'read' },
  });
  assert.equal(calls.at(-1)?.init.method, 'DELETE');
});
test('expanded token grants or repository scope fail closed and are revoked', async () => {
  for (const change of [
    { permissions: { contents: 'write' } },
    { permissions: { contents: 'read', administration: 'read' } },
    { repositories: [{ full_name: 'example/other' }] },
    { repositories: [] },
  ]) {
    const { calls, request } = sourceMock(change);
    await assert.rejects(
      githubArchive(credentials, '1'.repeat(40), new AbortController().signal, request),
      /source_preparation_failed/,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls.at(-1)?.init.method, 'DELETE');
  }
});
test('archive redirects cannot forward GitHub authorization to arbitrary destinations', async () => {
  for (const target of [
    'http://127.0.0.1/secret',
    `https://codeload.github.com/example/other/legacy.tar.gz/${'1'.repeat(40)}`,
    'https://evil.example/archive',
  ]) {
    const { calls, request } = sourceMock({}, target);
    await assert.rejects(
      githubArchive(credentials, '1'.repeat(40), new AbortController().signal, request),
      /source_preparation_failed/,
    );
    assert.ok(!calls.some((c) => c.url === target));
    assert.equal(calls.at(-1)?.init.method, 'DELETE');
  }
});
