import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import {
  approvedJob,
  prepareTask,
  taskSnapshot,
  verifyActivation,
} from '../src/github/activation.js';
import {
  INTAKE_EVENTS,
  INTAKE_PERMISSIONS,
  InstallationClient,
  REVIEW_PERMISSIONS,
} from '../src/github/client.js';
import {
  FixtureGitHub,
  commit,
  event,
  liveConfig,
  liveEnv,
  repository,
  task,
} from './github-fixtures.js';
import { policy } from './merge-fixtures.js';

test('live intake requires explicit immutable repository, HTTPS endpoint, human operators and execution selection', () => {
  for (const missing of [
    'FACTORY_REPOSITORY_ID',
    'FACTORY_WEBHOOK_URL',
    'FACTORY_OPERATORS',
    'FACTORY_EXECUTION',
  ])
    assert.throws(() => resolveConfig({ ...liveEnv(), [missing]: undefined }));
  for (const url of [
    'http://factory.example.com/webhook',
    'https://user:key@factory.example.com/webhook',
    'https://factory.example.com/webhook?token=no',
    'https://127.0.0.1/webhook',
    'https://factory.example.com/admin',
  ])
    assert.throws(() => resolveConfig({ ...liveEnv(), FACTORY_WEBHOOK_URL: url }));
  for (const operators of ['', 'user,user', 'factory[bot]', '*'])
    assert.throws(() => resolveConfig({ ...liveEnv(), FACTORY_OPERATORS: operators }));
  assert.equal(liveConfig().execution, 'disabled');
  assert.throws(
    () => resolveConfig({ ...liveEnv(), ANTHROPIC_API_KEY: 'accidental' }),
    /must_not_receive/,
  );
  assert.throws(
    () => resolveConfig({ ...liveEnv(), FACTORY_EXECUTION: 'manual' }),
    /ANTHROPIC_API_KEY/,
  );
});
test('Task snapshot binds title, content, labels and identity, and parses only bounded explicit execution fields', () => {
  const config = liveConfig();
  const issue = task();
  const hash = taskSnapshot(config, issue, commit).taskHash;
  for (const changed of [
    { ...issue, title: 'changed' },
    { ...issue, body: `${issue.body}\nchanged` },
    { ...issue, id: 99 },
  ])
    assert.notEqual(taskSnapshot(config, changed, commit).taskHash, hash);
  for (const changed of [
    { ...issue, state: 'closed' },
    { ...issue, locked: true },
    { ...issue, pull_request: {} },
    { ...issue, body: 'public text alone' },
    { ...issue, labels: [] },
    { ...issue, body: (issue.body ?? '').replace('30000', '999999999') },
    { ...issue, labels: [{ name: undefined as unknown as string }] },
  ])
    assert.throws(() => taskSnapshot(config, changed, commit), /task_/);
});
test('authorized human command is bound to the current Task and default-branch commit', async () => {
  const github = new FixtureGitHub();
  const proof = await verifyActivation(liveConfig(), github, github.current);
  assert.equal(proof.actorLogin, 'example-maintainer');
  assert.equal(proof.sourceCommit, commit);
  assert.equal(
    approvedJob(liveConfig(), 'fixture', proof, '0'.repeat(64)).prompt,
    'Fix arithmetic and verify it.',
  );
  github.currentHead = 'b'.repeat(40);
  await assert.rejects(prepareTask(liveConfig(), github, 1, commit), /current_default_head/);
});
test('outsiders, bot attribution, author_association and edited/comment commands never authorize', async () => {
  for (const changes of [
    {
      sender: { id: 55, login: 'outsider', type: 'User' },
      author_association: 'OWNER',
    },
    { sender: { id: 55, login: 'example-maintainer', type: 'Bot' } },
    { action: 'edited' },
    {
      comment: {
        ...event().comment,
        body: '<!-- sf:structural sf:agent=planner@fixture -->',
      },
    },
  ]) {
    const github = new FixtureGitHub();
    await assert.rejects(verifyActivation(liveConfig(), github, { ...github.current, ...changes }));
    assert.equal(github.reads.length, 0);
  }
});
test('current permission revocation, comment edits, Task edits, identity mismatch and stale approval fail closed', async () => {
  const scenarios = ['permission', 'comment', 'task', 'identity', 'expired'] as const;
  for (const scenario of scenarios) {
    const github = new FixtureGitHub();
    const delivered = structuredClone(github.current);
    if (scenario === 'permission') github.permission = 'read';
    if (scenario === 'comment')
      github.current.comment.updated_at = new Date(Date.now() + 1000).toISOString();
    if (scenario === 'task') github.current.issue.body += '\nchanged';
    if (scenario === 'identity') delivered.sender.id = 99;
    if (scenario === 'expired') {
      delivered.comment.created_at = new Date(Date.now() - 3_700_000).toISOString();
      delivered.comment.updated_at = delivered.comment.created_at;
    }
    await assert.rejects(
      verifyActivation(liveConfig(), github, delivered),
      /activation|task/,
      scenario,
    );
  }
});
function transport(
  change: {
    installation?: object;
    app?: object;
    hook?: object;
    listed?: object;
    token?: object;
    revokeFails?: boolean;
  } = {},
) {
  const calls: {
    path: string;
    method: string;
    body: unknown;
    authorization: string | null;
  }[] = [];
  const request = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path,
      method: init.method ?? 'GET',
      body,
      authorization: new Headers(init.headers).get('authorization'),
    });
    if (path === '/app') return Response.json({ id: 8, slug: 'factory-fixture', ...change.app });
    if (path === '/app/installations/7')
      return Response.json({
        id: 7,
        app_id: 8,
        account: { login: 'example' },
        repository_selection: 'selected',
        suspended_at: null,
        permissions: INTAKE_PERMISSIONS,
        events: INTAKE_EVENTS,
        ...change.installation,
      });
    if (path === '/app/hook/config')
      return Response.json({
        url: 'https://factory.example.com/webhook',
        content_type: 'json',
        insecure_ssl: '0',
        ...change.hook,
      });
    if (path.endsWith('/access_tokens'))
      return Response.json({
        token: 'synthetic-token',
        permissions: body.permissions,
        repositories: [repository],
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        ...change.token,
      });
    if (path === '/installation/repositories')
      return Response.json({
        total_count: 1,
        repositories: [repository],
        ...change.listed,
      });
    if (path === '/installation/token')
      return new Response(null, { status: change.revokeFails ? 500 : 204 });
    return Response.json({ fixture: 'read' });
  }) as typeof fetch;
  return { request, calls };
}
test('installation preflight verifies App, selected single repository, read-only permissions, subscriptions and secure webhook settings', async () => {
  const { request, calls } = transport();
  const client = new InstallationClient(liveConfig(), new AbortController().signal, request);
  assert.equal((await client.check()).repository.id, 42);
  assert.deepEqual(calls.find((c) => c.path.endsWith('/access_tokens'))?.body, {
    permissions: { metadata: 'read' },
  });
  assert.equal(calls.at(-1)?.method, 'DELETE');
  await client.read('/repos/example/factory-demo/issues/1');
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/access_tokens')).at(-1)?.body, {
    permissions: INTAKE_PERMISSIONS,
    repository_ids: [42],
  });
});
test('preflight rejects all-repository installations, excess grants, missing events, wrong App/repo and insecure/mismatched endpoints', async () => {
  for (const change of [
    { installation: { repository_selection: 'all' } },
    {
      installation: {
        permissions: { ...INTAKE_PERMISSIONS, contents: 'write' },
      },
    },
    { installation: { events: [] } },
    { installation: { suspended_at: 'now' } },
    { app: { slug: 'another-app' } },
    { hook: { insecure_ssl: '1' } },
    { hook: { url: 'https://another.example/webhook' } },
    { listed: { total_count: 2 } },
    { listed: { repositories: [{ ...repository, id: 99 }] } },
  ]) {
    const { request } = transport(change);
    await assert.rejects(
      new InstallationClient(liveConfig(), new AbortController().signal, request).check(),
    );
  }
});
test('token grant expansion and revocation failure stop protected reads and foreign paths are rejected before networking', async () => {
  for (const change of [
    {
      token: { permissions: { ...INTAKE_PERMISSIONS, administration: 'read' } },
    },
    { revokeFails: true },
  ]) {
    const { request, calls } = transport(change);
    await assert.rejects(
      new InstallationClient(liveConfig(), new AbortController().signal, request).read(
        '/repos/example/factory-demo/issues/1',
      ),
    );
    assert.equal(calls.at(-1)?.method, 'DELETE');
  }
  const { request, calls } = transport();
  await assert.rejects(
    new InstallationClient(liveConfig(), new AbortController().signal, request).read(
      '/repos/example/other/issues/1',
    ),
  );
  assert.equal(calls.length, 0);
});

