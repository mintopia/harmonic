import type { App } from './app-context.js';

export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter((origin) => origin !== '');
}

/** Bearer-only CORS: credentials are never allowed, so `*` is safe for Read Key viewers. Must be registered before the auth hook so preflights skip it. */
export function registerCors(app: App, origins: readonly string[]): void {
  if (origins.length === 0) return;
  const allowAll = origins.includes('*');
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || (!allowAll && !origins.includes(origin))) return;
    reply.header('access-control-allow-origin', allowAll ? '*' : origin);
    if (!allowAll) reply.header('vary', 'Origin');
    if (req.method !== 'OPTIONS' || !req.headers['access-control-request-method']) return;
    return reply
      .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      .header('access-control-allow-headers', req.headers['access-control-request-headers'] ?? 'authorization, content-type')
      .header('access-control-max-age', '600')
      .status(204)
      .send();
  });
}
