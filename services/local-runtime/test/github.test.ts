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
    graphql?: object;
    /** The issue a GET of `/issues/1` returns (Task pairing tests). */
    issue?: object;
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
    if (path === '/repos/example/factory-demo') return Response.json(repository);
    if (path === '/repos/example/factory-demo/issues/1' && (init.method ?? 'GET') === 'GET')
      return Response.json(change.issue ?? task());
    if (path === '/graphql') return Response.json(change.graphql ?? {});
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

test('review repository settings use scoped read-only GraphQL when REST omits them', async () => {
  const settings = {
    databaseId: 42,
    nameWithOwner: 'example/factory-demo',
    autoMergeAllowed: false,
    squashMergeAllowed: true,
    mergeCommitAllowed: false,
    rebaseMergeAllowed: false,
  };
  const config = { ...liveConfig(), mergePolicy: policy };
  const { request, calls } = transport({ graphql: { data: { repository: settings } } });
  const result = await new InstallationClient(config, new AbortController().signal, request).read(
    '/repos/example/factory-demo',
  );
  assert.deepEqual(result, {
    ...repository,
    allow_auto_merge: false,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
  });
  assert.deepEqual(calls[0]?.body, {
    repository_ids: [42],
    permissions: { ...REVIEW_PERMISSIONS, issues: 'read' },
  });
  assert.deepEqual(
    (calls.find((c) => c.path === '/graphql')?.body as { variables: unknown }).variables,
    { owner: 'example', name: 'factory-demo' },
  );
  assert.equal(calls.at(-1)?.method, 'DELETE');
  for (const graphql of [
    {},
    { errors: [{ message: 'permission denied' }], data: { repository: settings } },
    { data: { repository: null } },
    ...[
      { databaseId: 99 },
      { nameWithOwner: 'other/repository' },
      { autoMergeAllowed: null },
      { squashMergeAllowed: undefined },
      { mergeCommitAllowed: 'false' },
      { rebaseMergeAllowed: 0 },
    ].map((change) => ({ data: { repository: { ...settings, ...change } } })),
  ]) {
    const t = transport({ graphql });
    await assert.rejects(
      new InstallationClient(config, new AbortController().signal, t.request).read(
        '/repos/example/factory-demo',
      ),
      /repository_merge_settings_unreadable/,
    );
    assert.equal(t.calls.at(-1)?.method, 'DELETE');
  }
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
test('the Task reader accepts only the statuses it is given: proposed for activation, paired ones for the autonomy controller', () => {
  const config = liveConfig();
  const issue = task();
  const paired = { ...issue, labels: [{ name: 'kind:task' }, { name: 'status:in_review' }] };
  assert.throws(() => taskSnapshot(config, paired, commit), /task_labels_invalid/);
  assert.equal(
    taskSnapshot(config, paired, commit, ['status:proposed', 'status:in_review']).issue.id,
    issue.id,
  );
  assert.throws(
    () =>
      taskSnapshot(
        config,
        { ...issue, labels: [...paired.labels, { name: 'status:proposed' }] },
        commit,
        ['status:proposed', 'status:in_review'],
      ),
    /task_labels_invalid/,
  );
  assert.throws(
    () => taskSnapshot(config, paired, commit, ['status:proposed', 'status:ready']),
    /task_labels_invalid/,
  );
});
test('publication pairs the Task: backlink and status:in_review through issues write only, idempotent, never onto another pull request', async () => {
  const config = { ...liveConfig(), mergePolicy: policy };
  const proposed = transport();
  const client = new InstallationClient(config, new AbortController().signal, proposed.request);
  await assert.rejects(client.pairTask(0, 'PR_X'), /task_write_not_scoped/);
  await assert.rejects(client.pairTask(1, 'not valid!'), /task_write_not_scoped/);
  assert.equal(proposed.calls.length, 0);
  await client.pairTask(1, 'PR_X');
  const writes = proposed.calls.filter((c) => c.path.startsWith('/repos/'));
  assert.deepEqual(
    writes.map((c) => [c.method, c.path.replace('/repos/example/factory-demo', '')]),
    [
      ['GET', '/issues/1'],
      ['PATCH', '/issues/1'],
      ['POST', '/issues/1/labels'],
      ['DELETE', '/issues/1/labels/status%3Aproposed'],
    ],
  );
  assert.match(String((writes[1]?.body as { body: string }).body), /\n\npr-ref: PR_X\n$/);
  assert.deepEqual(writes[2]?.body, { labels: ['status:in_review'] });
  assert.deepEqual(proposed.calls[0]?.body, {
    repository_ids: [42],
    permissions: { issues: 'write', metadata: 'read' },
  });
  assert.equal(proposed.calls.at(-1)?.method, 'DELETE');
  assert.equal(proposed.calls.at(-1)?.path, '/installation/token');
  // Already paired: nothing is written again.
  const already = transport({
    issue: {
      ...task(),
      body: `${task().body}\n\npr-ref: PR_X\n`,
      labels: [{ name: 'kind:task' }, { name: 'status:in_review' }],
    },
  });
  await new InstallationClient(config, new AbortController().signal, already.request).pairTask(
    1,
    'PR_X',
  );
  assert.deepEqual(
    already.calls.filter((c) => c.path.startsWith('/repos/')).map((c) => c.method),
    ['GET'],
  );
  // Paired with another pull request, or in a status pairing does not own: refused before any write.
  for (const [issue, reason] of [
    [{ ...task(), body: `${task().body}\npr-ref: PR_OTHER\n` }, /task_paired_elsewhere/],
    [
      { ...task(), labels: [{ name: 'kind:task' }, { name: 'status:ready' }] },
      /task_status_not_pairable/,
    ],
    [{ ...task(), state: 'closed' }, /task_not_pairable/],
  ] as const) {
    const t = transport({ issue });
    await assert.rejects(
      new InstallationClient(config, new AbortController().signal, t.request).pairTask(1, 'PR_X'),
      reason,
    );
    assert.deepEqual(
      t.calls.filter((c) => c.path.startsWith('/repos/')).map((c) => c.method),
      ['GET'],
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
