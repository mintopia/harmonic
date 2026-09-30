import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_MASK } from '../src/archive/export-secrets.js';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('S3 export credentials never leave the API', () => {
  let server: TestServer;

  const storedYaml = () => readFileSync(join(server.dataDir, 'settings.yaml'), 'utf8');
  const putS3 = async (s3: Record<string, unknown>) => {
    const current = (await server.api('GET', '/api/config')).body;
    return server.api('PUT', '/api/config', { ...current, export: { ...current.export, s3: { ...current.export.s3, ...s3 } } });
  };

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  it('masks global keys on GET /config, /config/layers, PUT and DELETE /config/overrides; null stays null', async () => {
    expect((await server.api('GET', '/api/config')).body.export.s3.accessKeyId).toBeNull();
    const put = await putS3({ bucket: 'b', accessKeyId: 'AKIA-REAL', secretAccessKey: 'SECRET-REAL' });
    expect(put.status).toBe(200);
    expect(put.body.export.s3).toMatchObject({ bucket: 'b', accessKeyId: SECRET_MASK, secretAccessKey: SECRET_MASK });
    expect(JSON.stringify((await server.api('GET', '/api/config')).body)).not.toMatch(/AKIA-REAL|SECRET-REAL/);
    const layers = (await server.api('GET', '/api/config/layers')).body;
    expect(layers.global.export.s3.secretAccessKey).toBe(SECRET_MASK);
    expect(layers.baseline.export.s3.secretAccessKey).toBeNull();
    expect(storedYaml()).toContain('SECRET-REAL');
    const reverted = await server.api('DELETE', '/api/config/overrides');
    expect(reverted.body.export.s3.secretAccessKey).toBeNull();
  });

  it('a PUT round-trip of the mask keeps the stored secret; null clears; a new value replaces', async () => {
    await putS3({ bucket: 'b', accessKeyId: 'AKIA-REAL', secretAccessKey: 'SECRET-REAL' });
    await putS3({ region: 'eu-west-2' });
    expect(storedYaml()).toContain('SECRET-REAL');
    expect(storedYaml()).toContain('AKIA-REAL');

    await putS3({ secretAccessKey: 'SECRET-NEW' });
    expect(storedYaml()).toContain('SECRET-NEW');
    expect(storedYaml()).not.toContain('SECRET-REAL');

    const cleared = await putS3({ accessKeyId: null });
    expect(cleared.body.export.s3.accessKeyId).toBeNull();
    expect(cleared.body.export.s3.secretAccessKey).toBe(SECRET_MASK);
    expect(storedYaml()).not.toContain('AKIA-REAL');
  });

  it('masks Workspace override keys on GET/PATCH/list and preserves them across mask round-trips', async () => {
    const id = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id as number;
    const patched = await server.api('PATCH', `/api/workspaces/${id}`, {
      exportS3Bucket: 'ws-bucket',
      exportS3AccessKeyId: 'WS-AKIA',
      exportS3SecretAccessKey: 'WS-SECRET',
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ exportS3Bucket: 'ws-bucket', exportS3AccessKeyId: SECRET_MASK, exportS3SecretAccessKey: SECRET_MASK });
    for (const res of [await server.api('GET', `/api/workspaces/${id}`), await server.api('GET', '/api/workspaces')]) {
      expect(JSON.stringify(res.body)).not.toMatch(/WS-AKIA|WS-SECRET/);
    }

    const round = await server.api('PATCH', `/api/workspaces/${id}`, { exportS3AccessKeyId: SECRET_MASK, exportS3SecretAccessKey: SECRET_MASK, exportS3Region: 'us-east-1' });
    expect(round.body.exportS3Region).toBe('us-east-1');
    expect(round.body.exportS3SecretAccessKey).toBe(SECRET_MASK);
    expect(storedYaml()).toContain('WS-SECRET');
    expect(storedYaml()).toContain('WS-AKIA');

    const cleared = await server.api('PATCH', `/api/workspaces/${id}`, { exportS3SecretAccessKey: null });
    expect(cleared.body.exportS3SecretAccessKey).toBeNull();
    expect(storedYaml()).not.toContain('WS-SECRET');

    expect((await server.api('PATCH', `/api/workspaces/${id}`, { exportS3Endpoint: 'nope' })).status).toBe(400);
  });
});
