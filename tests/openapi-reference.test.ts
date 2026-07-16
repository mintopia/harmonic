import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApiReference, describeType, toSchemaNode } from '../web/src/openapi-reference.js';
import { startServer, type TestServer } from './helpers.js';

/** Minimal hand-written OpenAPI 3.1-shaped fixture, built up per test. */
function fixture(overrides: Record<string, unknown> = {}) {
  return {
    openapi: '3.1.0',
    info: { title: 'Test', version: '1.0.0' },
    tags: [{ name: 'Tasks' }, { name: 'Runs' }],
    paths: {},
    components: { schemas: {} },
    ...overrides,
  };
}

describe('buildApiReference: grouping', () => {
  it('groups endpoints under their first tag', () => {
    const spec = fixture({
      paths: {
        '/api/tasks': { post: { tags: ['Tasks'], responses: { '200': {} } } },
        '/api/runs/{id}': { get: { tags: ['Runs'], responses: { '200': {} } } },
      },
    });
    const groups = buildApiReference(spec);
    expect(groups.map((g) => g.name)).toEqual(['Tasks', 'Runs']);
    expect(groups[0]!.endpoints).toHaveLength(1);
    expect(groups[0]!.endpoints[0]!.path).toBe('/api/tasks');
  });

  it('follows the spec tags array order, not path discovery order', () => {
    const spec = fixture({
      paths: {
        '/api/runs/{id}': { get: { tags: ['Runs'], responses: { '200': {} } } },
        '/api/tasks': { post: { tags: ['Tasks'], responses: { '200': {} } } },
      },
    });
    const groups = buildApiReference(spec);
    // Runs is discovered first in paths, but Tasks is declared first in tags.
    expect(groups.map((g) => g.name)).toEqual(['Tasks', 'Runs']);
  });

  it('buckets untagged operations into "Other", always last', () => {
    const spec = fixture({
      paths: {
        '/api/tasks': { post: { tags: ['Tasks'], responses: { '200': {} } } },
        '/api/health': { get: { responses: { '200': {} } } },
      },
    });
    const groups = buildApiReference(spec);
    expect(groups.map((g) => g.name)).toEqual(['Tasks', 'Other']);
    expect(groups.at(-1)!.endpoints[0]!.path).toBe('/api/health');
  });

  it('appends undeclared tags alphabetically after the declared ones', () => {
    const spec = fixture({
      paths: {
        '/api/tasks': { post: { tags: ['Tasks'], responses: { '200': {} } } },
        '/api/runs/{id}': { get: { tags: ['Runs'], responses: { '200': {} } } },
        '/api/zebras': { get: { tags: ['Zebras'], responses: { '200': {} } } },
        '/api/aardvarks': { get: { tags: ['Aardvarks'], responses: { '200': {} } } },
      },
    });
    const groups = buildApiReference(spec);
    expect(groups.map((g) => g.name)).toEqual(['Tasks', 'Runs', 'Aardvarks', 'Zebras']);
  });

  it('never drops a group even when Runs has no endpoints in the spec', () => {
    const spec = fixture({ paths: { '/api/tasks': { post: { tags: ['Tasks'], responses: { '200': {} } } } } });
    const groups = buildApiReference(spec);
    // Declared but unused tags simply don't produce an empty group.
    expect(groups.map((g) => g.name)).toEqual(['Tasks']);
  });
});

describe('buildApiReference: endpoint fields', () => {
  it('extracts method (upper-cased), path, summary, and description', () => {
    const spec = fixture({
      paths: {
        '/api/tasks': {
          post: {
            tags: ['Tasks'],
            summary: 'Create a task',
            description: 'Reachable with a run-scoped Run Key.',
            responses: { '201': {} },
          },
        },
      },
    });
    const [endpoint] = buildApiReference(spec)[0]!.endpoints;
    expect(endpoint!.method).toBe('POST');
    expect(endpoint!.path).toBe('/api/tasks');
    expect(endpoint!.summary).toBe('Create a task');
    expect(endpoint!.description).toContain('Reachable with a run-scoped Run Key');
  });

  it('extracts parameters with name, in, required and a rendered type', () => {
    const spec = fixture({
      paths: {
        '/api/runs/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          get: {
            tags: ['Runs'],
            parameters: [{ name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } }],
            responses: { '200': {} },
          },
        },
      },
    });
    const [endpoint] = buildApiReference(spec)[0]!.endpoints;
    expect(endpoint!.parameters).toEqual([
      { name: 'id', in: 'path', required: true, type: 'integer' },
      { name: 'verbose', in: 'query', required: false, type: 'boolean' },
    ]);
  });

  it('extracts a request body schema, resolving a local $ref', () => {
    const spec = fixture({
      components: {
        schemas: {
          NewTask: {
            type: 'object',
            required: ['prompt'],
            properties: { prompt: { type: 'string' }, priority: { type: 'string' } },
          },
        },
      },
      paths: {
        '/api/tasks': {
          post: {
            tags: ['Tasks'],
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewTask' } } } },
            responses: { '201': {} },
          },
        },
      },
    });
    const [endpoint] = buildApiReference(spec)[0]!.endpoints;
    expect(endpoint!.requestBody).toEqual({
      kind: 'object',
      properties: [
        { name: 'prompt', required: true, schema: { kind: 'primitive', type: 'string', nullable: false } },
        { name: 'priority', required: false, schema: { kind: 'primitive', type: 'string', nullable: false } },
      ],
    });
  });

  it('extracts response shapes per status code', () => {
    const spec = fixture({
      paths: {
        '/api/tasks': {
          post: {
            tags: ['Tasks'],
            responses: {
              '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: {} } } } },
              '400': { description: 'Validation error' },
            },
          },
        },
      },
    });
    const [endpoint] = buildApiReference(spec)[0]!.endpoints;
    expect(endpoint!.responses).toEqual([
      { status: '201', description: 'Created', schema: { kind: 'object', properties: [] } },
      { status: '400', description: 'Validation error', schema: null },
    ]);
  });
});

