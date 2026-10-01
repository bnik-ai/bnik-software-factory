// Spec: docs/design/azure-adapter.md (ca-agent Container App) + ADR 0011
// (orchestrator → agents dispatch topology).
// Routes: POST /agent/tool/github/:verb, GET /health.
// Auth: caller-side HMAC using an intra-service shared secret from Key
// Vault. v0 verifies the X-Sf-Agent-Signature-256 header against
// AGENT_HMAC_SECRET using the same constant-time comparison as the
// GitHub webhook verifier.
//
// What this surface IS (post-ADR 0011 approval):
//   - A substrate-API surface called BY the per-role agent Container
//     Apps Jobs (caj-agent-spec / caj-agent-design / caj-agent-build /
//     caj-agent-review). Agents POST to /agent/tool/github/<verb> when
//     they want centralized, rate-limit-aware, audit-logged GitHub API
//     access instead of minting their own installation tokens from
//     sf-app-private-key. v0 stub returns 503; the per-verb GitHub
//     adapters are not implemented.
//   - Centralization is OPTIONAL — per the infrastructure repository's
//     Terraform, every caj-agent-* Job already has sf-app-private-key
//     bound as an env_var_from_kv, so agents CAN mint installation
//     tokens directly via agentClient() without going through this
//     surface. Routing through ca-agent is the post-v0 path when we
//     want central per-org rate-limit accounting or a single
//     compromise-containment surface.
//
// What this surface IS NOT (post-ADR 0011 approval):
//   - The orchestrator's dispatch target. ADR 0011 retired that role
//     when it chose Option B (per-role Service Bus fan-out); the
//     orchestrator dispatches via Service Bus, so this surface registers
//     no /agent/dispatch route.
//
// Invariants:
//   - AGENT_HMAC_SECRET MUST be set at boot via readAgentHmacSecretFromEnv;
//     there is no safe default (matches GITHUB_WEBHOOK_SECRET discipline).
//   - The signature header carries the body's sha256 HMAC, prefixed
//     'sha256='. Same shape as GitHub's webhook signature.
//   - 401 on auth failure (missing / malformed / mismatched signature).
//     503 on routes that haven't been implemented yet but ARE authorized.

import { Hono } from 'hono';
import type { AgentClient } from '../agentClient.js';
import { verifyWebhookSignature } from '../hmac.js';

type AgentAppEnv = { Variables: { rawBody: Buffer } };

export const AGENT_HMAC_SECRET_ENV = 'AGENT_HMAC_SECRET';
export const AGENT_SIGNATURE_HEADER = 'x-sf-agent-signature-256';

export interface AgentAppConfig {
  agentHmacSecret: string;
  version?: string;
  // Optional GitHub App agent-scoped client (JWT→installation-token minting).
  // Injected at boot via buildGitHubAppDeps when GITHUB_APP_* env is set.
  // Optional so the existing test suite (HMAC-only) keeps working. The
  // per-verb routes return 503 and do not use this client in v0.
  agentClient?: AgentClient;
}

export function readAgentHmacSecretFromEnv(): string {
  const secret = process.env[AGENT_HMAC_SECRET_ENV];
  if (secret === undefined || secret === '') {
    throw new Error(`${AGENT_HMAC_SECRET_ENV} env var is required and was empty`);
  }
  return secret;
}

export function buildAgentApp(config: AgentAppConfig): Hono<AgentAppEnv> {
  const version = config.version ?? '0.0.0';
  const app = new Hono<AgentAppEnv>();

  app.get('/health', (c) => c.json({ ok: true, service: 'ca-agent', version }));

  // Auth middleware for /agent/* routes (NOT /health which is unauthenticated
  // for platform probes).
  app.use('/agent/*', async (c, next) => {
    const signatureHeader = c.req.header(AGENT_SIGNATURE_HEADER);
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const verdict = verifyWebhookSignature({
      signatureHeader,
      rawBody,
      secret: config.agentHmacSecret,
    });
    if (!verdict.ok) {
      return c.json({ error: 'unauthorized', reason: verdict.reason }, 401);
    }
    // Stash body for handlers to re-parse (we already consumed the stream).
    c.set('rawBody', rawBody);
    await next();
  });

  // Substrate-API surface: agents POST here when they want centralized,
  // rate-limit-aware GitHub API access instead of minting their own
  // installation tokens. Verb is one of:
  //   issue.applyLabel | issue.removeLabel | issue.comment | issue.create
  //   issue.read       | pull.open         | pull.close   | pull.submitReview
  //   pull.merge       | git.branch        | git.commit   | git.push
  // v0: every verb returns 503 (no per-verb GitHub adapters).
  app.post('/agent/tool/github/:verb', (c) => {
    const verb = c.req.param('verb');
    return c.json(
      {
        error: 'not_implemented_v0',
        detail: `Per-tool verb '${verb}' lands in a follow-up PR alongside the real IssueTool / GitTool / PullTool GitHub adapters. Centralization through ca-agent is OPTIONAL — agents can also mint installation tokens directly via agentClient() with their bound sf-app-private-key.`,
      },
      503,
    );
  });

  return app;
}
