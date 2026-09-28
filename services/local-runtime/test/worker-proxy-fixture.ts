// Diagnostic transport for the real SDK container test. Never selected by the
// production executor; it contains no live credentials and makes no network call.
import { chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type ProxyConfig, apiProxy } from '../src/worker/proxy.js';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const config = JSON.parse(raw) as ProxyConfig;
let messages = 0;
const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
  const body = JSON.parse(String(init.body)) as {
    stream?: boolean;
    model: string;
    messages: { content: unknown }[];
  };
  if (String(url).includes('count_tokens')) return Response.json({ input_tokens: 100 });
  messages++;
  if (config.model.startsWith('claude-fixture-review')) {
    const critical = config.model === 'claude-fixture-review-critical';
    const malformed = config.model === 'claude-fixture-review-malformed';
    const verdict = critical
      ? {
          risk: 'critical',
          categories: ['security_auth'],
          findings: [
            {
              id: 'F1',
              severity: 'high',
              summary: 'Authorization check removed.',
              location: 'sum.js:1',
            },
          ],
          limitations: [],
        }
      : {
          risk: 'routine',
          categories: [],
          findings: [
            { id: 'F1', severity: 'low', summary: 'Consider a comment.', location: 'sum.js:1' },
          ],
          limitations: [],
        };
    return Response.json({
      id: `msg_fixture_review_${messages}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [
        {
          type: 'text',
          text: malformed ? 'LGTM, ship it' : `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``,
        },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 400, output_tokens: 60 },
    });
  }
  const loop = config.model === 'claude-fixture-loop';
  const tool = loop || messages === 1;
  const content = tool
    ? {
        type: 'tool_use',
        id: `toolu_fixture_${messages}`,
        name: 'Bash',
        input: {
          command: "printf 'module.exports = (a, b) => a + b;\\n' > sum.js",
          description: 'Apply a synthetic arithmetic fix',
        },
      }
    : { type: 'text', text: 'Synthetic SDK fixture completed.' };
  const message = {
    id: `msg_fixture_${messages}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [content],
    stop_reason: tool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 25 },
  };
  if (!body.stream) return Response.json(message);
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const events = [
    frame('message_start', {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: tool
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify('input' in content ? content.input : {}),
          }
        : { type: 'text_delta', text: 'Synthetic SDK fixture completed.' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 25 },
    }),
    frame('message_stop', { type: 'message_stop' }),
  ];
  return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
}) as typeof fetch;
const server = createServer(apiProxy(config, fake));
await new Promise<void>((resolve) => server.listen('/run/egress/api.sock', resolve));
await chmod('/run/egress/api.sock', 0o600);
setTimeout(() => process.exit(0), config.timeoutMs).unref();
