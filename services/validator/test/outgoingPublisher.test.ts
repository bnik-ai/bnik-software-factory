import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_DISPATCH_QUEUE_NAME,
  InMemoryOutgoingPublisher,
  SERVICE_BUS_CONNECTION_STRING_ENV,
  SERVICE_BUS_DISPATCH_QUEUE_ENV,
  SERVICE_BUS_NAMESPACE_ENV,
  type SenderLike,
  ServiceBusOutgoingPublisher,
  resolveOutgoingPublisherBootConfig,
  serializePublishedMessage,
} from '../src/outgoingPublisher.js';
import type { ParsedTransitionMessage } from '../src/queueConsumer.js';
import type { Verdict } from '../src/types.js';

function makeMessage(overrides: Partial<ParsedTransitionMessage> = {}): ParsedTransitionMessage {
  return {
    lockToken: 'lt-1',
    deliveryId: 'd-1',
    eventType: 'webhook:issues.labeled',
    kind: 'goal',
    actor: 'human',
    recordType: 'Issue',
    recordKind: 'Goal',
    recordId: 'I_kwAOA',
    fromState: 'proposed',
    toState: 'accepted',
    payloadHash: createHash('sha256').update('payload').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

const ACCEPT: Verdict = { verdict: 'accept' };
const FLAG: Verdict = { verdict: 'flag', reason: 'parent_goal_missing' };
const REJECT: Verdict = { verdict: 'reject', reason: 'illegal_transition' };

describe('serializePublishedMessage — wire shape', () => {
  test('Buffer payloadHash → hex string; Date receivedAt → ISO; verdict mirrored', () => {
    const wire = serializePublishedMessage(makeMessage(), ACCEPT);
    expect(wire.message.payloadHash).toMatch(/^[0-9a-f]+$/);
    expect(wire.message.receivedAt).toBe('2026-05-30T18:00:00.000Z');
    expect(wire.message.verdict).toBe('accept');
    expect(wire.verdict).toEqual({ verdict: 'accept' });
  });

  test('flag verdict carries reason field through', () => {
    const wire = serializePublishedMessage(makeMessage(), FLAG);
    expect(wire.message.verdict).toBe('flag');
    expect(wire.verdict).toEqual({ verdict: 'flag', reason: 'parent_goal_missing' });
  });

  test('reject verdict carries reason field through', () => {
    const wire = serializePublishedMessage(makeMessage(), REJECT);
    expect(wire.verdict).toEqual({ verdict: 'reject', reason: 'illegal_transition' });
  });

  test('payloadHash hex is the canonical sha256 of the source buffer', () => {
    const buf = createHash('sha256').update('payload').digest();
    const wire = serializePublishedMessage(makeMessage({ payloadHash: buf }), ACCEPT);
    expect(wire.message.payloadHash).toBe(buf.toString('hex'));
    expect(wire.message.payloadHash.length).toBe(64); // sha256 = 32 bytes = 64 hex chars
  });

  test('headBranch + baseBranch carry onto the wire when set (ADR 0012 §"Activation status" gate (a))', () => {
    // Without these on the wire the orchestrator's pre-review branch-sync
    // gate stays inert — the field is the activation surface
    // between validator and orchestrator.
    const wire = serializePublishedMessage(
      makeMessage({
        kind: 'pr',
        recordType: 'PullRequest',
        recordKind: 'PullRequest',
        headBranch: 'sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
        baseBranch: 'main',
      }),
      ACCEPT,
    );
    expect(wire.message.headBranch).toBe('sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7');
    expect(wire.message.baseBranch).toBe('main');
  });

  test('headBranch + baseBranch omitted from wire when not set on the message (non-PR transitions stay unchanged)', () => {
    const wire = serializePublishedMessage(makeMessage(), ACCEPT);
    expect('headBranch' in wire.message).toBe(false);
    expect('baseBranch' in wire.message).toBe(false);
  });

  test('headBranch alone is emitted (one half set is still useful to the gate)', () => {
    const wire = serializePublishedMessage(makeMessage({ headBranch: 'feature/x' }), ACCEPT);
    expect(wire.message.headBranch).toBe('feature/x');
    expect('baseBranch' in wire.message).toBe(false);
  });

  test('repoFullName + installationId carry onto the wire when set', () => {
    const wire = serializePublishedMessage(
      makeMessage({ repoFullName: 'example-org/software-factory', installationId: 42 }),
      ACCEPT,
    );
    expect(wire.message.repoFullName).toBe('example-org/software-factory');
    expect(wire.message.installationId).toBe(42);
  });

  test('repoFullName + installationId omitted from wire when unset (shape unchanged)', () => {
    const wire = serializePublishedMessage(makeMessage(), ACCEPT);
    expect('repoFullName' in wire.message).toBe(false);
    expect('installationId' in wire.message).toBe(false);
  });
});

describe('InMemoryOutgoingPublisher', () => {
  test('publish records the serialized wire shape', async () => {
    const p = new InMemoryOutgoingPublisher();
    await p.publish(makeMessage(), ACCEPT);
    expect(p.publishCount()).toBe(1);
    const recorded = p.publishedMessages()[0];
    expect(recorded?.message.recordId).toBe('I_kwAOA');
    expect(recorded?.message.verdict).toBe('accept');
  });

  test('publish preserves insertion order across multiple messages', async () => {
    const p = new InMemoryOutgoingPublisher();
    await p.publish(makeMessage({ deliveryId: 'a' }), ACCEPT);
    await p.publish(makeMessage({ deliveryId: 'b' }), FLAG);
    await p.publish(makeMessage({ deliveryId: 'c' }), REJECT);
    expect(p.publishedMessages().map((m) => m.message.deliveryId)).toEqual(['a', 'b', 'c']);
    expect(p.publishedMessages().map((m) => m.verdict.verdict)).toEqual([
      'accept',
      'flag',
      'reject',
    ]);
  });
});

describe('ServiceBusOutgoingPublisher — via senderFactory test seam', () => {
  function makeSpySender(): {
    sender: SenderLike;
    calls: Array<{ body: unknown; sessionId?: string }>;
  } {
    const calls: Array<{ body: unknown; sessionId?: string }> = [];
    const sender: SenderLike = {
      sendMessages: async (args) => {
        calls.push(args);
      },
    };
    return { sender, calls };
  }

  test('publish sends the wire-format JSON body keyed by recordId session', async () => {
    const { sender, calls } = makeSpySender();
    const p = new ServiceBusOutgoingPublisher({ senderFactory: () => sender });
    await p.publish(makeMessage({ recordId: 'I_session_abc' }), ACCEPT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe('I_session_abc');
    const body = calls[0]?.body as { message: { verdict: string }; verdict: { verdict: string } };
    expect(body.message.verdict).toBe('accept');
    expect(body.verdict).toEqual({ verdict: 'accept' });
  });

  test('senderFactory is invoked lazily on first publish, then cached', async () => {
    let constructed = 0;
    const { sender } = makeSpySender();
    const factory = (): SenderLike => {
      constructed += 1;
      return sender;
    };
    const p = new ServiceBusOutgoingPublisher({ senderFactory: factory });
    expect(constructed).toBe(0); // no calls before publish
    await p.publish(makeMessage(), ACCEPT);
    await p.publish(makeMessage({ deliveryId: 'd-2' }), FLAG);
    expect(constructed).toBe(1); // factory called exactly once
  });

  test('constructor throws when neither senderFactory nor auth is supplied', () => {
    expect(() => new ServiceBusOutgoingPublisher({})).toThrow(/senderFactory or auth/);
  });

  // An unclosed publisher keeps its AMQP handles open after the
  // consumer loop returns — the event loop never drains and the Container
  // Apps Job execution is killed at the replica timeout ('Failed' despite
  // correct processing). close() must release the sender (and, in auth mode,
  // the ServiceBusClient behind it).
  test('close() closes the sender created by senderFactory (idle-exit leak)', async () => {
    let senderClosed = 0;
    const sender: SenderLike = {
      sendMessages: async () => undefined,
      close: async () => {
        senderClosed += 1;
      },
    };
    const p = new ServiceBusOutgoingPublisher({ senderFactory: () => sender });
    await p.publish(makeMessage(), ACCEPT);
    await p.close();
    expect(senderClosed).toBe(1);
  });

  test('close() is idempotent and safe before any publish (no sender created yet)', async () => {
    let senderClosed = 0;
    const sender: SenderLike = {
      sendMessages: async () => undefined,
      close: async () => {
        senderClosed += 1;
      },
    };
    const p = new ServiceBusOutgoingPublisher({ senderFactory: () => sender });
    await p.close(); // pre-publish: nothing to close, must not throw
    expect(senderClosed).toBe(0);
    await p.publish(makeMessage(), ACCEPT);
    await p.close();
    await p.close(); // second close is a no-op
    expect(senderClosed).toBe(1);
  });

  test('close() swallows sender close errors (a failed teardown must not fail a clean drain)', async () => {
    const sender: SenderLike = {
      sendMessages: async () => undefined,
      close: async () => {
        throw new Error('amqp teardown blip');
      },
    };
    const p = new ServiceBusOutgoingPublisher({ senderFactory: () => sender });
    await p.publish(makeMessage(), ACCEPT);
    await expect(p.close()).resolves.toBeUndefined();
  });
});

describe('resolveOutgoingPublisherBootConfig — env-driven', () => {
  function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const originals: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      originals[k] = process.env[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  }

  test('no env set → in-memory', () => {
    withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: undefined,
        [SERVICE_BUS_NAMESPACE_ENV]: undefined,
        [SERVICE_BUS_DISPATCH_QUEUE_ENV]: undefined,
      },
      () => {
        expect(resolveOutgoingPublisherBootConfig()).toEqual({ kind: 'in-memory' });
      },
    );
  });

  test('SERVICE_BUS_CONNECTION_STRING set → connection-string with default queue', () => {
    withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: 'Endpoint=sb://x.servicebus.windows.net/;...',
        [SERVICE_BUS_NAMESPACE_ENV]: undefined,
        [SERVICE_BUS_DISPATCH_QUEUE_ENV]: undefined,
      },
      () => {
        const r = resolveOutgoingPublisherBootConfig();
        expect(r.kind).toBe('connection-string');
        if (r.kind === 'connection-string') {
          expect(r.queueName).toBe(DEFAULT_DISPATCH_QUEUE_NAME);
        }
      },
    );
  });

  test('SERVICE_BUS_NAMESPACE set without connection string → managed-identity', () => {
    withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: undefined,
        [SERVICE_BUS_NAMESPACE_ENV]: 'sfac-dev-region-sb-main.servicebus.windows.net',
        [SERVICE_BUS_DISPATCH_QUEUE_ENV]: undefined,
      },
      () => {
        const r = resolveOutgoingPublisherBootConfig();
        expect(r.kind).toBe('managed-identity');
        if (r.kind === 'managed-identity') {
          expect(r.fullyQualifiedNamespace).toBe('sfac-dev-region-sb-main.servicebus.windows.net');
          expect(r.queueName).toBe(DEFAULT_DISPATCH_QUEUE_NAME);
        }
      },
    );
  });

  test('SERVICE_BUS_DISPATCH_QUEUE override respected', () => {
    withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: 'Endpoint=sb://x.servicebus.windows.net/;...',
        [SERVICE_BUS_DISPATCH_QUEUE_ENV]: 'custom-dispatch-queue',
      },
      () => {
        const r = resolveOutgoingPublisherBootConfig();
        if (r.kind === 'connection-string') {
          expect(r.queueName).toBe('custom-dispatch-queue');
        }
      },
    );
  });

  test('connection-string takes precedence over namespace when both set', () => {
    withEnv(
      {
        [SERVICE_BUS_CONNECTION_STRING_ENV]: 'Endpoint=sb://x.servicebus.windows.net/;...',
        [SERVICE_BUS_NAMESPACE_ENV]: 'should-be-ignored.servicebus.windows.net',
      },
      () => {
        expect(resolveOutgoingPublisherBootConfig().kind).toBe('connection-string');
      },
    );
  });
});
