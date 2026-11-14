// Smart HTTP for git: info/refs advertisements (v0 + v2), upload-pack fetches (v0 + v2)
// and receive-pack pushes (v0, report-status).
//
// Wire shapes follow git's own protocol, as the suite's client parses them: pkt-line framing,
// sideband bands (1 = data, 2 = progress, 3 = error), v0 capability lists after a NUL on the
// first ref line, v2 section headers separated by delim packets.

import { type Repo, type Store } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  fetchObjects,
  hashObject,
  isDescendant,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  splitReceivePack,
  writePack,
  type GitObject,
} from './gitobj.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitResponse(status: number, contentType: string, body: Buffer): GitResponse {
  return { status, contentType, body };
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The refs a repo advertises, HEAD first, then branches, then tags (each sorted). */
function advertisedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const refs: Array<{ name: string; oid: string; peeled?: string }> = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef);
  if (headOid) refs.push({ name: 'HEAD', oid: headOid });
  const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  for (const ref of branches) refs.push({ name: ref, oid: repo.refs.get(ref) as string });
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject && targetObject.type === 'commit') peeled = target;
    }
    refs.push({ name: ref, oid, peeled });
  }
  return refs;
}

function uploadCaps(repo: Repo): string {
  return `side-band-64k shallow thin-pack ofs-delta multi_ack agent=forge/1.0 symref=HEAD:refs/heads/${repo.defaultBranch}`;
}

function receiveCaps(repo: Repo): string {
  return `report-status side-band-64k delete-refs ofs-delta thin-pack agent=forge/1.0 symref=HEAD:refs/heads/${repo.defaultBranch}`;
}

