// Explicit .js extensions: shared with the node-side test project (see
// board-model.ts for the same nodenext/Vite note).

/** `example` is whatever the spec declared for this node (zod `.meta({ example })`
 * in src/server/schemas.ts and the route modules). Absent means the spec author
 * didn't supply one — renderers should say so rather than invent precision. */
export type SchemaNode =
  | {
      kind: 'object';
      properties: { name: string; required: boolean; schema: SchemaNode }[];
      description?: string | undefined;
      example?: unknown;
    }
  | { kind: 'array'; items: SchemaNode; description?: string | undefined; example?: unknown }
  | { kind: 'enum'; values: (string | number | boolean)[]; description?: string | undefined; example?: unknown }
  | { kind: 'primitive'; type: string; nullable: boolean; description?: string | undefined; example?: unknown }
  | { kind: 'union'; options: SchemaNode[]; description?: string | undefined; example?: unknown }
  | { kind: 'raw'; raw: unknown; description?: string | undefined; example?: unknown };

export interface ApiReferenceParam {
  name: string;
  in: string;
  required: boolean;
  type: string;
}

export interface ApiReferenceResponse {
  status: string;
  description?: string | undefined;
  schema: SchemaNode | null;
}

export interface ApiReferenceEndpoint {
  method: string;
  path: string;
  tags: string[];
  summary?: string | undefined;
  description?: string | undefined;
  parameters: ApiReferenceParam[];
  requestBody: SchemaNode | null;
  responses: ApiReferenceResponse[];
}

