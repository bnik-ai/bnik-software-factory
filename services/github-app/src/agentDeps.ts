// Agent-scope GitHub App auth builder for the ca-agent Container App.
//
// Statically imports ONLY agentClient.ts (never substrateClient.ts) so the
// ca-agent bundle/module-graph carries the agent-write permission set and
// nothing wider — preserving the static-import isolation documented in
// agentClient.ts / substrateClient.ts. Shared scope-agnostic primitives come
// from githubAppAuthBase.ts, which imports neither factory.
//
// SECURITY: never logs the PEM or any minted token (see githubAppAuthBase.ts).

import { type AgentClient, buildAgentClient } from './agentClient.js';
import { type GitHubAppAuthOverrides, buildGitHubAppAuthBase } from './githubAppAuthBase.js';

export { GITHUB_APP_ID_ENV, GITHUB_APP_PRIVATE_KEY_ENV } from './githubAppAuthBase.js';
export type { GitHubAppAuthOverrides } from './githubAppAuthBase.js';

export interface AgentDeps {
  agentClient: AgentClient;
}

export function buildAgentDeps(overrides: GitHubAppAuthOverrides = {}): AgentDeps {
  const { cache, signJwt, mint } = buildGitHubAppAuthBase(overrides);
  return { agentClient: buildAgentClient({ cache, signJwt, mint }) };
}
