// Substrate-scope GitHub App auth builder for the ca-terraform Container App.
//
// Statically imports ONLY substrateClient.ts (never agentClient.ts) so the
// ca-terraform bundle/module-graph carries the substrate-write permission set
// and nothing wider — preserving the static-import isolation documented in
// substrateClient.ts / agentClient.ts. Shared scope-agnostic primitives come
// from githubAppAuthBase.ts, which imports neither factory.
//
// SECURITY: never logs the PEM or any minted token (see githubAppAuthBase.ts).

import { type GitHubAppAuthOverrides, buildGitHubAppAuthBase } from './githubAppAuthBase.js';
import { type SubstrateClient, buildSubstrateClient } from './substrateClient.js';

export { GITHUB_APP_ID_ENV, GITHUB_APP_PRIVATE_KEY_ENV } from './githubAppAuthBase.js';
export type { GitHubAppAuthOverrides } from './githubAppAuthBase.js';

export interface SubstrateDeps {
  substrateClient: SubstrateClient;
}

export function buildSubstrateDeps(overrides: GitHubAppAuthOverrides = {}): SubstrateDeps {
  const { cache, signJwt, mint } = buildGitHubAppAuthBase(overrides);
  return { substrateClient: buildSubstrateClient({ cache, signJwt, mint }) };
}
