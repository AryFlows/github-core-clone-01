// The forge's HTTP server: one in-memory store per process, routed by path.
//
//   GET  /healthz                                  200 {"ok":true}, no auth (the env's boot check)
//   /api/v3/*                                      REST v3 (Bearer token required)
//   POST /api/graphql                             GraphQL v4 (Bearer token required)
//   POST /mcp                                     MCP over streamable HTTP (Bearer token required)
//   /<owner>/<repo>.git/info/refs                 git smart HTTP advertisements (Bearer token required)
//   /<owner>/<repo>.git/git-upload-pack           git fetch, protocol v0 and v2
//   /<owner>/<repo>.git/git-receive-pack          git push, protocol v0, report-status
//   anything else                                 404 {"message":"Not Found"}
//
// Auth: the token is $MAKEFUN_SHOP_TOKEN. When it is set, only that exact Bearer token is
// accepted; when it is unset (local development), any non-empty Bearer token is accepted, but a
// request with no token is still 401. Every reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Clock } from './lib/util.ts';
import { Store } from './lib/store.ts';
import { handleRest, type RouteResult } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './lib/gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** An empty query set, shared by the requests that carry no query string. */
const EMPTY_QUERY = new URLSearchParams();

/**
 * The path and query of a request URL, parsed once (never a throw from a request). A manual
 * split, not `new URL`: the suite's paths are plain origin-form paths, and the URL parser's
 * validation and normalization cost several microseconds a request on the hot paths. A path
 * that does not start with '/' (or is missing) falls back to '/', as the old parse did.
 */
function pathAndQuery(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  if (!raw.startsWith('/')) return { path: '/', query: EMPTY_QUERY };
  const cut = raw.indexOf('?');
  if (cut < 0) return { path: raw, query: EMPTY_QUERY };
  return { path: raw.slice(0, cut), query: new URLSearchParams(raw.slice(cut + 1)) };
}

/** The request's own origin, for absolute pagination links. */
function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Whether the request carries the shop token (or any non-empty Bearer token in local dev). */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

/** Answer with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, headers: Readonly<Record<string, string>> = {}): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(buf);
}

/** Answer with raw bytes (the git protocol's framed responses). */
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

/** Answer with no body at all (204 deletes, 202 notifications). */
function sendEmpty(res: ServerResponse, status: number, requestId: string): void {
  res.writeHead(status, { 'x-github-request-id': requestId });
  res.end();
}

/** Read the whole request body, up to MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('request body is too large'));
      // Small bodies arrive in one chunk: hand it over without a copy. No handler mutates a
      // body buffer (they slice, hash or decode it), so sharing the chunk is safe.
      else if (chunks.length === 1) resolve(chunks[0] as Buffer);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store({ clock: new Clock() });
  let requestCounter = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `forge-${(requestCounter += 1)}`;
    const { path, query } = pathAndQuery(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    const segments = path.split('/').filter((part) => part !== '');
    const isApi = segments[0] === 'api' && (segments[1] === 'v3' || segments[1] === 'graphql');
    const isMcp = segments[0] === 'mcp';
    const isGit = segments.length >= 2 && segments[1]?.endsWith('.git') === true;

    // Everything except /healthz and the JSON 404 for unknown paths needs the token.
    if ((isApi || isMcp || isGit) && !authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, requestId);
      return;
    }

    void (async () => {
      try {
        // MCP: the raw body is needed to tell a parse error (HTTP 400, JSON-RPC -32700) apart.
        if (isMcp) {
          if (method === 'GET') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
            return;
          }
          if (method === 'DELETE') {
            sendJson(res, 200, { ok: true }, requestId);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(store, raw.toString('utf8'));
          if (result.body === null) sendEmpty(res, result.status, requestId);
          else sendJson(res, result.status, result.body, requestId);
          return;
        }

        // GraphQL.
        if (segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          const raw = await readBody(req);
          if (raw.length === 0) {
            sendJson(res, 400, { message: 'A GraphQL query string is required' }, requestId);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Request body is not valid JSON' }, requestId);
            return;
          }
          const result = handleGraphQL(store, parsed);
          sendJson(res, result.status, result.body, requestId);
          return;
        }

        // Git smart HTTP.
        if (isGit) {
          const owner = decodeURIComponent(segments[0] as string);
          const repoName = decodeURIComponent((segments[1] as string).slice(0, -'.git'.length));
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          const tail = segments.slice(2);
          const gitProtocol = req.headers['git-protocol'];
          if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
            const service = query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service is required' }, requestId);
              return;
            }
            const result: GitResponse = handleInfoRefs(repo, service, gitProtocol);
            sendRaw(res, result.status, result.contentType, result.body, requestId);
            return;
          }
          if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
            const raw = await readBody(req);
            const result: GitResponse = handleUploadPack(store, repo, raw, gitProtocol);
            sendRaw(res, result.status, result.contentType, result.body, requestId);
            return;
          }
          if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
            const raw = await readBody(req);
            const result: GitResponse = handleReceivePack(store, repo, raw);
            sendRaw(res, result.status, result.contentType, result.body, requestId);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const restSegments = segments.slice(2);
          let parsed: unknown = {};
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Request body is not valid JSON' }, requestId);
                return;
              }
            }
          }
          const result: RouteResult | null = handleRest(store, method, restSegments, query, parsed, baseUrlOf(req));
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          if (result.status === 204) {
            sendEmpty(res, 204, requestId);
            return;
          }
          if (result.raw !== undefined) {
            // A pre-serialized JSON body (the cached issue JSON): same headers sendJson
            // would set, without re-stringifying.
            sendRaw(res, result.status, JSON_TYPE, result.raw, requestId);
            return;
          }
          sendJson(res, result.status, result.body, requestId, result.headers ?? {});
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: (err as Error).message }, requestId);
        } else {
          res.destroy();
        }
      }
    })();
  });
}
