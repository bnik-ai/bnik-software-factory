import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_PRODUCE_QUEUE_NAME,
  type SenderLike,
  ServiceBusEventQueue,
  resolveEventQueueBootConfig,
} from '../src/serviceBusEventQueue.js';

function makeSender() {
  const sent: Array<{
    body: unknown;
    sessionId?: string;
    contentType?: string;
    messageId?: string;
  }> = [];
  const sender: SenderLike = {
    async sendMessages(message) {
      sent.push(message);
    },
  };
  return { sender, sent };
}

describe('ServiceBusEventQueue.enqueue', () => {
  test('sends the wire shape with sessionId defaulting to deliveryId', async () => {
    const { sender, sent } = makeSender();
    const queue = new ServiceBusEventQueue({ senderFactory: () => sender });

    await queue.enqueue({ deliveryId: 'd-1', event: 'issues', payload: '{"a":1}' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      body: { deliveryId: 'd-1', event: 'issues', payload: '{"a":1}' },
      sessionId: 'd-1',
      contentType: 'application/json',
      messageId: 'd-1',
    });
  });

  test('M2: includes repoFullName + installationId in the body when supplied', async () => {
    const { sender, sent } = makeSender();
    const queue = new ServiceBusEventQueue({ senderFactory: () => sender });

    await queue.enqueue({
      deliveryId: 'd-3',
      event: 'issues',
      payload: '{}',
      repoFullName: 'example-org/software-factory',
      installationId: 77,
    });

    expect(sent[0]?.body).toEqual({
      deliveryId: 'd-3',
      event: 'issues',
      payload: '{}',
      repoFullName: 'example-org/software-factory',
      installationId: 77,
    });
  });

  test('uses an explicit sessionId when supplied', async () => {
    const { sender, sent } = makeSender();
    const queue = new ServiceBusEventQueue({ senderFactory: () => sender });

    await queue.enqueue({
      deliveryId: 'd-2',
      event: 'pull_request',
      payload: 'body',
      sessionId: 'record-42',
    });

    expect(sent[0]?.sessionId).toBe('record-42');
    expect(sent[0]?.messageId).toBe('d-2');
  });

  test('lazily creates the sender exactly once across enqueues', async () => {
    const { sender } = makeSender();
    const factory = vi.fn(() => sender);
    const queue = new ServiceBusEventQueue({ senderFactory: factory });

    await queue.enqueue({ deliveryId: 'd-1', event: 'issues', payload: 'x' });
    await queue.enqueue({ deliveryId: 'd-2', event: 'issues', payload: 'y' });

    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('throws when neither senderFactory nor auth is provided', () => {
    expect(() => new ServiceBusEventQueue({})).toThrow(/senderFactory or auth/);
  });
});

describe('resolveEventQueueBootConfig', () => {
  const ENV_KEYS = [
    'SERVICE_BUS_CONNECTION_STRING',
    'SERVICE_BUS_NAMESPACE',
    'SERVICE_BUS_PRODUCE_QUEUE',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  // delete on a literal env member trips noDelete + useLiteralKeys at once;
  // the variable form is how app.test.ts unsets env.
  const unsetEnv = (key: string): void => {
    delete process.env[key];
  };

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('returns in-memory when no SB env is set', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(resolveEventQueueBootConfig()).toEqual({ kind: 'in-memory' });
  });

  test('prefers a connection string over the namespace', () => {
    process.env.SERVICE_BUS_CONNECTION_STRING = 'Endpoint=sb://x';
    process.env.SERVICE_BUS_NAMESPACE = 'ns.servicebus.windows.net';
    expect(resolveEventQueueBootConfig()).toEqual({
      kind: 'connection-string',
      connectionString: 'Endpoint=sb://x',
      queueName: DEFAULT_PRODUCE_QUEUE_NAME,
    });
  });

  test('falls back to managed-identity from the namespace FQDN', () => {
    unsetEnv('SERVICE_BUS_CONNECTION_STRING');
    process.env.SERVICE_BUS_NAMESPACE = 'sfac-dev-region-sb-main.servicebus.windows.net';
    process.env.SERVICE_BUS_PRODUCE_QUEUE = 'validator-events';
    expect(resolveEventQueueBootConfig()).toEqual({
      kind: 'managed-identity',
      fullyQualifiedNamespace: 'sfac-dev-region-sb-main.servicebus.windows.net',
      queueName: 'validator-events',
    });
  });

  test('defaults the produce queue to validator-events', () => {
    unsetEnv('SERVICE_BUS_CONNECTION_STRING');
    unsetEnv('SERVICE_BUS_PRODUCE_QUEUE');
    process.env.SERVICE_BUS_NAMESPACE = 'ns.servicebus.windows.net';
    const boot = resolveEventQueueBootConfig();
    expect(boot.kind === 'managed-identity' && boot.queueName).toBe('validator-events');
  });

  test('treats a set-but-empty produce queue as unset (defaults to validator-events)', () => {
    unsetEnv('SERVICE_BUS_CONNECTION_STRING');
    process.env.SERVICE_BUS_NAMESPACE = 'ns.servicebus.windows.net';
    process.env.SERVICE_BUS_PRODUCE_QUEUE = '';
    const boot = resolveEventQueueBootConfig();
    expect(boot.kind === 'managed-identity' && boot.queueName).toBe('validator-events');
  });
});
