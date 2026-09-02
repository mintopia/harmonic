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

const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-openapi-'));
try {
  const app = await buildApp({ dataDir });
  await app.ready();
  const spec = app.swagger();
  writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`);
  await app.close();
  logger.info(`Wrote ${outPath}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
