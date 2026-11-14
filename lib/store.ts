// The forge's state: every repository, its git objects and refs, and its issues, pull requests,
// labels and comments — all in memory, all deterministic.
//
// A repo is created through REST (never by a push). Its git history is the object map plus the
// ref map; its tracker state is the issue/pull arrays. Two counters live per repo: one shared
// issue+pull number counter (GitHub's behaviour) and one comment id counter.

import { Clock, VIEWER, viewerIdentity } from './util.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isDescendant,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export interface Repo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  ownerId: number;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  issueByNumber: Map<number, Issue>;
  pullByNumber: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Change {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldContent: string | null;
  newContent: string | null;
}

export interface StoreOptions {
  clock: Clock;
}

/** The whole forge, keyed by `owner/repo` (lowercase owner, exact repo name). */
export class Store {
  readonly clock: Clock;
  private repos = new Map<string, Repo>();
  private nextRepoId = 1;

  constructor(options: StoreOptions) {
    this.clock = options.clock;
  }

  private key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  listViewerRepos(): Repo[] {
    return this.listRepos().filter((repo) => repo.owner === VIEWER.login);
  }

  createRepo(name: string, options: { private?: boolean; description?: string }): Repo {
    const now = this.clock.nextIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      fullName: `${VIEWER.login}/${name}`,
      owner: VIEWER.login,
      ownerId: VIEWER.id,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueByNumber: new Map(),
      pullByNumber: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    for (const seed of [
      { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
      { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
      { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
      { name: 'question', color: 'd876e3', description: 'Further information is requested' },
      { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
      { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
    ]) {
      repo.labels.set(seed.name, { ...seed });
    }
    this.repos.set(this.key(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // -------------------------------------------------------------------------------------------
  // git helpers
  // -------------------------------------------------------------------------------------------

  objectLookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The commit a ref points at (tags peeled), or null when it points at nothing usable. */
  refCommit(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    const object = repo.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      return targetObject && targetObject.type === 'commit' ? target : null;
    }
    return null;
  }

  /** The full path map of a tree, recursively: path -> {mode, oid, data} for blobs. */
  treePaths(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string; data: Buffer }> {
    const result = new Map<string, { mode: string; oid: string; data: Buffer }>();
    const walk = (tree: string, prefix: string): void => {
      const object = repo.objects.get(tree);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const child = repo.objects.get(entry.oid);
        if (!child) continue;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode === '160000') continue;
        else result.set(path, { mode: entry.mode, oid: entry.oid, data: child.data });
      }
    };
    walk(treeOid, '');
    return result;
  }

  /** Build (and store) the tree for a path map, returning its oid. Empty dirs never appear. */
  buildTreeFromPaths(repo: Repo, paths: Map<string, { mode: string; oid: string; data: Buffer }>): string {
    // Group by directory, bottom-up: a directory's tree only exists when it holds a file.
    const byDir = new Map<string, Map<string, { mode: string; oid: string }>>();
    const ensureDir = (dir: string): Map<string, { mode: string; oid: string }> => {
      let bucket = byDir.get(dir);
      if (!bucket) {
        bucket = new Map();
        byDir.set(dir, bucket);
      }
      return bucket;
    };
    ensureDir('');
    for (const [path, file] of paths) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      // Register the file's directory and every ancestor, so a directory that only holds
      // subdirectories still gets a tree of its own.
      let ancestor = dir;
      for (;;) {
        ensureDir(ancestor);
        if (ancestor === '') break;
        const cut = ancestor.lastIndexOf('/');
        ancestor = cut < 0 ? '' : ancestor.slice(0, cut);
      }
      ensureDir(dir).set(name, { mode: file.mode, oid: file.oid });
    }
    // Directories deepest first so a parent's tree can reference its children.
    const dirs = [...byDir.keys()].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
    const treeOidByDir = new Map<string, string>();
    for (const dir of dirs) {
      const entries: TreeEntry[] = [];
      for (const [name, file] of ensureDir(dir)) entries.push({ mode: file.mode, name, oid: file.oid });
      // Subdirectories of this dir are already built; add them as tree entries.
      for (const [childDir, childOid] of treeOidByDir) {
        const childSlash = childDir.lastIndexOf('/');
        const childParent = childSlash < 0 ? '' : childDir.slice(0, childSlash);
        const childBase = childSlash < 0 ? childDir : childDir.slice(childSlash + 1);
        if (childParent === dir) entries.push({ mode: '40000', name: childBase, oid: childOid });
      }
      const data = buildTree(entries);
      const oid = hashObject('tree', data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
      treeOidByDir.set(dir, oid);
    }
    return treeOidByDir.get('') as string;
  }

  /** Store a blob for `content`, returning its oid. */
  storeBlob(repo: Repo, content: Buffer): string {
    const oid = hashObject('blob', content);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'blob', data: content });
    return oid;
  }

  /** Store a commit and return its oid. */
  storeCommit(repo: Repo, fields: { tree: string; parents?: readonly string[]; message: string }): string {
    const identity = viewerIdentity(this.clock);
    const data = buildCommit({ tree: fields.tree, parents: fields.parents ?? [], message: fields.message, author: identity, committer: identity });
    const oid = hashObject('commit', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
    return oid;
  }

  /** The commit at a ref (peeled), or null. */
  commitAt(repo: Repo, ref: string): { oid: string; commit: ReturnType<typeof parseCommit> } | null {
    const oid = this.refCommit(repo, ref);
    if (!oid) return null;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return { oid, commit: parseCommit(object.data) };
  }

  /** Commits reachable from `refOid`, newest first (generation order, ties by arrival). */
  commitsFrom(repo: Repo, refOid: string): Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> {
    const lookup = this.objectLookup(repo);
    const start = refOid;
    const startObject = lookup(start);
    if (!startObject) return [];
    let commitOid = start;
    if (startObject.type === 'tag') {
      const target = parseTag(startObject.data).object;
      if (!lookup(target) || lookup(target)?.type !== 'commit') return [];
      commitOid = target;
    }
    if (lookup(commitOid)?.type !== 'commit') return [];
    const seen = new Set<string>();
    const queue: string[] = [commitOid];
    const out: Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> = [];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ oid, commit });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** The merge base of two commits: the first common ancestor found walking both histories. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const lookup = this.objectLookup(repo);
    const ancestorsOf = (start: string): Set<string> => {
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length) {
        const oid = queue.pop() as string;
        if (seen.has(oid)) continue;
        const object = lookup(oid);
        if (!object || object.type !== 'commit') continue;
        seen.add(oid);
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
      return seen;
    };
    const bAncestors = ancestorsOf(b);
    const queue = [a];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift() as string;
      if (bAncestors.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** Diff two path maps into per-file changes with line counts (counting trailing newline). */
  diffPaths(
    from: Map<string, { mode: string; oid: string; data: Buffer }>,
    to: Map<string, { mode: string; oid: string; data: Buffer }>,
  ): Change[] {
    const changes: Change[] = [];
    const paths = new Set([...from.keys(), ...to.keys()]);
    const countLines = (content: string): number => {
      if (content === '') return 0;
      const lines = content.split('\n');
      return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    };
    const diffLines = (oldText: string, newText: string): { additions: number; deletions: number } => {
      const a = oldText === '' ? [] : oldText.split('\n');
      const b = newText === '' ? [] : newText.split('\n');
      if (a.length && a[a.length - 1] === '') a.pop();
      if (b.length && b[b.length - 1] === '') b.pop();
      // Longest-common-subsequence count, O(n*m) — files here are small.
      const n = a.length;
      const m = b.length;
      const table = new Uint32Array((n + 1) * (m + 1));
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          table[i * (m + 1) + j] = a[i] === b[j] ? table[(i + 1) * (m + 1) + (j + 1)] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + (j + 1)]);
        }
      }
      const lcs = table[0];
      return { additions: m - lcs, deletions: n - lcs };
    };
    for (const path of [...paths].sort()) {
      const oldFile = from.get(path);
      const newFile = to.get(path);
      if (!oldFile && newFile) {
        const text = newFile.data.toString('utf8');
        changes.push({
          path,
          status: 'added',
          additions: countLines(text),
          deletions: 0,
          changes: countLines(text),
          oldContent: null,
          newContent: text,
        });
      } else if (oldFile && !newFile) {
        const text = oldFile.data.toString('utf8');
        changes.push({
          path,
          status: 'removed',
          additions: 0,
          deletions: countLines(text),
          changes: countLines(text),
          oldContent: text,
          newContent: null,
        });
      } else if (oldFile && newFile && oldFile.oid !== newFile.oid) {
        const oldText = oldFile.data.toString('utf8');
        const newText = newFile.data.toString('utf8');
        const { additions, deletions } = diffLines(oldText, newText);
        changes.push({
          path,
          status: 'modified',
          additions,
          deletions,
          changes: additions + deletions,
          oldContent: oldText,
          newContent: newText,
        });
      }
    }
    return changes;
  }

