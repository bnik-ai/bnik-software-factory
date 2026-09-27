# Source builds only. The trusted supervisor has Docker daemon authority.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends python3 docker.io git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/github-app/package*.json services/github-app/
COPY services/validator/package*.json services/validator/
COPY services/orchestrator/package*.json services/orchestrator/
COPY services/agents/package*.json services/agents/
COPY services/local-runtime/package*.json services/local-runtime/
RUN for service in github-app validator orchestrator agents local-runtime; do \
      npm ci --prefix services/$service --omit=dev --ignore-scripts --no-audit --no-fund || exit 1; \
    done
COPY services /app/services
COPY runtime /app/runtime
COPY examples /app/examples
COPY LICENSE THIRD_PARTY.md PROVENANCE.md /app/
ENV NODE_ENV=production TSX_DISABLE_CACHE=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
USER node
WORKDIR /artifacts
ENTRYPOINT ["python3", "/app/runtime/operator/main.py"]
