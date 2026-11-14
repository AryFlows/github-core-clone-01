// GraphQL v4: the documents gh and github-mcp-server send — viewer and repository reads, issue
// and pull-request connections with cursor pagination, the five mutations, Relay node(id:) and
// the __type introspection probes.
//
// This is a small, purpose-built executor, not a general GraphQL server: a recursive-descent
// parser for the document shapes the suite sends, a hand-written schema (the types and fields
// the introspection probes ask about), and resolvers over the same in-memory store the REST
// surface uses, so a mutation is visible over REST immediately afterwards.
//
// Global ids are opaque and stable: base64url of `Repository:<dbId>`,
// `Issue:<repoDbId>:<number>`, `PullRequest:<repoDbId>:<number>` and
// `IssueComment:<repoDbId>:<commentId>` — never the plain number or database id.

import { b64url, VIEWER } from './util.ts';
import { parseCommit, type GitObject } from './gitobj.ts';
import { type Issue, type Pull, type Repo, type Store } from './store.ts';
import type { RouteResult } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// Document parsing
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
          continue;
        }
        value += source[i] as string;
        i += 1;
      }
      if (i >= source.length) throw new Error('unterminated string in GraphQL document');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let raw = '';
      while (i < source.length && /[0-9.eE+-]/.test(source[i] as string)) {
        raw += source[i] as string;
        i += 1;
      }
      if (/[.eE]/.test(raw)) tokens.push({ kind: 'float', value: raw });
      else tokens.push({ kind: 'int', value: raw });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let raw = '';
      while (i < source.length && /[_A-Za-z0-9]/.test(source[i] as string)) {
        raw += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'name', value: raw });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek()) definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      const operation = this.next().value as 'query' | 'mutation';
      let name: string | null = null;
      const next = this.peek();
      if (next && next.kind === 'name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected "on" in a fragment definition');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    throw new Error(`unexpected ${JSON.stringify(token.value)} at the start of a GraphQL definition`);
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.acceptPunct('(')) return variables;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      variables.push({ name, defaultValue });
    }
    return variables;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.acceptPunct(':')) {
      alias = name;
      fieldName = this.expectName();
    }
    const args = this.parseArguments();
    this.parseDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name: fieldName, alias, args, selections };
  }

  private parseDirectives(): void {
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value ${JSON.stringify(token.value)} in GraphQL document`);
  }
}

/** Resolve a value node against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Array<{ name: string; value: ValueNode }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { __typename: string; [key: string]: unknown }
  | string
  | number
  | boolean
  | null;

interface FieldDef {
  /** The field's type name, for validation and introspection. */
  type: string;
  resolve?: (obj: Record<string, unknown>, args: Record<string, unknown>, ctx: Ctx) => unknown;
}

interface TypeDef {
  kind: 'object' | 'enum';
  fields?: Record<string, FieldDef>;
  values?: string[];
}

interface Ctx {
  store: Store;
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'object',
    fields: {
      viewer: {
        type: 'Viewer',
        resolve: () => ({ __typename: 'Viewer', login: VIEWER.login }),
      },
      repository: {
        type: 'Repository',
        resolve: (_obj, args, ctx) => {
          const owner = args.owner;
          const name = args.name;
          if (typeof owner !== 'string' || typeof name !== 'string') return null;
          const repo = owner === VIEWER.login ? ctx.store.getRepo(owner, name) : undefined;
          return repo ? repoObject(repo) : null;
        },
      },
      node: {
        type: 'Node',
        resolve: (_obj, args, ctx) => {
          const id = args.id;
          if (typeof id !== 'string') return null;
          return nodeObject(ctx.store, id);
        },
      },
      __type: {
        type: '__Type',
        resolve: (_obj, args) => {
          const name = args.name;
          if (typeof name !== 'string') return null;
          const def = SCHEMA[name];
          if (!def) return null;
          return { __typename: '__Type', name, kind: def.kind === 'object' ? 'OBJECT' : 'ENUM', def };
        },
      },
      __schema: {
        type: '__Schema',
        resolve: () => ({
          __typename: '__Schema',
          types: Object.keys(SCHEMA).map((name) => ({ __typename: '__Type', name, kind: 'OBJECT', def: SCHEMA[name] as TypeDef })),
          queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT', def: SCHEMA.Query as TypeDef },
          mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT', def: SCHEMA.Mutation as TypeDef },
        }),
      },
    },
  },
  Mutation: {
    kind: 'object',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (_obj, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoFromGlobalId(ctx.store, input.repositoryId);
          if (!repo) throw new Error('Repository not found');
          const title = input.title;
          if (typeof title !== 'string' || title === '') throw new Error('title is required');
          const issue = ctx.store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
          return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (_obj, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueFromGlobalId(ctx.store, input.issueId);
          if (!found) throw new Error('Issue not found');
          const { repo, issue } = found;
          issue.state = 'closed';
          issue.updatedAt = ctx.store.clock.nextIso();
          issue.closedAt = issue.updatedAt;
          return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (_obj, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoFromGlobalId(ctx.store, input.repositoryId);
          if (!repo) throw new Error('Repository not found');
          const headRefName = input.headRefName;
          const baseRefName = input.baseRefName;
          const title = input.title;
          if (typeof headRefName !== 'string' || typeof baseRefName !== 'string' || typeof title !== 'string') {
            throw new Error('headRefName, baseRefName and title are required');
          }
          const headSha = ctx.store.refCommit(repo, `refs/heads/${headRefName}`);
          const baseSha = ctx.store.refCommit(repo, `refs/heads/${baseRefName}`);
          if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
          const pull = ctx.store.createPull(repo, {
            title,
            body: typeof input.body === 'string' ? input.body : '',
            headRef: headRefName,
            baseRef: baseRefName,
            headSha,
            baseSha,
          });
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(ctx.store, repo, pull) };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (_obj, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = pullFromGlobalId(ctx.store, input.pullRequestId);
          if (!found) throw new Error('Pull request not found');
          const { repo, pull } = found;
          if (pull.merged || pull.state === 'closed') throw new Error('Pull request is already merged or closed');
          const merged = ctx.store.mergePull(repo, pull);
          if (!merged) throw new Error('Merge conflict');
          return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(ctx.store, repo, pull) };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        resolve: (_obj, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueFromGlobalId(ctx.store, input.subjectId);
          if (!found) throw new Error('Issue not found');
          const { repo, issue } = found;
          const body = input.body;
          if (typeof body !== 'string' || body === '') throw new Error('body is required');
          const comment = ctx.store.addComment(repo, issue, body);
          return {
            __typename: 'AddCommentPayload',
            commentEdge: {
              __typename: 'IssueCommentEdge',
              node: { __typename: 'IssueComment', id: b64url(`IssueComment:${repo.id}:${comment.id}`), body: comment.body },
              cursor: b64url(`cursor:${repo.id}:${comment.id}`),
            },
          };
        },
      },
    },
  },
  Viewer: {
    kind: 'object',
    fields: {
      login: { type: 'String', resolve: (obj) => obj.login },
      id: { type: 'ID', resolve: () => b64url(`User:${VIEWER.id}`) },
    },
  },
  User: {
    kind: 'object',
    fields: {
      login: { type: 'String', resolve: (obj) => obj.login },
      id: { type: 'ID', resolve: (obj) => obj.id },
    },
  },
  Repository: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (obj) => obj.id },
      databaseId: { type: 'Int', resolve: (obj) => obj.databaseId },
      name: { type: 'String', resolve: (obj) => obj.name },
      nameWithOwner: { type: 'String', resolve: (obj) => obj.nameWithOwner },
      owner: { type: 'User', resolve: (obj) => ({ __typename: 'User', login: obj.ownerLogin, id: b64url(`User:${VIEWER.id}`) }) },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (obj, _args, ctx) => {
          const repo = (obj.repo as Repo);
          const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          void ctx;
          return sha ? { __typename: 'Ref', name: repo.defaultBranch } : null;
        },
      },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      url: { type: 'String', resolve: (obj) => `/repos/${obj.nameWithOwner}` },
      issue: {
        type: 'Issue',
        resolve: (obj, args, ctx) => {
          const repo = obj.repo as Repo;
          const number = args.number;
          if (typeof number !== 'number') return null;
          const issue = repo.issueByNumber.get(number);
          void ctx;
          return issue ? issueObject(repo, issue) : null;
        },
      },
      issues: {
        type: 'IssueConnection',
        resolve: (obj, args) => {
          const repo = obj.repo as Repo;
          return issueConnection(repo, args);
        },
      },
      pullRequests: {
        type: 'PullRequestConnection',
        resolve: (obj, args, ctx) => {
          const repo = obj.repo as Repo;
          return pullConnection(ctx.store, repo, args);
        },
      },
      pullRequest: {
        type: 'PullRequest',
        resolve: (obj, args, ctx) => {
          const repo = obj.repo as Repo;
          const number = args.number;
          if (typeof number !== 'number') return null;
          const pull = repo.pullByNumber.get(number);
          return pull ? pullObject(ctx.store, repo, pull) : null;
        },
      },
    },
  },
  Ref: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (obj) => obj.name },
    },
  },
  Issue: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (obj) => obj.id },
      number: { type: 'Int', resolve: (obj) => obj.number },
      title: { type: 'String', resolve: (obj) => obj.title },
      body: { type: 'String', resolve: (obj) => obj.body },
      state: { type: 'IssueState', resolve: (obj) => (obj.state === 'closed' ? 'CLOSED' : 'OPEN') },
      createdAt: { type: 'String', resolve: (obj) => obj.createdAt },
      updatedAt: { type: 'String', resolve: (obj) => obj.updatedAt },
      closedAt: { type: 'String', resolve: (obj) => obj.closedAt },
      author: { type: 'User', resolve: () => ({ __typename: 'User', login: VIEWER.login, id: b64url(`User:${VIEWER.id}`) }) },
      labels: {
        type: 'LabelConnection',
        resolve: (obj) => ({
          __typename: 'LabelConnection',
          nodes: ((obj.labels as Array<{ name: string; color: string }>) ?? []).map((label) => ({ __typename: 'Label', name: label.name, color: label.color })),
        }),
      },
    },
  },
  PullRequest: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (obj) => obj.id },
      number: { type: 'Int', resolve: (obj) => obj.number },
      title: { type: 'String', resolve: (obj) => obj.title },
      body: { type: 'String', resolve: (obj) => obj.body },
      state: {
        type: 'PullRequestState',
        resolve: (obj) => (obj.merged ? 'MERGED' : obj.state === 'closed' ? 'CLOSED' : 'OPEN'),
      },
      merged: { type: 'Boolean', resolve: (obj) => obj.merged },
      mergedAt: { type: 'String', resolve: (obj) => obj.mergedAt },
      headRefName: { type: 'String', resolve: (obj) => obj.headRefName },
      baseRefName: { type: 'String', resolve: (obj) => obj.baseRefName },
      mergeable: {
        type: 'MergeableState',
        resolve: (obj, _args, ctx) => {
          const repo = obj.repo as Repo;
          const pull = obj.pull as Pull;
          const baseCommitOid = ctx.store.refCommit(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
          const headCommitOid = ctx.store.refCommit(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
          if (!repo.objects.has(baseCommitOid) || !repo.objects.has(headCommitOid)) return 'UNKNOWN';
          try {
            return ctx.store.mergeable(repo, baseCommitOid, headCommitOid) ? 'MERGEABLE' : 'CONFLICTING';
          } catch {
            return 'UNKNOWN';
          }
        },
      },
      files: {
        type: 'PullRequestChangedFileConnection',
        resolve: (obj, args, ctx) => {
          const repo = obj.repo as Repo;
          const pull = obj.pull as Pull;
          const baseCommitOid = ctx.store.refCommit(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
          const headCommitOid = ctx.store.refCommit(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
          const ancestor = ctx.store.mergeBase(repo, baseCommitOid, headCommitOid);
          if (ancestor === null) {
            return { __typename: 'PullRequestChangedFileConnection', nodes: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 };
          }
          const baseCommit = parseCommit((repo.objects.get(ancestor) as GitObject).data);
          const headCommit = parseCommit((repo.objects.get(headCommitOid) as GitObject).data);
          const changes = ctx.store.diffPaths(ctx.store.treePaths(repo, baseCommit.tree), ctx.store.treePaths(repo, headCommit.tree));
          const first = typeof args.first === 'number' ? args.first : 100;
          const nodes = changes.slice(0, first).map((change) => ({
            __typename: 'PullRequestChangedFile',
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
          }));
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes,
            pageInfo: { __typename: 'PageInfo', hasNextPage: changes.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: changes.length,
          };
        },
      },
      createdAt: { type: 'String', resolve: (obj) => obj.createdAt },
      updatedAt: { type: 'String', resolve: (obj) => obj.updatedAt },
      closedAt: { type: 'String', resolve: (obj) => obj.closedAt },
      author: { type: 'User', resolve: () => ({ __typename: 'User', login: VIEWER.login, id: b64url(`User:${VIEWER.id}`) }) },
      headRef: { type: 'Ref', resolve: (obj) => ({ __typename: 'Ref', name: obj.headRefName }) },
      baseRef: { type: 'Ref', resolve: (obj) => ({ __typename: 'Ref', name: obj.baseRefName }) },
    },
  },
  IssueConnection: {
    kind: 'object',
    fields: {
      nodes: { type: '[Issue]', resolve: (obj) => obj.nodes },
      edges: {
        type: '[IssueEdge]',
        resolve: (obj) => (obj.nodes as unknown[]).map((node) => ({ __typename: 'IssueEdge', node, cursor: cursorFor(node) })),
      },
      pageInfo: { type: 'PageInfo', resolve: (obj) => obj.pageInfo },
      totalCount: { type: 'Int', resolve: (obj) => obj.totalCount },
    },
  },
  PullRequestConnection: {
    kind: 'object',
    fields: {
      nodes: { type: '[PullRequest]', resolve: (obj) => obj.nodes },
      edges: {
        type: '[PullRequestEdge]',
        resolve: (obj) => (obj.nodes as unknown[]).map((node) => ({ __typename: 'PullRequestEdge', node, cursor: cursorFor(node) })),
      },
      pageInfo: { type: 'PageInfo', resolve: (obj) => obj.pageInfo },
      totalCount: { type: 'Int', resolve: (obj) => obj.totalCount },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'object',
    fields: {
      nodes: { type: '[PullRequestChangedFile]', resolve: (obj) => obj.nodes },
      pageInfo: { type: 'PageInfo', resolve: (obj) => obj.pageInfo },
      totalCount: { type: 'Int', resolve: (obj) => obj.totalCount },
    },
  },
  LabelConnection: {
    kind: 'object',
    fields: {
      nodes: { type: '[Label]', resolve: (obj) => obj.nodes },
    },
  },
  Label: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (obj) => obj.name },
      color: { type: 'String', resolve: (obj) => obj.color },
    },
  },
  IssueEdge: {
    kind: 'object',
    fields: {
      node: { type: 'Issue', resolve: (obj) => obj.node },
      cursor: { type: 'String', resolve: (obj) => obj.cursor },
    },
  },
  PullRequestEdge: {
    kind: 'object',
    fields: {
      node: { type: 'PullRequest', resolve: (obj) => obj.node },
      cursor: { type: 'String', resolve: (obj) => obj.cursor },
    },
  },
  IssueCommentEdge: {
    kind: 'object',
    fields: {
      node: { type: 'IssueComment', resolve: (obj) => obj.node },
      cursor: { type: 'String', resolve: (obj) => obj.cursor },
    },
  },
  IssueComment: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (obj) => obj.id },
      body: { type: 'String', resolve: (obj) => obj.body },
      createdAt: { type: 'String', resolve: (obj) => obj.createdAt },
      updatedAt: { type: 'String', resolve: (obj) => obj.updatedAt },
      author: { type: 'User', resolve: () => ({ __typename: 'User', login: VIEWER.login, id: b64url(`User:${VIEWER.id}`) }) },
    },
  },
  PullRequestChangedFile: {
    kind: 'object',
    fields: {
      path: { type: 'String', resolve: (obj) => obj.path },
      additions: { type: 'Int', resolve: (obj) => obj.additions },
      deletions: { type: 'Int', resolve: (obj) => obj.deletions },
      changes: { type: 'Int', resolve: (obj) => obj.changes },
    },
  },
  PageInfo: {
    kind: 'object',
    fields: {
      hasNextPage: { type: 'Boolean', resolve: (obj) => obj.hasNextPage },
      hasPreviousPage: { type: 'Boolean', resolve: (obj) => obj.hasPreviousPage },
      startCursor: { type: 'String', resolve: (obj) => obj.startCursor },
      endCursor: { type: 'String', resolve: (obj) => obj.endCursor },
    },
  },
  CreateIssuePayload: {
    kind: 'object',
    fields: {
      issue: { type: 'Issue', resolve: (obj) => obj.issue },
    },
  },
  CloseIssuePayload: {
    kind: 'object',
    fields: {
      issue: { type: 'Issue', resolve: (obj) => obj.issue },
    },
  },
  CreatePullRequestPayload: {
    kind: 'object',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (obj) => obj.pullRequest },
    },
  },
  MergePullRequestPayload: {
    kind: 'object',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (obj) => obj.pullRequest },
    },
  },
  AddCommentPayload: {
    kind: 'object',
    fields: {
      commentEdge: { type: 'IssueCommentEdge', resolve: (obj) => obj.commentEdge },
    },
  },
  __Type: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (obj) => obj.name },
      kind: { type: 'String', resolve: (obj) => obj.kind },
      fields: {
        type: '[__Field]',
        resolve: (obj) => {
          const def = obj.def as TypeDef;
          if (def.kind !== 'object' || !def.fields) return null;
          return Object.keys(def.fields).map((name) => ({ __typename: '__Field', name }));
        },
      },
      enumValues: {
        type: '[__EnumValue]',
        resolve: (obj) => {
          const def = obj.def as TypeDef;
          if (def.kind !== 'enum' || !def.values) return null;
          return def.values.map((name) => ({ __typename: '__EnumValue', name }));
        },
      },
    },
  },
  __Field: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (obj) => obj.name },
      description: { type: 'String', resolve: () => null },
    },
  },
  __EnumValue: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (obj) => obj.name },
      description: { type: 'String', resolve: () => null },
    },
  },
  __Schema: {
    kind: 'object',
    fields: {
      types: { type: '[__Type]', resolve: (obj) => obj.types },
      queryType: { type: '__Type', resolve: (obj) => obj.queryType },
      mutationType: { type: '__Type', resolve: (obj) => obj.mutationType },
    },
  },
  IssueState: { kind: 'enum', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'enum', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'enum', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'enum', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'enum', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'ORGANIZATION'] },
  IssueOrderField: { kind: 'enum', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'enum', values: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'enum', values: ['MERGE', 'SQUASH', 'REBASE'] },
};

// ---------------------------------------------------------------------------------------------
// Object shapes
// ---------------------------------------------------------------------------------------------

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    repo,
    id: b64url(`Repository:${repo.id}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    ownerLogin: repo.owner,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    repo,
    issue,
    id: b64url(`Issue:${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    labels: issue.labels,
  };
}

function pullObject(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    repo,
    pull,
    store,
    id: b64url(`PullRequest:${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.state === 'closed' ? pull.updatedAt : null,
  };
}

/** Decode a global id into its kind and parts; null when it is not one of ours. */
function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    const kind = parts[0] as string;
    if (!kind || parts.length < 2) return null;
    return { kind, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function repoFromGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const dbId = Number.parseInt(decoded.parts[0] as string, 10);
  if (!Number.isInteger(dbId)) return null;
  return store.listRepos().find((repo) => repo.id === dbId) ?? null;
}

function issueFromGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const dbId = Number.parseInt(decoded.parts[0] as string, 10);
  const number = Number.parseInt(decoded.parts[1] as string, 10);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  const repo = store.listRepos().find((entry) => entry.id === dbId);
  if (!repo) return null;
  const issue = repo.issueByNumber.get(number);
  return issue ? { repo, issue } : null;
}

function pullFromGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const dbId = Number.parseInt(decoded.parts[0] as string, 10);
  const number = Number.parseInt(decoded.parts[1] as string, 10);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  const repo = store.listRepos().find((entry) => entry.id === dbId);
  if (!repo) return null;
  const pull = repo.pullByNumber.get(number);
  return pull ? { repo, pull } : null;
}

function nodeObject(store: Store, id: string): Record<string, unknown> | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoFromGlobalId(store, id);
    return repo ? repoObject(repo) : null;
  }
  if (decoded.kind === 'Issue') {
    const found = issueFromGlobalId(store, id);
    return found ? issueObject(found.repo, found.issue) : null;
  }
  if (decoded.kind === 'PullRequest') {
    const found = pullFromGlobalId(store, id);
    return found ? pullObject(store, found.repo, found.pull) : null;
  }
  if (decoded.kind === 'IssueComment') {
    const dbId = Number.parseInt(decoded.parts[0] as string, 10);
    const commentId = Number.parseInt(decoded.parts[1] as string, 10);
    const repo = store.listRepos().find((entry) => entry.id === dbId);
    if (!repo) return null;
    for (const issue of repo.issues) {
      const comment = issue.comments.find((entry) => entry.id === commentId);
      if (comment) {
        return { __typename: 'IssueComment', id, body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt };
      }
    }
    return null;
  }
  return null;
}

