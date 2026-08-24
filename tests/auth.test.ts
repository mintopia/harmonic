import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('runs ungated when no operator password is set — every surface is open', async () => {
    const open = await startServer(undefined, { password: '' });
    try {
      expect(await open.app.ctx.auth.hasPassword()).toBe(false);
      expect((await open.anonApi('GET', '/api/tasks')).status).toBe(200);
      expect((await open.anonApi('POST', '/api/tasks', { prompt: 'p' })).status).toBe(201);
      expect((await open.anonApi('GET', '/api/config')).status).toBe(200);
      // The SPA reads this to skip its login screen.
      expect((await open.anonApi('GET', '/api/auth/me')).body).toMatchObject({ passwordConfigured: false });
    } finally {
      await open.close();
    }
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
    expect(cookie).toContain('harmonic_session=');
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

  it('removes the operator password, falling back to ungated', async () => {
    const s = await startServer();
    try {
      // Wrong current password changes nothing.
      expect((await s.api('DELETE', '/api/auth/password', { currentPassword: 'nope' })).status).toBe(401);
      expect(await s.app.ctx.auth.hasPassword()).toBe(true);

      expect((await s.api('DELETE', '/api/auth/password', { currentPassword: TEST_PASSWORD })).status).toBe(200);
      expect(await s.app.ctx.auth.hasPassword()).toBe(false);
      // Now ungated: an unauthenticated request goes through.
      expect((await s.anonApi('GET', '/api/tasks')).status).toBe(200);
      // Removing again is idempotent.
      expect((await s.anonApi('DELETE', '/api/auth/password', { currentPassword: '' })).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('sets the initial password on an ungated install (currentPassword ignored)', async () => {
    const s = await startServer(undefined, { password: '' });
    try {
      expect(await s.app.ctx.auth.hasPassword()).toBe(false);
      expect((await s.anonApi('POST', '/api/auth/change-password', { currentPassword: '', newPassword: 'hunter2' })).status).toBe(200);
      expect(await s.app.ctx.auth.hasPassword()).toBe(true);
      // Gate is back on: unauthenticated is rejected, the new password logs in.
      expect((await s.anonApi('GET', '/api/tasks')).status).toBe(401);
      expect((await s.anonApi('POST', '/api/auth/login', { password: 'hunter2' })).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('an empty boot password clears a previously-set one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-clearpw-'));
    try {
      const withPw = await startServer(undefined, { dataDir: dir, password: 'secret1' });
      expect(await withPw.app.ctx.auth.hasPassword()).toBe(true);
      await withPw.close();

      const cleared = await startServer(undefined, { dataDir: dir, password: '' });
      expect(await cleared.app.ctx.auth.hasPassword()).toBe(false);
      await cleared.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the password hash at rest is not the password', async () => {
    const row = (await server.app.ctx.asyncDb.read((d) => d.select().from(settings).where(eq(settings.key, 'auth')).get()))!;
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

  it('accepts query tokens for WebSocket upgrades but not HTTP API requests', async () => {
    const apiWithQueryToken = await fetch(`${server.baseUrl}/api/keys?token=${server.sessionToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'query-token' }),
    });
    expect(apiWithQueryToken.status).toBe(401);

    const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener('error', () => resolve(false));
      ws.addEventListener('open', () => {
        ws.close();
        resolve(true);
      });
    });
    expect(opened).toBe(true);
  });

  it('password-only login works even when a legacy auth record carries a username', async () => {
    const legacy = await startServer();
    const row = (await legacy.app.ctx.asyncDb.read((d) => d.select().from(settings).where(eq(settings.key, 'auth')).get()))!;
    const value = JSON.stringify({ ...JSON.parse(row.value), username: 'jess' });
    await legacy.app.ctx.asyncDb.write((d) => d.update(settings).set({ value }).where(eq(settings.key, 'auth')).run());
    expect((await legacy.anonApi('POST', '/api/auth/login', { password: TEST_PASSWORD })).status).toBe(200);
    await legacy.close();
  });

  it('a stray username in the login body is ignored', async () => {
    expect(
      (await server.anonApi('POST', '/api/auth/login', { username: 'whoever', password: TEST_PASSWORD })).status,
    ).toBe(200);
  });

  it('garbage bearer tokens are rejected', async () => {
    const res = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: 'Bearer adk_0000000000000000000000000000000000000000000000' },
    });
    expect(res.status).toBe(401);
  });

  // Migrating routes to zod-declared schemas (ADR-0005) must not change the
  // error contract callers already depend on: a malformed body is still a
  // 400 with `{ error: { code: 'validation', message } }`, whether it's
  // rejected by a route's declared schema or an ad-hoc `z.object().parse()`.
  it('a malformed body on a zod-schema route returns the standard validation error shape', async () => {
    const missingPassword = await server.anonApi('POST', '/api/auth/login', {});
    expect(missingPassword.status).toBe(400);
    expect(missingPassword.body.error.code).toBe('validation');
    expect(typeof missingPassword.body.error.message).toBe('string');
    expect(missingPassword.body.error.message.length).toBeGreaterThan(0);

    const wrongType = await server.anonApi('POST', '/api/auth/login', { password: 42 });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('validation');
  });

  it('a malformed body creating an api key returns the standard validation error shape', async () => {
    const res = await server.api('POST', '/api/keys', { name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation');
  });
});
