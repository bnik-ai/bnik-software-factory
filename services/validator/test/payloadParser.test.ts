import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { type RawWebhookDelivery, parsePayload } from '../src/payloadParser.js';

const RECEIVED_AT = new Date('2026-05-29T18:00:00Z');

function makeIssueBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    action: 'labeled',
    issue: {
      node_id: 'I_kwAOA-NodeId',
      number: 42,
      title: 'A Goal',
      state: 'open',
      labels: [{ name: 'kind:goal' }, { name: 'status:accepted' }],
    },
    label: { name: 'status:accepted' },
    sender: { login: 'example-owner', type: 'User' },
    ...overrides,
  };
}

function makePrBody(
  overrides: Partial<Record<string, unknown>> = {},
  prOverrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    action: 'opened',
    pull_request: {
      node_id: 'PR_kwAOA-NodeId',
      number: 7,
      title: 'feat: x',
      draft: false,
      merged: false,
      state: 'open',
      // GitHub `pull_request` webhook spec — head/base are full ref
      // objects with the branch name in .ref. ADR 0012 activation gate
      // (a) extracts these into envelope.headBranch / .baseBranch.
      head: { ref: 'sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7' },
      base: { ref: 'main' },
      ...prOverrides,
    },
    sender: { login: 'example-owner', type: 'User' },
    ...overrides,
  };
}

function makePrReviewBody(
  overrides: Partial<Record<string, unknown>> = {},
  reviewOverrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    action: 'submitted',
    review: {
      state: 'approved',
      body: 'looks good',
      ...reviewOverrides,
    },
    pull_request: {
      node_id: 'PR_kwAOA-NodeId',
      number: 7,
      // pull_request_review events carry the same head/base shape.
      head: { ref: 'sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7' },
      base: { ref: 'main' },
    },
    sender: { login: 'example-owner', type: 'User' },
    ...overrides,
  };
}

function makeDeploymentStatusBody(
  overrides: Partial<Record<string, unknown>> = {},
  deploymentStatusOverrides: Partial<Record<string, unknown>> = {},
  deploymentOverrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    action: 'created',
    deployment_status: {
      state: 'success',
      environment: 'stgx',
      ...deploymentStatusOverrides,
    },
    deployment: {
      node_id: 'DE_kwAOA-NodeId',
      environment: 'stgx',
      ...deploymentOverrides,
    },
    sender: { login: 'example-owner', type: 'User' },
    ...overrides,
  };
}

function makeRaw(body: Record<string, unknown>, eventType = 'issues'): RawWebhookDelivery {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    deliveryId: '7f3d0c4e-1234-1234-1234-abcdef012345',
    eventType,
    rawBody,
    parsedBody: body,
    receivedAt: RECEIVED_AT,
  };
}

describe('parsePayload — issues event happy path', () => {
  test('extracts kind from the kind:* label', () => {
    const result = parsePayload(makeRaw(makeIssueBody()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.kind).toBe('goal');
  });

  test('extracts recordId from issue.node_id', () => {
    const result = parsePayload(makeRaw(makeIssueBody()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.recordId).toBe('I_kwAOA-NodeId');
  });

  test('extracts statusLabel from body.label when prefixed with status:', () => {
    const result = parsePayload(makeRaw(makeIssueBody()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.statusLabel).toBe('status:accepted');
  });

  test('omits statusLabel when body.label is missing', () => {
    const body = makeIssueBody({ action: 'opened', label: undefined });
    body.label = undefined;
    const result = parsePayload(makeRaw(body));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.statusLabel).toBeUndefined();
  });

  test('omits statusLabel when body.label is NOT prefixed status:*', () => {
    const result = parsePayload(makeRaw(makeIssueBody({ label: { name: 'priority:high' } })));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.statusLabel).toBeUndefined();
  });

  test('omits statusLabel on issues.unlabeled even when body.label is status:* (envelope contract = just-applied, not just-removed)', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          action: 'unlabeled',
          // GitHub sends `label` on unlabeled events too — the just-REMOVED label.
          label: { name: 'status:accepted' },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.statusLabel).toBeUndefined();
  });

  test('payloadHash matches sha256 of the raw body bytes', () => {
    const body = makeIssueBody();
    const raw = makeRaw(body);
    const expected = createHash('sha256').update(raw.rawBody).digest();
    const result = parsePayload(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.payloadHash.equals(expected)).toBe(true);
  });

  test('passes through deliveryId, eventType, action, receivedAt', () => {
    const result = parsePayload(makeRaw(makeIssueBody()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.deliveryId).toBe('7f3d0c4e-1234-1234-1234-abcdef012345');
      expect(result.envelope.eventType).toBe('issues');
      expect(result.envelope.action).toBe('labeled');
      expect(result.envelope.receivedAt).toEqual(RECEIVED_AT);
    }
  });

  test('recordKind is the capitalized form of kind', () => {
    const result = parsePayload(makeRaw(makeIssueBody()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.recordType).toBe('Issue');
      expect(result.envelope.recordKind).toBe('Goal');
    }
  });
});

