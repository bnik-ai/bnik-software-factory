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
    expect(out.numTurns).toBeNull();
    expect(out.costUsd).toBeNull();
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

describe('isolated execution contract', () => {
  test('preserves terminal SDK errors when its CLI exits nonzero but never masks transport failure as success', async () => {
    const stream =
      (subtype?: string): QueryFn =>
      () =>
        (async function* () {
          if (subtype) yield { type: 'result', subtype, num_turns: 1, total_cost_usd: 0.01 };
          throw new Error('CLI exited nonzero');
        })();
    const request = { cwd: '/workspace/repo', prompt: 'fixture' };
    const result = await runCodingAgent(request, stream('error_max_turns'));
    expect(result).toMatchObject({ ok: false, subtype: 'error_max_turns', numTurns: 1 });
    await expect(runCodingAgent(request, stream('success'))).rejects.toThrow('CLI exited');
    await expect(runCodingAgent(request, stream())).rejects.toThrow('CLI exited');
  });
  test('forwards only declared environment and disables external settings, plugins and MCP', async () => {
    const { fn, calls } = makeFakeQuery([
      { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, result: 'ok' },
    ]);
    const controller = new AbortController();
    await runCodingAgent(
      {
        cwd: '/workspace/repo',
        prompt: 'fixture',
        maxTurns: 2,
        isolation: { signal: controller.signal, environment: { HOME: '/tmp/worker-home' } },
      },
      fn,
    );
    expect(calls[0]?.options.env).toEqual({ HOME: '/tmp/worker-home' });
    expect(calls[0]?.options.settingSources).toEqual([]);
    expect(calls[0]?.options.plugins).toEqual([]);
    expect(calls[0]?.options.skills).toEqual([]);
    expect(calls[0]?.options.mcpServers).toEqual({});
    expect(calls[0]?.options.strictMcpConfig).toBe(true);
    expect(calls[0]?.options.persistSession).toBe(false);
  });
  test('cancellation reaches the SDK and invalid turn limits start no query', async () => {
    const controller = new AbortController();
    const fn: QueryFn = ({ options }) =>
      (async function* () {
        controller.abort();
        expect((options.abortController as AbortController).signal.aborted).toBe(true);
        yield { type: 'result', subtype: 'interrupted', num_turns: 0, total_cost_usd: 0 };
      })();
    const result = await runCodingAgent(
      {
        cwd: '/workspace/repo',
        prompt: 'fixture',
        isolation: { signal: controller.signal, environment: {} },
      },
      fn,
    );
    expect(result.ok).toBe(false);
    const never = makeFakeQuery([]);
    for (const maxTurns of [0, -1, 61, 1.5])
      await expect(
        runCodingAgent({ cwd: '/workspace/repo', prompt: 'fixture', maxTurns }, never.fn),
      ).rejects.toThrow('invalid_coding_turn_limit');
    await expect(
      runCodingAgent(
        {
          cwd: '/workspace/repo',
          prompt: 'fixture',
          isolation: { signal: controller.signal, environment: {} },
        },
        never.fn,
      ),
    ).rejects.toThrow();
    expect(never.calls).toHaveLength(0);
  });
});

describe('run budget and accounting', () => {
  test('passes a validated SDK budget and preserves only numeric model usage counters', async () => {
    const fake = makeFakeQuery([
      {
        type: 'result',
        subtype: 'error_max_budget_usd',
        num_turns: 1,
        total_cost_usd: 0.02,
        modelUsage: {
          fixture: {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            privateField: 'omit',
          },
        },
      },
    ]);
    const result = await runCodingAgent(
      { cwd: '/tmp/fixture', prompt: 'fixture', maxBudgetUsd: 0.01 },
      fake.fn,
    );
    expect(fake.calls[0]?.options.maxBudgetUsd).toBe(0.01);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(result.costUsd).toBe(0.02);
    expect(result.ok).toBe(false);
    for (const maxBudgetUsd of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 101])
      await expect(
        runCodingAgent({ cwd: '/tmp/fixture', prompt: 'fixture', maxBudgetUsd }, fake.fn),
      ).rejects.toThrow('invalid_coding_budget');
    expect(fake.calls).toHaveLength(1);
  });
  test('missing accounting and zeroed startup error accounting are unavailable', async () => {
    for (const message of [
      { type: 'result', subtype: 'success' },
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]) {
      const result = await runCodingAgent(
        { cwd: '/tmp/fixture', prompt: 'fixture' },
        makeFakeQuery([message]).fn,
      );
      expect(result.costUsd).toBeNull();
      expect(result.usage).toBeNull();
    }
  });
});
