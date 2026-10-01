import { describe, expect, test } from 'vitest';
import {
  type GithubSubstrateClient,
  createGithubSubstrateClient,
} from '../src/githubSubstrateClient.js';

// A throwaway RSA key for signing the App JWT in tests (never used against a
// real GitHub endpoint — the fetch is faked). Generated for test fixtures.
import { generateKeyPairSync } from 'node:crypto';

const { privateKey: TEST_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ENV = { GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY: TEST_PEM };
const RECORD_ID = 'I_kwAOA_NodeId';
const TOKEN = 'ghs_secrettoken_should_never_leak';

// Builds a fake fetch that answers the token mint (POST /access_tokens, 201)
// and the GraphQL node query (POST /graphql) with the supplied node payload.
function makeFetch(opts: {
  node?: unknown;
  graphqlErrors?: ReadonlyArray<{ type?: string; message?: string }>;
  graphqlStatus?: number;
  mintStatus?: number;
  onGraphqlRequest?: (init: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === 'string' ? url : url.toString();
    if (href.endsWith('/access_tokens')) {
      const status = opts.mintStatus ?? 201;
      if (status !== 201) return new Response('{}', { status });
      return new Response(JSON.stringify({ token: TOKEN, expires_at: '2099-01-01T00:00:00Z' }), {
        status: 201,
      });
    }
    if (href.endsWith('/graphql')) {
      opts.onGraphqlRequest?.(init ?? {});
      if (opts.graphqlStatus !== undefined && opts.graphqlStatus !== 200) {
        return new Response('{}', { status: opts.graphqlStatus });
      }
      const payload: Record<string, unknown> = {};
      if (opts.graphqlErrors !== undefined) payload.errors = opts.graphqlErrors;
      else payload.data = { node: opts.node ?? null };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${href}`);
  }) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch): GithubSubstrateClient {
  return createGithubSubstrateClient({ env: ENV, installationId: 555, fetch: fetchImpl });
}

describe('GithubSubstrateClient — construction', () => {
  test('throws when App env is missing', () => {
    expect(() =>
      createGithubSubstrateClient({ env: {}, installationId: 1, fetch: makeFetch({}) }),
    ).toThrow(/GITHUB_APP_ID/);
  });
});

describe('GithubSubstrateClient — getIssue / getCurrentLabels mapping', () => {
  const node = {
    number: 42,
    title: 'A Goal',
    body: 'goal body text',
    state: 'OPEN',
    labels: { nodes: [{ name: 'kind:goal' }, { name: 'status:accepted' }] },
  };

  test('maps a GraphQL Issue node to IssueView', async () => {
    const issue = await client(makeFetch({ node })).getIssue(RECORD_ID);
    expect(issue).toEqual({
      body: 'goal body text',
      labels: ['kind:goal', 'status:accepted'],
    });
  });

  test('getCurrentLabels returns the label name array', async () => {
    const labels = await client(makeFetch({ node })).getCurrentLabels(RECORD_ID);
    expect(labels).toEqual(['kind:goal', 'status:accepted']);
  });

  test('null body maps to empty string', async () => {
    const issue = await client(makeFetch({ node: { ...node, body: null } })).getIssue(RECORD_ID);
    expect(issue?.body).toBe('');
  });

  test('skips malformed label entries (no name / null)', async () => {
    const issue = await client(
      makeFetch({ node: { labels: { nodes: [{ name: 'kind:task' }, null, {}] } } }),
    ).getIssue(RECORD_ID);
    expect(issue?.labels).toEqual(['kind:task']);
  });
});

describe('GithubSubstrateClient — missing node', () => {
  test('null node → getIssue undefined, getCurrentLabels []', async () => {
    const c = client(makeFetch({ node: null }));
    expect(await c.getIssue(RECORD_ID)).toBeUndefined();
    expect(await c.getCurrentLabels(RECORD_ID)).toEqual([]);
  });

  test('GraphQL NOT_FOUND error → treated as missing (undefined)', async () => {
    const c = client(
      makeFetch({ graphqlErrors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }),
    );
    expect(await c.getIssue(RECORD_ID)).toBeUndefined();
  });
});

describe('GithubSubstrateClient — auth + token never leaks', () => {
  test('sends Bearer <installation-token> on the GraphQL request', async () => {
    let seenAuth: string | undefined;
    const fetchImpl = makeFetch({
      node: { labels: { nodes: [] } },
      onGraphqlRequest: (init) => {
        const headers = init.headers as Record<string, string>;
        seenAuth = headers.authorization;
      },
    });
    await client(fetchImpl).getCurrentLabels(RECORD_ID);
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
  });

  test('a non-200 GraphQL response throws WITHOUT the token in the message', async () => {
    const c = client(makeFetch({ graphqlStatus: 500 }));
    await expect(c.getCurrentLabels(RECORD_ID)).rejects.toThrow(/graphql_http_500/);
    await c.getCurrentLabels(RECORD_ID).catch((err: Error) => {
      expect(err.message).not.toContain(TOKEN);
    });
  });

  test('a failed token mint throws WITHOUT the PEM/token in the message', async () => {
    const c = client(makeFetch({ mintStatus: 401 }));
    await c.getCurrentLabels(RECORD_ID).catch((err: Error) => {
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain(TEST_PEM);
      expect(err.message).toContain('token_mint_failed');
    });
  });
});

describe('GithubSubstrateClient — token caching', () => {
  test('mints the token once across multiple reads (cached within the client)', async () => {
    let mintCount = 0;
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === 'string' ? url : url.toString();
      if (href.endsWith('/access_tokens')) {
        mintCount += 1;
        return new Response(JSON.stringify({ token: TOKEN, expires_at: '2099-01-01T00:00:00Z' }), {
          status: 201,
        });
      }
      return new Response(JSON.stringify({ data: { node: { labels: { nodes: [] } } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const c = client(fetchImpl);
    await c.getCurrentLabels(RECORD_ID);
    await c.getCurrentLabels(RECORD_ID);
    await c.getIssue(RECORD_ID);
    expect(mintCount).toBe(1);
  });
});

describe('GithubSubstrateClient — getReviewsForPr', () => {
  test('maps a PullRequest reviews node to ReviewView[], dropping non-gating states', async () => {
    const node = {
      reviews: {
        nodes: [
          { id: 'PRR_1', state: 'CHANGES_REQUESTED', body: 'round 1 findings' },
          { id: 'PRR_comment', state: 'COMMENTED', body: 'fyi' },
          { id: 'PRR_dismissed', state: 'DISMISSED', body: 'superseded' },
          { id: 'PRR_pending', state: 'PENDING', body: 'draft' },
          {
            id: 'PRR_2',
            state: 'APPROVED',
            body: '<!-- sf:structural sf:agent=review@sonnet-4-6 run=01HZXYZ123456789ABCDEFGHJK -->\nApproved.',
          },
        ],
      },
    };
    const reviews = await client(makeFetch({ node })).getReviewsForPr('PR_node');
    expect(reviews).toEqual([
      { recordId: 'PRR_1', state: 'changes_requested', body: 'round 1 findings' },
      {
        recordId: 'PRR_2',
        state: 'approved',
        body: '<!-- sf:structural sf:agent=review@sonnet-4-6 run=01HZXYZ123456789ABCDEFGHJK -->\nApproved.',
      },
    ]);
  });

  test('null review body maps to empty string; entries lacking an id are dropped', async () => {
    const node = {
      reviews: {
        nodes: [
          { id: 'PRR_3', state: 'APPROVED', body: null },
          { state: 'APPROVED', body: 'no id' },
          null,
        ],
      },
    };
    const reviews = await client(makeFetch({ node })).getReviewsForPr('PR_node');
    expect(reviews).toEqual([{ recordId: 'PRR_3', state: 'approved', body: '' }]);
  });

  test('absent / non-PR node → empty list', async () => {
    expect(await client(makeFetch({ node: null })).getReviewsForPr('PR_node')).toEqual([]);
  });

  test('a non-200 GraphQL response throws (fail-closed input for the assertion)', async () => {
    const c = client(makeFetch({ graphqlStatus: 500 }));
    await expect(c.getReviewsForPr('PR_node')).rejects.toThrow(/graphql_http_500/);
  });
});

describe('GithubSubstrateClient — getPullRequest', () => {
  test('maps headRefName + head commit message to PrView', async () => {
    const node = {
      headRefName: 'sf/T-230/01HZXYZ123456789ABCDEFGHJK/build@deepseek-chat',
      commits: {
        nodes: [
          { commit: { message: 'add(provider): DeepSeek\n\nSF-Agent: build@deepseek-chat' } },
        ],
      },
    };
    const pr = await client(makeFetch({ node })).getPullRequest('PR_node');
    expect(pr).toEqual({
      headRef: 'sf/T-230/01HZXYZ123456789ABCDEFGHJK/build@deepseek-chat',
      headCommitMessage: 'add(provider): DeepSeek\n\nSF-Agent: build@deepseek-chat',
    });
  });

  test('omits each field independently when the head lacks it', async () => {
    const refOnly = await client(
      makeFetch({
        node: { headRefName: 'sf/T-1/01HZXYZ123456789ABCDEFGHJK/build@x', commits: { nodes: [] } },
      }),
    ).getPullRequest('PR_node');
    expect(refOnly).toEqual({ headRef: 'sf/T-1/01HZXYZ123456789ABCDEFGHJK/build@x' });

    const commitOnly = await client(
      makeFetch({ node: { commits: { nodes: [{ commit: { message: 'SF-Agent: build@x' } }] } } }),
    ).getPullRequest('PR_node');
    expect(commitOnly).toEqual({ headCommitMessage: 'SF-Agent: build@x' });
  });

  test('absent / non-PR node → undefined', async () => {
    expect(await client(makeFetch({ node: null })).getPullRequest('PR_node')).toBeUndefined();
  });

  test('a non-200 GraphQL response throws (tolerated → undefined by the assertion)', async () => {
    const c = client(makeFetch({ graphqlStatus: 500 }));
    await expect(c.getPullRequest('PR_node')).rejects.toThrow(/graphql_http_500/);
  });
});

describe('getStructuralMarkers — GraphQL Bot login normalization', () => {
  test('Bot author login gains the [bot] suffix; User authors stay as-is', async () => {
    const fetchImpl = makeFetch({
      node: {
        body: 'pr body',
        author: { login: 'someuser', __typename: 'User' },
        comments: {
          nodes: [
            {
              body: '<!-- sf:structural sf:agent=review@sonnet-4-6 run=01HZXYZ123456789ABCDEFGHJK -->\nClaimed.',
              author: { login: 'example-factory', __typename: 'Bot' },
            },
            { body: 'human chatter', author: { login: 'example-maintainer', __typename: 'User' } },
          ],
        },
      },
    });
    const surfaces = await client(fetchImpl).getStructuralMarkers('PR_node');
    expect(surfaces?.comments[0]?.authorLogin).toBe('example-factory[bot]');
    expect(surfaces?.comments[1]?.authorLogin).toBe('example-maintainer');
    expect(surfaces?.bodyAuthorLogin).toBe('someuser');
  });
});
