import { createHash } from 'node:crypto';
import type { ServiceBusMessage, ServiceBusSender } from '@azure/service-bus';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_QUEUE_NAMES,
  InMemoryServiceBusAgentDispatcher,
  ServiceBusAgentDispatcher,
  resolveQueueNameOverrides,
  resolveServiceBusAgentDispatcherBootConfig,
} from '../src/serviceBusAgentDispatcher.js';
import type { AgentRole, ParsedTransitionMessage } from '../src/types.js';

const TEST_CONNECTION_STRING =
  'Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=v';

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
    payloadHash: createHash('sha256').update('p').digest(),
    receivedAt: new Date('2026-05-30T18:00:00Z'),
    ...overrides,
  };
}

interface FakeSenderCall {
  queueName: string;
  message: ServiceBusMessage;
}

function makeFakeSenderFactory(
  calls: FakeSenderCall[],
  options: { throwOnSend?: Error; throwOnCreate?: Error } = {},
): (queueName: string) => ServiceBusSender {
  return (queueName: string) => {
    if (options.throwOnCreate) throw options.throwOnCreate;
    const sender = {
      sendMessages: async (message: ServiceBusMessage | ServiceBusMessage[]) => {
        if (options.throwOnSend) throw options.throwOnSend;
        const msg = Array.isArray(message) ? message[0] : message;
        if (msg !== undefined) calls.push({ queueName, message: msg });
      },
    } as unknown as ServiceBusSender;
    return sender;
  };
}

describe('ServiceBusAgentDispatcher.dispatch — happy path', () => {
  test('enqueues per-role message + returns ok with messageId as dispatchId', async () => {
    const calls: FakeSenderCall[] = [];
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory(calls),
    });
    const result = await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent).toBe('SpecAgent');
    expect(result.dispatchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    expect(calls).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const call = calls[0]!;
    expect(call.queueName).toBe('agent-runs-spec');
    expect(call.message.messageId).toBe(result.dispatchId);
    expect(call.message.contentType).toBe('application/json');

    const body = call.message.body as {
      agent: string;
      transition_key: string;
      message: { kind: string; payloadHash: string; receivedAt: string };
    };
    expect(body.agent).toBe('SpecAgent');
    expect(body.transition_key).toBe('goal:proposed→accepted');
    expect(body.message.kind).toBe('goal');
  });

  test('reuses one sender per role across multiple dispatches', async () => {
    let factoryCalls = 0;
    const calls: FakeSenderCall[] = [];
    const innerFactory = makeFakeSenderFactory(calls);
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: (queueName) => {
        factoryCalls += 1;
        return innerFactory(queueName);
      },
    });
    await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage({ lockToken: 'lt-2' }),
      transitionKey: 'goal:proposed→accepted',
    });
    await dispatcher.dispatch({
      agent: 'ReviewAgent',
      message: makeMessage(),
      transitionKey: 'spec:drafting→ready_for_review',
    });
    // One sender for SpecAgent, one for ReviewAgent.
    expect(factoryCalls).toBe(2);
    expect(calls).toHaveLength(3);
  });
});

describe('ServiceBusAgentDispatcher — per-role queue mapping', () => {
  test('default queue names match agent-runs-<role> for every AgentRole', () => {
    const expected: Record<AgentRole, string> = {
      SpecAgent: 'agent-runs-spec',
      DesignAgent: 'agent-runs-design',
      PlannerAgent: 'agent-runs-planner',
      BuildAgent: 'agent-runs-build',
      ReviewAgent: 'agent-runs-review',
      OpsAgent: 'agent-runs-ops',
      SREAgent: 'agent-runs-sre',
    };
    expect(DEFAULT_QUEUE_NAMES).toEqual(expected);
  });

  test('each role enqueues to its own queue', async () => {
    const calls: FakeSenderCall[] = [];
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory(calls),
    });
    const roles: AgentRole[] = [
      'SpecAgent',
      'DesignAgent',
      'PlannerAgent',
      'BuildAgent',
      'ReviewAgent',
      'OpsAgent',
      'SREAgent',
    ];
    for (const agent of roles) {
      await dispatcher.dispatch({
        agent,
        message: makeMessage(),
        transitionKey: 't',
      });
    }
    expect(calls.map((c) => c.queueName)).toEqual([
      'agent-runs-spec',
      'agent-runs-design',
      'agent-runs-planner',
      'agent-runs-build',
      'agent-runs-review',
      'agent-runs-ops',
      'agent-runs-sre',
    ]);
  });

  test('queueNames overrides take precedence over defaults', async () => {
    const calls: FakeSenderCall[] = [];
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      queueNames: { SpecAgent: 'custom-spec-queue' },
      senderFactory: makeFakeSenderFactory(calls),
    });
    await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    expect(dispatcher.queueNameFor('SpecAgent')).toBe('custom-spec-queue');
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    expect(calls[0]!.queueName).toBe('custom-spec-queue');
    expect(dispatcher.queueNameFor('DesignAgent')).toBe('agent-runs-design');
  });
});

