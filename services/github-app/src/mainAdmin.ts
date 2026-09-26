// Production entrypoint for the `ca-admin` Container App per
// docs/design/azure-adapter.md. Authentication is platform-level
// (Microsoft Entra ID via Container Apps Easy Auth); the app code
// itself enforces no auth and trusts that requests reaching it are
// already authenticated.

import { buildAdminApp } from './apps/adminApp.js';
import { type StartedServer, startHonoServer } from './serverHelpers.js';

export function startServer(): StartedServer {
  const app = buildAdminApp();
  return startHonoServer({ name: 'ca-admin', app });
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  startServer();
}
