// Explicit .js extensions: shared with the node-side test project (see
// board-model.ts for the same nodenext/Vite note).

/**
 * Pure transform: fetched OpenAPI 3.x spec JSON -> a grouped, expandable
 * endpoint tree for the API page's rendered reference (issue 7). No React,
 * no fetch — the component owns those; this module only shapes data an
 * endpoint must never be dropped for having a schema this model doesn't
 * understand, it degrades to a `raw` node instead (see toSchemaNode).
 */

export type SchemaNode =
  | { kind: 'object'; properties: { name: string; required: boolean; schema: SchemaNode }[]; description?: string | undefined }
  | { kind: 'array'; items: SchemaNode; description?: string | undefined }
  | { kind: 'enum'; values: (string | number | boolean)[]; description?: string | undefined }
  | { kind: 'primitive'; type: string; nullable: boolean; description?: string | undefined }
  | { kind: 'union'; options: SchemaNode[]; description?: string | undefined }
  | { kind: 'raw'; raw: unknown; description?: string | undefined };

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

/** Resolves a local `#/a/b/c` JSON pointer against the document root. */
function resolveRef(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = doc;
  for (const part of ref.slice(2).split('/')) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Converts one JSON Schema / OpenAPI schema object into a SchemaNode.
 * Understands: $ref (local, cycle-guarded), enum, oneOf/anyOf of simple
 * (primitive/enum) branches, allOf of plain objects, array, object with
 * properties/required, primitives, and the `type: [x, "null"]` nullable
 * spelling. Everything else — exotic unions, discriminators, dictionaries,
 * `not`, etc. — degrades to a `raw` node carrying the schema as-is so the
 * component can render it verbatim instead of hiding the endpoint.
 */
export function toSchemaNode(schema: unknown, doc: unknown, seenRefs: ReadonlySet<string> = new Set()): SchemaNode {
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
      // Object with no declared shape (e.g. a free-form dictionary via
      // additionalProperties): not one of the "common constructs" — fall back.
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

  // No recognizable `type`, no properties, no enum/union/allOf: e.g. `{}`
  // (any), or an unsupported keyword like `not`/`patternProperties`.
  return { kind: 'raw', raw: schema, description };
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
 * Groups by first tag (untagged operations land in "Other", always last).
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