describe('ServiceBusAgentDispatcher — wire format', () => {
  test('payloadHash is hex; receivedAt is ISO 8601', async () => {
    const calls: FakeSenderCall[] = [];
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory(calls),
    });
    const message = makeMessage();
    await dispatcher.dispatch({
      agent: 'SpecAgent',
      message,
      transitionKey: 'goal:proposed→accepted',
    });
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const body = calls[0]!.message.body as {
      message: { payloadHash: string; receivedAt: string };
    };
    expect(body.message.payloadHash).toBe(message.payloadHash.toString('hex'));
    expect(body.message.payloadHash).toMatch(/^[0-9a-f]+$/);
    expect(body.message.receivedAt).toBe('2026-05-30T18:00:00.000Z');
  });

  test('all ParsedTransitionMessage fields are present in the serialized message', async () => {
    const calls: FakeSenderCall[] = [];
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory(calls),
    });
    await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage({ verdict: 'accept' }),
      transitionKey: 'goal:proposed→accepted',
    });
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const body = calls[0]!.message.body as { message: Record<string, unknown> };
    expect(Object.keys(body.message).sort()).toEqual(
      [
        'actor',
        'deliveryId',
        'eventType',
        'fromState',
        'kind',
        'lockToken',
        'payloadHash',
        'receivedAt',
        'recordId',
        'recordKind',
        'recordType',
        'toState',
        'verdict',
      ].sort(),
    );
    expect(body.message.verdict).toBe('accept');
  });

  test('headBranch + baseBranch are serialized when present', async () => {
    // ADR 0010 / 0012: the branch-sync gate populates headBranch +
    // baseBranch on the synthetic BuildAgent rebase-intent dispatch.
    // If these are dropped on the wire BuildAgent.runRebaseForReview
    // deadletters with build_agent_rebase_missing_head_branch.
    const calls: FakeSenderCall[] = [];
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory(calls),
    });
    await dispatcher.dispatch({
      agent: 'BuildAgent',
      message: makeMessage({
        headBranch: 'sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7',
        baseBranch: 'main',
      }),
      transitionKey: 'pr:open→needs_sync_for_review',
    });
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const body = calls[0]!.message.body as {
      message: Record<string, unknown>;
    };
    expect(body.message.headBranch).toBe('sf/T-42/01HZXYZ123456789ABCDEFGHJK/build@opus-4-7');
    expect(body.message.baseBranch).toBe('main');
  });

  test('headBranch + baseBranch are omitted when undefined (wire shape unchanged for non-PR transitions)', async () => {
    const calls: FakeSenderCall[] = [];
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory(calls),
    });
    await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const body = calls[0]!.message.body as { message: Record<string, unknown> };
    expect('headBranch' in body.message).toBe(false);
    expect('baseBranch' in body.message).toBe(false);
  });

  test('repoFullName + installationId are serialized when present', async () => {
    const calls: FakeSenderCall[] = [];
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory(calls),
    });
    await dispatcher.dispatch({
      agent: 'BuildAgent',
      message: makeMessage({
        repoFullName: 'example-org/software-factory',
        installationId: 42,
      }),
      transitionKey: 'task:proposed→ready',
    });
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const body = calls[0]!.message.body as { message: Record<string, unknown> };
    expect(body.message.repoFullName).toBe('example-org/software-factory');
    expect(body.message.installationId).toBe(42);
  });

  test('repoFullName + installationId are omitted when undefined (wire shape unchanged)', async () => {
    const calls: FakeSenderCall[] = [];
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory(calls),
    });
    await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const body = calls[0]!.message.body as { message: Record<string, unknown> };
    expect('repoFullName' in body.message).toBe(false);
    expect('installationId' in body.message).toBe(false);
  });
});

describe('ServiceBusAgentDispatcher — failure modes', () => {
  test('sender.sendMessages throws → typed enqueue_failed reason', async () => {
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory([], { throwOnSend: new Error('Broker unreachable') }),
    });
    const result = await dispatcher.dispatch({
      agent: 'BuildAgent',
      message: makeMessage(),
      transitionKey: 'task:proposed→ready',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.agent).toBe('BuildAgent');
    expect(result.reason).toBe('enqueue_failed:agent-runs-build:Broker unreachable');
  });

  test('sender construction throws → typed enqueue_failed:sender_create reason', async () => {
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory([], {
        throwOnCreate: new Error('namespace unauthorized'),
      }),
    });
    const result = await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('enqueue_failed:sender_create:namespace unauthorized');
  });
});

