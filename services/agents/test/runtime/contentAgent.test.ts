import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type ContentClientLike,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  generateContent,
} from '../../src/runtime/contentAgent.js';

// Build a fake Anthropic client returning a fixed response and recording
// the create() body so we assert model/max_tokens/system/messages mapping.
function makeFakeClient(response: {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}): {
  client: ContentClientLike;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const client: ContentClientLike = {
    messages: {
      create: async (body) => {
        calls.push(body as unknown as Record<string, unknown>);
        return response;
      },
    },
  };
  return { client, calls };
}

// vi.stubEnv handles set + unset of ANTHROPIC_MODEL without the env-string
// pitfall of `delete`/`= undefined`; unstubAllEnvs restores the original.
beforeEach(() => {
  vi.stubEnv('ANTHROPIC_MODEL', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('generateContent — text extraction', () => {
  test('concatenates text blocks, sets ok=true and stopReason', async () => {
    const { client } = makeFakeClient({
      content: [
        { type: 'text', text: '# Spec\n' },
        { type: 'text', text: 'Body line.' },
      ],
      stop_reason: 'end_turn',
    });

    const out = await generateContent({ prompt: 'author a spec' }, client);

    expect(out.ok).toBe(true);
    expect(out.text).toBe('# Spec\nBody line.');
    expect(out.stopReason).toBe('end_turn');
  });

  test('ignores non-text content blocks', async () => {
    const { client } = makeFakeClient({
      content: [
        { type: 'thinking', text: 'hmm' },
        { type: 'text', text: 'kept' },
        { type: 'tool_use' },
      ],
      stop_reason: 'end_turn',
    });

    const out = await generateContent({ prompt: 'p' }, client);

    expect(out.text).toBe('kept');
  });

  test('empty text → ok=false', async () => {
    const { client } = makeFakeClient({ content: [], stop_reason: 'end_turn' });

    const out = await generateContent({ prompt: 'p' }, client);

    expect(out.ok).toBe(false);
    expect(out.text).toBe('');
  });

  test('null stop_reason → stopReason omitted', async () => {
    const { client } = makeFakeClient({
      content: [{ type: 'text', text: 'x' }],
      stop_reason: null,
    });

    const out = await generateContent({ prompt: 'p' }, client);

    expect(out.stopReason).toBeUndefined();
  });
});

describe('generateContent — model + param resolution', () => {
  test('defaults: DEFAULT_MODEL, DEFAULT_MAX_TOKENS, user message, no system', async () => {
    const { client, calls } = makeFakeClient({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });

    await generateContent({ prompt: 'hello' }, client);

    const body = calls[0] ?? {};
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect('system' in body).toBe(false);
  });

  test('per-request model + system + maxTokens override', async () => {
    const { client, calls } = makeFakeClient({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });

    await generateContent(
      { prompt: 'p', system: 'You are a spec author.', model: 'claude-opus-4-8', maxTokens: 1000 },
      client,
    );

    const body = calls[0] ?? {};
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.max_tokens).toBe(1000);
    expect(body.system).toBe('You are a spec author.');
  });

  test('ANTHROPIC_MODEL env is used when no per-request model', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5');
    const { client, calls } = makeFakeClient({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });

    await generateContent({ prompt: 'p' }, client);

    expect(calls[0]?.model).toBe('claude-haiku-4-5');
  });

  test('per-request model wins over ANTHROPIC_MODEL env', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5');
    const { client, calls } = makeFakeClient({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });

    await generateContent({ prompt: 'p', model: 'claude-opus-4-8' }, client);

    expect(calls[0]?.model).toBe('claude-opus-4-8');
  });

  test('short ADR-0008 branch label (opus-4-7) is normalized to a full API id', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'opus-4-7');
    const { client, calls } = makeFakeClient({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });

    await generateContent({ prompt: 'p' }, client);

    expect(calls[0]?.model).toBe('claude-opus-4-7');
  });

  test('per-request short label is also normalized', async () => {
    const { client, calls } = makeFakeClient({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });

    await generateContent({ prompt: 'p', model: 'sonnet-4-6' }, client);

    expect(calls[0]?.model).toBe('claude-sonnet-4-6');
  });
});