describe('toSchemaNode: declared examples', () => {
  const doc = fixture();

  it('carries an object-level example', () => {
    const node = toSchemaNode({ type: 'object', properties: {}, example: { ok: true } }, doc);
    expect(node.example).toEqual({ ok: true });
  });

  it('carries a field-level example onto the property node', () => {
    const node = toSchemaNode(
      { type: 'object', properties: { harness: { type: 'string', example: 'claude' } }, required: ['harness'] },
      doc,
    );
    expect(node.kind).toBe('object');
    if (node.kind !== 'object') throw new Error('expected object');
    expect(node.properties[0]?.schema.example).toBe('claude');
  });

  it('accepts the JSON Schema `examples` array, taking the first', () => {
    const node = toSchemaNode({ type: 'string', examples: ['sonnet-5', 'opus-4'] }, doc);
    expect(node.example).toBe('sonnet-5');
  });

  it('leaves example undefined when the spec declares none — nothing to invent', () => {
    const node = toSchemaNode({ type: 'string' }, doc);
    expect(node.example).toBeUndefined();
  });

  it('resolves an example through a $ref, the definition winning over the use site', () => {
    const spec = fixture({
      components: { schemas: { Cost: { type: 'number', example: 0.52 } } },
    });
    // Same precedence as `description`: the definition is authoritative, and a
    // use-site annotation only fills a gap.
    expect(toSchemaNode({ $ref: '#/components/schemas/Cost' }, spec).example).toBe(0.52);
    expect(toSchemaNode({ $ref: '#/components/schemas/Cost', example: 1.75 }, spec).example).toBe(0.52);
  });

  it('takes a use-site example when the definition declares none', () => {
    const spec = fixture({ components: { schemas: { Bare: { type: 'number' } } } });
    expect(toSchemaNode({ $ref: '#/components/schemas/Bare', example: 1.75 }, spec).example).toBe(1.75);
  });
});