  /**
   * Whether a squash merge of `headCommit` onto `baseCommit` (merge base `base`) is clean.
   * A path conflicts only when the base tip changed it since the merge base AND the head
   * changed it to something else.
   */
  mergeable(repo: Repo, baseCommitOid: string, headCommitOid: string): boolean {
    const baseCommit = parseCommit((repo.objects.get(baseCommitOid) as GitObject).data);
    const headCommit = parseCommit((repo.objects.get(headCommitOid) as GitObject).data);
    const ancestor = this.mergeBase(repo, baseCommitOid, headCommitOid);
    if (ancestor === null) return false;
    const ancestorCommit = parseCommit((repo.objects.get(ancestor) as GitObject).data);
    const basePaths = this.treePaths(repo, baseCommit.tree);
    const headPaths = this.treePaths(repo, headCommit.tree);
    const ancestorPaths = this.treePaths(repo, ancestorCommit.tree);
    for (const [path, headFile] of headPaths) {
      const ancestorFile = ancestorPaths.get(path);
      const baseFile = basePaths.get(path);
      if (ancestorFile && headFile.oid !== ancestorFile.oid && baseFile && baseFile.oid !== ancestorFile.oid && baseFile.oid !== headFile.oid) {
        return false;
      }
      if (!ancestorFile && baseFile && baseFile.oid !== headFile.oid) return false;
    }
    for (const [path, ancestorFile] of ancestorPaths) {
      if (!headPaths.has(path) && basePaths.has(path) && (basePaths.get(path) as { oid: string }).oid !== ancestorFile.oid) {
        return false;
      }
    }
    return true;
  }

