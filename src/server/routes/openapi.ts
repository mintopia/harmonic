import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The name/version @fastify/swagger puts in the spec's `info` block come
 * from the package manifest — same root-relative path trick app.ts uses
 * for `dist/web`, so it resolves both under `tsx` (src/server/routes) and
 * the built output (dist/server/routes).
 */
export function readPackageManifest(): { name: string; version: string; description: string } {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
    name: string;
    version: string;
    description: string;
  };
}

/** Public spec endpoints (ADR-0005) — see PUBLIC_API_PATHS in app.ts. */
export async function openapiRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/openapi.json', { schema: { hide: true } }, async () => fastify.swagger());

  fastify.get('/openapi.yaml', { schema: { hide: true } }, async (_req, reply) => {
    reply.type('text/yaml');
    return fastify.swagger({ yaml: true });
  });
}
