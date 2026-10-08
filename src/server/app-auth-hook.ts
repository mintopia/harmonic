import { SESSION_COOKIE } from './routes/auth.js';
import type { AuthService } from './auth.js';
import type { App } from './app-context.js';
import { isPreflight } from './cors.js';
import { readScopeAllowed, scopedKeyAllowed } from './key-scopes.js';

export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/api/auth/me',
  '/api/openapi.json',
  '/api/openapi.yaml',
]);

// SameSite=Strict still sends the cookie from sibling subdomains, so compare Origin to Host.
function originMismatch(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export function registerAuthHook(app: App, auth: AuthService): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.routeOptions.url ?? req.url.split('?')[0] ?? req.url;
    if (isPreflight(req)) return;
    if ((!path.startsWith('/api') && !path.startsWith('/mcp')) || PUBLIC_API_PATHS.has(path)) return;

    if (!(await auth.hasPassword())) return;

    const forbidden = () =>
      reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'this key is scoped to its attempt and cannot access this endpoint' } });

    const scopeAllows = (scope: string): boolean =>
      scope === 'full' ||
      (scope === 'read'
        ? readScopeAllowed(path, req.method)
        : scopedKeyAllowed(path));

    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    let scopedKeyRejected = false;
    if (bearer) {
      const key = await auth.verifyKey(bearer);
      if (key) {
        if (scopeAllows(key.scope)) return;
        scopedKeyRejected = true;
      }
    }
    if (auth.validateSession(req.cookies[SESSION_COOKIE])) {
      if (originMismatch(req.headers.origin, req.headers.host)) {
        return reply.status(403).send({ error: { code: 'forbidden', message: 'cross-origin request rejected' } });
      }
      return;
    }
    if (path === '/api/ws') {
      const wsToken = req.headers['sec-websocket-protocol']?.split(',')[0]?.trim();
      if (wsToken) {
        if (auth.validateSession(wsToken)) return;
        const key = await auth.verifyKey(wsToken);
        if (key) {
          if (scopeAllows(key.scope)) return;
          scopedKeyRejected = true;
        }
      }
    }

    if (scopedKeyRejected) return forbidden();
    return reply.status(401).send({ error: { code: 'unauthenticated', message: 'authentication required' } });
  });
}
