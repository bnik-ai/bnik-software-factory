// coding "brain". Headless wrapper around `@anthropic-ai/claude-agent-sdk`
// `query()` (pinned 0.3.283). The SDK's Write/Edit/Bash tools make REAL
// persistent filesystem changes at `cwd` (the cloned repo working dir), so
// callers MUST scope `cwd` to a sandboxed clone.
// Invariants:
//   - `permissionMode: 'bypassPermissions'` — non-interactive Container Apps
//     Job has no human to approve tool use. This SDK version (0.3.283)
//     REQUIRES `allowDangerouslySkipPermissions: true` alongside it (sdk.d.ts:
//     "'bypassPermissions' … requires allowDangerouslySkipPermissions"); without
//     it the run cannot enter non-interactive mode and Write/Edit/Bash are
//     blocked.
//   - Tool surface is sandboxed via BOTH options (sdk.d.ts): `tools` sets the
//     *available* built-in tool set (`allowedTools` alone only auto-allows and
//     does NOT restrict), and `allowedTools` auto-allows them so they execute
//     without prompts. Both receive the same allowlist.
//   - `cwd` is the clone dir; the SDK reads ANTHROPIC_API_KEY from env.
//   - `maxTurns` caps loop-runaway.
//   - ADR 0009 commit-attribution trailers (SF-Agent/SF-Run/SF-Task) are
//     applied by the GitTool layer (services/agents/src/tools/), NOT
//     here — this module only drives the model's file edits.
//   - The SDK `query` is dependency-injected (`queryFn`) so tests drive a
//     fake async-generator; CI has no ANTHROPIC_API_KEY and MUST NOT call
//     the real SDK.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

// Default tool allowlist for a coding run. Matches the SDK tool names
// (verified against the live Agent SDK). Read/Grep/Glob for inspection;
// Write/Edit/Bash for real changes.
export const DEFAULT_CODING_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] as const;

// Default turn cap. Real build Tasks need many tool round-trips; 60 is a
// generous-but-bounded ceiling per the plan's loop-runaway guard.
export const DEFAULT_MAX_TURNS = 60;

export interface CodingAgentRequest {
  // Cloned repo working dir. The SDK's Write/Edit/Bash tools mutate this
  // path on the host filesystem — caller owns sandboxing/cleanup.
  cwd: string;
  // The Task instruction handed to the model as the prompt.
  prompt: string;
  // SDK tool allowlist. Defaults to DEFAULT_CODING_TOOLS.
  allowedTools?: string[];
  // Turn cap. Defaults to DEFAULT_MAX_TURNS.
  maxTurns?: number;
  maxBudgetUsd?: number;
  // Optional model override (e.g. a specific claude-* id). Omitted →
  // SDK default.
  model?: string;
  // Required by the isolated worker: no inherited host settings or environment.
  isolation?: { environment: Record<string, string>; signal: AbortSignal };
}

export interface CodingAgentResult {
  // True iff the run reached a `result` message with subtype 'success'.
  ok: boolean;
  // The `result` message subtype: 'success' | 'error_max_turns' |
  // 'error_during_execution' | 'error_max_budget_usd' | ... or the
  // 'no_result' sentinel if the stream ended without a result message.
  subtype: string;
  // Final text summary from the SDK result message ('' on error subtypes,
  // which carry no `result` field).
  summary: string;
  // Number of agent turns the run consumed.
  numTurns: number | null;
  // Total run cost in USD as reported by the SDK.
  costUsd: number | null;
  usage?: Record<string, number> | null;
}

// Structural subset of the SDK message stream this module reads. Kept
// minimal so the injected fake only has to satisfy what we consume.
interface ResultMessageLike {
  type: 'result';
  subtype: string;
  num_turns: number;
  total_cost_usd: number;
  modelUsage?: Record<string, Record<string, unknown>>;
  // Present only on the success variant (SDKResultSuccess); absent on
  // error subtypes.
  result?: string;
}

type StreamMessageLike = { type: string } & Partial<ResultMessageLike>;

