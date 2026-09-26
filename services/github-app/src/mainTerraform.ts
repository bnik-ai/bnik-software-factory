// Production entrypoint for the `ca-terraform` Container App per
// docs/design/azure-adapter.md.

import { buildTerraformApp, readTerraformHmacSecretFromEnv } from './apps/terraformApp.js';
import { type StartedServer, startHonoServer } from './serverHelpers.js';
import { GITHUB_APP_ID_ENV, buildSubstrateDeps } from './substrateDeps.js';

// Builds the GitHub App substrate-scoped client when GITHUB_APP_ID is set;
// logs whether outgoing auth is live (never logs the PEM or any token).
// Returns undefined for v0 boot / tests with no GitHub App env. Imports only
// substrateDeps (substrate scope) so ca-terraform never pulls in the agent
// token-minting path.
function resolveSubstrateClientFromEnv():
  | ReturnType<typeof buildSubstrateDeps>['substrateClient']
  | undefined {
  if (process.env[GITHUB_APP_ID_ENV]) {
    const deps = buildSubstrateDeps();
    console.log(
      '[ca-terraform] github-app outgoing auth: live (JWT signing + installation-token cache)',
    );
    return deps.substrateClient;
  }
  console.log('[ca-terraform] github-app outgoing auth: disabled (GITHUB_APP_ID unset)');
  return undefined;
}

export function startServer(): StartedServer {
  const terraformHmacSecret = readTerraformHmacSecretFromEnv();
  const substrateClient = resolveSubstrateClientFromEnv();
  const app = buildTerraformApp({ terraformHmacSecret, substrateClient });
  return startHonoServer({ name: 'ca-terraform', app });
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startServer();
}