  /** Apply a head's changes (vs the merge base) onto a base tree; returns the merged path map. */
  mergedPaths(repo: Repo, baseCommitOid: string, headCommitOid: string): Map<string, { mode: string; oid: string; data: Buffer }> {
    const baseCommit = parseCommit((repo.objects.get(baseCommitOid) as GitObject).data);
    const headCommit = parseCommit((repo.objects.get(headCommitOid) as GitObject).data);
    const ancestor = this.mergeBase(repo, baseCommitOid, headCommitOid) as string;
    const ancestorCommit = parseCommit((repo.objects.get(ancestor) as GitObject).data);
    const basePaths = this.treePaths(repo, baseCommit.tree);
    const headPaths = this.treePaths(repo, headCommit.tree);
    const ancestorPaths = this.treePaths(repo, ancestorCommit.tree);
    const merged = new Map(basePaths);
    for (const [path, headFile] of headPaths) {
      const ancestorFile = ancestorPaths.get(path);
      if (!ancestorFile || ancestorFile.oid !== headFile.oid) merged.set(path, headFile);
    }
    for (const path of ancestorPaths.keys()) {
      if (!headPaths.has(path) && basePaths.has(path)) merged.delete(path);
    }
    return merged;
  }

  // -------------------------------------------------------------------------------------------
  // tracker state
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, fields: { title: string; body?: string; labels?: Label[] }): Issue {
    const now = this.clock.nextIso();
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: repo.id * 1_000_000 + number,
      number,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      labels: fields.labels ?? [],
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      author: VIEWER.login,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, fields: { title: string; body?: string; headRef: string; baseRef: string; headSha: string; baseSha: string }): Pull {
    const now = this.clock.nextIso();
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      id: repo.id * 1_000_000 + number,
      number,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: fields.headRef,
      baseRef: fields.baseRef,
      headSha: fields.headSha,
      baseSha: fields.baseSha,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(number, pull);
    return pull;
  }

  addComment(repo: Repo, target: Issue | Pull, body: string): Comment {
    const now = this.clock.nextIso();
    const comment: Comment = {
      id: repo.nextCommentId,
      body,
      author: VIEWER.login,
      createdAt: now,
      updatedAt: now,
    };
    repo.nextCommentId += 1;
    target.comments.push(comment);
    return comment;
  }

  /** Squash-merge a pull: one commit on the base ref, PR closed and marked merged. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | null {
    const baseCommitOid = this.refCommit(repo, `refs/heads/${pull.baseRef}`);
    const headCommitOid = this.refCommit(repo, `refs/heads/${pull.headRef}`);
    if (!baseCommitOid || !headCommitOid) return null;
    if (!this.mergeable(repo, baseCommitOid, headCommitOid)) return null;
    const merged = this.mergedPaths(repo, baseCommitOid, headCommitOid);
    const treeOid = this.buildTreeFromPaths(repo, merged);
    const message = `${pull.title} (#${pull.number})\n\n${pull.body}`;
    const mergeSha = this.storeCommit(repo, { tree: treeOid, parents: [baseCommitOid], message });
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    const now = this.clock.nextIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = now;
    return { sha: mergeSha };
  }
}

export { ZERO_OID, collectReachable, isDescendant, isObjectId };