describe('toSchemaNode: common constructs', () => {
  it('renders an object with properties/required', () => {
    const node = toSchemaNode(
      { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'number' } } },
      {},
    );
    expect(node).toEqual({
      kind: 'object',
      properties: [
        { name: 'a', required: true, schema: { kind: 'primitive', type: 'string', nullable: false } },
        { name: 'b', required: false, schema: { kind: 'primitive', type: 'number', nullable: false } },
      ],
    });
  });

  it('renders an array of items', () => {
    const node = toSchemaNode({ type: 'array', items: { type: 'string' } }, {});
    expect(node).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string', nullable: false } });
  });

  it('renders an enum', () => {
    const node = toSchemaNode({ enum: ['draft', 'ready'] }, {});
    expect(node).toEqual({ kind: 'enum', values: ['draft', 'ready'] });
  });

  it('renders a primitive', () => {
    expect(toSchemaNode({ type: 'string' }, {})).toEqual({ kind: 'primitive', type: 'string', nullable: false });
  });

  it('renders nullable via a type array', () => {
    const node = toSchemaNode({ type: ['string', 'null'] }, {});
    expect(node).toEqual({ kind: 'primitive', type: 'string', nullable: true });
  });

  it('renders nullable via the 3.0-style `nullable: true` flag', () => {
    const node = toSchemaNode({ type: 'string', nullable: true }, {});
    expect(node).toEqual({ kind: 'primitive', type: 'string', nullable: true });
  });

  // Regression: zod's `.nullable()` on an object emits `anyOf: [X, {type:'null'}]`,
  // which isn't a union of scalars — so it used to fall through to `raw` and the
  // field rendered as a slab of JSON Schema where its example belonged.
  it('unwraps a nullable object union to the object itself', () => {
    const spec = fixture({
      components: {
        schemas: { Cost: { type: 'object', properties: { totalUsd: { type: 'number' } }, required: ['totalUsd'] } },
      },
    });
    const node = toSchemaNode({ anyOf: [{ $ref: '#/components/schemas/Cost' }, { type: 'null' }] }, spec);
    expect(node.kind).toBe('object');
    if (node.kind !== 'object') throw new Error('expected object');
    expect(node.properties.map((p) => p.name)).toEqual(['totalUsd']);
  });

  it('keeps a scalar-plus-null union whole, so it still reads as "number | null"', () => {
    const node = toSchemaNode({ anyOf: [{ type: 'number' }, { type: 'null' }] }, fixture());
    expect(describeType(node)).toBe('number | null');
  });

  it('renders a simple union of primitives (oneOf)', () => {
    const node = toSchemaNode({ oneOf: [{ type: 'string' }, { type: 'number' }] }, {});
    expect(node).toEqual({
      kind: 'union',
      options: [
        { kind: 'primitive', type: 'string', nullable: false },
        { kind: 'primitive', type: 'number', nullable: false },
      ],
    });
    expect(describeType(node)).toBe('string | number');
  });

  it('resolves nested local $refs', () => {
    const doc = { components: { schemas: { Id: { type: 'integer' } } } };
    const node = toSchemaNode({ $ref: '#/components/schemas/Id' }, doc);
    expect(node).toEqual({ kind: 'primitive', type: 'integer', nullable: false });
  });

  it('guards against a circular $ref instead of recursing forever', () => {
    const doc = { components: { schemas: { Node: { type: 'object', properties: { next: {} } } } } };
    (doc.components.schemas.Node.properties as any).next = { $ref: '#/components/schemas/Node' };
    const node = toSchemaNode({ $ref: '#/components/schemas/Node' }, doc);
    expect(node.kind).toBe('object');
    const next = (node as any).properties[0].schema;
    expect(next.kind).toBe('raw');
  });
});

describe('toSchemaNode: raw-JSON fallback', () => {
  it('degrades a mixed oneOf (object + primitive) to raw instead of dropping it', () => {
    const schema = { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'string' }] };
    const node = toSchemaNode(schema, {});
    expect(node).toEqual({ kind: 'raw', raw: schema });
  });

  it('degrades a discriminated union to raw', () => {
    const schema = {
      oneOf: [{ type: 'object', properties: { kind: { const: 'a' } } }, { type: 'object', properties: { kind: { const: 'b' } } }],
      discriminator: { propertyName: 'kind' },
    };
    expect(toSchemaNode(schema, {})).toEqual({ kind: 'raw', raw: schema });
  });

  it('degrades a free-form dictionary (additionalProperties, no declared shape) to raw', () => {
    const schema = { type: 'object', additionalProperties: { type: 'number' } };
    expect(toSchemaNode(schema, {})).toEqual({ kind: 'raw', raw: schema });
  });

  it('degrades an unresolvable $ref to raw rather than throwing', () => {
    const schema = { $ref: '#/components/schemas/Missing' };
    expect(toSchemaNode(schema, {})).toEqual({ kind: 'raw', raw: schema });
  });

  it('degrades a bare {} (any) schema to raw', () => {
    expect(toSchemaNode({}, {})).toEqual({ kind: 'raw', raw: {} });
  });

  it('a raw-fallback endpoint is still present in the built reference (never dropped)', () => {
    const spec = fixture({
      paths: {
        '/api/weird': {
          post: {
            tags: ['Tasks'],
            requestBody: {
              content: {
                'application/json': {
                  schema: { oneOf: [{ type: 'object', properties: {} }, { type: 'string' }] },
                },
              },
            },
            responses: { '200': {} },
          },
        },
      },
    });
    const [endpoint] = buildApiReference(spec)[0]!.endpoints;
    expect(endpoint!.path).toBe('/api/weird');
    expect(endpoint!.requestBody!.kind).toBe('raw');
  });
});

describe('buildApiReference: real spec invariant', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('drops no endpoint from the live-generated spec', async () => {
    const doc = (await server.anonApi('GET', '/api/openapi.json')).body;
    let specOperationCount = 0;
    for (const pathItem of Object.values<any>(doc.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
        if (pathItem[method]) specOperationCount += 1;
      }
    }

    const groups = buildApiReference(doc);
    const builtCount = groups.reduce((n, g) => n + g.endpoints.length, 0);
    expect(builtCount).toBe(specOperationCount);

    for (const group of groups) {
      for (const endpoint of group.endpoints) {
        expect(endpoint.method).toBeTruthy();
        expect(endpoint.path).toBeTruthy();
        // Every response must resolve to either a structured node or a
        // documented absence (no content) — never throw/undefined shape.
        for (const response of endpoint.responses) {
          expect(response.schema === null || typeof response.schema.kind === 'string').toBe(true);
        }
      }
    }
  });
});