/** The cursor after a connection node: base64url of `cursor:<repoDbId>:<number>`. */
function cursorFor(node: unknown): string {
  const record = node as Record<string, unknown>;
  const repo = record.repo as Repo | undefined;
  const number = typeof record.number === 'number' ? record.number : 0;
  return b64url(`cursor:${repo?.id ?? 0}:${number}`);
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'cursor' || parts.length !== 3) return null;
    const number = Number.parseInt(parts[2] as string, 10);
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

function pageInfoFor(page: unknown[], afterNumber: number | null, hasNextPage: boolean): Record<string, unknown> {
  const last = page[page.length - 1] as Record<string, unknown> | undefined;
  const firstNode = page[0] as Record<string, unknown> | undefined;
  return {
    __typename: 'PageInfo',
    hasNextPage,
    hasPreviousPage: afterNumber !== null,
    startCursor: firstNode ? cursorFor(firstNode) : null,
    endCursor: last ? cursorFor(last) : null,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
  let issues = [...repo.issues];
  if (states) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state)));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : 100;
  const afterNumber = cursorNumber(args.after);
  const startIndex = afterNumber === null ? 0 : issues.findIndex((issue) => issue.number === afterNumber) + 1;
  const page = issues.slice(Math.max(0, startIndex), Math.max(0, startIndex) + first);
  const total = issues.length;
  const nodes = page.map((issue) => issueObject(repo, issue));
  return {
    __typename: 'IssueConnection',
    nodes,
    pageInfo: pageInfoFor(nodes, afterNumber, startIndex + page.length < total),
    totalCount: total,
  };
}

