import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { verifyPass, type RepositoryPass } from './pass.js';
import { buildAdvertisement, parseAdvertisement } from './pktline.js';
import { allowedRefs, checkFetch, checkPush } from './rules.js';
import { resolveUpstream, type GitService, type Upstream, type UpstreamAuth } from './upstream.js';

export interface RepositoryProxyOptions {
  key: string;
  upstreamAuth?: UpstreamAuth;
  resolveUpstream?: (codeRepository: string) => Upstream;
  now?: () => number;
  maxBodyBytes?: number;
}

const ROUTE = /^\/r\/([A-Za-z0-9_-]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const DEFAULT_MAX_BODY = 512 * 1024 * 1024;

export function repositoryPath(codeRepository: string): string {
  return `/r/${Buffer.from(codeRepository).toString('base64url')}`;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function extractToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() === 'bearer') return value;
  if (scheme?.toLowerCase() === 'basic' && value) {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return undefined;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (req.headers['content-encoding'] === 'gzip') {
    try {
      return gunzipSync(raw, { maxOutputLength: limit });
    } catch {
      throw new HttpError(400, 'invalid gzip body');
    }
  }
  return raw;
}

function authorise(req: IncomingMessage, key: string, now: number, repoKey: string): RepositoryPass {
  const token = extractToken(req);
  if (!token) throw new HttpError(401, 'pass required');
  const verdict = verifyPass(token, key, now);
  if (!verdict.ok) throw new HttpError(403, `pass rejected: ${verdict.reason}`);
  if (Buffer.from(repoKey, 'base64url').toString('utf8') !== verdict.pass.codeRepository) {
    throw new HttpError(403, 'pass does not cover this repository');
  }
  return verdict.pass;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RepositoryProxyOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://proxy');
  const match = ROUTE.exec(url.pathname);
  if (!match) throw new HttpError(403, 'only git smart-HTTP paths are served');
  const [, repoKey, endpoint] = match as unknown as [string, string, string];
  const pass = authorise(req, opts.key, (opts.now ?? Date.now)(), repoKey);
  const upstream = (opts.resolveUpstream ?? ((repo) => resolveUpstream(repo, opts.upstreamAuth)))(
    pass.codeRepository,
  );

  if (endpoint === 'info/refs') {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      throw new HttpError(403, 'dumb protocol is not served');
    }
    const adv = parseAdvertisement(await upstream.advertise(service));
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
    });
    res.end(buildAdvertisement(service, adv, allowedRefs(pass)));
    return;
  }

  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
  const service = endpoint as GitService;
  const body = await readBody(req, opts.maxBodyBytes ?? DEFAULT_MAX_BODY);
  const decision =
    service === 'git-upload-pack'
      ? checkFetch(body, pass, parseAdvertisement(await upstream.advertise(service)))
      : checkPush(body, pass);
  if (!decision.allow) throw new HttpError(403, decision.reason);
  const result = await upstream.rpc(service, body);
  res.writeHead(200, { 'content-type': `application/x-${service}-result`, 'cache-control': 'no-cache' });
  res.end(result);
}

export function createRepositoryProxy(opts: RepositoryProxyOptions): Server {
  return createServer((req, res) => {
    handle(req, res, opts).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = err instanceof HttpError ? err.status : 502;
      const headers: Record<string, string> = { 'content-type': 'text/plain' };
      if (status === 401) headers['www-authenticate'] = 'Basic realm="harmonic-repository-proxy"';
      res.writeHead(status, headers);
      res.end(err instanceof HttpError ? err.message : 'upstream failure');
    });
  });
}
