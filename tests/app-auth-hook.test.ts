import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SESSION_COOKIE } from '../src/server/routes/auth.js';
import { startServer, type TestServer } from './helpers.js';

const FORBIDDEN = { error: { code: 'forbidden', message: 'this key is scoped to its attempt and cannot access this endpoint' } };
const UNAUTHENTICATED = { error: { code: 'unauthenticated', message: 'authentication required' } };

describe('auth hook rejection paths', () => {
  let server: TestServer;
  let attemptToken: string;
  let readToken: string;
  let cookies: Record<string, string>;

  beforeAll(async () => {
    server = await startServer();
    attemptToken = (await server.app.ctx.auth.createKey('scoped', { scope: 'attempt' })).token;
    readToken = (await server.app.ctx.auth.createKey('reader', { scope: 'read' })).token;
    cookies = { [SESSION_COOKIE]: server.app.ctx.auth.createSession() };
  });
  afterAll(async () => {
    await server.close();
  });

  const inject = (url: string, headers: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET') =>
    server.app.inject({ method, url, headers });

  it('403s an attempt-scoped bearer key on an operator route', async () => {
    const res = await inject('/api/keys', { authorization: `Bearer ${attemptToken}` });
    expect([res.statusCode, res.json()]).toEqual([403, FORBIDDEN]);
  });

  it('403s a read key on a mutation, 200s it on an allowed GET', async () => {
    const auth = { authorization: `Bearer ${readToken}` };
    expect((await inject('/api/tasks', auth, 'POST')).statusCode).toBe(403);
    expect((await inject('/api/tasks', auth)).statusCode).toBe(200);
  });

  it('401s a garbage bearer key', async () => {
    const res = await inject('/api/tasks', { authorization: 'Bearer nope' });
    expect([res.statusCode, res.json()]).toEqual([401, UNAUTHENTICATED]);
  });

  it('401s a non-Bearer authorization header', async () => {
    const res = await inject('/api/tasks', { authorization: `Basic ${attemptToken}` });
    expect(res.statusCode).toBe(401);
  });

  it('lets a valid session cookie through even when a scoped bearer key was rejected', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/keys',
      cookies,
      headers: { authorization: `Bearer ${attemptToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('403s a scoped key offered as a WebSocket subprotocol', async () => {
    const res = await inject('/api/ws', { 'sec-websocket-protocol': attemptToken });
    expect([res.statusCode, res.json()]).toEqual([403, FORBIDDEN]);
  });

  it('401s a bad or empty WebSocket subprotocol', async () => {
    expect((await inject('/api/ws', { 'sec-websocket-protocol': 'bad' })).statusCode).toBe(401);
    expect((await inject('/api/ws', { 'sec-websocket-protocol': ' ' })).statusCode).toBe(401);
  });

  it('keeps a rejected bearer scope verdict when the WebSocket token is invalid', async () => {
    const res = await inject('/api/ws', { authorization: `Bearer ${attemptToken}`, 'sec-websocket-protocol': 'bad' });
    expect(res.statusCode).toBe(403);
  });

  it('only honours the subprotocol token on /api/ws', async () => {
    const res = await inject('/api/tasks', { 'sec-websocket-protocol': server.sessionToken });
    expect(res.statusCode).toBe(401);
  });

  it('skips public and non-API paths', async () => {
    expect((await inject('/api/openapi.json')).statusCode).toBe(200);
    expect((await inject('/api/auth/me')).statusCode).not.toBe(401);
    expect((await inject('/some-spa-route')).statusCode).not.toBe(401);
  });
});