function pullConnection(store: Store, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  let pulls = [...repo.pulls];
  const wanted = new Set(
    states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state === 'MERGED' ? 'merged' : state)),
  );
  pulls = pulls.filter((pull) => {
    if (wanted.has('merged') && pull.merged) return true;
    return wanted.has(pull.state);
  });
  pulls.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : 100;
  const afterNumber = cursorNumber(args.after);
  const startIndex = afterNumber === null ? 0 : pulls.findIndex((pull) => pull.number === afterNumber) + 1;
  const page = pulls.slice(Math.max(0, startIndex), Math.max(0, startIndex) + first);
  const total = pulls.length;
  const nodes = page.map((pull) => pullObject(store, repo, pull));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    pageInfo: pageInfoFor(nodes, afterNumber, startIndex + page.length < total),
    totalCount: total,
  };
}

// ---------------------------------------------------------------------------------------------
// Validation + execution
// ---------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
}

interface Executor {
  errors: GqlError[];
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
  ctx: Ctx;
}

/** The type name a field's declared type resolves to, stripping list/non-null wrappers. */
function namedType(type: string): string {
  return type.replace(/[\[\]!]/g, '');
}

function validateSelections(
  executor: Executor,
  selections: SelectionNode[],
  parentType: string,
): void {
  const def = SCHEMA[parentType];
  if (!def || def.kind !== 'object' || !def.fields) return;
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') {
        if (selection.selections.length) validateSelections(executor, selection.selections, 'String');
        continue;
      }
      const fieldDef = def.fields[selection.name];
      if (!fieldDef) {
        executor.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
        continue;
      }
      if (selection.selections.length) {
        const childType = namedType(fieldDef.type);
        if (SCHEMA[childType]?.kind === 'object') validateSelections(executor, selection.selections, childType);
      }
    } else if (selection.kind === 'inline') {
      const typeCondition = selection.typeCondition ?? parentType;
      if (!SCHEMA[typeCondition]) {
        executor.errors.push({ message: `Unknown type "${typeCondition}".` });
        continue;
      }
      validateSelections(executor, selection.selections, typeCondition);
    } else if (selection.kind === 'spread') {
      const fragment = executor.fragments.get(selection.name);
      if (!fragment) {
        executor.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (!SCHEMA[fragment.typeCondition]) {
        executor.errors.push({ message: `Unknown type "${fragment.typeCondition}".` });
        continue;
      }
      validateSelections(executor, fragment.selections, fragment.typeCondition);
    }
  }
}

