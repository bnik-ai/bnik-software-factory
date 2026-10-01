// Spec: docs/decisions/0013-planner-agent.md §Decision item 4 + ADR 0009 §D.
// Coverage:
//   - listTasks builds the REST issue-search query (repo + kind + status
//     scope) and returns the items' node_ids.
//   - getTaskMetadata parses blocked-by body line + priority label +
//     createdAt + state.
//   - transitionTask applies status:<to>, removes status:<from>, posts the
//     sf:agent=PlannerAgent structural marker.
//   - The installation token never surfaces in a returned reason string.

import { describe, expect, test } from 'vitest';
import { GithubPlannerSubstrateClient } from '../../src/tools/plannerSubstrateClient.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

// A fake fetch that records every call and returns a canned response keyed
// by a matcher on the URL (so multi-call methods get the right body back).
function makeFetch(
  responder: (call: RecordedCall) => { status?: number; json?: unknown; text?: string },
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bodyRaw = init?.body;
    const body = typeof bodyRaw === 'string' ? JSON.parse(bodyRaw) : bodyRaw;
    const call: RecordedCall = { url: String(url), method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const r = responder(call);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const TOKEN = 'ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const getToken = async () => TOKEN;

function makeClient(fetchImpl: typeof fetch, runId = '01HZXYZ123456789ABCDEFGHJK') {
  return new GithubPlannerSubstrateClient({
    getToken,
    owner: 'example-org',
    repo: 'software-factory',
    runId,
    fetchImpl,
  });
}

describe('GithubPlannerSubstrateClient.listTasks', () => {
  test('proposed search matches kind:task minus later statuses (no status:proposed label exists)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      json: { items: [{ node_id: 'I_task_1' }, { node_id: 'I_task_2' }] },
    }));
    const client = makeClient(fetchImpl);
    const r = await client.listTasks('proposed');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(['I_task_1', 'I_task_2']);

    const call = calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url).toContain('/search/issues?q=');
    expect(call?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const decoded = decodeURIComponent(call?.url ?? '');
    expect(decoded).toContain('repo:example-org/software-factory');
    expect(decoded).toContain('is:issue');
    expect(decoded).toContain('is:open');
    expect(decoded).toContain('label:kind:task');
    // proposed is implicit: NOT label:status:proposed, but exclusions.
    expect(decoded).not.toContain('label:status:proposed');
    expect(decoded).toContain('-label:status:ready');
    expect(decoded).toContain('-label:status:in_progress');
    expect(decoded).toContain('-label:status:in_review');
    expect(decoded).toContain('-label:status:done');
    expect(decoded).toContain('-label:status:abandoned');
  });

  test('a labeled state (ready) matches the status carrier directly', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ json: { items: [] } }));
    await makeClient(fetchImpl).listTasks('ready');
    const decoded = decodeURIComponent(calls[0]?.url ?? '');
    expect(decoded).toContain('label:kind:task');
    expect(decoded).toContain('label:status:ready');
    expect(decoded).not.toContain('-label:status:');
  });

  test('empty items → empty list', async () => {
    const { fetchImpl } = makeFetch(() => ({ json: { items: [] } }));
    const r = await makeClient(fetchImpl).listTasks('proposed');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('non-2xx → typed list_tasks_failed', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 503, text: 'unavailable' }));
    const r = await makeClient(fetchImpl).listTasks('proposed');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^list_tasks_failed:503:/);
  });

  test('pages through ALL results when the first page is full', async () => {
    // Page 1 returns a full page (100) → the client must fetch page 2; page 2
    // returns 30 (partial) → stop. No Task beyond the first page is stranded.
    const page1 = Array.from({ length: 100 }, (_unused, i) => ({ node_id: `I_p1_${i}` }));
    const page2 = Array.from({ length: 30 }, (_unused, i) => ({ node_id: `I_p2_${i}` }));
    const { fetchImpl, calls } = makeFetch((call) => {
      const items = call.url.includes('page=2') ? page2 : page1;
      return { json: { items, total_count: 130 } };
    });
    const r = await makeClient(fetchImpl).listTasks('proposed');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(130);
      expect(r.value[0]).toBe('I_p1_0');
      expect(r.value[129]).toBe('I_p2_29');
    }
    // Exactly two pages fetched (page 2 was partial → stop).
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('page=1');
    expect(calls[1]?.url).toContain('page=2');
  });
});

