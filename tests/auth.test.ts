import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { settings } from '../src/db/schema.js';
import { startServer, TEST_PASSWORD, type TestServer } from './helpers.js';

describe('auth and api keys', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('rejects unauthenticated requests on every API surface', async () => {
    expect((await server.anonApi('GET', '/api/tasks')).status).toBe(401);
    expect((await server.anonApi('POST', '/api/tasks', { prompt: 'p' })).status).toBe(401);
    expect((await server.anonApi('GET', '/api/config')).status).toBe(401);
    expect((await server.anonApi('GET', '/api/keys')).status).toBe(401);

    // WebSocket upgrades are gated too.
    const ws = new WebSocket(server.baseUrl.replace('http', 'ws') + '/api/ws');
    const failed = await new Promise<boolean>((resolve) => {
      ws.addEventListener('error', () => resolve(true));
      ws.addEventListener('open', () => resolve(false));
    });
    expect(failed).toBe(true);
  });

  it('logs in with the operator password set at boot, and out again', async () => {
    const wrong = await server.anonApi('POST', '/api/auth/login', { password: 'nope' });
    expect(wrong.status).toBe(401);

    const login = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('agentdeck_session=');
    expect(cookie).toContain('HttpOnly');

    const sessionCookie = cookie.split(';')[0]!;
    const me = await fetch(`${server.baseUrl}/api/auth/me`, { headers: { cookie: sessionCookie } });
    expect(((await me.json()) as { authenticated: boolean }).authenticated).toBe(true);

    const logout = await fetch(`${server.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    expect(logout.status).toBe(200);
    const after = await fetch(`${server.baseUrl}/api/tasks`, { headers: { cookie: sessionCookie } });
    expect(after.status).toBe(401);
  });

  it('the password hash at rest is not the password', async () => {
    const row = server.app.ctx.db.select().from(settings).where(eq(settings.key, 'auth')).get()!;
    expect(row.value).not.toContain(TEST_PASSWORD);
    expect(JSON.parse(row.value)).toHaveProperty('hash');
    expect(JSON.parse(row.value)).toHaveProperty('salt');
  });

  it('creates, uses, lists, and revokes bearer API keys with last-used tracking', async () => {
    const created = await server.api('POST', '/api/keys', { name: 'ci-bot' });
    expect(created.status).toBe(201);
    const token = created.body.token;
    expect(token).toMatch(/^adk_/);

    // The token authenticates REST calls.
    const viaKey = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaKey.status).toBe(200);

    const list = await server.api('GET', '/api/keys');
    const key = list.body.keys.find((k: any) => k.id === created.body.id);
    expect(key.name).toBe('ci-bot');
    expect(key.lastUsedAt).toBeGreaterThan(0);
    expect(key.token).toBeUndefined();
    expect(key.tokenHash).toBeUndefined();

    // Revocation is immediate.
    expect((await server.api('DELETE', `/api/keys/${created.body.id}`)).status).toBe(200);
    const revoked = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(401);
  });

  it('garbage bearer tokens are rejected', async () => {
    const res = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: 'Bearer adk_0000000000000000000000000000000000000000000000' },
    });
    expect(res.status).toBe(401);
  });
});
