/**
 * Builds the Fastify app in-process and calls `app.swagger()` to write
 * `website/src/openapi.json`. Nothing calls `.listen()`, so the `onListen` hook
 * stays dormant; `app.ready()` is enough for @fastify/swagger to collect every route.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/server/app.js';
import { logger } from '../src/logger.js';

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'website', 'src', 'openapi.json');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Some schemas carry a runtime `.default(() => randomUUID())` (a server-assigned
 * id). @fastify/swagger evaluates that factory when serialising, so a fresh UUID
 * would land in the snapshot on every run and the stale-snapshot CI check could
 * never pass. Pin any UUID-valued `default` to a fixed placeholder so the doc is
 * deterministic; the runtime schema is untouched.
 */
function pinVolatileDefaults(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) pinVolatileDefaults(item);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.default === 'string' && UUID_RE.test(obj.default)) obj.default = PLACEHOLDER_UUID;
  for (const value of Object.values(obj)) pinVolatileDefaults(value);
}

const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-openapi-'));
try {
  const app = await buildApp({ dataDir });
  await app.ready();
  const spec = app.swagger();
  pinVolatileDefaults(spec);
  writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`);
  await app.close();
  logger.info(`Wrote ${outPath}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
