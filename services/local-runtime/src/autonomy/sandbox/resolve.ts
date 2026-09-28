import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAX_ARCHIVE_BYTES } from '../../worker/protocol.js';
import {
  REPOSITORY,
  checked,
  exec,
  fail,
  git,
  isolateEnvironment,
  prepareRepository,
  readInput,
} from './common.js';
import { diffLockfiles, manifestFieldsChanged } from './npm-lockfile.js';

/**
 * Dependency resolution sandbox (npm only). Rebuilds the candidate tree, then for
 * each listed npm project re-resolves the lockfile from package.json with install
 * scripts disabled and compares it byte for byte with the committed one. Package
 * deltas, manifest field changes and install-script changes are computed from the
 * base and candidate lockfiles. This is the one sandbox with network access. The
 * network is the Docker bridge, so the boundary is enforced here, not by the network:
 * a manifest, lockfile or .npmrc that could send npm anywhere but the public registry is
 * refused before npm runs, and nothing here executes candidate code.
 */
const REGISTRY = 'https://registry.npmjs.org/';
/** Version ranges, dist-tags and `npm:` aliases resolve at the registry; everything else does not. */
const REGISTRY_SPEC = /^(npm:(@[^\s/@]+\/)?[^\s/@]+@)?[\s~^<>=|*xX0-9A-Za-z.+-]*$/;
function offRegistry(manifest: string, lockfile: string): boolean {
  let parsedManifest: Record<string, unknown>;
  let parsedLock: unknown;
  try {
    parsedManifest = JSON.parse(manifest) as Record<string, unknown>;
    parsedLock = JSON.parse(lockfile);
  } catch {
    return true;
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'overrides',
    'resolutions',
  ]) {
    const specs = parsedManifest[field];
    if (specs === undefined) continue;
    if (specs === null || typeof specs !== 'object') return true;
    const stack: unknown[] = [specs];
    while (stack.length > 0) {
      const entry = stack.pop();
      if (typeof entry === 'string') {
        if (!REGISTRY_SPEC.test(entry)) return true;
      } else if (entry !== null && typeof entry === 'object') stack.push(...Object.values(entry));
      else return true;
    }
  }
  if (parsedManifest.workspaces !== undefined || parsedManifest.bundleDependencies !== undefined)
    return true;
  const stack: unknown[] = [parsedLock];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.link === true) return true;
    if (typeof record.resolved === 'string' && !record.resolved.startsWith(REGISTRY)) return true;
    if (typeof record.version === 'string' && /^(file:|git\+|https?:|github:)/.test(record.version))
      return true;
    stack.push(...Object.values(record));
  }
  return false;
}
interface Input {
  archive: string;
  patch: string;
  expectedTree: string;
  /** Repository paths of package.json and package-lock.json files to verify. */
  manifests: string[];
}
async function main() {
  if (process.getuid?.() !== 1000) fail('sandbox_requires_non_root_uid');
  const input = await readInput<Input>(MAX_ARCHIVE_BYTES * 3);
  const env = {
    ...isolateEnvironment(),
    npm_config_cache: '/tmp/npm-cache',
    npm_config_update_notifier: 'false',
  };
  const signal = AbortSignal.timeout(1_500_000);
  const started = Date.now();
  const prepared = await prepareRepository(
    Buffer.from(input.archive, 'base64'),
    input.patch,
    env,
    signal,
  );
  if ('reason' in prepared) fail(prepared.reason);
  if (prepared.candidateTree !== input.expectedTree) fail('tree_mismatch');
  const run = git(env, signal);
  const directories = new Set<string>();
  const unsupported: string[] = [];
  for (const path of input.manifests) {
    const name = path.split('/').pop();
    if (name === 'package.json' || name === 'package-lock.json') directories.add(dirname(path));
    else unsupported.push(path);
  }
  if (unsupported.length > 0 || directories.size === 0) {
    process.stdout.write(
      `${JSON.stringify({ version: 1, ok: true, status: 'unsupported', unsupported, elapsedMs: Date.now() - started })}\n`,
    );
    return;
  }
  const baseFile = async (path: string): Promise<string | null> => {
    const result = await exec('git', ['show', `${prepared.base}:${path}`], {
      env,
      signal,
      cwd: REPOSITORY,
    });
    return result.code === 0 ? result.stdout.toString('utf8') : null;
  };
  let resolution: 'reproduced' | 'mismatch' = 'reproduced';
  const fields = new Set<string>();
  let installScriptsChanged = false;
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const upgraded: unknown[] = [];
  const lockfiles: { path: string; content: string }[] = [];
  for (const directory of [...directories].sort()) {
    const prefix = directory === '.' ? '' : `${directory}/`;
    const projectDir = join(REPOSITORY, directory);
    const lockPath = join(projectDir, 'package-lock.json');
    let committedLock: string;
    try {
      committedLock = await readFile(lockPath, 'utf8');
    } catch {
      fail('lockfile_missing');
    }
    const committedManifest = await readFile(join(projectDir, 'package.json'), 'utf8');
    // Nothing leaves this sandbox before the sources are known to be the public registry.
    for (const rc of [
      join(projectDir, '.npmrc'),
      join(REPOSITORY, '.npmrc'),
      join(REPOSITORY, '.yarnrc'),
      join(REPOSITORY, '.yarnrc.yml'),
    ])
      if (
        await stat(rc).then(
          () => true,
          () => false,
        )
      )
        fail('non_registry_source');
    if (offRegistry(committedManifest, committedLock)) fail('non_registry_source');
    // Re-resolve from the manifest alone; the committed lockfile must come back identical.
    await rm(lockPath, { force: true });
    const install = await exec(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-bin-links',
      ],
      { env, signal, cwd: projectDir, limit: 4 * 1024 * 1024 },
    );
    if (install.code !== 0) fail('resolution_failed');
    const regenerated = await readFile(lockPath, 'utf8');
    if (regenerated !== committedLock) resolution = 'mismatch';
    lockfiles.push({ path: `${prefix}package-lock.json`, content: committedLock });
    const baseLock = await baseFile(`${prefix}package-lock.json`);
    const baseManifest = await baseFile(`${prefix}package.json`);
    let deltas: ReturnType<typeof diffLockfiles>;
    try {
      deltas = diffLockfiles(baseLock, committedLock);
      for (const field of manifestFieldsChanged(baseManifest, committedManifest))
        fields.add(`${prefix}package.json:${field}`);
    } catch {
      fail('lockfile_unparseable');
    }
    added.push(...deltas.added);
    removed.push(...deltas.removed);
    upgraded.push(...deltas.upgraded);
    installScriptsChanged ||= deltas.installScriptsChanged;
  }
  // Keep the workspace a data-only result; nothing from node_modules is executed or kept.
  await checked('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--', '.'], {
    env,
    signal,
    cwd: REPOSITORY,
  }).catch(() => undefined);
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      ok: true,
      status: 'complete',
      tree: prepared.candidateTree,
      manifests: input.manifests,
      resolution,
      manifestFieldsChanged: [...fields].sort(),
      installScriptsChanged,
      packages: { added, removed, upgraded },
      lockfiles,
      elapsedMs: Date.now() - started,
    })}\n`,
  );
}
main().catch(() => fail('resolve_failed'));
