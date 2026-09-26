// Production entrypoint for the `ca-agent` Container App per
// docs/design/azure-adapter.md.

import { GITHUB_APP_ID_ENV, buildAgentDeps } from './agentDeps.js';
import { buildAgentApp, readAgentHmacSecretFromEnv } from './apps/agentApp.js';
import { type StartedServer, startHonoServer } from './serverHelpers.js';

// Builds the GitHub App agent-scoped client when GITHUB_APP_ID is set; logs
// whether outgoing auth is live (never logs the PEM or any token). Returns
// undefined for v0 boot / tests with no GitHub App env, keeping the in-memory
// HMAC-only path working. Imports only agentDeps (agent scope) so ca-agent
// never pulls in the substrate token-minting path.
function resolveAgentClientFromEnv(): ReturnType<typeof buildAgentDeps>['agentClient'] | undefined {
  if (process.env[GITHUB_APP_ID_ENV]) {
    const deps = buildAgentDeps();
    console.log(
      '[ca-agent] github-app outgoing auth: live (JWT signing + installation-token cache)',
    );
    return deps.agentClient;
  }
  console.log('[ca-agent] github-app outgoing auth: disabled (GITHUB_APP_ID unset)');
  return undefined;
}

export function startServer(): StartedServer {
  const agentHmacSecret = readAgentHmacSecretFromEnv();
  const agentClient = resolveAgentClientFromEnv();
  const app = buildAgentApp({ agentHmacSecret, agentClient });
  return startHonoServer({ name: 'ca-agent', app });
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startServer();
}