/** GET info/refs?service=<service>. v2 only when the Git-Protocol header says version=2. */
export function handleInfoRefs(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | undefined,
): GitResponse {
  const isV2 = service === 'git-upload-pack' && gitProtocol === 'version=2';
  if (isV2) {
    const body = pktLines([
      `# service=${service}\n`,
      'flush',
      'version 2\n',
      'agent=forge/1.0\n',
      'ls-refs\n',
      'fetch=shallow\n',
      'object-format=sha1\n',
      'flush',
    ]);
    return gitResponse(200, UPLOAD_AD, body);
  }
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  if (!refs.length) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0;
      parts.push(pktLine(`${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return gitResponse(200, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, Buffer.concat(parts));
}

/** Frame pack bytes as sideband band-1 packets, each carrying at most 65500 bytes. */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const chunk = 65500;
  for (let offset = 0; offset < pack.length; offset += chunk) {
    const slice = pack.subarray(offset, Math.min(offset + chunk, pack.length));
    const framed = Buffer.allocUnsafe(slice.length + 1);
    framed[0] = 1;
    slice.copy(framed, 1);
    packets.push(pktLine(framed));
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// v2
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
}

function parseLsRefsArgs(packets: ReturnType<typeof decodePktLines>): LsRefsArgs {
  const args: LsRefsArgs = { prefixes: [], peel: false, symrefs: false };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) continue;
    if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
  }
  return args;
}

/** v2 ls-refs: one line per matching ref, HEAD carrying symref-target when asked. */
function handleLsRefs(repo: Repo, body: Buffer): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return gitResponse(400, UPLOAD_RESULT, Buffer.from('malformed ls-refs request'));
  }
  const args = parseLsRefsArgs(packets);
  const refs = advertisedRefs(repo);
  const lines: string[] = [];
  for (const ref of refs) {
    if (args.prefixes.length) {
      const matches = args.prefixes.some((prefix) => ref.name.startsWith(prefix));
      const headMatches = ref.name === 'HEAD' && args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
      if (!matches && !headMatches) continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD' && args.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    if (ref.peeled && args.peel) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(PKT_FLUSH);
  return gitResponse(200, UPLOAD_RESULT, Buffer.concat(parts));
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/** Parse a v2 fetch request (single section after the first delim). */
function parseV2FetchArgs(packets: ReturnType<typeof decodePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=') && line !== 'command=fetch') throw new Error(`unsupported v2 command ${line}`);
      continue;
    }
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number.parseInt(line.slice(13).trim(), 10);
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') break;
  }
  return args;
}

/** Parse a v0 fetch request: wants section, flush, haves section, flush. */
function parseV0FetchArgs(packets: ReturnType<typeof decodePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const command = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (command === 'want') args.wants.push(rest.split(' ')[0] as string);
    else if (command === 'have') args.haves.push(rest.trim());
    else if (command === 'shallow') args.shallow.push(rest.trim());
    else if (command === 'deepen') args.depth = Number.parseInt(rest.trim(), 10);
    else if (command === 'deepen-since') args.deepenSince = Number.parseInt(rest.trim(), 10);
    else if (command === 'deepen-not') args.deepenNot.push(rest.trim());
  }
  return args;
}

/**
 * The objects a fetch sends. A missing wanted object is skipped rather than failing the fetch:
 * the client's wants always resolve from the advertisement it just read.
 */
function computeFetch(store: Store, repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = store.objectLookup(repo);
  const wants = args.wants.filter((oid) => isObjectId(oid) && lookup(oid));
  return fetchObjects(lookup, wants, args.haves, args.shallow, args.depth);
}

/** POST git-upload-pack with the v2 header: ls-refs or fetch. */
function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return gitResponse(400, UPLOAD_RESULT, Buffer.from('malformed v2 request'));
  }
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  if (command === 'command=ls-refs') return handleLsRefs(repo, body);
  if (command !== 'command=fetch') {
    return gitResponse(400, UPLOAD_RESULT, Buffer.from('unsupported v2 command'));
  }
  let args: FetchArgs;
  try {
    args = parseV2FetchArgs(packets);
  } catch {
    return gitResponse(400, UPLOAD_RESULT, Buffer.from('malformed v2 fetch request'));
  }
  const { objects, shallow, unshallow } = computeFetch(store, repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM];
  if (shallow.length || unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return gitResponse(200, UPLOAD_RESULT, Buffer.concat(parts));
}

/** POST git-upload-pack, protocol v0. */
function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return gitResponse(400, UPLOAD_RESULT, Buffer.from('malformed v0 fetch request'));
  }
  let args: FetchArgs;
  try {
    args = parseV0FetchArgs(packets);
  } catch {
    return gitResponse(400, UPLOAD_RESULT, Buffer.from('malformed v0 fetch request'));
  }
  const { objects, shallow, unshallow } = computeFetch(store, repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return gitResponse(200, UPLOAD_RESULT, Buffer.concat(parts));
}

/** POST git-upload-pack: v2 when the header says so, else v0. */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, gitProtocol: string | undefined): GitResponse {
  if (gitProtocol === 'version=2') return handleUploadPackV2(store, repo, body);
  return handleUploadPackV0(store, repo, body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the command list of a receive-pack body; returns null when the framing is unusable. */
function parsePushCommands(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  const split = splitReceivePack(body);
  if (!split) return null;
  const commands: PushCommand[] = [];
  for (const packet of split.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const commandText = (nul < 0 ? text : text.slice(0, nul)).replace(/\n$/, '');
    const parts = commandText.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, pack: split.pack };
}

/** The report-status stream, framed inside sideband band-1 packets. */
function pushReport(lines: readonly string[]): Buffer {
  const text = pktLines(lines.map((line) => `${line}\n`));
  const framed = Buffer.allocUnsafe(text.length + 1);
  framed[0] = 1;
  text.copy(framed, 1);
  return Buffer.concat([pktLine(framed), PKT_FLUSH]);
}

/** POST git-receive-pack, protocol v0. */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const parsed = parsePushCommands(body);
  if (!parsed || !parsed.commands.length) {
    return gitResponse(200, RECEIVE_RESULT, pushReport(['unpack malformed command list']));
  }
  const { commands, pack } = parsed;
  const lookup = store.objectLookup(repo);

  // Unpack first. A bad pack reports only its unpack failure, never ref lines.
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  let incoming = new Map<string, GitObject>();
  if (hasUpdates) {
    if (!pack.length) {
      return gitResponse(200, RECEIVE_RESULT, pushReport(['unpack empty pack']));
    }
    try {
      incoming = readPack(pack, { resolveBase: lookup });
    } catch (err) {
      const detail = (err as Error).message.replace(/[\r\n]+/g, ' ').slice(0, 200);
      return gitResponse(200, RECEIVE_RESULT, pushReport([`unpack ${detail}`]));
    }
    for (const [oid, object] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  const reportLines: string[] = ['unpack ok'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} remote ref does not match`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} remote ref does not match`);
      continue;
    }
    const newObject = lookup(command.newOid) ?? incoming.get(command.newOid);
    if (!newObject) {
      reportLines.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (newObject.type === 'tag') {
        const target = parseTag(newObject.data).object;
        const targetObject = lookup(target) ?? incoming.get(target);
        if (!targetObject || targetObject.type !== 'commit') {
          reportLines.push(`ng ${command.ref} object is not a commit`);
          continue;
        }
      } else if (newObject.type !== 'commit') {
        reportLines.push(`ng ${command.ref} object is not a commit`);
        continue;
      }
      // A branch update must fast-forward: the new tip descends from the old one.
      if (current && current !== ZERO_OID) {
        const peeledNew = newObject.type === 'tag' ? parseTag(newObject.data).object : command.newOid;
        if (!isDescendant(lookup, peeledNew, current)) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }
  return gitResponse(200, RECEIVE_RESULT, pushReport(reportLines));
}

export { hashObject, parseCommit, parseTag, parseTree };
