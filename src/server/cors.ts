import type { FastifyReply } from 'fastify';
import type { App } from './app-context.js';

export type CorsPolicy =
  | { kind: 'off' }
  | { kind: 'any' }
  | { kind: 'list'; origins: ReadonlySet<string> };

export function parseCorsOrigins(raw: string | undefined): CorsPolicy {
  const entries = (raw ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (entries.length === 0) return { kind: 'off' };
  if (entries.includes('*')) return { kind: 'any' };
  const origins = new Set<string>();
  for (const entry of entries) {
    origins.add(parseOrigin(entry));
  }
  return { kind: 'list', origins };
}

function parseOrigin(entry: string): string {
  const bad = () => new Error(`HARMONIC_CORS_ORIGINS: "${entry}" is not a bare origin (expected e.g. https://viz.example.com) or "*"`);
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw bad();
  }
  if (url.origin === 'null' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') throw bad();
  return url.origin;
}

function appendVary(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader('vary');
  const current = Array.isArray(existing) ? existing.join(', ') : existing === undefined ? '' : String(existing);
  const present = current.split(',').map((v) => v.trim().toLowerCase());
  if (present.includes('*') || present.includes(value.toLowerCase())) return;
  reply.header('vary', current === '' ? value : `${current}, ${value}`);
}

/** Bearer-only CORS: credentials are never allowed, so `*` is safe for Read Key viewers. */
export function registerCors(app: App, policy: CorsPolicy): void {
  if (policy.kind === 'off') return;
  app.addHook('onRequest', async (req, reply) => {
    const isPreflight = req.method === 'OPTIONS' && Boolean(req.headers['access-control-request-method']);
    if (policy.kind === 'list') {
      appendVary(reply, 'Origin');
      if (isPreflight) appendVary(reply, 'Access-Control-Request-Headers');
    }
    const origin = req.headers.origin;
    if (!origin) return;
    if (policy.kind === 'list' && !policy.origins.has(origin)) return;
    reply.header('access-control-allow-origin', policy.kind === 'any' ? '*' : origin);
    if (!isPreflight) return;
    return reply
      .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      .header('access-control-allow-headers', req.headers['access-control-request-headers'] ?? 'authorization, content-type')
      .header('access-control-max-age', '600')
      .status(204)
      .send();
  });
}
