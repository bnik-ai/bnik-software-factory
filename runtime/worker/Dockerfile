# Local build only; vendor and OS redistribution review is a separate release gate.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends bash git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/agents/package*.json services/agents/
COPY services/local-runtime/package*.json services/local-runtime/
RUN npm ci --prefix services/agents --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm ci --prefix services/local-runtime --omit=dev --ignore-scripts --no-audit --no-fund
COPY services/agents/src/runtime/codingAgent.ts services/agents/src/runtime/codingAgent.ts
COPY services/local-runtime/src/worker services/local-runtime/src/worker
COPY services/local-runtime/test/worker-proxy-fixture.ts services/local-runtime/test/worker-proxy-fixture.ts
COPY runtime/worker/extract.py runtime/worker/extract.py
COPY THIRD_PARTY.md PROVENANCE.md /app/
RUN mkdir -p /run/egress /workspace && chown node:node /run/egress /workspace
# Normalize image-owned source modes even when the host checkout uses umask 077.
# Host files and separately mounted secrets are not changed.
RUN chmod -R a+rX /app
ENV NODE_ENV=production TSX_DISABLE_CACHE=1
USER 1000:1000
WORKDIR /app/services/local-runtime
CMD ["node", "--import", "tsx", "src/worker/entry.ts"]
