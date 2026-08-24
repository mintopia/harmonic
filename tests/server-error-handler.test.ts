import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/server/app.js';

describe('unexpected server errors', () => {
  let app: App | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not disclose an unexpected exception message to API clients', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-test-'));
    app = await buildApp({ dataDir });
    app.get('/api/test-unexpected-error', async () => {
      throw new Error('database password: super-secret');
    });

    const response = await app.inject({ method: 'GET', url: '/api/test-unexpected-error' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal', message: 'internal server error' } });
    expect(response.body).not.toContain('database password: super-secret');
  });
});