describe('parsePayload — sender → actor mapping', () => {
  test('User sender → human', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ sender: { login: 'example-owner', type: 'User' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.actor).toBe('human');
  });

  test('known Bot login → mapped Actor (spec-agent[bot] → SpecAgent)', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ sender: { login: 'spec-agent[bot]', type: 'Bot' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.actor).toBe('SpecAgent');
  });

  test('known Bot login → mapped Actor (build-agent[bot] → BuildAgent)', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ sender: { login: 'build-agent[bot]', type: 'Bot' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.actor).toBe('BuildAgent');
  });

  test('github-actions[bot] applying a status:* label (default labeled body) → untrusted_bot_event, VISIBLE: an untrusted substrate-state write is never silently settled — still NOT mapped to system (no privilege escalation)', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ sender: { login: 'github-actions[bot]', type: 'Bot' } })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('untrusted_bot_event');
      // VISIBLE: no observational flag → the consumer dead-letters it.
      expect(result.observational).toBeUndefined();
      expect(result.detail).toBe('github-actions[bot]');
    }
  });

  test('github-actions[bot] on a BENIGN inert event (issues.assigned) → third_party_bot_observational (only status:/kind: mutations stay visible)', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          action: 'assigned',
          sender: { login: 'github-actions[bot]', type: 'Bot' },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('third_party_bot_observational');
      expect(result.observational).toBe(true);
    }
  });

  test('a third-party bot (renovate[bot]) applying a status:* label → untrusted_bot_event, VISIBLE (ANY non-App bot state mutation, not just github-actions)', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ sender: { login: 'renovate[bot]', type: 'Bot' } })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('untrusted_bot_event');
      expect(result.observational).toBeUndefined();
      expect(result.detail).toBe('renovate[bot]');
    }
  });

  test('github-actions[bot] on deployment_status event → system (CI runner reports; the scoped trusted path)', () => {
    const result = parsePayload(
      makeRaw(
        makeDeploymentStatusBody({ sender: { login: 'github-actions[bot]', type: 'Bot' } }),
        'deployment_status',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.actor).toBe('system');
  });

  // ADR 0009 §1+§D: an App sender with NO body marker is no longer a parse
  // failure — the envelope carries appActorUnresolved=true (the placeholder
  // actor) so the transitionResolver finishes resolution from comments + the
  // single-agent FSM fallback. Covers all documented default slugs.
  for (const appLogin of ['softwarefactory[bot]', 'sf-platform[bot]', 'sf-example[bot]']) {
    test(`SF App login (${appLogin}) with no body marker → ok + appActorUnresolved (resolver finishes)`, () => {
      const result = parsePayload(
        makeRaw(makeIssueBody({ sender: { login: appLogin, type: 'Bot' } })),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.envelope.appActorUnresolved).toBe(true);
    });
  }

  test('SF App login + body structural marker → DEFERS (body=creator stamp, not this transition actor)', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          sender: { login: 'softwarefactory[bot]', type: 'Bot' },
          issue: {
            node_id: 'I_kwAOA-NodeId',
            number: 42,
            title: 'A Spec',
            state: 'open',
            labels: [{ name: 'kind:goal' }, { name: 'status:accepted' }],
            body: '<!-- sf:structural sf:agent=spec@opus-4-8 run=006F92T1MF2FBRG8T9Q321YMHJ -->\nbody',
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The body marker is the CREATOR's standing stamp; this transition's real
      // actor is resolved edge-aware (body+comments most-recent-wins + the
      // single-agent fallback) in transitionResolver — so the parser DEFERS.
      expect(result.envelope.appActorUnresolved).toBe(true);
    }
  });

  test('configurable App slug (GITHUB_APP_SLUG): example-factory[bot] recognized via options.appBotLogins → App path (appActorUnresolved), NOT a third-party observational settle', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ sender: { login: 'example-factory[bot]', type: 'Bot' } })),
      { appBotLogins: new Set(['example-factory[bot]']) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.appActorUnresolved).toBe(true);
  });

  test('example-factory[bot] is NOT a default slug → third_party_bot_observational, observational:true when no configured slug (still NOT the App path — no appActorUnresolved, no App actor)', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          action: 'assigned',
          sender: { login: 'example-factory[bot]', type: 'Bot' },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('third_party_bot_observational');
      expect(result.observational).toBe(true);
    }
  });

  test('dash-form software-factory[bot] (NOT a documented slug; an App look-alike) → third_party_bot_observational, observational:true — denied App treatment (no actor resolved), settles benignly', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          action: 'assigned',
          sender: { login: 'software-factory[bot]', type: 'Bot' },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('third_party_bot_observational');
      expect(result.observational).toBe(true);
    }
  });

  test('unknown third-party Bot login → third_party_bot_observational (NOT system — that would be privilege escalation), observational:true, detail carries the login', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({ action: 'assigned', sender: { login: 'renovate[bot]', type: 'Bot' } }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('third_party_bot_observational');
      expect(result.observational).toBe(true);
      expect(result.detail).toBe('renovate[bot]');
    }
  });

  test('external bots not in the allow-list get NO actor — system-only FSM transitions cannot be claimed by random strangers — and settle observationally (no dependabot[bot] DLQ noise)', () => {
    for (const stranger of ['dependabot[bot]', 'foreign-bot[bot]']) {
      const result = parsePayload(
        makeRaw(makeIssueBody({ action: 'assigned', sender: { login: stranger, type: 'Bot' } })),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('third_party_bot_observational');
        expect(result.observational).toBe(true);
      }
    }
  });

  // Forgery-guard invariant: the third-party observational
  // settle MUST NOT swallow an App-login sender. An App-login sender whose
  // agent actor is unresolvable takes the App path (appActorUnresolved=true,
  // ok:true) so the transitionResolver still fails closed
  // (actor_unresolved_app_sender) — it is NEVER observational.
  test('App-login sender (no marker) does NOT take the third-party observational path — stays App path (appActorUnresolved), forgery guard intact', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ sender: { login: 'softwarefactory[bot]', type: 'Bot' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.appActorUnresolved).toBe(true);
    }
    // Negative: it is not a third-party observational settle.
    if (!result.ok) {
      expect(result.reason).not.toBe('third_party_bot_observational');
    }
  });

  test('human (User) sender still resolves normally → actor human', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ sender: { login: 'a-human', type: 'User' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.actor).toBe('human');
      expect(result.envelope.appActorUnresolved).toBeUndefined();
    }
  });

  test('sender.type neither User nor Bot → unknown_actor_shape', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ sender: { login: 'x', type: 'Organization' } })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_actor_shape');
  });
});