describe('GithubPlannerSubstrateClient.getTaskMetadata', () => {
  test('parses blocked-by body line, priority label, createdAt, and state', async () => {
    const { fetchImpl } = makeFetch(() => ({
      json: {
        data: {
          node: {
            number: 12,
            body: 'parent-goal: x\nblocked-by: I_dep_a, I_dep_b\n\nScope: do the thing',
            state: 'OPEN',
            createdAt: '2026-05-30T18:00:00Z',
            labels: {
              nodes: [{ name: 'kind:task' }, { name: 'status:proposed' }, { name: 'priority:P1' }],
            },
          },
        },
      },
    }));
    const r = await makeClient(fetchImpl).getTaskMetadata('I_task_12');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.recordId).toBe('I_task_12');
    expect(r.value.state).toBe('proposed');
    expect(r.value.priority).toBe('P1');
    expect(r.value.blockedBy).toEqual(['I_dep_a', 'I_dep_b']);
    expect(r.value.createdAt).toBe('2026-05-30T18:00:00Z');
  });

  test('parses the GitHub issue-form `### blocked-by` heading format', async () => {
    // task.yml renders the blocked-by INPUT as a heading + value, not a line.
    const body = [
      '### parent-goal',
      '',
      'x',
      '',
      '### blocked-by',
      '',
      'I_dep_a, I_dep_b',
      '',
      '### Scope',
      '',
      'do it',
    ].join('\n');
    const { fetchImpl } = makeFetch(() => ({
      json: {
        data: {
          node: {
            number: 7,
            body,
            state: 'OPEN',
            createdAt: '2026-06-01T00:00:00Z',
            labels: { nodes: [{ name: 'kind:task' }] },
          },
        },
      },
    }));
    const r = await makeClient(fetchImpl).getTaskMetadata('I_form_task');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.blockedBy).toEqual(['I_dep_a', 'I_dep_b']);
  });

  test('treats `_No response_` under a blocked-by heading as no blockers', async () => {
    const body = ['### blocked-by', '', '_No response_', '', '### Scope', '', 'standalone'].join(
      '\n',
    );
    const { fetchImpl } = makeFetch(() => ({
      json: {
        data: {
          node: {
            number: 9,
            body,
            state: 'OPEN',
            createdAt: '2026-06-01T00:00:00Z',
            labels: { nodes: [{ name: 'kind:task' }] },
          },
        },
      },
    }));
    const r = await makeClient(fetchImpl).getTaskMetadata('I_noresp_task');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.blockedBy).toEqual([]);
  });

  test('no blocked-by line and no priority label → empty deps, undefined priority', async () => {
    const { fetchImpl } = makeFetch(() => ({
      json: {
        data: {
          node: {
            number: 5,
            body: 'Scope: standalone task',
            state: 'OPEN',
            createdAt: '2026-06-01T00:00:00Z',
            labels: { nodes: [{ name: 'kind:task' }, { name: 'status:proposed' }] },
          },
        },
      },
    }));
    const r = await makeClient(fetchImpl).getTaskMetadata('I_task_5');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.blockedBy).toEqual([]);
    expect(r.value.priority).toBeUndefined();
  });

  test('null node → record_not_found', async () => {
    const { fetchImpl } = makeFetch(() => ({ json: { data: { node: null } } }));
    const r = await makeClient(fetchImpl).getTaskMetadata('I_missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('record_not_found:I_missing');
  });

  test('resolves an owner/repo#number blocked-by ref via repository.issue', async () => {
    // The blocked-by form (task.yml + ADR 0003) is owner/repo#number, not a node
    // id — getTaskMetadata must query repository.issue so the blocker resolves.
    const { fetchImpl, calls } = makeFetch(() => ({
      json: {
        data: {
          repository: {
            issue: {
              number: 123,
              body: 'Scope: dep',
              state: 'CLOSED',
              createdAt: '2026-05-01T00:00:00Z',
              labels: { nodes: [{ name: 'kind:task' }, { name: 'status:done' }] },
            },
          },
        },
      },
    }));
    const r = await makeClient(fetchImpl).getTaskMetadata('example-org/software-factory#123');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recordId).toBe('example-org/software-factory#123');
      expect(r.value.state).toBe('done');
    }
    // Used the repository.issue query with the parsed owner/name/number.
    const sent = calls[0]?.body as { query: string; variables: Record<string, unknown> };
    expect(sent.query).toContain('repository(owner: $owner, name: $name)');
    expect(sent.variables).toEqual({ owner: 'example-org', name: 'software-factory', number: 123 });
  });

  test('non-Issue node (no Issue fields) → record_not_found, never throws', async () => {
    // A malformed blocked-by ref resolves to a non-Issue node: non-null, but the
    // `... on Issue` fragment yielded no `labels`/`createdAt`. Must surface the
    // typed not-found, not throw on node.labels.nodes.
    const { fetchImpl } = makeFetch(() => ({ json: { data: { node: {} } } }));
    const r = await makeClient(fetchImpl).getTaskMetadata('U_not_an_issue');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('record_not_found:U_not_an_issue');
  });

  test('no status label → proposed (the implicit initial state)', async () => {
    const { fetchImpl } = makeFetch(() => ({
      json: {
        data: {
          node: {
            number: 9,
            body: 'Scope: x',
            state: 'OPEN',
            createdAt: '2026-06-01T00:00:00Z',
            labels: { nodes: [{ name: 'kind:task' }] },
          },
        },
      },
    }));
    const r = await makeClient(fetchImpl).getTaskMetadata('I_task_9');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.state).toBe('proposed');
  });
});

