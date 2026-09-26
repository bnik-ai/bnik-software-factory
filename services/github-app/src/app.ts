import { Hono } from 'hono';
import { type AuditLedger, InMemoryAuditLedger } from './auditLedger.js';
import { WEBHOOK_SECRET_ENV } from './constants.js';
import { GITHUB_WEBHOOK_EVENTS, NOISE_DROP_EVENTS } from './eventAllowlist.js';
import { type EventQueue, InMemoryEventQueue } from './eventQueue.js';
import { PostgresAuditLedger } from './postgresAuditLedger.js';
import { POSTGRES_HOST_ENV, buildPostgresPool } from './postgresClient.js';
import { ServiceBusEventQueue, resolveEventQueueBootConfig } from './serviceBusEventQueue.js';
import { handleWebhook } from './webhook.js';

export interface AppConfig {
  // The HMAC secret used to verify GitHub webhook deliveries.
  // Required — there is no safe default.
  webhookSecret: string;
  // Optional override of the event allowlist (mainly for tests). Defaults to
  // the canonical set in `eventAllowlist.ts`.
  allowedEvents?: ReadonlySet<string>;
  // Audit-ledger implementation. Defaults to an in-memory implementation
  // suitable for tests and v0 boot; B7 swaps in a Postgres-backed one.
  auditLedger?: AuditLedger;
  // Event-queue implementation. Defaults to an in-memory implementation
  // suitable for tests and v0 boot; B7 swaps in an Azure Service Bus one.
  eventQueue?: EventQueue;
}

// Build a Hono app bound to the given config. Exported as a factory so that
// tests can inject a fixture secret without touching process.env; production
// boot (PR5+) calls `buildApp({ webhookSecret: readWebhookSecretFromEnv() })`.
export function buildApp(config: AppConfig): Hono {
  const {
    webhookSecret,
    allowedEvents = GITHUB_WEBHOOK_EVENTS,
    auditLedger = new InMemoryAuditLedger(),
    eventQueue = new InMemoryEventQueue(),
  } = config;
  const app = new Hono();

  app.get('/admin/health', (c) => c.json({ ok: true }));

  // Liveness probe: static, no I/O, no auth, no config lookups. Distinct from
  // `/admin/health` so platform liveness checks (k8s/ACA) can hit a guaranteed
  // cheap endpoint without traversing any admin-facing surface.
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.post('/webhook', async (c) => {
    const rawBodyBuffer = Buffer.from(await c.req.arrayBuffer());
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const verification = handleWebhook({
      headers,
      rawBody: rawBodyBuffer,
      secret: webhookSecret,
      allowedEvents,
    });

    if (verification.status !== 200) {
      return c.json(verification.body, verification.status);
    }

    const { deliveryId, event } = verification.body;

    // Issue #174 noise isolation: subscribed CI/dev events carry no FSM
    // transition. Signature-verified above; ACKNOWLEDGE (2xx, so GitHub does
    // not mark the delivery failed) and DROP — no ledger row, no enqueue.
    if (NOISE_DROP_EVENTS.has(event)) {
      return c.json({ ok: true, deliveryId, event, dropped: 'noise_event' }, 202);
    }

    // `installation.id` off the raw body so the validator's read-only
    // SubstrateClient can mint an installation token for the target repo
    // (issue #164). Both are optional — a malformed body or a delivery
    // without an `installation` block simply omits them and the validator
    // falls back to the in-memory substrate. Parsing here is best-effort and
    // never fails the webhook (the raw payload is the canonical carrier).
    const { repoFullName, installationId, recordNodeId } = parseRepoAndInstallation(rawBodyBuffer);

    // Two-phase ledger contract: see src/auditLedger.ts for the rationale.
    // `beginDelivery` reserves a row by `delivery_id`; `confirmEnqueued`
    // marks it processed AFTER the queue write succeeds. If `enqueue`
    // throws we return 503 with the row left pending so the next GitHub
    // redelivery re-attempts the enqueue.
    const ledgerResult = await auditLedger.beginDelivery({ deliveryId, event });

    if (ledgerResult.alreadyEnqueued) {
      return c.json({ ok: true, deliveryId, event, seq: ledgerResult.seq, idempotent: true }, 200);
    }

    try {
      await eventQueue.enqueue({
        deliveryId,
        event,
        payload: rawBodyBuffer.toString('utf8'),
        ...(repoFullName !== undefined ? { repoFullName } : {}),
        ...(installationId !== undefined ? { installationId } : {}),
        // Per-record session so all of one record's deliveries are FIFO-ordered
        // (prevents the auto-advance creation race; codex PR #150). Falls back to
        // the delivery id inside the queue when no record id is present.
        ...(recordNodeId !== undefined ? { sessionId: recordNodeId } : {}),
      });
    } catch (_err) {
      // Leave the ledger row pending (no confirmEnqueued call); GitHub's
      // retry will re-attempt this enqueue. The downstream queue is
      // at-least-once, so consumers must deduplicate on `delivery_id`.
      return c.json({ ok: false, reason: 'enqueue_failed' }, 503);
    }

    await auditLedger.confirmEnqueued(deliveryId);
    return c.json({ ok: true, deliveryId, event, seq: ledgerResult.seq }, 200);
  });

  return app;
}

