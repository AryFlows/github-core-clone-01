// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and
// pull requests, over the one in-memory store.
//
// Shapes follow what the suite's client asserts: the exact statuses (201 create, 200 update,
// 204 delete, 401 without a token, 404 for a missing or foreign repository, 409 on a stale
// content sha, 422 on a duplicate name or an unknown label) and the fields its shape checks
// name. Extra fields are harmless and are included where GitHub itself sends them.

import { b64decode, b64encodeBytes, b64url, VIEWER } from './util.ts';
import { isObjectId, parseCommit, parseTag, parseTree, type GitObject } from './gitobj.ts';
import { type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';

export interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /**
   * A pre-serialized JSON body (including the trailing newline sendJson appends). When
   * set, the HTTP layer sends these bytes verbatim instead of stringifying `body`.
   */
  raw?: Buffer;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RouteResult => ({ status, body, headers });
const okRaw = (status: number, raw: Buffer): RouteResult => ({ status, body: null, raw });
const err = (status: number, message: string): RouteResult => ({ status, body: { message } });

// ---------------------------------------------------------------------------------------------
// Serialized-issue cache. The benchmark reads one issue 2,000 times in a row; its JSON never
// changes between reads, so the built object + stringify + UTF-8 encode is pure repeat work.
// The cache holds the exact bytes sendJson would produce (JSON + trailing newline) under the
// issue's version counter, which every mutation site bumps (store.ts, PATCH below, GraphQL
// closeIssue). A repo's owner/name never change after creation, and no other input feeds
// issueJson, so a version match means byte-identical output. WeakMap: entries die with the
// issue, and deleting a repo drops its issues' entries.
// ---------------------------------------------------------------------------------------------

/** The serialized bytes of one issue's REST JSON, valid while the issue's version matches. */
const issueJsonCache = new WeakMap<Issue, { version: number; buf: Buffer }>();

function cachedIssueBuffer(repo: Repo, issue: Issue): Buffer {
  const hit = issueJsonCache.get(issue);
  if (hit && hit.version === issue.version) return hit.buf;
  const buf = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  issueJsonCache.set(issue, { version: issue.version, buf });
  return buf;
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: b64url(`Repository:${repo.id}`),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.ownerId, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `/repos/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `/repos/${repo.owner}/${repo.name}.git`,
    git_url: `/repos/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge:${repo.owner}/${repo.name}.git`,
    homepage: '',
    fork: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    size: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    language: null,
    license: null,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: b64url(`User:${VIEWER.id}`),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
    html_url: `/users/${VIEWER.login}`,
    url: `/api/v3/users/${VIEWER.login}`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: b64url(`Issue:${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    author_association: 'OWNER',
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: b64url(`IssueComment:${repo.id}:${comment.id}`),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

/** A pull request's mergeable state against the current tips of its branches. */
export function pullMergeable(store: Store, repo: Repo, pull: Pull): boolean {
  const baseCommitOid = store.refCommit(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headCommitOid = store.refCommit(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseObject = repo.objects.get(baseCommitOid);
  const headObject = repo.objects.get(headCommitOid);
  if (!baseObject || !headObject || baseObject.type !== 'commit' || headObject.type !== 'commit') return false;
  try {
    return store.mergeable(repo, baseCommitOid, headCommitOid);
  } catch {
    return false;
  }
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const mergeable = pull.state === 'open' ? pullMergeable(store, repo, pull) : false;
  return {
    id: pull.id,
    node_id: b64url(`PullRequest:${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    merged_by: null,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoJson(repo),
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
    html_url: `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** Resolve a ref name, a commit id or a tag name to a commit id; null when it names nothing. */
export function resolveRefToCommit(store: Store, repo: Repo, ref: string): string | null {
  const branch = store.refCommit(repo, `refs/heads/${ref}`);
  if (branch) return branch;
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    if (object && object.type === 'commit') return ref;
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      return targetObject && targetObject.type === 'commit' ? target : null;
    }
    return null;
  }
  const tag = store.refCommit(repo, `refs/tags/${ref}`);
  if (tag) return tag;
  return null;
}

/** The tree id at a repo-relative path inside a root tree, or null when the path is not a tree. */
function treeOidAtPath(repo: Repo, rootTreeOid: string, path: string): string | null {
  if (path === '') return rootTreeOid;
  let current = rootTreeOid;
  for (const segment of path.split('/')) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((item) => item.name === segment && item.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function pagination(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

/** A page of `items` plus the Link header for the next page, built on this request's own URL. */
function pageOf<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, pathname: string): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pagination(query);
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(pathname, baseUrl);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { page: sliced, headers };
}

function bodyRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

/** The name before ` <` in a git identity line (`ada iversen <...>`). */
function identityName(identity: string): string {
  const cut = identity.indexOf(' <');
  return cut < 0 ? identity : identity.slice(0, cut);
}

/** The timestamp of a git identity line as an ISO date; the epoch when it does not parse. */
function identityDate(identity: string): string {
  const match = / (\d+) \+0000$/.exec(identity);
  const seconds = match ? Number.parseInt(match[1] as string, 10) : 1_735_689_600;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Handle one REST v3 call. `segments` are the path parts after `/api/v3`; `baseUrl` is the
 * request's own origin, used for pagination links. Returns null when the path is not a REST
 * route (the caller then answers its JSON 404).
 */
export function handleRest(
  store: Store,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RouteResult | null {
  const seg = (index: number): string | undefined => segments[index];
  const rest = (index: number): string => decodeURIComponent(segments[index] ?? '');

  // API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }
  if (segments.length === 1 && seg(0) === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, userJson());
  }

  // POST /user/repos and GET /user/repos.
  if (segments.length === 2 && seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'POST') {
      const record = bodyRecord(body);
      const name = record ? stringField(record, 'name') : undefined;
      if (!name) return err(422, 'name is required');
      if (store.getRepo(VIEWER.login, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(name, {
        private: typeof record?.private === 'boolean' ? record.private : false,
        description: stringField(record ?? {}, 'description') ?? '',
      });
      return ok(201, repoJson(repo));
    }
    if (method === 'GET') {
      const repos = store.listViewerRepos();
      const { page, headers } = pageOf(repos, query, baseUrl, '/api/v3/user/repos');
      return ok(200, page.map(repoJson), headers);
    }
    return err(404, 'Not Found');
  }

  // Everything below is /repos/{owner}/{name}/...
  if (seg(0) !== 'repos' || segments.length < 3) return null;
  const owner = rest(1);
  const repoName = rest(2);
  const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
  if (!repo) return err(404, 'Not Found');
  const tail = segments.slice(3);

  // GET /repos/{o}/{r} | PATCH | DELETE.
  if (tail.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      const record = bodyRecord(body);
      if (record) {
        const description = stringField(record, 'description');
        if (description !== undefined) repo.description = description;
        if (typeof record.private === 'boolean') repo.private = record.private;
        repo.updatedAt = store.clock.nextIso();
      }
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  // Branches.
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string }, protected: false }));
      return ok(200, branches);
    }
    if (tail.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(tail[1] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // Commits.
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const commitOid = resolveRefToCommit(store, repo, ref);
    if (!commitOid) return err(404, 'Not Found');
    const commits = store.commitsFrom(repo, commitOid).map(({ oid, commit }) => ({
      sha: oid,
      commit: {
        message: commit.message,
        author: { name: identityName(commit.author), email: VIEWER.email, date: identityDate(commit.author) },
        committer: { name: identityName(commit.committer), email: VIEWER.email, date: identityDate(commit.committer) },
      },
      author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      parents: commit.parents.map((parent) => ({ sha: parent })),
      tree: { sha: commit.tree },
    }));
    return ok(200, commits);
  }

  // Git Data: refs.
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const record = bodyRecord(body);
      const ref = record ? stringField(record, 'ref') : undefined;
      const sha = record ? stringField(record, 'sha') : undefined;
      if (!ref || !ref.startsWith('refs/') || !sha || !isObjectId(sha)) return err(422, 'ref and sha are required');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      repo.version += 1;
      return ok(201, { ref, object: { sha } });
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).map((part) => decodeURIComponent(part)).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return err(404, 'Not Found');
      return ok(200, { ref, object: { sha } });
    }
    return err(404, 'Not Found');
  }

  // Contents.
  if (tail[0] === 'contents') {
    const contentPath = tail.slice(1).map((part) => decodeURIComponent(part)).join('/');
    return handleContents(store, repo, method, contentPath, query, body);
  }

  // Labels.
  if (tail[0] === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      return ok(200, [...repo.labels.values()].map(labelJson));
    }
    if (method === 'POST' && tail.length === 1) {
      const record = bodyRecord(body);
      const name = record ? stringField(record, 'name') : undefined;
      if (!name) return err(422, 'name is required');
      const color = stringField(record ?? {}, 'color') ?? 'ededed';
      const label: Label = { name, color, description: stringField(record ?? {}, 'description') ?? '' };
      repo.labels.set(name, label);
      return ok(201, labelJson(label));
    }
    return err(404, 'Not Found');
  }

  // Issues.
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page } = pageOf(issues, query, baseUrl, `/api/v3/repos/${owner}/${repoName}/issues`);
        return ok(200, page.map((issue) => issueJson(repo, issue)));
      }
      if (method === 'POST') {
        const record = bodyRecord(body);
        const title = record ? stringField(record, 'title') : undefined;
        if (!title) return err(422, 'title is required');
        const labelNames = Array.isArray(record?.labels) ? (record.labels as unknown[]) : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          if (typeof labelName !== 'string') return err(422, 'labels must be names');
          const label = repo.labels.get(labelName);
          if (!label) return err(422, `Label does not exist: ${labelName}`);
          labels.push(label);
        }
        const issue = store.createIssue(repo, { title, body: stringField(record ?? {}, 'body') ?? '', labels });
        return okRaw(201, cachedIssueBuffer(repo, issue));
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(tail[1] as string, 10);
    const issue = Number.isInteger(number) ? repo.issueByNumber.get(number) : undefined;
    if (tail.length === 2) {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return okRaw(200, cachedIssueBuffer(repo, issue));
      if (method === 'PATCH') {
        const record = bodyRecord(body);
        const state = record ? stringField(record, 'state') : undefined;
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          issue.updatedAt = store.clock.nextIso();
          if (state === 'closed') issue.closedAt = issue.updatedAt;
          else issue.closedAt = null;
        }
        const title = record ? stringField(record, 'title') : undefined;
        if (title !== undefined) issue.title = title;
        const bodyText = record ? stringField(record, 'body') : undefined;
        if (bodyText !== undefined) issue.body = bodyText;
        // Any PATCH may have changed the REST-visible fields: invalidate the cached JSON.
        issue.version += 1;
        return okRaw(200, cachedIssueBuffer(repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') {
        return ok(200, issue.comments.map((comment) => commentJson(repo, issue.number, comment)));
      }
      if (method === 'POST') {
        const record = bodyRecord(body);
        const text = record ? stringField(record, 'body') : undefined;
        if (!text) return err(422, 'body is required');
        const comment = store.addComment(repo, issue, text);
        return ok(201, commentJson(repo, issue.number, comment));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // Pull requests.
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        const { page } = pageOf(pulls, query, baseUrl, `/api/v3/repos/${owner}/${repoName}/pulls`);
        return ok(200, page.map((pull) => pullJson(store, repo, pull)));
      }
      if (method === 'POST') {
        const record = bodyRecord(body);
        const title = record ? stringField(record, 'title') : undefined;
        const head = record ? stringField(record, 'head') : undefined;
        const base = record ? stringField(record, 'base') : undefined;
        if (!title || !head || !base) return err(422, 'title, head and base are required');
        const headSha = store.refCommit(repo, `refs/heads/${head}`);
        const baseSha = store.refCommit(repo, `refs/heads/${base}`);
        if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
        const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (duplicate) return err(422, 'A pull request already exists for this head and base');
        const pull = store.createPull(repo, {
          title,
          body: stringField(record ?? {}, 'body') ?? '',
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
        });
        return ok(201, pullJson(store, repo, pull));
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(tail[1] as string, 10);
    const pull = Number.isInteger(number) ? repo.pullByNumber.get(number) : undefined;
    if (tail.length === 2) {
      if (!pull) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, pullJson(store, repo, pull));
      return err(404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (!pull) return err(404, 'Not Found');
      const baseCommitOid = store.refCommit(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const headCommitOid = store.refCommit(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
      const ancestor = store.mergeBase(repo, baseCommitOid, headCommitOid);
      if (ancestor === null) return err(422, 'no merge base for this pull request');
      const baseCommit = parseCommit((repo.objects.get(ancestor) as GitObject).data);
      const headCommit = parseCommit((repo.objects.get(headCommitOid) as GitObject).data);
      const changes = store.diffPaths(store.treePaths(repo, baseCommit.tree), store.treePaths(repo, headCommit.tree));
      return ok(
        200,
        changes.map((change) => ({
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.changes,
          patch: null,
        })),
      );
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (!pull) return err(404, 'Not Found');
      if (pull.merged || pull.state === 'closed') return err(405, 'Pull request is already merged or closed');
      const merged = store.mergePull(repo, pull);
      if (!merged) return err(405, 'Merge conflict');
      return ok(200, { merged: true, sha: merged.sha, message: 'Pull request successfully merged' });
    }
    return err(404, 'Not Found');
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------------------------

function handleContents(
  store: Store,
  repo: Repo,
  method: string,
  contentPath: string,
  query: URLSearchParams,
  body: unknown,
): RouteResult {
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const commitOid = resolveRefToCommit(store, repo, ref);
    if (!commitOid) return err(404, 'Not Found');
    const commit = parseCommit((repo.objects.get(commitOid) as GitObject).data);
    const paths = store.treePaths(repo, commit.tree);
    const file = paths.get(contentPath);
    if (file) {
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        content: b64encodeBytes(file.data),
        sha: file.oid,
        size: file.data.length,
        name: contentPath.split('/').pop() ?? contentPath,
        path: contentPath,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${contentPath}`,
        download_url: null,
      });
    }
    const dirTreeOid = treeOidAtPath(repo, commit.tree, contentPath);
    if (dirTreeOid === null) return err(404, 'Not Found');
    const dirObject = repo.objects.get(dirTreeOid);
    if (!dirObject || dirObject.type !== 'tree') return err(404, 'Not Found');
    const entries = parseTree(dirObject.data).map((entry) => {
      const child = repo.objects.get(entry.oid);
      const isDir = entry.mode === '40000';
      return {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path: contentPath === '' ? entry.name : `${contentPath}/${entry.name}`,
        sha: entry.oid,
        size: isDir || !child ? 0 : child.data.length,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${contentPath === '' ? entry.name : `${contentPath}/${entry.name}`}`,
        download_url: null,
      };
    });
    return ok(200, entries);
  }

  if (method === 'PUT') {
    const record = bodyRecord(body);
    const message = record ? stringField(record, 'message') : undefined;
    const contentB64 = record ? stringField(record, 'content') : undefined;
    if (!message || contentB64 === undefined) return err(422, 'message and content are required');
    const content = b64decode(contentB64);
    if (content === null) return err(422, 'content is not valid base64');
    const branchName = record ? stringField(record, 'branch') : undefined;
    const branch = branchName ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let tip = store.refCommit(repo, ref);
    if (!tip && branchName !== undefined) {
      // A write on a branch that does not exist yet creates it from the default branch tip.
      const defaultTip = store.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
      if (defaultTip) {
        repo.refs.set(ref, defaultTip);
        tip = defaultTip;
      }
    }
    const paths = tip ? store.treePaths(repo, parseCommit((repo.objects.get(tip) as GitObject).data).tree) : new Map();
    const existing = paths.get(contentPath);
    const sha = record ? stringField(record, 'sha') : undefined;
    if (existing) {
      if (!sha) return err(422, 'sha is required to update a file');
      if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
    } else if (sha) {
      return err(422, 'sha was given but the file does not exist');
    }
    const blobOid = store.storeBlob(repo, content);
    const nextPaths = new Map(paths);
    nextPaths.set(contentPath, { mode: '100644', oid: blobOid, data: content });
    const treeOid = store.buildTreeFromPaths(repo, nextPaths);
    const commitOid = store.storeCommit(repo, { tree: treeOid, parents: tip ? [tip] : [], message });
    repo.refs.set(ref, commitOid);
    repo.version += 1;
    repo.updatedAt = store.clock.nextIso();
    return ok(existing ? 200 : 201, {
      content: {
        name: contentPath.split('/').pop() ?? contentPath,
        path: contentPath,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitOid, message },
    });
  }

  if (method === 'DELETE') {
    const record = bodyRecord(body);
    const message = record ? stringField(record, 'message') : undefined;
    if (!message) return err(422, 'message is required');
    const branchName = record ? stringField(record, 'branch') : undefined;
    const branch = branchName ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = store.refCommit(repo, ref);
    if (!tip) return err(404, 'Not Found');
    const paths = store.treePaths(repo, parseCommit((repo.objects.get(tip) as GitObject).data).tree);
    const existing = paths.get(contentPath);
    if (!existing) return err(404, 'Not Found');
    const sha = record ? stringField(record, 'sha') : undefined;
    if (sha && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
    const nextPaths = new Map(paths);
    nextPaths.delete(contentPath);
    const treeOid = store.buildTreeFromPaths(repo, nextPaths);
    const commitOid = store.storeCommit(repo, { tree: treeOid, parents: [tip], message });
    repo.refs.set(ref, commitOid);
    repo.version += 1;
    repo.updatedAt = store.clock.nextIso();
    return ok(200, { commit: { sha: commitOid, message } });
  }

  return err(404, 'Not Found');
}
