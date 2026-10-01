// Spec: docs/design/azure-adapter.md (ca-terraform Container App).
// Routes: POST /terraform/plan, POST /terraform/apply, GET /health.
// Auth: signed dispatch from GitHub Actions + validator-bot. v0 uses the
// same HMAC scheme as ca-agent, with a distinct env var so secret
// rotation can move independently. Real terraform execution (shelling
// out to the terraform CLI under managed identity) is not implemented:
// plan/apply return 503 not_implemented_v0.

import { Hono } from 'hono';
import { verifyWebhookSignature } from '../hmac.js';
import type { SubstrateClient } from '../substrateClient.js';

type TerraformAppEnv = { Variables: { rawBody: Buffer } };

export const TERRAFORM_HMAC_SECRET_ENV = 'TERRAFORM_HMAC_SECRET';
export const TERRAFORM_SIGNATURE_HEADER = 'x-sf-terraform-signature-256';

export interface TerraformAppConfig {
  terraformHmacSecret: string;
  version?: string;
  // Optional GitHub App substrate-scoped client (JWT→installation-token
  // minting for Terraform commits). Injected at boot via buildGitHubAppDeps
  // when GITHUB_APP_* env is set. Optional so the existing HMAC-only test
  // suite keeps working; the plan/apply routes return 503 and do not use
  // this client in v0.
  substrateClient?: SubstrateClient;
}

export function readTerraformHmacSecretFromEnv(): string {
  const secret = process.env[TERRAFORM_HMAC_SECRET_ENV];
  if (secret === undefined || secret === '') {
    throw new Error(`${TERRAFORM_HMAC_SECRET_ENV} env var is required and was empty`);
  }
  return secret;
}

export function buildTerraformApp(config: TerraformAppConfig): Hono<TerraformAppEnv> {
  const version = config.version ?? '0.0.0';
  const app = new Hono<TerraformAppEnv>();

  app.get('/health', (c) => c.json({ ok: true, service: 'ca-terraform', version }));

  app.use('/terraform/*', async (c, next) => {
    const signatureHeader = c.req.header(TERRAFORM_SIGNATURE_HEADER);
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const verdict = verifyWebhookSignature({
      signatureHeader,
      rawBody,
      secret: config.terraformHmacSecret,
    });
    if (!verdict.ok) {
      return c.json({ error: 'unauthorized', reason: verdict.reason }, 401);
    }
    c.set('rawBody', rawBody);
    await next();
  });

  app.post('/terraform/plan', (c) =>
    c.json(
      {
        error: 'not_implemented_v0',
        detail: 'Terraform execution is experimental and is not implemented by this endpoint',
      },
      503,
    ),
  );

  app.post('/terraform/apply', (c) =>
    c.json(
      {
        error: 'not_implemented_v0',
        detail: 'Terraform execution is experimental; deployment overlays own the apply policy',
      },
      503,
    ),
  );

  return app;
}