// M2: best-effort extraction of `repository.full_name` + `installation.id`
// from the raw webhook body. Returns undefined fields when the body is
// unparseable or the keys are absent/wrong-typed — never throws, so a
// malformed body still flows through the existing parse-failure path
// downstream rather than failing the webhook here.
export function parseRepoAndInstallation(rawBody: Buffer): {
  repoFullName?: string;
  installationId?: number;
  recordNodeId?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const body = parsed as Record<string, unknown>;

  const repository = body.repository;
  let repoFullName: string | undefined;
  if (typeof repository === 'object' && repository !== null) {
    const fullName = (repository as Record<string, unknown>).full_name;
    if (typeof fullName === 'string' && fullName.length > 0) repoFullName = fullName;
  }

  const installation = body.installation;
  let installationId: number | undefined;
  if (typeof installation === 'object' && installation !== null) {
    const id = (installation as Record<string, unknown>).id;
    if (typeof id === 'number' && Number.isInteger(id)) installationId = id;
  }

  // The record's GraphQL node id — used as the per-record Service Bus session
  // key so every delivery for ONE record is processed in FIFO order (issues.opened
  // before issues.labeled, etc.). Without it the validator can resolve a label
  // change against a not-yet-written creation ledger row and dead-letter a valid
  // transition (the hands-off auto-advance race; codex PR #150). issue/PR/
  // deployment cover every FSM-bearing event; `pull_request_review` carries the
  // reviewed `pull_request`, so PR-lifecycle events all share one session. When
  // absent (e.g. non-record events), the enqueue falls back to the delivery id.
  const recordNodeId =
    nodeIdOf(body.issue) ?? nodeIdOf(body.pull_request) ?? nodeIdOf(body.deployment);

  return {
    ...(repoFullName !== undefined ? { repoFullName } : {}),
    ...(installationId !== undefined ? { installationId } : {}),
    ...(recordNodeId !== undefined ? { recordNodeId } : {}),
  };
}

// Extract a non-empty `node_id` string from a webhook sub-object, or undefined.
function nodeIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const nodeId = (value as Record<string, unknown>).node_id;
  return typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : undefined;
}

// Resolves the webhook secret from the environment. Kept separate from
// `buildApp` so tests never touch process.env and so production boot has
// one obvious failure point if the secret is missing.
export function readWebhookSecretFromEnv(): string {
  const secret = process.env[WEBHOOK_SECRET_ENV];
  if (secret === undefined || secret.length === 0) {
    throw new Error(
      `${WEBHOOK_SECRET_ENV} is not set; refusing to start without a webhook secret.`,
    );
  }
  return secret;
}

// Env-driven EventQueue resolution. Returns a ServiceBusEventQueue when SB
// env is set (connection string or namespace FQDN), else the in-memory impl
// so the v0 boot + existing tests keep working with no SB env. The chosen
// impl name is returned for boot logging (never logs secrets).
export function resolveEventQueueFromEnv(): { queue: EventQueue; impl: string } {
  const boot = resolveEventQueueBootConfig();
  switch (boot.kind) {
    case 'connection-string':
      return {
        queue: new ServiceBusEventQueue({
          auth: { connectionString: boot.connectionString },
          queueName: boot.queueName,
        }),
        impl: `service-bus(connection-string, queue=${boot.queueName})`,
      };
    case 'managed-identity':
      return {
        queue: lazyManagedIdentityServiceBusQueue(boot.fullyQualifiedNamespace, boot.queueName),
        impl: `service-bus(managed-identity, ns=${boot.fullyQualifiedNamespace}, queue=${boot.queueName})`,
      };
    default:
      return { queue: new InMemoryEventQueue(), impl: 'in-memory' };
  }
}

// Defers DefaultAzureCredential construction (and the @azure/identity import)
// to the SB-managed-identity branch only, so non-SB boots / tests never load
// the credential.
function lazyManagedIdentityServiceBusQueue(
  fullyQualifiedNamespace: string,
  queueName: string,
): EventQueue {
  return new ServiceBusEventQueue({
    queueName,
    senderFactory: async () => {
      const [{ ServiceBusClient }, { DefaultAzureCredential }] = await Promise.all([
        import('@azure/service-bus'),
        import('@azure/identity'),
      ]);
      const client = new ServiceBusClient(fullyQualifiedNamespace, new DefaultAzureCredential());
      return client.createSender(queueName);
    },
  });
}

// Env-driven AuditLedger resolution. Returns a Postgres-backed ledger when
// POSTGRES_HOST is set, else the in-memory impl. The chosen impl name is
// returned for boot logging.
export function resolveAuditLedgerFromEnv(): { ledger: AuditLedger; impl: string } {
  const host = process.env[POSTGRES_HOST_ENV];
  if (host !== undefined && host !== '') {
    return { ledger: new PostgresAuditLedger(buildPostgresPool()), impl: `postgres(${host})` };
  }
  return { ledger: new InMemoryAuditLedger(), impl: 'in-memory' };
}