describe('parsePayload — kind extraction', () => {
  test('issue with no kind:* label → unknown_kind', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          issue: {
            node_id: 'I_kwAOA',
            number: 1,
            labels: [{ name: 'priority:high' }],
            state: 'open',
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_kind');
  });

  test('issue with multiple kind:* labels → ambiguous_kind failure (ADR 0006: exactly one)', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          issue: {
            node_id: 'I_kwAOA',
            number: 1,
            labels: [{ name: 'kind:task' }, { name: 'kind:goal' }],
            state: 'open',
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous_kind');
      expect(result.detail).toContain('kind:task');
      expect(result.detail).toContain('kind:goal');
    }
  });

  test('issue with three+ kind:* labels also returns ambiguous_kind', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          issue: {
            node_id: 'I_kwAOA',
            number: 1,
            labels: [{ name: 'kind:goal' }, { name: 'kind:spec' }, { name: 'kind:task' }],
            state: 'open',
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ambiguous_kind');
  });

  test('exactly one kind:* label (alongside other label families) is accepted', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          issue: {
            node_id: 'I_kwAOA',
            number: 1,
            labels: [{ name: 'kind:goal' }, { name: 'priority:high' }, { name: 'status:proposed' }],
            state: 'open',
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.kind).toBe('goal');
  });

  test('one recognized + one UNRECOGNIZED kind:* → ambiguous_kind (the count is over the kind:* prefix, not the recognized subset)', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          issue: {
            node_id: 'I_kwAOA',
            number: 1,
            labels: [{ name: 'kind:goal' }, { name: 'kind:made-up' }],
            state: 'open',
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous_kind');
      expect(result.detail).toContain('kind:goal');
      expect(result.detail).toContain('kind:made-up');
    }
  });

  test('two UNRECOGNIZED kind:* labels → ambiguous_kind (still violates exactly-one)', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          issue: {
            node_id: 'I_kwAOA',
            number: 1,
            labels: [{ name: 'kind:made-up' }, { name: 'kind:also-made-up' }],
            state: 'open',
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ambiguous_kind');
  });

  test('issue with an unrecognized kind:* label → unknown_kind', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          issue: {
            node_id: 'I_kwAOA',
            number: 1,
            labels: [{ name: 'kind:made-up' }],
            state: 'open',
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_kind');
  });
});