// The injectable shape of the SDK `query`. The real export returns a
// `Query` (an AsyncGenerator); we only need the async-iterable contract.
export type QueryFn = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<StreamMessageLike>;

const NO_RESULT_SUBTYPE = 'no_result';

export async function runCodingAgent(
  req: CodingAgentRequest,
  queryFn: QueryFn = sdkQuery as unknown as QueryFn,
): Promise<CodingAgentResult> {
  if (
    !Number.isInteger(req.maxTurns ?? DEFAULT_MAX_TURNS) ||
    (req.maxTurns ?? DEFAULT_MAX_TURNS) < 1 ||
    (req.maxTurns ?? DEFAULT_MAX_TURNS) > 60
  )
    throw new Error('invalid_coding_turn_limit');
  if (
    req.maxBudgetUsd !== undefined &&
    (!Number.isFinite(req.maxBudgetUsd) || req.maxBudgetUsd < 0.001 || req.maxBudgetUsd > 100)
  )
    throw new Error('invalid_coding_budget');
  req.isolation?.signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.isolation?.signal.addEventListener('abort', abort, { once: true });
  const toolset = req.allowedTools ?? [...DEFAULT_CODING_TOOLS];
  const options: Record<string, unknown> = {
    cwd: req.cwd,
    ...(req.isolation
      ? {
          env: { ...req.isolation.environment },
          abortController: controller,
          settingSources: [],
          plugins: [],
          skills: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          stderr: () => {},
        }
      : {}),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // `tools` restricts the available built-in tool surface; `allowedTools`
    // auto-allows that same set so it runs without prompts. See header.
    tools: toolset,
    allowedTools: toolset,
    maxTurns: req.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(req.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: req.maxBudgetUsd }),
    ...(req.model !== undefined && req.model !== '' ? { model: req.model } : {}),
  };

  let resultMessage: ResultMessageLike | undefined;
  try {
    for await (const message of queryFn({ prompt: req.prompt, options })) {
      // The terminal `result` message carries the run summary + accounting.
      // Assistant/tool-use messages stream before it; we don't need their
      // contents for the result mapping (the GitTool layer inspects the
      // filesystem the SDK already mutated).
      if (message.type === 'result') {
        resultMessage = message as ResultMessageLike;
      }
    }
  } catch (error) {
    // The pinned SDK emits its terminal error result, then rejects the stream
    // when the CLI exits nonzero. Preserve that typed failure and accounting.
    // A transport failure after success (or without a result) remains a failure.
    if (!resultMessage || resultMessage.subtype === 'success' || req.isolation?.signal.aborted)
      throw error;
  } finally {
    req.isolation?.signal.removeEventListener('abort', abort);
  }

  if (resultMessage === undefined) {
    // Stream ended without a result message — a malformed/aborted run.
    // Surface a typed non-ok result rather than throwing.
    return {
      ok: false,
      subtype: NO_RESULT_SUBTYPE,
      summary: '',
      numTurns: null,
      costUsd: null,
      usage: null,
    };
  }

  const entries = Object.values(resultMessage.modelUsage ?? {});
  const counters = [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
  ];
  const usage =
    entries.length &&
    entries.length <= 16 &&
    entries.every((e) => counters.every((k) => Number.isSafeInteger(e[k]) && Number(e[k]) >= 0))
      ? Object.fromEntries(
          counters.map((k) => [k, entries.reduce((sum, e) => sum + Number(e[k]), 0)]),
        )
      : null;
  const cost = resultMessage.total_cost_usd;
  return {
    ok: resultMessage.subtype === 'success',
    subtype: resultMessage.subtype,
    summary: resultMessage.result ?? '',
    numTurns:
      Number.isSafeInteger(resultMessage.num_turns) && resultMessage.num_turns >= 0
        ? resultMessage.num_turns
        : null,
    costUsd:
      Number.isFinite(cost) &&
      cost >= 0 &&
      !(cost === 0 && !usage && resultMessage.subtype !== 'success')
        ? cost
        : null,
    usage,
  };
}
