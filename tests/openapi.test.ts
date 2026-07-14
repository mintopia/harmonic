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

  it('documents every registered /api route Fastify actually serves, against its own routing table', async () => {
    const doc = (await server.anonApi('GET', '/api/openapi.json')).body;
    // Fastify's `:name` params become OpenAPI's `{name}` in the generated spec.
    const toSpecPath = (url: string) => url.replace(/:([A-Za-z]+)/g, '{$1}');
    // Deliberately outside the spec's paths (ADR-0005): the spec-of-the-spec
    // endpoints, and MCP/WebSocket, documented in info.description prose instead.
    const excluded = new Set(['/api/openapi.json', '/api/openapi.yaml', '/api/ws']);

    const apiRoutes = server.app.registeredRoutes.filter(
      (r) => r.url.startsWith('/api') && r.method !== 'HEAD' && !excluded.has(r.url),
    );
    expect(apiRoutes.length).toBeGreaterThan(20); // sanity: the filter isn't vacuously empty

    for (const route of apiRoutes) {
      const specPath = toSpecPath(route.url);
      const pathEntry = doc.paths[specPath];
      expect(pathEntry, `${route.method} ${route.url} (spec path ${specPath}) missing from openapi paths`).toBeTruthy();
      const operation = pathEntry?.[route.method.toLowerCase()];
      expect(operation, `${route.method} ${specPath} missing from openapi spec`).toBeTruthy();
      expect(operation.responses, `${route.method} ${specPath} has no response schema`).toBeTruthy();
      expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
    }

    // MCP and the WebSocket are documented, just not as paths.
    expect(doc.info.description).toContain('MCP');
    expect(doc.info.description).toContain('WebSocket');
    expect(doc.paths['/mcp']).toBeUndefined();
  });

  it('groups endpoints under their documented area tags', async () => {
    const doc = (await server.anonApi('GET', '/api/openapi.json')).body;
    const tagsOf = (path: string, method: string) => doc.paths[path][method].tags;

    expect(tagsOf('/api/tasks', 'post')).toContain('Tasks');
    expect(tagsOf('/api/tasks/{id}/accept', 'post')).toContain('Tasks');
    expect(tagsOf('/api/tasks/{id}/run', 'post')).toContain('Runs');
    expect(tagsOf('/api/runs/{id}', 'get')).toContain('Runs');
    expect(tagsOf('/api/config', 'get')).toContain('Config');
    expect(tagsOf('/api/channels', 'get')).toContain('Channels');
    expect(tagsOf('/api/tasks/{id}/channels', 'get')).toContain('Channels');
    expect(tagsOf('/api/stats', 'get')).toContain('Stats');
    expect(tagsOf('/api/auth/login', 'post')).toContain('Auth');
    expect(tagsOf('/api/keys', 'get')).toContain('Keys');
  });

  it('states Run Key reachability in each migrated endpoint description', async () => {
    const doc = (await server.anonApi('GET', '/api/openapi.json')).body;

    // Reachable with a run-scoped Run Key: the agent task/run surface.
    expect(doc.paths['/api/tasks'].post.description).toContain('Reachable with a run-scoped Run Key');
    expect(doc.paths['/api/tasks/{id}/run'].post.description).toContain('Reachable with a run-scoped Run Key');
    expect(doc.paths['/api/runs/{id}'].get.description).toContain('Reachable with a run-scoped Run Key');

    // Accept/reject: gated on the agentReview config flag, not flatly denied or allowed.
    expect(doc.paths['/api/tasks/{id}/accept'].post.description).toContain('agentReview');
    expect(doc.paths['/api/tasks/{id}/reject'].post.description).toContain('agentReview');

    // Operator-only: config, channels (including the per-task channel overrides), stats, keys.
    expect(doc.paths['/api/config'].get.description).toContain('Operator only');
    expect(doc.paths['/api/config'].patch.description).toContain('Operator only');
    expect(doc.paths['/api/channels'].post.description).toContain('Operator only');
    expect(doc.paths['/api/tasks/{id}/channels'].post.description).toContain('Operator only');
    expect(doc.paths['/api/stats'].get.description).toContain('Operator only');
  });
});

describe('validation error contract on migrated routes', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('tasks: rejects a malformed body with a 400 validation envelope', async () => {
    const res = await server.api('POST', '/api/tasks', { prompt: 42 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation' } });
    expect(typeof res.body.error.message).toBe('string');
  });

  it('runs: rejects a malformed :id param with a 400 validation envelope', async () => {
    const res = await server.api('GET', '/api/runs/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation' } });
  });

  it('config: rejects a malformed patch body with a 400 validation envelope', async () => {
    const res = await server.api('PATCH', '/api/config', { autoRunner: { maxConcurrentRuns: 'two' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation' } });
  });

  it('channels: rejects an unknown channel type with a 400 validation envelope', async () => {
    const res = await server.api('POST', '/api/channels', { name: 'x', type: 'carrier-pigeon', config: {} });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation' } });
  });
});
