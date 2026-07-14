import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { startServer, type TestServer } from './helpers.js';

describe('openapi spec', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('serves openapi.json publicly, parsed as an OpenAPI 3.x document with paths', async () => {
    const res = await server.anonApi('GET', '/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body;
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });

  it('serves openapi.yaml publicly, parsed as the same OpenAPI 3.x document', async () => {
    const res = await fetch(`${server.baseUrl}/api/openapi.yaml`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const doc = parseYaml(text) as any;
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });

  it('declares both the bearer API key and session cookie security schemes', async () => {
    const doc = (await server.anonApi('GET', '/api/openapi.json')).body;
    const schemes = doc.components.securitySchemes;
    expect(schemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(schemes.sessionCookie).toMatchObject({ type: 'apiKey', in: 'cookie' });
  });

  it('documents the migrated auth and keys routes with request and response schemas', async () => {
    const doc = (await server.anonApi('GET', '/api/openapi.json')).body;

    const login = doc.paths['/api/auth/login'].post;
    expect(login.tags).toContain('Auth');
    expect(login.requestBody).toBeTruthy();
    expect(login.responses['200']).toBeTruthy();
    expect(login.responses['401']).toBeTruthy();

    const keys = doc.paths['/api/keys'];
    expect(keys.post.tags).toContain('Keys');
    expect(keys.post.requestBody).toBeTruthy();
    expect(keys.post.responses['201']).toBeTruthy();
    expect(keys.get.responses['200']).toBeTruthy();

    const keyById = doc.paths['/api/keys/{id}'];
    expect(keyById.delete.responses['200']).toBeTruthy();
  });
});
