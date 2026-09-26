# Experimental Azure-era recipe; not a supported local quickstart.
# Spec: docs/decisions/0011-agent-dispatch-topology.md (per-role
# `caj-agent-{spec,design,build,review}` Container Apps Jobs) +
# docs/design/azure-adapter.md (Container Apps Job runtime shape).
# Invariants:
#   - 4-stage build (deps-prod / deps / build / runtime) on node:20-alpine.
#     Mirrors services/validator/Dockerfile so the two runtime images stay
#     symmetric.
#   - Runtime image installs ONLY production deps (`npm ci --omit=dev`).
#     Vitest, TypeScript, Biome ship in `deps` for typecheck only.
#   - Non-root user (`appuser`, uid 1001).
#   - tsx is a RUNTIME dep, so it lands in deps-prod and ships.
#   - git is installed in the runtime image: the coding "brain"
#     (src/runtime/codingAgent.ts → @anthropic-ai/claude-agent-sdk) drives
#     Bash tool calls, and the downstream GitTool layer (src/tools/, M1b)
#     clones/commits/pushes — both need the git binary present.
#   - The Agent SDK bundles the claude-code runtime (npm install pulls ~100
#     packages); it is a regular `dependencies` entry, so `npm ci
#     --omit=dev` in deps-prod ships it into the runtime image.
#   - caj-agent-build CPU/mem are bumped at DEPLOY time (Container Apps Job
#     resources in VHQ infra), not here — the coding agent is heavier than
#     the other roles.
#   - No HEALTHCHECK: Container Apps Jobs have no HTTP ingress.
#   - No EXPOSE: Container Apps Jobs receive no inbound network.
#   - SINGLE IMAGE, MULTI-ROLE: one built artifact is deployed as each of
#     caj-agent-{spec,design,build,review}. The ENTRYPOINT_FILE build-arg
#     selects which mainAgent*.ts the CMD runs; the deploy workflow passes
#     `--build-arg ENTRYPOINT_FILE=mainAgentBuild.ts` (etc.) per role so the
#     four jobs share one rebuild path. v0 default is mainAgentSpec.ts so
#     the image runs SOMETHING if no build-arg is supplied (operator gets a
#     loud per-role queue-not-found error rather than a silent no-op).
#   - To switch roles per Job execution at runtime instead (without a
#     rebuild), an operator could also set CMD env in the Job spec; the
#     build-arg path is the v0 default because the deploy workflow's image
#     pinning + Container Apps Job revision model assumes the CMD is baked
#     into the image.

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

# Per-role entrypoint selector — see header. Default ships mainAgentSpec.ts
# so an unconfigured image still boots into a real consumer.
ARG ENTRYPOINT_FILE=mainAgentSpec.ts
ENV ENTRYPOINT_FILE=${ENTRYPOINT_FILE}

# git: required by the coding agent's Bash tool + the downstream GitTool
# clone/commit/push (see header).
RUN apk add --no-cache git

RUN addgroup --system --gid 1001 appgroup \
    && adduser --system --uid 1001 --ingroup appgroup --shell /sbin/nologin appuser

ENV NODE_ENV=production
# POLL_INTERVAL_MS (default 1000, range [50, 60000]),
# MAX_BATCH_SIZE (default 10, range [1, 256]),
# IDLE_EXIT_AFTER_EMPTY_POLLS (default 5, range [1, 60]),
# AGENT_QUEUE_NAME (overrides the per-entrypoint default),
# AGENT_DEFAULT_REPO (required for spec/design/build entrypoints),
# ANTHROPIC_MODEL (build entrypoint, default opus-4-7)
# are optional/required env overrides resolved at entrypoint startup.

COPY --from=deps-prod --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json package-lock.json tsconfig.json ./
COPY --chown=appuser:appgroup src ./src

USER appuser

# Resolve ENTRYPOINT_FILE via shell so the per-role build-arg picks up at
# CMD-eval time (the JSON-array exec form wouldn't expand env vars).
CMD ["sh", "-c", "exec npx tsx src/${ENTRYPOINT_FILE}"]
