# Experimental Azure-era recipe; not a supported local quickstart.
# Spec: docs/design/azure-adapter.md (ca-webhook Container App).
# Invariants:
#   - Four stages (deps-prod / deps / build / runtime); runtime is node:20-alpine.
#   - Runtime image installs ONLY production deps via `npm ci --omit=dev`.
#     Vitest, TypeScript, Biome ship in `deps` only (for typecheck) and never
#     reach the runtime image.
#   - Non-root user (`appuser`, uid 1001); listens on port 8080.
#   - tsx is a RUNTIME dep (not dev), so it lands in deps-prod and ships.
#   - HEALTHCHECK probes /admin/health using the runtime PORT (override-aware).
#   - GITHUB_WEBHOOK_SECRET MUST be bound at runtime (Key Vault `secretRef`).

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

ENV NODE_ENV=production \
    PORT=8080 \
    BIND_HOST=0.0.0.0
# BIND_HOST is service-specific. Docker/K8s/Container Apps inject HOSTNAME
# as the container/replica name; reading that for the listener bind would
# either fail or break the loopback healthcheck below.

COPY --from=deps-prod --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json package-lock.json tsconfig.json ./
COPY --chown=appuser:appgroup src ./src

USER appuser
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT:-8080}/admin/health" || exit 1

CMD ["npx", "tsx", "src/mainWebhook.ts"]
