import { describe, expect, test } from 'vitest';
import { GithubPullTool } from '../../src/tools/githubPullTool.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

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

const TOKEN = 'ghs_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const getToken = async () => TOKEN;

const prShape = {
  node_id: 'PR_node1',
  number: 11,
  state: 'open',
  draft: false,
  head: { ref: 'sf/T-1/01HV6/build@opus-4-8' },
  base: { ref: 'main' },
};

describe('GithubPullTool', () => {
  test('open POSTs head/base/title and maps the PR record', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 201, json: prShape }));
    const tool = new GithubPullTool({
      getToken,
      owner: 'example-org',
      repo: 'sample-app',
      fetchImpl,
    });
    const r = await tool.open({
      headBranch: 'sf/T-1/01HV6/build@opus-4-8',
      baseBranch: 'main',
      title: 'add: healthz',
      body: 'closes T-1',
      draft: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recordId).toBe('PR_node1');
      expect(r.value.number).toBe(11);
      expect(r.value.state).toBe('open');
    }
    expect(calls[0]?.url).toBe('https://api.github.com/repos/example-org/sample-app/pulls');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const sent = calls[0]?.body as { head: string; base: string; title: string };
    expect(sent.head).toBe('sf/T-1/01HV6/build@opus-4-8');
    expect(sent.base).toBe('main');
    expect(sent.title).toBe('add: healthz');
  });

  test('open maps draft and merged states', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 201,
      json: { ...prShape, draft: true },
    }));
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.open({
      headBranch: 'h',
      baseBranch: 'main',
      title: 't',
      body: 'b',
      draft: true,
    });
    if (r.ok) expect(r.value.state).toBe('draft');
  });

  test('submitReview resolves number then POSTs the mapped event', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return { json: { node_id: 'PRR_1', id: 555 } };
    });
    const tool = new GithubPullTool({
      getToken,
      owner: 'example-org',
      repo: 'sample-app',
      fetchImpl,
    });
    const r = await tool.submitReview({
      recordId: 'PR_node1',
      state: 'request-changes',
      body: 'missing tests',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.reviewId).toBe('PRR_1');
    expect(calls[1]?.url).toBe(
      'https://api.github.com/repos/example-org/sample-app/pulls/11/reviews',
    );
    expect((calls[1]?.body as { event: string }).event).toBe('REQUEST_CHANGES');
  });

  test('submitReview embeds ADR 0010 findings as a table in the review body', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return { json: { node_id: 'PRR_1' } };
    });
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.submitReview({
      recordId: 'PR_node1',
      state: 'request-changes',
      body: 'changes requested',
      findings: [
        {
          severity: 'P1',
          file: 'src/a.ts',
          line: 42,
          claim: 'null deref',
          suggestedFix: 'guard x',
          verdict: 'fix',
        },
      ],
    });
    expect(r.ok).toBe(true);
    const sentBody = (calls[1]?.body as { body: string }).body;
    expect(sentBody).toContain('changes requested');
    expect(sentBody).toContain('### Findings');
    expect(sentBody).toContain('| P1 | src/a.ts:42 | fix | null deref (fix: guard x) |');
  });

  test('submitReview leaves the body unchanged when findings is empty/absent', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return { json: { node_id: 'PRR_1' } };
    });
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    await tool.submitReview({ recordId: 'PR', state: 'approve', body: 'lgtm', findings: [] });
    expect((calls[1]?.body as { body: string }).body).toBe('lgtm');
  });

  test('submitReview maps approve and comment events', async () => {
    for (const [state, event] of [
      ['approve', 'APPROVE'],
      ['comment', 'COMMENT'],
    ] as const) {
      const { fetchImpl, calls } = makeFetch((call) => {
        if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 1 } } } };
        return { json: { node_id: 'PRR' } };
      });
      const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
      await tool.submitReview({ recordId: 'PR', state, body: 'b' });
      expect((calls[1]?.body as { event: string }).event).toBe(event);
    }
  });

  test('merge PUTs the method (default squash) and returns mergeSha', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return { json: { sha: 'mergesha123', merged: true } };
    });
    const tool = new GithubPullTool({
      getToken,
      owner: 'example-org',
      repo: 'sample-app',
      fetchImpl,
    });
    const r = await tool.merge({ recordId: 'PR_node1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mergeSha).toBe('mergesha123');
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.url).toBe(
      'https://api.github.com/repos/example-org/sample-app/pulls/11/merge',
    );
    expect((calls[1]?.body as { merge_method: string }).merge_method).toBe('squash');
  });

  test('merge surfaces a non-merged response', async () => {
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return { json: { sha: '', merged: false } };
    });
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.merge({ recordId: 'PR', method: 'rebase' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('merge_failed:not_merged');
  });

  test('close PATCHes state=closed', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return { json: { ...prShape, state: 'closed' } };
    });
    const tool = new GithubPullTool({
      getToken,
      owner: 'example-org',
      repo: 'sample-app',
      fetchImpl,
    });
    const r = await tool.close({ recordId: 'PR_node1', reason: 'superseded' });
    expect(r.ok).toBe(true);
    expect(calls[1]?.method).toBe('PATCH');
    expect((calls[1]?.body as { state: string }).state).toBe('closed');
  });

  test('getSyncStatus reads the PR then compares base...head, reporting behind', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      if (call.url.includes('/pulls/11') && !call.url.includes('compare')) {
        return { json: prShape };
      }
      return { json: { behind_by: 3 } };
    });
    const tool = new GithubPullTool({
      getToken,
      owner: 'example-org',
      repo: 'sample-app',
      fetchImpl,
    });
    const r = await tool.getSyncStatus('PR_node1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('behind');
      expect(r.value.behindBy).toBe(3);
    }
    const compareCall = calls.find((c) => c.url.includes('/compare/'));
    expect(compareCall?.url).toContain('main...sf%2FT-1%2F01HV6%2Fbuild%40opus-4-8');
  });

  test('getSyncStatus reports current when behind_by is 0', async () => {
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      if (call.url.includes('/pulls/11') && !call.url.includes('compare')) return { json: prShape };
      return { json: { behind_by: 0 } };
    });
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.getSyncStatus('PR_node1');
    if (r.ok) {
      expect(r.value.status).toBe('current');
      expect(r.value.behindBy).toBeUndefined();
    }
  });

  test('non-2xx open maps to typed failure and redacts the token', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 422,
      text: `validation failed; Bearer ${TOKEN}`,
    }));
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.open({ headBranch: 'h', baseBranch: 'main', title: 't', body: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith('open_failed:422:')).toBe(true);
      expect(r.reason).not.toContain(TOKEN);
    }
  });

  test('resolveNumber failure surfaces pr_record_not_found', async () => {
    const { fetchImpl } = makeFetch(() => ({ json: { data: { node: null } } }));
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.read('PR_missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('pr_record_not_found:PR_missing');
  });
});