describe('parsePayload — failure modes', () => {
  test('unknown event type → unknown_event_type (issues, pull_request, pull_request_review, and deployment_status are handled; e.g. push is not)', () => {
    const result = parsePayload(makeRaw(makeIssueBody(), 'push'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_event_type');
      expect(result.detail).toBe('push');
    }
  });

  test('parsedBody not an object → malformed_body', () => {
    const result = parsePayload({
      deliveryId: 'd',
      eventType: 'issues',
      rawBody: Buffer.from('"not an object"'),
      parsedBody: 'not an object',
      receivedAt: RECEIVED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed_body');
  });

  test('missing action → missing_field', () => {
    const body = makeIssueBody();
    body.action = undefined;
    const result = parsePayload(makeRaw(body));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('action');
    }
  });

  test('missing issue → missing_field', () => {
    const body = makeIssueBody();
    body.issue = undefined;
    const result = parsePayload(makeRaw(body));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('issue');
    }
  });

  test('missing issue.node_id → missing_field', () => {
    const result = parsePayload(
      makeRaw(makeIssueBody({ issue: { labels: [{ name: 'kind:goal' }] } })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('issue.node_id');
    }
  });

  test('missing sender → missing_field', () => {
    const body = makeIssueBody();
    body.sender = undefined;
    const result = parsePayload(makeRaw(body));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('sender');
    }
  });

  test('issue.labels not an array of objects → missing_field', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          issue: { node_id: 'I_kwAOA', labels: 'not an array' },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('issue.labels');
    }
  });
});

