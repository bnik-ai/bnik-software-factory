// doc-authoring "brain" for the text-generating agents (Spec/Design/Review).
// Thin wrapper around `@anthropic-ai/sdk` `messages.create()` (pinned
// 0.100.1). Unlike codingAgent (which drives real file edits via the Agent
// SDK), this returns generated markdown text only — no tools, no filesystem.
// Invariants:
//   - `new Anthropic()` reads ANTHROPIC_API_KEY from env automatically.
//   - Model resolves from the ANTHROPIC_MODEL env (the agents already read
//     it — see src/mainAgentBuild.ts) and falls back to DEFAULT_MODEL. A
//     per-request `model` overrides both.
//   - ANTHROPIC_MODEL holds the SHORT ADR-0008 branch-segment label (e.g.
//     `opus-4-7`, regex `[a-z0-9.-]+`; see README + mainAgentBuild.ts), NOT
//     a full Messages-API model id. `normalizeModelId` prefixes `claude-`
//     when absent so `opus-4-7` → `claude-opus-4-7` (the API rejects the bare
//     label); already-qualified ids pass through unchanged.
//   - The Anthropic client is dependency-injected (`client`) so tests pass a
//     fake; CI has no ANTHROPIC_API_KEY and MUST NOT call the real API.

import Anthropic from '@anthropic-ai/sdk';

// Fallback content-gen model. Sonnet for cost on doc authoring (plan: doc
// agents generate text, not code). Overridable via ANTHROPIC_MODEL env or
// the per-request `model`. Exact id, current Claude generation.
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Default output cap for a markdown doc generation.
export const DEFAULT_MAX_TOKENS = 4096;

export interface ContentRequest {
  // Optional system prompt establishing the agent's role/format rules.
  system?: string;
  // The user instruction (e.g. "author a Spec from this Goal body: ...").
  prompt: string;
  // Model override. Falls back to ANTHROPIC_MODEL env, then DEFAULT_MODEL.
  model?: string;
  // Output token cap. Defaults to DEFAULT_MAX_TOKENS.
  maxTokens?: number;
}

export interface ContentResult {
  // True iff a non-empty text response was produced.
  ok: boolean;
  // Concatenated text from the response's text content blocks.
  text: string;
  // The response stop_reason (e.g. 'end_turn', 'max_tokens'), if present.
  stopReason?: string;
}

// Structural subset of the SDK message response this module reads. Keeps the
// injected fake minimal.
interface TextBlockLike {
  type: string;
  text?: string;
}
interface MessageResponseLike {
  content: TextBlockLike[];
  stop_reason?: string | null;
}

// The injectable shape of the Anthropic client. We only depend on
// `messages.create` returning a message-like response.
export interface ContentClientLike {
  messages: {
    create: (body: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: 'user'; content: string }>;
    }) => Promise<MessageResponseLike>;
  };
}

// Map a short ADR-0008 branch-segment label to a Messages-API model id. The
// API wants `claude-<family>-<gen>` (e.g. `claude-opus-4-7`); the env/branch
// convention stores the bare `opus-4-7`. Already-qualified ids (`claude-…`)
// and DEFAULT_MODEL pass through untouched.
function normalizeModelId(model: string): string {
  return model.startsWith('claude-') ? model : `claude-${model}`;
}

function resolveModel(requested?: string): string {
  if (requested !== undefined && requested !== '') return normalizeModelId(requested);
  const fromEnv = process.env.ANTHROPIC_MODEL;
  if (fromEnv !== undefined && fromEnv !== '') return normalizeModelId(fromEnv);
  return DEFAULT_MODEL;
}

export async function generateContent(
  req: ContentRequest,
  client: ContentClientLike = new Anthropic() as unknown as ContentClientLike,
): Promise<ContentResult> {
  const response = await client.messages.create({
    model: resolveModel(req.model),
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(req.system !== undefined && req.system !== '' ? { system: req.system } : {}),
    messages: [{ role: 'user', content: req.prompt }],
  });

  // Concatenate the text from all text-type content blocks (the response
  // may interleave thinking/tool blocks; we only want emitted prose).
  const text = response.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');

  return {
    ok: text.length > 0,
    text,
    ...(response.stop_reason != null ? { stopReason: response.stop_reason } : {}),
  };
}
