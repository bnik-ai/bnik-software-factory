import { generateKeyPairSync } from 'node:crypto';
import type { RuntimeConfig } from '../src/config.js';
import { resolveConfig } from '../src/config.js';
import { activationCommand, taskSnapshot } from '../src/github/activation.js';
import type { Comment, GitHubReads, Issue, Repository } from '../src/github/client.js';
export const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
export const liveEnv = () => ({
  FACTORY_MODE: 'live',
  FACTORY_REPOSITORY: 'example/factory-demo',
  FACTORY_REPOSITORY_ID: '42',
  GITHUB_INSTALLATION_ID: '7',
  GITHUB_APP_ID: '8',
  GITHUB_APP_SLUG: 'factory-fixture',
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: 'synthetic-webhook-key-000000000000000',
  FACTORY_WEBHOOK_URL: 'https://factory.example.com/webhook',
  FACTORY_OPERATORS: 'example-maintainer',
  FACTORY_EXECUTION: 'disabled',
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_TLS: 'disable',
  POSTGRES_DATABASE: 'software_factory',
  POSTGRES_USER: 'factory_runtime',
  POSTGRES_PASSWORD: 'synthetic-database-key',
});
export const liveConfig = () => resolveConfig(liveEnv());
export const commit = 'a'.repeat(40);
export const repository: Repository = {
  id: 42,
  full_name: 'example/factory-demo',
  default_branch: 'main',
  archived: false,
  disabled: false,
};
export const task = (): Issue => ({
  id: 10,
  node_id: 'I_FIXTURE',
  number: 1,
  title: 'Synthetic arithmetic change',
  body: `\`\`\`factory-task\n${JSON.stringify({ prompt: 'Fix arithmetic and verify it.', model: 'claude-fixture', tests: ['node --test'], maxTurns: 2, timeoutMs: 30_000 })}\n\`\`\``,
  state: 'open',
  locked: false,
  labels: [{ name: 'kind:task' }, { name: 'status:proposed' }],
});
export function event(config: RuntimeConfig = liveConfig()) {
  const issue = task();
  const timestamp = new Date().toISOString();
  const user = { id: 55, login: 'example-maintainer', type: 'User' };
  const comment: Comment = {
    id: 66,
    body: activationCommand(commit, taskSnapshot(config, issue, commit).taskHash),
    created_at: timestamp,
    updated_at: timestamp,
    user,
  };
  return { action: 'created', sender: user, installation: { id: 7 }, repository, issue, comment };
}
export class FixtureGitHub implements GitHubReads {
  current = event();
  permission = 'write';
  currentHead = commit;
  reads: string[] = [];
  async check() {
    return {
      appId: 8,
      installationId: 7,
      repository,
      webhookUrl: 'https://factory.example.com/webhook',
    };
  }
  async read<T>(path: string): Promise<T> {
    this.reads.push(path);
    if (path.includes('/collaborators/'))
      return { permission: this.permission, user: this.current.sender } as T;
    if (path.includes('/issues/comments/')) return this.current.comment as T;
    if (path.endsWith('/issues/1')) return this.current.issue as T;
    if (path.includes('/commits/')) return { sha: this.currentHead } as T;
    throw new Error('unexpected_fixture_read');
  }
}
