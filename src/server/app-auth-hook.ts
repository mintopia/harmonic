import { SESSION_COOKIE } from './routes/auth.js';
import type { AuthService } from './auth.js';
import type { App } from './app-context.js';

export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/api/auth/me',
  '/api/openapi.json',
  '/api/openapi.yaml',
]);

export function scopedKeyAllowed(path: string): boolean {
  if (path.startsWith('/mcp')) return true;
  if (/^\/api\/tasks\/\d+\/complete$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/steer$/.test(path)) return false;
  if (/^\/api\/workspaces\/\d+\/epics\/\d+\/force-integrate$/.test(path)) return false;
  if (/^\/api\/workspaces\/\d+\/epics\/\d+\/reject$/.test(path)) return false;
  if (/^\/api\/workspaces\/\d+\/epics(\/\d+)?$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/(accept|reject|close)$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/channels(\/|$)/.test(path)) return false;
  if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return true;
  if (path.startsWith('/api/attempts')) return true;
  return false;
}

export function readScopeAllowed(path: string, method: string): boolean {
  if (method !== 'GET') return false;
  if (path === '/api/ws') return true;
  if (/^\/api\/workspaces\/\d+\/epics(\/\d+)?$/.test(path)) return false;
  if (/^\/api\/tasks\/\d+\/channels(\/|$)/.test(path)) return false;
  if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return true;
  if (path.startsWith('/api/attempts')) return true;
  if (path === '/api/maps' || path.startsWith('/api/maps/')) return true;
  if (path === '/api/activity') return true;
  if (path === '/api/operations') return true;
  if (path === '/api/scheduled-jobs') return true;
  return false;
}

export function registerAuthHook(app: App, auth: AuthService): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
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
    if (auth.validateSession(req.cookies[SESSION_COOKIE])) return;
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
