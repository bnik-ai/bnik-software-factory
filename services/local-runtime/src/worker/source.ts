import { signAppJwt } from '../../../agents/src/auth/installationToken.js';
import { MAX_ARCHIVE_BYTES } from './protocol.js';
export interface SourceCredentials {
  repository: string;
  installationId: number;
  appId: string;
  appPrivateKey: string;
}
export async function githubArchive(
  config: SourceCredentials,
  commit: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Buffer> {
  if (
    !/^[0-9a-f]{40}$/.test(commit) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.repository) ||
    !Number.isSafeInteger(config.installationId) ||
    config.installationId < 1
  )
    throw new Error('invalid_source_identity');
  const base = 'https://api.github.com';
  const jwt = signAppJwt(config.appId, config.appPrivateKey);
  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'software-factory-source',
    'Content-Type': 'application/json',
  });
  let token: string | undefined;
  let output: Buffer | undefined;
  let failed = false;
  let revocationFailed = false;
  try {
    const minted = await request(
      `${base}/app/installations/${config.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: headers(jwt),
        body: JSON.stringify({
          repositories: [config.repository.split('/')[1]],
          permissions: { contents: 'read', metadata: 'read' },
        }),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      },
    );
    if (minted.status !== 201) throw new Error();
    const data = (await minted.json()) as {
      token?: string;
      repositories?: { full_name: string }[];
      permissions?: Record<string, string>;
      expires_at?: string;
    };
    token = data.token;
    const expiry = Date.parse(data.expires_at ?? '');
    if (
      !token ||
      !Array.isArray(data.repositories) ||
      data.repositories.length !== 1 ||
      data.repositories[0]?.full_name.toLowerCase() !== config.repository.toLowerCase() ||
      data.permissions?.contents !== 'read' ||
      Object.entries(data.permissions ?? {}).some(
        ([key, value]) => !['contents', 'metadata'].includes(key) || value !== 'read',
      ) ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 3_660_000
    )
      throw new Error();
    const pinned = await request(`${base}/repos/${config.repository}/git/commits/${commit}`, {
      headers: headers(token),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (pinned.status !== 200 || ((await pinned.json()) as { sha?: string }).sha !== commit)
      throw new Error();
    let archive = await request(`${base}/repos/${config.repository}/tarball/${commit}`, {
      headers: headers(token),
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (archive.status === 302) {
      const url = new URL(archive.headers.get('location') ?? '');
      if (
        url.origin !== 'https://codeload.github.com' ||
        url.username ||
        url.password ||
        url.pathname.toLowerCase() !== `/${config.repository.toLowerCase()}/legacy.tar.gz/${commit}`
      )
        throw new Error();
      archive = await request(url, {
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    }
    if (archive.status !== 200 || !archive.body) throw new Error();
    let result = Buffer.alloc(0);
    for await (const chunk of archive.body) {
      if (result.length + chunk.length > MAX_ARCHIVE_BYTES) throw new Error();
      result = Buffer.concat([result, chunk]);
    }
    output = result;
  } catch {
    failed = true;
  } finally {
    if (token) {
      try {
        const revoked = await request(`${base}/installation/token`, {
          method: 'DELETE',
          headers: headers(token),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (revoked.status !== 204) revocationFailed = true;
      } catch {
        revocationFailed = true;
      }
    }
  }
  if (revocationFailed) throw new Error('repository_token_revocation_failed');
  if (failed || !output) throw new Error('repository_source_preparation_failed');
  return output;
}
