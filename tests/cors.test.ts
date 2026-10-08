import { describe, it, expect, afterEach } from 'vitest';
import { parseCorsOrigins } from '../src/server/cors.js';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('parseCorsOrigins', () => {
  it('is off when unset or blank', () => {
    expect(parseCorsOrigins(undefined)).toEqual({ kind: 'off' });
    expect(parseCorsOrigins(' , ')).toEqual({ kind: 'off' });
  });

  it('treats * as any, even alongside other entries', () => {
    expect(parseCorsOrigins('*')).toEqual({ kind: 'any' });
    expect(parseCorsOrigins('https://a.example, *')).toEqual({ kind: 'any' });
  });

  it('normalises trailing slashes and whitespace', () => {
    expect(parseCorsOrigins(' https://viz.example/ , http://localhost:5173 ')).toEqual({
      kind: 'list',
      origins: new Set(['https://viz.example', 'http://localhost:5173']),
    });
  });

  it('rejects entries that are not bare origins, naming the entry', () => {
    expect(() => parseCorsOrigins('viz.example')).toThrow(/"viz\.example"/);
    expect(() => parseCorsOrigins('https://x/path')).toThrow(/"https:\/\/x\/path"/);
    expect(() => parseCorsOrigins('https://x?q=1')).toThrow(/https:\/\/x\?q=1/);
    expect(() => parseCorsOrigins('https://:pw@x')).toThrow(/https:\/\/:pw@x/);
    expect(() => parseCorsOrigins('https://u@x')).toThrow(/https:\/\/u@x/);
  });
});

describe('CORS responses', () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const preflight = (origin: string) =>
    fetch(`${server!.baseUrl}/api/tasks`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });

  it('allows any origin under a * policy without varying', async () => {
    server = await startServer(stubHarness(), { corsOrigins: parseCorsOrigins('*') });
    const res = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${server.sessionToken}`, origin: 'https://anything.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('vary')).toBeNull();
  });

  it('echoes an allowed origin under a list policy and varies on Origin', async () => {
    server = await startServer(stubHarness(), { corsOrigins: parseCorsOrigins('https://viz.example') });
    const res = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${server.sessionToken}`, origin: 'https://viz.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://viz.example');
    expect(res.headers.get('vary')).toMatch(/Origin/);
  });

  it('omits the allow header for a disallowed or absent origin but still varies on Origin', async () => {
    server = await startServer(stubHarness(), { corsOrigins: parseCorsOrigins('https://viz.example') });
    const headers = { authorization: `Bearer ${server.sessionToken}` };
    const other = await fetch(`${server.baseUrl}/api/tasks`, { headers: { ...headers, origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect(other.headers.get('vary')).toMatch(/Origin/);
    const none = await fetch(`${server.baseUrl}/api/tasks`, { headers });
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
    expect(none.headers.get('vary')).toMatch(/Origin/);
  });

  it('appends to an existing Vary header instead of replacing it', async () => {
    server = await startServer(stubHarness(), { corsOrigins: parseCorsOrigins('https://viz.example') });
    const res = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${server.sessionToken}`, origin: 'https://viz.example', 'accept-encoding': 'gzip' },
    });
    const vary = (res.headers.get('vary') ?? '').split(',').map((v) => v.trim().toLowerCase());
    expect(vary.filter((v) => v === 'origin')).toHaveLength(1);
  });

  it('answers an allowed preflight with 204, methods, headers, and both Vary entries', async () => {
    server = await startServer(stubHarness(), { corsOrigins: parseCorsOrigins('https://viz.example') });
    const res = await preflight('https://viz.example');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://viz.example');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization');
    expect(res.headers.get('vary')).toMatch(/Origin/);
    expect(res.headers.get('vary')).toMatch(/Access-Control-Request-Headers/);
  });

  it('does not grant a preflight from a disallowed origin', async () => {
    server = await startServer(stubHarness(), { corsOrigins: parseCorsOrigins('https://viz.example') });
    const res = await preflight('https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('carries the allow header on a 401 for an allowed origin', async () => {
    server = await startServer(stubHarness(), { corsOrigins: parseCorsOrigins('https://viz.example') });
    const res = await fetch(`${server.baseUrl}/api/tasks`, { headers: { origin: 'https://viz.example' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://viz.example');
  });

  it('still requires auth for a non-preflight OPTIONS', async () => {
    server = await startServer(stubHarness(), { corsOrigins: parseCorsOrigins('https://viz.example') });
    const res = await fetch(`${server.baseUrl}/api/tasks`, { method: 'OPTIONS', headers: { origin: 'https://viz.example' } });
    expect(res.status).toBe(401);
  });

  it('lets a preflight through without auth even when CORS is off', async () => {
    server = await startServer(stubHarness());
    const res = await fetch(`${server.baseUrl}/api/tasks`, {
      method: 'OPTIONS',
      headers: { origin: 'https://viz.example', 'access-control-request-method': 'GET' },
    });
    expect(res.status).not.toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