describe('ServiceBusAgentDispatcher — transient/deterministic classification', () => {
  function makeServiceBusError(code: string, message = 'simulated SB error'): Error {
    const err = new Error(message);
    (err as Error & { code: string }).code = code;
    return err;
  }

  test.each([
    'ServiceBusy',
    'ServerBusy',
    'ServiceTimeout',
    'OperationCanceled',
    'ServiceCommunicationProblem',
  ])('SB error code %s → transient=true', async (code) => {
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory([], { throwOnSend: makeServiceBusError(code) }),
    });
    const result = await dispatcher.dispatch({
      agent: 'BuildAgent',
      message: makeMessage(),
      transitionKey: 'task:proposed→ready',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.transient).toBe(true);
  });

  test.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'])(
    'socket error code %s → transient=true',
    async (code) => {
      const dispatcher = new ServiceBusAgentDispatcher({
        auth: { connectionString: TEST_CONNECTION_STRING },
        senderFactory: makeFakeSenderFactory([], { throwOnSend: makeServiceBusError(code) }),
      });
      const result = await dispatcher.dispatch({
        agent: 'BuildAgent',
        message: makeMessage(),
        transitionKey: 'task:proposed→ready',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.transient).toBe(true);
    },
  );

  test('err.retryable=true → transient=true (alternative carrier)', async () => {
    const err = new Error('some retryable failure');
    (err as Error & { retryable: boolean }).retryable = true;
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory([], { throwOnSend: err }),
    });
    const result = await dispatcher.dispatch({
      agent: 'BuildAgent',
      message: makeMessage(),
      transitionKey: 'task:proposed→ready',
    });
    if (!result.ok) expect(result.transient).toBe(true);
  });

  test('auth/shape error code Unauthorized → transient=false', async () => {
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory([], {
        throwOnSend: makeServiceBusError('Unauthorized'),
      }),
    });
    const result = await dispatcher.dispatch({
      agent: 'BuildAgent',
      message: makeMessage(),
      transitionKey: 'task:proposed→ready',
    });
    if (!result.ok) expect(result.transient).toBe(false);
  });

  test('plain Error (no code, no retryable) → transient=false (conservative default)', async () => {
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory([], { throwOnSend: new Error('unknown shape') }),
    });
    const result = await dispatcher.dispatch({
      agent: 'BuildAgent',
      message: makeMessage(),
      transitionKey: 'task:proposed→ready',
    });
    if (!result.ok) expect(result.transient).toBe(false);
  });

  test('sender-create throw also carries transient classification', async () => {
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: makeFakeSenderFactory([], {
        throwOnCreate: makeServiceBusError('ServiceBusy'),
      }),
    });
    const result = await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    if (!result.ok) expect(result.transient).toBe(true);
  });
});