export interface ApiReferenceGroup {
  name: string;
  endpoints: ApiReferenceEndpoint[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = doc;
  for (const part of ref.slice(2).split('/')) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** The spec's declared example for a node, if it carries one. OpenAPI 3.0
 * spells it `example`; JSON Schema 2020-12 (what zod emits) uses `examples`
 * as an array — accept both, first wins. */
function readExample(schema: Record<string, unknown>): unknown {
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  return undefined;
}

/**
 * Converts one JSON Schema / OpenAPI schema object into a SchemaNode.
 * Understands: $ref (local, cycle-guarded), enum, oneOf/anyOf of simple
 * (primitive/enum) branches, allOf of plain objects, array, object with
 * properties/required, primitives, and the `type: [x, "null"]` nullable
 * spelling. Everything else — exotic unions, discriminators, dictionaries,
 * `not`, etc. — degrades to a `raw` node carrying the schema as-is so the
 * component can render it verbatim instead of hiding the endpoint.
 *
 * Any declared example rides along on the node. Where both a `$ref` use site
 * and the definition it points at declare one, the definition wins and the use
 * site only fills a gap — the same precedence `description` already uses just
 * below, so the two annotations don't disagree about which is authoritative.
 */
export function toSchemaNode(schema: unknown, doc: unknown, seenRefs: ReadonlySet<string> = new Set()): SchemaNode {
  const node = buildSchemaNode(schema, doc, seenRefs);
  if (!isPlainObject(schema)) return node;
  const example = readExample(schema);
  return example !== undefined && node.example === undefined ? { ...node, example } : node;
}

function buildSchemaNode(schema: unknown, doc: unknown, seenRefs: ReadonlySet<string>): SchemaNode {
  if (!isPlainObject(schema)) {
    return { kind: 'raw', raw: schema };
  }

  const description = typeof schema.description === 'string' ? schema.description : undefined;

  if (typeof schema.$ref === 'string') {
    if (seenRefs.has(schema.$ref)) {
      return { kind: 'raw', raw: { $ref: schema.$ref, note: 'circular reference' }, description };
    }
    const resolved = resolveRef(doc, schema.$ref);
    if (resolved === undefined) {
      return { kind: 'raw', raw: schema, description };
    }
    const next = new Set(seenRefs);
    next.add(schema.$ref);
    const node = toSchemaNode(resolved, doc, next);
    return description !== undefined && node.description === undefined ? { ...node, description } : node;
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(
      (v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    );
    if (values.length === schema.enum.length) {
      return { kind: 'enum', values, description };
    }
    return { kind: 'raw', raw: schema, description };
  }

  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (branches) {
    const options = branches.map((b) => toSchemaNode(b, doc, seenRefs));
    if (options.every((o) => o.kind === 'primitive' || o.kind === 'enum')) {
      return { kind: 'union', options, description };
    }
    // Anything else with exactly one non-null branch is zod's `.nullable()` on
    // a non-scalar — `anyOf: [Cost, { type: 'null' }]`. That's not a union the
    // reader cares about; it's a Cost that may be null. Unwrap to the branch,
    // because falling through to `raw` renders the whole field as a slab of
    // JSON Schema where its example should be.
    const nonNull = options.filter((o) => !(o.kind === 'primitive' && o.type === 'null'));
    const inner = nonNull.length === 1 && nonNull.length < options.length ? nonNull[0] : undefined;
    if (inner) {
      return description !== undefined && inner.description === undefined ? { ...inner, description } : inner;
    }
    return { kind: 'raw', raw: schema, description };
  }

  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((b) => toSchemaNode(b, doc, seenRefs));
    if (parts.every((p): p is Extract<SchemaNode, { kind: 'object' }> => p.kind === 'object')) {
      const properties: { name: string; required: boolean; schema: SchemaNode }[] = [];
      for (const part of parts) {
        for (const prop of part.properties) {
          const existing = properties.findIndex((p) => p.name === prop.name);
          if (existing >= 0) properties[existing] = prop;
          else properties.push(prop);
        }
      }
      return { kind: 'object', properties, description };
    }
    return { kind: 'raw', raw: schema, description };
  }

  let type = schema.type;
  let nullable = schema.nullable === true;
  if (Array.isArray(type)) {
    const types = type.filter((t): t is string => typeof t === 'string');
    nullable = nullable || types.includes('null');
    const nonNull = types.filter((t) => t !== 'null');
    if (nonNull.length === 1) {
      type = nonNull[0];
    } else if (nonNull.length > 1 && nonNull.every((t) => PRIMITIVE_TYPES.has(t))) {
      return {
        kind: 'union',
        options: nonNull.map((t) => ({ kind: 'primitive', type: t, nullable: false }) as SchemaNode),
        description,
      };
    } else {
      return { kind: 'raw', raw: schema, description };
    }
  }

  if (type === 'array') {
    const items = isPlainObject(schema.items) || Array.isArray(schema.items) ? schema.items : {};
    return { kind: 'array', items: toSchemaNode(items, doc, seenRefs), description };
  }

  if (type === 'object' || isPlainObject(schema.properties)) {
    if (!isPlainObject(schema.properties)) {
      return { kind: 'raw', raw: schema, description };
    }
    const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [];
    const properties = Object.entries(schema.properties).map(([name, propSchema]) => ({
      name,
      required: required.includes(name),
      schema: toSchemaNode(propSchema, doc, seenRefs),
    }));
    return { kind: 'object', properties, description };
  }

  if (typeof type === 'string' && PRIMITIVE_TYPES.has(type)) {
    return { kind: 'primitive', type, nullable, description };
  }

  return { kind: 'raw', raw: schema, description };
}

/** Stable, URL-safe anchor id for an endpoint deep link, e.g. "ep-get-api-tasks-id".
 *  Derived from method + path so it is stable across reloads and reorderings. */
export function endpointAnchor(method: string, path: string): string {
  const slug = `${method}-${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `ep-${slug}`;
}

/** Filters groups by a case-insensitive query matched over each endpoint's
 *  method, path and summary. Whitespace-separated terms must ALL match (AND).
 *  Groups with no surviving endpoints are dropped. Empty/whitespace query returns groups unchanged. */
export function filterApiReference(groups: ApiReferenceGroup[], query: string): ApiReferenceGroup[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return groups;
  return groups
    .map((group) => ({
      name: group.name,
      endpoints: group.endpoints.filter((endpoint) => {
        const target = `${endpoint.method} ${endpoint.path} ${endpoint.summary ?? ''}`.toLowerCase();
        return terms.every((term) => target.includes(term));
      }),
    }))
    .filter((group) => group.endpoints.length > 0);
}

/** Short human label for a parameter/summary line, e.g. "string[]", "enum(a | b)". */
export function describeType(node: SchemaNode): string {
  switch (node.kind) {
    case 'primitive':
      return node.nullable ? `${node.type} | null` : node.type;
    case 'array':
      return `${describeType(node.items)}[]`;
    case 'enum':
      return `enum(${node.values.join(' | ')})`;
    case 'union':
      return node.options.map(describeType).join(' | ');
    case 'object':
      return 'object';
    case 'raw':
      return 'raw';
  }
}

function jsonContentSchema(container: unknown): unknown {
  if (!isPlainObject(container)) return undefined;
  const content = container.content;
  if (!isPlainObject(content)) return undefined;
  const json = content['application/json'];
  if (!isPlainObject(json)) return undefined;
  return json.schema;
}

function buildParameters(
  operation: Record<string, unknown>,
  pathLevelParams: unknown[],
  doc: unknown,
): ApiReferenceParam[] {
  const raw = [...pathLevelParams, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  return raw.map((p) => {
    const resolved = isPlainObject(p) && typeof p.$ref === 'string' ? (resolveRef(doc, p.$ref) ?? p) : p;
    if (!isPlainObject(resolved)) {
      return { name: '(unknown)', in: 'query', required: false, type: 'raw' };
    }
    const schemaNode = resolved.schema !== undefined ? toSchemaNode(resolved.schema, doc) : ({ kind: 'raw', raw: null } as SchemaNode);
    return {
      name: typeof resolved.name === 'string' ? resolved.name : '(unknown)',
      in: typeof resolved.in === 'string' ? resolved.in : 'query',
      required: resolved.required === true,
      type: describeType(schemaNode),
    };
  });
}

function buildResponses(operation: Record<string, unknown>, doc: unknown): ApiReferenceResponse[] {
  const responses = isPlainObject(operation.responses) ? operation.responses : {};
  return Object.entries(responses).map(([status, resp]) => {
    const schema = jsonContentSchema(resp);
    return {
      status,
      description: isPlainObject(resp) && typeof resp.description === 'string' ? resp.description : undefined,
      schema: schema !== undefined ? toSchemaNode(schema, doc) : null,
    };
  });
}

function buildEndpoint(
  method: string,
  path: string,
  operation: Record<string, unknown>,
  pathLevelParams: unknown[],
  doc: unknown,
): ApiReferenceEndpoint {
  const requestBodySchema = jsonContentSchema(operation.requestBody);
  return {
    method: method.toUpperCase(),
    path,
    tags: Array.isArray(operation.tags) ? operation.tags.filter((t): t is string => typeof t === 'string') : [],
    summary: typeof operation.summary === 'string' ? operation.summary : undefined,
    description: typeof operation.description === 'string' ? operation.description : undefined,
    parameters: buildParameters(operation, pathLevelParams, doc),
    requestBody: requestBodySchema !== undefined ? toSchemaNode(requestBodySchema, doc) : null,
    responses: buildResponses(operation, doc),
  };
}

/**
 * Groups by first tag (untagged operations merge in "Other", always last).
 * Group order follows the spec's own `tags` array when present, then any
 * remaining encountered tags alphabetically.
 */
export function buildApiReference(spec: unknown): ApiReferenceGroup[] {
  const doc = spec;
  const paths = isPlainObject(doc) && isPlainObject(doc.paths) ? doc.paths : {};
  const declaredTags = isPlainObject(doc) && Array.isArray(doc.tags)
    ? doc.tags
        .map((t) => (isPlainObject(t) && typeof t.name === 'string' ? t.name : undefined))
        .filter((t): t is string => t !== undefined)
    : [];

  const groups = new Map<string, ApiReferenceEndpoint[]>();
  const ensure = (name: string) => {
    let list = groups.get(name);
    if (!list) {
      list = [];
      groups.set(name, list);
    }
    return list;
  };

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isPlainObject(pathItem)) continue;
    const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isPlainObject(operation)) continue;
      const tags = Array.isArray(operation.tags) ? operation.tags : [];
      const tag = typeof tags[0] === 'string' ? tags[0] : 'Other';
      ensure(tag).push(buildEndpoint(method, path, operation, pathLevelParams, doc));
    }
  }

  const encountered = [...groups.keys()];
  const orderedNames = [
    ...declaredTags.filter((t) => groups.has(t)),
    ...encountered.filter((t) => t !== 'Other' && !declaredTags.includes(t)).sort(),
    ...(groups.has('Other') ? ['Other'] : []),
  ];

  return orderedNames.map((name) => ({
    name,
    endpoints: groups
      .get(name)!
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path) || HTTP_METHODS.indexOf(a.method.toLowerCase() as any) - HTTP_METHODS.indexOf(b.method.toLowerCase() as any)),
  }));
}
