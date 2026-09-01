import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { settings } from '../src/db/schema.js';
import { startServer, TEST_PASSWORD, type TestServer } from './helpers.js';

async function loginAs(server: TestServer, password: string): Promise<string | null> {
  const res = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) return null;
  const cookie = res.headers.get('set-cookie')!;
  return cookie.split(';')[0]!;
}

describe('change operator password', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('rejects the wrong current password and changes nothing', async () => {
    const res = await server.api('POST', '/api/auth/change-password', {
      currentPassword: 'not-it',
      newPassword: 'brand-new-pw',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');

    expect(await loginAs(server, TEST_PASSWORD)).not.toBeNull();
    expect(await loginAs(server, 'brand-new-pw')).toBeNull();
  });

  it('rejects a new password shorter than the minimum with a validation error', async () => {
    const res = await server.api('POST', '/api/auth/change-password', {
      currentPassword: TEST_PASSWORD,
      newPassword: 'abc',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation');

    expect(await loginAs(server, TEST_PASSWORD)).not.toBeNull();
  });

  it('a malformed body returns the standard validation error shape', async () => {
    const res = await server.api('POST', '/api/auth/change-password', { currentPassword: TEST_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation');
    expect(typeof res.body.error.message).toBe('string');
  });

  it('changes the password, destroys every other session, and keeps the caller logged in', async () => {
    const fresh = await startServer();

    const cookieA = (await loginAs(fresh, TEST_PASSWORD))!;
    const cookieB = (await loginAs(fresh, TEST_PASSWORD))!;
    expect(cookieA).not.toBe(cookieB);

    const meA0 = await fetch(`${fresh.baseUrl}/api/auth/me`, { headers: { cookie: cookieA } });
    expect(((await meA0.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const meB0 = await fetch(`${fresh.baseUrl}/api/auth/me`, { headers: { cookie: cookieB } });
    expect(((await meB0.json()) as { authenticated: boolean }).authenticated).toBe(true);

    const change = await fetch(`${fresh.baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'a-new-password' }),
    });
    expect(change.status).toBe(200);
    expect((await change.json()) as { ok: boolean }).toEqual({ ok: true });

    const meA1 = await fetch(`${fresh.baseUrl}/api/auth/me`, { headers: { cookie: cookieA } });
    expect(((await meA1.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const tasksA = await fetch(`${fresh.baseUrl}/api/tasks`, { headers: { cookie: cookieA } });
    expect(tasksA.status).toBe(200);

    const tasksB = await fetch(`${fresh.baseUrl}/api/tasks`, { headers: { cookie: cookieB } });
    expect(tasksB.status).toBe(401);

    expect(await loginAs(fresh, 'a-new-password')).not.toBeNull();
    expect(await loginAs(fresh, TEST_PASSWORD)).toBeNull();

    await fresh.close();
  });

  it('leaves existing API keys untouched by a password change', async () => {
    const fresh = await startServer();
    const cookie = (await loginAs(fresh, TEST_PASSWORD))!;

    const created = await fetch(`${fresh.baseUrl}/api/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'ci-bot' }),
    });
    const { token } = (await created.json()) as { token: string };

    const change = await fetch(`${fresh.baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'a-new-password' }),
    });
    expect(change.status).toBe(200);

    const viaKey = await fetch(`${fresh.baseUrl}/api/tasks`, { headers: { authorization: `Bearer ${token}` } });
    expect(viaKey.status).toBe(200);

    await fresh.close();
  });

  it('the new password hash at rest never contains the plaintext', async () => {
    const fresh = await startServer();
    const cookie = (await loginAs(fresh, TEST_PASSWORD))!;
    const newPassword = 'super-secret-new-password';

    const change = await fetch(`${fresh.baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword }),
    });
    expect(change.status).toBe(200);

    const row = (await fresh.app.ctx.asyncDb.read((d) =>
      d.select().from(settings).where(eq(settings.key, 'auth')).get(),
    ))!;
    expect(row.value).not.toContain(newPassword);
    expect(JSON.parse(row.value)).toHaveProperty('hash');
    expect(JSON.parse(row.value)).toHaveProperty('salt');

    await fresh.close();
  });
});