describe('InMemoryServiceBusAgentDispatcher — recording behavior', () => {
  test('records each enqueue attempt with role, queueName, body', async () => {
    const dispatcher = new InMemoryServiceBusAgentDispatcher();
    const message = makeMessage();
    const result = await dispatcher.dispatch({
      agent: 'BuildAgent',
      message,
      transitionKey: 'task:proposed→ready',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dispatchId).toBe('disp-sb-1');
    expect(dispatcher.attemptCount()).toBe(1);
    expect(dispatcher.enqueueAttempts).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above.
    const attempt = dispatcher.enqueueAttempts[0]!;
    expect(attempt.role).toBe('BuildAgent');
    expect(attempt.queueName).toBe('agent-runs-build');
    expect(attempt.body.agent).toBe('BuildAgent');
    expect(attempt.body.transition_key).toBe('task:proposed→ready');
    expect(attempt.body.message.payloadHash).toBe(message.payloadHash.toString('hex'));
    expect(attempt.body.message.receivedAt).toBe(message.receivedAt.toISOString());
  });

  test('monotonic dispatch IDs across multiple enqueues', async () => {
    const dispatcher = new InMemoryServiceBusAgentDispatcher();
    const r1 = await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    const r2 = await dispatcher.dispatch({
      agent: 'ReviewAgent',
      message: makeMessage(),
      transitionKey: 'spec:drafting→ready_for_review',
    });
    if (r1.ok) expect(r1.dispatchId).toBe('disp-sb-1');
    if (r2.ok) expect(r2.dispatchId).toBe('disp-sb-2');
    expect(dispatcher.attemptCount()).toBe(2);
  });

  test('queueNames override propagates to recorded attempts', async () => {
    const dispatcher = new InMemoryServiceBusAgentDispatcher({ SpecAgent: 'custom-q' });
    await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    // biome-ignore lint/style/noNonNullAssertion: dispatch always pushes.
    expect(dispatcher.enqueueAttempts[0]!.queueName).toBe('custom-q');
  });
});

describe('resolveServiceBusAgentDispatcherBootConfig — env-driven boot', () => {
  test('returns null when neither env var is set', () => {
    const env = {};
    expect(resolveServiceBusAgentDispatcherBootConfig(env)).toBeNull();
  });

  test('connection-string takes precedence when both are set', () => {
    const env = {
      SERVICE_BUS_CONNECTION_STRING: TEST_CONNECTION_STRING,
      SERVICE_BUS_NAMESPACE: 'ns.servicebus.windows.net',
    };
    const config = resolveServiceBusAgentDispatcherBootConfig(env);
    expect(config?.kind).toBe('connection-string');
    if (config?.kind === 'connection-string') {
      expect(config.connectionString).toBe(TEST_CONNECTION_STRING);
    }
  });

  test('namespace-only → managed-identity boot config', () => {
    const env = { SERVICE_BUS_NAMESPACE: 'sfac-sb.servicebus.windows.net' };
    const config = resolveServiceBusAgentDispatcherBootConfig(env);
    expect(config?.kind).toBe('namespace');
    if (config?.kind === 'namespace') {
      expect(config.fullyQualifiedNamespace).toBe('sfac-sb.servicebus.windows.net');
    }
  });

  test('per-role queue overrides via AGENT_RUNS_QUEUE_<ROLE>', () => {
    const env = {
      SERVICE_BUS_CONNECTION_STRING: TEST_CONNECTION_STRING,
      AGENT_RUNS_QUEUE_SPEC: 'custom-spec',
      AGENT_RUNS_QUEUE_BUILD: 'custom-build',
    };
    const config = resolveServiceBusAgentDispatcherBootConfig(env);
    expect(config?.queueNames).toEqual({
      SpecAgent: 'custom-spec',
      BuildAgent: 'custom-build',
    });
  });

  test('resolveQueueNameOverrides covers all seven roles', () => {
    const env = {
      AGENT_RUNS_QUEUE_SPEC: 'a',
      AGENT_RUNS_QUEUE_DESIGN: 'b',
      AGENT_RUNS_QUEUE_PLANNER: 'c',
      AGENT_RUNS_QUEUE_BUILD: 'd',
      AGENT_RUNS_QUEUE_REVIEW: 'e',
      AGENT_RUNS_QUEUE_OPS: 'f',
      AGENT_RUNS_QUEUE_SRE: 'g',
    };
    expect(resolveQueueNameOverrides(env)).toEqual({
      SpecAgent: 'a',
      DesignAgent: 'b',
      PlannerAgent: 'c',
      BuildAgent: 'd',
      ReviewAgent: 'e',
      OpsAgent: 'f',
      SREAgent: 'g',
    });
  });

  test('empty-string env values are ignored', () => {
    const env = {
      SERVICE_BUS_CONNECTION_STRING: '',
      SERVICE_BUS_NAMESPACE: '',
      AGENT_RUNS_QUEUE_SPEC: '',
    };
    expect(resolveServiceBusAgentDispatcherBootConfig(env)).toBeNull();
    expect(resolveQueueNameOverrides(env)).toEqual({});
  });
});

describe('ServiceBusAgentDispatcher.close — releases pooled sender handles', () => {
  test('closes every pooled sender so the Container Apps Job can exit on idle-drain', async () => {
    const closedQueues: string[] = [];
    const senderFactory = (queueName: string) =>
      ({
        sendMessages: async () => undefined,
        close: async () => {
          closedQueues.push(queueName);
        },
      }) as unknown as ServiceBusSender;
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory,
    });

    // Two distinct roles → two pooled senders.
    await dispatcher.dispatch({
      agent: 'SpecAgent',
      message: makeMessage(),
      transitionKey: 'goal:proposed→accepted',
    });
    await dispatcher.dispatch({
      agent: 'BuildAgent',
      message: makeMessage({ kind: 'pr' }),
      transitionKey: 'pr:open→in_review',
    });

    await dispatcher.close();
    expect(closedQueues.sort()).toEqual(
      [DEFAULT_QUEUE_NAMES.SpecAgent, DEFAULT_QUEUE_NAMES.BuildAgent].sort(),
    );
  });

  test('close() is safe with no dispatches (empty sender pool)', async () => {
    const dispatcher = new ServiceBusAgentDispatcher({
      auth: { connectionString: TEST_CONNECTION_STRING },
      senderFactory: () => ({ sendMessages: async () => undefined }) as unknown as ServiceBusSender,
    });
    await expect(dispatcher.close()).resolves.toBeUndefined();
  });
});
