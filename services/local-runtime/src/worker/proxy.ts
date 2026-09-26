import { chmod } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export interface ProxyConfig {
  apiKey: string;
  model: string;
  maxRequests: number;
  timeoutMs: number;
}
// A fixed-origin API proxy, never a CONNECT tunnel. The worker receives no API key.
export function apiProxy(config: ProxyConfig, upstream: typeof fetch = fetch) {
  let requests = 0;
  const lifetime = AbortSignal.timeout(config.timeoutMs);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const deny = (status: number) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            type: 'worker_proxy_denied',
            message: 'Request not permitted by the worker profile.',
          },
        }),
      );
    };
    if (
      req.method !== 'POST' ||
      ![
        '/v1/messages',
        '/v1/messages?beta=true',
        '/v1/messages/count_tokens',
        '/v1/messages/count_tokens?beta=true',
      ].includes(req.url ?? '')
    )
      return deny(403);
    if (lifetime.aborted || requests >= config.maxRequests) return deny(429);
    requests++;
    try {
      let body = Buffer.alloc(0);
      for await (const chunk of req) {
        body = Buffer.concat([body, chunk]);
        if (body.length > 2 * 1024 * 1024) return deny(413);
      }
      const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      if (payload.model !== config.model || !Array.isArray(payload.messages)) return deny(403);
      if (
        !req.url?.includes('count_tokens') &&
        (typeof payload.max_tokens !== 'number' ||
          !Number.isSafeInteger(payload.max_tokens) ||
          payload.max_tokens < 1 ||
          payload.max_tokens > 16384)
      )
        return deny(403);
      // Provider callbacks, network tools and background continuations are excluded.
      const permitted = [
        'model',
        'messages',
        'max_tokens',
        'system',
        'tools',
        'tool_choice',
        'stream',
        'temperature',
        'top_p',
        'top_k',
        'stop_sequences',
        'thinking',
        'metadata',
        'output_config',
        'context_management',
        'service_tier',
        'cache_control',
      ];
      if (Object.keys(payload).some((key) => !permitted.includes(key))) return deny(403);
      if (
        Array.isArray(payload.tools) &&
        payload.tools.some((tool) => tool?.type && tool.type !== 'custom')
      )
        return deny(403);
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const result = await upstream(`https://api.anthropic.com${req.url}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': config.apiKey,
          ...(typeof req.headers['anthropic-beta'] === 'string'
            ? { 'anthropic-beta': req.headers['anthropic-beta'] }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([controller.signal, lifetime]),
      });
      res.writeHead(result.status, {
        'content-type': result.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      });
      if (result.body) {
        for await (const chunk of result.body) {
          if (!res.write(chunk))
            await new Promise<void>((resolve) => {
              res.once('drain', resolve);
              res.once('close', resolve);
            });
          if (controller.signal.aborted) break;
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) deny(502);
      else res.destroy();
    }
  };
}
async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 8192) throw new Error('invalid_proxy_input');
  }
  const config = JSON.parse(raw) as ProxyConfig;
  if (
    typeof config.apiKey !== 'string' ||
    !config.apiKey ||
    !/^claude-[A-Za-z0-9.-]+$/.test(config.model) ||
    !Number.isInteger(config.maxRequests) ||
    config.maxRequests < 1 ||
    config.maxRequests > 64 ||
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1000 ||
    config.timeoutMs > 1_860_000
  )
    throw new Error('invalid_proxy_configuration');
  const server = createServer(apiProxy(config));
  server.maxConnections = 4;
  server.requestTimeout = Math.min(config.timeoutMs, 120_000);
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen('/run/egress/api.sock', resolve);
  });
  await chmod('/run/egress/api.sock', 0o600);
  setTimeout(() => {
    server.closeAllConnections();
    server.close();
  }, config.timeoutMs).unref();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('worker_proxy_failed');
    process.exitCode = 1;
  });
