import { describe, expect, test } from 'vitest';
import {
  GithubSubstrateClient,
  InMemorySubstrateClient,
  extractPrRefFromBody,
} from '../src/substrateClient.js';

// Helper: builds a `fetch`-shaped stub that returns the given (status, body)
// pair for the first call, recording the URL + init. Subsequent calls are
// driven by `responses[i]` for i > 0.
interface StubResponse {
  status: number;
  json: unknown;
}
function makeFetchStub(responses: ReadonlyArray<StubResponse>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (r === undefined) {
      throw new Error('makeFetchStub: no responses configured');
    }
    return new Response(JSON.stringify(r.json), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('extractPrRefFromBody', () => {
  test('returns the value when `pr-ref:` line is present', () => {
    const body =
      'parent-goal: I_goal\ndesign-ref: I_design\npr-ref: PR_kwAOA_77\n\nImplement webhook endpoint';
    expect(extractPrRefFromBody(body)).toBe('PR_kwAOA_77');
  });

  test('returns undefined when the body has no `pr-ref:` line', () => {
    expect(extractPrRefFromBody('parent-goal: I_goal\n\nNo pr-ref field')).toBeUndefined();
  });

  test('returns undefined when `pr-ref:` is present but empty', () => {
    expect(extractPrRefFromBody('pr-ref:\n')).toBeUndefined();
  });
});

describe('InMemorySubstrateClient', () => {
  test('compareBranches: unseeded path returns current (behindBy=0)', async () => {
    const c = new InMemorySubstrateClient();
    const r = await c.compareBranches({ owner: 'o', repo: 'r', base: 'main', head: 'feat' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.behindBy).toBe(0);
      expect(r.aheadBy).toBe(0);
    }
  });

  test('compareBranches: seeded path returns the seeded result + records the call', async () => {
    const c = new InMemorySubstrateClient();
    c.seedCompare('main', 'feat', { ok: true, behindBy: 3, aheadBy: 1 });
    const r = await c.compareBranches({ owner: 'o', repo: 'r', base: 'main', head: 'feat' });
    if (r.ok) expect(r.behindBy).toBe(3);
    expect(c.compareCallHistory()).toHaveLength(1);
  });

  test('getTaskHeadBranch: unseeded returns typed failure', async () => {
    const c = new InMemorySubstrateClient();
    const r = await c.getTaskHeadBranch('I_t_missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('task_not_seeded:I_t_missing');
  });

  test('getTaskHeadBranch: seeded ok returns the view', async () => {
    const c = new InMemorySubstrateClient();
    c.seedTaskHeadBranch('I_t_42', {
      ok: true,
      value: { prRecordId: 'PR_42', headBranch: 'sf/T-42/01H/build@x', baseBranch: 'main' },
    });
    const r = await c.getTaskHeadBranch('I_t_42');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.prRecordId).toBe('PR_42');
      expect(r.value.headBranch).toBe('sf/T-42/01H/build@x');
    }
    expect(c.taskCallHistory()).toEqual(['I_t_42']);
  });
});

describe('GithubSubstrateClient — compareBranches', () => {
  test('200 with ahead_by/behind_by → ok:true', async () => {
    const stub = makeFetchStub([{ status: 200, json: { ahead_by: 5, behind_by: 2 } }]);
    const c = new GithubSubstrateClient({ getToken: () => 'tkn', fetch: stub.fetch });
    const r = await c.compareBranches({
      owner: 'o',
      repo: 'r',
      base: 'main',
      head: 'sf/x/build@y',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.behindBy).toBe(2);
      expect(r.aheadBy).toBe(5);
    }
    // URL-encoded segments + literal triple-dot separator.
    expect(stub.calls[0]?.url).toBe(
      'https://api.github.com/repos/o/r/compare/main...sf%2Fx%2Fbuild%40y',
    );
    expect((stub.calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer tkn',
    );
  });

  test('404 → ok:false with typed reason', async () => {
    const stub = makeFetchStub([{ status: 404, json: { message: 'Not Found' } }]);
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: stub.fetch });
    const r = await c.compareBranches({ owner: 'o', repo: 'r', base: 'main', head: 'h' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('compare_http_404');
  });

  test('422 → ok:false', async () => {
    const stub = makeFetchStub([{ status: 422, json: { message: 'Unprocessable' } }]);
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: stub.fetch });
    const r = await c.compareBranches({ owner: 'o', repo: 'r', base: 'main', head: 'h' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('compare_http_422');
  });

  test('200 with missing counts → ok:false', async () => {
    const stub = makeFetchStub([{ status: 200, json: { ahead_by: 1 } }]);
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: stub.fetch });
    const r = await c.compareBranches({ owner: 'o', repo: 'r', base: 'main', head: 'h' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('compare_body_missing_counts');
  });

  test('fetch throw → ok:false (typed transport failure)', async () => {
    const fetchImpl = (async () => {
      throw new Error('econnreset');
    }) as typeof fetch;
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: fetchImpl });
    const r = await c.compareBranches({ owner: 'o', repo: 'r', base: 'main', head: 'h' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('compare_fetch_failed:econnreset');
  });
});

describe('GithubSubstrateClient — getTaskHeadBranch (two-hop GraphQL)', () => {
  test('happy path: task body has pr-ref → resolves PR head/base ref names', async () => {
    const stub = makeFetchStub([
      { status: 200, json: { data: { node: { body: 'pr-ref: PR_kwA\n' } } } },
      {
        status: 200,
        json: {
          data: { node: { headRefName: 'sf/T-9/01H/build@x', baseRefName: 'main' } },
        },
      },
    ]);
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: stub.fetch });
    const r = await c.getTaskHeadBranch('I_t_9');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.prRecordId).toBe('PR_kwA');
      expect(r.value.headBranch).toBe('sf/T-9/01H/build@x');
      expect(r.value.baseBranch).toBe('main');
    }
    // Both calls were POSTs to /graphql.
    expect(stub.calls[0]?.url).toBe('https://api.github.com/graphql');
    expect(stub.calls[0]?.init?.method).toBe('POST');
    expect(stub.calls).toHaveLength(2);
  });

  test('task fetch 5xx → typed task_fetch_failed reason', async () => {
    const stub = makeFetchStub([{ status: 503, json: { message: 'Service Unavailable' } }]);
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: stub.fetch });
    const r = await c.getTaskHeadBranch('I_t_x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('task_fetch_failed:graphql_http_503');
  });

  test('task body without pr-ref → typed pr_ref_missing reason', async () => {
    const stub = makeFetchStub([
      { status: 200, json: { data: { node: { body: 'parent-goal: I_g\n' } } } },
    ]);
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: stub.fetch });
    const r = await c.getTaskHeadBranch('I_t_x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('pr_ref_missing:I_t_x');
  });

  test('PR fetch GraphQL errors → typed pr_fetch_failed reason', async () => {
    const stub = makeFetchStub([
      { status: 200, json: { data: { node: { body: 'pr-ref: PR_zz\n' } } } },
      { status: 200, json: { errors: [{ message: 'NOT_FOUND' }] } },
    ]);
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: stub.fetch });
    const r = await c.getTaskHeadBranch('I_t_z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('pr_fetch_failed:graphql_errors:NOT_FOUND');
  });

  test('PR missing headRefName → typed pr_head_ref_missing reason', async () => {
    const stub = makeFetchStub([
      { status: 200, json: { data: { node: { body: 'pr-ref: PR_yy\n' } } } },
      { status: 200, json: { data: { node: { baseRefName: 'main' } } } },
    ]);
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: stub.fetch });
    const r = await c.getTaskHeadBranch('I_t_y');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('pr_head_ref_missing:PR_yy');
  });

  test('task body missing → typed task_body_missing reason', async () => {
    const stub = makeFetchStub([{ status: 200, json: { data: { node: null } } }]);
    const c = new GithubSubstrateClient({ getToken: () => 't', fetch: stub.fetch });
    const r = await c.getTaskHeadBranch('I_t_q');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('task_body_missing:I_t_q');
  });
});

describe('extractPrRefFromBody — newest backlink wins (#180 rev9)', () => {
  test('two pr-ref lines → the LAST is returned (matches reviewAgent claim semantics)', () => {
    expect(extractPrRefFromBody('pr-ref: PR_stale\nsome text\npr-ref: PR_active')).toBe(
      'PR_active',
    );
  });
});
