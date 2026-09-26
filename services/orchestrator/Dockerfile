# Experimental Azure-era recipe; not a supported local quickstart.
# Spec: docs/design/azure-adapter.md (caj-orchestrator Container Apps Job).
# Invariants:
#   - Same four-stage shape + non-root + runtime-deps-only image as
#     services/validator/Dockerfile.
#   - No HEALTHCHECK / no EXPOSE: this is a Container Apps JOB (event-
#     driven, long-running); it has no HTTP ingress. Job health is
#     observed via execution state in Azure.
#   - tsx is a RUNTIME dep, so it lands in deps-prod and ships.
#   - Boot uses in-memory queue + InMemoryServiceBusAgentDispatcher;
#     SERVICE_BUS_CONNECTION_STRING or SERVICE_BUS_NAMESPACE env vars
#     at runtime swap the dispatcher to the real ServiceBusAgentDispatcher
#     (see services/orchestrator/src/mainConsumer.ts resolveDispatcher) per
#     ADR 0011 (per-role Service Bus fan-out). B7 swaps the input queue
#     behind the EventQueueConsumer interface as well.

# ---- deps-prod (runtime-only, --omit=dev) -------------------------------
FROM node:20-alpine AS deps-prod
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---- deps (full dep tree, for build typecheck) --------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---- build (typecheck only — no emit; tsx executes .ts at runtime) ------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npx tsc --noEmit

# ---- runtime ------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup --system --gid 1001 appgroup \
    && adduser --system --uid 1001 --ingroup appgroup --shell /sbin/nologin appuser

ENV NODE_ENV=production
# POLL_INTERVAL_MS, MAX_BATCH_SIZE, IDLE_EXIT_AFTER_EMPTY_POLLS env vars
# are validated + resolved at boot; defaults documented in mainConsumer.ts.
# SERVICE_BUS_CONNECTION_STRING (dev) or SERVICE_BUS_NAMESPACE (prod,
# managed-identity via DefaultAzureCredential) switches the dispatcher
# from in-memory to the real ServiceBusAgentDispatcher per ADR 0011
# (per-role fan-out onto agent-runs-<role> queues).

COPY --from=deps-prod --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json package-lock.json tsconfig.json ./
COPY --chown=appuser:appgroup src ./src

USER appuser

CMD ["npx", "tsx", "src/mainConsumer.ts"]
