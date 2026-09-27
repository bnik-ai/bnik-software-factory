import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

// Capture source bytes independently of Git's mutable index and ignore rules.
// This detects ordinary test side effects, not tamper-proof same-UID attestation.
export async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let bytes = 0;
  async function walk(relative: string) {
    for (const name of await readdir(join(root, relative))) {
      if (!relative && name === '.git') continue;
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(root, path);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        await walk(path);
      } else {
        if (files.size >= 4096) throw new Error('source_snapshot_entry_limit');
        if (stat.isSymbolicLink()) files.set(path, `link:${await readlink(absolute)}`);
        else if (stat.isFile()) {
          bytes += stat.size;
          if (bytes > 64 * 1024 * 1024) throw new Error('source_snapshot_byte_limit');
          files.set(
            path,
            `${stat.mode & 0o777}:${createHash('sha256')
              .update(await readFile(absolute))
              .digest('hex')}`,
          );
        } else throw new Error('source_snapshot_special_file');
      }
    }
  }
  await walk('');
  return files;
}
export function sourceChanges(before: Map<string, string>, after: Map<string, string>) {
  return {
    modifiedPaths: [...before]
      .filter(([path, hash]) => after.get(path) !== hash)
      .map(([path]) => path)
      .sort(),
    generatedPaths: [...after.keys()].filter((path) => !before.has(path)).sort(),
  };
}
