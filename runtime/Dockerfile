# Node 24.21.0, multi-platform manifest pinned from the official Node image.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY services/github-app/package*.json services/github-app/
COPY services/validator/package*.json services/validator/
COPY services/orchestrator/package*.json services/orchestrator/
COPY services/local-runtime/package*.json services/local-runtime/
RUN for service in github-app validator orchestrator local-runtime; do \
      npm ci --prefix services/$service --ignore-scripts --no-audit --no-fund || exit 1; \
    done
COPY services /app/services
COPY runtime /app/runtime
COPY LICENSE NOTICE THIRD_PARTY.md PROVENANCE.md /app/
# No Agent SDK/runtime installation or model-executed shell in this image.
# Normalize image-owned source modes even when the host checkout uses umask 077.
# Host files and separately mounted secrets are not changed.
RUN chmod -R a+rX /app
ENV NODE_ENV=production TSX_DISABLE_CACHE=1
USER node
WORKDIR /app/services/local-runtime
CMD ["node", "--import", "tsx", "src/main.ts", "serve"]
