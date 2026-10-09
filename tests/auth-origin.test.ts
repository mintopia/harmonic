import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SESSION_COOKIE } from '../src/server/routes/auth.js';
import { startServer, type TestServer } from './helpers.js';

describe('cookie-authenticated requests with a foreign Origin', () => {
  let server: TestServer;
  let cookies: Record<string, string>;
  const host = 'harmonic.example.test';

  beforeAll(async () => {
    server = await startServer();
    cookies = { [SESSION_COOKIE]: server.app.ctx.auth.createSession() };
  });
  afterAll(async () => {
    await server.close();
  });

  it('rejects a bodyless POST whose Origin host differs from Host', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/worktrees/1/cleanup',
      cookies,
      headers: { host, origin: 'https://evil.example.test' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a GET with a mismatched Origin', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/tasks',
      cookies,
      headers: { host, origin: 'https://evil.example.test' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a cookie-authenticated WebSocket upgrade with a mismatched Origin', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/ws',
      cookies,
      headers: { host, origin: 'https://evil.example.test', connection: 'upgrade', upgrade: 'websocket' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows a same-origin request', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/tasks',
      cookies,
      headers: { host, origin: `https://${host}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('allows an Origin matching X-Forwarded-Host when the proxy rewrote Host', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/tasks',
      cookies,
      headers: { host: 'internal.local:3000', 'x-forwarded-host': `${host}, hop.example.test`, origin: `https://${host}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects an Origin matching neither Host nor X-Forwarded-Host', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      cookies,
      headers: { host: 'internal.local:3000', 'x-forwarded-host': host, origin: 'https://evil.example.test' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows a request with no Origin header', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/api/tasks', cookies, headers: { host } });
    expect(response.statusCode).toBe(200);
  });

  it('still allows key-authenticated requests with a foreign Origin', async () => {
    const { token } = await server.app.ctx.auth.createKey('origin test', { scope: 'full' });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { host, origin: 'https://other.example.test', authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });
});