describe('GithubPullTool.diff (review surface)', () => {
  test('GETs the PR with the diff media type and returns the text', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.url.includes('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return { text: 'diff --git a/x b/x\n+hello' };
    });
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.diff('PR_node1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.diff).toContain('+hello');
      expect(r.value.truncated).toBe(false);
    }
    const diffCall = calls.find((c) => c.url.endsWith('/repos/o/r/pulls/11'));
    expect(diffCall?.headers.Accept).toBe('application/vnd.github.diff');
  });

  test('oversized diff is truncated at the cap with truncated=true', async () => {
    const big = `diff --git a/x b/x\n${'+x\n'.repeat(60000)}`; // > 120k chars
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.includes('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return { text: big };
    });
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.diff('PR_node1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.truncated).toBe(true);
      expect(r.value.diff.length).toBe(120_000);
    }
  });

  test('non-2xx maps to a typed diff_failed', async () => {
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.includes('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return { status: 404, text: 'nope' };
    });
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.diff('PR_node1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^diff_failed:404/);
  });
});

describe('GithubPullTool.readBaseFile (base-tree read)', () => {
  // The PR read resolves the base ref; the contents call carries ?ref=<base>.
  function baseFetch(responder: (call: RecordedCall) => { status?: number; text?: string }) {
    return makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      if (call.url.includes('/pulls/11') && !call.url.includes('compare')) return { json: prShape };
      return responder(call);
    });
  }

  test('GETs contents at ?ref=<baseBranch> with the raw media type and returns the bytes', async () => {
    const { fetchImpl, calls } = baseFetch(() => ({ text: 'def auth(): return 1' }));
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.readBaseFile('PR_node1', 'tests/api/conftest.py');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.found).toBe(true);
      expect(r.value.content).toContain('def auth');
      expect(r.value.truncated).toBe(false);
    }
    const contentsCall = calls.find((c) => c.url.includes('/contents/'));
    expect(contentsCall?.url).toBe(
      'https://api.github.com/repos/o/r/contents/tests/api/conftest.py?ref=main',
    );
    expect(contentsCall?.headers.Accept).toBe('application/vnd.github.raw+json');
  });

  test('clean 404 → found:false (genuinely absent at base, NOT a transport failure)', async () => {
    const { fetchImpl } = baseFetch(() => ({ status: 404, text: 'Not Found' }));
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.readBaseFile('PR_node1', 'tests/api/missing.py');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.found).toBe(false);
      expect(r.value.content).toBeUndefined();
    }
  });

  test('non-404 error → typed base_file_read_failed (transport failure)', async () => {
    const { fetchImpl } = baseFetch(() => ({ status: 500, text: 'boom' }));
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.readBaseFile('PR_node1', 'a.py');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^base_file_read_failed:500/);
  });

  test('rejects traversal / absolute paths before any contents call', async () => {
    for (const bad of ['../issues', 'a/../../secrets', '/etc/passwd', 'a/./b', 'a\\b', '']) {
      const { fetchImpl, calls } = baseFetch(() => ({ text: 'should-not-be-served' }));
      const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
      const r = await tool.readBaseFile('PR_node1', bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/^invalid_base_path:/);
      // No contents request was ever issued for a rejected path.
      expect(calls.some((c) => c.url.includes('/contents/'))).toBe(false);
    }
  });

  test('oversized base file is truncated at the cap with truncated=true', async () => {
    const big = 'x'.repeat(70_000); // > 64k
    const { fetchImpl } = baseFetch(() => ({ text: big }));
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.readBaseFile('PR_node1', 'big.py');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.truncated).toBe(true);
      expect(r.value.content?.length).toBe(64_000);
    }
  });

  // read() must surface PR author + cross-repo so BuildAgent's
  // auto-revision ownership guard can assert App-author + same-repo.
  test('read maps a Bot App author (suffix-normalized) + same-repo isCrossRepository=false', async () => {
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return {
        json: {
          ...prShape,
          user: { login: 'example-factory[bot]', type: 'Bot' },
          head: { ref: 'sf/T-1/01HV6/build@opus-4-8', repo: { id: 100 } },
          base: { ref: 'main', repo: { id: 100 } },
        },
      };
    });
    const tool = new GithubPullTool({
      getToken,
      owner: 'example-org',
      repo: 'sample-app',
      fetchImpl,
    });
    const r = await tool.read('PR_node1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `[bot]` suffix dropped to match the GraphQL-form App slug.
    expect(r.value.author).toEqual({ login: 'example-factory', isBot: true });
    expect(r.value.isCrossRepository).toBe(false);
  });

  test('read maps a human User author + a fork (differing repo ids) → isCrossRepository=true', async () => {
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return {
        json: {
          ...prShape,
          user: { login: 'a-human', type: 'User' },
          head: { ref: 'sf/T-1/01HV6/build@opus-4-8', repo: { id: 200 } },
          base: { ref: 'main', repo: { id: 100 } },
        },
      };
    });
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.read('PR_node1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.author).toEqual({ login: 'a-human', isBot: false });
    expect(r.value.isCrossRepository).toBe(true);
  });

  test('read fails closed to isCrossRepository=true when the head repo id is absent (deleted fork)', async () => {
    const { fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith('/graphql')) return { json: { data: { node: { number: 11 } } } };
      return {
        json: {
          ...prShape,
          user: { login: 'example-factory[bot]', type: 'Bot' },
          head: { ref: 'sf/T-1/01HV6/build@opus-4-8', repo: null },
          base: { ref: 'main', repo: { id: 100 } },
        },
      };
    });
    const tool = new GithubPullTool({ getToken, owner: 'o', repo: 'r', fetchImpl });
    const r = await tool.read('PR_node1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.isCrossRepository).toBe(true);
  });
});