describe('GithubPlannerSubstrateClient.transitionTask', () => {
  test('applies status:to, removes status:from, posts PlannerAgent marker', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) {
        const body = call.body as { query: string };
        if (body.query.includes('addComment')) {
          return { json: { data: { addComment: { commentEdge: { node: { id: 'C_1' } } } } } };
        }
        // resolveNumber
        return { json: { data: { node: { number: 42 } } } };
      }
      // REST label apply / remove
      return { json: {} };
    });
    const client = makeClient(fetchImpl, '01HZXYZ123456789ABCDEFGHJK');
    const r = await client.transitionTask({
      taskId: 'I_task_42',
      fromState: 'proposed',
      toState: 'ready',
      actor: 'PlannerAgent',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ taskId: 'I_task_42', toState: 'ready' });

    // POST labels with status:ready.
    const applyCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/42/labels'));
    expect(applyCall).toBeDefined();
    expect((applyCall?.body as { labels: string[] }).labels).toEqual(['status:ready']);

    // DELETE the prior status:proposed label.
    const removeCall = calls.find(
      (c) => c.method === 'DELETE' && c.url.includes('/issues/42/labels/'),
    );
    expect(removeCall).toBeDefined();
    expect(decodeURIComponent(removeCall?.url ?? '')).toContain('status:proposed');

    // addComment carries the sf:agent=PlannerAgent structural marker.
    const commentCall = calls.find(
      (c) =>
        c.url.endsWith('/graphql') && (c.body as { query: string }).query.includes('addComment'),
    );
    expect(commentCall).toBeDefined();
    const commentBody = (commentCall?.body as { variables: { body: string } }).variables.body;
    expect(commentBody).toContain(
      '<!-- sf:structural sf:agent=PlannerAgent run=01HZXYZ123456789ABCDEFGHJK -->',
    );
    expect(commentBody).toContain('proposed');
    expect(commentBody).toContain('ready');
  });

  test('removeLabel 404 (already absent) is idempotent success', async () => {
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) {
        const body = call.body as { query: string };
        if (body.query.includes('addComment')) {
          return { json: { data: { addComment: { commentEdge: { node: { id: 'C_1' } } } } } };
        }
        return { json: { data: { node: { number: 7 } } } };
      }
      if (call.method === 'DELETE') return { status: 404, text: 'not found' };
      return { json: {} };
    });
    const r = await makeClient(fetchImpl).transitionTask({
      taskId: 'I_task_7',
      fromState: 'proposed',
      toState: 'ready',
      actor: 'PlannerAgent',
    });
    expect(r.ok).toBe(true);
  });

  test('apply-label failure short-circuits before remove/comment', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 3 } } } };
      if (call.method === 'POST') return { status: 403, text: 'forbidden' };
      return { json: {} };
    });
    const r = await makeClient(fetchImpl).transitionTask({
      taskId: 'I_task_3',
      fromState: 'proposed',
      toState: 'ready',
      actor: 'PlannerAgent',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^apply_label_failed:403:/);
    // No DELETE / addComment after the apply failed.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('GithubPlannerSubstrateClient — token never logged', () => {
  test('an error reason containing the token is redacted', async () => {
    // The server echoes a Bearer token in the error body; safeText must redact.
    const { fetchImpl } = makeFetch(() => ({
      status: 500,
      text: `boom Bearer ${TOKEN} leaked`,
    }));
    const r = await makeClient(fetchImpl).listTasks('proposed');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain(TOKEN);
      expect(r.reason).toContain('***');
    }
  });
});

describe('GithubPlannerSubstrateClient.getTaskMetadata — dual-label precedence', () => {
  test('leftover status:ready BEFORE status:done derives done (terminal-first), unblocking dependents', async () => {
    const { fetchImpl } = makeFetch(() => ({
      json: {
        data: {
          node: {
            number: 13,
            body: '',
            state: 'OPEN',
            createdAt: '2026-06-12T00:00:00Z',
            labels: {
              // The failed-cleanup shape: prior label still present, done applied.
              nodes: [{ name: 'kind:task' }, { name: 'status:ready' }, { name: 'status:done' }],
            },
          },
        },
      },
    }));
    const r = await makeClient(fetchImpl).getTaskMetadata('I_task_13');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('done');
  });
});
