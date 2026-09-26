import { createTokenProvider } from '../../agents/src/auth/installationToken.js';
import {
  AlwaysCurrentBranchSyncChecker,
  GithubCompareBranchSyncChecker,
} from '../../orchestrator/src/branchSyncChecker.js';
import {
  InMemorySubstrateClient as DemoOrchestratorSubstrate,
  GithubSubstrateClient,
} from '../../orchestrator/src/substrateClient.js';
import { createGithubSubstrateClient } from '../../validator/src/githubSubstrateClient.js';
import { InMemorySubstrateClient as DemoValidatorSubstrate } from '../../validator/src/substrateClient.js';
import type { RuntimeConfig } from './config.js';
import type { RuntimeDependencies } from './runtime.js';

function boundedFetch(signal: AbortSignal): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(10_000),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
}
export function runtimeDependencies(config: RuntimeConfig): RuntimeDependencies {
  if (config.mode === 'demo') {
    return {
      validatorSubstrate: (delivery) => {
        const substrate = new DemoValidatorSubstrate();
        const body = JSON.parse(delivery.payload);
        if (typeof body.issue?.node_id === 'string')
          substrate.setIssue(body.issue.node_id, {
            body: typeof body.issue.body === 'string' ? body.issue.body : '',
            labels: Array.isArray(body.issue.labels)
              ? body.issue.labels.map((label: { name: string }) => label.name)
              : [],
            authorLogin: body.issue.user?.login,
          });
        return substrate;
      },
      orchestratorSubstrate: () => ({
        substrate: new DemoOrchestratorSubstrate(),
        branchSyncChecker: new AlwaysCurrentBranchSyncChecker(),
      }),
    };
  }
  const env = {
    GITHUB_APP_ID: config.appId,
    GITHUB_APP_PRIVATE_KEY: config.appPrivateKey,
  };
  const [owner, repo] = config.repository.split('/') as [string, string];
  return {
    validatorSubstrate: (delivery, signal) => {
      if (
        delivery.repoFullName?.toLowerCase() !== config.repository.toLowerCase() ||
        delivery.installationId !== config.installationId
      )
        throw new Error('unconfigured_delivery');
      return createGithubSubstrateClient({
        env,
        installationId: config.installationId,
        fetch: boundedFetch(signal),
      });
    },
    orchestratorSubstrate: (signal) => {
      const fetch = boundedFetch(signal);
      const token = createTokenProvider(env, { fetch });
      const substrate = new GithubSubstrateClient({
        getToken: () => token(owner, repo),
        fetch,
      });
      return {
        substrate,
        branchSyncChecker: new GithubCompareBranchSyncChecker({
          substrateClient: substrate,
          owner,
          repo,
        }),
      };
    },
  };
}