test('review App is restricted to issues write and administration read; contents/PR write grants are rejected', async () => {
  const config = { ...liveConfig(), mergePolicy: policy };
  const { request, calls } = transport({ installation: { permissions: REVIEW_PERMISSIONS } });
  const client = new InstallationClient(config, new AbortController().signal, request);
  await client.check();
  await client.read('/repos/example/factory-demo/branches/main/protection');
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/access_tokens')).at(-1)?.body, {
    repository_ids: [42],
    permissions: { ...REVIEW_PERMISSIONS, issues: 'read' },
  });
  for (const extra of [
    { contents: 'write' },
    { pull_requests: 'write' },
    { checks: 'write' },
    { administration: 'write' },
  ]) {
    const t = transport({ installation: { permissions: { ...REVIEW_PERMISSIONS, ...extra } } });
    await assert.rejects(
      new InstallationClient(config, new AbortController().signal, t.request).check(),
    );
  }
});
test('Task mutation validates target/status before any request and has no merge or deployment surface', async () => {
  const config = { ...liveConfig(), mergePolicy: policy };
  const { request, calls } = transport();
  const client = new InstallationClient(config, new AbortController().signal, request);
  for (const number of [0, -1, 1.5, Number.NaN])
    await assert.rejects(client.finishTask(number, [], async () => {}));
  await assert.rejects(client.finishTask(1, ['status:abandoned'], async () => {}));
  assert.equal(calls.length, 0);
  await assert.rejects(
    client.finishTask(1, [], async () => {
      throw new Error('changed');
    }),
    /changed/,
  );
  assert.deepEqual(calls[0]?.body, {
    repository_ids: [42],
    permissions: { issues: 'write', metadata: 'read' },
  });
  assert.equal(calls.at(-1)?.method, 'DELETE');
  assert.equal(calls.filter((c) => c.path.startsWith('/repos/')).length, 0);
});
