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

  // Regression: every `.meta({ id })` schema emits a `$ref` at each use site,
  // but nothing wrote the targets into components.schemas until app.ts passed
  // `transformObject`. The spec still served 200 and the UI still rendered —
  // it just showed a literal {"$ref": …}, and codegen against it would break.
  it('resolves every $ref it emits — a dangling pointer is an invalid spec', async () => {
    const doc = (await server.anonApi('GET', '/api/openapi.json')).body;
    const defined = new Set(Object.keys(doc.components?.schemas ?? {}));
    expect(defined.size).toBeGreaterThan(0);
    const used = [...new Set((JSON.stringify(doc).match(/#\/components\/schemas\/[A-Za-z0-9_]+/g) ?? []))].map(
      (ref) => ref.split('/').pop() as string,
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });

  it('gives every response its own description rather than the "Default Response" filler', async () => {
    const doc = (await server.anonApi('GET', '/api/openapi.json')).body;
    const filler: string[] = [];
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        for (const [code, res] of Object.entries<any>(op?.responses ?? {})) {
          if (!res.description || res.description === 'Default Response') {
            filler.push(`${method.toUpperCase()} ${path} ${code}`);
          }
        }
      }
    }
    expect(filler).toEqual([]);
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
    expect(tagsOf('/api/tasks/{id}/run', 'post')).toContain('Attempts');
    expect(tagsOf('/api/attempts/{id}', 'get')).toContain('Attempts');
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
    expect(doc.paths['/api/attempts/{id}'].get.description).toContain('Reachable with a run-scoped Run Key');

    // Accept/reject: human-only, always (#140, ADR-0021 retired the agentReview flag).
    expect(doc.paths['/api/tasks/{id}/accept'].post.description).toContain('Human-only');
    expect(doc.paths['/api/tasks/{id}/reject'].post.description).toContain('Human-only');
    expect(doc.paths['/api/tasks/{id}/accept'].post.description).not.toContain('agentReview');
    expect(doc.paths['/api/tasks/{id}/reject'].post.description).not.toContain('agentReview');

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
    const res = await server.api('GET', '/api/attempts/not-a-number');
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
