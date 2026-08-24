/**
 * Build-time OpenAPI export (issue #74).
 *
 * Builds the Fastify app in-process and calls `app.swagger()` to write a
 * committed `website/src/openapi.json` snapshot — no server boot, no port.
 * `buildApp` never calls `.listen()`, so the `onListen` hook (MCP URL wiring,
 * tracker sync) stays dormant; `app.ready()` is enough for @fastify/swagger to
 * collect every zod-declared route (ADR-0005). The committed snapshot lets the
 * Starlight `dev` build work offline; the Pages workflow regenerates it before
 * the docs build so the API reference can never drift from the route schemas.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/server/app.js';
import { logger } from '../src/logger.js';

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'website', 'src', 'openapi.json');

// A throwaway data dir: the export opens a real (empty) SQLite DB but never
// serves traffic, so nothing persists beyond this process.
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
