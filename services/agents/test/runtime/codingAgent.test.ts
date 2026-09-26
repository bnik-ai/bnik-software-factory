import { describe, expect, test } from 'vitest';
import {
  DEFAULT_CODING_TOOLS,
  DEFAULT_MAX_TURNS,
  type QueryFn,
  runCodingAgent,
} from '../../src/runtime/codingAgent.js';

// Build a fake SDK `query` async-generator that yields the given messages
// and records the params it was called with (so we assert option mapping).
function makeFakeQuery(messages: Array<Record<string, unknown>>): {
  fn: QueryFn;
  calls: Array<{ prompt: string; options: Record<string, unknown> }>;
} {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const fn = ((params: { prompt: string; options: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options });
    return (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
  }) as unknown as QueryFn;
  return { fn, calls };
}

const ASSISTANT_MSG = {
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.ts' } }] },
};

describe('runCodingAgent — result mapping', () => {
  test('success result maps subtype/summary/numTurns/costUsd and ok=true', async () => {
    const { fn } = makeFakeQuery([
      ASSISTANT_MSG,
      {
        type: 'result',
        subtype: 'success',
        num_turns: 7,
        total_cost_usd: 0.42,
        result: 'Added /healthz endpoint with a test.',
      },
    ]);

    const out = await runCodingAgent({ cwd: '/tmp/clone', prompt: 'do the task' }, fn);

    expect(out.ok).toBe(true);
    expect(out.subtype).toBe('success');
    expect(out.summary).toBe('Added /healthz endpoint with a test.');
    expect(out.numTurns).toBe(7);
    expect(out.costUsd).toBe(0.42);
  });

  test('error_max_turns subtype → ok=false, empty summary (no result field)', async () => {
    const { fn } = makeFakeQuery([
      ASSISTANT_MSG,
      { type: 'result', subtype: 'error_max_turns', num_turns: 60, total_cost_usd: 1.1 },
    ]);

    const out = await runCodingAgent({ cwd: '/tmp/clone', prompt: 'do the task' }, fn);

    expect(out.ok).toBe(false);
    expect(out.subtype).toBe('error_max_turns');
    expect(out.summary).toBe('');
    expect(out.numTurns).toBe(60);
    expect(out.costUsd).toBe(1.1);
  });

  test('last result message wins when several are streamed', async () => {
    const { fn } = makeFakeQuery([
      { type: 'result', subtype: 'error_during_execution', num_turns: 1, total_cost_usd: 0.01 },
      { type: 'result', subtype: 'success', num_turns: 9, total_cost_usd: 0.5, result: 'done' },
    ]);

    const out = await runCodingAgent({ cwd: '/tmp/clone', prompt: 'p' }, fn);

    expect(out.ok).toBe(true);
    expect(out.subtype).toBe('success');
    expect(out.numTurns).toBe(9);
  });

  test('stream without a result message → ok=false, no_result sentinel', async () => {
    const { fn } = makeFakeQuery([ASSISTANT_MSG]);

    const out = await runCodingAgent({ cwd: '/tmp/clone', prompt: 'p' }, fn);

    expect(out.ok).toBe(false);
    expect(out.subtype).toBe('no_result');
    expect(out.summary).toBe('');
    expect(out.numTurns).toBe(0);
    expect(out.costUsd).toBe(0);
  });
});

describe('runCodingAgent — option mapping into query()', () => {
  test('defaults: bypassPermissions, DEFAULT_CODING_TOOLS, DEFAULT_MAX_TURNS, no model', async () => {
    const { fn, calls } = makeFakeQuery([
      { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, result: 'ok' },
    ]);

    await runCodingAgent({ cwd: '/tmp/clone', prompt: 'the prompt' }, fn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe('the prompt');
    const options = calls[0]?.options ?? {};
    expect(options.cwd).toBe('/tmp/clone');
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.tools).toEqual([...DEFAULT_CODING_TOOLS]);
    expect(options.allowedTools).toEqual([...DEFAULT_CODING_TOOLS]);
    expect(options.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect('model' in options).toBe(false);
  });

  test('overrides: custom allowedTools, maxTurns, and model are threaded', async () => {
    const { fn, calls } = makeFakeQuery([
      { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, result: 'ok' },
    ]);

    await runCodingAgent(
      {
        cwd: '/work',
        prompt: 'p',
        allowedTools: ['Read', 'Bash'],
        maxTurns: 12,
        model: 'claude-opus-4-8',
      },
      fn,
    );

    const options = calls[0]?.options ?? {};
    expect(options.tools).toEqual(['Read', 'Bash']);
    expect(options.allowedTools).toEqual(['Read', 'Bash']);
    expect(options.maxTurns).toBe(12);
    expect(options.model).toBe('claude-opus-4-8');
  });
});
