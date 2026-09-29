/**
 * What the collector's repository snapshot for the reviewer never includes, by directory name at
 * any depth; the reviewer's heading names the same rule. No imports: ships in the worker image.
 */
export const SNAPSHOT_EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  '.factory',
  'vendor',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  '.cache',
  'target',
] as const;
export const SNAPSHOT_EXCLUSION_RULE = `directories named ${SNAPSHOT_EXCLUDED_DIRECTORIES.join(', ')} at any depth and the policy's protected paths are never included; secret-shaped or oversized files are omitted by name`;
