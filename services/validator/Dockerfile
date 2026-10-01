# Experimental Azure-era recipe; not a supported local quickstart.
# Spec: docs/design/azure-adapter.md (caj-validator Container Apps Job).
# Invariants:
#   - 4-stage build (deps-prod / deps / build / runtime) on node:20-alpine.
#   - Runtime image installs ONLY production deps (`npm ci --omit=dev`).
#     Vitest, TypeScript, Biome ship in `deps` for typecheck only.
#   - Non-root user (`appuser`, uid 1001).
#   - tsx is a RUNTIME dep, so it lands in deps-prod and ships.
#   - No HEALTHCHECK: this is a Container Apps JOB (event-driven, long-running);
#     it has no HTTP ingress to probe. Job health is observed via execution
#     state in Azure.
#   - No EXPOSE: Container Apps Jobs receive no inbound network.
#   - Boot wires in-memory deps unless Service Bus / Postgres env is set;
#     with it, the Service Bus + Postgres impls sit behind the
#     EventQueueConsumer / AuditLedgerWriter interfaces.

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
# POLL_INTERVAL_MS (default 1000, range [50, 60000]) and
# MAX_BATCH_SIZE (default 10, range [1, 256]) are optional overrides;
# the entrypoint resolves them at startup.

COPY --from=deps-prod --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json package-lock.json tsconfig.json ./
COPY --chown=appuser:appgroup src ./src

USER appuser

CMD ["npx", "tsx", "src/mainConsumer.ts"]
