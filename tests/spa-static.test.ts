import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type TestServer } from './helpers.js';

// These assert the embedded-SPA serving contract, which only exists once
// `dist/web` has been built next to the server code. When it hasn't (e.g. a
// server-only CI shard), the static handler isn't registered, so skip rather
// than assert against a build that isn't there.
const webRoot = fileURLToPath(new URL('../dist/web', import.meta.url));
const built = existsSync(join(webRoot, 'index.html'));

describe.skipIf(!built)('embedded SPA static serving', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('serves index.html with a no-cache header so the shell is never stale', async () => {
    const res = await fetch(`${server.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
  });

  it('falls back to the SPA shell for extension-less client routes', async () => {
    const res = await fetch(`${server.baseUrl}/workspaces/anything/board`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  // The regression: a stale index.html requests an asset hash we've already
  // deleted. That must 404 cleanly, NOT return the HTML shell with 200 — which
  // the browser would try to execute as JS and blank the page until a
  // cache-disabled hard reload.
  it('returns a real 404 (not the HTML shell) for a missing hashed asset', async () => {
    const res = await fetch(`${server.baseUrl}/assets/index-DEADBEEF.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/);
  });

  it('serves real hashed assets as immutable', async () => {
    const asset = readdirSync(join(webRoot, 'assets')).find((f) => f.endsWith('.js'));
    expect(asset).toBeTruthy();
    const res = await fetch(`${server.baseUrl}/assets/${asset}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
  });
});
