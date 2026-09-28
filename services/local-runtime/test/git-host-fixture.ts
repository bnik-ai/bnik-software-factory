import { createHash } from 'node:crypto';
import type { GitHost, PullSummary, TreeEntryInput } from '../src/autonomy/publisher.js';
import { AutonomyError } from '../src/autonomy/schema.js';

/**
 * In-memory GitHub Git Data host with real Git object hashing, so a tree it
 * builds has the same SHA a real repository would compute. That makes the
 * publisher's tested-tree equivalence check meaningful without a network.
 */
type Mode = '100644' | '100755' | '120000' | '160000' | '40000';
interface Entry {
  mode: Mode;
  sha: string;
}
const sha1 = (type: string, body: Buffer) =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]))
    .digest('hex');
export function blobSha(content: Buffer): string {
  return sha1('blob', content);
}
/** Git sorts tree entries by name, with directories compared as if suffixed by "/". */
function treeSha(entries: Map<string, Entry>): string {
  const sorted = [...entries.entries()].sort(([leftName, left], [rightName, right]) => {
    const a = left.mode === '40000' ? `${leftName}/` : leftName;
    const b = right.mode === '40000' ? `${rightName}/` : rightName;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return sha1(
    'tree',
    Buffer.concat(
      sorted.map(([name, entry]) =>
        Buffer.concat([Buffer.from(`${entry.mode} ${name}\0`), Buffer.from(entry.sha, 'hex')]),
      ),
    ),
  );
}
interface FlatTree {
  [path: string]: { mode: Exclude<Mode, '40000'>; sha: string };
}
export class FixtureGitHost implements GitHost {
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, Map<string, Entry>>();
  readonly commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  readonly refs = new Map<string, string>();
  readonly pulls: (PullSummary & {
    title: string;
    body: string;
    head: string;
    base: string;
    state: 'open';
  })[] = [];
  readonly baseCommit: string;
  readonly baseTree: string;
  calls: string[] = [];
  constructor(
    readonly writeRepository: { fullName: string; id: number },
    readonly baseRepository: { fullName: string; id: number },
    files: Record<string, { content: Buffer; mode?: '100644' | '100755' | '120000' }>,
    readonly defaultBranch = 'main',
  ) {
    const flat: FlatTree = {};
    for (const [path, file] of Object.entries(files)) {
      const sha = blobSha(file.content);
      this.blobs.set(sha, file.content);
      flat[path] = { mode: file.mode ?? '100644', sha };
    }
    this.baseTree = this.store(flat);
    this.baseCommit = this.commit(this.baseTree, [], 'Base');
    this.refs.set(defaultBranch, this.baseCommit);
  }
  private commitSerial = 0;
  /** Like Git, each created commit carries a committer timestamp: identical content twice gives two SHAs. */
  private commit(tree: string, parents: string[], message: string): string {
    const sha = sha1(
      'commit',
      Buffer.from(
        `tree ${tree}\n${parents.map((parent) => `parent ${parent}\n`).join('')}committer fixture <fixture@example.invalid> ${++this.commitSerial} +0000\n\n${message}`,
      ),
    );
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }
  /** Stores nested trees for a flat path map and returns the root tree SHA. */
  private store(flat: FlatTree): string {
    const root = new Map<string, Entry>();
    const directories = new Map<string, FlatTree>();
    for (const [path, entry] of Object.entries(flat)) {
      const slash = path.indexOf('/');
      if (slash === -1) root.set(path, entry);
      else {
        const directory = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        directories.set(directory, { ...(directories.get(directory) ?? {}), [rest]: entry });
      }
    }
    for (const [name, children] of directories)
      root.set(name, { mode: '40000', sha: this.store(children) });
    const sha = treeSha(root);
    this.trees.set(sha, root);
    return sha;
  }
  private flatten(tree: string, prefix = ''): FlatTree {
    const entries = this.trees.get(tree);
    if (!entries) throw new Error('fixture_tree_missing');
    const flat: FlatTree = {};
    for (const [name, entry] of entries) {
      if (entry.mode === '40000') Object.assign(flat, this.flatten(entry.sha, `${prefix}${name}/`));
      else flat[`${prefix}${name}`] = { mode: entry.mode, sha: entry.sha };
    }
    return flat;
  }
  async createBlob(content: Buffer): Promise<string> {
    this.calls.push('createBlob');
    const sha = blobSha(content);
    this.blobs.set(sha, content);
    return sha;
  }
  async createTree(baseTree: string, entries: TreeEntryInput[]): Promise<string> {
    this.calls.push('createTree');
    const flat = this.flatten(baseTree);
    for (const entry of entries) {
      if (entry.sha === null) delete flat[entry.path];
      else {
        if (!this.blobs.has(entry.sha)) throw new Error('fixture_blob_missing');
        flat[entry.path] = { mode: entry.mode, sha: entry.sha };
      }
    }
    return this.store(flat);
  }
  async createCommit(tree: string, parents: string[], message: string): Promise<string> {
    this.calls.push('createCommit');
    if (!this.trees.has(tree)) throw new Error('fixture_tree_missing');
    return this.commit(tree, parents, message);
  }
  async getCommit(sha: string) {
    const commit = this.commits.get(sha);
    if (!commit) throw new Error('fixture_commit_missing');
    return { sha, tree: commit.tree, parents: commit.parents };
  }
  async getRef(branch: string): Promise<string | null> {
    return this.refs.get(branch) ?? null;
  }
  async createRef(branch: string, sha: string): Promise<void> {
    this.calls.push('createRef');
    if (this.refs.has(branch)) throw new Error('fixture_ref_exists');
    this.refs.set(branch, sha);
    for (const pull of this.pulls) if (pull.head.endsWith(branch)) pull.headSha = sha;
  }
  async updateRef(branch: string, sha: string): Promise<void> {
    this.calls.push('updateRef');
    const current = this.refs.get(branch);
    if (current === undefined) throw new Error('fixture_ref_missing');
    // GitHub refuses non-fast-forward updates when force is false.
    const commit = this.commits.get(sha);
    if (!commit || !commit.parents.includes(current))
      throw new Error('fixture_ref_not_fast_forward');
    this.refs.set(branch, sha);
    for (const pull of this.pulls) if (pull.head.endsWith(branch)) pull.headSha = sha;
  }
  /** Like GitHub: an unqualified `head` filter is ignored and every open pull against the base comes back. */
  async findOpenPull(headLabel: string, base: string): Promise<PullSummary | null> {
    const candidates = this.pulls.filter(
      (pull) =>
        pull.base === base &&
        pull.state === 'open' &&
        (headLabel.includes(':') ? pull.head === headLabel : true),
    );
    if (candidates.length > 1) throw new AutonomyError('github_pull_ambiguous');
    const found = candidates[0];
    return found
      ? { number: found.number, nodeId: found.nodeId, id: found.id, headSha: found.headSha }
      : null;
  }
  async createPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullSummary> {
    this.calls.push('createPull');
    const branch = input.head.includes(':') ? (input.head.split(':')[1] as string) : input.head;
    const headSha = this.refs.get(branch);
    if (!headSha) throw new Error('fixture_head_missing');
    const number = this.pulls.length + 1;
    const pull = {
      number,
      nodeId: `PR_fixture_${number}`,
      id: 1000 + number,
      headSha,
      ...input,
      state: 'open' as const,
    };
    this.pulls.push(pull);
    return { number, nodeId: pull.nodeId, id: pull.id, headSha };
  }
  async updatePull(number: number, input: { body: string }): Promise<void> {
    this.calls.push('updatePull');
    const pull = this.pulls.find((entry) => entry.number === number);
    if (!pull) throw new Error('fixture_pull_missing');
    pull.body = input.body;
  }
}
