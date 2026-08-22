# OpenAPI is generated from zod route schemas

The REST API's OpenAPI spec is generated at runtime from zod schemas
attached to every Fastify route (via `fastify-type-provider-zod` +
`@fastify/swagger`), served at `/api/openapi.json` (and `.yaml`), and
rendered in the web UI by a hand-rolled reference component. We chose
this over a hand-written spec file (drifts silently the moment a route
changes) and over Fastify-native JSON schemas (would duplicate every
shape already expressed in zod). The migration cost buys a spec that
cannot disagree with the code, plus uniform request validation. That
cost: every handler's ad-hoc `z.object(...).parse(req.body)` moves into
declared route schemas, and response schemas are written for the first
time.

## Consequences

- The spec endpoints are deliberately **unauthenticated** (added to
  `PUBLIC_API_PATHS`): the project is open source, so the surface is
  already public knowledge.
- New routes must declare zod schemas or they ship undocumented and
  unvalidated; review should treat a schema-less route as a defect.
- The spec documents the whole `/api` surface, including auth, keys,
  and config, with run-scoped-key restrictions noted per endpoint.
  MCP and the WebSocket are described in prose only.
- The UI renders the spec itself (per DESIGN.md) instead of embedding
  Swagger UI/Scalar, so OpenAPI features the renderer doesn't support
  (e.g. oneOf trees) need renderer work to become visible.