function executeSelections(
  executor: Executor,
  selections: SelectionNode[],
  parentType: string,
  obj: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = parentType;
        continue;
      }
      const def = SCHEMA[parentType];
      const fieldDef = def?.kind === 'object' ? def.fields?.[selection.name] : undefined;
      if (!fieldDef) {
        executor.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
        out[key] = null;
        continue;
      }
      const args = resolveArgs(selection.args, executor.variables);
      let value: unknown;
      try {
        value = fieldDef.resolve ? fieldDef.resolve(obj, args, executor.ctx) : (obj[selection.name] ?? null);
      } catch (err) {
        executor.errors.push({ message: (err as Error).message });
        out[key] = null;
        continue;
      }
      if (selection.selections.length === 0) {
        out[key] = value;
        continue;
      }
      const childType = namedType(fieldDef.type);
      if (value === null || value === undefined) {
        out[key] = null;
        continue;
      }
      if (Array.isArray(value)) {
        out[key] = value.map((item) =>
          item !== null && typeof item === 'object'
            ? executeSelections(executor, selection.selections, childType, item as Record<string, unknown>)
            : item,
        );
        continue;
      }
      if (typeof value === 'object') {
        const valueType = ((value as Record<string, unknown>).__typename as string) ?? childType;
        out[key] = executeSelections(executor, selection.selections, valueType, value as Record<string, unknown>);
        continue;
      }
      out[key] = value;
    } else if (selection.kind === 'inline') {
      const typeCondition = selection.typeCondition ?? parentType;
      const objType = (obj.__typename as string) ?? parentType;
      if (typeCondition === objType || selection.typeCondition === null) {
        const nested = executeSelections(executor, selection.selections, typeCondition, obj);
        if (nested) Object.assign(out, nested);
      }
    } else if (selection.kind === 'spread') {
      const fragment = executor.fragments.get(selection.name);
      if (!fragment) continue;
      const nested = executeSelections(executor, fragment.selections, fragment.typeCondition, obj);
      if (nested) Object.assign(out, nested);
    }
  }
  return out;
}