describe('parsePayload — pull_request event happy path', () => {
  test('opened (draft=false) → kind=pr, recordType=PullRequest, action=opened, draft=false', async () => {
    const result = parsePayload(makeRaw(makePrBody(), 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.kind).toBe('pr');
      expect(result.envelope.recordType).toBe('PullRequest');
      expect(result.envelope.recordKind).toBe('PullRequest');
      expect(result.envelope.action).toBe('opened');
      expect(result.envelope.draft).toBe(false);
      expect(result.envelope.recordId).toBe('PR_kwAOA-NodeId');
    }
  });

  test('opened (draft=true) → draft flag passes through', async () => {
    const result = parsePayload(makeRaw(makePrBody({}, { draft: true }), 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.draft).toBe(true);
  });

  test('closed (merged=true) → merged passthrough', async () => {
    const result = parsePayload(
      makeRaw(makePrBody({ action: 'closed' }, { merged: true }), 'pull_request'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.action).toBe('closed');
      expect(result.envelope.merged).toBe(true);
    }
  });

  test('closed (merged=false) → merged=false (PR closed without merge)', async () => {
    const result = parsePayload(
      makeRaw(makePrBody({ action: 'closed' }, { merged: false }), 'pull_request'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.merged).toBe(false);
  });

  test('ready_for_review action passes through verbatim', async () => {
    const result = parsePayload(
      makeRaw(makePrBody({ action: 'ready_for_review' }), 'pull_request'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.action).toBe('ready_for_review');
  });

  test('payloadHash is sha256 of the raw bytes', async () => {
    const body = makePrBody();
    const raw = makeRaw(body, 'pull_request');
    const expected = createHash('sha256').update(raw.rawBody).digest();
    const result = parsePayload(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.payloadHash).toEqual(expected);
  });
});

describe('parsePayload — pull_request labeled/unlabeled', () => {
  // A PR is an Issue in GitHub's API, so applying a status:* label to a PR
  // fires `pull_request` action='labeled' carrying body.label — NOT
  // issues.labeled. The parser surfaces statusLabel for the resolver's
  // PR labeled branch.
  test('labeled status:in_review → statusLabel populated', async () => {
    const result = parsePayload(
      makeRaw(
        makePrBody({ action: 'labeled', label: { name: 'status:in_review' } }),
        'pull_request',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.action).toBe('labeled');
      expect(result.envelope.statusLabel).toBe('status:in_review');
    }
  });

  test('labeled status:approved → statusLabel populated', async () => {
    const result = parsePayload(
      makeRaw(
        makePrBody({ action: 'labeled', label: { name: 'status:approved' } }),
        'pull_request',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.statusLabel).toBe('status:approved');
  });

  test('labeled non-status label (area:x) → statusLabel undefined (only status:* is surfaced)', async () => {
    const result = parsePayload(
      makeRaw(makePrBody({ action: 'labeled', label: { name: 'area:webhook' } }), 'pull_request'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.statusLabel).toBeUndefined();
  });

  test('unlabeled status:in_review → removedLabel populated, statusLabel undefined', async () => {
    const result = parsePayload(
      makeRaw(
        makePrBody({ action: 'unlabeled', label: { name: 'status:in_review' } }),
        'pull_request',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.removedLabel).toBe('status:in_review');
      expect(result.envelope.statusLabel).toBeUndefined();
    }
  });
});

describe('parsePayload — pull_request head/base branch population (ADR 0012 §"Activation status" gate (a))', () => {
  // Without these on the envelope, the orchestrator's pre-review
  // branch-sync gate skips for real traffic and the re-sync
  // protection ships inert. The orchestrator side accepts both
  // fields on the wire (sister serializer).

  test('opened → headBranch + baseBranch populated from pull_request.head.ref / .base.ref', async () => {
    const result = parsePayload(makeRaw(makePrBody(), 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.headBranch).toBe('sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7');
      expect(result.envelope.baseBranch).toBe('main');
    }
  });

  test('synchronize action (revision pushed) → fields still populated', async () => {
    const result = parsePayload(makeRaw(makePrBody({ action: 'synchronize' }), 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.headBranch).toBe('sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7');
      expect(result.envelope.baseBranch).toBe('main');
    }
  });

  test('ready_for_review action → fields still populated', async () => {
    const result = parsePayload(
      makeRaw(makePrBody({ action: 'ready_for_review' }), 'pull_request'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.headBranch).toBe('sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7');
      expect(result.envelope.baseBranch).toBe('main');
    }
  });

  test('non-main base (PR feeding stgx) → baseBranch is the actual base, not hardcoded main', async () => {
    const result = parsePayload(makeRaw(makePrBody({}, { base: { ref: 'stgx' } }), 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.baseBranch).toBe('stgx');
  });

  test('missing pull_request.head → headBranch undefined (lenient; gate skips when absent)', async () => {
    const result = parsePayload(makeRaw(makePrBody({}, { head: undefined }), 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.headBranch).toBeUndefined();
      expect(result.envelope.baseBranch).toBe('main');
    }
  });

  test('missing pull_request.base → baseBranch undefined', async () => {
    const result = parsePayload(makeRaw(makePrBody({}, { base: undefined }), 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.headBranch).toBe('sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7');
      expect(result.envelope.baseBranch).toBeUndefined();
    }
  });

  test('non-string head.ref → headBranch undefined (defensive against malformed payloads)', async () => {
    const result = parsePayload(makeRaw(makePrBody({}, { head: { ref: 12345 } }), 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.headBranch).toBeUndefined();
  });

  test('pull_request_review event → head/base populated from body.pull_request', async () => {
    const result = parsePayload(makeRaw(makePrReviewBody(), 'pull_request_review'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.headBranch).toBe('sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7');
      expect(result.envelope.baseBranch).toBe('main');
    }
  });

  test('issues event (Goal/Spec/Design/Task) → head/base remain undefined (no PR semantics)', () => {
    const result = parsePayload(makeRaw(makeIssueBody()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.headBranch).toBeUndefined();
      expect(result.envelope.baseBranch).toBeUndefined();
    }
  });

  test('deployment_status event → head/base remain undefined', () => {
    const result = parsePayload(makeRaw(makeDeploymentStatusBody(), 'deployment_status'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.headBranch).toBeUndefined();
      expect(result.envelope.baseBranch).toBeUndefined();
    }
  });
});

describe('parsePayload — pull_request sender resolution', () => {
  test('User sender → actor=human', async () => {
    const result = parsePayload(makeRaw(makePrBody(), 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.actor).toBe('human');
  });

  test('SF App login (no PR-body marker) → ok + appActorUnresolved (resolver finishes via fallback)', async () => {
    const result = parsePayload(
      makeRaw(
        makePrBody({ sender: { login: 'softwarefactory[bot]', type: 'Bot' } }),
        'pull_request',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.appActorUnresolved).toBe(true);
  });

  test('SF App login + PR body marker → DEFERS (body=creator stamp; resolver attributes the transition)', async () => {
    const result = parsePayload(
      makeRaw(
        makePrBody(
          { sender: { login: 'softwarefactory[bot]', type: 'Bot' } },
          {
            body: '<!-- sf:structural sf:agent=build@opus-4-8 run=006F92T1MF2FBRG8T9Q321YMHJ -->',
          },
        ),
        'pull_request',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.appActorUnresolved).toBe(true);
    }
  });

  test('third-party bot on an INERT PR event (synchronize) → third_party_bot_observational (dependabot PR-branch pushes settle cleanly, no DLQ noise)', async () => {
    const result = parsePayload(
      makeRaw(
        makePrBody({ action: 'synchronize', sender: { login: 'dependabot[bot]', type: 'Bot' } }),
        'pull_request',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('third_party_bot_observational');
      expect(result.observational).toBe(true);
    }
  });

  test('third-party bot on a TRANSITION-CAPABLE PR event (opened, no status label) → untrusted_bot_event, VISIBLE (non-label transition-capable actions are NOT silently settled)', async () => {
    const result = parsePayload(
      makeRaw(
        makePrBody({ action: 'opened', sender: { login: 'dependabot[bot]', type: 'Bot' } }),
        'pull_request',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('untrusted_bot_event');
      expect(result.observational).toBeUndefined();
      expect(result.detail).toBe('dependabot[bot]');
    }
  });

  test('third-party bot review_requested on an open PR → untrusted_bot_event, VISIBLE (maps to a real →in_review transition, not inert)', async () => {
    const result = parsePayload(
      makeRaw(
        makePrBody({
          action: 'review_requested',
          sender: { login: 'dependabot[bot]', type: 'Bot' },
        }),
        'pull_request',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('untrusted_bot_event');
      expect(result.observational).toBeUndefined();
    }
  });

  test('third-party bot applying a policy:* label → untrusted_bot_event, VISIBLE (policy:violation is the validator-only enforcement label)', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          label: { name: 'policy:violation' },
          sender: { login: 'dependabot[bot]', type: 'Bot' },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('untrusted_bot_event');
      expect(result.observational).toBeUndefined();
    }
  });

  test('third-party bot applying a COSMETIC label (dependencies) → third_party_bot_observational (non-state labels settle cleanly)', () => {
    const result = parsePayload(
      makeRaw(
        makeIssueBody({
          label: { name: 'dependencies' },
          sender: { login: 'dependabot[bot]', type: 'Bot' },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('third_party_bot_observational');
      expect(result.observational).toBe(true);
    }
  });
});

describe('parsePayload — pull_request failure modes', () => {
  test('missing pull_request object → missing_field', async () => {
    const body = makePrBody();
    body.pull_request = undefined;
    const result = parsePayload(makeRaw(body, 'pull_request'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('pull_request');
    }
  });

  test('missing pull_request.node_id → missing_field', async () => {
    const body = makePrBody({}, { node_id: undefined });
    const result = parsePayload(makeRaw(body, 'pull_request'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('pull_request.node_id');
    }
  });

  test('action=closed missing pull_request.merged → missing_field (merged is load-bearing for the FSM; silent downgrade to closed would bypass approved → merged audit)', async () => {
    const body = makePrBody({ action: 'closed' }, { merged: undefined });
    const result = parsePayload(makeRaw(body, 'pull_request'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('pull_request.merged');
    }
  });

  test('issues.unlabeled removing the only kind:* label → envelope.kind derived from REMOVED label (ADR-0006 violation path reaches resolver)', () => {
    const body = makeIssueBody({
      action: 'unlabeled',
      issue: {
        node_id: 'I_kwAOA-NodeId',
        number: 42,
        labels: [{ name: 'priority:p1' }], // post-removal: no kind:* present
      },
      label: { name: 'kind:goal' }, // the just-removed label
    });
    const result = parsePayload(makeRaw(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.kind).toBe('goal');
      expect(result.envelope.action).toBe('unlabeled');
      expect(result.envelope.removedLabel).toBe('kind:goal');
    }
  });

  test('issues.unlabeled removing a non-kind label with no kind:* in post-removal → still unknown_kind (no kind to derive)', () => {
    const body = makeIssueBody({
      action: 'unlabeled',
      issue: {
        node_id: 'I_kwAOA-NodeId',
        number: 42,
        labels: [{ name: 'priority:p1' }], // post-removal: no kind:*
      },
      label: { name: 'status:proposed' }, // removed label is not a kind:*
    });
    const result = parsePayload(makeRaw(body));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_kind');
  });

  test('action=opened with no pull_request.merged → ok (merged is informational for non-closed actions)', async () => {
    const body = makePrBody({ action: 'opened' }, { merged: undefined });
    const result = parsePayload(makeRaw(body, 'pull_request'));
    expect(result.ok).toBe(true);
  });

  test('missing pull_request.draft → missing_field (draft is required to disambiguate draft vs open initial state)', async () => {
    const body = makePrBody({}, { draft: undefined });
    const result = parsePayload(makeRaw(body, 'pull_request'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('pull_request.draft');
    }
  });

  test('missing action → missing_field', async () => {
    const body = makePrBody();
    body.action = undefined;
    const result = parsePayload(makeRaw(body, 'pull_request'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_field');
  });
});

describe('parsePayload — deployment_status event happy path', () => {
  test('action=created, state=success → kind=deployment, recordType=Deployment, deploymentState passthrough', async () => {
    const result = parsePayload(makeRaw(makeDeploymentStatusBody(), 'deployment_status'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.kind).toBe('deployment');
      expect(result.envelope.recordType).toBe('Deployment');
      expect(result.envelope.recordKind).toBe('Deployment');
      expect(result.envelope.action).toBe('created');
      expect(result.envelope.deploymentState).toBe('success');
      expect(result.envelope.recordId).toBe('DE_kwAOA-NodeId');
    }
  });

  test('state=failure passes through verbatim', async () => {
    const result = parsePayload(
      makeRaw(makeDeploymentStatusBody({}, { state: 'failure' }), 'deployment_status'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.deploymentState).toBe('failure');
  });

  test('state=in_progress passes through verbatim', async () => {
    const result = parsePayload(
      makeRaw(makeDeploymentStatusBody({}, { state: 'in_progress' }), 'deployment_status'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.deploymentState).toBe('in_progress');
  });

  test('payloadHash is sha256 of the raw bytes', async () => {
    const body = makeDeploymentStatusBody();
    const raw = makeRaw(body, 'deployment_status');
    const expected = createHash('sha256').update(raw.rawBody).digest();
    const result = parsePayload(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.payloadHash).toEqual(expected);
  });
});

describe('parsePayload — deployment_status failure modes', () => {
  test('missing deployment object → missing_field', async () => {
    const body = makeDeploymentStatusBody();
    body.deployment = undefined;
    const result = parsePayload(makeRaw(body, 'deployment_status'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('deployment');
    }
  });

  test('missing deployment.node_id → missing_field', async () => {
    const body = makeDeploymentStatusBody({}, {}, { node_id: undefined });
    const result = parsePayload(makeRaw(body, 'deployment_status'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('deployment.node_id');
    }
  });

  test('missing deployment_status object → missing_field', async () => {
    const body = makeDeploymentStatusBody();
    body.deployment_status = undefined;
    const result = parsePayload(makeRaw(body, 'deployment_status'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('deployment_status');
    }
  });

  test('missing deployment_status.state → missing_field', async () => {
    const body = makeDeploymentStatusBody({}, { state: undefined });
    const result = parsePayload(makeRaw(body, 'deployment_status'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('deployment_status.state');
    }
  });

  test('SF App sender (no body marker) → ok + appActorUnresolved (deployment edges resolve via single-agent fallback at the resolver)', async () => {
    const result = parsePayload(
      makeRaw(
        makeDeploymentStatusBody({ sender: { login: 'softwarefactory[bot]', type: 'Bot' } }),
        'deployment_status',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.appActorUnresolved).toBe(true);
  });
});

describe('parsePayload — pull_request_review event happy path', () => {
  test('submitted with state=approved → kind=pr, action=submitted, reviewState=approved', () => {
    const result = parsePayload(makeRaw(makePrReviewBody(), 'pull_request_review'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.kind).toBe('pr');
      expect(result.envelope.recordType).toBe('PullRequest');
      expect(result.envelope.action).toBe('submitted');
      expect(result.envelope.reviewState).toBe('approved');
      expect(result.envelope.recordId).toBe('PR_kwAOA-NodeId');
    }
  });

  test('submitted with state=changes_requested → reviewState passthrough', () => {
    const result = parsePayload(
      makeRaw(makePrReviewBody({}, { state: 'changes_requested' }), 'pull_request_review'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.reviewState).toBe('changes_requested');
  });

  test('submitted with state=commented → reviewState=commented (resolver will defer)', () => {
    const result = parsePayload(
      makeRaw(makePrReviewBody({}, { state: 'commented' }), 'pull_request_review'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.reviewState).toBe('commented');
  });
});

describe('parsePayload — pull_request_review failure modes', () => {
  test('missing review object → missing_field', () => {
    const body = makePrReviewBody();
    body.review = undefined;
    const result = parsePayload(makeRaw(body, 'pull_request_review'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('review');
    }
  });

  test('missing review.state → missing_field', () => {
    const body = makePrReviewBody({}, { state: undefined });
    const result = parsePayload(makeRaw(body, 'pull_request_review'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('review.state');
    }
  });

  test('missing pull_request.node_id → missing_field', () => {
    const body = makePrReviewBody();
    (body.pull_request as Record<string, unknown>).node_id = undefined;
    const result = parsePayload(makeRaw(body, 'pull_request_review'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_field');
      expect(result.detail).toBe('pull_request.node_id');
    }
  });
});

describe('parsePayload — repo + installation threading', () => {
  test('issues event with repository + installation → repoFullName + installationId populated', () => {
    const body = makeIssueBody({
      repository: { full_name: 'example-org/software-factory' },
      installation: { id: 12345678 },
    });
    const result = parsePayload(makeRaw(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.repoFullName).toBe('example-org/software-factory');
      expect(result.envelope.installationId).toBe(12345678);
    }
  });

  test('issues event WITHOUT repository/installation → both fields undefined', () => {
    const result = parsePayload(makeRaw(makeIssueBody()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.repoFullName).toBeUndefined();
      expect(result.envelope.installationId).toBeUndefined();
    }
  });

  test('pull_request event with repository + installation → fields populated', () => {
    const body = makePrBody({
      repository: { full_name: 'example-org/software-factory' },
      installation: { id: 99 },
    });
    const result = parsePayload(makeRaw(body, 'pull_request'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.repoFullName).toBe('example-org/software-factory');
      expect(result.envelope.installationId).toBe(99);
    }
  });

  test('non-integer installation.id is ignored (undefined)', () => {
    const body = makeIssueBody({
      repository: { full_name: 'o/r' },
      installation: { id: 'not-a-number' },
    });
    const result = parsePayload(makeRaw(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.repoFullName).toBe('o/r');
      expect(result.envelope.installationId).toBeUndefined();
    }
  });

  test('empty repository.full_name string is treated as absent', () => {
    const body = makeIssueBody({ repository: { full_name: '' }, installation: { id: 7 } });
    const result = parsePayload(makeRaw(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.repoFullName).toBeUndefined();
      expect(result.envelope.installationId).toBe(7);
    }
  });
});

describe('parsePayload — issue_comment is observational', () => {
  test('issue_comment event → observational_event_type, observational:true (settled cleanly, not DLQ)', () => {
    const result = parsePayload(makeRaw({ action: 'created' }, 'issue_comment'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('observational_event_type');
      expect(result.detail).toBe('issue_comment');
      expect(result.observational).toBe(true);
    }
  });

  test('truly unknown event type (push) still dead-letters → unknown_event_type, NOT observational', () => {
    const result = parsePayload(makeRaw({ ref: 'refs/heads/main' }, 'push'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_event_type');
      expect(result.observational).toBeUndefined();
    }
  });
});

describe('parsePayload — installation lifecycle events are observational', () => {
  test('installation_repositories (repo-scope change on the installation) → observational_event_type, observational:true (settled cleanly, not DLQ)', () => {
    const result = parsePayload(
      makeRaw({ action: 'added', installation: { id: 9001 } }, 'installation_repositories'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('observational_event_type');
      expect(result.detail).toBe('installation_repositories');
      expect(result.observational).toBe(true);
    }
  });

  test('installation (install/suspend/unsuspend lifecycle) → observational_event_type, observational:true', () => {
    const result = parsePayload(
      makeRaw({ action: 'unsuspend', installation: { id: 9001 } }, 'installation'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('observational_event_type');
      expect(result.detail).toBe('installation');
      expect(result.observational).toBe(true);
    }
  });
});

describe('parsePayload — issue_comment sender gating', () => {
  test('App-sent NON-structural comment → nonstructural_agent_comment violation, NOT observational', () => {
    const result = parsePayload(
      makeRaw(
        {
          action: 'created',
          sender: { login: 'softwarefactory[bot]', type: 'Bot' },
          comment: { body: 'free-form agent chatter without a marker' },
        },
        'issue_comment',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('nonstructural_agent_comment');
      expect(result.observational).toBeUndefined();
    }
  });

  test('App-sent STRUCTURAL marker comment → observational settle', () => {
    const result = parsePayload(
      makeRaw(
        {
          action: 'created',
          sender: { login: 'softwarefactory[bot]', type: 'Bot' },
          comment: {
            body: '<!-- sf:structural sf:agent=review@sonnet-4-6 run=01HZXYZ123456789ABCDEFGHJK -->\nFindings.',
          },
        },
        'issue_comment',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('observational_event_type');
      expect(result.observational).toBe(true);
    }
  });

  test('human comment → observational settle (humans may discuss freely)', () => {
    const result = parsePayload(
      makeRaw(
        {
          action: 'created',
          sender: { login: 'example-maintainer', type: 'User' },
          comment: { body: 'looks good, shipping' },
        },
        'issue_comment',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('observational_event_type');
      expect(result.observational).toBe(true);
    }
  });
});
