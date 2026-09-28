/**
 * Pure npm lockfile (v2/v3) and package.json analysis shared by the resolution
 * sandbox and its host-side tests. No I/O.
 */
export interface LockedPackage {
  name: string;
  version: string;
  resolved: string | null;
  license: string | null;
  hasInstallScript: boolean;
  link: boolean;
}
export type PackageSource = 'registry' | 'git' | 'url' | 'file' | 'link' | 'workspace';
export interface PackageDelta {
  ecosystem: 'npm';
  name: string;
  version: string;
  previousVersion: string | null;
  license: string | null;
  major: boolean;
  direction: 'upgrade' | 'downgrade' | null;
  source: PackageSource;
}
const NUMERIC_PREFIX = /^v?(\d+(?:\.\d+)*)/;
function numeric(version: string): number[] | null {
  const match = NUMERIC_PREFIX.exec(version);
  return match ? (match[1] as string).split('.').map(Number) : null;
}
function compare(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
/** Semver break, with 0.x minors counted as breaking. */
export function isMajorChange(previous: string, next: string): boolean {
  const before = numeric(previous);
  const after = numeric(next);
  if (before === null || after === null) return true;
  if (before[0] !== after[0]) return true;
  return before[0] === 0 && (before[1] ?? 0) !== (after[1] ?? 0);
}
export function sourceOf(entry: LockedPackage, workspaces: readonly string[]): PackageSource {
  if (entry.link) return workspaces.length ? 'workspace' : 'link';
  const resolved = entry.resolved ?? '';
  if (resolved === '') return 'registry';
  if (resolved.startsWith('git+') || resolved.startsWith('git:')) return 'git';
  if (resolved.startsWith('file:')) return 'file';
  if (/^https?:\/\/registry\.npmjs\.org\//.test(resolved)) return 'registry';
  if (/^https?:\/\//.test(resolved)) return 'url';
  return 'url';
}
/** Packages under node_modules, keyed by the lockfile path ("node_modules/a/node_modules/b"). */
export function parseLockfile(text: string): {
  packages: Map<string, LockedPackage>;
  workspaces: string[];
} {
  const parsed = JSON.parse(text) as {
    lockfileVersion?: number;
    packages?: Record<string, Record<string, unknown>>;
  };
  if (parsed.lockfileVersion !== 2 && parsed.lockfileVersion !== 3)
    throw new Error('lockfile_version_unsupported');
  if (!parsed.packages || typeof parsed.packages !== 'object')
    throw new Error('lockfile_packages_missing');
  const packages = new Map<string, LockedPackage>();
  const workspaces: string[] = [];
  for (const [key, value] of Object.entries(parsed.packages)) {
    if (key === '') continue;
    if (!key.includes('node_modules/')) {
      workspaces.push(key);
      continue;
    }
    const name =
      typeof value.name === 'string' ? value.name : (key.split('node_modules/').pop() as string);
    packages.set(key, {
      name,
      version: typeof value.version === 'string' ? value.version : 'unknown',
      resolved: typeof value.resolved === 'string' ? value.resolved : null,
      license: typeof value.license === 'string' ? value.license : null,
      hasInstallScript: value.hasInstallScript === true,
      link: value.link === true,
    });
  }
  return { packages, workspaces };
}
/**
 * Compares two lockfiles by package name (the first occurrence wins when a name is
 * nested several times). A name present on both sides with a different version is an
 * upgrade or downgrade; the runner reports one story per package.
 */
export function diffLockfiles(
  before: string | null,
  after: string,
): {
  added: PackageDelta[];
  removed: PackageDelta[];
  upgraded: PackageDelta[];
  installScriptsChanged: boolean;
} {
  const previous =
    before === null
      ? { packages: new Map<string, LockedPackage>(), workspaces: [] }
      : parseLockfile(before);
  const current = parseLockfile(after);
  const byName = (packages: Map<string, LockedPackage>) => {
    const map = new Map<string, LockedPackage>();
    for (const entry of packages.values()) if (!map.has(entry.name)) map.set(entry.name, entry);
    return map;
  };
  const oldByName = byName(previous.packages);
  const newByName = byName(current.packages);
  const delta = (
    entry: LockedPackage,
    previousEntry: LockedPackage | null,
    workspaces: string[],
  ): PackageDelta => {
    const previousVersion = previousEntry?.version ?? null;
    const order =
      previousVersion === null
        ? 0
        : (() => {
            const left = numeric(previousVersion);
            const right = numeric(entry.version);
            return left && right ? compare(left, right) : 0;
          })();
    return {
      ecosystem: 'npm',
      name: entry.name,
      version: entry.version,
      previousVersion,
      license: entry.license,
      major: previousVersion === null ? false : isMajorChange(previousVersion, entry.version),
      direction: previousVersion === null ? null : order <= 0 ? 'upgrade' : 'downgrade',
      source: sourceOf(entry, workspaces),
    };
  };
  const added: PackageDelta[] = [];
  const upgraded: PackageDelta[] = [];
  const removed: PackageDelta[] = [];
  for (const [name, entry] of newByName) {
    const previousEntry = oldByName.get(name);
    if (!previousEntry) added.push(delta(entry, null, current.workspaces));
    else if (previousEntry.version !== entry.version)
      upgraded.push(delta(entry, previousEntry, current.workspaces));
  }
  for (const [name, entry] of oldByName)
    if (!newByName.has(name))
      removed.push({
        ...delta(entry, null, previous.workspaces),
        source: sourceOf(entry, previous.workspaces),
      });
  const scripted = (map: Map<string, LockedPackage>) =>
    [...map.values()]
      .filter((entry) => entry.hasInstallScript)
      .map((entry) => `${entry.name}@${entry.version}`)
      .sort();
  const installScriptsChanged =
    JSON.stringify(scripted(oldByName)) !== JSON.stringify(scripted(newByName));
  return { added, removed, upgraded, installScriptsChanged };
}
const DEPENDENCY_FIELDS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
]);
/** Top-level package.json fields outside dependency specifications that changed. */
export function manifestFieldsChanged(before: string | null, after: string): string[] {
  const previous = before === null ? {} : (JSON.parse(before) as Record<string, unknown>);
  const current = JSON.parse(after) as Record<string, unknown>;
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (DEPENDENCY_FIELDS.has(key)) continue;
    if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) changed.add(key);
  }
  return [...changed].sort();
}