function executeOperation(
  store: Store,
  operation: OperationNode,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  const executor: Executor = { errors: [], fragments, variables, ctx: { store } };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(executor, operation.selections, rootType);
  if (executor.errors.length > 0) return { data: null, errors: executor.errors };
  const root: Record<string, unknown> = { __typename: rootType };
  const data = executeSelections(executor, operation.selections, rootType, root);
  if (executor.errors.length > 0) return { data, errors: executor.errors };
  return { data };
}

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  const record = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'A GraphQL query string is required' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${(err as Error).message}` }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  if (!operations.length) {
    return { data: null, errors: [{ message: 'The document holds no operation' }] };
  }
  let operation = operations[0] as OperationNode;
  const operationName = record.operationName;
  if (typeof operationName === 'string' && operationName !== '') {
    const named = operations.find((entry) => entry.name === operationName);
    if (!named) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    operation = named;
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (mergedVariables[variable.name] === undefined && variable.defaultValue) {
      mergedVariables[variable.name] = resolveValue(variable.defaultValue, mergedVariables);
    }
  }
  return executeOperation(store, operation, fragments, mergedVariables);
}

/** POST /api/graphql. Accepts one operation or a JSON array of them (GitHub's batching). */
export function handleGraphQL(store: Store, body: unknown): RouteResult {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(store, entry)) };
  }
  return { status: 200, body: executeOne(store, body) };
}
