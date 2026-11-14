// MCP over streamable HTTP: the 2026-07-28 `server/discover` era with the legacy `initialize`
// handshake as a fallback, plus `tools/list` and `tools/call` over the same store the REST and
// GraphQL surfaces use.
//
// Transport notes, as the suite's client speaks them: one POST is answered by one JSON body (no
// SSE needed), a notification (no id) is answered 202 with an empty body, a body that is not
// JSON is HTTP 400 with JSON-RPC -32700, an unknown method is -32601, an unknown tool or bad
// parameters are -32602, and a tool that cannot run its arguments answers isError:true.

import { VIEWER } from './util.ts';
import { commentJson, issueJson, pullJson, repoJson, type RouteResult } from './rest.ts';
import { type Repo, type Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

function repoOf(store: Store, args: Record<string, unknown>): Repo {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner !== 'string' || typeof repo !== 'string') throw new Error('owner and repo are required');
  const found = owner === VIEWER.login ? store.getRepo(owner, repo) : undefined;
  if (!found) throw new Error(`Repository not found: ${owner}/${repo}`);
  return found;
}

function stringArg(args: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = args[name];
  if (typeof value === 'string' && value !== '') return value;
  if (required) throw new Error(`${name} is required`);
  return undefined;
}

function numberArg(args: Record<string, unknown>, name: string, required: boolean): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  if (required) throw new Error(`${name} is required`);
  return undefined;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (store, args) => {
      const name = stringArg(args, 'name', true) as string;
      if (store.getRepo(VIEWER.login, name)) throw new Error(`Repository already exists: ${name}`);
      const repo = store.createRepo(name, {
        private: typeof args.private === 'boolean' ? args.private : false,
        description: stringArg(args, 'description', false) ?? '',
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => repoJson(repoOf(store, args)),
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user repositories.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    run: (store) => store.listViewerRepos().map(repoJson),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const title = stringArg(args, 'title', true) as string;
      const issue = store.createIssue(repo, { title, body: stringArg(args, 'body', false) ?? '' });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const number = numberArg(args, 'issue_number', true) as number;
      const issue = repo.issueByNumber.get(number);
      if (!issue) throw new Error(`Issue not found: #${number}`);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      return repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const title = stringArg(args, 'title', true) as string;
      const head = stringArg(args, 'head', true) as string;
      const base = stringArg(args, 'base', true) as string;
      const headSha = store.refCommit(repo, `refs/heads/${head}`);
      const baseSha = store.refCommit(repo, `refs/heads/${base}`);
      if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) throw new Error('A pull request already exists for this head and base');
      const pull = store.createPull(repo, {
        title,
        body: stringArg(args, 'body', false) ?? '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return pullJson(store, repo, pull);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      return repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .map((pull) => pullJson(store, repo, pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const number = numberArg(args, 'pull_number', true) as number;
      const pull = repo.pullByNumber.get(number);
      if (!pull) throw new Error(`Pull request not found: #${number}`);
      if (pull.merged || pull.state === 'closed') throw new Error('Pull request is already merged or closed');
      const merged = store.mergePull(repo, pull);
      if (!merged) throw new Error('Merge conflict');
      return { merged: true, sha: merged.sha, message: 'Pull request successfully merged' };
    },
  },
  {
    name: 'create_comment',
    description: 'Comment on an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const number = numberArg(args, 'issue_number', true) as number;
      const issue = repo.issueByNumber.get(number);
      if (!issue) throw new Error(`Issue not found: #${number}`);
      const body = stringArg(args, 'body', true) as string;
      const comment = store.addComment(repo, issue, body);
      return commentJson(repo, issue.number, comment);
    },
  },
];

const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(data: unknown): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  const data = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true };
}

function handleOne(store: Store, request: unknown): { status: number; body: unknown } | null {
  if (!isRecord(request)) return null;
  const id = request.id;
  const hasId = typeof id === 'string' || typeof id === 'number';
  const method = request.method;
  if (typeof method !== 'string') {
    if (!hasId) return { status: 202, body: null };
    return { status: 200, body: rpcError(typeof id === 'string' || typeof id === 'number' ? id : null, -32600, 'Invalid Request') };
  }
  const params = isRecord(request.params) ? request.params : {};

  // A notification (no id) is answered 202 with an empty body.
  if (!hasId) return { status: 202, body: null };
  const rpcId = id as string | number;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(rpcId, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : SUPPORTED_VERSIONS[0];
    return {
      status: 200,
      body: rpcResult(rpcId, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(rpcId, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(rpcId, { tools: TOOL_LIST }) };
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      return { status: 200, body: rpcError(rpcId, -32602, 'tools/call requires a tool name') };
    }
    const tool = TOOLS.find((entry) => entry.name === name);
    if (!tool) {
      return { status: 200, body: rpcError(rpcId, -32602, `Unknown tool: ${name}`) };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
    if (missing.length > 0) {
      return { status: 200, body: rpcResult(rpcId, toolError(`Missing required arguments: ${missing.join(', ')}`)) };
    }
    try {
      const data = tool.run(store, args);
      return { status: 200, body: rpcResult(rpcId, toolResult(data)) };
    } catch (err) {
      return { status: 200, body: rpcResult(rpcId, toolError((err as Error).message)) };
    }
  }
  return { status: 200, body: rpcError(rpcId, -32601, `Method not found: ${method}`) };
}

/**
 * POST /mcp. `rawBody` is the request body as text: a body that is not JSON is HTTP 400 with
 * JSON-RPC -32700 (the id is echoed when it can be read out of the broken body).
 */
export function handleMcp(store: Store, rawBody: string): RouteResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    const idMatch = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(rawBody);
    let id: string | number | null = null;
    if (idMatch) {
      const raw = idMatch[1] as string;
      try {
        id = JSON.parse(raw) as string | number;
      } catch {
        id = null;
      }
    }
    return { status: 400, body: rpcError(id, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const entry of parsed) {
      const handled = handleOne(store, entry);
      if (handled && handled.body !== null) results.push(handled.body);
    }
    return { status: 200, body: results };
  }
  const handled = handleOne(store, parsed);
  if (!handled) return { status: 200, body: rpcError(null, -32600, 'Invalid Request') };
  return handled as RouteResult;
}
